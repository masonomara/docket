import { API_URL } from "./auth-client";

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
 * Makes an authenticated API request, using the service binding when available
 * (for server-side requests in Cloudflare Workers) or falling back to fetch.
 *
 * @param context - The loader/action context from React Router
 * @param path - API path like "/api/auth/get-session"
 * @param cookie - The cookie header from the incoming request
 */
export async function apiFetch(
  context: unknown,
  path: string,
  cookie: string
): Promise<Response> {
  const requestOptions = {
    headers: { Cookie: cookie },
  };

  // Try to use the Cloudflare service binding if available (server-side)
  const cloudflareContext = context as {
    cloudflare?: {
      env?: {
        API?: { fetch: typeof fetch };
      };
    };
  };

  const serviceBinding = cloudflareContext.cloudflare?.env?.API;

  if (serviceBinding) {
    try {
      const request = new Request(
        `https://api.docketadmin.com${path}`,
        requestOptions
      );
      return await serviceBinding.fetch(request);
    } catch (error) {
      // Service binding failed, fall through to regular fetch
      console.error("Service binding fetch failed:", error);
    }
  }

  // Fallback to regular fetch (client-side or if service binding unavailable)
  return fetch(`${API_URL}${path}`, requestOptions);
}
