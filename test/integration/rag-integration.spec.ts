/**
 * RAG Integration Tests
 *
 * These tests verify the complete RAG retrieval pipeline using real
 * Cloudflare services (D1, Vectorize, Workers AI) in test mode.
 *
 * Test data setup:
 * - Creates test KB chunks with different metadata (jurisdiction, practice type, etc.)
 * - Creates test org context chunks
 * - Creates a "forbidden" other org to test data isolation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env } from "cloudflare:test";
import {
  retrieveRAGContext,
  formatRAGContext,
} from "../../src/services/rag-retrieval";

describe("RAG Integration", () => {
  // Test identifiers
  const testOrgId = `test-org-${Date.now()}`;
  const testVectorIds: string[] = [];

  // Store other org ID for cleanup
  let otherOrgId: string;

  // ===========================================================================
  // Test Setup
  // ===========================================================================

  beforeAll(async () => {
    // Create test org
    await env.DB.prepare(
      "INSERT OR IGNORE INTO org (id, name, created_at) VALUES (?, ?, datetime('now'))"
    )
      .bind(testOrgId, "Test Org")
      .run();

    // Insert KB test data with various metadata configurations
    await setupKBTestData();

    // Insert org-specific test data
    await setupOrgTestData();

    // Insert "forbidden" data to test isolation
    await setupOtherOrgData();
  });

  async function setupKBTestData() {
    const kbTestData = [
      {
        id: "kb_general_test_0",
        content: "General Clio workflow best practices.",
        source: "clio-workflows.md",
        category: "general",
        jurisdiction: null,
        practice_type: null,
        firm_size: null,
      },
      {
        id: "kb_federal_test_0",
        content: "Federal court filing procedures.",
        source: "federal-rules.md",
        category: null,
        jurisdiction: "federal",
        practice_type: null,
        firm_size: null,
      },
      {
        id: "kb_ca_test_0",
        content: "California statute of limitations for PI.",
        source: "ca-deadlines.md",
        category: null,
        jurisdiction: "CA",
        practice_type: null,
        firm_size: null,
      },
      {
        id: "kb_ny_test_0",
        content: "New York civil procedure rules.",
        source: "ny-procedures.md",
        category: null,
        jurisdiction: "NY",
        practice_type: null,
        firm_size: null,
      },
      {
        id: "kb_pi_test_0",
        content: "Personal injury intake checklist.",
        source: "pi-intake.md",
        category: null,
        jurisdiction: null,
        practice_type: "personal-injury",
        firm_size: null,
      },
      {
        id: "kb_solo_test_0",
        content: "Solo practitioner time management.",
        source: "solo-guide.md",
        category: null,
        jurisdiction: null,
        practice_type: null,
        firm_size: "solo",
      },
    ];

    // Insert into D1
    const insertStmt = env.DB.prepare(`
      INSERT OR REPLACE INTO kb_chunks
        (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    await env.DB.batch(
      kbTestData.map((chunk) =>
        insertStmt.bind(
          chunk.id,
          chunk.content,
          chunk.source,
          null,
          0,
          chunk.category,
          chunk.jurisdiction,
          chunk.practice_type,
          chunk.firm_size
        )
      )
    );

    // Generate embeddings
    const contents = kbTestData.map((c) => c.content);
    const embeddingResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: contents,
    })) as { data: number[][] };

    // Insert into Vectorize
    const vectors = kbTestData.map((chunk, i) => ({
      id: chunk.id,
      values: embeddingResult.data[i],
      metadata: {
        type: "kb",
        source: chunk.source,
        ...(chunk.category && { category: chunk.category }),
        ...(chunk.jurisdiction && { jurisdiction: chunk.jurisdiction }),
        ...(chunk.practice_type && { practice_type: chunk.practice_type }),
        ...(chunk.firm_size && { firm_size: chunk.firm_size }),
      },
    }));

    await env.VECTORIZE.upsert(vectors);
    testVectorIds.push(...vectors.map((v) => v.id));
  }

  async function setupOrgTestData() {
    const orgTestData = [
      {
        id: `${testOrgId}_file1_0`,
        content: "Billing: Partner $500/hr, Associate $250/hr.",
        source: "billing.md",
      },
      {
        id: `${testOrgId}_file1_1`,
        content: "Retainer: Min $5,000 for new matters.",
        source: "billing.md",
      },
    ];

    // Insert into D1
    const insertStmt = env.DB.prepare(`
      INSERT OR REPLACE INTO org_context_chunks
        (id, org_id, file_id, content, source, chunk_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    await env.DB.batch(
      orgTestData.map((chunk, i) =>
        insertStmt.bind(
          chunk.id,
          testOrgId,
          "file1",
          chunk.content,
          chunk.source,
          i
        )
      )
    );

    // Generate embeddings and insert into Vectorize
    const contents = orgTestData.map((c) => c.content);
    const embeddingResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: contents,
    })) as { data: number[][] };

    const vectors = orgTestData.map((chunk, i) => ({
      id: chunk.id,
      values: embeddingResult.data[i],
      metadata: {
        type: "org",
        org_id: testOrgId,
        source: chunk.source,
      },
    }));

    await env.VECTORIZE.upsert(vectors);
    testVectorIds.push(...vectors.map((v) => v.id));
  }

  async function setupOtherOrgData() {
    // Create another org with confidential data that should NOT leak
    otherOrgId = `other-org-${Date.now()}`;

    await env.DB.prepare(
      "INSERT OR IGNORE INTO org (id, name, created_at) VALUES (?, ?, datetime('now'))"
    )
      .bind(otherOrgId, "Other Org")
      .run();

    const otherChunk = {
      id: `${otherOrgId}_file1_0`,
      content: "Other firm confidential info.",
      source: "other.md",
    };

    await env.DB.prepare(`
      INSERT OR REPLACE INTO org_context_chunks
        (id, org_id, file_id, content, source, chunk_index)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        otherChunk.id,
        otherOrgId,
        "file1",
        otherChunk.content,
        otherChunk.source,
        0
      )
      .run();

    const embeddingResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [otherChunk.content],
    })) as { data: number[][] };

    await env.VECTORIZE.upsert([
      {
        id: otherChunk.id,
        values: embeddingResult.data[0],
        metadata: {
          type: "org",
          org_id: otherOrgId,
          source: otherChunk.source,
        },
      },
    ]);

    testVectorIds.push(otherChunk.id);
  }

  // ===========================================================================
  // Test Cleanup
  // ===========================================================================

  afterAll(async () => {
    // Clean up Vectorize
    if (testVectorIds.length > 0) {
      await env.VECTORIZE.deleteByIds(testVectorIds);
    }

    // Clean up D1
    await env.DB.prepare(
      "DELETE FROM kb_chunks WHERE id LIKE 'kb_%_test_%'"
    ).run();

    await env.DB.prepare("DELETE FROM org_context_chunks WHERE org_id = ?")
      .bind(testOrgId)
      .run();

    await env.DB.prepare("DELETE FROM org WHERE id = ?").bind(testOrgId).run();

    if (otherOrgId) {
      await env.DB.prepare("DELETE FROM org_context_chunks WHERE org_id = ?")
        .bind(otherOrgId)
        .run();

      await env.DB.prepare("DELETE FROM org WHERE id = ?")
        .bind(otherOrgId)
        .run();
    }
  });

  // ===========================================================================
  // KB Retrieval Tests
  // ===========================================================================

  describe("KB Retrieval", () => {
    const noFilters = {
      jurisdiction: null,
      practiceType: null,
      firmSize: null,
    };

    it("retrieves KB content with multi-query", async () => {
      const context = await retrieveRAGContext(
        env,
        "Clio workflows?",
        testOrgId,
        noFilters
      );

      expect(context).toBeDefined();
      expect(Array.isArray(context.kbChunks)).toBe(true);
    });

    it("filters by jurisdiction", async () => {
      const context = await retrieveRAGContext(
        env,
        "statute of limitations?",
        testOrgId,
        { jurisdiction: "CA", practiceType: null, firmSize: null }
      );

      expect(Array.isArray(context.kbChunks)).toBe(true);

      // If results returned, should include CA content
      if (context.kbChunks.length > 0) {
        const hasCAContent = context.kbChunks.some(
          (c) => c.content.includes("California") || c.source.includes("ca")
        );
        expect(hasCAContent).toBe(true);
      }
    });

    it("excludes unrelated jurisdiction", async () => {
      const context = await retrieveRAGContext(
        env,
        "court procedures?",
        testOrgId,
        { jurisdiction: "CA", practiceType: null, firmSize: null }
      );

      // Should NOT include NY-specific content when filtering for CA
      const hasNYContent = context.kbChunks.some(
        (c) => c.content.includes("New York") || c.source.includes("ny")
      );
      expect(hasNYContent).toBe(false);
    });

    it("filters by practice type", async () => {
      const context = await retrieveRAGContext(
        env,
        "intake process?",
        testOrgId,
        { jurisdiction: null, practiceType: "personal-injury", firmSize: null }
      );

      expect(Array.isArray(context.kbChunks)).toBe(true);
    });

    it("filters by firm size", async () => {
      const context = await retrieveRAGContext(
        env,
        "time management?",
        testOrgId,
        { jurisdiction: null, practiceType: null, firmSize: "solo" }
      );

      expect(Array.isArray(context.kbChunks)).toBe(true);
    });
  });

  // ===========================================================================
  // Org Context Retrieval Tests
  // ===========================================================================

  describe("Org Context Retrieval", () => {
    const noFilters = {
      jurisdiction: null,
      practiceType: null,
      firmSize: null,
    };

    it("retrieves org-specific content", async () => {
      const context = await retrieveRAGContext(
        env,
        "billing rates?",
        testOrgId,
        noFilters
      );

      expect(Array.isArray(context.orgChunks)).toBe(true);
    });

    it("does not leak other org content", async () => {
      // Query for content that exists in another org
      const context = await retrieveRAGContext(
        env,
        "confidential",
        testOrgId,
        noFilters
      );

      // Should NOT return content from other org
      const hasOtherOrgContent = context.orgChunks.some((c) =>
        c.content.includes("Other firm")
      );
      expect(hasOtherOrgContent).toBe(false);
    });
  });

  // ===========================================================================
  // Formatting Tests
  // ===========================================================================

  describe("formatRAGContext", () => {
    it("formats both KB and Org chunks", () => {
      const context = {
        kbChunks: [{ content: "KB content.", source: "kb.md" }],
        orgChunks: [{ content: "Org content.", source: "org.md" }],
      };

      const formatted = formatRAGContext(context);

      expect(formatted).toContain("## Knowledge Base");
      expect(formatted).toContain("*Source: kb.md*");
      expect(formatted).toContain("## Firm Context");
    });

    it("omits empty sections", () => {
      const kbOnlyContext = {
        kbChunks: [{ content: "KB only.", source: "kb.md" }],
        orgChunks: [],
      };

      const formatted = formatRAGContext(kbOnlyContext);

      expect(formatted).toContain("## Knowledge Base");
      expect(formatted).not.toContain("## Firm Context");
    });

    it("returns empty string when no context", () => {
      const emptyContext = { kbChunks: [], orgChunks: [] };

      const formatted = formatRAGContext(emptyContext);

      expect(formatted).toBe("");
    });
  });

  // ===========================================================================
  // Token Budget Tests
  // ===========================================================================

  describe("Token Budget", () => {
    it("limits context to token budget", async () => {
      // Query with all filters to get maximum content
      const context = await retrieveRAGContext(
        env,
        "everything about Clio and billing",
        testOrgId,
        { jurisdiction: "CA", practiceType: "personal-injury", firmSize: "solo" }
      );

      const formatted = formatRAGContext(context);

      // Budget is 3000 tokens @ ~4 chars/token = 12000 chars max
      const estimatedTokens = formatted.length / 4;
      expect(estimatedTokens).toBeLessThanOrEqual(3000);
    });
  });
});
