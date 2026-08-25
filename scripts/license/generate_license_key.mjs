#!/usr/bin/env node
// generate_license_key.mjs — vendor-side offline license-key minting tool for
// the self-hosted/on-prem bundle (selfhost/README.md, runtime/src/core/license.ts).
//
// Two subcommands, both plain Node (no deps, no build step — usable straight
// from a clean checkout):
//
//   node scripts/license/generate_license_key.mjs keygen
//     Generates a fresh Ed25519 key pair and prints both halves. Keep the
//     PRIVATE key offline (never commit it, never put it in this repo); the
//     PUBLIC key is what customers set as LICENSE_PUBLIC_KEY (or you bake it
//     into runtime/src/core/license.ts's DEFAULT_PUBLIC_KEY_PEM for a rotation).
//
//   node scripts/license/generate_license_key.mjs sign \
//     --private-key-file ./vendor-private.pem \
//     --org "Acme Corp" --plan enterprise --seats 50 \
//     [--expires 2027-01-01] [--features sso,rbac-v2]
//     Mints a LICENSE_KEY value for a customer. Prints the key to stdout —
//     nothing is written to disk, nothing touches the network.
//
// This script never verifies keys — that's runtime/src/core/license.ts's job,
// done fully offline by the gateway at boot / on /api/license/status.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function keygen() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  console.log('# PUBLIC KEY — distribute to customers as LICENSE_PUBLIC_KEY, or bake in as the new default:\n');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  console.log('# PRIVATE KEY — keep this offline. Never commit it. Never put it in this repo:\n');
  console.log(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
}

function sign(args) {
  const required = ['private-key-file', 'org', 'plan', 'seats'];
  const missing = required.filter((r) => !args[r]);
  if (missing.length > 0) {
    console.error(`sign: missing required flag(s): ${missing.map((m) => `--${m}`).join(', ')}`);
    process.exit(1);
  }
  if (args.plan !== 'community' && args.plan !== 'enterprise') {
    console.error(`sign: --plan must be "community" or "enterprise", got "${args.plan}"`);
    process.exit(1);
  }
  const seats = Number(args.seats);
  if (!Number.isInteger(seats) || (seats < 0 && seats !== -1)) {
    console.error('sign: --seats must be a non-negative integer, or -1 for unlimited');
    process.exit(1);
  }
  let privateKeyPem;
  try {
    privateKeyPem = readFileSync(args['private-key-file'], 'utf8');
  } catch (err) {
    console.error(`sign: cannot read --private-key-file: ${err.message}`);
    process.exit(1);
  }
  const payload = {
    org: args.org,
    plan: args.plan,
    seats,
    issuedAt: new Date().toISOString(),
    expiresAt: args.expires ? new Date(args.expires).toISOString() : null,
    features: args.features ? String(args.features).split(',').map((f) => f.trim()).filter(Boolean) : [],
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(body, 'utf8'), privateKey);
  const key = `${body}.${b64url(signature)}`;
  console.log(key);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'keygen') {
  keygen();
} else if (cmd === 'sign') {
  sign(parseArgs(rest));
} else {
  console.error('usage: generate_license_key.mjs <keygen|sign> [flags]');
  process.exit(1);
}
