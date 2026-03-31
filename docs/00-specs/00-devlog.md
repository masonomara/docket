# Account Setup Devlog

Devlog of account setup actions. Granular details deferred to other docs.

## Overview

Got three accounts setup: Cloudflare, Clio, and Teams. Cloudflare was straightforward—Worker, DO, D1, R2, Vectorize, and AI were all configured, bound to the worker, accessible from local and remote servers, and tests were created for them. Clio was also easy and the auth endpoint is working. Costs ~$50/month to keep a Clio developer account. Teams was more confusing. We initially planned on using developer accounts but that wasn't financially feasible. We pivoted to using Agents Playground for initial setup and validation, deferring a real Teams tenant to Phase 10 for end-to-end testing. The Agents Playground runs locally, connects to our Worker, and simulates a Teams chatbot—covering all development needs.

## Step 1: Cloudflare Setup

### 1.1 Created Worker Project

Followed all steps in <https://developers.cloudflare.com/workers/get-started/guide/> Step 1. Create a Worker project:

```bash
npm create cloudflare@latest -- durable-object-starter
```

### 1.2 Installed Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 1.3 Created D1 Database

```bash
npx wrangler d1 create docket-db
# database_id: ed591ebb-f0b5-4cf4-b0e9-c95e049af3ab
```

```jsonc
"d1_databases": [
  {
    "binding": "docket_db",
    "database_name": "docket-db",
    "database_id": "ed591ebb-f0b5-4cf4-b0e9-c95e049af3ab"
  }
]
```

**Local vs Remote:** Use `wrangler dev` (local) by default. Use `--remote` only for production debugging.

### 1.4 Created R2 Bucket

```bash
npx wrangler r2 bucket create docket-storage
```

```jsonc
"r2_buckets": [
  {
    "bucket_name": "docket-storage",
    "binding": "docket_storage"
  }
]
```

### 1.5 Created Vectorize Index

```bash
npx wrangler vectorize create docket-vectors --dimensions=768 --metric=cosine
```

```jsonc
"vectorize": [
  {
    "binding": "VECTORIZE",
    "index_name": "docket-vectors"
  }
]
```

### 1.6 Added Workers AI

```jsonc
"ai": {
  "binding": "AI"
}
```

### 1.7 Configured Durable Objects

```jsonc
"durable_objects": {
  "bindings": [
    {
      "name": "TENANT",
      "class_name": "TenantDO"
    }
  ]
},
"migrations": [
  {
    "tag": "v1",
    "new_sqlite_classes": ["TenantDO"]
  }
]
```

### 1.8 Enabled Observability

```jsonc
"observability": {
  "enabled": true
}
```

## Step 2: Clio Setup

### 2.1 Created Developer App

You need a paid Clio account to create applications. EasyStart tier doesn't support developer features.

<https://developers.clio.com/> → New App

```text
Name: Docket
URL: https://docketadmin.com
Redirect URI: http://127.0.0.1:8787/callback
Permissions: Everything except Clio Payments
```

### 2.2 Stored Production Secrets

```bash
npx wrangler secret put CLIO_CLIENT_ID
npx wrangler secret put CLIO_CLIENT_SECRET
npx wrangler secret put CLIO_APP_ID
```

### 2.3 Created Local Environment

Created `.dev.vars` (gitignored):

```env
CLIO_APP_ID=app_id
CLIO_CLIENT_ID=client_id
CLIO_CLIENT_SECRET=client_secret
```

### 2.4 OAuth Flow Reference

```text
1. User clicks "Connect Clio"
2. Redirect to: https://app.clio.com/oauth/authorize?
     response_type=code&client_id=...&redirect_uri=...&state=...
3. User approves access
4. Clio redirects to callback with auth code
5. Exchange code for tokens via POST https://app.clio.com/oauth/token
6. Receive access_token, refresh_token (expires in 7 days)
```

## Step 3: Microsoft Teams Setup

Two environments for bot testing: M365 Agents Playground (free, no tenant) and Business Basic Tenant (deferred to Phase 10).

See `docs/02-account-setup/01-teams-development-workflow.md` for environment details.

### 3.1 Installed M365 Agents Playground

Bash installation:

```bash
npm install -g @microsoft/m365agentsplayground
```

### 3.2 Deferred: Business Basic Tenant

Full E2E testing with real Teams tenant deferred to Phase 10. Can purchase earlier if needed.

## Step 4: Verification Tests

### 4.1 Set Up Cloudflare Environment Tests

