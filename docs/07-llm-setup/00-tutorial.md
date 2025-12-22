# Phase 7: Workers AI + RAG Tutorial

**LONGER DOC**

This tutorial walks through implementing the AI inference and RAG retrieval layer for Docket. By the end, you'll understand how LLMs, embeddings, vector databases, and tool calling work together to create an intelligent case management assistant.

## What We're Building

Phase 7 connects three major systems:

1. **RAG Retrieval** — Query Vectorize to find relevant Knowledge Base and Org Context chunks
2. **LLM Inference** — Call Workers AI to generate natural language responses
3. **Tool Calling** — Let the LLM request Clio operations via structured function calls

The result: users ask questions in plain English, and Docket responds with contextually-aware answers or executes Clio operations on their behalf.

```
User Message → Generate Embedding → Query Vectorize (KB + Org Context)
     ↓
Build System Prompt (RAG context + Clio Schema + History)
     ↓
Call LLM → Response or Tool Call?
     ↓                    ↓
  Return Text       Execute Tool → Feed Result Back → Return Text
```

## Prerequisites

Before starting Phase 7, ensure you have completed:

- **Phase 5**: Knowledge Base seeded in D1 + Vectorize
- **Phase 6**: Durable Object with SQLite tables for conversations, messages, pending confirmations

Your `wrangler.jsonc` should have these bindings configured:

```jsonc
{
  "ai": { "binding": "AI" },
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "docket-kb" }]
}
```

---

## Part 1: Understanding Embeddings

### What Are Embeddings?

Embeddings convert text into numerical vectors that capture semantic meaning. Similar concepts end up near each other in vector space.

```
"How do I create a new matter in Clio?"
    ↓ Workers AI embedding model
[0.023, -0.145, 0.089, ... 768 total dimensions]
```

### Why BGE-Base?

We use `@cf/baai/bge-base-en-v1.5` because:

- **768 dimensions** — Good balance of precision vs. storage cost
- **English-optimized** — Docket serves US/UK legal markets
- **Fast inference** — Low latency on Cloudflare's edge network
- **Cosine similarity** — Works well with Vectorize's cosine metric

### Generating Embeddings

Generate a single embedding for a user query

**Key insight**: The same embedding model must be used for both indexing (when we seed KB/Org Context) and querying (when users ask questions). Mixing models produces incompatible vectors.

---

## Part 2: Vector Search with Vectorize

### How Vectorize Works

Vectorize stores vectors with metadata. When you query, it finds vectors closest to your query vector using cosine similarity (closer to 1.0 = more similar).

Return top 5 matches, only search `{ type: "kb" }` vectors, (nor org), and include all metadata in response. Response structure shoudl resemle the following:

```typescript
// Results structure:
// {
//   matches: [
//     { id: "kb_chunk_123", score: 0.89, metadata: { source: "clio-workflows.md" } },
//     { id: "kb_chunk_456", score: 0.82, metadata: { source: "billing-guidance.md" } },
//   ]
// }
```

### Metadata Filtering Strategy

Vectorize doesn't support `$or` filters. To search multiple categories, run parallel queries and merge. Alwasy include `category: general`, `jurisdiction: "federal"` and org-specific filters like `jurisdiction: { $in: orgSettings.jurisdictions.slice(0, 5) }` or `practice_type: { $in: orgSettings.practiceTypes.slice(0, 5) }`

**Why limit to 5?** Each filter spawns a parallel Vectorize query. Too many filters = too many concurrent requests = rate limits.

### Merging Results by Score

After parallel queries complete, merge and deduplicate:

---

## Part 3: RAG Retrieval Flow

### The Complete Flow

1. Convert user query to vector
2. Search both KB and Org Context in parallel
3. Enforce token budget
4. Graceful degradation: continue without RAG

### Fetching Chunk Text from D1

Vectorize stores vectors, not text. After getting IDs from Vectorize, fetch actual content from D1:

Preserve relevance order from Vectorize scores

### Token Budget Management

Context windows are finite. Prioritize KB chunks (authoritative), then add Org Context:

- ~3000 tokens at 4 chars/token
- KB chunks first (higher priority)
- Org chunks with remaining budget

---

## Part 4: LLM Inference

### Model Selection

We use `@cf/meta/llama-3.1-8b-instruct` because:

