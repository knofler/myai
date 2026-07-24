import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createChildLogger } from '../shared/logger.js';
import { getConfig } from '../shared/config.js';
import { getAdapter } from './registry.js';
import type { TelegramAdapter } from './telegram.js';

const log = createChildLogger({ module: 'host-control' });

let interval: ReturnType<typeof setInterval> | null = null;
let currentlyActive = false;

/**
 * Read the active host from the Dropbox-synced control file.
 * Written by `agent mode` on session start.
 */
function readActiveHost(): string | null {
  const config = getConfig();
  const controlPath = resolve(config.aiRoot, 'state', '.telegram-active-host');
  if (!existsSync(controlPath)) return null;
  return readFileSync(controlPath, 'utf-8').trim();
}

function shouldPoll(): boolean {
  const hostMachine = process.env.HOST_HOSTNAME || '';
  if (!hostMachine) return false;
  const activeHost = readActiveHost();
  if (!activeHost) return false;
  return hostMachine.startsWith(activeHost);
}

/**
 * Start periodic checking of the control file (every 10s).
 * Dropbox syncs the file between machines — when `agent mode` runs
 * on a new machine, it writes the hostname and this picks it up.
 */
export function startHostControl(): void {
  const config = getConfig();
  if (!config.channels.telegram.token) return;

  check();
  interval = setInterval(check, 10_000);
  log.info({ hostMachine: process.env.HOST_HOSTNAME }, 'Telegram host control active — checking every 10s');
}

function check(): void {
  const should = shouldPoll();

  if (should && !currentlyActive) {
    const adapter = getAdapter('telegram') as TelegramAdapter | undefined;
    if (adapter) {
      log.info({ host: process.env.HOST_HOSTNAME }, 'Activating Telegram on this machine');
      adapter.start()
        .then(() => { currentlyActive = true; })
        .catch(err => log.error({ err }, 'Failed to start Telegram'));
    }
  } else if (!should && currentlyActive) {
    const adapter = getAdapter('telegram') as TelegramAdapter | undefined;
    if (adapter) {
      log.info({ host: process.env.HOST_HOSTNAME, activeHost: readActiveHost() }, 'Deactivating Telegram — another machine is active');
      adapter.stop()
        .then(() => { currentlyActive = false; })
        .catch(err => log.error({ err }, 'Failed to stop Telegram'));
    }
  }
}

export function stopHostControl(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

