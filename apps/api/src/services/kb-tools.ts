import { Env } from "../types/env";
import {
  generateQueryEmbedding,
  ChunkWithSource,
  OrgSettings,
} from "./rag-retrieval";
import { KB_CONFIG } from "../config/kb";

export interface KBCategory {
  category: string;
  description: string;
}

export interface KBQueryArgs {
  operation: "search" | "listCategories";
  query?: string;
  category?: string;
  jurisdiction?: string;
  practiceType?: string;
  limit?: number;
}

const KB_CATEGORIES: KBCategory[] = [
  { category: "general", description: "Core Clio workflows and features" },
  {
    category: "billing",
    description: "Time tracking, invoicing, trust accounting",
  },
  {
    category: "deadlines",
    description: "Filing windows, statute of limitations, discovery timelines",
  },
  {
    category: "practice-management",
    description: "Intake, conflict checks, matter stages",
  },
];

export function getKnowledgeBaseToolSchema(): object {
  return {
    type: "function",
    function: {
      name: "knowledgeBaseQuery",
      description:
        "Search the shared Knowledge Base for Clio workflows, practice management guidance, billing best practices, and legal procedure information.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["search", "listCategories"],
            description: `Operation to perform:
- search: Semantic search with optional filters
- listCategories: Show available KB categories`,
          },
          query: {
            type: "string",
            description: "Search query (required for 'search' operation)",
          },
          category: {
            type: "string",
            description:
              "Filter by category: general, billing, deadlines, practice-management",
          },
          jurisdiction: {
            type: "string",
            description:
              "Filter by jurisdiction: federal, CA, NY, TX, FL, etc.",
          },
          practiceType: {
            type: "string",
            description:
              "Filter by practice type: personal-injury, family-law, criminal-law, etc.",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 10)",
          },
        },
        required: ["operation"],
      },
    },
  };
}

export async function executeKnowledgeBaseQuery(
  env: Env,
  orgSettings: OrgSettings,
  args: KBQueryArgs
): Promise<string> {
  const limit = args.limit ?? 10;

  switch (args.operation) {
    case "listCategories":
      return listKBCategories();

    case "search":
      if (!args.query) {
        return "Error: 'query' is required for search operation.";
      }
      return searchKnowledgeBase(env, orgSettings, args.query, limit, {
        category: args.category,
        jurisdiction: args.jurisdiction,
        practiceType: args.practiceType,
      });

    default:
      return `Error: Unknown operation "${args.operation}". Use search or listCategories.`;
  }
}

function listKBCategories(): string {
  const formatted = KB_CATEGORIES.map(
    (c) => `- **${c.category}**: ${c.description}`
  ).join("\n");

  return `Knowledge Base categories:\n${formatted}\n\nUse knowledgeBaseQuery with operation="search" and optionally category, jurisdiction, or practiceType filters.`;
}

async function searchKnowledgeBase(
  env: Env,
  orgSettings: OrgSettings,
  query: string,
  limit: number,
  filters: {
    category?: string;
    jurisdiction?: string;
    practiceType?: string;
  }
): Promise<string> {
  const { vector } = await generateQueryEmbedding(env, query);

  // Build Vectorize filters
  const vectorizeFilters = buildSearchFilters(orgSettings, filters);

  // Query each filter in parallel and merge results
  const filterResults = await Promise.all(
    vectorizeFilters.map((filter) =>
      env.VECTORIZE.query(vector, {
        topK: KB_CONFIG.KB_TOP_K,
        returnMetadata: "all",
        filter,
      })
    )
  );

  // Merge and deduplicate by best score
  const bestScoreById = new Map<string, number>();
  for (const result of filterResults) {
    for (const match of result.matches) {
      const currentBest = bestScoreById.get(match.id) ?? -1;
      if (match.score > currentBest) {
        bestScoreById.set(match.id, match.score);
      }
    }
  }

  // Sort by score and take top results
  const sortedEntries = Array.from(bestScoreById.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (sortedEntries.length === 0) {
    return `No matching content found for "${query}" in the Knowledge Base.`;
  }

  const ids = sortedEntries.map(([id]) => id);
  const scoreById = new Map(sortedEntries);

  // Fetch chunk content from D1
  const placeholders = ids.map(() => "?").join(", ");
  const dbResult = await env.DB.prepare(
    `SELECT id, content, source FROM kb_chunks WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all<{ id: string; content: string; source: string }>();

  const chunksById = new Map(dbResult.results.map((c) => [c.id, c]));
  const chunks: ChunkWithSource[] = [];

  for (const id of ids) {
    const chunk = chunksById.get(id);
    if (chunk) {
      chunks.push({
        content: chunk.content,
        source: chunk.source,
        score: scoreById.get(id),
      });
    }
  }

  if (chunks.length === 0) {
    return `No matching content found for "${query}" in the Knowledge Base. Try different search terms or broader filters.`;
  }

  // Group by source
  const bySource = new Map<string, string[]>();
  for (const chunk of chunks) {
    const existing = bySource.get(chunk.source) || [];
    existing.push(chunk.content);
    bySource.set(chunk.source, existing);
  }

  // Format as structured findings for LLM to summarize
  const findings: string[] = [];
  for (const [source, contents] of bySource) {
    findings.push(`From "${source}":\n${contents.join("\n---\n")}`);
  }

  return `Found relevant information from ${bySource.size} source${bySource.size === 1 ? "" : "s"}:\n\n${findings.join("\n\n")}\n\nSummarize this for the user naturally.`;
}

function buildSearchFilters(
  orgSettings: OrgSettings,
  explicitFilters: {
    category?: string;
    jurisdiction?: string;
    practiceType?: string;
  }
): VectorizeVectorMetadataFilter[] {
  const filters: VectorizeVectorMetadataFilter[] = [];

  // If explicit filters provided, use those
  if (explicitFilters.category) {
    filters.push({ type: "kb", category: explicitFilters.category });
  }

  if (explicitFilters.jurisdiction) {
    filters.push({ type: "kb", jurisdiction: explicitFilters.jurisdiction });
  }

  if (explicitFilters.practiceType) {
    filters.push({ type: "kb", practice_type: explicitFilters.practiceType });
  }

  // If no explicit filters, use org settings as defaults
  if (filters.length === 0) {
    // Always include general and federal
    filters.push({ type: "kb", category: "general" });
    filters.push({ type: "kb", jurisdiction: "federal" });

    // Add org-specific jurisdictions
    if (orgSettings.jurisdictions.length > 0) {
      filters.push({
        type: "kb",
        jurisdiction: { $in: orgSettings.jurisdictions.slice(0, 5) },
      });
    }

    // Add org-specific practice types
    if (orgSettings.practiceTypes.length > 0) {
      filters.push({
        type: "kb",
        practice_type: { $in: orgSettings.practiceTypes.slice(0, 5) },
      });
    }

    // Add firm size filter
    if (orgSettings.firmSize) {
      filters.push({ type: "kb", firm_size: orgSettings.firmSize });
    }
  }

  return filters;
}