- **128K context window** — Fits RAG context + conversation history
- **Instruction-tuned** — Follows system prompts reliably
- **Tool calling support** — Can output structured function calls
- **Edge-optimized** — Fast inference on Cloudflare

### Building the System Prompt

The system prompt sets Docket's behavior and provides context:

```typescript
function buildSystemPrompt(ragContext: string, userRole: string): string {
  const roleNote =
    userRole === "admin"
      ? "This user is an Admin and can perform create/update/delete operations with confirmation."
      : "This user is a Member with read-only access to Clio.";

  return `You are Docket, a case management assistant for legal teams using Clio.

**Tone:** Helpful, competent, deferential. You assist—you don't lead.

**User Role:** ${userRole}
${roleNote}

**Knowledge Base Context:**
${ragContext || "No relevant context found."}

**Clio Schema Reference:**
${formatSchemaCache()}

**Instructions:**
- Use Knowledge Base and firm context for case management questions
- Query Clio using the clioQuery tool per the schema above
- For write operations (create, update, delete), always confirm first
- NEVER give legal advice—you manage cases, not law
- Stay in scope: case management, Clio operations, firm procedures`;
}
```

### Calling the LLM

- Handle string response (no tool calls)
- Handle structured response with potential tool calls

### Error Handling

Workers AI has specific error codes. Handle gracefully:

| Code | Meaning             | Action                 |
| ---- | ------------------- | ---------------------- |
| 3040 | Rate limit (429)    | Retry once after 1s    |
| 3043 | Server error (500)  | Retry once after 1s    |
| 3036 | Daily limit reached | Fail with user message |
| 5007 | Model not found     | Log error, fail        |

- Retry once for transient errors

---

## Part 5: Tool Calling (clioQuery)

### Why One Tool?

We use a single `clioQuery` tool instead of separate tools per Clio object because:

1. **Security** — DO validates and builds Clio API calls, preventing injection
2. **Simplicity** — LLM picks operation + object type, we handle the rest
3. **Consistency** — Uniform permission enforcement for all operations

### Defining the Tool

```typescript
function getClioTools(userRole: string): object[] {
  const canModify = userRole === "admin";
  const modifyNote = canModify
    ? "Create/update/delete operations will require user confirmation."
    : "As a Member, only read operations are permitted.";

  return [
    {
      type: "function",
      function: {
        name: "clioQuery",
        description: `Query or modify Clio data. ${modifyNote}`,
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["read", "create", "update", "delete"],
              description: "The operation to perform",
            },
            objectType: {
              type: "string",
              enum: ["Matter", "Contact", "Task", "CalendarEntry", "TimeEntry"],
              description: "The Clio object type",
            },
            id: {
              type: "string",
              description: "Object ID (required for read single/update/delete)",
            },
            filters: {
              type: "object",
              description: "Query filters for list operations",
            },
            data: {
              type: "object",
              description: "Data for create/update operations",
            },
          },
          required: ["operation", "objectType"],
        },
      },
    },
  ];
}
```

### Handling Tool Calls

When the LLM returns a tool call, the DO processes it:

```typescript
async function handleToolCalls(
  message: ChannelMessage,
  toolCalls: ToolCall[]
): Promise<string> {
  const results: string[] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "clioQuery") {
      results.push(`Unknown tool: ${toolCall.name}`);
      continue;
    }

    const args = toolCall.arguments;

    // Permission check
    if (args.operation !== "read" && message.userRole !== "admin") {
      results.push(
        `You don't have permission to ${args.operation} ${args.objectType}s.`
      );
      continue;
    }

    // Read operations execute immediately
    if (args.operation === "read") {
      const readResult = await executeClioRead(message.userId, args);
      results.push(readResult);
      continue;
    }

    // CUD operations require confirmation
    await createPendingConfirmation(message, args);
    results.push(buildConfirmationPrompt(args));
  }

  return results.join("\n\n");
}
```

### CUD Confirmation Flow

For create/update/delete operations:

1. Store pending confirmation in DO SQLite (5-minute expiry)
2. Return confirmation prompt to user
3. On next message, classify user's intent (approve/reject/modify/unrelated)
4. Execute or cancel based on classification

```typescript
async function classifyConfirmationResponse(
  env: Env,
  userMessage: string,
  confirmation: PendingConfirmation
): Promise<{ intent: string; modifiedRequest?: string }> {
  const prompt = `A user was asked to confirm: ${confirmation.action} a ${confirmation.objectType}
The user responded: "${userMessage}"
Classify as ONE of: approve, reject, modify, unrelated
Respond with JSON: {"intent": "...", "modifiedRequest": "..."}`;

  const response = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt,
    max_tokens: 100,
  });

  // Parse JSON from response
  const jsonMatch = response.match(/\{[^}]+\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: "unclear" };
}
```

---

## Part 6: Putting It All Together

### The Message Processing Flow

1. Retrieve RAG context
2. Get conversation history
3. Build messages array
4. Call LLM with tools
5. Handle tool calls or return text

---

## Part 7: Testing

### Unit Tests

Test individual components in isolation:

```typescript
// test/rag-retrieval.spec.ts
import { describe, it, expect, vi } from "vitest";
import {
  retrieveRAGContext,
  formatRAGContext,
} from "../src/services/rag-retrieval";

