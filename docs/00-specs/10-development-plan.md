# Docket Development Plan

Each phase needs to have simple unit, integration (if applicable), and end-to-end testing, as well as a verbose component/example that demonstrates what was accomplished in each phase for shareholder demonstration.

## Phase 1: Validate Plan

**Checklist:**

- [x] Interview questions prepared
- [ ] 3-4 legal professionals interviewed
- [ ] Pain points documented
- [ ] Feature priorities validated
- [ ] Interview notes archived in `/docs/01-user-interviews`

## Phase 2: Accounts & Project Init

**Checklist:**

- [x] Cloudflare account created
- [x] Wrangler CLI installed and authenticated
- [x] D1 database created and bound (`DB`)
- [x] R2 bucket created and bound (`R2`)
- [x] R2 lifecycle rules configured
- [x] Vectorize index created (768 dimensions, cosine metric, `VECTORIZE`)
- [x] Workers AI binding configured (`AI`)
- [x] Durable Object class declared (`docketTenant`)
- [x] `nodejs_compat` compatibility flag set
- [x] `ENCRYPTION_KEY` secret stored (`wrangler secret put`)
- [x] Clio developer application created
- [x] Clio credentials stored in Wrangler secrets (`CLIO_CLIENT_ID`, `CLIO_CLIENT_SECRET`)
- [x] M365 Agents Playground installed
- [x] All verification tests pass locally
- [x] Demo artifact deployed and shareable

**Files Created/Modified:**

- `src/index.ts`
- `wrangler.jsonc`
- `worker-configuration.d.ts`
- `vitest.config.mts`
- `tsconfig.json`
- `package.json`
- `test/env.d.ts`
- `test/tsconfig.json`
- `test/index.spec.ts`

## Phase 3: Storage Layer

**Checklist:**

- [x] All migration files created
- [x] Migrations applied locally (`--local`)
- [x] Auth tables exist (`user`, `session`, `account`, `verification`)
- [x] Cross-tenant tables exist (`org`, `workspace_bindings`, `channel_user_links`, `api_keys`, `invitations`)
- [x] Subscription tables exist (`subscriptions`, `tier_limits`, `role_permissions`, `org_members`)
- [x] KB table exists (`kb_chunks`)
- [x] Org Context table exists (`org_context_chunks`)
- [x] Tier limits seeded (4 tiers)
- [x] Role permissions seeded (24 rows: 3 roles × 8 permissions)
- [x] Vectorize metadata index created for `org_id`
- [x] R2 path helpers implemented (`/orgs/{org_id}/docs/`, `/orgs/{org_id}/audit/`, `/orgs/{org_id}/conversations/`)
- [x] Unit tests passing
- [x] Integration tests passing (requires `--remote` for Vectorize)
- [x] Migrations applied to production (`--remote`)
- [x] Demo endpoint returns all checks passing

**Files Created/Modified:**

- `migrations/0000_init-auth.sql`
- `migrations/0001_create_org_tables.sql`
- `migrations/0002_create_subscription_tables.sql`
- `migrations/0003_create_kb_tables.sql`
- `migrations/0004_add_updated_at_triggers.sql`
- `src/lib/auth.ts`
- `src/storage/r2-paths.ts`
- `src/index.ts`
- `test/migrations.ts`
- `test/storage.spec.ts`

## Phase 4: Auth Foundation

**Checklist:**

- [x] Drizzle adapter configured for D1
- [x] Better Auth factory function working (runtime init pattern)
- [x] Email/password auth tested (PBKDF2 hashing, constant-time verify)
- [x] Google SSO credentials stored
- [x] Apple SSO credentials stored (with JWT rotation plan)
- [x] Channel linking service implemented (`channel_user_links` table + CRUD)
- [x] Invitation processing on signup (check `invitations` table, link to org)
- [x] Per-user key derivation (PBKDF2-SHA256 with `user_id` as salt)
- [x] Key rotation via fallback (try current key, then `ENCRYPTION_KEY_OLD`)
- [x] User leaves org flow (D1 cleanup; full flow needs Phase 6 for DO/confirmations)
- [x] Org deletion flow (D1 + R2 cleanup; full flow needs Phase 6 for DO)
- [x] GDPR deletion flow (D1 cleanup, audit log anonymization with `REDACTED-{hash}`)
- [x] Unit tests passing
- [x] Integration tests passing
- [x] Demo page deployed

**Note:** Channel-specific linking (Teams SSO, Slack magic link) deferred to their respective adapter phases. Clio OAuth deferred to Phase 8.

**Files Created/Modified:**

- `src/lib/auth.ts`
- `src/lib/encryption.ts`
- `src/services/channel-linking.ts`
- `src/services/invitations.ts`
- `src/services/gdpr.ts`
- `src/services/org-membership.ts`
- `src/services/org-deletion.ts`
- `src/index.ts`
- `test/auth.spec.ts`
- `test/channel-linking.spec.ts`
- `test/encryption.spec.ts`
- `test/invitations.spec.ts`
- `test/gdpr.spec.ts`
- `test/org-membership.spec.ts`
- `test/org-deletion.spec.ts`

