import { z } from "zod";

// ============================================================================
// Role and Type Definitions
// ============================================================================

export type OrgRole = "admin" | "member";

export type ChannelType = "teams" | "slack" | "mcp" | "chatgpt" | "web";

export type FirmSize = "solo" | "small" | "mid" | "large";

export type ConversationScope =
  | "personal"
  | "groupChat"
  | "teams"
  | "dm"
  | "channel"
  | "api";

// ============================================================================
// Organization Types
// ============================================================================

export interface Organization {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrgSettings {
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null;
}

export interface OrgMembership {
  id: string;
  userId: string;
  orgId: string;
  role: OrgRole;
  isOwner: boolean;
  createdAt: number;
}

// Database row format (snake_case, numeric booleans)
// Use orgMemberRowToEntity() to convert to OrgMembership.
export interface OrgMemberRow {
  id: string;
  user_id: string;
  org_id: string;
  role: OrgRole;
  is_owner: number; // SQLite stores booleans as 0/1
  created_at: number;
}

export function orgMemberRowToEntity(row: OrgMemberRow): OrgMembership {
  return {
    id: row.id,
    userId: row.user_id,
    orgId: row.org_id,
    role: row.role,
    isOwner: row.is_owner === 1,
    createdAt: row.created_at,
  };
}

// ============================================================================
// Invitation Types
// ============================================================================

export interface Invitation {
  id: string;
  email: string;
  orgId: string;
  role: OrgRole;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
}

// ============================================================================
// Channel Types
// ============================================================================

export interface ChannelLink {
  channelType: ChannelType;
  channelUserId: string;
  userId: string;
}

export interface ChannelMetadata {
  threadId?: string;
  teamsChannelId?: string;
  slackChannelId?: string;
}

export interface ChannelMessage {
  channel: ChannelType;
  orgId: string;
  userId: string;
  userRole: OrgRole;
  conversationId: string;
  conversationScope: ConversationScope;
  message: string;
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null;
  metadata?: ChannelMetadata;
}

export const ChannelMessageSchema = z.object({
  channel: z.enum(["teams", "slack", "mcp", "chatgpt", "web"]),
  orgId: z.string().min(1),
  userId: z.string().min(1),
  userRole: z.enum(["admin", "member"]),
  conversationId: z.string().min(1),
  conversationScope: z.enum([
    "personal",
    "groupChat",
    "teams",
    "dm",
    "channel",
    "api",
  ]),
  message: z.string().min(1).max(10000),
  jurisdictions: z.array(z.string()),
  practiceTypes: z.array(z.string()),
  firmSize: z.enum(["solo", "small", "mid", "large"]).nullable(),
  metadata: z
    .object({
      threadId: z.string().optional(),
      teamsChannelId: z.string().optional(),
      slackChannelId: z.string().optional(),
    })
    .optional(),
});

// ============================================================================
// Audit Types
// ============================================================================

export interface AuditEntry {
  id: string;
  userId: string;
  action: string;
  objectType: string;
  params: Record<string, unknown>;
  result: "success" | "error";
  errorMessage?: string;
  createdAt: string;
}

// ============================================================================
// Conversation Types
// ============================================================================

export interface PendingConfirmation {
  id: string;
  action: "create" | "update" | "delete";
  objectType: string;
  params: Record<string, unknown>;
  expiresAt: number;
}

// ============================================================================
// LLM Types
// ============================================================================

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolCall {
  name: string;
  arguments: {
    operation: "read" | "create" | "update" | "delete";
    objectType: string;
    id?: string;
    filters?: Record<string, unknown>;
    data?: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
}

// ============================================================================
// SSE Event Types (Web Chat Interface)
// ============================================================================

export interface SSEContentEvent {
  text: string;
}

export type ProcessEventType =
  | "started"
  | "rag_lookup"
  | "llm_thinking"
  | "clio_call"
  | "clio_result";

export interface SSEProcessEventStarted {
  type: "started";
}

export interface SSEProcessEventRagLookup {
  type: "rag_lookup";
  status: "started" | "complete";
  chunks?: Array<{ text: string; source: string }>;
}

export interface SSEProcessEventLlmThinking {
  type: "llm_thinking";
  status: "started";
}

export interface SSEProcessEventClioCall {
  type: "clio_call";
  operation: "read" | "create" | "update" | "delete";
  objectType: string;
  filters?: Record<string, unknown>;
}

export interface SSEProcessEventClioResult {
  type: "clio_result";
  count: number;
  preview: unknown[];
}

export type SSEProcessEvent =
  | SSEProcessEventStarted
  | SSEProcessEventRagLookup
  | SSEProcessEventLlmThinking
  | SSEProcessEventClioCall
  | SSEProcessEventClioResult;

export interface SSEConfirmationRequiredEvent {
  confirmationId: string;
  action: "create" | "update" | "delete";
  objectType: string;
  params: Record<string, unknown>;
}

export interface SSEErrorEvent {
  message: string;
}

export type SSEEvent =
  | { event: "content"; data: SSEContentEvent }
  | { event: "process"; data: SSEProcessEvent }
  | { event: "confirmation_required"; data: SSEConfirmationRequiredEvent }
  | { event: "error"; data: SSEErrorEvent }
  | { event: "done"; data: null };

export const SSEContentEventSchema = z.object({
  text: z.string(),
});

export const SSEProcessEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("started") }),
  z.object({
    type: z.literal("rag_lookup"),
    status: z.enum(["started", "complete"]),
    chunks: z.array(z.object({ text: z.string(), source: z.string() })).optional(),
  }),
  z.object({
    type: z.literal("llm_thinking"),
    status: z.literal("started"),
  }),
  z.object({
    type: z.literal("clio_call"),
    operation: z.enum(["read", "create", "update", "delete"]),
    objectType: z.string(),
    filters: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("clio_result"),
    count: z.number(),
    preview: z.array(z.unknown()),
  }),
]);

export const SSEConfirmationRequiredEventSchema = z.object({
  confirmationId: z.string(),
  action: z.enum(["create", "update", "delete"]),
  objectType: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const SSEErrorEventSchema = z.object({
  message: z.string(),
});
