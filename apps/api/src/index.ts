import { getAuth } from "./lib/auth";
import { withAuth, withMember, withAdmin, withOwner } from "./lib/session";
import { TenantDO } from "./do/tenant";
import { generateRequestId } from "./lib/logger";
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
import { seedKB } from "./services/kb-loader";
import {
  handleChatMessage,
  handleGetConversations,
  handleGetConversation,
  handleDeleteConversation,
  handleAcceptConfirmation,
  handleRejectConfirmation,
} from "./handlers/chat";
import type { Env } from "./types/env";

export { TenantDO };
export type { Env };

// -----------------------------------------------------------------------------
// CORS Configuration
// -----------------------------------------------------------------------------

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

function addCorsHeaders(
  response: Response,
  request: Request,
  requestId: string
): Response {
  const headers = new Headers(response.headers);

  const corsHeaders = getCorsHeaders(request);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  headers.set("X-Request-Id", requestId);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// -----------------------------------------------------------------------------
// Route Handler Type
// -----------------------------------------------------------------------------

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

// -----------------------------------------------------------------------------
// Static Routes - Simple path-to-handler mapping
// -----------------------------------------------------------------------------

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

  // Members and invitations
  "/api/org/members": {
    GET: withMember(handleGetMembers),
  },
  "/api/org/invitations": {
    GET: withAdmin(handleGetInvitations),
    POST: withAdmin(handleSendInvitation),
  },
  "/api/org/transfer-ownership": {
    POST: withAdmin(handleTransferOwnership),
  },

  // Account management
  "/api/account/deletion-preview": {
    GET: withAuth(handleGetAccountDeletionPreview),
  },
  "/api/account": {
    PATCH: withAuth(handleUpdateAccount),
    DELETE: withAuth(handleDeleteAccount),
  },

  // Org context documents
  "/api/org/context": {
    GET: withAdmin(handleGetDocuments),
    POST: withAdmin(handleUploadDocument),
  },

  // Chat
  "/api/chat": {
    POST: withMember(handleChatMessage),
  },
  "/api/conversations": {
    GET: withMember(handleGetConversations),
  },
};

// -----------------------------------------------------------------------------
// Dynamic Routes - Routes with path parameters
// -----------------------------------------------------------------------------

interface DynamicRouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

function matchMemberRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // /api/org/members/:memberId
  const match = path.match(/^\/api\/org\/members\/([^/]+)$/);
  if (!match) return null;

  const memberId = match[1];

  if (method === "DELETE") {
    return {
      handler: withAdmin((req, env, ctx) =>
        handleRemoveMember(req, env, ctx, memberId)
      ),
      params: { memberId },
    };
  }

  if (method === "PATCH") {
    return {
      handler: withAdmin((req, env, ctx) =>
        handleUpdateMemberRole(req, env, ctx, memberId)
      ),
      params: { memberId },
    };
  }

  return null;
}

function matchOrgInvitationRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // /api/org/invitations/:invitationId (DELETE only)
  const match = path.match(/^\/api\/org\/invitations\/([^/]+)$/);
  if (!match || method !== "DELETE") return null;

  const invitationId = match[1];
  return {
    handler: withAdmin((req, env, ctx) =>
      handleRevokeInvitation(req, env, ctx, invitationId)
    ),
    params: { invitationId },
  };
}

function matchPublicInvitationRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // /api/invitations/:invitationId (GET - public)
  const getMatch = path.match(/^\/api\/invitations\/([^/]+)$/);
  if (getMatch && method === "GET") {
    const invitationId = getMatch[1];
    return {
      handler: (req, env) => handleGetInvitation(req, env, invitationId),
      params: { invitationId },
    };
  }

  // /api/invitations/:invitationId/accept (POST)
  const acceptMatch = path.match(/^\/api\/invitations\/([^/]+)\/accept$/);
  if (acceptMatch && method === "POST") {
    const invitationId = acceptMatch[1];
    return {
      handler: withAuth((req, env, ctx) =>
        handleAcceptInvitation(req, env, ctx, invitationId)
      ),
      params: { invitationId },
    };
  }

  return null;
}

function matchDocumentRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // /api/org/context/:documentId (DELETE only)
  const match = path.match(/^\/api\/org\/context\/([^/]+)$/);
  if (!match || method !== "DELETE") return null;

  const documentId = match[1];
  return {
    handler: withAdmin((req, env, ctx) =>
      handleDeleteDocument(req, env, ctx, documentId)
    ),
    params: { documentId },
  };
}

function matchConversationRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // /api/conversations/:conversationId
  const match = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (!match) return null;

  const conversationId = match[1];

  if (method === "GET") {
    return {
      handler: withMember((req, env, ctx) =>
        handleGetConversation(req, env, ctx, conversationId)
      ),
      params: { conversationId },
    };
  }

  if (method === "DELETE") {
    return {
      handler: withMember((req, env, ctx) =>
        handleDeleteConversation(req, env, ctx, conversationId)
      ),
      params: { conversationId },
    };
  }

  return null;
}

function matchConfirmationRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  if (method !== "POST") return null;

  // /api/confirmations/:confirmationId/accept
  const acceptMatch = path.match(/^\/api\/confirmations\/([^/]+)\/accept$/);
  if (acceptMatch) {
    const confirmationId = acceptMatch[1];
    return {
      handler: withMember((req, env, ctx) =>
        handleAcceptConfirmation(req, env, ctx, confirmationId)
      ),
      params: { confirmationId },
    };
  }

  // /api/confirmations/:confirmationId/reject
  const rejectMatch = path.match(/^\/api\/confirmations\/([^/]+)\/reject$/);
  if (rejectMatch) {
    const confirmationId = rejectMatch[1];
    return {
      handler: withMember((req, env, ctx) =>
        handleRejectConfirmation(req, env, ctx, confirmationId)
      ),
      params: { confirmationId },
    };
  }

  return null;
}

function matchDynamicRoute(
  path: string,
  method: string
): DynamicRouteMatch | null {
  // Try each dynamic route matcher in order
  return (
    matchMemberRoute(path, method) ||
    matchOrgInvitationRoute(path, method) ||
    matchPublicInvitationRoute(path, method) ||
    matchDocumentRoute(path, method) ||
    matchConversationRoute(path, method) ||
    matchConfirmationRoute(path, method)
  );
}

// -----------------------------------------------------------------------------
// Main Request Handler
// -----------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const requestId =
      request.headers.get("X-Request-Id") || generateRequestId();

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...getCorsHeaders(request),
          "X-Request-Id": requestId,
        },
      });
    }

    // Health check endpoints (no CORS needed)
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

    // Better Auth routes (handled by auth library)
    if (path.startsWith("/api/auth")) {
      try {
        const authResponse = await getAuth(env).handler(request);
        return addCorsHeaders(authResponse, request, requestId);
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.message}\n${error.stack}`
            : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Teams webhook (no CORS - server-to-server)
    if (path === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // Clio OAuth callback (no CORS - browser redirect)
    if (path === "/clio/callback") {
      return handleClioCallback(request, env);
    }

    // Internal: Seed KB (protected by secret)
    if (path === "/internal/seed-kb" && method === "POST") {
      const secret = request.headers.get("X-Seed-Secret");
      if (!env.SEED_SECRET || secret !== env.SEED_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const result = await seedKB(env);
        return Response.json({
          success: true,
          message: "KB seeded successfully",
          ...result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Try static routes first
    const staticHandler = staticRoutes[path]?.[method];
    if (staticHandler) {
      const response = await staticHandler(request, env);
      return addCorsHeaders(response, request, requestId);
    }

    // Try dynamic routes
    const dynamicMatch = matchDynamicRoute(path, method);
    if (dynamicMatch) {
      const response = await dynamicMatch.handler(request, env);
      return addCorsHeaders(response, request, requestId);
    }

    // 404 - No route matched
    return addCorsHeaders(
      Response.json({ error: "Not found" }, { status: 404 }),
      request,
      requestId
    );
  },
};
