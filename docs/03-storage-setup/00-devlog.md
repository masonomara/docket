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

### 2.1 COnfigured Apple Sign-In

Followed https://www.better-auth.com/docs/authentication/apple

- Registered domain `docketadmin.com`
- Created Service ID in Apple Developer Portal
- Generated client secret JWT from private key
- Added to `.dev.vars`: `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET`, `APPLE_KEY_ID`, `APPLE_TEAM_ID`
- Added `APPLE_APP_BUNDLE_IDENTIFIER` to `wrangler.jsonc` vars

### 2.2 Configured Google Sign-In

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
