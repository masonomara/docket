import { Env } from "../types/env";
import { generateQueryEmbedding, ChunkWithSource } from "./rag-retrieval";
import { KB_CONFIG } from "../config/kb";

export interface OrgContextDocument {
  id: string;
  filename: string;
  chunkCount: number;
  uploadedAt: string;
}

export interface OrgContextQueryArgs {
  operation: "list" | "search" | "getDocument";
  query?: string;
  source?: string;
  limit?: number;
}

export function getOrgContextToolSchema(): object {
  return {
    type: "function",
    function: {
      name: "orgContextQuery",
      description:
        "Search and retrieve firm documents uploaded to Org Context. Use this to find policies, procedures, templates, and other firm-specific content.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["list", "search", "getDocument"],
            description: `Operation to perform:
- list: Show all uploaded documents
- search: Semantic search across all documents
- getDocument: Get full content of a specific document`,
          },
          query: {
            type: "string",
            description: "Search query (required for 'search' operation)",
          },
          source: {
            type: "string",
            description:
              "Document filename (required for 'getDocument' operation)",
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

export async function executeOrgContextQuery(
  env: Env,
  orgId: string,
  args: OrgContextQueryArgs
): Promise<string> {
  const limit = args.limit ?? 10;

  switch (args.operation) {
    case "list":
      return listOrgDocuments(env, orgId);

    case "search":
      if (!args.query) {
        return "Error: 'query' is required for search operation.";
      }
      return searchOrgDocuments(env, orgId, args.query, limit);

    case "getDocument":
      if (!args.source) {
        return "Error: 'source' is required for getDocument operation.";
      }
      return getDocumentContent(env, orgId, args.source);

    default:
      return `Error: Unknown operation "${args.operation}". Use list, search, or getDocument.`;
  }
}

async function listOrgDocuments(env: Env, orgId: string): Promise<string> {
  const result = await env.DB.prepare(
    `SELECT
      d.id,
      d.filename,
      d.created_at as uploadedAt,
      COUNT(c.id) as chunkCount
    FROM org_context_documents d
    LEFT JOIN org_context_chunks c ON c.file_id = d.id AND c.org_id = d.org_id
    WHERE d.org_id = ?
    GROUP BY d.id
    ORDER BY d.created_at DESC`
  )
    .bind(orgId)
    .all<{
      id: string;
      filename: string;
      uploadedAt: string;
      chunkCount: number;
    }>();

  if (result.results.length === 0) {
    return "No firm documents have been uploaded yet. An admin can upload documents in the Org Context settings.";
  }

  const docs = result.results.map((d) => `- ${d.filename}`);

  return `The firm has ${result.results.length} document${result.results.length === 1 ? "" : "s"} uploaded:\n${docs.join("\n")}\n\nYou can search these documents or ask about specific topics.`;
}

async function searchOrgDocuments(
  env: Env,
  orgId: string,
  query: string,
  limit: number
): Promise<string> {
  const { vector } = await generateQueryEmbedding(env, query);

  const results = await env.VECTORIZE.query(vector, {
    topK: Math.min(limit, 20),
    returnMetadata: "all",
    filter: { type: "org", org_id: orgId },
  });

  if (results.matches.length === 0) {
    return `No matching content found for "${query}" in firm documents.`;
  }

  const ids = results.matches.map((m) => m.id);
  const scoreById = new Map(results.matches.map((m) => [m.id, m.score]));

  const placeholders = ids.map(() => "?").join(", ");
  const dbResult = await env.DB.prepare(
    `SELECT id, content, source FROM org_context_chunks
     WHERE id IN (${placeholders}) AND org_id = ?`
  )
    .bind(...ids, orgId)
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
    return `No matching content found for "${query}" in firm documents. Try different search terms or use operation="list" to see available documents.`;
  }

  // Group by source document
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

  return `Found relevant content in ${bySource.size} document${bySource.size === 1 ? "" : "s"}:\n\n${findings.join("\n\n")}\n\nSummarize this for the user naturally, referencing the source documents.`;
}

async function getDocumentContent(
  env: Env,
  orgId: string,
  source: string
): Promise<string> {
  const result = await env.DB.prepare(
    `SELECT content, chunk_index FROM org_context_chunks
     WHERE org_id = ? AND source = ?
     ORDER BY chunk_index ASC`
  )
    .bind(orgId, source)
    .all<{ content: string; chunk_index: number }>();

  if (result.results.length === 0) {
    return `Document "${source}" not found. Use orgContextQuery with operation="list" to see available documents.`;
  }

  const fullContent = result.results.map((c) => c.content).join("\n\n");

  return `Full content of "${source}":\n\n${fullContent}\n\nSummarize the key points from this document for the user.`;
}
