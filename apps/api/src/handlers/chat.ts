import { z } from "zod";
import type { MemberContext } from "../lib/session";
import { getOrgMembership } from "../services/org-membership";
import { createLogger, generateRequestId } from "../lib/logger";
import type { Env } from "../types/env";
import type { FirmSize, OrgRole } from "../types";
import { errors, errorResponse } from "../lib/errors";

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

  const body = await parseJsonBody(request);
  if (body === null) {
    return errors.invalidJson();
  }

  const parseResult = ChatMessageRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return errors.invalidRequest(parseResult.error.issues);
  }

  const { conversationId, message } = parseResult.data;

  const membership = await getOrgMembership(env.DB, ctx.user.id, ctx.orgId);
  if (!membership) {
    log.warn("User not a member of org", {
      userId: ctx.user.id,
      orgId: ctx.orgId,
    });
    return errors.notMember();
  }

  const orgSettings = await getOrgSettings(env.DB, ctx.orgId);
  if (!orgSettings) {
    log.warn("Organization not found", { orgId: ctx.orgId });
    return errors.notFound("Organization");
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

  if (!doResponse.ok) {
    const errorBody = await doResponse.text();
    log.error("DO streaming failed", {
      status: doResponse.status,
      error: errorBody,
    });

    let errorMessage = "Failed to process message";
    try {
      const parsed = JSON.parse(errorBody);
      if (parsed.error) {
        errorMessage = parsed.error;
      }
    } catch {
      // Use default error message
    }

    return errorResponse(doResponse.status, errorMessage, "INTERNAL_ERROR");
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
    return errorResponse(doResponse.status, "Failed to fetch conversations", "INTERNAL_ERROR");
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
    return errorResponse(status, "Conversation not found", "CONVERSATION_NOT_FOUND");
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
    return errorResponse(status, "Conversation not found", "CONVERSATION_NOT_FOUND");
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

  const membership = await getOrgMembership(env.DB, ctx.user.id, ctx.orgId);
  if (membership?.role !== "admin") {
    return errors.adminRequired();
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
    return errorResponse(status, "Confirmation not found or expired", "CONFIRMATION_NOT_FOUND");
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
    return errorResponse(status, "Confirmation not found or expired", "CONFIRMATION_NOT_FOUND");
  }

  return Response.json({ success: true });
}
