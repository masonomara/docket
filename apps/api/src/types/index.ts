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
