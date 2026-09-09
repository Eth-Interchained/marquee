/**
 * Structured stdout logging for the main process.
 *
 * The shell is a desktop process, not an HTTP server, so there is no request
 * logger to hang off. One line of JSON per event keeps `--enable-logging`
 * output greppable and safe to ship to a file.
 */

export type LogFields = Record<string, unknown>;

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, fields?: LogFields) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    scope,
    msg,
    ...fields,
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export type Logger = {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(scope: string): Logger;
};

export function createLogger(scope: string): Logger {
  return {
    info: (msg, fields) => emit("info", scope, msg, fields),
    warn: (msg, fields) => emit("warn", scope, msg, fields),
    error: (msg, fields) => emit("error", scope, msg, fields),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { err: error.message, stack: error.stack };
  }
  return { err: String(error) };
}

export const log: Logger = createLogger("marquee-shell");
