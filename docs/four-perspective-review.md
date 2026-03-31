# Docket Project Review - Four Perspectives

**Date:** 2025-12-31
**Scope:** All numbered specs (00-12), all test files
**Reviewers:** Christian Engineer, Taoist PM, Lawyerly Supervisor, Nicaraguan Developer

---

### 6. E2E Tests Default to Production URL

**Source:** Nicaraguan Developer
**Location:** `apps/api/test/e2e/demo-flow.spec.ts:1-3`

**Description:** If the `WORKER_URL` environment variable is not set, E2E tests silently default to `https://api.docketadmin.com`. Running `npm run test:e2e` without proper env setup will:

- Spam production API with test requests
- Potentially create/modify real data
- Cause rate limiting on production

```typescript
// Current (dangerous default)
const BASE_URL = process.env?.WORKER_URL || "https://api.docketadmin.com";
```

**Recommended Fix:**

```typescript
const BASE_URL = process.env.WORKER_URL;

if (!BASE_URL) {
  throw new Error(
    "WORKER_URL environment variable is required for E2E tests.\n" +
      "Set it to your local worker (http://localhost:8787) or staging URL.\n" +
      "Example: WORKER_URL=http://localhost:8787 npm run test:e2e"
  );
}
```

---

### 8. TenantDO Has No Unit Tests (2700 Lines)

**Source:** Christian Engineer
**Location:** `apps/api/src/do/tenant.ts`

**Description:** The TenantDO Durable Object is 2700+ lines and handles critical functionality:

- Message processing and streaming
- Tool call handling for Clio operations
- Confirmation flow management
- Database migrations
- Token management

Due to the vitest-pool-workers limitation with DO SQLite, integration tests skip most DO functionality. No unit tests exist to cover this code with mocked dependencies.

**Recommended Fix:** Extract testable logic into pure functions and create unit tests:

```typescript
// 1. Extract to apps/api/src/services/llm-parser.ts
export function parseLLMResponse(raw: string): ParsedResponse {
  // Move parsing logic here
}

export function parseClassificationJSON(raw: string): Classification {
  // Move classification parsing here
}

// 2. Create apps/api/test/unit/llm-parser.spec.ts
describe("parseLLMResponse", () => {
  it("extracts text content from streaming response", () => {});
  it("handles tool call responses", () => {});
  it("handles malformed JSON gracefully", () => {});
});

describe("parseClassificationJSON", () => {
  it("parses approve classification", () => {});
  it("parses reject classification", () => {});
  it("returns unknown for unparseable input", () => {});
});

// 3. Extract to apps/api/src/services/system-prompt.ts
export function buildSystemPrompt(config: SystemPromptConfig): string {
  // Move prompt construction here
}

// 4. Test prompt construction
describe("buildSystemPrompt", () => {
  it("includes org context when available", () => {});
  it("includes clio schema when connected", () => {});
  it("respects token budget", () => {});
});
```

---

### 9. Silent Test Skipping Hides Coverage Gaps

**Source:** Nicaraguan Developer
**Location:** `apps/api/test/integration/chat.spec.ts`

**Description:** When DO SQLite tests cannot run, the code silently returns early with a console.log. Tests appear to pass (green checkmarks) but no assertions execute. New developers will think tests pass when nothing is verified.

```typescript
// Current (silent skip)
if (!doTestsSupported) {
  console.log("Skipping: DO tests not supported in this environment");
  return;
}
```

**Recommended Fix:** Use explicit skip mechanisms that are visible in test output:

```typescript
// Option 1: describe.skipIf (vitest)
describe.skipIf(!doTestsSupported)("TenantDO Integration Tests", () => {
  // Tests here will show as "skipped" in output
});

// Option 2: Conditional describe with clear warning
const doDescribe = doTestsSupported ? describe : describe.skip;

beforeAll(() => {
  if (!doTestsSupported) {
    console.warn(
      "\n⚠️  DO SQLite tests SKIPPED - see CLAUDE.md Known Issues\n"
    );
  }
});

doDescribe("TenantDO Integration Tests", () => {
  // Tests
});
```

---

### 12. Playwright Auth Setup Uses Fixed Timeouts

**Source:** Nicaraguan Developer
**Location:** `apps/web/test/e2e/auth.setup.ts`

**Description:** The auth setup uses three `waitForTimeout()` calls with fixed durations (2000ms, 1500ms, 2000ms). Fixed timeouts are the #1 source of flaky E2E tests:

- On fast machines: waste 5.5 seconds per test run
- On slow CI: timeout anyway because operations take longer
- Network variability makes this worse

```typescript
// Current (flaky)
await page.waitForTimeout(2000);
// ... operations ...
await page.waitForTimeout(1500);
// ... more operations ...
await page.waitForTimeout(2000);
```

**Recommended Fix:** Replace with explicit wait conditions:

```typescript
// Instead of waitForTimeout(2000) after navigation:
await page.waitForURL("**/admin");
await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();

// Instead of waitForTimeout(1500) after form submission:
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL("**/dashboard");

// Instead of waitForTimeout(2000) for auth state:
await expect(page.getByTestId("user-menu")).toBeVisible();
// Or wait for network idle:
await page.waitForLoadState("networkidle");
```

---

### 14. Test Helpers Duplicated Across Files

**Source:** Taoist PM
**Location:** Multiple test files

**Description:** Each integration test file recreates common helpers:

- `createTestUser()` in `chat.spec.ts`
- `createTestOrg()` in `chat.spec.ts`, `rag-integration.spec.ts`
- `post()`, `get()` in `auth.spec.ts`
- Session creation in multiple files

