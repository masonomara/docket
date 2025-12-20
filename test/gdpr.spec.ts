import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  hashUserId,
  checkSoleOwnerships,
  deleteUserData,
  getDataDeletionPreview,
  type SoleOwnershipError,
} from "../src/services/gdpr";

describe("GDPR Deletion", () => {
  describe("hashUserId", () => {
    it("produces consistent hash for same input", () => {
      expect(hashUserId("user-123")).toBe(hashUserId("user-123"));
    });

    it("produces different hashes for different inputs", () => {
      expect(hashUserId("user-123")).not.toBe(hashUserId("user-456"));
    });

    it("produces 8-character hex string", () => {
      expect(hashUserId("any-user-id")).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe("checkSoleOwnerships", () => {
    it("returns empty array when user owns no orgs", async () => {
      const userId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          "No Orgs User",
          `no-orgs-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        )
        .run();
      expect(await checkSoleOwnerships(env.DB, userId)).toEqual([]);
    });

    it("returns org ID when user is sole owner", async () => {
      const userId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          "Sole Owner",
          `sole-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
        .bind(orgId, "Sole Org", Date.now(), Date.now())
        .run();
      await env.DB.prepare(
        `INSERT INTO org_members (id, org_id, user_id, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), orgId, userId, "admin", 1, Date.now())
        .run();
      expect(await checkSoleOwnerships(env.DB, userId)).toContain(orgId);
    });

    it("returns empty when org has multiple owners", async () => {
      const userId1 = crypto.randomUUID();
      const userId2 = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          userId1,
          "Owner 1",
          `owner1-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        ),
        env.DB.prepare(
          `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          userId2,
          "Owner 2",
          `owner2-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        ),
      ]);
      await env.DB.prepare(
        `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
        .bind(orgId, "Multi Owner Org", Date.now(), Date.now())
        .run();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO org_members (id, org_id, user_id, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), orgId, userId1, "admin", 1, Date.now()),
        env.DB.prepare(
          `INSERT INTO org_members (id, org_id, user_id, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), orgId, userId2, "admin", 1, Date.now()),
      ]);
      expect(await checkSoleOwnerships(env.DB, userId1)).toEqual([]);
    });
  });

  describe("deleteUserData", () => {
    it("deletes user and all related records", async () => {
      const userId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          "Delete Me",
          `delete-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          userId,
          "token-123",
          Date.now() + 86400000,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO account (id, user_id, account_id, provider_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          userId,
          "acc-123",
          "credential",
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO channel_user_links (id, channel_type, channel_user_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), "teams", "29:test", userId, Date.now())
        .run();

      const result = await deleteUserData(env.DB, env.R2, userId);
      expect(result).not.toHaveProperty("type");
      const gdprResult = result as {
        success: boolean;
        deletedRecords: {
          user: boolean;
          sessions: number;
          accounts: number;
          channelLinks: number;
        };
      };
      expect(gdprResult.success).toBe(true);
      expect(gdprResult.deletedRecords.user).toBe(true);
      expect(gdprResult.deletedRecords.sessions).toBe(1);
      expect(
        await env.DB.prepare(`SELECT id FROM user WHERE id = ?`)
          .bind(userId)
          .first()
      ).toBeNull();
    });

    it("fails when user is sole owner", async () => {
      const userId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          "Sole Owner Delete",
          `sole-delete-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
        .bind(orgId, "Sole Delete Org", Date.now(), Date.now())
        .run();
      await env.DB.prepare(
        `INSERT INTO org_members (id, org_id, user_id, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), orgId, userId, "admin", 1, Date.now())
        .run();

      const result = await deleteUserData(env.DB, env.R2, userId);
      expect((result as SoleOwnershipError).type).toBe("sole_owner");
      expect(
        await env.DB.prepare(`SELECT id FROM user WHERE id = ?`)
          .bind(userId)
          .first()
      ).not.toBeNull();
    });

    it("returns error for non-existent user", async () => {
      const result = await deleteUserData(env.DB, env.R2, crypto.randomUUID());
      expect((result as { success: boolean }).success).toBe(false);
      expect((result as { errors: string[] }).errors).toContain(
        "User not found"
      );
    });
  });

  describe("getDataDeletionPreview", () => {
    it("returns count of records to be deleted", async () => {
      const userId = crypto.randomUUID();
      const email = `preview-${Date.now()}@test.com`;
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(userId, "Preview User", email, 1, Date.now(), Date.now())
        .run();
      await env.DB.prepare(
        `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          userId,
          "token-1",
          Date.now() + 86400000,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          userId,
          "token-2",
          Date.now() + 86400000,
          Date.now(),
          Date.now()
        )
        .run();

      const preview = await getDataDeletionPreview(env.DB, userId);
      expect(preview.user?.email).toBe(email);
      expect(preview.sessions).toBe(2);
    });

    it("returns null user for non-existent user", async () => {
      const preview = await getDataDeletionPreview(env.DB, crypto.randomUUID());
      expect(preview.user).toBeNull();
    });

    it("includes sole owner orgs in preview", async () => {
      const userId = crypto.randomUUID();
      const orgId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          "Preview Sole",
          `preview-sole-${Date.now()}@test.com`,
          1,
          Date.now(),
          Date.now()
        )
        .run();
      await env.DB.prepare(
        `INSERT INTO org (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`
      )
        .bind(orgId, "Preview Org", Date.now(), Date.now())
        .run();
      await env.DB.prepare(
        `INSERT INTO org_members (id, org_id, user_id, role, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), orgId, userId, "admin", 1, Date.now())
        .run();

      expect(
        (await getDataDeletionPreview(env.DB, userId)).soleOwnerOrgs
      ).toContain(orgId);
    });
  });
});
