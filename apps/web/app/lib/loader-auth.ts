import { redirect } from "react-router";
import { apiFetch, generateRequestId, ENDPOINTS } from "./api";
import type { SessionResponse, OrgMembership } from "./types";

// ============================================================================
// Types
// ============================================================================

/**
 * Standard React Router loader args.
 */
interface LoaderArgs {
  request: Request;
  context: unknown;
  params: Record<string, string | undefined>;
}

/**
 * User info from the session, guaranteed to exist after auth check.
 */
type AuthenticatedUser = SessionResponse["user"];

/**
 * Context passed to protected loaders (user must be logged in, org optional).
 */
export interface ProtectedLoaderContext {
  user: AuthenticatedUser;
  org: OrgMembership | null;
  cookie: string;
  requestId: string;
  /** Helper to fetch from the API with auth cookies and request ID already set. */
  fetch: (path: string) => Promise<Response>;
}

/**
 * Context passed to org loaders (user must be logged in AND have an org).
 */
export interface OrgLoaderContext {
  user: AuthenticatedUser;
  org: OrgMembership;
  cookie: string;
  requestId: string;
  /** Helper to fetch from the API with auth cookies and request ID already set. */
  fetch: (path: string) => Promise<Response>;
}

// ============================================================================
// Loader Wrappers
// ============================================================================

/**
 * Wraps a loader to require authentication. Redirects to /auth if not logged in.
 * The org may or may not exist - use this for pages like /admin.
 *
 * Usage:
 *   export const loader = protectedLoader(async ({ user, org, fetch }) => {
 *     const data = await fetch("/api/some-endpoint").then(r => r.json());
 *     return { user, data };
 *   });
 */
export function protectedLoader<T>(
  loader: (ctx: ProtectedLoaderContext) => Promise<T> | T
) {
  return async ({ request, context }: LoaderArgs): Promise<T> => {
    const requestId = generateRequestId();
    const cookie = request.headers.get("cookie") || "";

    // Check if user is logged in
    const auth = await checkAuthOptionalOrg(context, cookie, requestId);

    // Build the context object for the loader
    const loaderContext: ProtectedLoaderContext = {
      user: auth.user,
      org: auth.org,
      cookie,
      requestId,
      fetch: (path: string) => apiFetch(context, path, cookie, requestId),
    };

    return loader(loaderContext);
  };
}

/**
 * Wraps a loader to require both authentication AND org membership.
 * Redirects to /auth if not logged in, /admin if no org.
 *
 * Usage:
 *   export const loader = orgLoader(async ({ user, org, fetch }) => {
 *     const members = await fetch("/api/org/members").then(r => r.json());
 *     return { members };
 *   });
 *
 *   // For admin-only pages:
 *   export const loader = orgLoader(async ({ user, org }) => {
 *     return { org };
 *   }, { requireAdmin: true });
 */
export function orgLoader<T>(
  loader: (
    ctx: OrgLoaderContext,
    args: { params: Record<string, string | undefined> }
  ) => Promise<T> | T,
  options: { requireAdmin?: boolean } = {}
) {
  return async ({ request, context, params }: LoaderArgs): Promise<T> => {
    const requestId = generateRequestId();
    const cookie = request.headers.get("cookie") || "";

    // Check if user is logged in AND has an org
    const auth = await checkAuthRequireOrg(context, cookie, requestId, options);

    // Build the context object for the loader
    const loaderContext: OrgLoaderContext = {
      user: auth.user,
      org: auth.org,
      cookie,
      requestId,
      fetch: (path: string) => apiFetch(context, path, cookie, requestId),
    };

    return loader(loaderContext, { params });
  };
}

// ============================================================================
// Auth Checking Functions
// ============================================================================

/**
 * Check that user is logged in AND has an org membership.
 * Throws redirect if either condition fails.
 */
