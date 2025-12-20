# Docket Durable Objects

**Important Doc:** [Cloudflare Durable Objects Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

## Overview

One DO per organization. Each org's DO coordinates tenant state, conversation logic, and Clio interactions. Keeps storage distributed and data isolated. Each Teams/Slack conversation maintains isolated history within the org's DO.

**State:** conversations (keyed by `conversationId`), messages, pending confirmations, org settings, cached Clio schema.

**Logic:** RAG retrieval, LLM invocation, permission enforcement, Clio query execution, response formatting.

## Request Flow

Endpoint: `POST /process-message`

1. Channel Adapter sends `ChannelMessage` (user_id, org_id, role, conversationId, conversationScope, message, jurisdiction, practiceType, firmSize) to DO
2. DO verifies user's role from SQLite
3. DO generates embedding via Workers AI, queries Vectorize for Knowledge Base + Org Context chunks (filtered by jurisdiction, practiceType, firmSize)
4. DO loads Clio Schema from memory cache (populated from SQLite in constructor)
5. DO builds system prompt: RAG context + Clio Schema + Org Context
6. DO appends last 15 messages from this `conversationId`'s history, calls Workers AI
7. If LLM returns tool call (structured params) → DO builds Clio API call, executes against Clio
8. For CUD operations: DO stores pending confirmation, returns confirmation prompt to user
9. On user confirmation: DO executes Clio operation, logs to audit
10. DO formats response, returns through Worker → Channel → user

## Org Identity

DO derives `orgId` from its own Durable Object ID, never from `ChannelMessage.orgId`. The DO ID _is_ the org identity—established at instantiation by the Channel Adapter's D1 lookup. All internal operations (RAG queries, Clio calls, audit logs) use this derived identity. The `orgId` in incoming messages exists only for request tracing and must match DO identity or request is rejected.

## Conversation Isolation

Each `conversationId` (Teams personal chat, group chat, channel, or Slack DM/channel) maintains separate:

- Message history (for LLM context)
- Pending confirmations
- Thread context

## User Permissions Enforcement

DO enforces permissions, not adapter. Centralized enforcement prevents bypass.

- Member: Read-only Clio queries execute automatically
- Admin: CUD operations require explicit confirmation
- DO checks `role_permissions` matrix before any Clio operation
- Unauthorized attempts logged to audit, user gets denial message

## Rate Limiting

Cloudflare rate limiting rules on `/process-message`: 50 req/min per user IP. Configured in dashboard, not code.

## DO Storage Split

Two storage mechanisms in each DO:

- DO SQLite: Structured data: conversations (keyed by `conversationId`), messages, pending confirmations, org settings, Clio schema cache
- DO Storage (KV): Encrypted secrets: Clio OAuth tokens (per-user), channel bot tokens. Clio tokens encrypted with AES-GCM, per-user key derivation.

## Audit Logs

Audit logs are for troubleshooting, compliance, and support. They track Clio CUD operations (user_id, timestamp, params, result), Org Context changes (uploads, deletions), role/permission changes, and Clio OAuth connect/disconnect events.

**Storage:** One R2 object per entry (`/orgs/{org_id}/audit/{year}/{month}/{day}/{timestamp}-{uuid}.json`). Simple PUT, no read-modify-write. Query via R2 list with date prefix. Multi-year retention for legal compliance.

## Constructor Pattern

SQLite tables don't auto-create. Use `blockConcurrencyWhile()` in constructor for migrations and schema loading. `PRAGMA user_version` tracks migration version.

`blockConcurrencyWhile()` blocks all requests (~200 req/s ceiling). Keep it fast—storage ops only, no external I/O.

## Alarms

Use alarms (not cron) for per-org scheduled work:

- Archive conversations older than 30 days: Active conversations live in DO SQLite. Old conversations (>30 days inactive) archived to R2 (`/orgs/{org_id}/conversations/`) via alarm. Prevents SQLite bloat for active orgs. Keeps archived conversations retrievable in storage but not loaded into LLM context.
- Clean expired pending confirmations

## Clio Schema

The Clio Schema accessed by the DO, is refreshed/provisioned in three scenarios.

**Initial provisioning:** Fetched from Clio when first user from org connects their Clio Account, which triggers `POST /provision-schema`. That makes the DO fetch schema (including org-specific custom fields), stores it in SQLite, and loads to memory. Note on DO's: Concurrent requests blocked by DO's single-threaded execution until provisioning completes.

**Developer migration:** when Clio's base API changes (rare), that requires a code update, so the developer migration sets a refresh flag. The next request with a valid Clio token triggers re-fetch automatically.

**Admin refresh:** A simple button in the Docket website Clio settings (Admin only, complete with explanation of what it does). Admin clicks when they've added custom fields in Clio, calls `POST /refresh-schema` on DO, re-fetches from Clio, logs to audit.
