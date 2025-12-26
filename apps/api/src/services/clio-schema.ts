// =============================================================================
// Clio Schema Service
// =============================================================================
//
// Fetches per-org custom fields from Clio. Base object fields (matters, contacts,
// etc.) are not fetched - the LLM uses its training knowledge of Clio's API.
// Only custom fields vary per-firm and need to be fetched.

import { createLogger } from "../lib/logger";

const log = createLogger({ component: "clio-schema" });
const CLIO_API_BASE = "https://app.clio.com/api/v4";

/**
 * Increment when custom field handling changes.
 * Used to invalidate cached custom fields.
 */
export const CLIO_SCHEMA_VERSION = 2;

/**
 * Custom fields refresh after this duration (1 hour).
 * Lazy refresh: only checked when user makes a Clio API call.
 */
export const CUSTOM_FIELDS_TTL_MS = 60 * 60 * 1000;

/**
 * Parent types that support custom fields in Clio
 */
const CUSTOM_FIELD_PARENT_TYPES = ["Matter", "Contact"] as const;

// =============================================================================
// Types
// =============================================================================

export interface ClioCustomField {
  id: number;
  name: string;
  fieldType: string; // checkbox, contact, date, email, etc.
  parentType: string; // Matter or Contact
  required?: boolean;
  options?: string[]; // For picklist/multi-select types
}

interface ClioCustomFieldApiResponse {
  data: Array<{
    id: number;
    name: string;
    field_type: string;
    parent_type: string;
    required?: boolean;
    picklist_options?: Array<{ option: string }>;
  }>;
}

// =============================================================================
// Custom Field Fetching
// =============================================================================

/**
 * Fetch custom fields for a specific parent type.
 *
 * @param parentType - "Matter" or "Contact"
 * @param accessToken - Valid Clio access token
 * @returns Array of custom fields, empty if none or fetch failed
 */
async function fetchCustomFieldsForType(
  parentType: string,
  accessToken: string
): Promise<ClioCustomField[]> {
  const url = `${CLIO_API_BASE}/custom_fields.json?parent_type=${parentType}&deleted=false&fields=id,name,field_type,parent_type,required,picklist_options`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error("Failed to fetch custom fields", {
      parentType,
      status: response.status,
      error: errorText.slice(0, 200),
    });
    return [];
  }

  const data = (await response.json()) as ClioCustomFieldApiResponse;

  if (!data.data || data.data.length === 0) {
    return [];
  }

  return data.data.map((field) => ({
    id: field.id,
    name: field.name,
    fieldType: field.field_type,
    parentType: field.parent_type,
    required: field.required,
    options: field.picklist_options?.map((p) => p.option),
  }));
}

/**
 * Fetch all custom fields for the organization.
 *
 * Fetches Matter and Contact custom fields in parallel.
 *
 * @param accessToken - Valid Clio access token
 * @returns Array of all custom fields
 */
export async function fetchAllCustomFields(
  accessToken: string
): Promise<ClioCustomField[]> {
  const fetchPromises = CUSTOM_FIELD_PARENT_TYPES.map((type) =>
    fetchCustomFieldsForType(type, accessToken)
  );

  const results = await Promise.allSettled(fetchPromises);

  const allFields: ClioCustomField[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allFields.push(...result.value);
    }
  }

  log.info("Custom fields fetched", { count: allFields.length });
  return allFields;
}

// =============================================================================
// Formatting (for LLM context)
// =============================================================================

/**
 * Format custom fields into a compact string for LLM context.
 *
 * Example output:
 * ```
 * Matter Custom Fields: Case Type (picklist: Criminal|Civil|Family), Jurisdiction (text)
 * Contact Custom Fields: SSN (text), Preferred Name (text)
 * ```
 */
export function formatCustomFieldsForLLM(fields: ClioCustomField[]): string {
  if (fields.length === 0) {
    return "";
  }

  const byType = new Map<string, ClioCustomField[]>();
  for (const field of fields) {
    const existing = byType.get(field.parentType) || [];
    existing.push(field);
    byType.set(field.parentType, existing);
  }

  const lines: string[] = [];
  for (const [parentType, typeFields] of byType) {
    const fieldDescriptions = typeFields.map((field) => {
      let desc = `${field.name} (${field.fieldType}`;
      if (field.options && field.options.length > 0) {
        desc += `: ${field.options.join("|")}`;
      }
      if (field.required) {
        desc += ", required";
      }
      desc += ")";
      return desc;
    });
    lines.push(`${parentType} Custom Fields: ${fieldDescriptions.join(", ")}`);
  }

  return lines.join("\n");
}

// =============================================================================
// Versioning & TTL
// =============================================================================

/**
 * Check if cached custom fields are outdated.
 *
 * Returns true if:
 * - No cached version exists
 * - Cached version is older than current CLIO_SCHEMA_VERSION
 * - Cache is older than CUSTOM_FIELDS_TTL_MS (1 hour)
 *
 * @param cachedVersion - Version of cached custom fields (null if none)
 * @param fetchedAt - Timestamp when custom fields were last fetched (null if never)
 * @returns true if custom fields should be re-fetched
 */
export function customFieldsNeedRefresh(
  cachedVersion: number | null,
  fetchedAt: number | null
): boolean {
  // No cache exists
  if (cachedVersion === null || fetchedAt === null) {
    return true;
  }

  // Version mismatch (developer bumped version)
  if (cachedVersion < CLIO_SCHEMA_VERSION) {
    return true;
  }

  // TTL expired (lazy refresh after 1 hour)
  const age = Date.now() - fetchedAt;
  if (age > CUSTOM_FIELDS_TTL_MS) {
    return true;
  }

  return false;
}
