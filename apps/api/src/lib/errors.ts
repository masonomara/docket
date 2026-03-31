/**
 * Standardized error response utilities.
 * Use these helpers to ensure consistent error format across all handlers.
 */

// Standard error codes used across the API
export type ErrorCode =
  // 400 Bad Request
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "VALIDATION_ERROR"
  | "MISSING_FIELD"
  | "INVALID_FIELD"
  | "ALREADY_EXISTS"
  | "CANNOT_REMOVE_SELF"
  | "CANNOT_MODIFY_OWNER"
  | "NAME_MISMATCH"
  | "EMAIL_MISMATCH"
  | "SOLE_OWNER"
  | "ALREADY_MEMBER"
  | "INVITATION_EXPIRED"
  | "INVITATION_ACCEPTED"
  // 403 Forbidden
  | "FORBIDDEN"
  | "NOT_OWNER"
  | "ADMIN_REQUIRED"
  | "NOT_MEMBER"
  // 404 Not Found
  | "NOT_FOUND"
  | "ORG_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "INVITATION_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "CONVERSATION_NOT_FOUND"
  | "CONFIRMATION_NOT_FOUND"
  // 405 Method Not Allowed
  | "METHOD_NOT_ALLOWED"
  // 500 Server Error
  | "INTERNAL_ERROR"
  | "DB_ERROR";

interface APIError {
  error: string;
  code: ErrorCode;
  details?: unknown;
}

/**
 * Create a standardized JSON error response.
 */
export function errorResponse(
  status: number,
  message: string,
  code: ErrorCode,
  details?: unknown
): Response {
  const body: APIError = { error: message, code };
  if (details !== undefined) body.details = details;
  return Response.json(body, { status });
}

// Common error factories for frequently used errors
export const errors = {
  invalidJson: () => errorResponse(400, "Invalid JSON body", "INVALID_JSON"),

  invalidRequest: (details?: unknown) =>
    errorResponse(400, "Invalid request", "INVALID_REQUEST", details),

  validationError: (message: string, details?: unknown) =>
    errorResponse(400, message, "VALIDATION_ERROR", details),

  missingField: (field: string) =>
    errorResponse(400, `${field} is required`, "MISSING_FIELD"),

  methodNotAllowed: () =>
    errorResponse(405, "Method not allowed", "METHOD_NOT_ALLOWED"),

  notFound: (resource: string) =>
    errorResponse(404, `${resource} not found`, "NOT_FOUND"),

  forbidden: (message = "Forbidden") =>
    errorResponse(403, message, "FORBIDDEN"),

  notMember: () =>
    errorResponse(403, "Not a member of organization", "NOT_MEMBER"),

  adminRequired: () =>
    errorResponse(403, "Admin role required", "ADMIN_REQUIRED"),

  internal: (message = "Internal server error") =>
    errorResponse(500, message, "INTERNAL_ERROR"),
};

/**
 * Map service error types to HTTP status codes.
 * Use this when services return typed error results.
 */
export function getStatusForError(errorType: string): number {
  const statusMap: Record<string, number> = {
    // 400 errors
    is_owner: 400,
    target_not_admin: 400,
    sole_owner: 400,
    already_exists: 400,
    already_member: 400,
    invitation_expired: 400,
    invitation_accepted: 400,
    // 403 errors
    not_owner: 403,
    forbidden: 403,
    not_member: 403,
    // 404 errors
    not_found: 404,
    user_not_member: 404,
    target_not_member: 404,
    // 500 errors
    db_error: 500,
  };
  return statusMap[errorType] ?? 500;
}