This leads to inconsistency and maintenance burden.

**Recommended Fix:** Consolidate into shared helpers:

```typescript
// apps/api/test/helpers/fixtures.ts
export async function createTestUser(
  db: D1Database,
  overrides?: Partial<User>
): Promise<User> {
  const user = {
    id: `test-user-${crypto.randomUUID()}`,
    email: `test-${Date.now()}@example.com`,
    name: "Test User",
    ...overrides,
  };
  await db
    .prepare("INSERT INTO user (id, email, name) VALUES (?, ?, ?)")
    .bind(user.id, user.email, user.name)
    .run();
  return user;
}

export async function createTestOrg(
  db: D1Database,
  overrides?: Partial<Organization>
): Promise<Organization> {
  /* ... */
}

export async function addOrgMember(
  db: D1Database,
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member"
): Promise<void> {
  /* ... */
}

// apps/api/test/helpers/requests.ts
export function createTestClient(worker: UnstableDevWorker) {
  return {
    get: (path: string, headers?: HeadersInit) =>
      worker.fetch(`http://test${path}`, { headers }),
    post: (path: string, body: unknown, headers?: HeadersInit) =>
      worker.fetch(`http://test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    // ... other methods
  };
}

// apps/api/test/helpers/auth.ts
export async function createAuthenticatedSession(
  db: D1Database,
  user: User
): Promise<{ cookie: string; session: Session }> {
  /* ... */
}
```

---

### 18. Token Refresh Failure Flow Not Tested

**Source:** Nicaraguan Developer
**Location:** `apps/api/src/do/tenant.ts` (refresh logic), no test file

**Description:** The spec says when token refresh returns `invalid_grant`, the system should mark `clio_connected=false` and return a re-auth message. No test verifies:

- Refresh failure detection
- `clio_connected` flag update
- User receives appropriate error message
- Retry doesn't loop infinitely

**Recommended Fix:** Add to `apps/api/test/unit/clio-oauth.spec.ts`:

```typescript
describe("token refresh failure handling", () => {
  it("marks clio_connected=false on invalid_grant", async () => {
    // Mock refresh endpoint to return invalid_grant
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })
    );

    const result = await refreshClioToken(
      mockFetch,
      expiredToken,
      clientId,
      clientSecret
    );

    expect(result.success).toBe(false);
    expect(result.requiresReauth).toBe(true);
  });

  it("returns user-friendly message for reauth", async () => {
    const result = await handleClioUnauthorized(doContext, userId);

    expect(result.message).toContain("reconnect");
    expect(result.action).toBe("reauth");
  });

  it("does not retry infinitely on persistent failure", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("Server Error", { status: 500 }));

    const result = await refreshClioToken(
      mockFetch,
      expiredToken,
      clientId,
      clientSecret
    );

    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry on 500
    expect(result.success).toBe(false);
  });
});
```

---

### 19. Test Setup Not Documented

**Source:** Nicaraguan Developer
**Location:** Needs new file `docs/testing.md`

**Description:** The project has 4 test configurations across 2 apps with different requirements:

- `apps/api/vitest.config.mts` - Workers pool for unit/integration
- `apps/api/vitest.e2e.config.mts` - Standard node for HTTP E2E
- `apps/web/vitest.config.ts` - jsdom for React components
- `apps/web/playwright.config.ts` - Browser E2E

New developers don't know which command runs what, which env vars are needed, or what's expected to fail.

**Recommended Fix:** Create `docs/testing.md`:

````markdown
# Testing Guide

## Test Commands

| Command                        | App | What It Tests      | Requirements         |
| ------------------------------ | --- | ------------------ | -------------------- |
| `npm run test -w apps/api`     | API | Unit + integration | None                 |
| `npm run test:e2e -w apps/api` | API | HTTP E2E           | `WORKER_URL` env var |
| `npm run test -w apps/web`     | Web | Components + hooks | None                 |
| `npm run test:e2e -w apps/web` | Web | Browser E2E        | Running dev servers  |

## Environment Variables

### API Tests

- `INTEGRATION_TESTS_ENABLED=true` - Required for RAG integration tests
- `WORKER_URL=http://localhost:8787` - Required for E2E tests

### Web Tests

- `VITE_API_URL=http://localhost:8787` - API URL for MSW handlers

## Known Limitations

### DO SQLite Tests Skip

The vitest-pool-workers plugin cannot test Durable Object SQLite due to SQLITE_AUTH errors. Tests using DO SQLite will be skipped with a warning. See CLAUDE.md for details.

**What's affected:** TenantDO integration tests (~26 tests)
**Workaround:** Test against deployed staging worker

### RAG Tests Require Live Services

RAG integration tests hit live Cloudflare Vectorize and Workers AI. They may be slow (30s+) and can fail due to rate limits.

**Run separately:** `npm run test -- --grep "RAG" -w apps/api`

## Running Tests

```bash
# All API tests (some will skip)
npm run test -w apps/api

# API E2E against local worker
WORKER_URL=http://localhost:8787 npm run test:e2e -w apps/api

# Web unit tests
npm run test -w apps/web

# Web E2E (requires running servers)
npm run dev  # Terminal 1
npm run test:e2e -w apps/web  # Terminal 2
```
````

---

#### 6. No Local Development Setup Documentation

No `.env.example` files, no setup scripts, no documentation on getting local dev environment running.

**What to do:** Create `.env.example` files for both apps. Add `scripts/dev-setup.sh`.
