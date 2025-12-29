// =============================================================================
// Clio API Client
// =============================================================================

const CLIO_API_BASE = "https://app.clio.com/api/v4";

/**
 * Maps our internal object type names to Clio API endpoint paths.
 * All keys are lowercase for case-insensitive lookups.
 */
const OBJECT_ENDPOINTS: Record<string, string> = {
  matter: "matters",
  contact: "contacts",
  task: "tasks",
  calendar_entry: "calendar_entries",
  time_entry: "time_entries",
  document: "documents",
  practice_area: "practice_areas",
  activity_description: "activity_descriptions",
  user: "users",
};

// =============================================================================
// Types
// =============================================================================

export interface ClioApiError {
  message: string;
  status: number;
  clioError?: string;
}

export interface ClioApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ClioApiError;
}

// =============================================================================
// API Execution
// =============================================================================

/**
 * Execute a request to the Clio API.
 *
 * Handles:
 * - Authorization header injection
 * - Rate limiting (429 with retry)
 * - Error mapping to user-friendly messages
 */
export async function executeClioCall<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  endpoint: string,
  accessToken: string,
  body?: Record<string, unknown>
): Promise<ClioApiResponse<T>> {
  const url = `${CLIO_API_BASE}${endpoint}`;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  const requestBody = body ? JSON.stringify(body) : undefined;

  // Make the request
  let response = await fetch(url, { method, headers, body: requestBody });

  // Handle rate limiting - wait and retry once
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;

    await sleep(waitMs);
    response = await fetch(url, { method, headers, body: requestBody });
  }

  // DELETE returns 204 No Content on success
  if (method === "DELETE" && response.status === 204) {
    return { success: true };
  }

  // Handle errors
  if (!response.ok) {
    const error = await mapClioError(response);
    return { success: false, error };
  }

  // Parse successful response
  const responseData = (await response.json()) as { data: T };
  return { success: true, data: responseData.data };
}

/**
 * Simple sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map Clio error responses to user-friendly messages
 */
async function mapClioError(response: Response): Promise<ClioApiError> {
  // Try to extract Clio's error message from the response body
  let clioError: string | undefined;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    clioError = body.error?.message;
  } catch {
    // Response body wasn't JSON or couldn't be parsed
  }

  // Map status codes to user-friendly messages
  const statusMessages: Record<number, string> = {
    400: "Invalid request. Please check your query and try again.",
    401: "Authentication failed. Your Clio connection may need to be refreshed.",
    403: "You don't have permission to access this resource.",
    404: "The requested record was not found.",
    410: "This record has been deleted from Clio",
    422: "The data provided is invalid. Please check the values and try again.",
    429: "Too many requests. Please wait a moment and try again.",
    500: "Clio is experiencing issues. Please try again later.",
    503: "Clio is temporarily unavailable. Please try again later.",
  };

  const message =
    statusMessages[response.status] || `Clio error: ${response.status}`;

  return {
    status: response.status,
    message,
    clioError,
  };
}

// =============================================================================
// Query Building
// =============================================================================

/**
 * Get the API endpoint for an object type (case-insensitive)
 */
function getEndpoint(objectType: string): string {
  const endpoint = OBJECT_ENDPOINTS[objectType.toLowerCase()];

  if (!endpoint) {
    throw new Error(`Unknown object type: ${objectType}`);
  }

  return endpoint;
}

/**
 * Build a GET endpoint for reading Clio objects.
 *
 * @param objectType - The type of object (Matter, Contact, Task, etc.)
 * @param id - Optional ID for fetching a single record
 * @param filters - Optional query filters for list operations
 * @param fields - Optional specific fields to return
 */
export function buildReadQuery(
  objectType: string,
  id?: string,
  filters?: Record<string, unknown>,
  fields?: string[]
): string {
  const endpoint = getEndpoint(objectType);

  // Single record by ID
  if (id) {
    const params = new URLSearchParams();

    if (fields && fields.length > 0) {
      params.set("fields", fields.join(","));
    }

    const query = params.toString();
    const queryString = query ? `?${query}` : "";

    return `/${endpoint}/${id}.json${queryString}`;
  }

  // List of records with optional filters
  const params = new URLSearchParams();

  // Add filters to query string
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      // Skip null/undefined values
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
  }

  // Add fields parameter
  if (fields && fields.length > 0) {
    params.set("fields", fields.join(","));
  }

  const query = params.toString();
  const queryString = query ? `?${query}` : "";

  return `/${endpoint}.json${queryString}`;
}

/**
 * Build a POST body for creating a new Clio object.
 *
 * Clio expects the format: { data: { ...fields } }
 */
export function buildCreateBody(
  objectType: string,
  data: Record<string, unknown>
): { endpoint: string; body: Record<string, unknown> } {
  const endpoint = getEndpoint(objectType);

  return {
    endpoint: `/${endpoint}.json`,
    body: {
      data,
    },
  };
}

/**
 * Build a PATCH body for updating an existing Clio object.
 *
 * Clio expects the format: { data: { ...fields } }
 */
export function buildUpdateBody(
  objectType: string,
  id: string,
  data: Record<string, unknown>
): { endpoint: string; body: Record<string, unknown> } {
  const endpoint = getEndpoint(objectType);

  return {
    endpoint: `/${endpoint}/${id}.json`,
    body: {
      data,
    },
  };
}

/**
 * Build a DELETE endpoint for removing a Clio object.
 */
export function buildDeleteEndpoint(objectType: string, id: string): string {
  const endpoint = getEndpoint(objectType);
  return `/${endpoint}/${id}.json`;
}

// =============================================================================
// Response Formatting
// =============================================================================

/**
 * Format Clio API response data into a human-readable string.
 * Used for displaying results to users via chat.
 */
export function formatClioResponse(objectType: string, data: unknown): string {
  // Empty array
  if (Array.isArray(data) && data.length === 0) {
    return `No ${objectType} records found.`;
  }

  // Array of records
  if (Array.isArray(data)) {
    const count = data.length;
    const json = JSON.stringify(data, null, 2);
    return `Found ${count} ${objectType} record(s):\n${json}`;
  }

  // Single record
  const json = JSON.stringify(data, null, 2);
  return `${objectType} record:\n${json}`;
}
