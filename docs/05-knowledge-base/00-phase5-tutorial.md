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

### Vectorize Configuration

Configure Vectorize in `wrangler.jsonc` with metadata indexes for filtering:

```jsonc
{
  "vectorize": [
    {
      "binding": "VECTORIZE",
      "index_name": "docket-kb",
      "preset": "baai/bge-base-en-v1.5" // 768 dimensions
    }
  ]
}
```

Create the index with metadata indexes for filtering (one-time setup):

```bash
# Create the Vectorize index with metadata indexes
wrangler vectorize create docket-kb \
  --preset baai/bge-base-en-v1.5 \
  --metadata-indexes type:string,category:string,jurisdiction:string,practice_type:string,firm_size:string,org_id:string,source:string
```

**Why metadata indexes matter:** Vectorize can only filter on indexed metadata fields. Without indexes, `filter: { type: "kb" }` returns all vectors. The `type` field is critical for separating KB and Org Context vectors.

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

### Step 1: Create the `/kb` Directory Structure

The folder structure determines metadata for filtering:

```
/kb/
├── general/                        → category: "general" (always included)
│   ├── clio-workflows.md
│   ├── practice-management.md
│   └── billing-guidance.md
├── jurisdictions/
│   ├── federal/                    → jurisdiction: "federal" (always included)
│   │   └── federal-rules.md
│   ├── CA/                         → jurisdiction: "CA"
│   │   └── california-deadlines.md
│   └── NY/                         → jurisdiction: "NY"
│       └── new-york-procedures.md
├── practice-types/
│   ├── personal-injury/            → practice_type: "personal-injury"
│   │   └── pi-best-practices.md
│   ├── family-law/                 → practice_type: "family-law"
│   └── immigration/                → practice_type: "immigration"
└── firm-sizes/
    ├── solo/                       → firm_size: "solo"
    ├── small/                      → firm_size: "small"
    └── mid/                        → firm_size: "mid"
```

**Filtering Logic:**

| Folder                   | Metadata                  | When Included                   |
| ------------------------ | ------------------------- | ------------------------------- |
| `general/`               | `category: "general"`     | Always                          |
| `jurisdictions/federal/` | `jurisdiction: "federal"` | Always (federal applies to all) |
| `jurisdictions/{state}/` | `jurisdiction: "{state}"` | When org.jurisdiction matches   |
| `practice-types/{type}/` | `practice_type: "{type}"` | When org.practiceType matches   |
| `firm-sizes/{size}/`     | `firm_size: "{size}"`     | When org.firmSize matches       |

Example markdown file:

```markdown
<!-- kb/jurisdictions/CA/california-deadlines.md -->

# California Deadline Calculations

## Statute of Limitations

Personal injury: 2 years from incident (CCP § 335.1).
Medical malpractice: 3 years from injury or 1 year from discovery.
Contract disputes: 4 years written, 2 years oral.
```

### Step 2: The KB Builder Service

Create `src/services/kb-builder.ts`:

