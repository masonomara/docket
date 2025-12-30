/**
 * Shared types for the web application.
 */

// ============================================================================
// Auth Types
// ============================================================================

export interface SessionResponse {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
  };
}

// ============================================================================
// Organization Types
// ============================================================================

export type OrgRole = "admin" | "member";

export interface OrgMembership {
  org: {
    id: string;
    name: string;
    jurisdictions?: string[];
    practiceTypes?: string[];
    firmSize?: string;
  };
  role: OrgRole;
  isOwner: boolean;
}

export interface OrgMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: OrgRole;
  isOwner: boolean;
  createdAt: number;
}

// ============================================================================
// Invitation Types
// ============================================================================

export interface PendingInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string;
  inviterName: string;
  createdAt: number;
  expiresAt: number;
}

export interface InvitationDetails {
  id: string;
  email: string;
  orgName: string;
  role: OrgRole;
  inviterName: string;
  isExpired: boolean;
  isAccepted: boolean;
}

// ============================================================================
// Document Types
// ============================================================================

export interface OrgContextDocument {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  chunkCount: number;
}

// ============================================================================
// Chat Types
// ============================================================================

export type MessageRole = "user" | "assistant" | "system";
export type MessageStatus = "complete" | "partial" | "error" | "streaming";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface ConversationDetail {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingConfirmation {
  id: string;
  action: "create" | "update" | "delete";
  objectType: string;
  params: Record<string, unknown>;
}

export type ProcessEventType =
  | "rag_lookup"
  | "llm_thinking"
  | "clio_call"
  | "clio_result"
  | "confirmation_required";

export interface ProcessEvent {
  type: ProcessEventType;
  status: "started" | "completed" | "error";
  timestamp: number;
  details?: Record<string, unknown>;
}