export async function requireOrgAuth(
  context: unknown,
  cookie: string,
  requestId: string,
  options: { requireAdmin?: boolean } = {}
): Promise<{ user: AuthenticatedUser; org: OrgMembership }> {
  return checkAuthRequireOrg(context, cookie, requestId, options);
}

/**
 * Internal: Check auth and require org membership.
 */
async function checkAuthRequireOrg(
  context: unknown,
  cookie: string,
  requestId: string,
  options: { requireAdmin?: boolean }
): Promise<{ user: AuthenticatedUser; org: OrgMembership }> {
  // Fetch session and org in parallel (no dependency between them)
  const [sessionResponse, orgResponse] = await Promise.all([
    apiFetch(context, "/api/auth/get-session", cookie, requestId),
    apiFetch(context, "/api/user/org", cookie, requestId),
  ]);

  // Check session
  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }
  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // Check org membership
  if (!orgResponse.ok) {
    throw redirect("/admin");
  }
  const org = (await orgResponse.json()) as OrgMembership | null;
  if (!org?.org) {
    throw redirect("/admin");
  }

  // Check admin requirement
  if (options.requireAdmin && org.role !== "admin") {
    throw redirect("/admin");
  }

  return { user: session.user, org };
}

/**
 * Internal: Check auth but org is optional.
 */
async function checkAuthOptionalOrg(
  context: unknown,
  cookie: string,
  requestId: string
): Promise<{ user: AuthenticatedUser; org: OrgMembership | null }> {
  // Fetch session and org in parallel (no dependency between them)
  const [sessionResponse, orgResponse] = await Promise.all([
    apiFetch(context, "/api/auth/get-session", cookie, requestId),
    apiFetch(context, "/api/user/org", cookie, requestId),
  ]);

  // Check session (required)
  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }
  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // Check org (optional)
  let org: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      org = orgData;
    }
  }

  return { user: session.user, org };
}

// ============================================================================
// Layout Route Loaders (New Streaming Architecture)
// ============================================================================

/**
 * Data returned by appLayoutLoader, available to _app layout and children.
 */
export interface AppLayoutData {
  user: AuthenticatedUser;
  org: OrgMembership | null;
}

/**
 * Loader for the _app layout route. Fetches session and org in parallel.
 * Redirects to /auth if not authenticated.
 *
 * Usage in _app.tsx:
 *   export const loader = appLayoutLoader;
 */
export async function appLayoutLoader({
  request,
  context,
}: LoaderArgs): Promise<AppLayoutData> {
  const requestId = generateRequestId();
  const cookie = request.headers.get("cookie") || "";

  // Fetch session and org in parallel
  const [sessionResponse, orgResponse] = await Promise.all([
    apiFetch(context, ENDPOINTS.auth.session, cookie, requestId),
    apiFetch(context, ENDPOINTS.user.org, cookie, requestId),
  ]);

  // Check session
  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }
  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // Check org (optional)
  let org: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      org = orgData;
    }
  }

  return { user: session.user, org };
}

/**
 * Context passed to child loaders under the _app layout.
 */
export interface ChildLoaderContext {
  fetch: (path: string) => Promise<Response>;
  params: Record<string, string | undefined>;
}

/**
 * Wrapper for child route loaders that need to fetch additional data.
 * Auth is inherited from parent _app layout - this just provides a fetch helper.
 *
 * Usage:
 *   export const loader = childLoader(async ({ fetch, params }) => {
 *     const data = await fetch("/api/some-endpoint").then(r => r.json());
 *     return { data };
 *   });
 */
export function childLoader<T>(
  loader: (ctx: ChildLoaderContext) => Promise<T> | T
) {
  return async ({ request, context, params }: LoaderArgs): Promise<T> => {
    const requestId = generateRequestId();
    const cookie = request.headers.get("cookie") || "";

    return loader({
      fetch: (path: string) => apiFetch(context, path, cookie, requestId),
      params,
    });
  };
}