## Phase 5: Knowledge Base

**Checklist:**

- [x] KB folder structure created (`/kb/federal/`, `/kb/jurisdictions/`, `/kb/practice-types/`, `/kb/firm-sizes/`)
- [x] Placeholder KB markdown files created
- [x] Build-time KB function implemented (full rebuild on deploy)
- [x] KB clearing: delete all `kb_chunks` rows
- [x] KB clearing: delete all non-org embeddings from Vectorize
- [x] Metadata extraction from folder path (jurisdiction, practice_type, firm_size)
- [x] Markdown parsing respects section boundaries
- [x] Chunk size ~500 characters
- [x] Embeddings via Workers AI (`@cf/baai/bge-base-en-v1.5`)
- [x] Insert to D1 (`kb_chunks`) and Vectorize with `{ category, jurisdiction, practice_type, firm_size }` metadata
- [x] Org Context upload validation (MIME + extension: PDF/DOCX/MD, 25MB limit, filename sanitization)
- [x] Raw file storage in R2 (`/orgs/{org_id}/docs/{file_id}`)
- [x] Text parsing (pdf-parse for PDF, mammoth for DOCX, direct for MD)
- [x] Org Context chunks stored in D1 (`org_context_chunks`)
- [x] Org Context embeddings upserted to Vectorize with `{ org_id, jurisdiction, practice_type, firm_size }` metadata (inherited from org settings)
- [x] Delete/update flow (delete from D1, Vectorize, R2; updates = delete + re-upload)
- [x] RAG retrieval: two parallel Vectorize queries (KB filtered by jurisdiction/practice_type/firm_size, Org Context filtered by org_id, topK: 5)
- [x] Token budget enforcement (3000 tokens for RAG context)
- [x] Graceful degradation on RAG failure (return empty context, log error)
- [x] Unit tests passing
- [x] Integration tests passing
- [x] Demo endpoint deployed

**Note:** Shared KB content (Clio workflows, deadline calculations, billing guidance) requires legal expert review. Use placeholder content if unavailable.

## Phase 6: Core Worker + Durable Object

**Checklist:**

- [x] DO bindings configured in `wrangler.jsonc`
- [ ] One DO per organization (DO ID = org identity)
- [ ] DO derives `orgId` from DO ID, rejects mismatched `ChannelMessage.orgId`
- [ ] Constructor uses `blockConcurrencyWhile()` for migrations + schema loading
- [ ] `PRAGMA user_version` for DO SQLite migration tracking
- [ ] DO SQLite tables (conversations, messages, pending_confirmations, org_settings, clio_schema_cache)
- [ ] `ChannelMessage` interface (channel, orgId, userId, userRole, conversationId, conversationScope, message, jurisdiction, practiceType, firmSize, metadata)
- [ ] `POST /process-message` endpoint
- [ ] Channel Adapter routing (unified format)
- [ ] ChannelMessage validation
- [ ] Workspace binding validation (D1 lookup)
- [ ] Conversation isolation per `conversationId`
- [ ] Permission enforcement in DO (role check before LLM, log unauthorized attempts)
- [ ] Error responses ("I'm having trouble connecting", Clio-specific errors)
- [ ] Audit logging to R2 (CUD operations, Org Context changes, role changes, Clio OAuth events)
- [ ] User leaves org: expire `pending_confirmations`, delete Clio token from DO Storage
- [ ] Org deletion: delete DO instance (SQLite + Storage)
- [ ] GDPR: DO purges user's conversations/messages
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo endpoint deployed

## Phase 7: Workers AI + RAG

**Checklist:**

- [ ] Workers AI binding configured
- [ ] LLM inference (`@cf/meta/llama-3.1-8b-instruct`)
- [ ] Embedding generation (`@cf/baai/bge-base-en-v1.5`, 768 dimensions)
- [ ] RAG retrieval (parallel Vectorize queries for KB + Org Context)
- [ ] System prompt construction (KB context, Org Context, Clio Schema, last 15 messages)
- [ ] Context window management (~10K tokens of 128K)
- [ ] Single `clioQuery` tool (structured params, DO builds validated Clio calls)
- [ ] CUD confirmation flow (pending_confirmations, 5-min expiry)
- [ ] Confirmation classification (approve/reject/modify/unrelated)
- [ ] Error code handling (3040, 3043 → retry once; 3036 → fail; 5007 → log)
- [ ] Graceful degradation (RAG failure → empty context, continue)
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo endpoint deployed

## Phase 8: Clio Integration

**Checklist:**

