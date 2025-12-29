import { redirect } from "react-router";
import { apiFetch } from "./api";
import type { SessionResponse, OrgMembership } from "./types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface AuthResult {
  user: SessionResponse["user"];
  org: OrgMembership;
}

interface OptionalOrgResult {
  user: SessionResponse["user"];
  org: OrgMembership | null;
}

interface AuthOptions {
  requireAdmin?: boolean;
}

type LoaderArgs = { request: Request; context: unknown };

type AuthenticatedLoaderContext<T extends OptionalOrgResult | AuthResult> =
  T & {
    cookie: string;
    fetch: (path: string) => Promise<Response>;
  };

// -----------------------------------------------------------------------------
// Protected Loader Wrappers
// -----------------------------------------------------------------------------

/**
 * Wraps a loader that requires authentication (org optional).
 * Provides auth data plus helpers for additional API calls.
 */
export function protectedLoader<T>(
  loader: (ctx: AuthenticatedLoaderContext<OptionalOrgResult>) => Promise<T> | T
) {
  return async ({ request, context }: LoaderArgs): Promise<T> => {
    const auth = await requireAuth(request, context);
    const cookie = request.headers.get("cookie") || "";
    return loader({
      ...auth,
      cookie,
      fetch: (path: string) => apiFetch(context, path, cookie),
    });
  };
}

/**
 * Wraps a loader that requires org membership.
 * Redirects to /dashboard if user has no org.
 */
export function orgLoader<T>(
  loader: (ctx: AuthenticatedLoaderContext<AuthResult>) => Promise<T> | T,
  options: AuthOptions = {}
) {
  return async ({ request, context }: LoaderArgs): Promise<T> => {
    const auth = await requireOrgAuth(request, context, options);
    const cookie = request.headers.get("cookie") || "";
    return loader({
      ...auth,
      cookie,
      fetch: (path: string) => apiFetch(context, path, cookie),
    });
  };
}

// -----------------------------------------------------------------------------
// Core Auth Functions (used by wrappers)
// -----------------------------------------------------------------------------

export async function requireOrgAuth(
  request: Request,
  context: unknown,
  options: AuthOptions = {}
): Promise<AuthResult> {
  const cookie = request.headers.get("cookie") || "";

  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );
  if (!sessionResponse.ok) throw redirect("/auth");

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;
  if (!sessionData?.user) throw redirect("/auth");

  const orgResponse = await apiFetch(context, "/api/user/org", cookie);
  if (!orgResponse.ok) throw redirect("/dashboard");

  const orgMembership = (await orgResponse.json()) as OrgMembership | null;
  if (!orgMembership?.org) throw redirect("/dashboard");

  if (options.requireAdmin && orgMembership.role !== "admin") {
    throw redirect("/dashboard");
  }

  return { user: sessionData.user, org: orgMembership };
}

export async function requireAuth(
  request: Request,
  context: unknown
): Promise<OptionalOrgResult> {
  const cookie = request.headers.get("cookie") || "";

  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );
  if (!sessionResponse.ok) throw redirect("/auth");

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;
  if (!sessionData?.user) throw redirect("/auth");

  const orgResponse = await apiFetch(context, "/api/user/org", cookie);
  let org: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) org = orgData;
  }

  return { user: sessionData.user, org };
}
