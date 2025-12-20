import { Env } from "../index";

interface KBMetadata {
  category: "general" | null;
  jurisdiction: string | null;
  practiceType: string | null;
  firmSize: string | null;
}

interface KBChunk {
  id: string;
  content: string;
  source: string;
  section: string | null;
  chunkIndex: number;
  metadata: KBMetadata;
}


/**
 * Extracts metadata from file path based on folder structure.
 *
 * /kb/general/           → category: "general" (always included)
 * /kb/jurisdictions/CA/  → jurisdiction: "CA"
 * /kb/practice-types/X/  → practiceType: "X"
 * /kb/firm-sizes/solo/   → firmSize: "solo"
 */
export function extractMetadataFromPath(filePath: string): KBMetadata {
  const metadata: KBMetadata = {
    category: null,
    jurisdiction: null,
    practiceType: null,
    firmSize: null,
  };

  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, "/");

  if (normalizedPath.includes("/general/")) {
    metadata.category = "general";
  } else if (normalizedPath.includes("/jurisdictions/")) {
    const match = normalizedPath.match(/\/jurisdictions\/([^/]+)\//);
    if (match) {
      metadata.jurisdiction = match[1];
    }
  } else if (normalizedPath.includes("/practice-types/")) {
    const match = normalizedPath.match(/\/practice-types\/([^/]+)\//);
    if (match) {
      metadata.practiceType = match[1];
    }
  } else if (normalizedPath.includes("/firm-sizes/")) {
    const match = normalizedPath.match(/\/firm-sizes\/([^/]+)\//);
    if (match) {
      metadata.firmSize = match[1];
    }
  }

  return metadata;
}

/**
 * Chunks text into ~500 character segments, respecting section boundaries.
 */
export function chunkText(text: string, maxChars = 500): string[] {
  const chunks: string[] = [];
  const sections = text.split(/(?=^##?\s)/m);

  for (const section of sections) {
    if (section.length <= maxChars) {
      if (section.trim()) chunks.push(section.trim());
      continue;
    }

    const paragraphs = section.split(/\n\n+/);
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length > maxChars && current) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += (current ? "\n\n" : "") + para;
      }
    }

    if (current.trim()) chunks.push(current.trim());
  }

  return chunks;
}


/**
 * Generates embeddings for text using Workers AI.
 * Batches requests (max 100 per call) to avoid rate limits.
 */
async function generateEmbeddings(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await ai.run("@cf/baai/bge-base-en-v1.5", { text: batch });
    // Result is { shape: number[], data: number[][] }
    const embeddings = (result as { data: number[][] }).data;
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}

/**
 * Clears all KB data from D1 and Vectorize.
 */
async function clearKB(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM kb_chunks").run();

  // Note: Vectorize bulk delete by query not supported.
  // KB embeddings are cleared by upserting with same IDs (overwrite).
}

/**
 * Main KB build function. Call this at deploy time.
 *
 * @param kbFiles - Map of file paths to content (path relative to /kb/)
 */
export async function buildKB(
  env: Env,
  kbFiles: Map<string, string>
): Promise<{ chunks: number }> {
  await clearKB(env);

  const allChunks: KBChunk[] = [];

  for (const [filePath, content] of kbFiles) {
    const metadata = extractMetadataFromPath(filePath);
    const filename = filePath.split("/").pop() || filePath;
    const chunks = chunkText(content);

    let currentSection: string | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const headerMatch = chunks[i].match(/^##?\s+(.+)/m);
      if (headerMatch) currentSection = headerMatch[1];

      allChunks.push({
        id: `kb_${filename}_${i}`,
        content: chunks[i],
        source: filename,
        section: currentSection,
        chunkIndex: i,
        metadata,
      });
    }
  }

  // Generate embeddings
  const embeddings = await generateEmbeddings(
    env.AI,
    allChunks.map((c) => c.content)
  );

  // Insert chunks into D1
  const chunkStmt = env.DB.prepare(
    `INSERT INTO kb_chunks (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  await env.DB.batch(
    allChunks.map((c) =>
      chunkStmt.bind(
        c.id,
        c.content,
        c.source,
        c.section,
        c.chunkIndex,
        c.metadata.category,
        c.metadata.jurisdiction,
        c.metadata.practiceType,
        c.metadata.firmSize
      )
    )
  );

  // Upsert embeddings to Vectorize with metadata
  // Filter out null values as Vectorize doesn't accept them
  const vectors = allChunks.map((chunk, i) => {
    const metadata: Record<string, string> = {
      source: chunk.source,
      type: "kb",
    };

    if (chunk.metadata.category) {
      metadata.category = chunk.metadata.category;
    }
    if (chunk.metadata.jurisdiction) {
      metadata.jurisdiction = chunk.metadata.jurisdiction;
    }
    if (chunk.metadata.practiceType) {
      metadata.practice_type = chunk.metadata.practiceType;
    }
    if (chunk.metadata.firmSize) {
      metadata.firm_size = chunk.metadata.firmSize;
    }

    return {
      id: chunk.id,
      values: embeddings[i],
      metadata,
    };
  });

  // Vectorize upsert in batches of 100
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }

  return { chunks: allChunks.length };
}
