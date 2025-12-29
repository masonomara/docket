import type { MemberContext } from "../lib/session";
import type { Env } from "../types/env";
import type { ChannelMessage, FirmSize, OrgRole } from "../types";
import { ChannelMessageSchema } from "../types";
import { createLogger, generateRequestId } from "../lib/logger";

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

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
 * Get the user's role and organization settings from D1.
 */
async function getUserContext(
  db: D1Database,
  userId: string,
  orgId: string
): Promise<{
  role: OrgRole;
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null;
} | null> {
  const query = `
    SELECT
      om.role,
      o.jurisdictions,
      o.practice_types,
      o.firm_size
    FROM org_members om
    JOIN org o ON o.id = om.org_id
    WHERE om.user_id = ? AND om.org_id = ?
  `;

  const row = await db.prepare(query).bind(userId, orgId).first<{
    role: OrgRole;
    jurisdictions: string | null;
    practice_types: string | null;
    firm_size: FirmSize | null;
  }>();

  if (!row) {
    return null;
  }

  return {
    role: row.role,
    jurisdictions: safeParseJsonArray(row.jurisdictions),
    practiceTypes: safeParseJsonArray(row.practice_types),
    firmSize: row.firm_size,
  };
}

/**
 * Get the Durable Object stub for an organization.
 */
function getOrgDurableObject(env: Env, orgId: string) {
  const doId = env.TENANT.idFromName(orgId);
  return env.TENANT.get(doId);
}

// -----------------------------------------------------------------------------
// Chat Handler
// -----------------------------------------------------------------------------

/**
 * POST /api/chat
 *
 * Main entry point for web chat messages. This handler:
 * 1. Validates the request body
 * 2. Builds a ChannelMessage from the authenticated user's context
 * 3. Forwards to the organization's Durable Object
 * 4. Returns the DO's response as an SSE stream
 *
 * The withMember middleware has already validated:
 * - User is logged in
 * - User belongs to an organization
 * - User has at least "member" role
 */
export async function handleChatMessage(
  request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "chat" });

  // Parse the incoming message
  let body: { conversationId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  if (!body.conversationId) {
    return Response.json({ error: "Missing conversationId" }, { status: 400 });
  }

  if (!body.message || body.message.trim().length === 0) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  // Get user context (role and org settings) from D1
  const userContext = await getUserContext(env.DB, ctx.user.id, ctx.orgId);

  if (!userContext) {
    log.warn("User context not found", {
      userId: ctx.user.id,
      orgId: ctx.orgId,
    });
    return Response.json({ error: "User context not found" }, { status: 403 });
  }

  // Build the ChannelMessage
  const channelMessage: ChannelMessage = {
    channel: "web",
    orgId: ctx.orgId,
    userId: ctx.user.id,
    userRole: userContext.role,
    conversationId: body.conversationId,
    conversationScope: "personal", // Web is always 1:1 with the bot
    message: body.message.trim(),
    jurisdictions: userContext.jurisdictions,
    practiceTypes: userContext.practiceTypes,
    firmSize: userContext.firmSize,
  };

  // Validate against the schema (defense in depth)
  const parseResult = ChannelMessageSchema.safeParse(channelMessage);
  if (!parseResult.success) {
    log.warn("Channel message validation failed", {
      errors: parseResult.error.issues,
    });
    return Response.json({ error: "Invalid message format" }, { status: 400 });
  }

  // Get the organization's Durable Object
  const doStub = getOrgDurableObject(env, ctx.orgId);

  // Forward to the DO and return its streaming response
  const doRequest = new Request("https://do/process-message-stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
    body: JSON.stringify(channelMessage),
  });

  log.info("Forwarding chat message to DO", {
    conversationId: body.conversationId,
    orgId: ctx.orgId,
  });

  // Pass through the SSE response from the DO
  const doResponse = await doStub.fetch(doRequest);

  // If the DO returned an error, pass it through
  if (!doResponse.ok) {
    const errorBody = await doResponse.text();
    log.error("DO returned error", {
      status: doResponse.status,
      body: errorBody,
    });
    return new Response(errorBody, {
      status: doResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Return the SSE stream with appropriate headers
  return new Response(doResponse.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Request-Id": requestId,
    },
  });
}

// -----------------------------------------------------------------------------
// Conversation List Handlers
// -----------------------------------------------------------------------------

/**
 * GET /api/conversations
 *
 * Returns the user's conversations, most recent first.
 * Each conversation shows title (first message truncated), updated time, and message count.
 */
export async function handleGetConversations(
  request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const doStub = getOrgDurableObject(env, ctx.orgId);

  const doRequest = new Request(
    `https://do/conversations?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "GET" }
  );

  return doStub.fetch(doRequest);
}

/**
 * GET /api/conversations/:id
 *
 * Returns a single conversation with all its messages.
 * Used when user clicks a conversation in the sidebar.
 */
export async function handleGetConversation(
  request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const doStub = getOrgDurableObject(env, ctx.orgId);

  const doRequest = new Request(
    `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "GET" }
  );

  return doStub.fetch(doRequest);
}

/**
 * DELETE /api/conversations/:id
 *
 * Deletes a conversation and all its messages.
 * Users can only delete their own conversations.
 */
export async function handleDeleteConversation(
  request: Request,
  env: Env,
  ctx: MemberContext,
  conversationId: string
): Promise<Response> {
  const doStub = getOrgDurableObject(env, ctx.orgId);

  const doRequest = new Request(
    `https://do/conversation/${conversationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "DELETE" }
  );

  return doStub.fetch(doRequest);
}

// -----------------------------------------------------------------------------
// Confirmation Handlers
// -----------------------------------------------------------------------------

/**
 * POST /api/confirmations/:id/accept
 *
 * Accepts a pending Clio operation.
 * Returns the operation result.
 */
export async function handleAcceptConfirmation(
  request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const doStub = getOrgDurableObject(env, ctx.orgId);

  const doRequest = new Request(
    `https://do/accept-confirmation/${confirmationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "POST" }
  );

  return doStub.fetch(doRequest);
}

/**
 * POST /api/confirmations/:id/reject
 *
 * Rejects a pending Clio operation.
 */
export async function handleRejectConfirmation(
  request: Request,
  env: Env,
  ctx: MemberContext,
  confirmationId: string
): Promise<Response> {
  const doStub = getOrgDurableObject(env, ctx.orgId);

  const doRequest = new Request(
    `https://do/reject-confirmation/${confirmationId}?userId=${encodeURIComponent(ctx.user.id)}`,
    { method: "POST" }
  );

  return doStub.fetch(doRequest);
}