describe("RAG Retrieval", () => {
  it("generates embeddings for user queries", async () => {
    const mockEnv = {
      AI: {
        run: vi.fn().mockResolvedValue({
          data: [[0.1, 0.2 /* ... 768 dimensions */]],
        }),
      },
      VECTORIZE: {
        query: vi.fn().mockResolvedValue({ matches: [] }),
      },
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      },
    };

    const result = await retrieveRAGContext(
      mockEnv as any,
      "How do I create a matter?",
      "org_123",
      { jurisdictions: ["CA"], practiceTypes: [], firmSize: null }
    );

    expect(mockEnv.AI.run).toHaveBeenCalledWith(
      "@cf/baai/bge-base-en-v1.5",
      expect.any(Object)
    );
  });

  it("formats RAG context with sources", () => {
    const context = {
      kbChunks: [
        { content: "Matters organize cases", source: "clio-workflows.md" },
      ],
      orgChunks: [{ content: "Use prefix MX-", source: "firm-procedures.pdf" }],
    };

    const formatted = formatRAGContext(context);

    expect(formatted).toContain("Knowledge Base");
    expect(formatted).toContain("Matters organize cases");
    expect(formatted).toContain("Firm Context");
    expect(formatted).toContain("Use prefix MX-");
  });

  it("applies token budget, prioritizing KB chunks", () => {
    // Test that KB chunks are included first when budget is limited
  });

  it("handles RAG failures gracefully", async () => {
    const mockEnv = {
      AI: { run: vi.fn().mockRejectedValue(new Error("AI unavailable")) },
      VECTORIZE: { query: vi.fn() },
      DB: { prepare: vi.fn() },
    };

    const result = await retrieveRAGContext(
      mockEnv as any,
      "test query",
      "org_123",
      { jurisdictions: [], practiceTypes: [], firmSize: null }
    );

    // Should return empty context, not throw
    expect(result).toEqual({ kbChunks: [], orgChunks: [] });
  });
});
```

### Integration Tests

Test Vectorize + D1 together (requires `--remote` flag):

```typescript
// test/rag-integration.spec.ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";

describe("RAG Integration", () => {
  it("retrieves chunks matching query semantics", async () => {
    // Seed a test chunk
    await env.DB.prepare(
      "INSERT INTO kb_chunks (id, content, source) VALUES (?, ?, ?)"
    )
      .bind("test_chunk_1", "Creating matters in Clio requires...", "test.md")
      .run();

    // Generate embedding and upsert to Vectorize
    const embedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["Creating matters in Clio requires..."],
    });

    await env.VECTORIZE.upsert([
      {
        id: "test_chunk_1",
        values: embedding.data[0],
        metadata: { type: "kb", category: "general" },
      },
    ]);

    // Query with related question
    const queryEmbedding = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["How do I create a new matter?"],
    });

    const results = await env.VECTORIZE.query(queryEmbedding.data[0], {
      topK: 5,
      filter: { type: "kb" },
    });

    expect(results.matches.length).toBeGreaterThan(0);
    expect(results.matches[0].id).toBe("test_chunk_1");
  });
});
```

### End-to-End Tests

Test the full message flow:

```typescript
// test/message-flow.spec.ts
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";

