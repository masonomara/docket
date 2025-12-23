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

