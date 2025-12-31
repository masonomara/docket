import { Env } from "../types/env";
import { KB_CONFIG } from "../config/kb";
import { createLogger } from "../lib/logger";

export interface ChunkWithSource {
  content: string;
  source: string;
  score?: number;
}

export interface RAGContext {
  kbChunks: ChunkWithSource[];
  orgChunks: ChunkWithSource[];
}

export interface OrgSettings {
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: string | null;
}

// Intermediate result types for granular event emission
export interface EmbeddingResult {
  vector: number[];
  durationMs: number;
}

export interface KBSearchResult {
  chunks: ChunkWithSource[];
  filters: {
    jurisdictions?: string[];
    practiceTypes?: string[];
    firmSize?: string;
  };
  durationMs: number;
}

export interface OrgSearchResult {
  chunks: ChunkWithSource[];
  durationMs: number;
}

/**
 * Generate embedding for a query using Workers AI.
 */
export async function generateQueryEmbedding(
  env: Env,
  query: string
): Promise<EmbeddingResult> {
  const startTime = Date.now();

  const embeddingResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [query],
  })) as { data: number[][] };

  return {
    vector: embeddingResult.data[0],
    durationMs: Date.now() - startTime,
  };
}

/**
 * Search the shared Knowledge Base with org-specific filters.
 */
export async function searchKnowledgeBase(
  env: Env,
  queryVector: number[],
  orgSettings: OrgSettings
): Promise<KBSearchResult> {
  const startTime = Date.now();
  const chunks = await retrieveKBChunks(env, queryVector, orgSettings);

  return {
    chunks,
    filters: {
      jurisdictions:
        orgSettings.jurisdictions.length > 0
          ? orgSettings.jurisdictions
          : undefined,
      practiceTypes:
        orgSettings.practiceTypes.length > 0
          ? orgSettings.practiceTypes
          : undefined,
      firmSize: orgSettings.firmSize || undefined,
    },
    durationMs: Date.now() - startTime,
  };
}

/**
 * Search org-specific context.
 */
