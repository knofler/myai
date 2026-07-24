import { disconnectDB } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'shutdown' });

let isShuttingDown = false;

export function setupGracefulShutdown(cleanup?: (signal: string) => Promise<void>): void {
  const handler = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log.info({ signal }, 'Graceful shutdown initiated');

    const timeout = setTimeout(() => {
      log.error('Shutdown timeout exceeded (30s) — forcing exit');
      process.exit(1);
    }, 30_000);

    try {
      if (cleanup) await cleanup(signal);
      await disconnectDB();
      log.info('Shutdown complete');
      clearTimeout(timeout);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'Error during shutdown');
      clearTimeout(timeout);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}
