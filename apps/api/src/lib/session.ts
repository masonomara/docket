import { getAuth } from "./auth";
import { logAuthzFailure } from "./logger";
import type { Env } from "../types/env";

// =============================================================================
// Session Types
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthContext {
  user: AuthUser;
}

export interface MemberContext extends AuthContext {
  orgId: string;
}

export interface AdminContext extends AuthContext {
  orgId: string;
  isOwner: boolean;
}

export interface OwnerContext extends AuthContext {
  orgId: string;
}

// =============================================================================
// Route Handler Wrappers
// =============================================================================

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

/**
 * Wraps a handler to require authentication.
 * The handler receives the authenticated user in ctx.
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
 * Wraps a handler to require organization membership.
 * The handler receives user and orgId in ctx.
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
 * Wraps a handler to require admin membership.
 * The handler receives user, orgId, and isOwner in ctx.
 */
export function withAdmin(handler: AdminHandler): RouteHandler {
  return async (request, env) => {
    const session = await getSession(request, env);
    const path = new URL(request.url).pathname;

    if (!session?.user) {
      logAuthzFailure("withAdmin", "No session", { path });
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getMembership(env.DB, session.user.id, true);
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
 * Wraps a handler to require organization ownership.
 * The handler receives user and orgId in ctx.
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

// =============================================================================
// Core Session Functions
// =============================================================================

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

export async function getMembership(
  db: D1Database,
  userId: string,
  requireAdmin = false
) {
  const query = requireAdmin
    ? `SELECT org_id, role, is_owner FROM org_members WHERE user_id = ? AND role = 'admin'`
    : `SELECT org_id, role, is_owner FROM org_members WHERE user_id = ?`;
  return db.prepare(query).bind(userId).first<MembershipRow>();
}

