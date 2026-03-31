import { type ChannelMessage } from "../types";
import type { Env } from "../types/env";
import { createLogger, generateRequestId } from "../lib/logger";
import { errors } from "../lib/errors";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface TeamsActivity {
  type: string;
  text?: string;
  id?: string;
  from?: { id: string; aadObjectId?: string };
  recipient?: { id: string };
  conversation?: { id: string; conversationType?: string };
  channelId?: string;
  serviceUrl?: string;
  channelData?: { tenant?: { id: string } };
}

interface ChannelUserInfo {
  userId: string;
  orgId: string;
  role: "admin" | "member";
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: string | null;
}

type ConversationScope = "personal" | "groupChat" | "teams";

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
 * Determine the conversation scope from the Teams activity.
 */
function getConversationScope(activity: TeamsActivity): ConversationScope {
  const conversationType = activity.conversation?.conversationType;

  if (conversationType === "personal") {
    return "personal";
  }
  if (conversationType === "groupChat") {
    return "groupChat";
  }
  return "teams";
}

/**
 * Look up a user by their channel-specific ID (e.g., Teams AAD Object ID).
 */
async function lookupChannelUser(
  env: Env,
  channelType: string,
  channelUserId: string
): Promise<ChannelUserInfo | null> {
  // Find the user link and their org membership
  const linkQuery = `
    SELECT cul.user_id, om.org_id, om.role
    FROM channel_user_links cul
    JOIN org_members om ON om.user_id = cul.user_id
    WHERE cul.channel_type = ? AND cul.channel_user_id = ?
    LIMIT 1
  `;

  const link = await env.DB.prepare(linkQuery)
    .bind(channelType, channelUserId)
    .first<{ user_id: string; org_id: string; role: "admin" | "member" }>();

  if (!link) {
    return null;
  }

  // Get the organization's configuration
  const orgQuery = `SELECT jurisdictions, practice_types, firm_size FROM org WHERE id = ?`;
  const org = await env.DB.prepare(orgQuery)
    .bind(link.org_id)
    .first<{ jurisdictions: string; practice_types: string; firm_size: string | null }>();

  if (!org) {
    return null;
  }

  return {
    userId: link.user_id,
    orgId: link.org_id,
    role: link.role,
    jurisdictions: safeParseJsonArray(org.jurisdictions),
    practiceTypes: safeParseJsonArray(org.practice_types),
    firmSize: org.firm_size,
  };
}

/**
 * Resolve the organization ID for a workspace-scoped conversation.
 * Verifies that the Teams tenant is bound to the user's organization.
 */
async function resolveWorkspaceOrg(
  env: Env,
  user: ChannelUserInfo,
  activity: TeamsActivity
): Promise<string | null> {
  const tenantId = activity.channelData?.tenant?.id;
  if (!tenantId) {
    return null;
  }

  // Check if the tenant is bound to an organization
  const bindingQuery = `
    SELECT org_id FROM workspace_bindings
    WHERE channel_type = ? AND workspace_id = ?
  `;

  const binding = await env.DB.prepare(bindingQuery)
    .bind("teams", tenantId)
    .first<{ org_id: string }>();

  // Only allow if the binding matches the user's organization
  if (binding?.org_id === user.orgId) {
    return binding.org_id;
  }

  return null;
}

/**
 * Send a reply message back to the Teams conversation.
 */
async function sendTeamsReply(
  activity: TeamsActivity,
  reply: { text: string; replyToId?: string }
): Promise<void> {
  const { serviceUrl, conversation, recipient, from } = activity;

  if (!serviceUrl || !conversation?.id) {
    return;
  }

  const replyUrl = `${serviceUrl}/v3/conversations/${conversation.id}/activities`;

  const replyPayload = {
    type: "message",
    text: reply.text,
    from: recipient,
    recipient: from,
    conversation,
    replyToId: reply.replyToId,
  };

  try {
    await fetch(replyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyPayload),
    });
  } catch (error) {
    const log = createLogger({ handler: "teams-reply" });
    log.error("Failed to send Teams reply", {
      error,
      conversationId: conversation.id,
    });
  }
}

// -----------------------------------------------------------------------------
// Main Handler
// -----------------------------------------------------------------------------

/**
 * POST /teams/messages
 * Handles incoming messages from Microsoft Teams.
 */
export async function handleTeamsMessage(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return errors.methodNotAllowed();
  }

  // Parse the incoming activity
  let activity: TeamsActivity;
  try {
    activity = (await request.json()) as TeamsActivity;
  } catch {
    // Return 200 even on parse failure to acknowledge receipt
    return new Response(null, { status: 200 });
  }

  const log = createLogger({
    requestId: generateRequestId(),
    handler: "teams-message",
  });

  try {
    return await processTeamsActivity(activity, env);
  } catch (error) {
    log.error("Teams message processing failed", { error });
    // Always return 200 to Teams to prevent retries
    return new Response(null, { status: 200 });
  }
}

/**
 * Process a Teams activity and generate a response.
 */
async function processTeamsActivity(
  activity: TeamsActivity,
  env: Env
): Promise<Response> {
  // Only process message activities with text content
  if (activity.type !== "message" || !activity.text) {
    return new Response(null, { status: 200 });
  }

  // Extract required identifiers
  const aadObjectId = activity.from?.aadObjectId;
  const conversationId = activity.conversation?.id;

  if (!aadObjectId || !conversationId) {
    return new Response(null, { status: 200 });
  }

  // Look up the user by their Teams ID
  const user = await lookupChannelUser(env, "teams", aadObjectId);

  if (!user) {
    // User not linked - send onboarding message
    await sendTeamsReply(activity, {
      text: "Welcome to Docket! Please link your account at docket.com to get started.",
    });
    return new Response(null, { status: 200 });
  }

  // Determine conversation scope and organization
  const scope = getConversationScope(activity);

  let orgId: string | null;
  if (scope === "personal") {
    // Personal chats use the user's organization directly
    orgId = user.orgId;
  } else {
    // Workspace chats require tenant binding verification
    orgId = await resolveWorkspaceOrg(env, user, activity);
  }

  if (!orgId) {
    return new Response(null, { status: 200 });
  }

  // Build the channel message for the Durable Object
  const channelMessage: ChannelMessage = {
    channel: "teams",
    orgId,
    userId: user.userId,
    userRole: user.role,
    conversationId,
    conversationScope: scope,
    message: activity.text,
    jurisdictions: user.jurisdictions,
    practiceTypes: user.practiceTypes,
    firmSize: user.firmSize as "solo" | "small" | "mid" | "large" | null,
    metadata: {
      threadId: conversationId,
      teamsChannelId: activity.channelId,
    },
  };

  // Send to the organization's Durable Object for processing
  const doId = env.TENANT.idFromName(orgId);
  const doStub = env.TENANT.get(doId);

  const doRequest = new Request("https://do/process-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(channelMessage),
  });

  const doResponse = await doStub.fetch(doRequest);
  const result = (await doResponse.json()) as { response: string };

  // Send the response back to Teams
  await sendTeamsReply(activity, {
    text: result.response,
    replyToId: activity.id,
  });

  return new Response(null, { status: 200 });
}
