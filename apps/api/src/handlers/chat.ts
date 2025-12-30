import { z } from "zod";
import type { MemberContext } from "../lib/session";
import { getOrgMembership } from "../services/org-membership";
import { createLogger, generateRequestId } from "../lib/logger";
import type { Env } from "../types/env";
import type { FirmSize, OrgRole } from "../types";

// -----------------------------------------------------------------------------
// Request Schemas
// -----------------------------------------------------------------------------

const ChatMessageRequestSchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid UUID"),
  message: z.string().min(1, "Message is required").max(10000, "Message too long"),
});

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Get org settings from D1 for building the ChannelMessage.
 */
async function getOrgSettings(
  db: D1Database,
  orgId: string
): Promise<{
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null;
} | null> {
  const org = await db
    .prepare("SELECT jurisdictions, practice_types, firm_size FROM org WHERE id = ?")
    .bind(orgId)
    .first<{ jurisdictions: string; practice_types: string; firm_size: string | null }>();

  if (!org) {
    return null;
  }

  return {
    jurisdictions: safeParseJsonArray(org.jurisdictions),
    practiceTypes: safeParseJsonArray(org.practice_types),
    firmSize: org.firm_size as FirmSize | null,
  };
}

/**
 * Safely parse a JSON string, returning an empty array on failure.
 */
function safeParseJsonArray(jsonString: string | null): string[] {
  if (!jsonString) {
    return [];
  }
  try {
    return JSON.parse(jsonString);
  } catch {
    return [];
  }
}

/**
 * Get the Durable Object stub for an organization.
 */
function getOrgDurableObject(env: Env, orgId: string) {
  const doId = env.TENANT.idFromName(orgId);
  return env.TENANT.get(doId);
}

// -----------------------------------------------------------------------------
// Chat Handlers
// -----------------------------------------------------------------------------

/**
 * POST /api/chat
 * Handles chat messages with SSE streaming response.
 */
export async function handleChatMessage(
  request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "chat" });

  // Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = ChatMessageRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request", details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const { conversationId, message } = parseResult.data;

  // Get user's role from org membership
  const membership = await getOrgMembership(env.DB, ctx.user.id, ctx.orgId);
  if (!membership) {
    log.warn("User not a member of org", { userId: ctx.user.id, orgId: ctx.orgId });
    return Response.json({ error: "Not a member of organization" }, { status: 403 });
  }

  const userRole: OrgRole = membership.role;

  // Get org settings for RAG context
  const orgSettings = await getOrgSettings(env.DB, ctx.orgId);
  if (!orgSettings) {
    log.warn("Organization not found", { orgId: ctx.orgId });
    return Response.json({ error: "Organization not found" }, { status: 404 });
  }

  // Build the ChannelMessage for the DO
  const channelMessage = {
    channel: "web" as const,
    orgId: ctx.orgId,
    userId: ctx.user.id,
    userRole,
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

  // Forward to DO's streaming endpoint
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request("https://do/process-message-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channelMessage),
  });

  const doResponse = await stub.fetch(doRequest);

  // If DO returns an error, pass it through
  if (!doResponse.ok) {
    const errorBody = await doResponse.text();
    log.error("DO streaming failed", { status: doResponse.status, error: errorBody });
    return new Response(errorBody, {
      status: doResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return SSE stream from DO
  return new Response(doResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/conversations
 * Returns the user's conversation list.
 */
export async function handleGetConversations(
  _request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request(
    `https://do/conversations?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "GET" }
  );

  const doResponse = await stub.fetch(doRequest);

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

/**
 * GET /api/conversations/:id
 * Returns a single conversation with messages and pending confirmations.
 */
export async function handleGetConversation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request(
    `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "GET" }
  );

  const doResponse = await stub.fetch(doRequest);

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Conversation not found" },
      { status }
    );
  }

  return new Response(doResponse.body, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * DELETE /api/conversations/:id
 * Deletes a conversation.
 */
export async function handleDeleteConversation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request(
    `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "DELETE" }
  );

  const doResponse = await stub.fetch(doRequest);

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Conversation not found" },
      { status }
    );
  }

  return Response.json({ success: true });
}

/**
 * POST /api/confirmations/:id/accept
 * Accepts a pending confirmation and executes the Clio operation.
 */
export async function handleAcceptConfirmation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request(
    `https://do/confirmation/${confirmationId}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: ctx.user.id }),
    }
  );

  const doResponse = await stub.fetch(doRequest);

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Confirmation not found or expired" },
      { status }
    );
  }

  // Return SSE stream with operation result
  return new Response(doResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * POST /api/confirmations/:id/reject
 * Rejects a pending confirmation.
 */
export async function handleRejectConfirmation(
  _request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const stub = getOrgDurableObject(env, ctx.orgId);
  const doRequest = new Request(
    `https://do/confirmation/${confirmationId}/reject`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: ctx.user.id }),
    }
  );

  const doResponse = await stub.fetch(doRequest);

  if (!doResponse.ok) {
    const status = doResponse.status === 404 ? 404 : doResponse.status;
    return Response.json(
      { error: "Confirmation not found or expired" },
      { status }
    );
  }

  return Response.json({ success: true });
}
