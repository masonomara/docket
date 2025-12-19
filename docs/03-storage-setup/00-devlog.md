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

## Step 3: D1 Schema Migrations

### 3.1 Created Organization Tables Migration

Created `migrations/0001_create_org_tables.sql` with tables: `org`, `workspace_bindings`, `channel_user_links`, `invitations`, `api_keys`. Includes CHECK constraints for `channel_type` and `role`, foreign keys with cascade delete, and indexes on common query patterns.

### 3.2 Created Subscription Tables Migration

Created `migrations/0002_create_subscription_tables.sql` with tables: `org_members`, `subscriptions`, `tier_limits`, `role_permissions`. Seeded tier limits (free, starter, professional, enterprise) and role permissions (8 permissions × 3 roles = 24 entries).

### 3.3 Created Knowledge Base Tables Migration

Created `migrations/0003_create_kb_tables.sql` with tables: `kb_chunks`, `kb_formulas`, `kb_benchmarks`, `org_context_chunks`. KB tables are immutable (populated at build time), org context uses delete/recreate pattern for updates.

### 3.4 Applied Migrations

Auth tables existed from Step 1 but weren't tracked. Manually inserted migration record, then applied remaining migrations:

```bash
npx wrangler d1 execute docket-db --local --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_init-auth.sql', datetime('now'))"
npx wrangler d1 migrations apply docket-db --local
```

Result: 17 application tables + `d1_migrations` tracking table.