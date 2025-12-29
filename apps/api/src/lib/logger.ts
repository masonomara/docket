export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  orgId?: string;
  userId?: string;
  handler?: string;
  [key: string]: unknown;
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * Creates a structured JSON logger with context that gets included in every log entry.
 *
 * Usage:
 *   const logger = createLogger({ requestId: "abc123", handler: "clio" });
 *   logger.info("Processing request", { matterId: "12345" });
 *
 * To add more context later, use .child():
 *   const childLogger = logger.child({ orgId: "org-456" });
 */
export function createLogger(context: LogContext = {}) {
  function log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>
  ): void {
    // Build the log entry with all context
    const entry: Record<string, unknown> = {
      level,
      message,
      timestamp: new Date().toISOString(),
      ...context,
      ...extra,
    };

    // Extract error details if an Error object was passed
    if (extra?.error instanceof Error) {
      entry.error = extra.error.message;
      entry.stack = extra.error.stack;
    }

    const output = JSON.stringify(entry);

    // Route to appropriate console method
    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else {
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

    child: (childContext: LogContext) =>
      createLogger({ ...context, ...childContext }),
  };
}

/**
 * Generates a short unique ID for request tracing.
 * Uses first 8 chars of a UUID for brevity while maintaining uniqueness.
 */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Default logger instance for cases where no context is needed */
export const logger = createLogger();

/**
 * Logs an authorization failure with consistent formatting.
 * Used by session middleware when access is denied.
 */
export function logAuthzFailure(
  handler: string,
  reason: string,
  context: {
    userId?: string;
    email?: string;
    path?: string;
    orgId?: string;
  }
): void {
  createLogger({ requestId: generateRequestId(), handler }).warn(
    "Authorization failed",
    { reason, ...context }
  );
}
