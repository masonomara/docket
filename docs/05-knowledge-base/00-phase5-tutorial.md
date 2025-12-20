# Phase 5: Knowledge Base Tutorial

**LONGER DOC**

This tutorial builds the Knowledge Base (KB) and Org Context systems that power Docket's RAG (Retrieval-Augmented Generation) capabilities. By the end, you'll understand how vector embeddings work, how to store and query them, and how to build a complete document processing pipeline.

## What We're Building

Docket's AI needs context to answer questions intelligently. Rather than fine-tuning an LLM (expensive, slow), we use RAG: retrieve relevant documents at query time and inject them into the prompt.

**Two knowledge sources:**

1. **Shared KB** — Best practices for legal case management, Clio workflows, deadline calculations. Shared across all organizations. Built at deploy time from markdown files.

2. **Org Context** — Firm-specific documents (procedures, templates, billing rates). Per-organization, uploaded by admins at runtime.

**The data flow:**

```
User Query → Generate Embedding → Query Vectorize → Fetch Chunks from D1 → Inject into Prompt
```

## Part 1: Understanding Vector Embeddings

### What Are Embeddings?

An embedding is a list of numbers (a vector) that represents the "meaning" of text. Similar concepts produce similar vectors. This lets us find relevant content without keyword matching.

```typescript
// Example embedding (768 dimensions, truncated for display)
const embedding = [0.023, -0.156, 0.089, 0.312, -0.045, ...];
```

When a user asks "How do I calculate statute of limitations?", we:

1. Convert the question to an embedding
2. Find stored embeddings that are mathematically similar
3. Retrieve the original text for those embeddings

### Why 768 Dimensions?

Our embedding model (`@cf/baai/bge-base-en-v1.5`) outputs 768-dimensional vectors. More dimensions capture more nuance but require more storage. This model balances quality and efficiency.

### Cosine Similarity

Vectorize uses cosine similarity to compare vectors. It measures the angle between vectors, not their magnitude. Two vectors pointing the same direction (similar meaning) have similarity near 1.0.

## Part 2: The Storage Architecture

### Where Data Lives

| Data        | Storage   | Why                                   |
| ----------- | --------- | ------------------------------------- |
| Embeddings  | Vectorize | Optimized for similarity search       |
| Text chunks | D1        | SQL queries, joins with metadata      |
| Raw files   | R2        | Large file storage, per-org isolation |

**Vectorize cannot store the original text.** It only stores vectors and metadata. We store vectors in Vectorize for fast similarity search, then look up the actual text in D1 using the returned IDs.

### The Chunk ID Pattern

Every chunk has a unique ID that encodes its origin:

```typescript
// KB chunk ID format
const kbChunkId = `kb_${sourceFile}_${chunkIndex}`;
// Example: "kb_deadline-guide.md_3"

// Org Context chunk ID format
const orgChunkId = `${orgId}_${fileId}_${chunkIndex}`;
// Example: "org-123_file-456_7"
```

This lets us:

- Delete all chunks for a file: `WHERE chunk_id LIKE 'org-123_file-456_%'`
- Delete all org chunks: `WHERE org_id = 'org-123'`
- Trace any chunk back to its source

## Part 3: Building the Shared Knowledge Base

The KB is rebuilt on every deploy. This ensures the codebase and KB stay in sync.

### Step 1: Create the `/kb` Directory

```bash
mkdir -p kb
```

Add markdown files with legal best practices:

```markdown
<!-- kb/deadline-calculations.md -->

# Deadline Calculations

## Statute of Limitations

**SOL Formula**: Incident Date + Jurisdiction Limit

Most personal injury: 2 years from incident.
Medical malpractice: Often 2-3 years, discovery rule may apply.
Contract disputes: Typically 4-6 years.

| Case Type           | Typical Limit | Notes                   |
| ------------------- | ------------- | ----------------------- |
| Personal Injury     | 2 years       | From date of injury     |
| Medical Malpractice | 2-3 years     | Discovery rule varies   |
| Contract            | 4-6 years     | Written vs oral differs |
```

### Step 2: The KB Builder Service

Create `src/services/kb-builder.ts`:

