# API Tests

## Quick Start

```bash
npm test                              # Unit + integration (some skip)
export CLOUDFLARE_ACCOUNT_ID=xxx && npm test   # With integration tests
WORKER_URL=http://localhost:8787 npm run test:e2e  # E2E tests
```

## Environment Variables

| Variable                | Required For                  | Example                 |
| ----------------------- | ----------------------------- | ----------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Integration tests (RAG, GDPR) | Export before running   |
| `WORKER_URL`            | E2E tests                     | `http://localhost:8787` |

## Test Categories

```
test/
├── unit/          Pure function tests, mocked dependencies
├── integration/   D1/R2/Vectorize tests via miniflare
├── e2e/           HTTP tests against running worker
└── helpers/       Shared test utilities
```

## Using Shared Helpers

```typescript
import {
  createTestUser,
  createTestOrg,
  addOrgMember,
  signUpUser,
  generateEmbedding,
} from "../helpers";

// Create fixtures
const user = await createTestUser(env.DB, { name: "Alice" });
const org = await createTestOrg(env.DB, { name: "Test Firm" });
await addOrgMember(env.DB, { orgId: org.id, userId: user.id, role: "admin" });

// Auth flows
const { userId, cookie } = await signUpUser(worker, env);

// Vectorize
const embedding = await generateEmbedding(env, "test content");
```

## Known Limitations

### DO SQLite Tests Skip

The vitest-pool-workers plugin cannot test Durable Object SQLite (SQLITE_AUTH error). Tests using DO SQLite show as skipped.

**Affected:** TenantDO integration tests
**Workaround:** Test against deployed staging worker

### Integration Tests Need Live Cloudflare

RAG and GDPR Vectorize tests hit live Cloudflare services. They:

- Require `CLOUDFLARE_ACCOUNT_ID` exported
- May be slow (30s+)
- Can fail due to rate limits

```bash
# Run integration tests
export CLOUDFLARE_ACCOUNT_ID=your-account-id
npm test -- --grep "RAG\|GDPR Vectorize"
```

## Writing Tests

1. Use shared helpers from `./helpers` instead of duplicating fixtures
2. Use `describe.skipIf()` for conditional tests, not silent returns
3. Clean up test data in `afterAll` hooks
4. Use `VectorTracker` for Vectorize cleanup:

```typescript
import { VectorTracker } from "../helpers";

const tracker = new VectorTracker();
afterAll(() => tracker.cleanup(env));

it("tests vectors", async () => {
  tracker.track("my-vector-id");
  await env.VECTORIZE.upsert([...]);
});
```
