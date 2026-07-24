/**
 * Pluggable mail transport (Team tier — password reset et al).
 *
 * Two built-in transports, selected by env at first send:
 *  • smtp    — when SMTP_HOST is set. Zero-dependency SMTP client over
 *              node:net/node:tls: implicit TLS on port 465, STARTTLS upgrade
 *              otherwise (disable with SMTP_STARTTLS=0 for a trusted relay),
 *              AUTH LOGIN when SMTP_USER/SMTP_PASS are set.
 *  • console — self-host fallback: the full message (including any action
 *              link) is written to the gateway log, so a single-operator
 *              deployment works with no mail infrastructure at all.
 *
 * Env: SMTP_HOST, SMTP_PORT (default 587; 465 → implicit TLS), SMTP_USER,
 * SMTP_PASS, SMTP_FROM (default MAIL_FROM or myai@localhost), SMTP_STARTTLS.
 *
 * Tests (and future providers — SES, Resend, …) plug in via setMailTransport().
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'mailer' });

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative (e.g. from notifications/email-templates.ts). Sent as multipart/alternative when present. */
  html?: string;
  /** Override the envelope/header From (e.g. per-tenant branded address). Falls back to SMTP_FROM/MAIL_FROM. */
  from?: string;
  /** Optional Reply-To header (e.g. per-tenant support address). */
  replyTo?: string;
}

export interface MailTransport {
  name: string;
  send(msg: MailMessage): Promise<void>;
}

// ── Console transport (self-host default) ──────────────────────────────────

export const consoleTransport: MailTransport = {
  name: 'console',
  async send(msg: MailMessage): Promise<void> {
    log.info(
      {
        to: msg.to,
        from: msg.from,
        replyTo: msg.replyTo,
        subject: msg.subject,
        body: msg.text,
        hasHtml: Boolean(msg.html),
      },
      'MAIL (console transport — set SMTP_HOST to send real email)',
    );
  },
};

// ── SMTP transport (zero-dependency) ───────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  starttls: boolean;
}

function smtpConfigFromEnv(): SmtpConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    user: process.env.SMTP_USER || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.SMTP_FROM || process.env.MAIL_FROM || 'myai@localhost',
    starttls: process.env.SMTP_STARTTLS !== '0',
  };
}

const SMTP_TIMEOUT_MS = 15_000;

/**
 * Minimal SMTP conversation. Multiline replies ("250-…") are consumed until
 * the terminal "NNN " line; only the final code is checked.
 */
class SmtpSession {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = '';
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.setTimeout(SMTP_TIMEOUT_MS, () => this.fail(new Error('SMTP timeout')));
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (err: Error) => this.fail(err));
  }

  private fail(err: Error): void {
    const w = this.waiter;
    this.waiter = null;
    this.socket.destroy();
    w?.reject(err);
  }

  private drain(): void {
    if (!this.waiter) return;
    // A reply is complete once a "NNN<space>" (non-continuation) line arrives.
    const lines = this.buffer.split(/\r?\n/);
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        this.buffer = lines.slice(i + 1).join('\n');
        const w = this.waiter;
        this.waiter = null;
        w!.resolve(lines[i]);
        return;
      }
    }
  }

  /** Await the next complete server reply; throws if its code ≥ 400. */
  reply(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.drain();
    }).then((line) => {
      if (Number(line.slice(0, 3)) >= 400) throw new Error(`SMTP error: ${line}`);
      return line;
    });
  }

  async command(cmd: string): Promise<string> {
    this.socket.write(`${cmd}\r\n`);
    return this.reply();
  }

  /** STARTTLS upgrade: wrap the plain socket, then continue on the TLS one. */
  async upgradeTls(host: string): Promise<void> {
    const plain = this.socket as net.Socket;
    plain.setTimeout(0);
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const secured = tls.connect({ socket: plain, servername: host }, () => resolve(secured));
      secured.once('error', reject);
    });
    this.buffer = '';
    this.attach(this.socket);
  }

  end(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

async function smtpSend(cfg: SmtpConfig, msg: MailMessage): Promise<void> {
  const implicitTls = cfg.port === 465;
  const socket: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    const s = implicitTls
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => resolve(s))
      : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once('error', reject);
  });

  const session = new SmtpSession(socket);
  try {
    await session.reply(); // 220 greeting
    await session.command(`EHLO myai-gateway`);

    if (!implicitTls && cfg.starttls) {
      await session.command('STARTTLS');
      await session.upgradeTls(cfg.host);
      await session.command(`EHLO myai-gateway`);
    }

    if (cfg.user && cfg.pass) {
      await session.command('AUTH LOGIN');
      await session.command(Buffer.from(cfg.user, 'utf8').toString('base64'));
      await session.command(Buffer.from(cfg.pass, 'utf8').toString('base64'));
    }

    // Envelope sender stays the SMTP-configured address regardless of the
    // header From override — an arbitrary envelope-from would fail SPF/DMARC
    // at most relays. The header From is what recipients actually see.
    const fromHeader = msg.from || cfg.from;
    await session.command(`MAIL FROM:<${cfg.from}>`);
    await session.command(`RCPT TO:<${msg.to}>`);
    await session.command('DATA');

    const headerLines = [
      `From: ${fromHeader}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
    ];
    if (msg.replyTo) headerLines.push(`Reply-To: ${msg.replyTo}`);

    let mime: string;
    if (msg.html) {
      const boundary = `myai_${crypto.randomBytes(12).toString('hex')}`;
      headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      mime =
        `--${boundary}\r\n` +
        'Content-Type: text/plain; charset=utf-8\r\n\r\n' +
        `${msg.text}\r\n\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: text/html; charset=utf-8\r\n\r\n' +
        `${msg.html}\r\n\r\n` +
        `--${boundary}--`;
    } else {
      headerLines.push('Content-Type: text/plain; charset=utf-8');
      mime = msg.text;
    }

    const headers = headerLines.join('\r\n');
    // Dot-stuffing per RFC 5321 §4.5.2.
    const body = mime.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
    await session.command(`${headers}\r\n\r\n${body}\r\n.`);
    await session.command('QUIT').catch(() => undefined); // some servers close abruptly
  } finally {
    session.end();
  }
}

function makeSmtpTransport(cfg: SmtpConfig): MailTransport {
  return {
    name: 'smtp',
    async send(msg: MailMessage): Promise<void> {
      await smtpSend(cfg, msg);
      log.info({ to: msg.to, subject: msg.subject, host: cfg.host }, 'mail sent via SMTP');
    },
  };
}

// ── Selection + plug point ──────────────────────────────────────────────────

let activeTransport: MailTransport | null = null;

/** Override the transport (tests, custom providers). Pass null to re-detect from env. */
export function setMailTransport(transport: MailTransport | null): void {
  activeTransport = transport;
}

export function getMailTransport(): MailTransport {
  if (activeTransport) return activeTransport;
  const smtp = smtpConfigFromEnv();
  activeTransport = smtp ? makeSmtpTransport(smtp) : consoleTransport;
  log.info({ transport: activeTransport.name }, 'mail transport selected');
  return activeTransport;
}

export async function sendMail(msg: MailMessage): Promise<void> {
  await getMailTransport().send(msg);
}
