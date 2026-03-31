/**
 * Knowledge Base Builder
 *
 * Builds the shared KB by:
 * 1. Reading markdown files from the kb/ directory
 * 2. Extracting metadata from folder structure (jurisdiction, practice type, etc.)
 * 3. Chunking content into embedding-sized pieces
 * 4. Generating embeddings via Workers AI
 * 5. Storing chunks in D1 and vectors in Vectorize
 */

import { Env } from "../types/env";
import { KB_CONFIG } from "../config/kb";

// ============================================================================
// Types
// ============================================================================

interface KBMetadata {
  category: string | null;
  jurisdiction: string | null;
  practice_type: string | null;
  firm_size: string | null;
}

interface KBChunk {
  id: string;
  content: string;
  source: string;
  section: string | null;
  chunkIndex: number;
  metadata: KBMetadata;
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extracts metadata from the file's path within the KB directory.
 *
 * The KB folder structure encodes metadata:
 *   - general/billing.md           -> category: "general"
 *   - jurisdictions/CA/deadlines.md -> jurisdiction: "CA"
 *   - practice-types/pi/intake.md  -> practice_type: "pi"
 *   - firm-sizes/solo/handbook.md  -> firm_size: "solo"
 */
export function extractMetadataFromPath(filePath: string): KBMetadata {
  const metadata: KBMetadata = {
    category: null,
    jurisdiction: null,
    practice_type: null,
    firm_size: null,
  };

  const pathParts = filePath.split("/");
  const rootFolder = pathParts[0];
  const subfolder = pathParts[1];

  // Determine which type of content this is based on the root folder
  switch (rootFolder) {
    case "general":
      metadata.category = "general";
      break;
    case "jurisdictions":
      if (subfolder) metadata.jurisdiction = subfolder;
      break;
    case "practice-types":
      if (subfolder) metadata.practice_type = subfolder;
      break;
    case "firm-sizes":
      if (subfolder) metadata.firm_size = subfolder;
      break;
  }

  return metadata;
}

// ============================================================================
// Text Chunking
// ============================================================================

/**
 * Splits markdown text into chunks suitable for embedding.
 *
 * Strategy:
 * 1. First, split on markdown headers (# or ##) to respect section boundaries
 * 2. If a section is still too long, split on paragraph breaks
 * 3. Combine short paragraphs to avoid tiny chunks
 */
export function chunkText(
  text: string,
  maxChars: number = KB_CONFIG.CHUNK_SIZE
): string[] {
  const chunks: string[] = [];

  // Split on markdown headers (# or ##)
  // The regex captures the header so it stays with its content
  const sections = text.split(/(?=^##?\s)/m);

  for (const section of sections) {
    const trimmedSection = section.trim();
    if (!trimmedSection) continue;

    // If section fits in one chunk, use it as-is
    if (trimmedSection.length <= maxChars) {
      chunks.push(trimmedSection);
      continue;
    }

    // Section is too long - split by paragraphs
    const paragraphs = trimmedSection.split(/\n\n+/);
    let currentChunk = "";

    for (const paragraph of paragraphs) {
      const wouldExceedLimit =
        currentChunk.length + paragraph.length > maxChars;
      const hasExistingContent = currentChunk.length > 0;

      if (wouldExceedLimit && hasExistingContent) {
        // Save current chunk and start a new one
        chunks.push(currentChunk.trim());
        currentChunk = paragraph;
      } else {
        // Add to current chunk
        const separator = currentChunk ? "\n\n" : "";
        currentChunk += separator + paragraph;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
  }

  return chunks;
}

// ============================================================================
// Embedding Generation
// ============================================================================

/**
 * Generates embeddings for an array of texts using Workers AI.
 * Processes in batches to respect API limits.
 */
export async function generateEmbeddings(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  const batchSize = KB_CONFIG.EMBEDDING_BATCH_SIZE;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const result = (await ai.run("@cf/baai/bge-base-en-v1.5", {
      text: batch,
    })) as { data: number[][] };

    allEmbeddings.push(...result.data);
  }

  return allEmbeddings;
}

// ============================================================================
// KB Management
// ============================================================================

/**
 * Clears all existing KB data from D1 and Vectorize.
 * Called before rebuilding the KB to ensure a clean slate.
 */
async function clearExistingKB(env: Env): Promise<void> {
  // Get all existing chunk IDs
  const existingChunks = await env.DB.prepare("SELECT id FROM kb_chunks").all<{
    id: string;
  }>();

  // Delete vectors in batches (only IDs that are valid length)
  if (existingChunks.results.length > 0) {
    const ids = existingChunks.results
      .map((row) => row.id)
      .filter((id) => id.length <= 64); // Skip IDs that are too long for Vectorize

    for (let i = 0; i < ids.length; i += KB_CONFIG.VECTORIZE_BATCH_SIZE) {
      const batch = ids.slice(i, i + KB_CONFIG.VECTORIZE_BATCH_SIZE);
      try {
        await env.VECTORIZE.deleteByIds(batch);
      } catch {
        // Ignore delete errors - vectors may not exist
      }
    }
  }

  // Clear D1 table
  await env.DB.prepare("DELETE FROM kb_chunks").run();
}

/**
 * Builds the entire Knowledge Base from source markdown files.
 *
 * This is a full rebuild - it clears existing data first.
 * Should be called when KB content is updated.
 */
export async function buildKB(
  env: Env,
  kbFiles: Map<string, string>
): Promise<{ chunks: number }> {
  // Start fresh
  await clearExistingKB(env);

  // Process all files into chunks
  const allChunks: KBChunk[] = [];

  for (const [filePath, content] of kbFiles) {
    const metadata = extractMetadataFromPath(filePath);
    const textChunks = chunkText(content);
    const filename = filePath.split("/").pop() || filePath;

    // Track which section we're in for better context
    let currentSection: string | null = null;

    for (let i = 0; i < textChunks.length; i++) {
      const chunkContent = textChunks[i];

      // Update section if this chunk starts with a header
      const headerMatch = chunkContent.match(/^##?\s+(.+)/m);
      if (headerMatch) {
        currentSection = headerMatch[1];
      }

      // Create a unique ID (max 64 bytes for Vectorize)
      // Use filename + index, truncating filename if needed
      const baseName = filename.replace(".md", "");
      const maxBaseLength = 64 - 4 - String(i).length; // "kb_" + "_" + index
      const truncatedBase = baseName.slice(0, maxBaseLength);
      const chunkId = `kb_${truncatedBase}_${i}`;

      allChunks.push({
        id: chunkId,
        content: chunkContent,
        source: filename,
        section: currentSection,
        chunkIndex: i,
        metadata,
      });
    }
  }

  // Generate embeddings for all chunks
  const chunkTexts = allChunks.map((chunk) => chunk.content);
  const embeddings = await generateEmbeddings(env.AI, chunkTexts);

  // Insert chunks into D1
  const insertStatement = env.DB.prepare(`
    INSERT INTO kb_chunks (
      id, content, source, section, chunk_index,
      category, jurisdiction, practice_type, firm_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOperations = allChunks.map((chunk) =>
    insertStatement.bind(
      chunk.id,
      chunk.content,
      chunk.source,
      chunk.section,
      chunk.chunkIndex,
      chunk.metadata.category,
      chunk.metadata.jurisdiction,
      chunk.metadata.practice_type,
      chunk.metadata.firm_size
    )
  );

  await env.DB.batch(insertOperations);

  // Insert vectors into Vectorize
  const vectors = allChunks.map((chunk, index) => ({
    id: chunk.id,
    values: embeddings[index],
    metadata: buildVectorMetadata(chunk),
  }));

  for (let i = 0; i < vectors.length; i += KB_CONFIG.VECTORIZE_BATCH_SIZE) {
    const batch = vectors.slice(i, i + KB_CONFIG.VECTORIZE_BATCH_SIZE);
    await env.VECTORIZE.upsert(batch);
  }

  return { chunks: allChunks.length };
}

/**
 * Builds the metadata object for a vector, only including non-null fields.
 */
function buildVectorMetadata(chunk: KBChunk): Record<string, string> {
  const metadata: Record<string, string> = {
    type: "kb",
    source: chunk.source,
  };

  // Only add non-null metadata fields
  if (chunk.metadata.category) {
    metadata.category = chunk.metadata.category;
  }
  if (chunk.metadata.jurisdiction) {
    metadata.jurisdiction = chunk.metadata.jurisdiction;
  }
  if (chunk.metadata.practice_type) {
    metadata.practice_type = chunk.metadata.practice_type;
  }
  if (chunk.metadata.firm_size) {
    metadata.firm_size = chunk.metadata.firm_size;
  }

  return metadata;
}