describe("Message Flow E2E", () => {
  it("generates contextual response using RAG", async () => {
    // Setup: create org, seed KB with relevant content
    const orgId = "test_org_e2e";

    // Create DO instance
    const doId = env.TENANT.idFromName(orgId);
    const stub = env.TENANT.get(doId);

    // Send message
    const response = await stub.fetch(
      new Request("https://do/process-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "web",
          orgId,
          userId: "user_123",
          userRole: "member",
          conversationId: "conv_e2e_1",
          conversationScope: "personal",
          message: "How do I create a new matter in Clio?",
          jurisdictions: ["CA"],
          practiceTypes: ["personal-injury-law"],
          firmSize: "small",
        }),
      })
    );

    const result = await response.json();

    // Response should be contextually relevant
    expect(result.response).toBeDefined();
    expect(result.response.toLowerCase()).toContain("matter");
  });

  it("enforces permission for CUD operations", async () => {
    // Member tries to create a matter - should be denied
    const orgId = "test_org_perms";
    const stub = env.TENANT.get(env.TENANT.idFromName(orgId));

    // First, get the LLM to attempt a create operation
    const response = await stub.fetch(
      new Request("https://do/process-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "web",
          orgId,
          userId: "member_user",
          userRole: "member", // Not admin!
          conversationId: "conv_perms_1",
          conversationScope: "personal",
          message: "Create a new matter for client John Smith",
          jurisdictions: [],
          practiceTypes: [],
          firmSize: null,
        }),
      })
    );

    const result = await response.json();

    // Should indicate permission denied, not create the matter
    expect(result.response.toLowerCase()).toContain("permission");
  });
});
```

---

## Part 8: Demo Component

A verbose demo endpoint for shareholder demonstration:

**src/routes/demo.ts:**

1. Demonstrate embedding generation
2. Demonstrate Vectorize query
3. Demonstrate chunk retrieval from D1
4. Demonstrate LLM inference
5. Demonstrate tool calling
6. Demonstrate Summary

### Running the Demo

```bash
# Deploy and test
wrangler deploy
curl https://your-worker.workers.dev/demo/phase7 | jq

# Expected output:
{
  "embedding": {
    "query": "How do I create a new matter in Clio?",
    "dimensions": 768,
    "sampleValues": [0.023, -0.145, 0.089, 0.034, -0.067],
    "latencyMs": 45
  },
  "vectorSearch": {
    "matchCount": 3,
    "topMatches": [
      { "id": "kb_clio_1", "score": "0.8934", "metadata": {...} }
    ],
    "latencyMs": 12
  },
  "chunkRetrieval": {
    "chunksFound": 3,
    "chunks": [{ "id": "kb_clio_1", "source": "clio-workflows.md", "contentPreview": "..." }],
    "latencyMs": 8
  },
  "llmInference": {
    "response": "To create a new matter in Clio...",
    "latencyMs": 890
  },
  "toolCalling": {
    "hasToolCalls": true,
    "toolCalls": [{ "name": "clioQuery", "arguments": {...} }]
  },
  "summary": {
    "totalLatencyMs": 955,
    "status": "Phase 7 Demo Complete"
  }
}
```

---

## Checklist

After completing this tutorial, verify:

- [ ] Workers AI binding configured (`AI`)
- [ ] LLM inference (`@cf/meta/llama-3.1-8b-instruct`)
- [ ] Embedding generation (`@cf/baai/bge-base-en-v1.5`, 768 dimensions)
- [ ] RAG retrieval (parallel Vectorize queries for KB + Org Context)
- [ ] System prompt construction (KB context, Org Context, Clio Schema, last 15 messages)
- [ ] Context window management (~10K tokens of 128K)
- [ ] Single `clioQuery` tool (structured params, DO builds validated Clio calls)
- [ ] CUD confirmation flow (pending_confirmations, 5-min expiry)
- [ ] Confirmation classification (approve/reject/modify/unrelated)
- [ ] Error code handling (3040, 3043 → retry once; 3036 → fail; 5007 → log)
- [ ] Graceful degradation (RAG failure → empty context, continue)
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Demo endpoint deployed

---

## Key Takeaways

1. **Embeddings are the bridge** — They convert text to vectors for semantic search
2. **Parallel queries overcome Vectorize limits** — No `$or` filters, so run multiple queries
3. **Token budgets prevent overflow** — Always truncate context before sending to LLM
4. **One tool is enough** — The DO validates and builds all Clio API calls
5. **Graceful degradation is essential** — Never let RAG failures crash the assistant
6. **Confirmations protect users** — CUD operations require explicit approval
