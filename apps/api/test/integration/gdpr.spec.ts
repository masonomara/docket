import { env } from "cloudflare:test";
import { describe, it, expect, afterAll } from "vitest";
import {
  hashUserId,
  checkSoleOwnerships,
  deleteUserData,
  getDataDeletionPreview,
  type SoleOwnershipError,
  type GdprDeleteResult,
} from "../../src/services/gdpr";
import {
  uniqueEmail,
  createTestUser,
  createTestOrg,
  addOrgMember,
  createOrgContextChunk,
  createSession,
  createAccount,
  createChannelLink,
} from "../helpers";
import {
  generateEmbedding,
  VectorTracker,
} from "../helpers";

// Integration tests require CLOUDFLARE_ACCOUNT_ID set in environment
const integrationEnabled = !!(env as { INTEGRATION_TESTS_ENABLED?: boolean })
  .INTEGRATION_TESTS_ENABLED;

describe("GDPR Deletion", () => {
  describe("hashUserId", () => {
    it("produces consistent 16-char hex hash", async () => {
      const hash1 = await hashUserId("user-123");
      const hash2 = await hashUserId("user-123");

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    });

    it("produces different hashes for different users", async () => {
      const hash1 = await hashUserId("user-123");
      const hash2 = await hashUserId("user-456");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("checkSoleOwnerships", () => {
    it("returns empty when user owns no orgs", async () => {
      const user = await createTestUser(env.DB, { email: uniqueEmail("no-orgs") });

      const result = await checkSoleOwnerships(env.DB, user.id);

      expect(result).toEqual([]);
    });

    it("returns org ID when user is sole owner", async () => {
      const user = await createTestUser(env.DB, { email: uniqueEmail("sole") });
      const org = await createTestOrg(env.DB, { name: "Sole Org" });
      await addOrgMember(env.DB, { orgId: org.id, userId: user.id, isOwner: true });

      const result = await checkSoleOwnerships(env.DB, user.id);

      expect(result).toContain(org.id);
    });

    it("returns empty when multiple owners exist", async () => {
      const user1 = await createTestUser(env.DB, { name: "Owner 1", email: uniqueEmail("o1") });
      const user2 = await createTestUser(env.DB, { name: "Owner 2", email: uniqueEmail("o2") });
      const org = await createTestOrg(env.DB, { name: "Multi-Owner Org" });

      await addOrgMember(env.DB, { orgId: org.id, userId: user1.id, isOwner: true });
      await addOrgMember(env.DB, { orgId: org.id, userId: user2.id, isOwner: true });

      const result = await checkSoleOwnerships(env.DB, user1.id);

      expect(result).toEqual([]);
    });
  });

  describe("deleteUserData", () => {
    it("deletes user and related records", async () => {
      const user = await createTestUser(env.DB, {
        email: uniqueEmail("delete"),
        name: "Delete Me",
      });

      await createSession(env.DB, user.id, { token: "tok" });
      await createAccount(env.DB, { userId: user.id, providerId: "credential" });
      await createChannelLink(env.DB, {
        channelType: "teams",
        channelUserId: "29:test",
        userId: user.id,
      });

      const result = (await deleteUserData(
        env.DB,
        env.R2,
        env.VECTORIZE,
        user.id
      )) as {
        success: boolean;
        deletedRecords: { user: boolean; sessions: number };
      };

      expect(result.success).toBe(true);
      expect(result.deletedRecords.user).toBe(true);
      expect(result.deletedRecords.sessions).toBe(1);

      const userCheck = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`)
        .bind(user.id)
        .first();

      expect(userCheck).toBeNull();
    });

    it("fails when user is sole owner", async () => {
      const user = await createTestUser(env.DB, { email: uniqueEmail("sole-del") });
      const org = await createTestOrg(env.DB, { name: "Sole Del Org" });
      await addOrgMember(env.DB, { orgId: org.id, userId: user.id, isOwner: true });

      const result = (await deleteUserData(
        env.DB,
        env.R2,
        env.VECTORIZE,
        user.id
      )) as SoleOwnershipError;

      expect(result.type).toBe("sole_owner");

      const userCheck = await env.DB.prepare(`SELECT id FROM user WHERE id = ?`)
        .bind(user.id)
        .first();

      expect(userCheck).not.toBeNull();
    });

    it("returns error for non-existent user", async () => {
      const result = (await deleteUserData(
        env.DB,
        env.R2,
        env.VECTORIZE,
        crypto.randomUUID()
      )) as { success: boolean; errors: string[] };

      expect(result.success).toBe(false);
      expect(result.errors).toContain("User not found");
    });
  });

  describe("getDataDeletionPreview", () => {
    it("returns count of records", async () => {
      const email = uniqueEmail("preview");
      const user = await createTestUser(env.DB, { email, name: "Preview" });

      await createSession(env.DB, user.id, { token: "t1" });
      await createSession(env.DB, user.id, { token: "t2" });

      const preview = await getDataDeletionPreview(env.DB, user.id);

      expect(preview.user?.email).toBe(email);
      expect(preview.sessions).toBe(2);
    });

    it("returns null user for non-existent", async () => {
      const preview = await getDataDeletionPreview(env.DB, crypto.randomUUID());

      expect(preview.user).toBeNull();
    });

    it("includes sole owner orgs in preview", async () => {
      const user = await createTestUser(env.DB, { email: uniqueEmail("prev-sole") });
      const org = await createTestOrg(env.DB, { name: "Preview Org" });
      await addOrgMember(env.DB, { orgId: org.id, userId: user.id, isOwner: true });

      const preview = await getDataDeletionPreview(env.DB, user.id);

      expect(preview.soleOwnerOrgs).toContain(org.id);
    });
  });
});

// =============================================================================
// Vectorize Integration Tests (require live Vectorize)
// =============================================================================

const vectorTracker = new VectorTracker();

describe.skipIf(!integrationEnabled)("GDPR Vectorize Deletion", () => {
  afterAll(() => vectorTracker.cleanup(env as any));

  it("deletes user's org context chunks from D1 and Vectorize", async () => {
    const user = await createTestUser(env.DB, { email: uniqueEmail("vec-del") });
    const org = await createTestOrg(env.DB, { name: "Vectorize Test Org" });
    const chunkId = `gdpr-vec-test-${Date.now()}`;
    const testContent = "Confidential client billing procedures for GDPR test";

    await createOrgContextChunk(env.DB, {
      id: chunkId,
      orgId: org.id,
      content: testContent,
      uploadedBy: user.id,
    });

    // Verify D1 record exists before deletion
    const beforeCheck = await env.DB.prepare(
      `SELECT id, uploaded_by FROM org_context_chunks WHERE id = ?`
    )
      .bind(chunkId)
      .first<{ id: string; uploaded_by: string }>();
    expect(beforeCheck?.id).toBe(chunkId);
    expect(beforeCheck?.uploaded_by).toBe(user.id);

    // Generate embedding and upsert to Vectorize
    const embedding = await generateEmbedding(env as any, testContent);
    await env.VECTORIZE.upsert([
      {
        id: chunkId,
        values: embedding,
        metadata: { type: "org", org_id: org.id },
      },
    ]);
    vectorTracker.track(chunkId);

    // Execute GDPR deletion
    const result = (await deleteUserData(
      env.DB,
      env.R2,
      env.VECTORIZE,
      user.id
    )) as GdprDeleteResult;

    expect(result.success).toBe(true);
    expect(result.deletedVectorizeChunks).toBe(1);

    // Verify D1 chunk record is deleted
    const afterCheck = await env.DB.prepare(
      `SELECT id FROM org_context_chunks WHERE id = ?`
    )
      .bind(chunkId)
      .first();
    expect(afterCheck).toBeNull();

    // Verify Vectorize deletion
    await new Promise((r) => setTimeout(r, 500));
    const vectorCheck = await env.VECTORIZE.getByIds([chunkId]);
    expect(vectorCheck.length).toBe(0);
  });

  it("handles multiple chunks from same user", async () => {
    const user = await createTestUser(env.DB, { email: uniqueEmail("vec-multi") });
    const org = await createTestOrg(env.DB, { name: "Multi Chunk Org" });
    const baseId = `gdpr-multi-${Date.now()}`;
    const chunkIds = [`${baseId}-0`, `${baseId}-1`, `${baseId}-2`];

    for (let i = 0; i < chunkIds.length; i++) {
      await createOrgContextChunk(env.DB, {
        id: chunkIds[i],
        orgId: org.id,
        content: `Test content chunk ${i}`,
        uploadedBy: user.id,
      });

      const embedding = await generateEmbedding(env as any, `Test content chunk ${i}`);
      await env.VECTORIZE.upsert([
        {
          id: chunkIds[i],
          values: embedding,
          metadata: { type: "org", org_id: org.id },
        },
      ]);
      vectorTracker.track(chunkIds[i]);
    }

    // Verify D1 records exist
    const countBefore = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM org_context_chunks WHERE uploaded_by = ?`
    )
      .bind(user.id)
      .first<{ count: number }>();
    expect(countBefore?.count).toBe(3);

    // Execute GDPR deletion
    const result = (await deleteUserData(
      env.DB,
      env.R2,
      env.VECTORIZE,
      user.id
    )) as GdprDeleteResult;

    expect(result.success).toBe(true);
    expect(result.deletedVectorizeChunks).toBe(3);

    // Verify all D1 records are deleted
    const countAfter = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM org_context_chunks WHERE uploaded_by = ?`
    )
      .bind(user.id)
      .first<{ count: number }>();
    expect(countAfter?.count).toBe(0);
  });
});
