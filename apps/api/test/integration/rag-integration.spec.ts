import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env } from "cloudflare:test";
import {
  retrieveRAGContext,
  formatRAGContext,
} from "../../src/services/rag-retrieval";

// ============================================================================
// Test Configuration
// ============================================================================

const integrationEnabled = !!(env as { INTEGRATION_TESTS_ENABLED?: boolean })
  .INTEGRATION_TESTS_ENABLED;

// Generate unique IDs for this test run to avoid collisions
const testOrgId = `test-org-${Date.now()}`;
let otherOrgId: string;

// Track vector IDs so we can clean them up
const testVectorIds: string[] = [];

// Default org settings with no filters
const noFilters = {
  jurisdictions: [],
  practiceTypes: [],
  firmSize: null,
};

// ============================================================================
// Types
// ============================================================================

interface KBChunk {
  id: string;
  content: string;
  source: string;
  category: string | null;
  jurisdiction: string | null;
  practice_type: string | null;
  firm_size: string | null;
}

interface OrgChunk {
  id: string;
  content: string;
  source: string;
}

// ============================================================================
// Test Data
// ============================================================================

/**
 * Knowledge Base test chunks covering different filter scenarios:
 * - General content (always included)
 * - Federal content (always included)
 * - State-specific content (CA, NY)
 * - Practice-type content (personal injury)
 * - Firm-size content (solo)
 */
const kbTestChunks: KBChunk[] = [
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

/**
 * Organization-specific test chunks for testing org context isolation.
 */
const orgTestChunks: OrgChunk[] = [
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

// ============================================================================
// Test Setup Helpers
// ============================================================================

/**
 * Creates an organization in the database.
 */
async function createTestOrg(orgId: string, name: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO org (id, name, created_at) VALUES (?, ?, datetime('now'))"
  )
    .bind(orgId, name)
    .run();
}

/**
 * Inserts KB chunks into the database.
 */
async function insertKBChunks(chunks: KBChunk[]): Promise<void> {
  const insertStatement = env.DB.prepare(`
    INSERT OR REPLACE INTO kb_chunks
    (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const statements = chunks.map((chunk) =>
    insertStatement.bind(
      chunk.id,
      chunk.content,
      chunk.source,
      null, // section
      0, // chunk_index
      chunk.category,
      chunk.jurisdiction,
      chunk.practice_type,
      chunk.firm_size
    )
  );

  await env.DB.batch(statements);
}

/**
 * Inserts org context chunks into the database.
 */
async function insertOrgChunks(
  orgId: string,
  chunks: OrgChunk[]
): Promise<void> {
  const insertStatement = env.DB.prepare(`
    INSERT OR REPLACE INTO org_context_chunks
    (id, org_id, file_id, content, source, chunk_index)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const statements = chunks.map((chunk, index) =>
    insertStatement.bind(
      chunk.id,
      orgId,
      "file1",
      chunk.content,
      chunk.source,
      index
    )
  );

  await env.DB.batch(statements);
}

/**
 * Generates embeddings for an array of text strings.
 */
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const result = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: texts,
  })) as { data: number[][] };

  return result.data;
}

/**
 * Upserts vectors into the Vectorize index.
 */
async function upsertVectors(
  chunks: (KBChunk | OrgChunk)[],
  type: "kb" | "org",
  orgId?: string
): Promise<void> {
  const texts = chunks.map((chunk) => chunk.content);
  const embeddings = await generateEmbeddings(texts);

  const vectors = chunks.map((chunk, index) => {
    // Build metadata based on chunk type
    const metadata: Record<string, string> = {};

    if (type === "kb") {
      const kbChunk = chunk as KBChunk;
      metadata.type = "kb";
      metadata.source = kbChunk.source;

      // Only add optional fields if they have values
      if (kbChunk.category) {
        metadata.category = kbChunk.category;
      }
      if (kbChunk.jurisdiction) {
        metadata.jurisdiction = kbChunk.jurisdiction;
      }
      if (kbChunk.practice_type) {
        metadata.practice_type = kbChunk.practice_type;
      }
      if (kbChunk.firm_size) {
        metadata.firm_size = kbChunk.firm_size;
      }
    } else {
      metadata.type = "org";
      metadata.org_id = orgId!;
      metadata.source = chunk.source;
    }

    return {
      id: chunk.id,
      values: embeddings[index],
      metadata,
    };
  });

  await env.VECTORIZE.upsert(vectors);

  // Track IDs for cleanup
  for (const vector of vectors) {
    testVectorIds.push(vector.id);
  }
}

