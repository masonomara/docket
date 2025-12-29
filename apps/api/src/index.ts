import { getAuth } from "./lib/auth";
import { withAuth, withMember, withAdmin, withOwner } from "./lib/session";
import { TenantDO } from "./do/tenant";
import { generateRequestId } from "./lib/logger";

// Handler imports
import { handleTeamsMessage } from "./handlers/teams";
import { handleCheckEmail } from "./handlers/auth";
import {
  handleClioCallback,
  handleClioConnectAuth,
  handleClioStatus,
  handleClioRefreshSchema,
  handleClioDisconnect,
} from "./handlers/clio";
import {
  handleCreateOrg,
  handleGetUserOrg,
  handleUpdateOrg,
  handleGetOrgDeletionPreview,
  handleDeleteOrg,
} from "./handlers/org";
import {
  handleGetMembers,
  handleSendInvitation,
  handleGetInvitations,
  handleRevokeInvitation,
  handleRemoveMember,
  handleUpdateMemberRole,
  handleTransferOwnership,
  handleGetInvitation,
  handleAcceptInvitation,
} from "./handlers/members";
import {
  handleGetAccountDeletionPreview,
  handleUpdateAccount,
  handleDeleteAccount,
} from "./handlers/account";
import {
  handleGetDocuments,
  handleUploadDocument,
  handleDeleteDocument,
} from "./handlers/documents";

import type { Env } from "./types/env";

export { TenantDO };
export type { Env };

// ============================================================================
// CORS Configuration
// ============================================================================

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://docketadmin.com",
  "https://www.docketadmin.com",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-Id",
    "Access-Control-Expose-Headers": "X-Request-Id",
    "Access-Control-Allow-Credentials": "true",
  };
}