export async function searchOrgContext(
  env: Env,
  queryVector: number[],
  orgId: string
): Promise<OrgSearchResult> {
  const startTime = Date.now();
  const chunks = await retrieveOrgChunks(env, queryVector, orgId);

  return {
    chunks,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Apply token budget and combine results.
 */
export function finalizeContext(context: RAGContext): RAGContext {
  return applyTokenBudget(context);
}

/**
 * Main entry point for RAG context retrieval.
 * Embeds the query, then fetches relevant chunks from both the
 * shared Knowledge Base and the org-specific context.
 */
export async function retrieveRAGContext(
  env: Env,
  query: string,
  orgId: string,
  orgSettings: OrgSettings
): Promise<RAGContext> {
  const logger = createLogger({ component: "rag-retrieval", orgId });

  try {
    // Generate embedding for the user's query
    const { vector: queryVector } = await generateQueryEmbedding(env, query);

    // Fetch chunks from both sources in parallel
    const [kbResult, orgResult] = await Promise.all([
      searchKnowledgeBase(env, queryVector, orgSettings),
      searchOrgContext(env, queryVector, orgId),
    ]);

    // Trim to fit within token budget
    return applyTokenBudget({
      kbChunks: kbResult.chunks,
      orgChunks: orgResult.chunks,
    });
  } catch (error) {
    logger.error("RAG retrieval failed", { error });
    return { kbChunks: [], orgChunks: [] };
  }
}

/**
 * Formats RAG context into XML-style documents for the LLM prompt.
 */
export function formatRAGContext(context: RAGContext): string {
  const sections: string[] = [];

  if (context.kbChunks.length > 0) {
    const formatted = formatChunks(context.kbChunks);
    sections.push(`## Knowledge Base\n\n${formatted}`);
  }

  if (context.orgChunks.length > 0) {
    const formatted = formatChunks(context.orgChunks);
    sections.push(`## Firm Context\n\n${formatted}`);
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

/**
 * Retrieves relevant chunks from the shared Knowledge Base.
 * Runs multiple filter queries to cover different content types,
 * then deduplicates and returns the top results.
 */
async function retrieveKBChunks(
  env: Env,
  queryVector: number[],
  orgSettings: OrgSettings
): Promise<ChunkWithSource[]> {
  // Build filters for different KB content types
  const filters = buildKBFilters(orgSettings);

  // Query Vectorize with each filter in parallel
  const filterResults = await Promise.all(
    filters.map((filter) => queryVectorize(env, queryVector, filter))
  );

  // Merge results, keeping the best score for each chunk ID
  const bestScoreById = new Map<string, number>();
  for (const results of filterResults) {
    for (const match of results) {
      const currentBest = bestScoreById.get(match.id) ?? -1;
      if (match.score > currentBest) {
        bestScoreById.set(match.id, match.score);
      }
    }
  }

  // Sort by score and take the top results
  const sortedEntries = Array.from(bestScoreById.entries()).sort(
    (a, b) => b[1] - a[1]
  );
  const topEntries = sortedEntries.slice(0, KB_CONFIG.KB_TOP_K);
  const topIds = topEntries.map(([id]) => id);
  const scoreById = new Map(topEntries);

  if (topIds.length === 0) {
    return [];
  }

  // Fetch the actual chunk content from D1
  return fetchKBChunksFromDB(env, topIds, scoreById);
}

function buildKBFilters(
  orgSettings: OrgSettings
): VectorizeVectorMetadataFilter[] {
  const filters: VectorizeVectorMetadataFilter[] = [
    { type: "kb", category: "general" },
    { type: "kb", jurisdiction: "federal" },
  ];

  // Add jurisdiction-specific filter if the org has jurisdictions set
  if (orgSettings.jurisdictions.length > 0) {
    filters.push({
      type: "kb",
      jurisdiction: { $in: orgSettings.jurisdictions.slice(0, 5) },
    });
  }

  // Add practice type filter if the org has practice types set
  if (orgSettings.practiceTypes.length > 0) {
    filters.push({
      type: "kb",
      practice_type: { $in: orgSettings.practiceTypes.slice(0, 5) },
    });
  }

  // Add firm size filter if set
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
): Promise<{ id: string; score: number }[]> {
  const result = await env.VECTORIZE.query(queryVector, {
    topK: KB_CONFIG.KB_TOP_K,
    returnMetadata: "all",
    filter,
  });

  return result.matches.map((match) => ({
    id: match.id,
    score: match.score,
  }));
}

async function fetchKBChunksFromDB(
  env: Env,
  ids: string[],
  scoreById?: Map<string, number>
): Promise<ChunkWithSource[]> {
  const placeholders = ids.map(() => "?").join(", ");
  const query = `SELECT id, content, source FROM kb_chunks WHERE id IN (${placeholders})`;

  const result = await env.DB.prepare(query)
    .bind(...ids)
    .all<{ id: string; content: string; source: string }>();

  // Return chunks in the same order as the input IDs (preserving score order)
  const chunksById = new Map(result.results.map((chunk) => [chunk.id, chunk]));

  const orderedChunks: ChunkWithSource[] = [];
  for (const id of ids) {
    const chunk = chunksById.get(id);
    if (chunk) {
      orderedChunks.push({
        content: chunk.content,
        source: chunk.source,
        score: scoreById?.get(id),
      });
    }
  }

  return orderedChunks;
}

/**
 * Retrieves relevant chunks from the org-specific context.
 */
async function retrieveOrgChunks(
  env: Env,
  queryVector: number[],
  orgId: string
): Promise<ChunkWithSource[]> {
  const results = await env.VECTORIZE.query(queryVector, {
    topK: KB_CONFIG.ORG_TOP_K,
    returnMetadata: "all",
    filter: { type: "org", org_id: orgId },
  });

  if (results.matches.length === 0) {
    return [];
  }

  // Create score map for each match
  const scoreById = new Map(results.matches.map((m) => [m.id, m.score]));
  const ids = results.matches.map((match) => match.id);
  const placeholders = ids.map(() => "?").join(", ");
  const query = `SELECT id, content, source FROM org_context_chunks WHERE id IN (${placeholders}) AND org_id = ?`;

  const result = await env.DB.prepare(query)
    .bind(...ids, orgId)
    .all<{ id: string; content: string; source: string }>();

  // Return chunks with scores, preserving order
  const chunksById = new Map(result.results.map((c) => [c.id, c]));
  const orderedChunks: ChunkWithSource[] = [];

  for (const id of ids) {
    const chunk = chunksById.get(id);
    if (chunk) {
      orderedChunks.push({
        content: chunk.content,
        source: chunk.source,
        score: scoreById.get(id),
      });
    }
  }

  return orderedChunks;
}

/**
 * Trims chunks to fit within the token budget.
 * Processes KB chunks first, then org chunks.
 */
function applyTokenBudget(context: RAGContext): RAGContext {
  const budgetInChars = KB_CONFIG.TOKEN_BUDGET * KB_CONFIG.CHARS_PER_TOKEN;
  let remainingBudget = budgetInChars;

  const result: RAGContext = {
    kbChunks: [],
    orgChunks: [],
  };

  // Process KB chunks first
  for (const chunk of context.kbChunks) {
    const chunkSize = estimateChunkSize(chunk);
    if (chunkSize <= remainingBudget) {
      result.kbChunks.push(chunk);
      remainingBudget -= chunkSize;
    }
  }

  // Then process org chunks with remaining budget
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
  // Content + source + XML wrapper overhead
  return chunk.content.length + chunk.source.length + 20;
}
