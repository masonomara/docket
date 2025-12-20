# Docket Knowledge Base

The Knowledge Base (KB) provides RAG context for AI responses. Two sections: KB (best legal practices, Clio workflows) and Org Context (firm-specific documents).

All users access both sections. Role restrictions apply only to editing Org Context on the Docket website.

## How Knowledge Base Works

The Durable Object makes two parallel Vectorize queries with the same embedding. Results inject into the system prompt alongside Clio Schema:

- `retrieveKBContext(query, jurisdiction, practiceType, firmSize)` → Vectorize with compound filter for Shared KB chunks
- `retrieveOrgContext(query, orgId)` → Vectorize (filter `{ type: "org", org_id }`) for firm-specific Org Context chunks

KB filtering uses org settings (jurisdiction, practiceType, firmSize) passed via ChannelMessage. General content and federal jurisdiction always included. Org Context is filtered by `org_id` only.

**Vector Type Separation:** All vectors include a `type` field (`"kb"` or `"org"`) to prevent cross-contamination when filtering on fields that may not exist on all vectors.

**Graceful Degradation:** Each org setting is optional. KB query always includes `general` + `federal`, then adds filters for each setting that exists. An org with only `practiceType` set gets general + federal + matching practice type content.

**Configuration:**

- Embedding model: `@cf/baai/bge-base-en-v1.5` (768 dimensions)
- Chunk size: ~500 characters
- Vectorize topK: 5 (no minimum score threshold - rely on token budget truncation)
- Token budget: 3,000 tokens for RAG context

## Knowledge Base Sections

**Shared KB** for Clio + practice management. This includes best practices and foundational knowledge like Clio workflows (matters, time entries, invoices, reports), deadline calculations (filing windows, discovery response times), practice management (intake checklists, conflict checks, matter stages), and billing guidance (retainers, trust accounting, LEDES).

**Org Context** for firm-specific uploads. This includes internal docs and administration information like internal templates, engagement letters, standard clauses, firm billing rates, documented firm workflows, and staff/team routing preferences.

## Org Context Upload Flow

**Upload:**

1. Admin uploads file on Docket website
2. Validate: MIME type + extension (PDF, DOCX, MD only), size limit (25MB), sanitize filename
3. Stores raw file in R2: `/orgs/{org_id}/docs/{file_id}` (file_id is UUID)
4. Parse to text (PDF: `unpdf`, DOCX: `mammoth`, MD: direct) - wrap in try/catch, log failures
5. Chunk text (~500 chars, chunk*id format: `{org_id}*{file*id}*{chunk_index}`)
6. Store chunks in D1 `org_context_chunks`
7. Generate embeddings (~100 chunks per batch)
8. Upsert to Vectorize with metadata `{ type: "org", org_id, source }`

**Delete/Update:**

1. Delete chunks from D1 where `chunk_id LIKE '{org_id}_{file_id}_%'`
2. Delete embeddings from Vectorize by chunk_id list
3. Delete raw file from R2
4. For updates: delete then re-upload (no in-place update)

## How Knowledge Base is Distributed

Vectorize: Embeddings only

- Shared KB embeddings: `{ type: "kb", category?, jurisdiction?, practice_type?, firm_size? }`
- Org Context embeddings: `{ type: "org", org_id, source }`

D1: Chunked text

- `kb_chunks` (shared)
- `org_context_chunks` (per-org, filtered by org_id)

R2: Raw uploaded files at `/orgs/{org_id}/docs/{file_id}`

## RAG Orchestration Flow

1. Generate query embedding (one embedding, used for both)
2. Query Vectorize (two parallel calls)
3. Fetch chunk text from D1 (`kb_chunks` and `org_context_chunks`)
4. Apply token budget (~3,000 tokens for RAG context), truncate and log dropped chunks
5. Format for system prompt:

```text
## Knowledge Base Context
[KB chunk text here]
*Source: case-management.md*

## Org Context (This Firm's Practices)
[Org context chunk text here]
*Source: firm-procedures.pdf*
```

6. Inject into system prompt alongside Clio Schema.

## Knowledge Base Creation at Build-Time

Full rebuild on each deploy ensures KB stays in sync with source markdown. No incremental updates.

**Build process:**

1. Run `npm run kb:manifest` — Node.js script reads `/kb` folder, outputs JSON manifest
2. Run `wrangler deploy` — Manifest bundled with worker
3. Call `POST /admin/seed-kb` — Triggers KB rebuild from manifest

**Seed function:**

1. Query D1 for all existing KB chunk IDs
2. Delete those IDs from Vectorize (batches of 100)
3. Delete all rows from `kb_chunks` in D1
4. Read files from bundled manifest (folder structure determines metadata)
5. Extract metadata from folder path (see structure below)
6. Chunk at ~500 characters, respecting section boundaries
7. Generate embeddings via Workers AI
8. Insert to D1 and Vectorize with metadata `{ type: "kb", category?, jurisdiction?, practice_type?, firm_size? }`

**Why explicit ID deletion:** Vectorize doesn't support filter-based deletion. Upserting with same IDs only works if file paths don't change. Tracking IDs ensures removed/renamed files don't leave orphaned vectors.

**Why manifest approach:** Workers can't access filesystem at runtime. Build script reads files, bundles as JSON, worker imports at deploy time.

**KB Folder Structure:**

```
/kb/
├── general/                        → category: "general" (always included)
│   ├── clio-workflows.md
│   ├── practice-management.md
│   └── billing-guidance.md
├── jurisdictions/
│   ├── federal/                    → jurisdiction: "federal" (always included alongside state)
│   ├── CA/                         → jurisdiction: "CA"
│   └── NY/                         → jurisdiction: "NY"
├── practice-types/
│   ├── personal-injury-law/        → practice_type: "personal-injury-law"
│   ├── family-law/                 → practice_type: "family-law"
│   ├── criminal-law/               → practice_type: "criminal-law"
│   ├── immigration-law/            → practice_type: "immigration-law"
│   └── ...
└── firm-sizes/
    ├── solo/                       → firm_size: "solo"
    ├── small/                      → firm_size: "small"
    ├── mid/                        → firm_size: "mid"
    └── large/                      → firm_size: "large"
```

**Filtering Logic:**

| Folder | Metadata | When Included |
|--------|----------|---------------|
| `general/` | `category: "general"` | Always |
| `jurisdictions/federal/` | `jurisdiction: "federal"` | Always (federal applies to all) |
| `jurisdictions/{state}/` | `jurisdiction: "{state}"` | When org.jurisdiction matches |
| `practice-types/{type}/` | `practice_type: "{type}"` | When org.practiceType matches |
| `firm-sizes/{size}/` | `firm_size: "{size}"` | When org.firmSize matches |

**Vectorize Query Filter:**

```typescript
// Build filter dynamically based on available settings
const orClauses = [
  { category: "general" },
  { jurisdiction: "federal" }, // Always include federal
];

if (org.jurisdiction) {
  orClauses.push({ jurisdiction: org.jurisdiction });
}
if (org.practiceType) {
  orClauses.push({ practice_type: org.practiceType });
}
if (org.firmSize) {
  orClauses.push({ firm_size: org.firmSize });
}

filter: { type: "kb", $or: orClauses }
```

Each setting is optional. An org with only `practiceType` set gets: general + federal + matching practice type.

## Error Handling

RAG failures return empty context (graceful degradation) so AI can continue without KB context rather than failing the entire request.

```typescript
catch (error) {
  console.error("[RAG] Retrieval error:", error);
  return { kbChunks: [], orgChunks: [] };
}
```
