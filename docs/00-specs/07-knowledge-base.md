# Docket Knowledge Base

The Knowledge Base (KB) provides RAG context for AI responses. Two sections: KB (best legal practices, Clio workflows) and Org Context (firm-specific documents).

All users access both sections. Role restrictions apply only to editing Org Context on the Docket website.

## How Knowledge Base Works

The Durable Object makes two parallel Vectorize queries with the same embedding. Results inject into the system prompt alongside Clio Schema:

- `retrieveKBContext(query, jurisdiction, practiceType, firmSize)` → Vectorize with compound filter for Shared KB chunks
- `retrieveOrgContext(query, orgId)` → Vectorize (filter `{ org_id }`) for firm-specific Org Context chunks

KB filtering uses org settings (jurisdiction, practiceType, firmSize) passed via ChannelMessage. General content (Clio workflows, etc.) always included. Org Context inherits org settings on upload.

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
4. Parse to text (PDF: pdf-parse, DOCX: mammoth, MD: direct) - wrap in try/catch, log failures
5. Chunk text (~500 chars, chunk*id format: `{org_id}*{file*id}*{chunk_index}`)
6. Store chunks in D1 `org_context_chunks`
7. Generate embeddings (~100 chunks per batch)
8. Upsert to Vectorize with metadata `{ org_id, jurisdiction, practice_type, firm_size }` (inherited from org settings)

**Delete/Update:**

1. Delete chunks from D1 where `chunk_id LIKE '{org_id}_{file_id}_%'`
2. Delete embeddings from Vectorize by chunk_id list
3. Delete raw file from R2
4. For updates: delete then re-upload (no in-place update)

## How Knowledge Base is Distributed

Vectorize: Embeddings only

- Shared KB embeddings (general always included; others filtered by `{ jurisdiction, practice_type, firm_size }`)
- Org Context embeddings (filtered by `{ org_id }`)

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

Full rebuild on each deploy ensures KB stays in sync with source markdown. No incremental updates. KB built at deploy. Function would:

1. Clear old data: Delete all rows from `kb_chunks`; delete all non-org embeddings from Vectorize
2. Read markdown files from `/kb` directory (folder structure determines metadata)
3. Extract metadata from folder path (see structure below)
4. Chunk at ~500 characters, respecting section boundaries
5. Generate embeddings via Workers AI
6. Insert to D1 and Vectorize with metadata `{ category, jurisdiction, practice_type, firm_size }`

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
filter: {
  $or: [
    { category: "general" },
    { jurisdiction: { $in: [org.jurisdiction, "federal"] } },
    { practice_type: org.practiceType },
    { firm_size: org.firmSize }
  ]
}
```

## Error Handling

RAG failures return empty context (graceful degradation) so AI can continue without KB context rather than failing the entire request.

```typescript
catch (error) {
  console.error("[RAG] Retrieval error:", error);
  return { kbChunks: [], orgChunks: [] };
}
```