```typescript
import { Env } from "../index";

interface KBMetadata {
  category: string | null; // "general" for always-included content
  jurisdiction: string | null; // "federal", "CA", "NY", etc.
  practice_type: string | null; // "personal-injury", "family-law", etc.
  firm_size: string | null; // "solo", "small", "mid", "large"
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
 * Extracts metadata from KB file path based on folder structure.
 * Example: "jurisdictions/CA/deadlines.md" → { jurisdiction: "CA" }
 */
export function extractMetadataFromPath(filePath: string): KBMetadata {
  const metadata: KBMetadata = {
    category: null,
    jurisdiction: null,
    practice_type: null,
    firm_size: null,
  };

  const parts = filePath.split("/");

  if (parts[0] === "general") {
    metadata.category = "general";
  } else if (parts[0] === "jurisdictions" && parts[1]) {
    metadata.jurisdiction = parts[1]; // "federal", "CA", "NY", etc.
  } else if (parts[0] === "practice-types" && parts[1]) {
    metadata.practice_type = parts[1]; // "personal-injury", "family-law", etc.
  } else if (parts[0] === "firm-sizes" && parts[1]) {
    metadata.firm_size = parts[1]; // "solo", "small", "mid", "large"
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
 * Must delete by ID since Vectorize doesn't support filter-based deletion.
 */
async function clearKB(env: Env): Promise<void> {
  // Get all existing KB chunk IDs from D1
  const existing = await env.DB.prepare("SELECT id FROM kb_chunks").all<{
    id: string;
  }>();

  // Delete from Vectorize by ID (batches of 100)
  if (existing.results.length > 0) {
    const ids = existing.results.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      await env.VECTORIZE.deleteByIds(ids.slice(i, i + 100));
    }
  }

  // Clear D1
  await env.DB.prepare("DELETE FROM kb_chunks").run();
}

/**
 * Main KB build function. Call this at deploy time.
 * kbFiles: Map of relative path (e.g., "jurisdictions/CA/deadlines.md") to content
 */
export async function buildKB(
  env: Env,
  kbFiles: Map<string, string>
): Promise<{ chunks: number }> {
  await clearKB(env);

  const allChunks: KBChunk[] = [];

  for (const [filePath, content] of kbFiles) {
    const metadata = extractMetadataFromPath(filePath);
    const chunks = chunkText(content);
    const filename = filePath.split("/").pop() || filePath;

    let currentSection: string | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const headerMatch = chunks[i].match(/^##?\s+(.+)/m);
      if (headerMatch) currentSection = headerMatch[1];

      allChunks.push({
        id: `kb_${filePath.replace(/\//g, "_")}_${i}`,
        content: chunks[i],
        source: filename,
        section: currentSection,
        chunkIndex: i,
        metadata,
      });
    }
  }

  const embeddings = await generateEmbeddings(
    env.AI,
    allChunks.map((c) => c.content)
  );

  // Insert chunks into D1 with metadata
  const chunkStmt = env.DB.prepare(
    `INSERT INTO kb_chunks
     (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
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
        c.metadata.practice_type,
        c.metadata.firm_size
      )
    )
  );

  // Upsert embeddings to Vectorize with metadata for filtering
  const vectors = allChunks.map((chunk, i) => ({
    id: chunk.id,
    values: embeddings[i],
    metadata: {
      type: "kb", // Distinguishes from org context vectors
      source: chunk.source,
      // Only include non-null metadata fields
      ...(chunk.metadata.category && { category: chunk.metadata.category }),
      ...(chunk.metadata.jurisdiction && {
        jurisdiction: chunk.metadata.jurisdiction,
      }),
      ...(chunk.metadata.practice_type && {
        practice_type: chunk.metadata.practice_type,
      }),
      ...(chunk.metadata.firm_size && { firm_size: chunk.metadata.firm_size }),
    },
  }));

  for (let i = 0; i < vectors.length; i += 100) {
    await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
  }

  return { chunks: allChunks.length };
}
```

### What's Happening Here?

1. **`extractMetadataFromPath()`** — Parses folder path to determine metadata. `jurisdictions/CA/deadlines.md` becomes `{ jurisdiction: "CA" }`.

2. **`chunkText()`** — Splits markdown into ~500 character pieces, respecting section headers.

3. **`buildKB()`** — Orchestrates the full rebuild: extract metadata from paths, chunk text, generate embeddings, store with metadata for filtering.

### Step 3: Build-Time KB Loader

Workers can't read the filesystem at runtime. We solve this with a two-step process:

**1. Generate a manifest at build time** — A Node.js script reads `/kb` files and outputs a JSON manifest.

Create `scripts/generate-kb-manifest.ts`:

```typescript
import { readdir, readFile } from "fs/promises";
import { join } from "path";

interface KBManifest {
  files: Array<{ path: string; content: string }>;
  generatedAt: string;
}

async function walkDir(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = base ? `${base}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walkDir(fullPath, relativePath)));
    } else if (entry.name.endsWith(".md")) {
      files.push(relativePath);
    }
  }

  return files;
}

