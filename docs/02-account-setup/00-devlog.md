# Account Setups

Devlog of account setup actions. Granular details deferred to other docs.

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
# database_id: afb86a9d-5697-401d-b55a-6079a7aa8779
```

```jsonc
"d1_databases": [
  {
    "binding": "docket_db",
    "database_name": "docket-db",
    "database_id": "afb86a9d-5697-401d-b55a-6079a7aa8779"
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

See `docs/02-dev-accounts/01-teams-development-workflow.md` for environment details.

### 3.1 Installed M365 Agents Playground

Bash installtion didnt seem to do anything:

```bash
npm install -g @microsoft/m365agentsplayground
```

So I went with dowloading the Microsoft 365 Agents Toolkit VSCode extension

### 3.2 Deferred: Business Basic Tenant

Full E2E testing with real Teams tenant deferred to Phase 10. Can purchase earlier if needed.

## Step 4: Verifciaton Tests

### 4.1 Set Up Cloudlfare Environment Tests

In `src/index.ts` and `test/index.spec.ts` I set up tests for interacting with DOs, the D1 database, the R2 database, and the Vecotrize + AI database. I was able to run all tests locally (except Vectorize + AI becuas ehtye odnt work locally), remotely, and then deployed and coudl runt he tests from my actual Cloudlfare Worker

### 4.2 Tested Clio OAuth

Authorization code received. OAuth flow working:

1. Opened: `https://app.clio.com/oauth/authorize?response_type=code&client_id=CLIO_CLIENT_ID&redirect_uri=http://127.0.0.1:8787/callback&state=test123`
2. Approved permissions on Clio "Approve/Deny Permissions" screen
3. Redirected to: `http://127.0.0.1:8787/callback?code=HEKQCpWAjKE5UtHfbZL8&state=test123`

### 4.3 Tested Agents Playground

Bot message handling working via M365 Agents Playground. Bot Framework requires POSTing replies back to `serviceUrl`, not returning them in the response body.:

1. Added `/api/messages` endpoint to worker (Bot Framework Activity protocol)
2. Launched: `npx @microsoft/m365agentsplayground -e "http://127.0.0.1:8787/api/messages" -c "emulator"`
3. Sent messages in playground UI, bot replies appear correctly