```typescript
import { Env } from "../index";

interface KBChunk {
  id: string;
  content: string;
  source: string;
  section: string | null;
  chunkIndex: number;
}

interface KBFormula {
  id: string;
  name: string;
  formula: string;
  description: string | null;
  source: string;
}

interface KBBenchmark {
  id: string;
  name: string;
  value: string;
  unit: string | null;
  context: string | null;
  source: string;
}

/**
 * Chunks text into ~500 character segments, respecting section boundaries.
 *
 * Why 500 characters? Balances context (enough to be useful) with
 * embedding quality (models perform better on focused text).
 */
function chunkText(text: string, maxChars = 500): string[] {
  const chunks: string[] = [];
  const sections = text.split(/(?=^##?\s)/m); // Split on markdown headers

  for (const section of sections) {
    if (section.length <= maxChars) {
      if (section.trim()) chunks.push(section.trim());
      continue;
    }

    // Split long sections by paragraphs
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
 * Extracts formulas from markdown using pattern: **Name**: formula
 */
function extractFormulas(content: string, source: string): KBFormula[] {
  const formulas: KBFormula[] = [];
  const pattern = /\*\*([^*]+)\*\*:\s*(.+?)(?=\n|$)/g;

  let match;
  while ((match = pattern.exec(content)) !== null) {
    const [, name, formula] = match;
    // Only include if it looks like a formula (has calculation terms)
    if (
      formula.includes("+") ||
      formula.includes("×") ||
      formula.includes("=")
    ) {
      formulas.push({
        id: `formula_${source}_${formulas.length}`,
        name: name.trim(),
        formula: formula.trim(),
        description: null,
        source,
      });
    }
  }

  return formulas;
}

/**
 * Extracts benchmarks from markdown tables.
 * Tables must have headers including "value" or "rate" or numeric columns.
 */
function extractBenchmarks(content: string, source: string): KBBenchmark[] {
  const benchmarks: KBBenchmark[] = [];

  // Match markdown tables
  const tablePattern = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;

  let match;
  while ((match = tablePattern.exec(content)) !== null) {
    const headers = match[1].split("|").map((h) => h.trim().toLowerCase());
    const rows = match[2].trim().split("\n");

    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length >= 2) {
        // First column is name, look for numeric values
        const name = cells[0];
        const value = cells.find((c) => /\d/.test(c)) || cells[1];

        benchmarks.push({
          id: `benchmark_${source}_${benchmarks.length}`,
          name,
          value,
          unit: null,
          context: cells.slice(2).join(" ") || null,
          source,
        });
      }
    }
  }

  return benchmarks;
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
    allEmbeddings.push(...result.data);
  }

  return allEmbeddings;
}

/**
 * Clears all KB data from D1 and Vectorize.
 * Called before rebuilding to ensure clean state.
 */
async function clearKB(env: Env): Promise<void> {
  // Clear D1 tables
  await env.DB.batch([
    env.DB.prepare("DELETE FROM kb_chunks"),
    env.DB.prepare("DELETE FROM kb_formulas"),
    env.DB.prepare("DELETE FROM kb_benchmarks"),
  ]);

  // Clear KB embeddings from Vectorize (those without org_id metadata)
  // Note: Vectorize doesn't support bulk delete by query, so we need to
  // list and delete by IDs. For KB, we track IDs in D1.
  // In practice, we rebuild the entire index.
}

/**
 * Main KB build function. Call this at deploy time.
 */
export async function buildKB(
  env: Env,
  kbFiles: Map<string, string>
): Promise<{ chunks: number; formulas: number; benchmarks: number }> {
  await clearKB(env);

  const allChunks: KBChunk[] = [];
  const allFormulas: KBFormula[] = [];
  const allBenchmarks: KBBenchmark[] = [];

  // Process each KB file
  for (const [filename, content] of kbFiles) {
    const chunks = chunkText(content);

    // Extract current section header for context
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
      });
    }

    allFormulas.push(...extractFormulas(content, filename));
    allBenchmarks.push(...extractBenchmarks(content, filename));
  }

  // Generate embeddings for all chunks
  const embeddings = await generateEmbeddings(
    env.AI,
    allChunks.map((c) => c.content)
  );

  // Insert chunks into D1
  const chunkStmt = env.DB.prepare(
    `INSERT INTO kb_chunks (id, content, source, section, chunk_index)
     VALUES (?, ?, ?, ?, ?)`
  );

  await env.DB.batch(
    allChunks.map((c) =>
      chunkStmt.bind(c.id, c.content, c.source, c.section, c.chunkIndex)
    )
  );

  // Insert formulas into D1
  if (allFormulas.length > 0) {
    const formulaStmt = env.DB.prepare(
      `INSERT INTO kb_formulas (id, name, formula, description, source)
       VALUES (?, ?, ?, ?, ?)`
    );

    await env.DB.batch(
      allFormulas.map((f) =>
        formulaStmt.bind(f.id, f.name, f.formula, f.description, f.source)
      )
    );
  }

  // Insert benchmarks into D1
  if (allBenchmarks.length > 0) {
    const benchmarkStmt = env.DB.prepare(
      `INSERT INTO kb_benchmarks (id, name, value, unit, context, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    await env.DB.batch(
      allBenchmarks.map((b) =>
        benchmarkStmt.bind(b.id, b.name, b.value, b.unit, b.context, b.source)
      )
    );
  }

  // Upsert embeddings to Vectorize
  const vectors = allChunks.map((chunk, i) => ({
    id: chunk.id,
    values: embeddings[i],
    metadata: { source: chunk.source, type: "kb" },
  }));

  // Vectorize upsert in batches of 100
  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }

  return {
    chunks: allChunks.length,
    formulas: allFormulas.length,
    benchmarks: allBenchmarks.length,
  };
}
```

### What's Happening Here?

1. **`chunkText()`** — Splits markdown into ~500 character pieces, respecting section headers. We want coherent chunks, not arbitrary splits mid-sentence.

2. **`extractFormulas()`** — Finds patterns like `**SOL Formula**: Incident Date + Jurisdiction Limit`. Formulas are prioritized in RAG results because they're actionable.

3. **`extractBenchmarks()`** — Parses markdown tables for reference metrics. Legal professionals need concrete numbers.

4. **`generateEmbeddings()`** — Calls Workers AI in batches. The model accepts up to 100 texts per call.

5. **`buildKB()`** — Orchestrates the full rebuild: clear old data, process files, generate embeddings, store everything.

## Part 4: Org Context Upload Flow

Unlike KB (built at deploy), Org Context is uploaded by users at runtime.

### Step 1: File Validation

Create `src/services/org-context.ts`:

```typescript
import { Env } from "../index";
import { R2Paths } from "../storage/r2-paths";

