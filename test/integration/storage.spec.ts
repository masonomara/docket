import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { R2Paths } from "../../src/storage/r2-paths";

// ============================================================================
// D1 Storage Schema Tests
// ============================================================================

describe("D1 Storage Schema", () => {
  it("creates all required tables", async () => {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();

    const tableNames = (result.results as { name: string }[]).map(
      (row) => row.name
    );

    const requiredTables = [
      "user",
      "session",
      "account",
      "verification",
      "org",
      "workspace_bindings",
      "channel_user_links",
      "invitations",
      "api_keys",
      "org_members",
      "subscriptions",
      "tier_limits",
      "role_permissions",
      "kb_chunks",
      "org_context_chunks",
    ];

    for (const tableName of requiredTables) {
      expect(tableNames).toContain(tableName);
    }
  });

  it("enforces role constraints on org_members", async () => {
    // Setup: Create org and user
    await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
      .bind("test-org-role", "Test Org")
      .run();

    const now = Date.now();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user (id, email, name, email_verified, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    )
      .bind("test-user-role", "role-test@example.com", "Test", now, now)
      .run();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO org_members (id, user_id, org_id, role)
       VALUES (?, ?, ?, ?)`
    )
      .bind("om-role-1", "test-user-role", "test-org-role", "admin")
      .run();

    const roleResult = await env.DB.prepare(
      "SELECT role FROM org_members WHERE id = ?"
    )
      .bind("om-role-1")
      .first<{ role: string }>();

    expect(roleResult?.role).toBe("admin");

    // Attempt to insert invalid role - should fail
    await expect(
      env.DB.prepare(
        `INSERT INTO org_members (id, user_id, org_id, role)
         VALUES (?, ?, ?, ?)`
      )
        .bind("om-role-2", "test-user-role", "test-org-role", "superuser")
        .run()
    ).rejects.toThrow();
  });

  it("seeds tier limits", async () => {
    const tiersResult = await env.DB.prepare(
      "SELECT tier FROM tier_limits ORDER BY tier"
    ).all();

    const tiers = (tiersResult.results as { tier: string }[]).map(
      (row) => row.tier
    );

    expect(tiers).toEqual(["enterprise", "free", "professional", "starter"]);

    // Check free tier limits
    const freeTier = await env.DB.prepare(
      "SELECT max_users, max_queries_per_day, clio_write FROM tier_limits WHERE tier = ?"
    )
      .bind("free")
      .first();

    expect(freeTier).toMatchObject({
      max_users: 1,
      max_queries_per_day: 25,
      clio_write: 0,
    });

    // Check enterprise tier limits
    const enterpriseTier = await env.DB.prepare(
      "SELECT max_users, clio_write FROM tier_limits WHERE tier = ?"
    )
      .bind("enterprise")
      .first();

    expect(enterpriseTier).toMatchObject({
      max_users: -1, // Unlimited
      clio_write: 1,
    });
  });

  it("seeds role permissions", async () => {
    const countResult = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM role_permissions"
    ).first<{ count: number }>();

    expect(countResult?.count).toBe(12);

    // Helper to check permission
    async function checkPermission(
      role: string,
      permission: string
    ): Promise<number | undefined> {
      const result = await env.DB.prepare(
        "SELECT allowed FROM role_permissions WHERE role = ? AND permission = ?"
      )
        .bind(role, permission)
        .first<{ allowed: number }>();
      return result?.allowed;
    }

    // Admin should have clio_delete permission
    expect(await checkPermission("admin", "clio_delete")).toBe(1);

    // Member should NOT have clio_delete permission
    expect(await checkPermission("member", "clio_delete")).toBe(0);

    // Member should have clio_read permission
    expect(await checkPermission("member", "clio_read")).toBe(1);
  });
});

// ============================================================================
// R2 Path Helper Tests
// ============================================================================

describe("R2 Path Helpers", () => {
  it("generates correct paths", () => {
    expect(R2Paths.orgDoc("acme", "doc-123")).toBe("orgs/acme/docs/doc-123");

    expect(R2Paths.auditLogPrefix("acme", 2025, 1)).toBe(
      "orgs/acme/audit/2025/01/"
    );

    expect(R2Paths.auditLogPrefix("acme", 2025, 12, 5)).toBe(
      "orgs/acme/audit/2025/12/05/"
    );

    expect(R2Paths.archivedConversation("acme", "conv-456")).toBe(
      "orgs/acme/conversations/conv-456.json"
    );
  });
});

// ============================================================================
// R2 Storage Operation Tests
// ============================================================================

describe("R2 Storage Operations", () => {
  it("stores and retrieves documents", async () => {
    const path = R2Paths.orgDoc("test-org-r2", crypto.randomUUID());

    await env.R2.put(path, "test content", {
      httpMetadata: { contentType: "text/plain" },
    });

    const retrieved = await env.R2.get(path);
    const content = await retrieved!.text();

    expect(content).toBe("test content");
  });

  it("isolates documents between organizations", async () => {
    await env.R2.put("orgs/org-a-iso/docs/file1", "org a content");
    await env.R2.put("orgs/org-b-iso/docs/file1", "org b content");

    const orgAList = await env.R2.list({ prefix: "orgs/org-a-iso/" });
    const orgAKeys = orgAList.objects.map((obj) => obj.key);

    expect(orgAKeys).toContain("orgs/org-a-iso/docs/file1");
    expect(orgAKeys).not.toContain("orgs/org-b-iso/docs/file1");
  });
});

// ============================================================================
// TenantDO Audit Log Tests (Skipped - requires DO setup)
// ============================================================================

describe.skip("TenantDO Audit Log", () => {
  it("appends audit entries via DO endpoint", async () => {
    const doId = env.TENANT.idFromName(`audit-${Date.now()}`);
    const stub = env.TENANT.get(doId);

    const response = await stub.fetch("http://do/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "user-123",
        action: "clio_create",
        object_type: "matter",
        params: { name: "Test" },
        result: "success",
      }),
    });

    const data = (await response.json()) as { id: string };
    expect(data.id).toBeDefined();
  });

  it("stores each entry as separate R2 object", async () => {
    const orgId = `separate-${Date.now()}`;
    const doId = env.TENANT.idFromName(orgId);
    const stub = env.TENANT.get(doId);

    // Create two audit entries
    for (const userId of ["user-1", "user-2"]) {
      await stub.fetch("http://do/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          action: "test",
          object_type: "test",
          params: {},
          result: "success",
        }),
      });
    }

    const now = new Date();
    const prefix = R2Paths.auditLogPrefix(
      doId.toString(),
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate()
    );

    const listResult = await env.R2.list({ prefix });

    expect(listResult.objects.length).toBe(2);
  });
});

// ============================================================================
// Vectorize Metadata Filtering Tests (Skipped - requires Vectorize setup)
// ============================================================================

describe.skip("Vectorize Metadata Filtering", () => {
  it("generates embeddings with metadata", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "test document",
    })) as { data: number[][] };

    expect(data[0].length).toBe(768);

    const id = `vec-${Date.now()}`;
    await env.VECTORIZE.upsert([
      {
        id,
        values: data[0],
        metadata: { type: "test", source: "integration" },
      },
    ]);

    const queryResult = await env.VECTORIZE.query(data[0], {
      topK: 1,
      returnMetadata: "all",
    });

    expect(queryResult.matches.length).toBeGreaterThan(0);
  });

  it("filters org context by org_id", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "firm billing",
    })) as { data: number[][] };

    const timestamp = Date.now();

    await env.VECTORIZE.upsert([
      {
        id: `org_acme_${timestamp}`,
        values: data[0],
        metadata: { type: "org_context", org_id: "acme" },
      },
      {
        id: `org_beta_${timestamp}`,
        values: data[0],
        metadata: { type: "org_context", org_id: "beta" },
      },
    ]);

    const queryResult = await env.VECTORIZE.query(data[0], {
      topK: 10,
      filter: { org_id: "acme" },
      returnMetadata: "all",
    });

    const orgIds = queryResult.matches.map((match) => match.metadata?.org_id);

    expect(orgIds).toContain("acme");
    expect(orgIds).not.toContain("beta");
  });

  it("retrieves KB content without org filter", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "clio workflow",
    })) as { data: number[][] };

    await env.VECTORIZE.upsert([
      {
        id: `kb_${Date.now()}`,
        values: data[0],
        metadata: { type: "kb", source: "clio-workflows.md" },
      },
    ]);

    const queryResult = await env.VECTORIZE.query(data[0], {
      topK: 5,
      filter: { type: "kb" },
      returnMetadata: "all",
    });

    const types = queryResult.matches.map((match) => match.metadata?.type);

    expect(types).toContain("kb");
  });
});
