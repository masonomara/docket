# Testing Guide

## CI Pipeline

Runs automatically on push/PR to `main` (`.github/workflows/ci.yml`):

| Job | What it does |
|-----|--------------|
| API Tests | `tsc --noEmit` + vitest (191 tests) |
| Web Tests | `tsc` + build |
| Lint | ESLint (if configured) |

## Test Coverage Overview

**Automated (191 tests):** D1 storage, R2 paths, auth flows, Clio OAuth/API mocking, channel linking, org membership, KB builder, GDPR, encryption, embeddings, workspace binding.

**Skipped (11 tests):** RAG integration tests requiring live Cloudflare AI/Vectorize bindings.

**Manual Required:** Durable Object SQLite operations (vitest-pool-workers SQLITE_AUTH limitation).

## Running Tests

```bash
# Unit + integration tests
cd apps/api && npm test

# E2E tests (requires running worker)
npm run dev        # Terminal 1
npm run test:e2e   # Terminal 2

# RAG integration (requires Cloudflare credentials)
CLOUDFLARE_ACCOUNT_ID=xxx npm test
```

## Manual DO Testing

The TenantDO class cannot be unit tested due to vitest-pool-workers limitations with DO SQLite. Test manually using the dev server:

### 1. Start Dev Server

```bash
cd apps/api && npm run dev
```

### 2. Test Conversation Storage

```bash
# Send Teams message
curl -X POST http://localhost:8787/api/messages \
  -H "Content-Type: application/json" \
  -d '{
    "type": "message",
    "text": "Test message",
    "from": {"aadObjectId": "test-user"},
    "conversation": {"id": "test-conv", "conversationType": "personal"},
    "serviceUrl": "https://test.botframework.com/"
  }'
```

### 3. Verify DO State

Check wrangler logs for:
- `TenantDO.handleMessage` execution
- Conversation creation/retrieval
- Settings persistence

### 4. Test Clio OAuth Flow

1. Navigate to `http://localhost:5173/settings/clio`
2. Initiate OAuth connection
3. Verify token storage in DO KV (check logs)
4. Test token refresh on API calls

## Post-Deploy Smoke Test

```bash
# Run against staging
./scripts/smoke-test.sh staging

# Run against production
./scripts/smoke-test.sh production

# Run locally
./scripts/smoke-test.sh local
```

Verifies: API routes, Teams endpoint, Clio callback, web app availability.

## Pre-Deployment Checklist

Before deploying to production:

- [ ] All 191 automated tests pass
- [ ] E2E demo flow completes without errors
- [ ] Manual DO conversation test works
- [ ] Clio OAuth flow completes successfully
- [ ] RAG retrieval returns expected results (if credentials available)

## Known Limitations

| Limitation | Workaround |
|------------|------------|
| DO SQLite in vitest | Manual testing via dev server |
| RAG tests need credentials | Set `CLOUDFLARE_ACCOUNT_ID` or skip |
| External OAuth providers | 2 tests skipped, manual verification |