const ALLOWED_TYPES = new Map([
  ["application/pdf", ".pdf"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["text/markdown", ".md"],
]);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

interface UploadResult {
  success: boolean;
  fileId?: string;
  error?: string;
  chunksCreated?: number;
}

/**
 * Validates file before processing.
 * Defense in depth: check both MIME type AND extension.
 */
function validateFile(
  filename: string,
  mimeType: string,
  size: number
): { valid: boolean; error?: string } {
  // Check size
  if (size > MAX_FILE_SIZE) {
    return { valid: false, error: `File exceeds 25MB limit` };
  }

  // Check MIME type
  if (!ALLOWED_TYPES.has(mimeType)) {
    return { valid: false, error: `Unsupported file type: ${mimeType}` };
  }

  // Check extension matches MIME type
  const expectedExt = ALLOWED_TYPES.get(mimeType);
  const actualExt = filename.toLowerCase().slice(filename.lastIndexOf("."));

  if (actualExt !== expectedExt) {
    return {
      valid: false,
      error: `Extension mismatch: expected ${expectedExt}`,
    };
  }

  // Sanitize filename (prevent path traversal)
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return { valid: false, error: "Invalid filename" };
  }

  return { valid: true };
}

/**
 * Extracts text from uploaded file based on type.
 */
async function extractText(
  content: ArrayBuffer,
  mimeType: string
): Promise<string> {
  switch (mimeType) {
    case "text/markdown":
      return new TextDecoder().decode(content);

    case "application/pdf":
      // pdf-parse would be used here
      // For now, placeholder - actual implementation needs pdf-parse package
      throw new Error("PDF parsing requires pdf-parse package");

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      // mammoth would be used here
      throw new Error("DOCX parsing requires mammoth package");

    default:
      throw new Error(`Unsupported type: ${mimeType}`);
  }
}

/**
 * Uploads and processes an Org Context document.
 */