/**
 * Cleans up all test data after tests complete.
 */
async function cleanupTestData(): Promise<void> {
  // Delete vectors from Vectorize
  if (testVectorIds.length > 0) {
    await env.VECTORIZE.deleteByIds(testVectorIds);
  }

  // Delete KB chunks
  await env.DB.prepare(
    "DELETE FROM kb_chunks WHERE id LIKE 'kb_%_test_%'"
  ).run();

  // Delete test org data
  await env.DB.prepare("DELETE FROM org_context_chunks WHERE org_id = ?")
    .bind(testOrgId)
    .run();
  await env.DB.prepare("DELETE FROM org WHERE id = ?").bind(testOrgId).run();

  // Delete "other org" data if it was created
  if (otherOrgId) {
    await env.DB.prepare("DELETE FROM org_context_chunks WHERE org_id = ?")
      .bind(otherOrgId)
      .run();
    await env.DB.prepare("DELETE FROM org WHERE id = ?").bind(otherOrgId).run();
  }
}

// ============================================================================
// Tests
// ============================================================================

// Track whether Vectorize filtering works in this environment
let vectorizeFilteringWorks = false;

describe.skipIf(!integrationEnabled)("RAG Integration", () => {
  beforeAll(async () => {
    // Set up the test organization
    await createTestOrg(testOrgId, "Test Org");

    // Insert and vectorize KB chunks
    await insertKBChunks(kbTestChunks);
    await upsertVectors(kbTestChunks, "kb");

    // Insert and vectorize org context chunks
    await insertOrgChunks(testOrgId, orgTestChunks);
    await upsertVectors(orgTestChunks, "org", testOrgId);

    // Create another org to test isolation
    otherOrgId = `other-org-${Date.now()}`;
    await createTestOrg(otherOrgId, "Other Org");

    const otherOrgChunk: OrgChunk = {
      id: `${otherOrgId}_file1_0`,
      content: "Other firm confidential info.",
      source: "other.md",
    };

    await insertOrgChunks(otherOrgId, [otherOrgChunk]);
    await upsertVectors([otherOrgChunk], "org", otherOrgId);

    // Check if Vectorize filtering works in this environment
    vectorizeFilteringWorks = await checkVectorizeFiltering();
  }, 60000);

  /**
   * Checks if Vectorize metadata filtering works in this environment.
   * vitest-pool-workers may not fully support metadata filtering.
   */
  async function checkVectorizeFiltering(): Promise<boolean> {
    // Wait for vectors to be indexed in remote Vectorize
    // Remote indexing requires eventual consistency (30-60+ seconds)
    await new Promise((r) => setTimeout(r, 45000));

    // Generate a test embedding
    const embResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["Clio workflow"],
    })) as { data: number[][] };
    const testVector = embResult.data[0];

    // Try filtered query
    const filtered = await env.VECTORIZE.query(testVector, {
      topK: 5,
      filter: { type: "kb" },
    });

    // Try unfiltered query
    const unfiltered = await env.VECTORIZE.query(testVector, {
      topK: 5,
    });

    if (unfiltered.matches.length > 0 && filtered.matches.length === 0) {
      console.warn(
        "\n⚠️  Vectorize filtering not working in test environment.\n" +
          "   RAG filter tests will be skipped. This is a known limitation.\n"
      );
      return false;
    }

    return filtered.matches.length > 0;
  }

  /**
   * Skip test if Vectorize filtering doesn't work
   */
  function requireFiltering(): void {
    if (!vectorizeFilteringWorks) {
      throw new Error(
        "SKIPPED: Vectorize metadata filtering not available in test environment"
      );
    }
  }

  afterAll(cleanupTestData);

  // --------------------------------------------------------------------------
  // Knowledge Base Retrieval Tests
  // --------------------------------------------------------------------------

  describe("Knowledge Base Retrieval", () => {
    it("retrieves KB content for a relevant query", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "Clio workflows?",
        testOrgId,
        noFilters
      );

      expect(context.kbChunks.length).toBeGreaterThan(0);
    });

    it("includes jurisdiction-specific content when filtered", async () => {
      requireFiltering();
      const context = await retrieveRAGContext(
        env,
        "statute of limitations?",
        testOrgId,
        { jurisdictions: ["CA"], practiceTypes: [], firmSize: null }
      );

      const hasCaliforniaContent = context.kbChunks.some(
        (chunk) =>
          chunk.content.includes("California") || chunk.source.includes("ca")
      );

      expect(hasCaliforniaContent).toBe(true);
    });

    it("excludes unrelated jurisdiction content", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "court procedures?",
        testOrgId,
        { jurisdictions: ["CA"], practiceTypes: [], firmSize: null }
      );

      const hasNewYorkContent = context.kbChunks.some(
        (chunk) =>
          chunk.content.includes("New York") || chunk.source.includes("ny")
      );

      expect(hasNewYorkContent).toBe(false);
    });

    it("filters by practice type", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "intake process?",
        testOrgId,
        {
          jurisdictions: [],
          practiceTypes: ["personal-injury"],
          firmSize: null,
        }
      );

      const hasPersonalInjuryContent = context.kbChunks.some((chunk) =>
        chunk.source.includes("pi")
      );

      expect(hasPersonalInjuryContent).toBe(true);
    });

    it("filters by firm size", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "time management?",
        testOrgId,
        { jurisdictions: [], practiceTypes: [], firmSize: "solo" }
      );

      const hasSoloContent = context.kbChunks.some((chunk) =>
        chunk.source.includes("solo")
      );

      expect(hasSoloContent).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Organization Context Retrieval Tests
  // --------------------------------------------------------------------------

  describe("Org Context Retrieval", () => {
    it("retrieves org-specific content", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "billing rates?",
        testOrgId,
        noFilters
      );

      const hasBillingContent = context.orgChunks.some((chunk) =>
        chunk.content.includes("Billing")
      );

      expect(hasBillingContent).toBe(true);
    });

    it("does not leak content from other organizations", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "confidential",
        testOrgId,
        noFilters
      );

      const hasOtherOrgContent = context.orgChunks.some((chunk) =>
        chunk.content.includes("Other firm")
      );

      expect(hasOtherOrgContent).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Context Formatting Tests
  // --------------------------------------------------------------------------

  describe("Context Formatting", () => {
    it("formats both KB and Org sections", () => {
      const formatted = formatRAGContext({
        kbChunks: [{ content: "KB.", source: "kb.md" }],
        orgChunks: [{ content: "Org.", source: "org.md" }],
      });

      expect(formatted).toContain("## Knowledge Base");
      expect(formatted).toContain("## Firm Context");
    });

    it("omits empty sections", () => {
      const formatted = formatRAGContext({
        kbChunks: [{ content: "KB.", source: "kb.md" }],
        orgChunks: [],
      });

      expect(formatted).toContain("## Knowledge Base");
      expect(formatted).not.toContain("## Firm Context");
    });

    it("returns empty string when no context", () => {
      const formatted = formatRAGContext({
        kbChunks: [],
        orgChunks: [],
      });

      expect(formatted).toBe("");
    });
  });

  // --------------------------------------------------------------------------
  // Token Budget Tests
  // --------------------------------------------------------------------------

  describe("Token Budget", () => {
    it("limits context to token budget", async () => {
      requireFiltering();

      const context = await retrieveRAGContext(
        env,
        "everything about Clio and billing",
        testOrgId,
        {
          jurisdictions: ["CA"],
          practiceTypes: ["personal-injury"],
          firmSize: "solo",
        }
      );

      const formatted = formatRAGContext(context);

      // Rough estimate: 4 chars per token, budget is 3000 tokens
      const estimatedTokens = formatted.length / 4;
      expect(estimatedTokens).toBeLessThanOrEqual(3000);
    });
  });
});
