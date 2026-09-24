import type { Logger } from "./types.js";

/**
 * Default logger: warnings and errors only.
 *
 * This SDK runs inside someone else's server. It should be audible when
 * something is actually wrong — a bad key, a config that will not load — and
 * silent otherwise, so it never becomes the noisiest thing in their logs.
 */
export const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn(message, meta) {
    if (meta === undefined) console.warn(`[spectry] ${message}`);
    else console.warn(`[spectry] ${message}`, meta);
  },
  error(message, meta) {
    if (meta === undefined) console.error(`[spectry] ${message}`);
    else console.error(`[spectry] ${message}`, meta);
  },
};

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function resolveLogger(logger: Logger | false | undefined): Logger {
  if (logger === false) return silentLogger;
  return logger ?? defaultLogger;
}
