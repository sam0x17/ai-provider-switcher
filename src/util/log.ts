export interface Logger {
  info(message: string): void;
  debug(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, debug() {}, error() {} };

export function prefixed(base: Logger, prefix: string): Logger {
  return {
    info: (m) => base.info(`${prefix} ${m}`),
    debug: (m) => base.debug(`${prefix} ${m}`),
    error: (m) => base.error(`${prefix} ${m}`),
  };
}
