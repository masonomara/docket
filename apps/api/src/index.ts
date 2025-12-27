import { getAuth } from "./lib/auth";
import { TenantDO } from "./do/tenant";
import { handleTeamsMessage } from "./handlers/teams";
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
  handleDeleteAccount,
} from "./handlers/account";
import { handleCheckEmail } from "./handlers/auth";
import {
  handleGetDocuments,
  handleUploadDocument,
  handleDeleteDocument,
} from "./handlers/documents";
import type { Env } from "./types/env";

// Re-export for Cloudflare Workers
export { TenantDO };
export type { Env };

// Origins allowed to make CORS requests
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://docketadmin.com",
  "https://www.docketadmin.com",
];

/**
 * Builds CORS headers for the response based on the request origin.
 * If the origin is in our allowed list, we reflect it back.
 * Otherwise, we use localhost as a fallback (blocks requests from unknown origins).
 */
function getCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

/**
 * Wraps a response with CORS headers.
 */
function withCors(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(getCorsHeaders(request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Main Cloudflare Worker entry point.
 * Routes requests to the appropriate handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight requests
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // Health check endpoint (for load balancers, etc.)
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    // Readiness check (verifies D1 is accessible)
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

    // Better Auth handles all /api/auth/* routes
    if (path.startsWith("/api/auth")) {
      try {
        const authResponse = await getAuth(env).handler(request);
        return withCors(authResponse, request);
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.message}\n${error.stack}`
            : String(error);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Teams bot webhook (doesn't need CORS)
    if (path === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // Clio OAuth callback (doesn't need CORS - it's a redirect from Clio)
    if (path === "/clio/callback") {
      return handleClioCallback(request, env);
    }

    // Route to appropriate handler
    const response = await routeRequest(request, env, path, method);

    if (response) {
      return withCors(response, request);
    }

    // No matching route found
    return withCors(
      Response.json({ error: "Not found" }, { status: 404 }),
      request
    );
  },
};

/**
 * Routes authenticated API requests to the appropriate handler.
 * Returns null if no matching route is found.
 */
async function routeRequest(
  request: Request,
  env: Env,
  path: string,
  method: string
): Promise<Response | null> {
  // ============================================================
  // Authentication
  // ============================================================

  if (path === "/api/check-email" && method === "POST") {
    return handleCheckEmail(request, env);
  }

  // ============================================================
  // Organization Management
  // ============================================================

  if (path === "/api/org" && method === "POST") {
    return handleCreateOrg(request, env);
  }

  if (path === "/api/org" && method === "PATCH") {
    return handleUpdateOrg(request, env);
  }

  if (path === "/api/org" && method === "DELETE") {
    return handleDeleteOrg(request, env);
  }

  if (path === "/api/org/deletion-preview" && method === "GET") {
    return handleGetOrgDeletionPreview(request, env);
  }

  if (path === "/api/user/org" && method === "GET") {
    return handleGetUserOrg(request, env);
  }

  // ============================================================
  // Clio Integration
  // ============================================================

  if (path === "/api/clio/connect" && method === "GET") {
    return handleClioConnectAuth(request, env);
  }

  if (path === "/api/clio/status" && method === "GET") {
    return handleClioStatus(request, env);
  }

  if (path === "/api/clio/disconnect" && method === "POST") {
    return handleClioDisconnect(request, env);
  }

  if (path === "/api/org/clio/refresh-schema" && method === "POST") {
    return handleClioRefreshSchema(request, env);
  }

  // ============================================================
  // Member Management
  // ============================================================

  if (path === "/api/org/members" && method === "GET") {
    return handleGetMembers(request, env);
  }

  if (path === "/api/org/invitations" && method === "POST") {
    return handleSendInvitation(request, env);
  }

  if (path === "/api/org/invitations" && method === "GET") {
    return handleGetInvitations(request, env);
  }

  if (path === "/api/org/transfer-ownership" && method === "POST") {
    return handleTransferOwnership(request, env);
  }

  // Member routes with dynamic ID: /api/org/members/:userId
  const memberMatch = path.match(/^\/api\/org\/members\/([^/]+)$/);
  if (memberMatch) {
    const userId = memberMatch[1];

    if (method === "DELETE") {
      return handleRemoveMember(request, env, userId);
    }

    if (method === "PATCH") {
      return handleUpdateMemberRole(request, env, userId);
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Invitation revocation: /api/org/invitations/:invitationId
  const invitationMatch = path.match(/^\/api\/org\/invitations\/([^/]+)$/);
  if (invitationMatch && method === "DELETE") {
    return handleRevokeInvitation(request, env, invitationMatch[1]);
  }

  // ============================================================
  // Public Invitation Routes (unauthenticated)
  // ============================================================

  // Get invitation details: /api/invitations/:invitationId
  const publicInviteMatch = path.match(/^\/api\/invitations\/([^/]+)$/);
  if (publicInviteMatch && method === "GET") {
    return handleGetInvitation(request, env, publicInviteMatch[1]);
  }

  // Accept invitation: /api/invitations/:invitationId/accept
  const acceptMatch = path.match(/^\/api\/invitations\/([^/]+)\/accept$/);
  if (acceptMatch && method === "POST") {
    return handleAcceptInvitation(request, env, acceptMatch[1]);
  }

  // ============================================================
  // Account Management
  // ============================================================

  if (path === "/api/account/deletion-preview" && method === "GET") {
    return handleGetAccountDeletionPreview(request, env);
  }

  if (path === "/api/account" && method === "DELETE") {
    return handleDeleteAccount(request, env);
  }

  // ============================================================
  // Document Management (Org Context)
  // ============================================================

  if (path === "/api/org/documents" && method === "GET") {
    return handleGetDocuments(request, env);
  }

  if (path === "/api/org/documents" && method === "POST") {
    return handleUploadDocument(request, env);
  }

  // Delete document: /api/org/documents/:documentId
  const documentMatch = path.match(/^\/api\/org\/documents\/([^/]+)$/);
  if (documentMatch && method === "DELETE") {
    return handleDeleteDocument(request, env, documentMatch[1]);
  }

  // No matching route
  return null;
}
