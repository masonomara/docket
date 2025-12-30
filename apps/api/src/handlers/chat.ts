import { z } from "zod";
import type { MemberContext } from "../lib/session";
import { getOrgMembership } from "../services/org-membership";
import { createLogger, generateRequestId } from "../lib/logger";
import type { Env } from "../types/env";
import type { FirmSize, OrgRole } from "../types";

// =============================================================================
// Request Validation
// =============================================================================

const ChatMessageRequestSchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid UUID"),
  message: z
    .string()
    .min(1, "Message is required")
    .max(10000, "Message too long"),
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the TenantDO instance for an organization.
 * The DO is identified by orgId, so each org has its own isolated state.
 */
function getTenantDO(env: Env, orgId: string) {
  const doId = env.TENANT.idFromName(orgId);
  return env.TENANT.get(doId);
}

/**
 * Fetch org settings from D1 (jurisdictions, practice types, firm size).
 * These are used to customize RAG context retrieval.
 */
async function getOrgSettings(
  db: D1Database,
  orgId: string
): Promise<{
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null;
} | null> {
  const row = await db
    .prepare(
      "SELECT jurisdictions, practice_types, firm_size FROM org WHERE id = ?"
    )
    .bind(orgId)
    .first<{
      jurisdictions: string;
      practice_types: string;
      firm_size: string | null;
    }>();

  if (!row) {
    return null;
  }

  // Parse JSON arrays, defaulting to empty arrays on parse failure
  function parseJsonArray(value: string | null): string[] {
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  return {
    jurisdictions: parseJsonArray(row.jurisdictions),
    practiceTypes: parseJsonArray(row.practice_types),
    firmSize: row.firm_size as FirmSize | null,
  };
}

/**
 * Parse JSON body from request, returning null on failure.
 */
async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// =============================================================================
// Chat Message Handler (POST /api/chat)
// =============================================================================

export async function handleChatMessage(
  request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "chat" });

  // Parse request body
  const body = await parseJsonBody(request);
  if (body === null) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate request schema
  const parseResult = ChatMessageRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request", details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const { conversationId, message } = parseResult.data;

  // Verify user is still a member of the organization
  const membership = await getOrgMembership(env.DB, ctx.user.id, ctx.orgId);
  if (!membership) {
    log.warn("User not a member of org", {
      userId: ctx.user.id,
      orgId: ctx.orgId,
    });
    return Response.json(
      { error: "Not a member of organization" },
      { status: 403 }
    );
  }

  // Get org settings for RAG context
  const orgSettings = await getOrgSettings(env.DB, ctx.orgId);
  if (!orgSettings) {
    log.warn("Organization not found", { orgId: ctx.orgId });
    return Response.json({ error: "Organization not found" }, { status: 404 });
  }

  // Build the channel message payload for the DO
  const channelMessage = {
    channel: "web" as const,
    orgId: ctx.orgId,
    userId: ctx.user.id,
    userRole: membership.role as OrgRole,
    conversationId,
    conversationScope: "personal" as const,
    message,
    jurisdictions: orgSettings.jurisdictions,
    practiceTypes: orgSettings.practiceTypes,
    firmSize: orgSettings.firmSize,
  };

  log.info("Processing chat message", {
    conversationId,
    userId: ctx.user.id,
    orgId: ctx.orgId,
  });

  // Forward to TenantDO for processing (returns SSE stream)
  const tenantDO = getTenantDO(env, ctx.orgId);
  const doResponse = await tenantDO.fetch(
    new Request("https://do/process-message-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
      },
      body: JSON.stringify(channelMessage),
    })
  );

  // Handle DO errors
  if (!doResponse.ok) {
    const errorBody = await doResponse.text();
    log.error("DO streaming failed", {
      status: doResponse.status,
      error: errorBody,
    });

    // Try to extract error message from JSON response
    let errorMessage = "Failed to process message";
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.error) {
        errorMessage = parsed.error;
      }
    } catch {
      // Use default error message
    }

    return Response.json(
      { error: errorMessage },
      { status: doResponse.status }
    );
  }

  // Return the SSE stream from the DO
  return new Response(doResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// =============================================================================
// Conversation List Handler (GET /api/conversations)
// =============================================================================

export async function handleGetConversations(
  _request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const tenantDO = getTenantDO(env, ctx.orgId);

  const doResponse = await tenantDO.fetch(
    new Request(
      `https://do/conversations?userId=${encodeURIComponent(ctx.user.id)}`,
      { method: "GET" }
    )
  );

  if (!doResponse.ok) {
    return Response.json(
      { error: "Failed to fetch conversations" },
      { status: doResponse.status }
    );
  }

  return new Response(doResponse.body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// Single Conversation Handler (GET /api/conversations/:id)
// =============================================================================

export async function handleGetConversation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const tenantDO = getTenantDO(env, ctx.orgId);

  const doResponse = await tenantDO.fetch(
    new Request(
      `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
      { method: "GET" }
    )
  );

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json({ error: "Conversation not found" }, { status });
  }

  return new Response(doResponse.body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// =============================================================================
// Delete Conversation Handler (DELETE /api/conversations/:id)
// =============================================================================

export async function handleDeleteConversation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const tenantDO = getTenantDO(env, ctx.orgId);

  const doResponse = await tenantDO.fetch(
    new Request(
      `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
      { method: "DELETE" }
    )
  );

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json({ error: "Conversation not found" }, { status });
  }

  return Response.json({ success: true });
}

// =============================================================================
// Accept Confirmation Handler (POST /api/confirmations/:id/accept)
// =============================================================================

export async function handleAcceptConfirmation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const requestId = generateRequestId();

  // Only admins can execute Clio write operations
  const membership = await getOrgMembership(env.DB, ctx.user.id, ctx.orgId);
  if (membership?.role !== "admin") {
    return Response.json(
      { error: "Admin role required to execute Clio operations" },
      { status: 403 }
    );
  }

  const tenantDO = getTenantDO(env, ctx.orgId);

  const doResponse = await tenantDO.fetch(
    new Request(`https://do/confirmation/${confirmationId}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": requestId,
      },
      body: JSON.stringify({ userId: ctx.user.id }),
    })
  );

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Confirmation not found or expired" },
      { status }
    );
  }

  // Return the SSE stream from the DO
  return new Response(doResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// =============================================================================
// Reject Confirmation Handler (POST /api/confirmations/:id/reject)
// =============================================================================

export async function handleRejectConfirmation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const tenantDO = getTenantDO(env, ctx.orgId);

  const doResponse = await tenantDO.fetch(
    new Request(`https://do/confirmation/${confirmationId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: ctx.user.id }),
    })
  );

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Confirmation not found or expired" },
      { status }
    );
  }

  return Response.json({ success: true });
}
