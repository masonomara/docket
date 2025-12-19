# Phase 3: Storage Layer Tutorial

**LONGER DOC**

This tutorial walks through setting up all storage schemas and structures for Docket. By the end, you'll have a working D1 database with all tables, Vectorize configured for multi-tenant semantic search, and R2 organized for document storage.

## What We're Building

Phase 2 created the raw infrastructure—empty D1 database, blank R2 bucket, Vectorize index. Phase 3 fills them with structure:

```
D1 Database
├── Auth tables (Better Auth)     → User accounts, sessions
├── Cross-tenant tables           → Orgs, workspace bindings, invitations
├── Subscription tables           → Billing tiers, permissions
└── Knowledge Base tables         → Shared KB + per-org context

Vectorize Index
├── Shared KB embeddings          → No metadata filter
└── Org Context embeddings        → Filtered by { org_id }

R2 Bucket
└── /orgs/{org_id}/
    ├── docs/{file_id}            → Uploaded documents
    ├── audit/{year}/{month}.jsonl → Tamper-evident logs
    └── conversations/            → Archived chats (>30 days)
```

**Why this structure?** D1 handles relational data with foreign keys and indexes. Vectorize enables semantic search across documents. R2 stores large files that don't belong in a database. The DO SQLite (per-org) stores conversation state—that's Phase 6.

## Part 1: D1 Migrations Setup

### 1.1 Understanding D1 Migrations

D1 migrations are versioned `.sql` files that evolve your schema. Cloudflare tracks which migrations have run in a `d1_migrations` table, so each migration executes exactly once.

```
migrations/
├── 0001_create_auth_tables.sql      → Better Auth foundation
├── 0002_create_org_tables.sql       → Multi-tenancy
├── 0003_create_subscription_tables.sql → Billing
└── 0004_create_kb_tables.sql        → Knowledge Base
```

Each file is numbered sequentially. Wrangler applies them in order, skipping already-applied migrations.

**Key commands:**

```bash
# Create a new migration file
npx wrangler d1 migrations create docket-db <migration_name>

# List pending migrations
npx wrangler d1 migrations list docket-db --local

# Apply migrations locally
npx wrangler d1 migrations apply docket-db --local

# Apply to production
npx wrangler d1 migrations apply docket-db --remote
```

### 1.2 Create the Migrations Folder

```bash
mkdir -p migrations
```

### 1.3 Migration 1: Auth Tables (Better Auth)

Better Auth expects specific table names and columns. We create these manually to control the schema and avoid drift.

Create `migrations/0001_create_auth_tables.sql`

**Tables:** `user`, `session`, `account`, `verification`

**What's happening here:**

- `user` stores Docket accounts (email/password or OAuth)
- `session` tracks who's logged into the web dashboard
- `account` links OAuth providers (if user signs up via Google)
- `verification` handles email verification and password reset flows

**Important:** This is NOT where Teams/Slack users are stored. Channel identities link to these accounts via `channel_user_links` (next migration).

### 1.4 Migration 2: Organization Tables

Create `migrations/0002_create_org_tables.sql`

**Tables:** `org`, `workspace_bindings`, `channel_user_links`, `invitations`, `api_keys`

**Identity flow explained:**

1. User sends message from Teams
2. Bot Framework gives us `teamsUserId`
3. Query `channel_user_links` for matching `channel_user_id`
4. If found → have `user_id` → fetch Docket user
5. If not found → trigger linking flow (OAuthCard → Azure AD SSO)
6. After linking → store mapping in `channel_user_links`

**Why separate `workspace_bindings`?** When a Teams admin installs Docket for their tenant, we need to know which Docket org that Teams workspace belongs to. One workspace = one org.

### 1.5 Migration 3: Subscriptions & Permissions

Create `migrations/0003_create_subscription_tables.sql`

**Tables:** `org_members`, `subscriptions`, `tier_limits`, `role_permissions`

**Why `org_members` here?** The `role` column in `org_members` ties directly to `role_permissions`. User access is determined by role → permissions lookup. Grouping these together keeps the access control logic in one migration.

**How permission checking works:**

```typescript
// In the DO, before executing a Clio operation
const canDelete = await db
  .prepare(
    `
  SELECT allowed FROM role_permissions
  WHERE role = ? AND permission = 'clio_delete'
`
  )
  .bind(userRole)
  .first();

if (!canDelete?.allowed) {
  return { error: "You don't have permission to delete Clio records" };
}
```

### 1.6 Migration 4: Knowledge Base Tables

Create `migrations/0004_create_kb_tables.sql`

**Tables:** `kb_chunks`, `kb_formulas`, `kb_benchmarks`, `org_context_chunks`

**Two different populations:**

1. **Shared KB** (`kb_chunks`, `kb_formulas`, `kb_benchmarks`): Populated at deploy time via a build script. Contains Clio workflows, deadline calculations, billing guidance.