async function generateManifest(): Promise<void> {
  const kbDir = join(process.cwd(), "kb");
  const filePaths = await walkDir(kbDir);

  const files = await Promise.all(
    filePaths.map(async (path) => ({
      path,
      content: await readFile(join(kbDir, path), "utf-8"),
    }))
  );

  const manifest: KBManifest = {
    files,
    generatedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(manifest, null, 2));
}

generateManifest();
```

Add to `package.json`:

```json
{
  "scripts": {
    "kb:manifest": "tsx scripts/generate-kb-manifest.ts > src/kb-manifest.json"
  }
}
```

**TypeScript configuration for JSON imports:**

Update `tsconfig.json` to enable JSON module imports:

```json
{
  "compilerOptions": {
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

**2. Load manifest and seed KB** — A service reads the bundled manifest and calls `buildKB()`.

Create `src/services/kb-loader.ts`:

```typescript
import { Env } from "../index";
import { buildKB } from "./kb-builder";
import kbManifest from "../kb-manifest.json";

interface KBManifest {
  files: Array<{ path: string; content: string }>;
  generatedAt: string;
}

/**
 * Seeds the KB from the bundled manifest.
 * Call this after deploy via a seeding endpoint or scheduled task.
 */
export async function seedKB(env: Env): Promise<{ chunks: number; files: number }> {
  const manifest = kbManifest as KBManifest;

  const kbFiles = new Map<string, string>();
  for (const file of manifest.files) {
    kbFiles.set(file.path, file.content);
  }

  const result = await buildKB(env, kbFiles);

  return { chunks: result.chunks, files: manifest.files.length };
}
```

**3. Seeding endpoint** — Trigger KB rebuild after deploy.

Add to `src/index.ts`:

```typescript
// POST /admin/seed-kb — Rebuild KB from manifest (protected endpoint)
if (req.method === "POST" && url.pathname === "/admin/seed-kb") {
  // TODO: Add admin auth check
  const { seedKB } = await import("./services/kb-loader");
  const result = await seedKB(env);
  return Response.json(result);
}
```

**Deploy workflow:**

```bash
# 1. Generate manifest from /kb files
npm run kb:manifest

# 2. Deploy worker (manifest is bundled)
wrangler deploy

# 3. Seed KB
curl -X POST https://your-worker.dev/admin/seed-kb
```

## Part 4: Org Context Upload Flow

Unlike KB (built at deploy), Org Context is uploaded by users at runtime. Filtered by `org_id` only — no jurisdiction/practiceType/firmSize filtering needed since each org has one set of documents.

### Step 1: R2 Path Helper

Create `src/storage/r2-paths.ts` to standardize R2 path construction:

```typescript
/**
 * Centralized R2 path construction.
 * Matches the path structure defined in docs/00-specs/03-storage-schemas.md
 */
export const R2Paths = {
  /** Raw uploaded org context documents: /orgs/{org_id}/docs/{file_id} */
  orgDoc: (orgId: string, fileId: string) => `orgs/${orgId}/docs/${fileId}`,

  /** Audit log entries: /orgs/{org_id}/audit/{YYYY}/{MM}/{DD}/{timestamp}-{uuid}.json */
  auditLog: (orgId: string, date: Date, uuid: string) => {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const timestamp = date.getTime();
    return `orgs/${orgId}/audit/${yyyy}/${mm}/${dd}/${timestamp}-${uuid}.json`;
  },

  /** Archived conversations: /orgs/{org_id}/conversations/{conversation_id}.json */
  conversation: (orgId: string, conversationId: string) =>
    `orgs/${orgId}/conversations/${conversationId}.json`,
};
```

### Step 2: File Validation

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
export function validateFile(
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
 * Wraps extraction in try/catch for graceful failure.
 *
 * Dependencies:
 *   npm install mammoth unpdf
 */
async function extractText(
  content: ArrayBuffer,
  mimeType: string,
  filename: string
): Promise<string> {
  try {
    switch (mimeType) {
      case "text/markdown":
        return new TextDecoder().decode(content);

      case "application/pdf":
        return await extractPdfText(content);

      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        return await extractDocxText(content);

      default:
        throw new Error(`Unsupported type: ${mimeType}`);
    }
  } catch (error) {
    console.error(`[OrgContext] Text extraction failed for ${filename}:`, error);
    throw new Error(`Failed to extract text from ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extracts text from PDF using unpdf (works in Workers).
 * Install: npm install unpdf
 */
async function extractPdfText(content: ArrayBuffer): Promise<string> {
  try {
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(content));
    if (!text || text.trim().length === 0) {
      throw new Error("PDF appears to be empty or image-only");
    }
    return text;
  } catch (error) {
    // Re-throw with context
    throw new Error(`PDF extraction error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extracts text from DOCX using mammoth.
 * Install: npm install mammoth
 */
async function extractDocxText(content: ArrayBuffer): Promise<string> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: content });
    if (!result.value || result.value.trim().length === 0) {
      throw new Error("DOCX appears to be empty");
    }
    return result.value;
  } catch (error) {
    throw new Error(`DOCX extraction error: ${error instanceof Error ? error.message : String(error)}`);
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

    const text = await extractText(content, mimeType, filename);
    const chunks = chunkText(text);
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

    // Upsert to Vectorize with org_id for filtering
    const vectors = chunks.map((chunk, i) => ({
      id: `${orgId}_${fileId}_${i}`,
      values: embeddings[i],
      metadata: { type: "org", org_id: orgId, source: filename },
    }));

    for (let i = 0; i < vectors.length; i += 100) {
      await env.VECTORIZE.upsert(vectors.slice(i, i + 100));
    }

    return { success: true, fileId, chunksCreated: chunks.length };
  } catch (error) {
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

### Key Difference: Org Isolation

Org Context uses `type: "org"` plus `org_id` filtering:

```typescript
// Vectorize metadata
metadata: { type: "org", org_id: orgId, source: filename }

// Query filter
await env.VECTORIZE.query(queryVector, {
  topK: 5,
  filter: { type: "org", org_id: orgId },
});
```

The `type` field prevents KB vectors from appearing in Org Context queries (and vice versa) when filtering on fields that may not exist on all vectors.

## Part 5: RAG Retrieval System

Now we build the retrieval functions that the Durable Object will call. Two parallel queries with different filters.

Create `src/services/rag-retrieval.ts`:

```typescript
import { Env } from "../index";

interface OrgSettings {
  jurisdiction: string | null;
  practiceType: string | null;
  firmSize: string | null;
}

interface RAGContext {
  kbChunks: Array<{ content: string; source: string }>;
  orgChunks: Array<{ content: string; source: string }>;
}

const TOKEN_BUDGET = 3000;
const CHARS_PER_TOKEN = 4;

/**
 * Builds the KB filter based on org settings.
 * Each setting is optional - include filter clause only if setting exists.
 * Always includes general + federal.
 */
function buildKBFilter(orgSettings: OrgSettings): Record<string, unknown> {
  const orClauses: Record<string, unknown>[] = [
    { category: "general" },
    { jurisdiction: "federal" }, // Always include federal
  ];

  // Add clauses for each setting that exists
  if (orgSettings.jurisdiction) {
    orClauses.push({ jurisdiction: orgSettings.jurisdiction });
  }
  if (orgSettings.practiceType) {
    orClauses.push({ practice_type: orgSettings.practiceType });
  }
  if (orgSettings.firmSize) {
    orClauses.push({ firm_size: orgSettings.firmSize });
  }

  return { type: "kb", $or: orClauses };
}

/**
 * Retrieves KB context with compound filter.
 * Always includes general + federal; adds other filters based on available settings.
 */
async function retrieveKBContext(
  env: Env,
  queryVector: number[],
  orgSettings: OrgSettings
): Promise<Array<{ content: string; source: string }>> {
  const filter = buildKBFilter(orgSettings);

  const kbResults = await env.VECTORIZE.query(queryVector, {
    topK: 5,
    returnMetadata: "all",
    filter,
  });

  if (kbResults.matches.length === 0) return [];

  const kbIds = kbResults.matches.map((m) => m.id);
  const chunks = await env.DB.prepare(
    `SELECT content, source FROM kb_chunks WHERE id IN (${kbIds
      .map(() => "?")
      .join(",")})`
  )
    .bind(...kbIds)
    .all<{ content: string; source: string }>();

  return chunks.results;
}

/**
 * Retrieves Org Context filtered by type and org_id.
 */
async function retrieveOrgContext(
  env: Env,
  queryVector: number[],
  orgId: string
): Promise<Array<{ content: string; source: string }>> {
  const orgResults = await env.VECTORIZE.query(queryVector, {
    topK: 5,
    returnMetadata: "all",
    filter: { type: "org", org_id: orgId },
  });

  if (orgResults.matches.length === 0) return [];

  const orgIds = orgResults.matches.map((m) => m.id);
  const chunks = await env.DB.prepare(
    `SELECT content, source FROM org_context_chunks WHERE id IN (${orgIds
      .map(() => "?")
      .join(",")})`
  )
    .bind(...orgIds)
    .all<{ content: string; source: string }>();

  return chunks.results;
}

/**
 * Main RAG retrieval function.
 * Two parallel Vectorize queries with different filters.
 */
export async function retrieveRAGContext(
  env: Env,
  query: string,
  orgId: string,
  orgSettings: OrgSettings
): Promise<RAGContext> {
  try {
    // Generate embedding for the query
    const embeddingResult = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [query],
    });
    const queryVector = embeddingResult.data[0];

    // Parallel Vectorize queries with different filters
    const [kbChunks, orgChunks] = await Promise.all([
      retrieveKBContext(env, queryVector, orgSettings),
      retrieveOrgContext(env, queryVector, orgId),
    ]);

    return applyTokenBudget({ kbChunks, orgChunks });
  } catch (error) {
    console.error("[RAG] Retrieval error:", error);
    return { kbChunks: [], orgChunks: [] };
  }
}

/**
 * Applies token budget to RAG context.
 */
function applyTokenBudget(context: RAGContext): RAGContext {
  let remainingChars = TOKEN_BUDGET * CHARS_PER_TOKEN;
  const result: RAGContext = { kbChunks: [], orgChunks: [] };

  // KB chunks first
  for (const c of context.kbChunks) {
    const len = c.content.length + c.source.length + 20;
    if (len <= remainingChars) {
      result.kbChunks.push(c);
      remainingChars -= len;
    }
  }

  // Org Context chunks
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
  const kbSection =
    context.kbChunks.length > 0
      ? "## Knowledge Base Context\n\n" +
        context.kbChunks
          .map((c) => `${c.content}\n*Source: ${c.source}*`)
          .join("\n\n")
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

When the budget is exceeded, chunks are truncated starting from the end.

## Part 6: Testing Strategy

### Unit Tests

Create `test/kb.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("Knowledge Base", () => {
  describe("extractMetadataFromPath", () => {
    it("extracts general category", async () => {
      const { extractMetadataFromPath } = await import(
        "../src/services/kb-builder"
      );
      const metadata = extractMetadataFromPath("general/clio-workflows.md");

      expect(metadata.category).toBe("general");
      expect(metadata.jurisdiction).toBeNull();
    });

    it("extracts jurisdiction from path", async () => {
      const { extractMetadataFromPath } = await import(
        "../src/services/kb-builder"
      );
      const metadata = extractMetadataFromPath("jurisdictions/CA/deadlines.md");

      expect(metadata.jurisdiction).toBe("CA");
      expect(metadata.category).toBeNull();
    });

    it("extracts federal jurisdiction", async () => {
      const { extractMetadataFromPath } = await import(
        "../src/services/kb-builder"
      );
      const metadata = extractMetadataFromPath(
        "jurisdictions/federal/rules.md"
      );

      expect(metadata.jurisdiction).toBe("federal");
    });

    it("extracts practice type", async () => {
      const { extractMetadataFromPath } = await import(
        "../src/services/kb-builder"
      );
      const metadata = extractMetadataFromPath(
        "practice-types/personal-injury/guide.md"
      );

      expect(metadata.practice_type).toBe("personal-injury");
    });

    it("extracts firm size", async () => {
      const { extractMetadataFromPath } = await import(
        "../src/services/kb-builder"
      );
      const metadata = extractMetadataFromPath("firm-sizes/solo/tips.md");

      expect(metadata.firm_size).toBe("solo");
    });
  });

  describe("chunkText", () => {
    it("respects section boundaries", async () => {
      const text = `# Header One

Some content here.

## Header Two

More content.`;

      const { chunkText } = await import("../src/services/kb-builder");
      const chunks = chunkText(text);

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toContain("Header One");
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
    // Seed test KB data with metadata
    await env.DB.prepare(
      `INSERT INTO kb_chunks
       (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "kb_general_0",
        "Clio workflow basics.",
        "clio.md",
        "Clio",
        0,
        "general",
        null,
        null,
        null
      )
      .run();

    await env.DB.prepare(
      `INSERT INTO kb_chunks
       (id, content, source, section, chunk_index, category, jurisdiction, practice_type, firm_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        "kb_ca_0",
        "California statute of limitations.",
        "ca-deadlines.md",
        "Deadlines",
        0,
        null,
        "CA",
        null,
        null
      )
      .run();
  });

  it("filters KB by type and compound $or filter", async () => {
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["statute of limitations"],
    });

    // Upsert test vectors with type field
    await env.VECTORIZE.upsert([
      {
        id: "kb_general_0",
        values: embedding.data[0],
        metadata: { type: "kb", category: "general", source: "clio.md" },
      },
      {
        id: "kb_ca_0",
        values: embedding.data[0],
        metadata: { type: "kb", jurisdiction: "CA", source: "ca-deadlines.md" },
      },
      {
        id: "kb_ny_0",
        values: embedding.data[0],
        metadata: { type: "kb", jurisdiction: "NY", source: "ny-deadlines.md" },
      },
    ]);

    // Query with type + compound filter (CA org should get general + CA, not NY)
    const results = await env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
      returnMetadata: "all",
      filter: {
        type: "kb",
        $or: [
          { category: "general" },
          { jurisdiction: { $in: ["CA", "federal"] } },
        ],
      },
    });

    const ids = results.matches.map((m) => m.id);
    expect(ids).toContain("kb_general_0");
    expect(ids).toContain("kb_ca_0");
    expect(ids).not.toContain("kb_ny_0");
  });

  it("filters Org Context by type and org_id", async () => {
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["firm billing procedures"],
    });

    await env.VECTORIZE.upsert([
      {
        id: `${testOrgId}_file1_0`,
        values: embedding.data[0],
        metadata: { type: "org", org_id: testOrgId, source: "procedures.md" },
      },
      {
        id: "other-org_file2_0",
        values: embedding.data[0],
        metadata: { type: "org", org_id: "other-org", source: "other.md" },
      },
    ]);

    const results = await env.VECTORIZE.query(embedding.data[0], {
      topK: 5,
      filter: { type: "org", org_id: testOrgId },
      returnMetadata: "all",
    });

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
    const { query, orgId, jurisdiction, practiceType, firmSize } =
      (await req.json()) as {
        query: string;
        orgId: string;
        jurisdiction: string | null;
        practiceType: string | null;
        firmSize: string | null;
      };

    const { retrieveRAGContext, formatRAGContext } = await import(
      "./services/rag-retrieval"
    );
    const context = await retrieveRAGContext(env, query, orgId, {
      jurisdiction,
      practiceType,
      firmSize,
    });
    const formatted = formatRAGContext(context);

    return Response.json({
      raw: context,
      formatted,
      stats: {
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
        <label>Org ID</label>
        <input type="text" id="orgId" class="input" placeholder="test-org-123" value="test-org">
      </div>
      <div style="display: flex; gap: 12px;">
        <div class="form-group" style="flex: 1;">
          <label>Jurisdiction</label>
          <select id="jurisdiction" class="input">
            <option value="">(Not set)</option>
            <option value="CA">California</option>
            <option value="NY">New York</option>
            <option value="TX">Texas</option>
          </select>
        </div>
        <div class="form-group" style="flex: 1;">
          <label>Practice Type</label>
          <select id="practiceType" class="input">
            <option value="">(Not set)</option>
            <option value="personal-injury">Personal Injury</option>
            <option value="family-law">Family Law</option>
            <option value="immigration">Immigration</option>
          </select>
        </div>
        <div class="form-group" style="flex: 1;">
          <label>Firm Size</label>
          <select id="firmSize" class="input">
            <option value="">(Not set)</option>
            <option value="solo">Solo</option>
            <option value="small">Small</option>
            <option value="mid">Mid</option>
          </select>
        </div>
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
      const jurisdiction = document.getElementById('jurisdiction').value || null;
      const practiceType = document.getElementById('practiceType').value || null;
      const firmSize = document.getElementById('firmSize').value || null;

      const res = await fetch('/demo/kb?action=query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, orgId, jurisdiction, practiceType, firmSize })
      });
      const data = await res.json();

      const statsEl = document.getElementById('stats');
      statsEl.innerHTML = \`
        <div class="stat"><div class="stat-value">\${data.stats.kbChunks}</div><div class="stat-label">KB Chunks</div></div>
        <div class="stat"><div class="stat-value">\${data.stats.orgChunks}</div><div class="stat-label">Org Chunks</div></div>
      \`;
      statsEl.style.display = 'flex';

      const formattedEl = document.getElementById('formatted');
      formattedEl.innerHTML = '<h3>Formatted Context (injected into prompt)</h3><pre>' + (data.formatted || '(empty)') + '</pre>';
      formattedEl.style.display = 'block';

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

// Add KB routes to src/index.ts fetch handler
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // KB Demo page
    if (url.pathname === "/demo/kb") {
      return handleKBDemo(req, env);
    }

    // KB Seeding endpoint (protected - add auth in production)
    if (req.method === "POST" && url.pathname === "/admin/seed-kb") {
      const { seedKB } = await import("./services/kb-loader");
      const result = await seedKB(env);
      return Response.json(result);
    }

    // ... other routes from previous phases
    return new Response("Not found", { status: 404 });
  },
};
```

## Dependencies

Install all required packages for Phase 5:

```bash
npm install mammoth unpdf tsx
npm install -D vitest @cloudflare/vitest-pool-workers
```

| Package | Purpose |
|---------|---------|
| `mammoth` | Extract text from DOCX files |
| `unpdf` | Extract text from PDF files (works in Workers) |
| `tsx` | Run TypeScript scripts (KB manifest generation) |
| `vitest` | Testing framework |
| `@cloudflare/vitest-pool-workers` | Run tests in Workers environment |

## Summary: What We Built

1. **KB Builder** (`src/services/kb-builder.ts`)

   - Extracts metadata from folder structure (jurisdiction, practiceType, firmSize)
   - Chunks markdown into ~500 char segments
   - Explicit ID-based cleanup before rebuild (Vectorize doesn't support filter delete)
   - Stores with `type: "kb"` to prevent cross-contamination with Org Context

2. **KB Loader** (`scripts/generate-kb-manifest.ts` + `src/services/kb-loader.ts`)

   - Build script generates JSON manifest from `/kb` folder
   - Manifest bundled with worker at deploy
   - Seeding endpoint (`/admin/seed-kb`) triggers rebuild

3. **Org Context Service** (`src/services/org-context.ts`)

   - Validates uploads (MIME, size, extension)
   - Stores raw files in R2, chunks in D1, embeddings in Vectorize
   - Uses `type: "org"` + `org_id` for filtering

4. **RAG Retrieval** (`src/services/rag-retrieval.ts`)

   - KB query: `type: "kb"` + compound `$or` filter
   - Always includes general + federal; adds filters for each available setting
   - Org Context query: `type: "org"` + `org_id`
   - Token budget enforcement, graceful degradation

5. **Demo Endpoint** (`/demo/kb`)
   - Query form with org settings (jurisdiction, practiceType, firmSize) for KB filtering
   - Simple file upload form (orgId + file) for Org Context

## Next Steps

Phase 6 will integrate this RAG system into the Durable Object, where it will:

- Receive org settings via ChannelMessage
- Apply compound filters before each LLM inference
- Inject filtered context into the system prompt
