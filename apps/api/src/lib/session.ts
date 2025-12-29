import { getAuth } from "./auth";
import { logAuthzFailure } from "./logger";
import type { Env } from "../types/env";

// ============================================================================
// Context Types - What gets passed to route handlers
// ============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/** Base context with just the authenticated user */
export interface AuthContext {
  user: AuthUser;
}

/** Context for any org member (admin or regular member) */
export interface MemberContext extends AuthContext {
  orgId: string;
}

/** Context for admins, includes whether they're also the owner */
export interface AdminContext extends AuthContext {
  orgId: string;
  isOwner: boolean;
}

/** Context for owner-only operations */
export interface OwnerContext extends AuthContext {
  orgId: string;
}

// ============================================================================
// Handler Types
// ============================================================================

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

type AuthedHandler = (
  request: Request,
  env: Env,
  ctx: AuthContext
) => Promise<Response>;

type MemberHandler = (
  request: Request,
  env: Env,
  ctx: MemberContext
) => Promise<Response>;

type AdminHandler = (
  request: Request,
  env: Env,
  ctx: AdminContext
) => Promise<Response>;

type OwnerHandler = (
  request: Request,
  env: Env,
  ctx: OwnerContext
) => Promise<Response>;

// ============================================================================
// Authorization Wrappers
// ============================================================================

/**
 * Requires authentication only (no org membership required).
 * Use for: account settings, creating an org, accepting invitations.
 */
export function withAuth(handler: AuthedHandler): RouteHandler {
  return async (request, env) => {
    const session = await getSession(request, env);

    if (!session?.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    return handler(request, env, { user: session.user });
  };
}

/**
 * Requires authentication AND membership in an org.
 * Use for: viewing org data, sending messages, etc.
 */
export function withMember(handler: MemberHandler): RouteHandler {
  return async (request, env) => {
    const session = await getSession(request, env);
    const path = new URL(request.url).pathname;

    if (!session?.user) {
      logAuthzFailure("withMember", "No session", { path });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(env.DB, session.user.id);

    if (!membership) {
      logAuthzFailure("withMember", "No organization", {
        userId: session.user.id,
        path,
      });
      return Response.json(
        { error: "Not a member of any organization" },
        { status: 403 }
      );
    }

    return handler(request, env, {
      user: session.user,
      orgId: membership.org_id,
    });
  };
}

/**
 * Requires authentication AND admin role in an org.
 * Use for: managing members, org settings, invitations.
 */
export function withAdmin(handler: AdminHandler): RouteHandler {
  return async (request, env) => {
    const session = await getSession(request, env);
    const path = new URL(request.url).pathname;

    if (!session?.user) {
      logAuthzFailure("withAdmin", "No session", { path });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(
      env.DB,
      session.user.id,
      true // requireAdmin
    );

    if (!membership) {
      logAuthzFailure("withAdmin", "Not admin", {
        userId: session.user.id,
        path,
      });
      return Response.json({ error: "Admin access required" }, { status: 403 });
    }

    return handler(request, env, {
      user: session.user,
      orgId: membership.org_id,
      isOwner: membership.is_owner === 1,
    });
  };
}

/**
 * Requires authentication AND owner status in an org.
 * Use for: deleting org, transferring ownership.
 */
export function withOwner(handler: OwnerHandler): RouteHandler {
  return async (request, env) => {
    const session = await getSession(request, env);
    const path = new URL(request.url).pathname;

    if (!session?.user) {
      logAuthzFailure("withOwner", "No session", { path });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(env.DB, session.user.id);

    if (!membership) {
      logAuthzFailure("withOwner", "No organization", {
        userId: session.user.id,
        path,
      });
      return Response.json({ error: "No organization found" }, { status: 404 });
    }

    if (!membership.is_owner) {
      logAuthzFailure("withOwner", "Not owner", {
        userId: session.user.id,
        orgId: membership.org_id,
        path,
      });
      return Response.json(
        { error: "Only the owner can perform this action" },
        { status: 403 }
      );
    }

    return handler(request, env, {
      user: session.user,
      orgId: membership.org_id,
    });
  };
}

// ============================================================================
// Session & Membership Queries
// ============================================================================

/**
 * Gets the current session from request cookies.
 * Returns null if no valid session exists.
 */
export async function getSession(request: Request, env: Env) {
  try {
    return await getAuth(env).api.getSession({ headers: request.headers });
  } catch {
    return null;
  }
}

interface MembershipRow {
  org_id: string;
  role: string;
  is_owner: number;
}

/**
 * Looks up a user's org membership.
 *
 * @param db - D1 database instance
 * @param userId - The user to look up
 * @param requireAdmin - If true, only returns membership if user is an admin
 */
export async function getMembership(
  db: D1Database,
  userId: string,
  requireAdmin = false
): Promise<MembershipRow | null> {
  const query = requireAdmin
    ? `SELECT org_id, role, is_owner FROM org_members WHERE user_id = ? AND role = 'admin'`
    : `SELECT org_id, role, is_owner FROM org_members WHERE user_id = ?`;

  return db.prepare(query).bind(userId).first<MembershipRow>();
}
