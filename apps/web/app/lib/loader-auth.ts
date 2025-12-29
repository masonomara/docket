import { redirect } from "react-router";
import { apiFetch, generateRequestId } from "./api";
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
 * The org may or may not exist - use this for pages like /dashboard.
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
 * Redirects to /auth if not logged in, /dashboard if no org.
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
  loader: (ctx: OrgLoaderContext) => Promise<T> | T,
  options: { requireAdmin?: boolean } = {}
) {
  return async ({ request, context }: LoaderArgs): Promise<T> => {
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

    return loader(loaderContext);
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
  // Step 1: Check session
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie,
    requestId
  );
  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // Step 2: Check org membership
  const orgResponse = await apiFetch(
    context,
    "/api/user/org",
    cookie,
    requestId
  );
  if (!orgResponse.ok) {
    throw redirect("/dashboard");
  }

  const org = (await orgResponse.json()) as OrgMembership | null;
  if (!org?.org) {
    throw redirect("/dashboard");
  }

  // Step 3: Check admin requirement
  if (options.requireAdmin && org.role !== "admin") {
    throw redirect("/dashboard");
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
  // Step 1: Check session
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie,
    requestId
  );
  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // Step 2: Try to get org (optional)
  const orgResponse = await apiFetch(
    context,
    "/api/user/org",
    cookie,
    requestId
  );

  let org: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      org = orgData;
    }
  }

  return { user: session.user, org };
}
