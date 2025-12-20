import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { R2Paths } from "../src/storage/r2-paths";

describe("D1 Storage Schema", () => {
  it("creates all required tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const tables = (results as { name: string }[]).map((r) => r.name);
    for (const table of [
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
      "kb_formulas",
      "kb_benchmarks",
      "org_context_chunks",
    ]) {
      expect(tables).toContain(table);
    }
  });

  it("enforces role constraints on org_members", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
      .bind("test-org-role", "Test Org")
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO user (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        "test-user-role",
        "role-test@example.com",
        "Test User",
        0,
        Date.now(),
        Date.now()
      )
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO org_members (id, user_id, org_id, role) VALUES (?, ?, ?, ?)"
    )
      .bind("om-role-1", "test-user-role", "test-org-role", "admin")
      .run();

    const member = await env.DB.prepare(
      "SELECT role FROM org_members WHERE id = ?"
    )
      .bind("om-role-1")
      .first<{ role: string }>();
    expect(member?.role).toBe("admin");

    await expect(
      env.DB.prepare(
        "INSERT INTO org_members (id, user_id, org_id, role) VALUES (?, ?, ?, ?)"
      )
        .bind("om-role-2", "test-user-role", "test-org-role", "superuser")
        .run()
    ).rejects.toThrow();
  });

  it("seeds tier limits with correct values", async () => {
    const { results } = await env.DB.prepare(
      "SELECT tier FROM tier_limits ORDER BY tier"
    ).all();
    expect((results as { tier: string }[]).map((t) => t.tier)).toEqual([
      "enterprise",
      "free",
      "professional",
      "starter",
    ]);

    const freeTier = await env.DB.prepare(
      "SELECT * FROM tier_limits WHERE tier = ?"
    )
      .bind("free")
      .first<{
        max_users: number;
        max_queries_per_day: number;
        clio_write: number;
      }>();
    expect(freeTier).toMatchObject({
      max_users: 1,
      max_queries_per_day: 25,
      clio_write: 0,
    });

    const enterpriseTier = await env.DB.prepare(
      "SELECT * FROM tier_limits WHERE tier = ?"
    )
      .bind("enterprise")
      .first<{ max_users: number; clio_write: number }>();
    expect(enterpriseTier).toMatchObject({ max_users: -1, clio_write: 1 });
  });

  it("seeds role permissions with correct values", async () => {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM role_permissions"
    ).first<{ count: number }>();
    expect(count?.count).toBe(12);

    async function checkPermission(
      role: string,
      permission: string
    ): Promise<number | undefined> {
      return (
        await env.DB.prepare(
          "SELECT allowed FROM role_permissions WHERE role = ? AND permission = ?"
        )
          .bind(role, permission)
          .first<{ allowed: number }>()
      )?.allowed;
    }

    expect(await checkPermission("admin", "clio_delete")).toBe(1);
    expect(await checkPermission("member", "clio_delete")).toBe(0);
    expect(await checkPermission("member", "clio_read")).toBe(1);
  });
});

describe("R2 Path Helpers", () => {
  it("generates correct org document paths", () => {
    expect(R2Paths.orgDoc("acme-law", "doc-123")).toBe(
      "orgs/acme-law/docs/doc-123"
    );
  });

  it("generates correct audit log prefixes with zero-padding", () => {
    expect(R2Paths.auditLogPrefix("acme-law", 2025, 1)).toBe(
      "orgs/acme-law/audit/2025/01/"
    );
    expect(R2Paths.auditLogPrefix("acme-law", 2025, 12, 5)).toBe(
      "orgs/acme-law/audit/2025/12/05/"
    );
  });

  it("generates correct archived conversation paths", () => {
    expect(R2Paths.archivedConversation("acme-law", "conv-456")).toBe(
      "orgs/acme-law/conversations/conv-456.json"
    );
  });
});

describe("R2 Storage Operations", () => {
  it("stores and retrieves documents", async () => {
    const path = R2Paths.orgDoc("test-org-r2", crypto.randomUUID());
    await env.R2.put(path, "test document content", {
      httpMetadata: { contentType: "text/plain" },
    });
    expect(await (await env.R2.get(path))!.text()).toBe(
      "test document content"
    );
  });

  it("isolates documents between organizations", async () => {
    await env.R2.put("orgs/org-a-iso/docs/file1", "org a content");
    await env.R2.put("orgs/org-b-iso/docs/file1", "org b content");

    const keys = (await env.R2.list({ prefix: "orgs/org-a-iso/" })).objects.map(
      (o) => o.key
    );
    expect(keys).toContain("orgs/org-a-iso/docs/file1");
    expect(keys).not.toContain("orgs/org-b-iso/docs/file1");
  });
});

describe.skip("TenantDO Audit Log", () => {
  it("appends audit entries via DO endpoint", async () => {
    const orgId = `audit-test-${Date.now()}`;
    const stub = env.TENANT.get(env.TENANT.idFromName(orgId));
    const response = await stub.fetch("http://do/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: "user-123",
        action: "clio_create",
        object_type: "matter",
        params: { name: "Test Matter" },
        result: "success",
      }),
    });
    expect(((await response.json()) as { id: string }).id).toBeDefined();
  });

  it("stores each entry as separate R2 object", async () => {
    const orgId = `separate-test-${Date.now()}`;
    const id = env.TENANT.idFromName(orgId);
    const stub = env.TENANT.get(id);

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
      id.toString(),
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate()
    );
    expect((await env.R2.list({ prefix })).objects.length).toBe(2);
  });
});

describe.skip("Vectorize Metadata Filtering", () => {
  it("generates embeddings and stores with metadata", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "test document",
    })) as { data: number[][] };
    expect(data[0].length).toBe(768);

    const testId = `vec-test-${Date.now()}`;
    await env.VECTORIZE.upsert([
      {
        id: testId,
        values: data[0],
        metadata: { type: "test", source: "integration-test" },
      },
    ]);
    expect(
      (await env.VECTORIZE.query(data[0], { topK: 1, returnMetadata: "all" }))
        .matches.length
    ).toBeGreaterThan(0);
  });

  it("filters org context by org_id", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "firm billing",
    })) as { data: number[][] };
    const ts = Date.now();
    await env.VECTORIZE.upsert([
      {
        id: `org_acme_${ts}`,
        values: data[0],
        metadata: { type: "org_context", org_id: "acme" },
      },
      {
        id: `org_beta_${ts}`,
        values: data[0],
        metadata: { type: "org_context", org_id: "beta" },
      },
    ]);

    const orgIds = (
      await env.VECTORIZE.query(data[0], {
        topK: 10,
        filter: { org_id: "acme" },
        returnMetadata: "all",
      })
    ).matches.map((m) => m.metadata?.org_id);
    expect(orgIds).toContain("acme");
    expect(orgIds).not.toContain("beta");
  });

  it("retrieves KB content without org filter", async () => {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "clio workflow",
    })) as { data: number[][] };
    await env.VECTORIZE.upsert([
      {
        id: `kb_shared_${Date.now()}`,
        values: data[0],
        metadata: { type: "kb", source: "clio-workflows.md" },
      },
    ]);
    expect(
      (
        await env.VECTORIZE.query(data[0], {
          topK: 5,
          filter: { type: "kb" },
          returnMetadata: "all",
        })
      ).matches.map((m) => m.metadata?.type)
    ).toContain("kb");
  });
});