- [ ] Clio OAuth flow (PKCE S256, state signed with HMAC-SHA256, 10-min expiry)
- [ ] Token storage in DO Storage (AES-GCM encrypted, per-user key derivation)
- [ ] Token structure (`access_token`, `refresh_token`, `expires_at`)
- [ ] Access tokens expire after 7 days; refresh tokens don't expire
- [ ] Proactive token refresh (5-min expiry window)
- [ ] Reactive token refresh (401 → refresh → retry or mark `clio_connected=false`)
- [ ] Initial schema provisioning (`POST /provision-schema` on first Clio connect)
- [ ] Schema caching in DO SQLite (core + read-only objects)
- [ ] Schema endpoints: `GET /api/v4/{object}.json?fields=schema`
- [ ] Admin schema refresh button (logs to audit)
- [ ] Developer migration refresh flag
- [ ] `clioQuery` tool with structured params
- [ ] Read operations execute automatically (Member + Admin)
- [ ] CUD operations require Admin role + user confirmation
- [ ] Clio error handling (400, 401, 403, 404, 410, 422, 429, 500+)
- [ ] Rate limit awareness (50 req/min per access token)
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo endpoint deployed

## Phase 9: Website MVP

**Checklist:**

- [ ] Auth UI (Better Auth signup/login, Google/Apple SSO)
- [ ] Invitation signup flow (check `invitations` table, link to org)
- [ ] Org creation flow (type, practice areas, location, name, logo)
- [ ] Creator becomes Owner (`is_owner: true`)
- [ ] Org settings dashboard
- [ ] Member invitation UI (email + role)
- [ ] Ownership transfer (select Admin, password re-entry)
- [ ] Clio connect flow (OAuth redirect)
- [ ] Clio schema refresh button (Admin only)
- [ ] Org Context upload UI (MIME validation, 25MB limit, filename sanitization)
- [ ] Org Context management (list, delete)
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo deployed

**Note:** Required before Teams adapter (OAuth redirects, signup, Org Context upload).

## Phase 10: Teams Adapter

**Checklist:**

- [ ] M365 Business Basic tenant ($6/mo)
- [ ] Custom app upload enabled in Teams admin
- [ ] Azure Bot resource created (F0 free tier)
- [ ] Teams credentials stored in Wrangler secrets
- [ ] Scaffold: `teams new typescript docket-teams --atk embed`
- [ ] Bot Framework integration (`@microsoft/teams-ai` v2)
- [ ] Extract `user.aadObjectId` from activity
- [ ] D1 lookup: `aadObjectId` → `user_id` → `org_id` + `role`
- [ ] Teams linking flow (OAuthCard → Azure AD SSO → email match → `channel_user_links`)
- [ ] "No account found" response for unmatched emails
- [ ] Validate workspace linked to user's org for groupChat/teams
- [ ] Conversation isolation per `conversation.id`
- [ ] @mention handling (personal receives all; groupChat/teams require @mention)
- [ ] Manifest with scopes (personal, groupChat, team)
- [ ] E2E testing in real Teams
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo deployed

**Note:** Start finding business partners during this phase.

## Phase 11: Production Hardening

**Checklist:**

- [ ] Rate limiting (50 req/min per user IP via Cloudflare dashboard)
- [ ] Audit log retrieval endpoint (list R2 by date prefix)
- [ ] Multi-year audit log retention
- [ ] Encryption verification (Clio tokens, at-rest)
- [ ] DO Alarms: archive >30d conversations to R2
- [ ] DO Alarms: clean expired confirmations
- [ ] DO Alarms: clean old Slack events (>30 days)
- [ ] Data residency: US-EAST only
- [ ] Error monitoring and alerting
- [ ] Load testing for 10,000 users
- [ ] Demo deployed

## Phase 12: Compliance Review

**Checklist:**

- [ ] Legal counsel review (professional responsibility)
- [ ] Security audit (SOC 2)
- [ ] DPA with Cloudflare
- [ ] Disaster recovery procedures documented
- [ ] Data retention policy documented
- [ ] Breach notification procedure documented
- [ ] Data portability mechanism (GDPR Article 20)
- [ ] Consent tracking mechanism

## Phase 13: Teams App Store

**Checklist:**

- [ ] Microsoft Teams Partner Center account
- [ ] Live SaaS offer on AppSource with pricing
- [ ] Manifest `subscriptionOffer` in publisherId.offerId format
- [ ] Valid app package (zip with manifest + icons)
- [ ] App submission approved

## Phase 14: MCP Channel

**Checklist:**

- [ ] MCP server with stdio transport (JSON-RPC)
- [ ] API key validation → `user_id` + `org_id` + `role` lookup in D1
- [ ] Route to org's DO with validated context
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo deployed

---

## Version 2 Candidates

Features considered but deferred:

- Slack Adapter:
  - Magic link auth (expiry, single-use, rate limiting, brute-force protection)
  - Slack Events API integration
  - Signature verification via Web Crypto API
  - Event deduplication (track `event_id` in DO SQLite)
  - Async acknowledgment (return 200 immediately, process via `waitUntil()`)
  - Challenge verification for initial app configuration
- ChatGPT Adapter (OAuth auth, user_id/org_id lookup)