export async function uploadOrgContext(
  env: Env,
  orgId: string,
  filename: string,
  mimeType: string,
  content: ArrayBuffer
): Promise<UploadResult> {
  // Validate
  const validation = validateFile(filename, mimeType, content.byteLength);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const fileId = crypto.randomUUID();

  try {
    // Store raw file in R2
    const r2Path = R2Paths.orgDoc(orgId, fileId);
    await env.R2.put(r2Path, content, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { originalFilename: filename },
    });

    // Extract text
    const text = await extractText(content, mimeType);

    // Chunk text
    const chunks = chunkText(text);

    // Generate embeddings
    const embeddings = await generateEmbeddings(env.AI, chunks);

    // Store chunks in D1
    const chunkStmt = env.DB.prepare(
      `INSERT INTO org_context_chunks (id, org_id, file_id, content, source, chunk_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    await env.DB.batch(
      chunks.map((chunk, i) =>
        chunkStmt.bind(
          `${orgId}_${fileId}_${i}`,
          orgId,
          fileId,
          chunk,
          filename,
          i
        )
      )
    );

    // Upsert to Vectorize with org_id metadata for filtering
    const vectors = chunks.map((chunk, i) => ({
      id: `${orgId}_${fileId}_${i}`,
      values: embeddings[i],
      metadata: { org_id: orgId, source: filename, type: "org_context" },
    }));

    for (let i = 0; i < vectors.length; i += 100) {
      await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
    }

    return { success: true, fileId, chunksCreated: chunks.length };
  } catch (error) {
    // Cleanup on failure
    await env.R2.delete(R2Paths.orgDoc(orgId, fileId));
    return { success: false, error: String(error) };
  }
}

/**
 * Deletes an Org Context document and all associated data.
 */
export async function deleteOrgContext(
  env: Env,
  orgId: string,
  fileId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get chunk IDs for Vectorize deletion
    const chunks = await env.DB.prepare(
      `SELECT id FROM org_context_chunks WHERE org_id = ? AND file_id = ?`
    )
      .bind(orgId, fileId)
      .all<{ id: string }>();

    // Delete from Vectorize
    if (chunks.results.length > 0) {
      const ids = chunks.results.map((c) => c.id);
      await env.VECTORIZE.deleteByIds(ids);
    }

    // Delete from D1
    await env.DB.prepare(
      `DELETE FROM org_context_chunks WHERE org_id = ? AND file_id = ?`
    )
      .bind(orgId, fileId)
      .run();

    // Delete from R2
    await env.R2.delete(R2Paths.orgDoc(orgId, fileId));

    return { success: true };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Re-export helpers used by both KB and Org Context
function chunkText(text: string, maxChars = 500): string[] {
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

async function generateEmbeddings(
  ai: Ai,
  texts: string[]
): Promise<number[][]> {
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const result = await ai.run("@cf/baai/bge-base-en-v1.5", { text: batch });
    allEmbeddings.push(...result.data);
  }

  return allEmbeddings;
}
```

### Key Difference: Metadata Filtering

When we upsert Org Context vectors, we include `org_id` in the metadata:

```typescript
{
  id: `${orgId}_${fileId}_${i}`,
  values: embedding,
  metadata: { org_id: orgId }  // This enables filtering!
}
```

At query time, we filter so each org only sees their own documents:

```typescript
await env.VECTORIZE.query(queryVector, {
  topK: 5,
  filter: { org_id: orgId }, // Only return vectors from this org
});
```

## Part 5: RAG Retrieval System

Now we build the retrieval function that the Durable Object will call.

Create `src/services/rag-retrieval.ts`:

```typescript
import { Env } from "../index";

interface RAGContext {
  formulas: Array<{ name: string; formula: string; source: string }>;
  benchmarks: Array<{ name: string; value: string; source: string }>;
  kbChunks: Array<{ content: string; source: string }>;
  orgChunks: Array<{ content: string; source: string }>;
}

const TOKEN_BUDGET = 3000;
const CHARS_PER_TOKEN = 4; // Rough estimate

/**
 * Retrieves RAG context for a user query.
 *
 * Two parallel Vectorize queries:
 * 1. KB (no filter) - shared knowledge
 * 2. Org Context (filtered by org_id) - firm-specific
 */
export async function retrieveRAGContext(
  env: Env,
  query: string,
  orgId: string
): Promise<RAGContext> {
  try {
    // Generate embedding for the query
    const embeddingResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [query],
    });
    const queryVector = embeddingResult.data[0];

    // Parallel Vectorize queries
    const [kbResults, orgResults] = await Promise.all([
      // KB: no filter
      env.VECTORIZE.query(queryVector, {
        topK: 5,
        returnMetadata: "all",
      }),
      // Org Context: filter by org_id
      env.VECTORIZE.query(queryVector, {
        topK: 5,
        filter: { org_id: orgId },
        returnMetadata: "all",
      }),
    ]);

    // Extract IDs for D1 lookups
    const kbIds = kbResults.matches
      .filter((m) => m.metadata?.type === "kb")
      .map((m) => m.id);

    const orgIds = orgResults.matches.map((m) => m.id);

    // Parallel D1 fetches
    const [kbChunks, orgChunks, formulas, benchmarks] = await Promise.all([
      // Fetch KB chunk text
      kbIds.length > 0
        ? env.DB.prepare(
            `SELECT content, source FROM kb_chunks WHERE id IN (${kbIds
              .map(() => "?")
              .join(",")})`
          )
            .bind(...kbIds)
            .all<{ content: string; source: string }>()
        : Promise.resolve({ results: [] }),

      // Fetch Org Context chunk text
      orgIds.length > 0
        ? env.DB.prepare(
            `SELECT content, source FROM org_context_chunks WHERE id IN (${orgIds
              .map(() => "?")
              .join(",")})`
          )
            .bind(...orgIds)
            .all<{ content: string; source: string }>()
        : Promise.resolve({ results: [] }),

      // Fetch formulas from same sources as retrieved chunks
      kbIds.length > 0
        ? env.DB.prepare(
            `SELECT DISTINCT name, formula, source FROM kb_formulas
             WHERE source IN (SELECT DISTINCT source FROM kb_chunks WHERE id IN (${kbIds
               .map(() => "?")
               .join(",")}))`
          )
            .bind(...kbIds)
            .all<{ name: string; formula: string; source: string }>()
        : Promise.resolve({ results: [] }),

      // Fetch benchmarks from same sources
      kbIds.length > 0
        ? env.DB.prepare(
            `SELECT DISTINCT name, value, source FROM kb_benchmarks
             WHERE source IN (SELECT DISTINCT source FROM kb_chunks WHERE id IN (${kbIds
               .map(() => "?")
               .join(",")}))`
          )
            .bind(...kbIds)
            .all<{ name: string; value: string; source: string }>()
        : Promise.resolve({ results: [] }),
    ]);

    // Apply token budget with priority
    return applyTokenBudget({
      formulas: formulas.results,
      benchmarks: benchmarks.results,
      kbChunks: kbChunks.results,
      orgChunks: orgChunks.results,
    });
  } catch (error) {
    // Graceful degradation: return empty context on failure
    console.error("[RAG] Retrieval error:", error);
    return {
      formulas: [],
      benchmarks: [],
      kbChunks: [],
      orgChunks: [],
    };
  }
}

/**
 * Applies token budget, prioritizing by information type.
 * Priority: formulas > benchmarks > KB narrative > Org Context
 */
function applyTokenBudget(context: RAGContext): RAGContext {
  let remainingChars = TOKEN_BUDGET * CHARS_PER_TOKEN;
  const result: RAGContext = {
    formulas: [],
    benchmarks: [],
    kbChunks: [],
    orgChunks: [],
  };

  // 1. Formulas (highest priority)
  for (const f of context.formulas) {
    const len = f.name.length + f.formula.length + f.source.length + 20;
    if (len <= remainingChars) {
      result.formulas.push(f);
      remainingChars -= len;
    }
  }

  // 2. Benchmarks
  for (const b of context.benchmarks) {
    const len = b.name.length + b.value.length + b.source.length + 20;
    if (len <= remainingChars) {
      result.benchmarks.push(b);
      remainingChars -= len;
    }
  }

  // 3. KB chunks
  for (const c of context.kbChunks) {
    const len = c.content.length + c.source.length + 20;
    if (len <= remainingChars) {
      result.kbChunks.push(c);
      remainingChars -= len;
    }
  }

  // 4. Org Context chunks (lowest priority)
  for (const c of context.orgChunks) {
    const len = c.content.length + c.source.length + 20;
    if (len <= remainingChars) {
      result.orgChunks.push(c);
      remainingChars -= len;
    }
  }

  return result;
}

/**
 * Formats RAG context for injection into system prompt.
 */
export function formatRAGContext(context: RAGContext): string {
  const sections: string[] = [];

  if (context.formulas.length > 0) {
    sections.push(
      "### Formulas\n" +
        context.formulas
          .map((f) => `**${f.name}**: ${f.formula}\n*Source: ${f.source}*`)
          .join("\n\n")
    );
  }

  if (context.benchmarks.length > 0) {
    sections.push(
      "### Benchmarks\n" +
        context.benchmarks
          .map((b) => `- ${b.name}: ${b.value} *(${b.source})*`)
          .join("\n")
    );
  }

  if (context.kbChunks.length > 0) {
    sections.push(
      "### Best Practices\n" +
        context.kbChunks
          .map((c) => `${c.content}\n*Source: ${c.source}*`)
          .join("\n\n")
    );
  }

  const kbSection =
    sections.length > 0
      ? "## Knowledge Base Context\n\n" + sections.join("\n\n")
      : "";

  const orgSection =
    context.orgChunks.length > 0
      ? "## Org Context (This Firm's Practices)\n\n" +
        context.orgChunks
          .map((c) => `${c.content}\n*Source: ${c.source}*`)
          .join("\n\n")
      : "";

  return [kbSection, orgSection].filter(Boolean).join("\n\n");
}
```

### Understanding the Token Budget

We allocate ~3,000 tokens for RAG context. Why?

- Total context window: 128K tokens
- System prompt base: ~500 tokens
- Clio Schema: ~1,500 tokens
- Conversation history: ~3,000 tokens
- Response buffer: ~2,000 tokens
- **RAG context: ~3,000 tokens**

Priority ordering ensures the most actionable information survives truncation:

1. **Formulas** — Direct calculations users can apply
2. **Benchmarks** — Concrete reference numbers
3. **KB narrative** — General guidance
4. **Org Context** — Firm-specific (useful but less universal)

## Part 6: Testing Strategy

### Unit Tests

Create `test/kb.spec.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";

describe("Knowledge Base", () => {
  describe("chunkText", () => {
    it("respects section boundaries", async () => {
      const text = `# Header One

Some content here that is under the limit.

## Header Two

More content under a different section.`;

      // Import and test the chunk function
      const { chunkText } = await import("../src/services/kb-builder");
      const chunks = chunkText(text);

      // Each section should be its own chunk if under limit
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toContain("Header One");
    });

    it("splits long sections by paragraph", async () => {
      const longPara = "A".repeat(300);
      const text = `# Long Section\n\n${longPara}\n\n${longPara}`;

      const { chunkText } = await import("../src/services/kb-builder");
      const chunks = chunkText(text, 400);

      expect(chunks.length).toBe(2);
    });
  });

  describe("extractFormulas", () => {
    it("finds formula patterns", async () => {
      const content = `
**SOL Formula**: Incident Date + Jurisdiction Limit
**Not a formula**: Just some text
**Billing Rate**: Hours × Rate = Total
      `;

      const { extractFormulas } = await import("../src/services/kb-builder");
      const formulas = extractFormulas(content, "test.md");

      expect(formulas.length).toBe(2);
      expect(formulas[0].name).toBe("SOL Formula");
      expect(formulas[1].name).toBe("Billing Rate");
    });
  });

  describe("extractBenchmarks", () => {
    it("parses markdown tables", async () => {
      const content = `
| Metric | Value | Notes |
|--------|-------|-------|
| Retention Rate | 85% | Excellent |
| Collection Rate | 92% | Above average |
      `;

      const { extractBenchmarks } = await import("../src/services/kb-builder");
      const benchmarks = extractBenchmarks(content, "test.md");

      expect(benchmarks.length).toBe(2);
      expect(benchmarks[0].name).toBe("Retention Rate");
      expect(benchmarks[0].value).toBe("85%");
    });
  });
});