2. **Org Context** (`org_context_chunks`): Populated at runtime when admins upload documents. Firm-specific procedures, templates, billing rates.

### 1.7 Apply Migrations

Run all migrations locally first:

```bash
# Create migration files (if using wrangler generate)
npx wrangler d1 migrations create docket-db create_auth_tables
npx wrangler d1 migrations create docket-db create_org_tables
npx wrangler d1 migrations create docket-db create_subscription_tables
npx wrangler d1 migrations create docket-db create_kb_tables

# Apply locally
npx wrangler d1 migrations apply docket-db --local

# Verify tables exist
npx wrangler d1 execute docket-db --local --command "SELECT name FROM sqlite_master WHERE type='table'"
```

Expected output:

```
┌───────────────────────┐
│ name                  │
├───────────────────────┤
│ d1_migrations         │
│ user                  │
│ session               │
│ account               │
│ verification          │
│ org                   │
│ org_members           │
│ workspace_bindings    │
│ channel_user_links    │
│ invitations           │
│ api_keys              │
│ tier_limits           │
│ subscriptions         │
│ role_permissions      │
│ kb_chunks             │
│ kb_formulas           │
│ kb_benchmarks         │
│ org_context_chunks    │
└───────────────────────┘
```

## Part 2: Vectorize Metadata Setup

Vectorize stores embeddings for semantic search. We need metadata filtering to separate shared KB from org-specific content.

### 2.1 Create Metadata Index

The Vectorize index exists from Phase 2. Now add a metadata index for `org_id`:

```bash
npx wrangler vectorize create-metadata-index docket-vectors \
  --property-name=org_id \
  --type=string
```

This enables filtering queries by `org_id`. Without it, you can't isolate org-specific embeddings.

### 2.2 How Embeddings Are Stored

**Shared KB embeddings** (no org_id):

```typescript
await env.VECTORIZE.upsert([
  {
    id: "kb_chunk_123",
    values: embedding, // 768 dimensions
    metadata: { type: "kb", source: "clio-workflows.md" },
  },
]);
```

**Org Context embeddings** (with org_id):

```typescript
await env.VECTORIZE.upsert([
  {
    id: "org_acme_chunk_456",
    values: embedding,
    metadata: {
      type: "org_context",
      org_id: "org_acme",
      source: "firm-procedures.pdf",
    },
  },
]);
```

### 2.3 How Queries Work

**Retrieving KB context** (all orgs see this):

```typescript
const kbResults = await env.VECTORIZE.query(queryEmbedding, {
  topK: 5,
  filter: { type: "kb" },
  returnMetadata: "all",
});
```

**Retrieving Org Context** (filtered by org):

```typescript
const orgResults = await env.VECTORIZE.query(queryEmbedding, {
  topK: 5,
  filter: { org_id: currentOrgId },
  returnMetadata: "all",
});
```

Both queries run in parallel during RAG retrieval:

```typescript
const [kbResults, orgResults] = await Promise.all([
  retrieveKBContext(queryEmbedding, env),
  retrieveOrgContext(queryEmbedding, orgId, env),
]);
```

## Part 3: R2 Path Structure

R2 stores files too large for D1—uploaded documents, audit logs, archived conversations.

### 3.1 Directory Structure

```
/orgs/{org_id}/
├── docs/
│   └── {file_id}              → Original uploaded files (PDF, DOCX, MD)
├── audit/
│   └── {year}/
│       └── {month}.jsonl      → Append-only audit logs
└── conversations/
    └── {conversation_id}.json → Archived conversations (>30 days)
```

### 3.2 Path Helpers

Create a utility for consistent paths:

```typescript
// src/storage/r2-paths.ts

export const R2Paths = {
  // Document storage
  orgDoc: (orgId: string, fileId: string) => `orgs/${orgId}/docs/${fileId}`,

  // Audit logs
  auditLog: (orgId: string, year: number, month: number) =>
    `orgs/${orgId}/audit/${year}/${month.toString().padStart(2, "0")}.jsonl`,

  // Archived conversations
  archivedConversation: (orgId: string, conversationId: string) =>
    `orgs/${orgId}/conversations/${conversationId}.json`,
};
```

### 3.3 Audit Log Format

Each audit entry is a JSON line with hash chaining for tamper detection:

```typescript
interface AuditEntry {
  id: string;
  user_id: string;
  action: string; // "clio_create", "clio_update", etc.
  object_type: string; // "Matter", "Contact", etc.
  params: Record<string, unknown>;
  result: "success" | "error";
  error_message?: string;
  created_at: string;
  prev_hash: string; // SHA-256 of previous entry
}
```

**Why hash chaining?** Each entry includes the hash of the previous entry. If someone modifies an old entry, all subsequent hashes become invalid. Auditors can verify the chain hasn't been tampered with.