function withCors(
  response: Response,
  request: Request,
  requestId: string
): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(getCorsHeaders(request))) {
    headers.set(key, value);
  }
  headers.set("X-Request-Id", requestId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Route Definitions
// ============================================================================

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

/**
 * Static routes - paths that don't have dynamic segments.
 * Format: { [path]: { [method]: handler } }
 */
const staticRoutes: Record<string, Record<string, RouteHandler>> = {
  // Auth
  "/api/check-email": {
    POST: handleCheckEmail,
  },

  // Organization management
  "/api/org": {
    POST: withAuth(handleCreateOrg),
    PATCH: withAdmin(handleUpdateOrg),
    DELETE: withOwner(handleDeleteOrg),
  },
  "/api/org/deletion-preview": {
    GET: withOwner(handleGetOrgDeletionPreview),
  },
  "/api/user/org": {
    GET: withAuth(handleGetUserOrg),
  },

  // Clio integration
  "/api/clio/connect": {
    GET: withMember(handleClioConnectAuth),
  },
  "/api/clio/status": {
    GET: withMember(handleClioStatus),
  },
  "/api/clio/disconnect": {
    POST: withMember(handleClioDisconnect),
  },
  "/api/org/clio/refresh-schema": {
    POST: withAdmin(handleClioRefreshSchema),
  },

  // Members
  "/api/org/members": {
    GET: withMember(handleGetMembers),
  },

  // Invitations
  "/api/org/invitations": {
    GET: withAdmin(handleGetInvitations),
    POST: withAdmin(handleSendInvitation),
  },

  // Ownership transfer
  "/api/org/transfer-ownership": {
    POST: withAdmin(handleTransferOwnership),
  },

  // Account
  "/api/account/deletion-preview": {
    GET: withAuth(handleGetAccountDeletionPreview),
  },
  "/api/account": {
    PATCH: withAuth(handleUpdateAccount),
    DELETE: withAuth(handleDeleteAccount),
  },

  // Org Context (Knowledge Base documents)
  "/api/org/context": {
    GET: withAdmin(handleGetDocuments),
    POST: withAdmin(handleUploadDocument),
  },
};

/**
 * Matches dynamic routes with path parameters.
 * Returns null if no match, otherwise returns a Promise<Response>.
 */
function matchDynamicRoute(
  path: string,
  method: string,
  request: Request,
  env: Env
): Promise<Response> | null {
  // /api/org/members/:memberId - DELETE or PATCH a specific member
  const memberIdMatch = path.match(/^\/api\/org\/members\/([^/]+)$/);
  if (memberIdMatch) {
    const memberId = memberIdMatch[1];

    if (method === "DELETE") {
      return withAdmin((req, e, ctx) =>
        handleRemoveMember(req, e, ctx, memberId)
      )(request, env);
    }

    if (method === "PATCH") {
      return withAdmin((req, e, ctx) =>
        handleUpdateMemberRole(req, e, ctx, memberId)
      )(request, env);
    }

    return Promise.resolve(
      Response.json({ error: "Method not allowed" }, { status: 405 })
    );
  }

  // /api/org/invitations/:invitationId - DELETE (revoke) a specific invitation
  const revokeInvitationMatch = path.match(
    /^\/api\/org\/invitations\/([^/]+)$/
  );
  if (revokeInvitationMatch && method === "DELETE") {
    const invitationId = revokeInvitationMatch[1];
    return withAdmin((req, e, ctx) =>
      handleRevokeInvitation(req, e, ctx, invitationId)
    )(request, env);
  }

  // /api/invitations/:invitationId - GET invitation details (public)
  const getInvitationMatch = path.match(/^\/api\/invitations\/([^/]+)$/);
  if (getInvitationMatch && method === "GET") {
    const invitationId = getInvitationMatch[1];
    return handleGetInvitation(request, env, invitationId);
  }

  // /api/invitations/:invitationId/accept - POST to accept an invitation
  const acceptInvitationMatch = path.match(
    /^\/api\/invitations\/([^/]+)\/accept$/
  );
  if (acceptInvitationMatch && method === "POST") {
    const invitationId = acceptInvitationMatch[1];
    return withAuth((req, e, ctx) =>
      handleAcceptInvitation(req, e, ctx, invitationId)
    )(request, env);
  }

  // /api/org/context/:documentId - DELETE a specific document
  const documentMatch = path.match(/^\/api\/org\/context\/([^/]+)$/);
  if (documentMatch && method === "DELETE") {
    const documentId = documentMatch[1];
    return withAdmin((req, e, ctx) =>
      handleDeleteDocument(req, e, ctx, documentId)
    )(request, env);
  }

  return null;
}

// ============================================================================
// Main Worker Export
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const requestId =
      request.headers.get("X-Request-Id") || generateRequestId();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      const headers = getCorsHeaders(request);
      headers["X-Request-Id"] = requestId;
      return new Response(null, { status: 204, headers });
    }

    // Health check endpoints
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    if (path === "/ready") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return Response.json({ status: "ready", db: "ok" });
      } catch {
        return Response.json(
          { status: "not ready", db: "error" },
          { status: 503 }
        );
      }
    }

    // better-auth handles all /api/auth/* routes
    if (path.startsWith("/api/auth")) {
      try {
        const response = await getAuth(env).handler(request);
        return withCors(response, request, requestId);
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.message}\n${error.stack}`
            : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Teams webhook (no auth, validated by Teams signature)
    if (path === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // Clio OAuth callback (no auth, uses state parameter for validation)
    if (path === "/clio/callback") {
      return handleClioCallback(request, env);
    }

    // Try static routes first
    const methodHandlers = staticRoutes[path];
    if (methodHandlers && methodHandlers[method]) {
      const response = await methodHandlers[method](request, env);
      return withCors(response, request, requestId);
    }

    // Try dynamic routes
    const dynamicResponse = matchDynamicRoute(path, method, request, env);
    if (dynamicResponse) {
      const response = await dynamicResponse;
      return withCors(response, request, requestId);
    }

    // No route matched
    return withCors(
      Response.json({ error: "Not found" }, { status: 404 }),
      request,
      requestId
    );
  },
};