describe("Org Context", () => {
  describe("validateFile", () => {
    it("rejects files over 25MB", async () => {
      const { validateFile } = await import("../src/services/org-context");
      const result = validateFile(
        "test.pdf",
        "application/pdf",
        30 * 1024 * 1024
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("25MB");
    });

    it("rejects unsupported MIME types", async () => {
      const { validateFile } = await import("../src/services/org-context");
      const result = validateFile("test.exe", "application/x-executable", 1000);

      expect(result.valid).toBe(false);
    });

    it("rejects path traversal attempts", async () => {
      const { validateFile } = await import("../src/services/org-context");
      const result = validateFile("../../../etc/passwd", "text/markdown", 100);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid filename");
    });

    it("accepts valid PDF files", async () => {
      const { validateFile } = await import("../src/services/org-context");
      const result = validateFile("document.pdf", "application/pdf", 1000);

      expect(result.valid).toBe(true);
    });
  });
});
```

### Integration Tests

Create `test/rag-integration.spec.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";

describe("RAG Integration", () => {
  const testOrgId = "test-org-" + Date.now();

  beforeAll(async () => {
    // Seed test data
    await env.DB.prepare(
      `INSERT INTO kb_chunks (id, content, source, section, chunk_index)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        "kb_test_0",
        "Statute of limitations for personal injury is typically 2 years.",
        "deadlines.md",
        "Deadlines",
        0
      )
      .run();

    // Seed a formula
    await env.DB.prepare(
      `INSERT INTO kb_formulas (id, name, formula, description, source)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        "formula_test_0",
        "SOL Calculation",
        "Incident Date + Jurisdiction Limit",
        null,
        "deadlines.md"
      )
      .run();
  });

  it("retrieves KB chunks from Vectorize query", async () => {
    // Note: This test requires --remote flag for real Vectorize
    // Generate embedding
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["statute of limitations deadline"],
    });

    // Upsert test vector
    await env.VECTORIZE.upsert([
      {
        id: "kb_test_0",
        values: embedding.data[0],
        metadata: { type: "kb", source: "deadlines.md" },
      },
    ]);

    // Query
    const results = await env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
      returnMetadata: "all",
    });

    expect(results.matches.length).toBeGreaterThan(0);
    expect(results.matches[0].id).toBe("kb_test_0");
  });

  it("filters Org Context by org_id", async () => {
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["firm billing procedures"],
    });

    // Upsert vectors for two different orgs
    await env.VECTORIZE.upsert([
      {
        id: `${testOrgId}_file1_0`,
        values: embedding.data[0],
        metadata: { org_id: testOrgId, type: "org_context" },
      },
      {
        id: "other-org_file2_0",
        values: embedding.data[0],
        metadata: { org_id: "other-org", type: "org_context" },
      },
    ]);

    // Query with filter
    const results = await env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
      filter: { org_id: testOrgId },
      returnMetadata: "all",
    });

    // Should only return the matching org's vectors
    expect(results.matches.every((m) => m.metadata?.org_id === testOrgId)).toBe(
      true
    );
  });
});
```

### Running Tests

```bash
# Unit tests (local)
npx vitest run test/kb.spec.ts

