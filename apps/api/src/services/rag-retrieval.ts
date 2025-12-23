import { Env } from "../types/env";
import { KB_CONFIG } from "../config/kb";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OrgSettings {
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: string | null;
}

interface ChunkWithSource {
  content: string;
  source: string;
}

interface RAGContext {
  kbChunks: ChunkWithSource[];
  orgChunks: ChunkWithSource[];
}

interface VectorMatch {
  id: string;
  score: number;
}

const MAX_FILTER_VALUES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retrieves relevant context for a query from both the knowledge base
 * and organization-specific documents.
 */
export async function retrieveRAGContext(
  env: Env,
  query: string,
  orgId: string,
  orgSettings: OrgSettings
): Promise<RAGContext> {
  try {
    // Generate embedding for the query
    const queryVector = await generateQueryEmbedding(env, query);

    // Retrieve from both sources in parallel
    const [kbChunks, orgChunks] = await Promise.all([
      retrieveKBChunks(env, queryVector, orgSettings),
      retrieveOrgChunks(env, queryVector, orgId),
    ]);

    // Apply token budget to avoid exceeding context limits
    return applyTokenBudget({ kbChunks, orgChunks });
  } catch (error) {
    console.error("[RAG] Retrieval error:", error);
    return { kbChunks: [], orgChunks: [] };
  }
}

/**
 * Formats RAG context into a string suitable for the LLM prompt.
 */
export function formatRAGContext(context: RAGContext): string {
  const sections: string[] = [];

  if (context.kbChunks.length > 0) {
    const kbContent = formatChunks(context.kbChunks);
    sections.push(`## Knowledge Base\n\n${kbContent}`);
  }

  if (context.orgChunks.length > 0) {
    const orgContent = formatChunks(context.orgChunks);
    sections.push(`## Firm Context\n\n${orgContent}`);
  }

  return sections.join("\n\n");
}

function formatChunks(chunks: ChunkWithSource[]): string {
  return chunks
    .map(
      (chunk) =>
        `<document source="${chunk.source}">\n${chunk.content}\n</document>`
    )
    .join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding Generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateQueryEmbedding(
  env: Env,
  query: string
): Promise<number[]> {
  const result = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [query],
  })) as { data: number[][] };

  return result.data[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base Retrieval
// ─────────────────────────────────────────────────────────────────────────────

async function retrieveKBChunks(
  env: Env,
  queryVector: number[],
  orgSettings: OrgSettings
): Promise<ChunkWithSource[]> {
  // Build filters based on org settings
  const filters = buildKBFilters(orgSettings);

  // Query with each filter in parallel
  const filterPromises = filters.map((filter) =>
    queryVectorize(env, queryVector, filter)
  );
  const allResults = await Promise.all(filterPromises);

  // Merge results, keeping best score per chunk
  const bestScores = mergeVectorResults(allResults);

  // Get top chunk IDs
  const topChunkIds = getTopChunkIds(bestScores, 5);

  if (topChunkIds.length === 0) {
    return [];
  }

  // Fetch chunk content from database
  return fetchKBChunksFromDB(env, topChunkIds);
}

function buildKBFilters(
  orgSettings: OrgSettings
): VectorizeVectorMetadataFilter[] {
  const filters: VectorizeVectorMetadataFilter[] = [
    // Always include general and federal content
    { type: "kb", category: "general" },
    { type: "kb", jurisdiction: "federal" },
  ];

  // Add jurisdiction-specific filter
  if (orgSettings.jurisdictions.length > 0) {
    const jurisdictions = orgSettings.jurisdictions.slice(0, MAX_FILTER_VALUES);
    filters.push({
      type: "kb",
      jurisdiction: { $in: jurisdictions },
    });
  }

  // Add practice type filter
  if (orgSettings.practiceTypes.length > 0) {
    const practiceTypes = orgSettings.practiceTypes.slice(0, MAX_FILTER_VALUES);
    filters.push({
      type: "kb",
      practice_type: { $in: practiceTypes },
    });
  }

  // Add firm size filter
  if (orgSettings.firmSize) {
    filters.push({
      type: "kb",
      firm_size: orgSettings.firmSize,
    });
  }

  return filters;
}

async function queryVectorize(
  env: Env,
  queryVector: number[],
  filter: VectorizeVectorMetadataFilter
): Promise<VectorMatch[]> {
  const results = await env.VECTORIZE.query(queryVector, {
    topK: KB_CONFIG.KB_TOP_K,
    returnMetadata: "all",
    filter,
  });

  return results.matches.map((match) => ({
    id: match.id,
    score: match.score,
  }));
}

function mergeVectorResults(resultSets: VectorMatch[][]): Map<string, number> {
  const bestScores = new Map<string, number>();

  for (const results of resultSets) {
    for (const match of results) {
      const currentBest = bestScores.get(match.id);

      if (currentBest === undefined || match.score > currentBest) {
        bestScores.set(match.id, match.score);
      }
    }
  }

  return bestScores;
}

function getTopChunkIds(scores: Map<string, number>, limit: number): string[] {
  // Sort by score descending
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);

  // Take top N
  return sorted.slice(0, limit).map(([id]) => id);
}

