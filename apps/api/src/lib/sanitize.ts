/**
 * Fields that contain personally identifiable information and should be redacted.
 */
const PII_FIELDS = new Set([
  // Name fields
  "name",
  "first_name",
  "last_name",

  // Contact info
  "email",
  "phone",
  "phone_number",
  "mobile",
  "fax",
  "primary_email_address",
  "primary_phone_number",
  "secondary_email_address",
  "secondary_phone_number",

  // Address fields
  "address",
  "street",
  "city",
  "state",
  "zip",
  "postal_code",
  "country",
  "primary_address",
  "secondary_address",
  "billing_address",

  // Financial info
  "credit_card",
  "bank_account",
  "ssn",
  "tax_id",
  "ein",

  // Free-form text that may contain PII
  "description",
  "notes",
  "memo",
  "body",
  "content",
  "message",
]);

/**
 * Fields that are safe to include in audit logs without redaction.
 */
const SAFE_FIELDS = new Set([
  "id",
  "object_id",
  "objecttype",
  "object_type",
  "type",
  "status",
  "count",
  "objectcount",
  "created_at",
  "updated_at",
  "etag",
]);

/**
 * Sanitizes parameters for audit logging by redacting PII.
 * Safe fields (IDs, types, status) are preserved.
 * Unknown string fields are redacted by default.
 */
export function sanitizeAuditParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    sanitized[key] = sanitizeValue(key, value);
  }

  return sanitized;
}

function sanitizeValue(key: string, value: unknown): unknown {
  const lowerKey = key.toLowerCase();

  // Always redact known PII fields
  if (PII_FIELDS.has(lowerKey)) {
    return "[REDACTED]";
  }

  // Preserve known safe fields and ID fields
  if (SAFE_FIELDS.has(lowerKey) || lowerKey.endsWith("_id")) {
    return value;
  }

  // Preserve null, undefined, numbers, and booleans
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  // Redact unknown strings
  if (typeof value === "string") {
    return "[REDACTED]";
  }

  // Recursively sanitize arrays
  if (Array.isArray(value)) {
    return sanitizeArray(value);
  }

  // Recursively sanitize objects
  if (typeof value === "object") {
    return sanitizeAuditParams(value as Record<string, unknown>);
  }

  // Redact anything else
  return "[REDACTED]";
}

function sanitizeArray(arr: unknown[]): unknown[] {
  return arr.map((item) => {
    if (typeof item === "object" && item !== null) {
      return sanitizeAuditParams(item as Record<string, unknown>);
    }

    if (typeof item === "string") {
      return "[REDACTED]";
    }

    return item;
  });
}
