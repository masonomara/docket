import { API_URL } from "./auth-client";

/**
 * Generate a short request ID for tracing requests through the system.
 */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Retry delays in milliseconds for failed requests.
 * We use exponential backoff: 500ms, then 1000ms.
 */
const RETRY_DELAYS = [500, 1000];
const MAX_ATTEMPTS = 3;

/**
 * Wraps a fetch call with automatic retry logic for server errors (5xx).
 * Client errors (4xx) are returned immediately without retry.
 */
async function fetchWithRetry(
  doFetch: () => Promise<Response>
): Promise<Response> {
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await doFetch();

    // Success or client error - return immediately
    if (response.status < 500) {
      return response;
    }

    // Server error - save response and maybe retry
    lastResponse = response;

    // Don't wait after the last attempt
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    if (!isLastAttempt) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS[attempt])
      );
    }
  }

  // All retries exhausted, return the last failed response
  return lastResponse!;
}

/**
 * API endpoint paths. Dynamic paths are functions that take an ID parameter.
 */
export const ENDPOINTS = {
  auth: {
    session: "/api/auth/get-session",
    checkEmail: "/api/check-email",
  },
  account: {
    base: "/api/account",
    deletionPreview: "/api/account/deletion-preview",
  },
  org: {
    base: "/api/org",
    deletionPreview: "/api/org/deletion-preview",
    members: "/api/org/members",
    member: (userId: string) => `/api/org/members/${userId}`,
    invitations: "/api/org/invitations",
    invitation: (id: string) => `/api/org/invitations/${id}`,
    transferOwnership: "/api/org/transfer-ownership",
    context: "/api/org/context",
    contextDoc: (id: string) => `/api/org/context/${id}`,
    clioRefreshSchema: "/api/org/clio/refresh-schema",
  },
  user: {
    org: "/api/user/org",
  },
  invitations: {
    get: (id: string) => `/api/invitations/${id}`,
    accept: (id: string) => `/api/invitations/${id}/accept`,
  },
  clio: {
    status: "/api/clio/status",
    connect: "/api/clio/connect",
    disconnect: "/api/clio/disconnect",
  },
} as const;

/**
 * The shape of the Cloudflare context object passed to loaders.
 * We only care about the API service binding for direct worker-to-worker calls.
 */
interface CloudflareContext {
  cloudflare?: {
    env?: {
      API?: {
        fetch: typeof fetch;
      };
    };
  };
}

/**
 * Fetch from the API, using service binding when available (faster, no network hop)
 * or falling back to regular HTTP fetch in development.
 */
export async function apiFetch(
  context: unknown,
  path: string,
  cookie: string,
  requestId?: string
): Promise<Response> {
  // Build headers
  const headers: Record<string, string> = { Cookie: cookie };
  if (requestId) {
    headers["X-Request-Id"] = requestId;
  }

  // Try to use the Cloudflare service binding for worker-to-worker calls
  const cloudflareContext = context as CloudflareContext;
  const apiBinding = cloudflareContext.cloudflare?.env?.API;

  if (apiBinding) {
    try {
      const request = new Request(`https://api.docketadmin.com${path}`, {
        headers,
      });
      return await fetchWithRetry(() => apiBinding.fetch(request));
    } catch (error) {
      console.error("Service binding fetch failed:", error);
      // Fall through to regular fetch
    }
  }

  // Fallback to regular HTTP fetch (used in development)
  return fetchWithRetry(() => fetch(`${API_URL}${path}`, { headers }));
}