async function fetchKBChunksFromDB(
  env: Env,
  chunkIds: string[]
): Promise<ChunkWithSource[]> {
  // Build parameterized query
  const placeholders = chunkIds.map(() => "?").join(",");
  const query = `SELECT id, content, source FROM kb_chunks WHERE id IN (${placeholders})`;

  const result = await env.DB.prepare(query)
    .bind(...chunkIds)
    .all<{ id: string; content: string; source: string }>();

  // Create lookup map for ordering
  const chunkById = new Map<string, { content: string; source: string }>();
  for (const chunk of result.results) {
    chunkById.set(chunk.id, { content: chunk.content, source: chunk.source });
  }

  // Return in original order (by relevance score)
  const orderedChunks: ChunkWithSource[] = [];
  for (const id of chunkIds) {
    const chunk = chunkById.get(id);
    if (chunk) {
      orderedChunks.push(chunk);
    }
  }

  return orderedChunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization Context Retrieval
// ─────────────────────────────────────────────────────────────────────────────

async function retrieveOrgChunks(
  env: Env,
  queryVector: number[],
  orgId: string
): Promise<ChunkWithSource[]> {
  // Query for org-specific chunks
  const results = await env.VECTORIZE.query(queryVector, {
    topK: 5,
    returnMetadata: "all",
    filter: { type: "org", org_id: orgId },
  });

  if (results.matches.length === 0) {
    return [];
  }

  // Fetch chunk content from database
  const chunkIds = results.matches.map((match) => match.id);
  const placeholders = chunkIds.map(() => "?").join(",");

  const query = `SELECT content, source FROM org_context_chunks WHERE id IN (${placeholders}) AND org_id = ?`;

  const result = await env.DB.prepare(query)
    .bind(...chunkIds, orgId)
    .all<{ content: string; source: string }>();

  return result.results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Budget Management
// ─────────────────────────────────────────────────────────────────────────────

function applyTokenBudget(context: RAGContext): RAGContext {
  const maxChars = KB_CONFIG.TOKEN_BUDGET * KB_CONFIG.CHARS_PER_TOKEN;
  let remainingBudget = maxChars;

  const result: RAGContext = {
    kbChunks: [],
    orgChunks: [],
  };

  // Add KB chunks until budget exhausted
  for (const chunk of context.kbChunks) {
    const chunkSize = estimateChunkSize(chunk);

    if (chunkSize <= remainingBudget) {
      result.kbChunks.push(chunk);
      remainingBudget -= chunkSize;
    }
  }

  // Add org chunks with remaining budget
  for (const chunk of context.orgChunks) {
    const chunkSize = estimateChunkSize(chunk);

    if (chunkSize <= remainingBudget) {
      result.orgChunks.push(chunk);
      remainingBudget -= chunkSize;
    }
  }

  return result;
}

function estimateChunkSize(chunk: ChunkWithSource): number {
  // Content + source + XML tags overhead
  return chunk.content.length + chunk.source.length + 20;
}
