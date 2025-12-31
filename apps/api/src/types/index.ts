import { z } from "zod";

// =============================================================================
// Core Enums & Primitives
// =============================================================================

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

// =============================================================================
// Organization Types
// =============================================================================

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

/**
 * Database row format for org_member table (snake_case).
 * Use orgMemberRowToEntity() to convert to OrgMembership.
 */
export interface OrgMemberRow {
  id: string;
  user_id: string;
  org_id: string;
  role: OrgRole;
  is_owner: number; // SQLite boolean (0 or 1)
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

// =============================================================================
// Channel & Messaging Types
// =============================================================================

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

/**
 * Message payload from any channel (Teams, Slack, web, etc.)
 * This is the unified format that gets passed to the TenantDO for processing.
 */
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

// =============================================================================
// Audit Types
// =============================================================================

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

// =============================================================================
// Confirmation Types (for Clio write operations)
// =============================================================================

/**
 * When the LLM wants to create/update/delete something in Clio,
 * we store a pending confirmation that the user must approve.
 */
export interface PendingConfirmation {
  id: string;
  conversationId: string;
  action: "create" | "update" | "delete";
  objectType: string;
  params: Record<string, unknown>;
  expiresAt: number;
}

// =============================================================================
// LLM Types
// =============================================================================

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

// =============================================================================
// SSE (Server-Sent Events) Types
// =============================================================================
//
// These types define the streaming events sent from the API to the web client.
// Each event type has a corresponding Zod schema for validation.

interface SSEBaseEvent {
  requestId?: string;
}

// --- Content Event ---
// Sent when the assistant has text content to display

export interface SSEContentEvent extends SSEBaseEvent {
  text: string;
}

export const SSEContentEventSchema = z.object({
  text: z.string(),
  requestId: z.string().optional(),
});

// --- Process Events ---
// Sent to show progress through the processing pipeline.
// These events provide a granular, transparent view into how the assistant processes each message.

export type ProcessEventType =
  | "started"
  | "embedding"
  | "kb_search"
  | "org_context_search"
  | "context_retrieved"
  | "clio_schema"
  | "history_loaded"
  | "prompt_building"
  | "llm_thinking"
  | "clio_call"
  | "clio_result";

export interface SSEProcessEventStarted extends SSEBaseEvent {
  type: "started";
}

// Embedding the user's query for semantic search
export interface SSEProcessEventEmbedding extends SSEBaseEvent {
  type: "embedding";
  status: "started" | "complete";
  query?: string; // The query being embedded
  durationMs?: number;
}

// Searching the shared Knowledge Base
export interface SSEProcessEventKBSearch extends SSEBaseEvent {
  type: "kb_search";
  status: "started" | "complete";
  filters?: {
    jurisdictions?: string[];
    practiceTypes?: string[];
    firmSize?: string;
  };
  matchCount?: number;
  chunks?: Array<{
    source: string;
    preview: string;
    score?: number;
  }>;
  durationMs?: number;
}

// Searching organization-specific context
export interface SSEProcessEventOrgContextSearch extends SSEBaseEvent {
  type: "org_context_search";
  status: "started" | "complete";
  matchCount?: number;
  chunks?: Array<{
    source: string;
    preview: string;
    score?: number;
  }>;
  durationMs?: number;
}

// Summary of all retrieved context
export interface SSEProcessEventContextRetrieved extends SSEBaseEvent {
  type: "context_retrieved";
  kbCount: number;
  orgCount: number;
  totalTokens?: number;
  sources: Array<{
    type: "kb" | "org";
    source: string;
    preview: string;
  }>;
}

// Loading Clio schema (custom fields, API configuration)
export interface SSEProcessEventClioSchema extends SSEBaseEvent {
  type: "clio_schema";
  status: "started" | "complete";
  customFieldCount?: number;
  cached?: boolean;
  durationMs?: number;
}

// Loading conversation history
export interface SSEProcessEventHistoryLoaded extends SSEBaseEvent {
  type: "history_loaded";
  messageCount: number;
  durationMs?: number;
}

// Building the system prompt
export interface SSEProcessEventPromptBuilding extends SSEBaseEvent {
  type: "prompt_building";
  status: "started" | "complete";
  components?: {
    ragContext: boolean;
    customFields: boolean;
    userRole: string;
    toolsEnabled: string[];
  };
  promptLength?: number;
  durationMs?: number;
}

export interface SSEProcessEventLlmThinking extends SSEBaseEvent {
  type: "llm_thinking";
  status: "started" | "complete";
  model?: string;
  durationMs?: number;
  hasToolCalls?: boolean;
  toolCallCount?: number;
}

export interface SSEProcessEventClioCall extends SSEBaseEvent {
  type: "clio_call";
  operation: "read" | "create" | "update" | "delete";
  objectType: string;
  filters?: Record<string, unknown>;
}

export interface SSEProcessEventClioResultRead extends SSEBaseEvent {
  type: "clio_result";
  count: number;
  preview: unknown[];
}

export interface SSEProcessEventClioResultWrite extends SSEBaseEvent {
  type: "clio_result";
  success: boolean;
}

export type SSEProcessEventClioResult =
  | SSEProcessEventClioResultRead
  | SSEProcessEventClioResultWrite;

export type SSEProcessEvent =
  | SSEProcessEventStarted
  | SSEProcessEventEmbedding
  | SSEProcessEventKBSearch
  | SSEProcessEventOrgContextSearch
  | SSEProcessEventContextRetrieved
  | SSEProcessEventClioSchema
  | SSEProcessEventHistoryLoaded
  | SSEProcessEventPromptBuilding
  | SSEProcessEventLlmThinking
  | SSEProcessEventClioCall
  | SSEProcessEventClioResult;

const chunkSchema = z.object({
  source: z.string(),
  preview: z.string(),
  score: z.number().optional(),
});

export const SSEProcessEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("started"),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("embedding"),
    status: z.enum(["started", "complete"]),
    query: z.string().optional(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("kb_search"),
    status: z.enum(["started", "complete"]),
    filters: z
      .object({
        jurisdictions: z.array(z.string()).optional(),
        practiceTypes: z.array(z.string()).optional(),
        firmSize: z.string().optional(),
      })
      .optional(),
    matchCount: z.number().optional(),
    chunks: z.array(chunkSchema).optional(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("org_context_search"),
    status: z.enum(["started", "complete"]),
    matchCount: z.number().optional(),
    chunks: z.array(chunkSchema).optional(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("context_retrieved"),
    kbCount: z.number(),
    orgCount: z.number(),
    totalTokens: z.number().optional(),
    sources: z.array(
      z.object({
        type: z.enum(["kb", "org"]),
        source: z.string(),
        preview: z.string(),
      })
    ),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("clio_schema"),
    status: z.enum(["started", "complete"]),
    customFieldCount: z.number().optional(),
    cached: z.boolean().optional(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("history_loaded"),
    messageCount: z.number(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("prompt_building"),
    status: z.enum(["started", "complete"]),
    components: z
      .object({
        ragContext: z.boolean(),
        customFields: z.boolean(),
        userRole: z.string(),
        toolsEnabled: z.array(z.string()),
      })
      .optional(),
    promptLength: z.number().optional(),
    durationMs: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("llm_thinking"),
    status: z.enum(["started", "complete"]),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    hasToolCalls: z.boolean().optional(),
    toolCallCount: z.number().optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("clio_call"),
    operation: z.enum(["read", "create", "update", "delete"]),
    objectType: z.string(),
    filters: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("clio_result"),
    count: z.number().optional(),
    preview: z.array(z.unknown()).optional(),
    success: z.boolean().optional(),
    requestId: z.string().optional(),
  }),
]);

// --- Confirmation Required Event ---
// Sent when a write operation needs user approval

export interface SSEConfirmationRequiredEvent extends SSEBaseEvent {
  confirmationId: string;
  action: "create" | "update" | "delete";
  objectType: string;
  params: Record<string, unknown>;
}

export const SSEConfirmationRequiredEventSchema = z.object({
  confirmationId: z.string(),
  action: z.enum(["create", "update", "delete"]),
  objectType: z.string(),
  params: z.record(z.string(), z.unknown()),
  requestId: z.string().optional(),
});

// --- Error Event ---

export interface SSEErrorEvent extends SSEBaseEvent {
  message: string;
}

export const SSEErrorEventSchema = z.object({
  message: z.string(),
  requestId: z.string().optional(),
});

// --- Done Event ---

export interface SSEDoneEvent extends SSEBaseEvent {}

export const SSEDoneEventSchema = z.object({
  requestId: z.string().optional(),
});

// --- Union of All SSE Events ---

export type SSEEvent =
  | { event: "content"; data: SSEContentEvent }
  | { event: "process"; data: SSEProcessEvent }
  | { event: "confirmation_required"; data: SSEConfirmationRequiredEvent }
  | { event: "error"; data: SSEErrorEvent }
  | { event: "done"; data: SSEDoneEvent };
