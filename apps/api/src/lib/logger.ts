export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  orgId?: string;
  userId?: string;
  [key: string]: unknown;
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * Creates a structured JSON logger with optional context.
 * Child loggers inherit parent context.
 */
export function createLogger(context: LogContext = {}) {
  function log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void {
    // Build the log entry
    const entry: Record<string, unknown> = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...context,
      ...extra,
    };

    // Extract error details if present
    if (extra?.error instanceof Error) {
      entry.error = extra.error.message;
      entry.stack = extra.error.stack;
    }

    // Output as JSON
    const output = JSON.stringify(entry);

    // Use appropriate console method based on level
    switch (level) {
      case "error":
        console.error(output);
        break;
      case "warn":
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) =>
      log("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) =>
      log("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      log("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) =>
      log("error", msg, extra),

    /**
     * Creates a child logger that inherits this logger's context
     * plus additional context.
     */
    child: (childContext: LogContext) =>
      createLogger({ ...context, ...childContext }),
  };
}

/**
 * Generates a short request ID for tracing.
 */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Default logger instance for convenience.
 */
export const logger = createLogger();