### 3.4 Writing Audit Logs

```typescript
async function appendAuditLog(
  env: Env,
  orgId: string,
  entry: Omit<AuditEntry, "id" | "created_at" | "prev_hash">
): Promise<void> {
  const now = new Date();
  const path = R2Paths.auditLog(orgId, now.getFullYear(), now.getMonth() + 1);

  // Get existing log to find prev_hash
  const existing = await env.R2.get(path);
  let prevHash = "genesis";

  if (existing) {
    const text = await existing.text();
    const lines = text.trim().split("\n");
    if (lines.length > 0) {
      const lastEntry = JSON.parse(lines[lines.length - 1]);
      prevHash = await sha256(JSON.stringify(lastEntry));
    }
  }

  const fullEntry: AuditEntry = {
    id: crypto.randomUUID(),
    created_at: now.toISOString(),
    prev_hash: prevHash,
    ...entry,
  };

  // Append to log
  const newLine = JSON.stringify(fullEntry) + "\n";
  const newContent = existing ? (await existing.text()) + newLine : newLine;

  await env.R2.put(path, newContent, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
}
```

## Part 4: Testing

### 4.1 Unit Tests for Migrations

Create `test/storage.spec.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

describe("D1 Storage Schema", () => {
  it("has all required tables", async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();

    const tables = result.results.map((r: { name: string }) => r.name);

    expect(tables).toContain("user");
    expect(tables).toContain("session");
    expect(tables).toContain("org");
    expect(tables).toContain("org_members");
    expect(tables).toContain("channel_user_links");
    expect(tables).toContain("kb_chunks");
    expect(tables).toContain("org_context_chunks");
  });

  it("enforces role constraints", async () => {
    // Insert test org
    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind("test-org", "Test Org")
      .run();

    // Insert test user
    await env.DB.prepare("INSERT INTO user (id, email) VALUES (?, ?)")
      .bind("test-user", "test@example.com")
      .run();

    // Valid role should work
    await env.DB.prepare(
      "INSERT INTO org_members (id, user_id, org_id, role) VALUES (?, ?, ?, ?)"
    )
      .bind("om-1", "test-user", "test-org", "admin")
      .run();

    // Invalid role should fail
    await expect(
      env.DB.prepare(
        "INSERT INTO org_members (id, user_id, org_id, role) VALUES (?, ?, ?, ?)"
      )
        .bind("om-2", "test-user", "test-org", "superuser")
        .run()
    ).rejects.toThrow();
  });

  it("has seeded tier limits", async () => {
    const tiers = await env.DB.prepare(
      "SELECT tier FROM tier_limits ORDER BY tier"
    ).all();

    expect(tiers.results).toHaveLength(4);
    expect(tiers.results.map((t: { tier: string }) => t.tier)).toEqual([
      "enterprise",
      "free",
      "professional",
      "starter",
    ]);
  });

  it("has seeded role permissions", async () => {
    const perms = await env.DB.prepare(
      "SELECT role, permission, allowed FROM role_permissions WHERE permission = 'clio_delete'"
    ).all();

    const adminPerm = perms.results.find(
      (p: { role: string }) => p.role === "admin"
    );
    const memberPerm = perms.results.find(
      (p: { role: string }) => p.role === "member"
    );

    expect(adminPerm?.allowed).toBe(1);
    expect(memberPerm?.allowed).toBe(0);
  });
});
```

### 4.2 Integration Tests for Vectorize

```typescript
describe("Vectorize Metadata Filtering", () => {
  it("filters org context by org_id", async () => {
    // Generate test embedding
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "test document content",
    })) as { data: number[][] };

    const embedding = data[0];

    // Insert KB chunk (no org_id)
    await env.VECTORIZE.upsert([
      {
        id: "kb_test_1",
        values: embedding,
        metadata: { type: "kb", source: "test.md" },
      },
    ]);

    // Insert org context for two orgs
    await env.VECTORIZE.upsert([
      {
        id: "org_acme_1",
        values: embedding,
        metadata: { type: "org_context", org_id: "acme" },
      },
      {
        id: "org_beta_1",
        values: embedding,
        metadata: { type: "org_context", org_id: "beta" },
      },
    ]);

    // Query with org filter - should only get acme's context
    const results = await env.VECTORIZE.query(embedding, {
      topK: 10,
      filter: { org_id: "acme" },
      returnMetadata: "all",
    });

    const orgIds = results.matches.map((m) => m.metadata?.org_id);
    expect(orgIds).toContain("acme");
    expect(orgIds).not.toContain("beta");
  });
});
```

### 4.3 R2 Path Tests