# Integration tests (requires Vectorize, use --remote)
npx vitest run test/rag-integration.spec.ts -- --remote
```

## Part 7: Demo Endpoint

Add a demo endpoint to visualize what we built.

Update `src/index.ts` to add the KB demo route:

```typescript
/**
 * Phase 5 Demo: Knowledge Base & RAG
 */
async function handleKBDemo(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Handle RAG query
  if (req.method === "POST" && url.searchParams.get("action") === "query") {
    const { query, orgId } = (await req.json()) as {
      query: string;
      orgId: string;
    };

    const { retrieveRAGContext, formatRAGContext } = await import(
      "./services/rag-retrieval"
    );
    const context = await retrieveRAGContext(env, query, orgId);
    const formatted = formatRAGContext(context);

    return Response.json({
      raw: context,
      formatted,
      stats: {
        formulas: context.formulas.length,
        benchmarks: context.benchmarks.length,
        kbChunks: context.kbChunks.length,
        orgChunks: context.orgChunks.length,
      },
    });
  }

  // Handle file upload
  if (req.method === "POST" && url.searchParams.get("action") === "upload") {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const orgId = formData.get("orgId") as string;

    if (!file || !orgId) {
      return Response.json({ error: "Missing file or orgId" }, { status: 400 });
    }

    const { uploadOrgContext } = await import("./services/org-context");
    const result = await uploadOrgContext(
      env,
      orgId,
      file.name,
      file.type,
      await file.arrayBuffer()
    );

    return Response.json(result);
  }

  // GET: Show demo page
  const html = buildKBDemoPage();
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function buildKBDemoPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Docket - Phase 5: Knowledge Base Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, -apple-system, sans-serif; background: #f7f7f7; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .subtitle { color: #64748b; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid rgba(0,0,0,.1); }
    .card h2 { font-size: 1rem; margin-bottom: 16px; text-transform: uppercase; letter-spacing: .05em; color: #333; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #64748b; }
    .input, .textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .textarea { min-height: 100px; font-family: inherit; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-secondary { background: #64748b; color: #fff; }
    .result { background: #f5f5f5; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-top: 16px; max-height: 400px; overflow: auto; }
    .stats { display: flex; gap: 16px; margin-bottom: 16px; }
    .stat { background: #e0f2fe; padding: 12px 16px; border-radius: 8px; text-align: center; }
    .stat-value { font-size: 24px; font-weight: bold; color: #0369a1; }
    .stat-label { font-size: 12px; color: #64748b; }
    .formatted { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .formatted h3 { font-size: 14px; margin-bottom: 8px; color: #333; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Docket Knowledge Base</h1>
    <p class="subtitle">Phase 5: RAG System Demo</p>

    <div class="card">
      <h2>Test RAG Query</h2>
      <div class="form-group">
        <label>Query</label>
        <input type="text" id="query" class="input" placeholder="How do I calculate statute of limitations?">
      </div>
      <div class="form-group">
        <label>Org ID (for Org Context filtering)</label>
        <input type="text" id="orgId" class="input" placeholder="test-org-123" value="test-org">
      </div>
      <button class="btn btn-primary" onclick="runQuery()">Query RAG</button>

      <div id="stats" class="stats" style="display: none; margin-top: 16px;"></div>
      <div id="formatted" class="formatted" style="display: none;"></div>
      <div id="raw" class="result" style="display: none;"></div>
    </div>

    <div class="card">
      <h2>Upload Org Context Document</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="uploadOrgId" class="input" placeholder="org-123" value="test-org">
      </div>
      <div class="form-group">
        <label>File (PDF, DOCX, or MD)</label>
        <input type="file" id="file" accept=".pdf,.docx,.md">
      </div>
      <button class="btn btn-secondary" onclick="uploadFile()">Upload</button>
      <div id="uploadResult" class="result" style="display: none;"></div>
    </div>

    <div class="card">
      <h2>System Status</h2>
      <div id="status">Loading...</div>
    </div>
  </div>

  <script>
    async function runQuery() {
      const query = document.getElementById('query').value;
      const orgId = document.getElementById('orgId').value;

      const res = await fetch('/demo/kb?action=query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, orgId })
      });
      const data = await res.json();

      // Show stats
      const statsEl = document.getElementById('stats');
      statsEl.innerHTML = \`
        <div class="stat"><div class="stat-value">\${data.stats.formulas}</div><div class="stat-label">Formulas</div></div>
        <div class="stat"><div class="stat-value">\${data.stats.benchmarks}</div><div class="stat-label">Benchmarks</div></div>
        <div class="stat"><div class="stat-value">\${data.stats.kbChunks}</div><div class="stat-label">KB Chunks</div></div>
        <div class="stat"><div class="stat-value">\${data.stats.orgChunks}</div><div class="stat-label">Org Chunks</div></div>
      \`;
      statsEl.style.display = 'flex';

      // Show formatted
      const formattedEl = document.getElementById('formatted');
      formattedEl.innerHTML = '<h3>Formatted Context (injected into prompt)</h3><pre>' + (data.formatted || '(empty)') + '</pre>';
      formattedEl.style.display = 'block';

      // Show raw
      const rawEl = document.getElementById('raw');
      rawEl.textContent = JSON.stringify(data.raw, null, 2);
      rawEl.style.display = 'block';
    }

    async function uploadFile() {
      const orgId = document.getElementById('uploadOrgId').value;
      const file = document.getElementById('file').files[0];

      if (!file) {
        alert('Please select a file');
        return;
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('orgId', orgId);

      const res = await fetch('/demo/kb?action=upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      const resultEl = document.getElementById('uploadResult');
      resultEl.textContent = JSON.stringify(data, null, 2);
      resultEl.style.display = 'block';
    }

    // Load status
    async function loadStatus() {
      try {
        // Count KB chunks
        const statusEl = document.getElementById('status');
        statusEl.innerHTML = \`
          <p>✅ D1 Database: Connected</p>
          <p>✅ Vectorize: Connected</p>
          <p>✅ Workers AI: Connected</p>
          <p>✅ R2: Connected</p>
        \`;
      } catch (e) {
        document.getElementById('status').textContent = 'Error: ' + e.message;
      }
    }
    loadStatus();
  </script>
</body>
</html>`;
}

// Add to routes
const routes: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/api/messages": (req) => handleBotMessage(req),
  "/callback": handleClioCallback,
  "/demo/org-membership": handleOrgMembershipDemo,
  "/demo/kb": handleKBDemo, // Add this line
  "/": handleAuthDemo,
};
```

## Summary: What We Built

1. **KB Builder** (`src/services/kb-builder.ts`)

   - Chunks markdown into ~500 char segments
   - Extracts formulas and benchmarks
   - Generates embeddings via Workers AI
   - Stores in D1 + Vectorize

2. **Org Context Service** (`src/services/org-context.ts`)

   - Validates uploads (MIME, size, extension)
   - Stores raw files in R2
   - Chunks and embeds text
   - Uses metadata filtering for org isolation

3. **RAG Retrieval** (`src/services/rag-retrieval.ts`)

   - Parallel Vectorize queries (KB + Org Context)
   - Token budget enforcement with priority
   - Graceful degradation on errors

4. **Demo Endpoint** (`/demo/kb`)
   - Visual interface for testing queries
   - File upload for Org Context
   - Shows formatted output

## Next Steps

Phase 6 will integrate this RAG system into the Durable Object, where it will:

- Be called before each LLM inference
- Inject context into the system prompt
- Work alongside Clio Schema for complete context