In `src/index.ts` and `test/index.spec.ts` I set up tests for interacting with DOs, D1, R2, and Vectorize + AI. All tests ran locally (except Vectorize + AI which don't work locally), remotely, and from the deployed Cloudflare Worker.

### 4.2 Tested Clio OAuth

Authorization code received. OAuth flow working:

1. Opened: `https://app.clio.com/oauth/authorize?response_type=code&client_id=CLIO_CLIENT_ID&redirect_uri=http://127.0.0.1:8787/callback&state=test123`
2. Approved permissions on Clio "Approve/Deny Permissions" screen
3. Redirected to: `http://127.0.0.1:8787/callback?code=HEKQCpWAjKE5UtHfbZL8&state=test123`

### 4.3 Tested Agents Playground

Bot message handling working via M365 Agents Playground. Bot Framework requires POSTing replies back to `serviceUrl`, not returning them in the response body.

1. Added `/api/messages` endpoint to worker (Bot Framework Activity protocol)
2. Launched: `npx @microsoft/m365agentsplayground -e "http://127.0.0.1:8787/api/messages" -c "emulator"`
3. Sent messages in playground UI, bot replies appear correctly

# Storage Setup Devlog

Devlog of storage setup actions. Granular details deferred to other docs.

## Step 1: Better Auth Setup

### 1.1 Installed the Better Auth Package

Followed https://www.better-auth.com/docs/installation

Known dependency conflict between vitest and better-auth@1.4.7. Workaround:

```bash
npm install better-auth --legacy-peer-deps
```

### 1.2 Set Environment Variables

- `BETTER_AUTH_SECRET` — generated with `openssl rand -base64 32`, added to `.dev.vars` and Cloudflare secrets
- `BETTER_AUTH_URL` — set to `https://docketadmin.com` in `wrangler.jsonc` vars

### 1.3 Developed Auth Instance

Created `src/lib/auth.ts` with factory pattern `getAuth(env)` for Cloudflare Workers environment bindings.

### 1.4 Created Database Schema & Migration

1. Ran `npx @better-auth/cli generate` to scaffold schema
2. Created `src/db/auth-schema.ts` with Drizzle ORM tables (user, session, account, verification)
3. Installed `drizzle-kit`, created `drizzle.config.ts`
4. Generated SQL migration: `migrations/0000_init-auth.sql`
5. Applied to D1: `wrangler d1 execute docket-db --remote --file=./migrations/0000_init-auth.sql`

### 1.5 Set up Route Handler

Mounted Better Auth handler at `/api/auth/*` in `src/index.ts` using Cloudflare Workers pattern.

## Step 2: OAuth Provider Pre-Config

### 2.1 Configured Google Sign-In

Followed https://www.better-auth.com/docs/authentication/google

- Created OAuth 2.0 credentials in Google Cloud Console
- Added to `.dev.vars`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Step 3: Completed Remaining D1 Migrations

### 3.1 Created Organization Tables Migration

Created `migrations/0001_create_org_tables.sql` with `org`, `workspace_bindings`, `channel_user_links`, `invitations`, `api_keys`.

### 3.2 Created Subscription Tables Migration

Created `migrations/0002_create_subscription_tables.sql` with `org_members`, `subscriptions`, `tier_limits`, `role_permissions`.

### 3.3 Created Knowledge Base Tables Migration

Created `migrations/0003_create_kb_tables.sql` with `kb_chunks`, `org_context_chunks`.

### 3.4 Applied Migrations

```bash
npx wrangler d1 execute docket-db --remote --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init-auth.sql', datetime('now'))"
npx wrangler d1 migrations apply docket-db --remote
npx wrangler d1 execute docket-db --local --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init-auth.sql', datetime('now'))"
npx wrangler d1 migrations apply docket-db --local
```

Result: 17 application tables + `d1_migrations` tracking table.

## Step 4: Applied Metadata Filter

### 4.1 Set up filters by org_id

```bash
npx wrangler vectorize create-metadata-index docket-vectors --property-name=org_id --type=string
```

## Step 5: R2 Path Helpers

### 5.1 Created Path Utilities

Created `src/storage/r2-paths.ts` with:

- `R2Paths` object for consistent path generation (docs, audit log prefixes, archived conversations)

Audit logging moved to `TenantDO.appendAuditLog()` with one-object-per-entry pattern:

- Each audit entry stored as separate R2 object: `orgs/{org}/audit/YYYY/MM/DD/{timestamp}-{uuid}.json`
- No read-modify-write — eliminates race conditions
- List by date prefix for retrieval

## Step 6: Unit Tests

### 6.1 Created Storage Tests

Created `test/storage.spec.ts` and `test/migrations.ts` with tests for:

- D1 tables exist (17 tables)
- Role constraints enforced (CHECK constraints)
- Tier limits seeded (4 tiers)
- Role permissions seeded (24 entries)
- R2 path helpers generate correct paths
- R2 org isolation works

All 11 tests passing.

### 6.2 Added Integration Tests

Added Vectorize metadata filtering tests (skipped locally, require `--remote`):

- Embedding dimension verification (768)
- Vector storage with metadata
- Org context filtering by `org_id`
- KB content retrieval by type filter

Run integration tests with remote access: `npm test -- test/storage.spec.ts` (requires wrangler auth)

## Step 7: Interactive Demo Endpoint

### 7.1 Created `/demo/storage` Route

Interactive Phase 3 verification page with:

- **Overview tab**: Run all checks, view stats (tables, tiers, permissions, R2)
- **D1 Tables tab**: Browse all tables with row counts
- **Permissions tab**: View tier limits and role permissions matrices
- **R2 Storage tab**: Test write/read/list with custom org and file paths
- **Vectorize tab**: Embed text and query with org_id filtering

Auto-runs checks on load. All actions use query params for API calls.

## Step 8: Clio API Smoke Test

### 8.1 Test Endpoints (Removed)

Created temporary test endpoints to verify Clio CRUD operations:

- `POST /api/test/clio` - Test read/create/update/delete with structured params
- `POST /api/test/clio-raw` - Send raw endpoint/body to debug format issues

**Removed after testing completed.**

### 8.2 Fixed Request Body Format

Discovered Clio expects `{ data: { ...fields } }` not `{ data: { contact: { ...fields } } }`.

Updated `buildCreateBody` and `buildUpdateBody` in `clio-api.ts`. Added documentation to `09-clio-integration.md`.

### 8.3 CRUD Test Results

All operations passed:

- CREATE: Contact created successfully
- READ: Contact retrieved by ID
- UPDATE: Contact modified
- DELETE: Contact removed (204 No Content)
