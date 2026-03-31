# Docket Development Plan

Each phase needs to have simple unit, integration (if applicable), and end-to-end testing, as well as a verbose component/example that demonstrates what was accomplished in each phase for shareholder demonstration.

**Overall Progress:** Phases 2-9 complete. Phase 9b (web chat interface) in progress.

## Phase 1: Validate Plan

**Completion:** 20% (interviews deferred)

**Checklist:**

- [x] Interview questions prepared
- [ ] 3-4 legal professionals interviewed
- [ ] Pain points documented
- [ ] Feature priorities validated
- [ ] Interview notes archived in `/docs/01-user-interviews`

## Phase 2: Accounts & Project Init

**Completion:** 100%

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

**Completion:** 100%

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

**Completion:** 100%

**Skipped Tests:** SSO Providers (2 tests) — requires external OAuth setup

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

**Completion:** 100%

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

**Completion:** 100%

**Skipped Tests:** TenantDO (19 tests), Message Flow E2E (7 tests) — DO SQLite blocked by vitest-pool-workers SQLITE_AUTH limitation

**Checklist:**

- [x] DO bindings configured in `wrangler.jsonc`
- [x] One DO per organization (DO ID = org identity)
- [x] DO derives `orgId` from DO ID, rejects mismatched `ChannelMessage.orgId`
- [x] Constructor uses `blockConcurrencyWhile()` for migrations + schema loading
- [x] `PRAGMA user_version` for DO SQLite migration tracking
- [x] DO SQLite tables (conversations, messages, pending_confirmations, org_settings, clio_schema_cache)
- [x] `ChannelMessage` interface (channel, orgId, userId, userRole, conversationId, conversationScope, message, jurisdictions[], practiceTypes[], firmSize, metadata)
- [x] `POST /process-message` endpoint
- [x] Channel Adapter routing (unified format)
- [x] ChannelMessage validation
- [x] Workspace binding validation (D1 lookup)
- [x] Conversation isolation per `conversationId`
- [x] Permission enforcement in DO (role check before LLM, log unauthorized attempts)
- [x] Generic error responses ("I'm having trouble processing your request")
- [x] Audit logging to R2 (CUD operations, Org Context changes, role changes, Clio OAuth events)
- [x] User leaves org: `POST /remove-user` expires `pending_confirmations` in DO
- [x] Org deletion: Worker calls `POST /delete-org` on DO to clear SQLite + KV storage
- [x] GDPR: `POST /purge-user-data` purges user's conversations/messages from DO
- [x] Unit tests passing (TenantDO tests written but skipped - DO SQLite blocked by vitest-pool-workers SQLITE_AUTH)
- [x] Integration tests passing
- [x] Demo endpoint (skipped - not blocking)

**Phase 8 Dependencies (deferred):**

- [ ] Clio-specific error responses (401 expired, 429 rate limit, connection errors)
- [ ] User leaves org: delete Clio token from DO KV Storage

**Note:** Clio token storage doesn't exist until Phase 8. Generic error handling covers LLM/RAG failures; Clio-specific errors require Phase 8's OAuth and API integration.

## Phase 7: Workers AI + RAG

**Completion:** 100%

**Skipped Tests:** RAG Integration (11 tests) — requires INTEGRATION_TESTS_ENABLED flag for live Vectorize/AI calls

**Checklist:**

- [x] Workers AI binding configured
- [x] LLM inference (`@cf/meta/llama-3.1-8b-instruct`)
- [x] Embedding generation (`@cf/baai/bge-base-en-v1.5`, 768 dimensions)
- [x] RAG retrieval (parallel Vectorize queries for KB + Org Context)
- [x] System prompt construction (KB context, Org Context, Clio Schema, last 15 messages)
- [x] Context window management (~10K tokens of 128K)
- [x] Single `clioQuery` tool (structured params, DO builds validated Clio calls)
- [x] CUD confirmation flow (pending_confirmations, 5-min expiry)
- [x] Confirmation classification (approve/reject/modify/unrelated)
- [x] Error code handling (3040, 3043 → retry once; 3036 → fail; 5007 → log)
- [x] Graceful degradation (RAG failure → empty context, continue)
- [x] Unit tests passing
- [x] Integration tests passing (RAG integration; DO SQLite tests blocked by vitest-pool-workers)
- [x] Demo endpoint deployed

## Phase 8: Clio Integration

**Completion:** 100%

**Checklist:**

