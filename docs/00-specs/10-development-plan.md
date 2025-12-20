# Docket Development Plan

Each phase needs to have simple unit, integration (if applicable), and end-to-end testing, as well as a verbose component/example that demonstrates what was accomplished in each phase for shareholder demonstration.

## Phase 1: Validate Plan

Find 3-4 people to interview.

## Phase 2: Accounts & Project Init

**Checklist:**

- [x] Cloudflare account created
- [x] Wrangler CLI installed and authenticated
- [x] D1 database created and bound
- [x] R2 bucket created and bound
- [x] Vectorize index created (768 dimensions, cosine metric)
- [x] Workers AI binding configured
- [x] Durable Object class declared
- [x] All verification tests pass locally
- [x] Clio developer application created
- [x] Clio credentials stored in Wrangler secrets
- [x] M365 Agents Playground installed
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

- [x] All 4 migration files created
- [x] Migrations applied locally (`--local`)
- [x] All 14+ tables exist in D1
- [x] Tier limits seeded (4 tiers)
- [x] Role permissions seeded (24 rows: 3 roles × 8 permissions)
- [x] Vectorize metadata index created for `org_id`
- [x] R2 path helpers implemented
- [x] Unit tests passing
- [x] Integration tests passing (requires `--remote` for Vectorize)
- [x] Demo endpoint returns all checks passing
- [x] Migrations applied to production (`--remote`)

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

- [x] Better Auth factory function working
- [x] Email/password auth tested
- [x] Google SSO credentials stored
- [x] Apple SSO credentials stored (with JWT rotation plan)
- [x] Channel linking service implemented
- [x] Invitation processing on signup
- [x] Key rotation mechanism documented
- [x] GDPR deletion flow implemented
- [x] Unit tests passing
- [x] Integration tests passing
- [x] Demo page deployed

## Phase 5: Knowledge Base

Create knowledge base:

- **BLOCKER:** Needs legal expert for actual knowledge base
- If can't get a legal expert, create fake knowledge base
- KB content: Clio workflows, deadline calculations, billing guidance, practice management.
- Buildtime script to:
  - Clear old kb_chunks, kb_formulas, kb_benchmarks
  - Read markdown from `/kb` directory
  - Chunk at ~500 chars
  - Generate embeddings via Workers AI
  - Insert to D1 + Vectorize

## Phase 6: Core Worker + Durable Object

Set up Cloudflare Worker and Durable Object:

- Set up bindings in `wrangler.jsonc`
- DO SQLite tables
- Channel Adapter routing (unified `ChannelMessage` format)
- ChannelMessage validation
- Workspace binding validation
- Permission enforcement in DO (not adapter)

## Phase 7: Workers AI + RAG

Set up Cloudflare Workers AI:

- Workers AI binding
- LLM inference
- Embedding model: `@cf/baai/bge-base-en-v1.5` (768 dimensions)
- RAG retrieval (parallel Vectorize queries for KB + Org Context)
- CUD confirmation expiry (5 min)

## Phase 8: Clio Integration

Set up Clio integration:

- Clio OAuth flow (PKCE, state signing)
- Token storage in DO Storage (AES-GCM encrypted)
- Schema caching in DO SQLite
- Schema refresh triggers
- `clioQuery` tool with structured params

## Phase 9: Website MVP

Create website MCP. Required before Teams (OAuth redirects, signup, Org Context upload):

- Auth UI (Better Auth)
- Org creation, member invitations
- Clio connect flow
- Org Context upload (R2 + chunking + Vectorize)
- Upload validation (MIME, 25MB, sanitize)
- Org Context delete/update flow

## Phase 10: Teams Adapter

Create Teams adapter and acquire real tenant for E2E testing:

- [ ] M365 Business Basic tenant ($6/mo)
- [ ] Custom app upload enabled in Teams admin
- [ ] Azure Bot resource created
- [ ] Teams credentials stored in Wrangler secrets

- Azure Bot registration (F0 free tier)
- Enable sideloading in Teams admin center
- Scaffold: `teams new typescript docket-teams --atk embed`
- Bot Framework integration
- Manifest with scopes (personal, groupChat, team)
- E2E testing in real Teams
- **Start finding business partners**

## Phase 11: Production Hardening

Prepare for first 10,000 users:

- Rate limiting (50 req/min per user IP via Cloudflare dashboard)
- Audit log retrieval endpoint (list R2 by date prefix)
- Encryption verification (Clio tokens, at-rest)
- DO Alarms: archive >30d conversations, clean expired confirmations

## Phase 12: Compliance Review

Legal compliance before production:

- Legal counsel review (professional responsibility)
- Security audit (SOC 2)
- DPA with Cloudflare
- Disaster recovery procedures
- Data retention policy
- Breach notification procedure

## Phase 13: Teams App Store

List App in Teams App Store:

- AppSource listing with pricing
- Manifest `subscriptionOffer` in publisherId.offerId format
- Microsoft Teams Partner Center account

## Phase 14: MCP Channel

MCP server with stdio transport:

- API key auth via D1

---

## Version 2 Candidates

Features with technical breadth considered in Version 1:

- Industry Knowledge Bases — Criminal Defense, Immigration, etc. filtered by metafilter
- Location Knowledge Bases — Federal, State, etc. filtered by metafilter
- Slack Messaging
- ChatGPT Messaging
