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
