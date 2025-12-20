# Docket Technical Foundation

## Multi-Tenant Architecture

Law firms and clinics sign up as one organization ("org"). Users create a law firm or clinic, then invite members. To join an existing organization, users must be invited by an Admin. Note: "tenant" and "organization" are used interchangeably — both refer to a single law firm or clinic's environment.

Each organization has its own Cloudflare Durable Object (DO). The Knowledge Base (KB) and Clio Schema are shared across organizations. Org Context is per-org. Each user must have their own Clio account.

## Data Storage Reference

| Data                   | Location               | Classification | Reason                                    |
| ---------------------- | ---------------------- | -------------- | ----------------------------------------- |
| User accounts          | D1 (Better Auth)       | Confidential   | Shared auth infrastructure                |
| Sessions               | D1 (Better Auth)       | Confidential   | Shared auth infrastructure                |
| Org registry           | D1                     | Internal       | Cross-tenant lookups                      |
| Workspace bindings     | D1                     | Internal       | Cross-tenant lookups (Teams/Slack → org)  |
| API keys               | D1                     | Confidential   | Cross-tenant lookups                      |
| Invitations            | D1                     | Internal       | Cross-tenant lookups                      |
| Subscriptions          | D1                     | Internal       | Billing, tier enforcement                 |
| Role permissions       | D1                     | Internal       | Role × permission matrix                  |
| KB chunks              | D1 + Vectorize         | Public         | Shared across all orgs                    |
| Org Context chunks     | D1 + Vectorize         | Privileged     | Per-org (filtered by org_id)              |
| Org Context documents  | R2                     | Privileged     | Large files, path-isolated by org         |
| Conversations          | DO SQLite              | Privileged     | Tenant isolation, keyed by conversationId |
| Messages               | DO SQLite              | Privileged     | Tenant isolation, per conversationId      |
| Pending confirmations  | DO SQLite              | Privileged     | Tenant isolation                          |
| Org settings           | DO SQLite              | Confidential   | Tenant isolation                          |
| Cached Clio Schema     | DO SQLite              | Internal       | Per-org, loaded to memory                 |
| Audit logs             | R2                     | Privileged     | Append-only, hash-chained, multi-year     |
| Clio OAuth tokens      | DO Storage (encrypted) | Privileged     | Per-user, per-org, sensitive              |
| Archived conversations | R2                     | Privileged     | Cold storage, path-isolated by org        |
| Legal docs             | R2                     | Privileged     | Large files, path-isolated by org         |

**Data Classification:**

- Privileged: Tenant-isolated, audit logged
- Confidential: Sensitive business data, access controlled
- Internal: Operational data, not exposed externally
- Public: Shared knowledge, no tenant restrictions

**Data Locations:**

- Cloudflare Workers: Channel adapters, routing (`Docket Bot`)
- DOs: Per-org isolated state: conversations (keyed by `conversationId`), messages, settings, cached schema (`docketTenant`)
- D1 Database: Auth, org registry, subscriptions, role permissions, invitations, workspace bindings, API keys, KB chunks, Org Context chunks (`DB`)
- Vectorize: KB embeddings (shared) + Org Context embeddings (filtered by org_id) (`VECTORIZE`)
- R2 Bucket: Org Context docs, legal docs, archived conversations, audit logs (path-isolated) (`R2`). Configure lifecycle rules for retention and storage.
- DO Storage: Per-user Clio OAuth tokens (encrypted)
- Workers AI: LLM interface (`AI`)
- All bindings attached to worker

**Estimated cost:**

~$8.00 per 500 messages across Workers, DOs, Workers AI, D1, Vectorize, and R2.

## Encryption

- Cloudflare encrypts all D1, DO SQLite, DO Storage, R2, and Vectorize data at rest. At-rest encryption (AES-256) meets standard for privileged communications.
- Clio OAuth tokens in DO Storage use AES-GCM application-level encryption.

**Key Management:**

- Master key stored in Cloudflare Secrets (`wrangler secret put ENCRYPTION_KEY`)
- Per-user keys derived via HKDF-SHA256 with `user_id` as context/salt
- Key version prefixed to ciphertext for rotation support, decrypt with old key, re-encrypt with new

## Data Deletion

**User Leaves Org:** Messages stay (org owns for compliance). Delete: `org_members` entry, `channel_user_links` for that org, user's Clio OAuth token from DO KV, expire `pending_confirmations`. Auth sessions cleared (D1).

**Org Deletion:** Full wipe. Delete DO instance (SQLite + KV gone), R2 `/orgs/{org_id}/*`, D1 records (`org`, `org_members`, `workspace_bindings`, `org_context_chunks`, `subscriptions`, `api_keys`, `invitations`, `channel_user_links`). User accounts preserved—may belong to multiple orgs. Requires owner re-auth + typed confirmation.

**GDPR Request:** Delete from D1 (`user`, `session`, `account`, `channel_user_links`, `org_members`). Worker iterates user's orgs, each DO purges their conversations/messages. Audit logs anonymized (replace `user_id` with `REDACTED-{hash}`) to preserve hash chain. If user is sole org owner, triggers org deletion flow.
