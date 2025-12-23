import { type ChannelMessage } from "../types";
import type { Env } from "../types/env";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ChannelUserInfo {
  userId: string;
  orgId: string;
  role: "admin" | "member";
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: string | null;
}

interface TeamsActivity {
  type: string;
  text?: string;
  id?: string;
  from?: {
    id: string;
    aadObjectId?: string;
  };
  recipient?: {
    id: string;
  };
  conversation?: {
    id: string;
    conversationType?: string;
  };
  channelId?: string;
  serviceUrl?: string;
  channelData?: {
    tenant?: {
      id: string;
    };
  };
}

type ConversationScope = "personal" | "groupChat" | "teams";

// ─────────────────────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleTeamsMessage(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Parse the incoming activity
  let activity: TeamsActivity;
  try {
    activity = (await request.json()) as TeamsActivity;
  } catch {
    // Invalid JSON, but Teams expects 200
    return new Response(null, { status: 200 });
  }

  try {
    return await processTeamsActivity(activity, env);
  } catch (error) {
    console.error("handleTeamsMessage error:", error);
    // Always return 200 to Teams to prevent retries
    return new Response(null, { status: 200 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Processing
// ─────────────────────────────────────────────────────────────────────────────

async function processTeamsActivity(
  activity: TeamsActivity,
  env: Env
): Promise<Response> {
  // Only process message activities with text
  if (activity.type !== "message" || !activity.text) {
    return new Response(null, { status: 200 });
  }

  // Extract required IDs
  const aadObjectId = activity.from?.aadObjectId;
  const conversationId = activity.conversation?.id;

  if (!aadObjectId || !conversationId) {
    return new Response(null, { status: 200 });
  }

  // Look up the user in our system
  const user = await lookupChannelUser(env, "teams", aadObjectId);

  if (!user) {
    // User not linked, send welcome message
    await sendTeamsReply(activity, {
      text: "Welcome to Docket! Please link your account at docket.com to get started.",
    });
    return new Response(null, { status: 200 });
  }

  // Determine conversation scope and validate org access
  const scope = getConversationScope(activity);
  const orgId = await resolveOrgId(env, user, activity, scope);

  if (!orgId) {
    return new Response(null, { status: 200 });
  }

  // Build the channel message
  const channelMessage = buildChannelMessage(activity, user, orgId, scope);

  // Route to the organization's Durable Object
  const doResponse = await routeMessageToDO(env, channelMessage);
  const result = (await doResponse.json()) as { response: string };

  // Send the response back to Teams
  await sendTeamsReply(activity, {
    text: result.response,
    replyToId: activity.id,
  });

  return new Response(null, { status: 200 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

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

async function resolveOrgId(
  env: Env,
  user: ChannelUserInfo,
  activity: TeamsActivity,
  scope: ConversationScope
): Promise<string | null> {
  // For personal chats, use the user's org directly
  if (scope === "personal") {
    return user.orgId;
  }

  // For team/group chats, verify the workspace is linked to the user's org
  const tenantId = activity.channelData?.tenant?.id;
  if (!tenantId) {
    return null;
  }

  const workspaceOrgId = await lookupWorkspaceOrg(env, "teams", tenantId);

  // Verify user belongs to this workspace's org
  if (!workspaceOrgId || workspaceOrgId !== user.orgId) {
    return null;
  }

  return workspaceOrgId;
}

function buildChannelMessage(
  activity: TeamsActivity,
  user: ChannelUserInfo,
  orgId: string,
  scope: ConversationScope
): ChannelMessage {
  return {
    channel: "teams",
    orgId,
    userId: user.userId,
    userRole: user.role,
    conversationId: activity.conversation!.id,
    conversationScope: scope,
    message: activity.text!,
    jurisdictions: user.jurisdictions,
    practiceTypes: user.practiceTypes,
    firmSize: user.firmSize as "solo" | "small" | "mid" | "large" | null,
    metadata: {
      threadId: activity.conversation?.id,
      teamsChannelId: activity.channelId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Teams API
// ─────────────────────────────────────────────────────────────────────────────

async function sendTeamsReply(
  activity: TeamsActivity,
  reply: { text: string; replyToId?: string }
): Promise<void> {
  const serviceUrl = activity.serviceUrl;
  const conversationId = activity.conversation?.id;

  if (!serviceUrl || !conversationId) {
    return;
  }

  const replyUrl = `${serviceUrl}/v3/conversations/${conversationId}/activities`;

  const replyPayload = {
    type: "message",
    text: reply.text,
    from: activity.recipient,
    recipient: activity.from,
    conversation: activity.conversation,
    replyToId: reply.replyToId,
  };

  try {
    await fetch(replyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(replyPayload),
    });
  } catch (error) {
    console.error("Teams reply error:", error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Lookups
// ─────────────────────────────────────────────────────────────────────────────

async function lookupChannelUser(
  env: Env,
  channelType: string,
  channelUserId: string
): Promise<ChannelUserInfo | null> {
  // Look up the channel link and org membership
  const link = await env.DB.prepare(
    `SELECT cul.user_id, om.org_id, om.role
     FROM channel_user_links cul
     JOIN org_members om ON om.user_id = cul.user_id
     WHERE cul.channel_type = ? AND cul.channel_user_id = ?
     LIMIT 1`
  )
    .bind(channelType, channelUserId)
    .first<{ user_id: string; org_id: string; role: "admin" | "member" }>();

  if (!link) {
    return null;
  }

  // Get org settings
  const org = await env.DB.prepare(
    `SELECT jurisdictions, practice_types, firm_size
     FROM org
     WHERE id = ?`
  )
    .bind(link.org_id)
    .first<{
      jurisdictions: string;
      practice_types: string;
      firm_size: string | null;
    }>();

  if (!org) {
    return null;
  }

  // Parse JSON arrays
  const jurisdictions = parseJsonArray(org.jurisdictions);
  const practiceTypes = parseJsonArray(org.practice_types);

  return {
    userId: link.user_id,
    orgId: link.org_id,
    role: link.role,
    jurisdictions,
    practiceTypes,
    firmSize: org.firm_size,
  };
}

function parseJsonArray(json: string | null): string[] {
  if (!json) {
    return [];
  }

  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

async function lookupWorkspaceOrg(
  env: Env,
  channelType: string,
  workspaceId: string
): Promise<string | null> {
  const result = await env.DB.prepare(
    `SELECT org_id
     FROM workspace_bindings
     WHERE channel_type = ? AND workspace_id = ?`
  )
    .bind(channelType, workspaceId)
    .first<{ org_id: string }>();

  return result?.org_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable Object Routing
// ─────────────────────────────────────────────────────────────────────────────

async function routeMessageToDO(
  env: Env,
  message: ChannelMessage
): Promise<Response> {
  const doId = env.TENANT.idFromName(message.orgId);
  const doStub = env.TENANT.get(doId);

  return doStub.fetch(
    new Request("https://do/process-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    })
  );
}