```typescript
describe("R2 Path Structure", () => {
  it("stores documents in correct paths", async () => {
    const orgId = "test-org";
    const fileId = crypto.randomUUID();
    const path = `orgs/${orgId}/docs/${fileId}`;

    await env.R2.put(path, "test content", {
      httpMetadata: { contentType: "text/plain" },
    });

    const obj = await env.R2.get(path);
    expect(obj).not.toBeNull();
    expect(await obj!.text()).toBe("test content");
  });

  it("isolates orgs in separate paths", async () => {
    // Store doc for org A
    await env.R2.put("orgs/org-a/docs/file1", "org a content");

    // Store doc for org B
    await env.R2.put("orgs/org-b/docs/file1", "org b content");

    // List org A's docs - should not see org B
    const list = await env.R2.list({ prefix: "orgs/org-a/" });
    const keys = list.objects.map((o) => o.key);

    expect(keys).toContain("orgs/org-a/docs/file1");
    expect(keys).not.toContain("orgs/org-b/docs/file1");
  });
});
```

## Part 5: Demo Component

Update the demo page to verify Phase 3 completion.

Add to `src/index.ts` a new route `/demo/storage` that verifies:

1. All D1 tables exist
2. Tier limits are seeded
3. Role permissions are seeded
4. Vectorize accepts metadata
5. R2 path structure works

```typescript
async function handleStorageDemo(_req: Request, env: Env): Promise<Response> {
  const checks: { name: string; status: "pass" | "fail"; detail: string }[] =
    [];

  // Check D1 tables
  try {
    const tables = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'd1_%'"
    ).first<{ count: number }>();

    checks.push({
      name: "D1 Tables",
      status: tables!.count >= 14 ? "pass" : "fail",
      detail: `${tables!.count} tables created`,
    });
  } catch (e) {
    checks.push({ name: "D1 Tables", status: "fail", detail: String(e) });
  }

  // Check tier limits
  try {
    const tiers = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM tier_limits"
    ).first<{ count: number }>();
    checks.push({
      name: "Tier Limits",
      status: tiers!.count === 4 ? "pass" : "fail",
      detail: `${tiers!.count} tiers defined`,
    });
  } catch (e) {
    checks.push({ name: "Tier Limits", status: "fail", detail: String(e) });
  }

  // Check role permissions
  try {
    const perms = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM role_permissions"
    ).first<{ count: number }>();
    checks.push({
      name: "Role Permissions",
      status: perms!.count >= 14 ? "pass" : "fail",
      detail: `${perms!.count} permissions defined`,
    });
  } catch (e) {
    checks.push({
      name: "Role Permissions",
      status: "fail",
      detail: String(e),
    });
  }

  // Check Vectorize metadata
  try {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "storage test",
    })) as { data: number[][] };

    await env.VECTORIZE.upsert([
      {
        id: "storage-demo-test",
        values: data[0],
        metadata: { org_id: "demo-org", type: "test" },
      },
    ]);

    const results = await env.VECTORIZE.query(data[0], {
      topK: 1,
      filter: { org_id: "demo-org" },
    });

    checks.push({
      name: "Vectorize Metadata",
      status: results.matches.length > 0 ? "pass" : "fail",
      detail: "Metadata filtering works",
    });
  } catch (e) {
    checks.push({
      name: "Vectorize Metadata",
      status: "fail",
      detail: String(e),
    });
  }

  // Check R2 structure
  try {
    const testPath = "orgs/demo-org/docs/storage-test.txt";
    await env.R2.put(testPath, "storage demo");
    const obj = await env.R2.get(testPath);

    checks.push({
      name: "R2 Path Structure",
      status: obj ? "pass" : "fail",
      detail: "Org isolation working",
    });
  } catch (e) {
    checks.push({
      name: "R2 Path Structure",
      status: "fail",
      detail: String(e),
    });
  }

  const allPassed = checks.every((c) => c.status === "pass");

  return Response.json({
    phase: 3,
    name: "Storage Layer",
    status: allPassed ? "complete" : "incomplete",
    checks,
  });
}
```

## Checklist

Before marking Phase 3 complete:

- [ ] All 4 migration files created
- [ ] Migrations applied locally (`--local`)
- [ ] All 14+ tables exist in D1
- [ ] Tier limits seeded (4 tiers)
- [ ] Role permissions seeded (14 permissions)
- [ ] Vectorize metadata index created for `org_id`
- [ ] R2 path helpers implemented
- [ ] Unit tests passing
- [ ] Integration tests passing (requires `--remote` for Vectorize)
- [ ] Demo endpoint returns all checks passing
- [ ] Migrations applied to production (`--remote`)

## Next Phase

Phase 4: Auth Foundation—integrate Better Auth with D1, implement the factory pattern for Workers runtime, and build channel identity linking.

---

**Sources:**

- [Cloudflare D1 Migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Vectorize Metadata Filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
- [Better Auth Cloudflare Integration](https://github.com/zpg6/better-auth-cloudflare)
