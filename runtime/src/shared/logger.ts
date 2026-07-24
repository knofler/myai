import pino from 'pino';
import { getConfig } from './config.js';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!_logger) {
    const config = getConfig();
    _logger = pino({
      level: config.logging.level,
      ...(config.logging.pretty
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
        : {}),
    });
  }
  return _logger;
}

export function createChildLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