- [x] Clio OAuth flow (PKCE S256, state signed with HMAC-SHA256, 10-min expiry)
- [x] Token storage in DO Storage (AES-GCM encrypted, per-user key derivation)
- [x] Token structure (`access_token`, `refresh_token`, `expires_at`)
- [x] Access tokens expire after 7 days; refresh tokens don't expire
- [x] Proactive token refresh (5-min expiry window)
- [x] Reactive token refresh (401 → refresh → retry or mark `clio_connected=false`)
- [x] Initial schema provisioning (`POST /provision-schema` on first Clio connect)
- [x] Schema caching in DO SQLite (core + read-only objects)
- [x] Schema endpoints: `GET /api/v4/{object}.json?fields=schema`
- [x] Admin schema refresh button (logs to audit)
- [x] Developer migration refresh flag
- [x] `clioQuery` tool with structured params
- [x] Read operations execute automatically (Member + Admin)
- [x] CUD operations require Admin role + user confirmation
- [x] Clio error handling (400, 401, 403, 404, 410, 422, 429, 500+)
- [x] Rate limit awareness (429 retry with backoff)
- [x] Unit tests passing
- [x] Integration tests passing
- [x] Demo endpoint deployed

## Phase 9: Website MVP

**Checklist:**

- [x] Web app wrangler config (determine origin: same-domain vs subdomain vs Pages URL)
- [x] CORS policy matching web app origin + Better Auth `trustedOrigins`
- [x] Auth UI (Better Auth signup/login, Google SSO, maybe Apple SSO (oauth concern w/ Apple ID))
- [x] Email service (Resend: invitations, password reset, email verification)
- [x] Email verification flow (post-signup pending screen, verification callback, resend button)
- [x] Forgot password flow (request form, reset form with token)
- [x] Logout functionality
- [x] Invitation signup flow (check `invitations` table, link to org)
- [x] Org creation flow (type, practice areas, location, name, logo)
- [x] Creator becomes Owner (`is_owner: true`)
- [x] Org settings dashboard
- [x] Member invitation UI (email + role)
- [x] Ownership transfer (select Admin, password re-entry)
- [x] Clio connect flow (OAuth redirect)
- [x] Clio schema refresh button (Admin only)
- [x] Org Context upload UI (MIME validation, 25MB limit, filename sanitization)
- [x] Org Context management (list, delete)
- [x] Audit log PII redaction (sanitize `params` field before logging)
- [x] Unit tests passing
- [x] Integration tests passing
- [x] MVP deployed

**Note:** Required before Teams adapter (OAuth redirects, signup, Org Context upload).

## Phase 9b: Web Chat Interface

**Note:** Read and refer to `docs/00-specs/12-web-chat-interface.md`

**Checklist:**

API (`apps/api`):

- [x] Create `src/handlers/chat.ts`:
  - `handleChatMessage` — SSE streaming
  - `handleGetConversations` — List user's conversations
  - `handleGetConversation` — Get conversation with messages
  - `handleDeleteConversation` — Delete conversation
- [x] Update `src/do/tenant.ts`:
  - `GET /conversations` — List by updatedAt desc, limit 50
  - `GET /conversation/:id` — Conversation + messages
  - `DELETE /conversation/:id`
  - Modify `handleProcessMessage` to yield SSE events
  - Add step events: `rag_lookup`, `llm_thinking`, `clio_call`, `clio_result`
  - `handleAcceptConfirmation`
  - `handleRejectConfirmation`
- [x] Update `src/index.ts`:
  - Routes: `POST /api/chat`, `GET /api/conversations`, `GET /api/conversations/:id`, `DELETE /api/conversations/:id`
  - Routes: `POST /api/confirmations/:id/accept`, `POST /api/confirmations/:id/reject`
  - Use `withMember` middleware
- [x] Add `conversationScope: "personal"` for web channel messages

Web (`apps/web`):

- [x] `app/routes/chat.tsx` — Main interface
- [x] `app/routes/chat.$conversationId.tsx` — Conversation view
- [x] `app/routes/dashboard.tsx` — Redirect to `/chat` if user has org
- [x] `app/components/ChatSidebar.tsx` — Conversation list (inline in chat.tsx)
- [x] `app/components/ChatMessages.tsx` — Message display (inline in chat.$conversationId.tsx)
- [x] `app/components/ChatInput.tsx` — Input with submit (inline in chat.$conversationId.tsx)
- [x] `app/components/ProcessLog.tsx` — Step visibility (inline in chat.$conversationId.tsx)
- [x] `app/lib/use-chat.ts` — SSE hook and state

Testing:

- [x] Unit: `handleChatMessage` SSE format
- [x] Unit: Conversation CRUD
- [x] Integration: Full message flow with mocked AI
- [x] Manual: Multi-tab behavior

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
- [ ] UPL mitigation: output filtering for legal advice patterns
- [ ] UPL mitigation: prepend disclaimer to all responses
- [ ] Demo deployed
- [ ] Research an dintegratte Third-Party Observability Options for LLM

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
- [ ] Attorney-client privilege: `is_privileged` flag on conversations
- [ ] Attorney-client privilege: exclude privileged messages from RAG context
- [ ] Attorney-client privilege: privilege log export for litigation
- [ ] Conflict of interest: prevent multi-org membership OR matter tracking with party names

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
