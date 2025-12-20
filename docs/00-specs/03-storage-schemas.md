# Docket Storage Schemas

These are guidelines, not final schemas. Implementation will reveal what's actually needed.

## D1 Schema (Global)

**Tables:**

- Auth (Better Auth managed):
  - `user` - user accounts
  - `session` - active sessions
  - `account` - OAuth account links
  - `verification` - email verification, password reset tokens
- Cross-tenant:
  - `org` - org registry (includes `jurisdiction`, `practice_type`, `firm_size` for KB filtering)
  - `workspace_bindings` - Teams/Slack workspace → org mapping
  - `channel_user_links` - channel user → Docket user
  - `api_keys` - API keys for MCP/ChatGPT access
  - `invitations` - pending org invitations
- Subscriptions & Permissions:
  - `subscriptions` - org billing status
  - `tier_limits` - tier definitions
  - `role_permissions` - role × permission matrix
  - `org_members` - user-org-role binding
- Knowledge Base (shared, buildtime):
  - `kb_chunks` - text chunks for RAG
- Org Context (per-org, runtime):
  - `org_context_chunks` - firm-specific document chunks

**Indexes:** Add as query patterns emerge.

## DO SQLite Schema (Per-Org)

**Tables:**

- Conversations - chat sessions with metadata
- Messages - LLM context window history
- Pending Confirmations - CUD operations awaiting approval
- Org Settings - key-value config
- Clio Schema Cache - cached object definitions

**Indexes:** Add as query patterns emerge.

## R2 Storage (Per-Org)

**Path structure:**

```
/orgs/{org_id}/
├── docs/          → uploaded documents
├── audit/         → one JSON file per entry (YYYY/MM/DD/{timestamp}-{uuid}.json)
└── conversations/ → archived chats
```

Audit logs stored as individual objects for simple writes. Query via R2 list with date prefix.

## Session Disambiguation

| Term         | Meaning                            | Storage         |
| ------------ | ---------------------------------- | --------------- |
| Auth session | Better Auth login state            | D1 `session`    |
| Conversation | Teams/Slack chat context + history | DO SQLite       |
| Clio token   | OAuth credentials for Clio API     | DO Storage (KV) |
