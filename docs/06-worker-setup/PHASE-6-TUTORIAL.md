
### Example Message Flow

```
1. Teams sends message to Worker
2. Worker extracts user identity (aadObjectId)
3. Worker queries D1: who is this user? → user_id, org_id, role
4. Worker routes to that org's DO via stub.fetch()

5. DO receives ChannelMessage
6. DO verifies orgId matches its own ID (security check)
7. DO checks user permissions
8. DO generates query embedding (Workers AI)
9. DO runs parallel Vectorize queries (KB + Org Context)
10. DO builds system prompt with RAG context
11. DO appends last 15 messages from conversation
12. DO calls LLM
13. If tool call → execute Clio, get confirmation if CUD
14. DO returns response to Worker
15. Worker sends reply through channel
```

---

## Part 1: Understanding the ChannelMessage Contract

The DO doesn't know about Teams, Slack, or MCP. It receives a unified format:

```typescript
// src/types/index.ts

export interface ChannelMessage {
  // Which channel sent this?
  channel: ChannelType; // "teams" | "slack" | "mcp" | "chatgpt" | "web"

  // Who is this? (from D1 lookup, trusted)
  orgId: string;
  userId: string;
  userRole: OrgRole; // "admin" | "member"

  // Conversation identity (isolation boundary)
  conversationId: string;
  conversationScope: ConversationScope;
    // "personal" | "groupChat" | "teams" | "dm" | "channel" | "api"

  // The actual message
  message: string;

  // Org settings for KB filtering (from D1 org table)
  // Arrays can be empty or have 100+ entries
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: FirmSize | null; // "solo" | "small" | "mid" | "large"

  // Channel-specific data (for replies)
  metadata?: ChannelMetadata;
}
```

**Key insight:** The Worker does the D1 lookup and populates `orgId`, `userId`, `userRole`. The DO trusts these values because the Worker verified them.

But the DO *also* derives `orgId` from its own Durable Object ID. If they don't match, the request is rejected. This prevents a compromised Worker from routing requests to the wrong org.

---

## Part 2: DO SQLite Schema

The DO needs five tables. You already have most of this from Phase 5's scaffolding. Let's understand each:

### conversations
```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,           -- conversationId from Teams/Slack
  channel_type TEXT NOT NULL,    -- teams, slack, mcp, etc.
  scope TEXT NOT NULL,           -- personal, groupChat, channel, etc.
  created_at INTEGER NOT NULL,   -- Unix timestamp
  updated_at INTEGER NOT NULL,   -- For archival alarm
  archived_at INTEGER            -- NULL if active
);
```

**Why?** Each Teams personal chat, group chat, or channel needs isolated history. The `id` is the `conversationId` from the channel.

### messages
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  user_id TEXT,                  -- NULL for assistant/system messages
  created_at INTEGER NOT NULL
);
```

**Why?** LLM context window. We store the last N messages and include them in the prompt.

### pending_confirmations
```sql
CREATE TABLE pending_confirmations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- 'create', 'update', 'delete'
  object_type TEXT NOT NULL,     -- 'Matter', 'Contact', 'Task', etc.
  params TEXT NOT NULL,          -- JSON of the operation params
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL    -- 5 minutes from creation
);
```

**Why?** CUD operations on Clio require user confirmation. When the LLM wants to create a task, we store it here and ask the user "Should I create this task?". They have 5 minutes to confirm.

### org_settings
```sql
CREATE TABLE org_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Why?** Per-org configuration. Could store things like "default time zone" or "Clio connected status".

### clio_schema_cache
```sql
CREATE TABLE clio_schema_cache (
  object_type TEXT PRIMARY KEY,  -- 'Matter', 'Contact', etc.
  schema TEXT NOT NULL,          -- JSON schema from Clio
  custom_fields TEXT,            -- Firm-specific custom fields
  fetched_at INTEGER NOT NULL
);
```

**Why?** We cache Clio's schema so we don't fetch it on every request. The schema includes field definitions, enums, and relationships.

---

## Part 3: Building the DO Class

Create `src/durable-objects/tenant-do.ts`:

```typescript
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../index";
import {
  ChannelMessageSchema,
  type ChannelMessage,
  type PendingConfirmation,
  type LLMResponse,
  type ToolCall,
} from "../types";
import { AuditEntryInputSchema } from "../types/requests";
import { retrieveRAGContext, formatRAGContext } from "../services/rag-retrieval";

// Migration version - increment when schema changes
const SCHEMA_VERSION = 1;

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private orgId: string;

  // In-memory caches (populated in constructor)
  private schemaCache: Map<string, object> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // CRITICAL: Derive orgId from DO's own ID, never from requests
    // The DO ID IS the org identity
    this.orgId = ctx.id.toString();

    // Block all requests until initialization completes
    ctx.blockConcurrencyWhile(async () => {
      await this.migrate();
      await this.loadSchemaCache();
    });
  }

  /**
   * Run schema migrations using PRAGMA user_version for tracking.
   *
   * This pattern ensures:
   * 1. Tables exist before any request is processed
   * 2. Schema updates happen atomically
   * 3. We never re-run migrations on existing DOs
   */
  private async migrate(): Promise<void> {
    const result = this.sql.exec("PRAGMA user_version").one();
    const currentVersion = (result?.user_version as number) ?? 0;

    if (currentVersion >= SCHEMA_VERSION) {
      return; // Already migrated
    }

    // Version 1: Initial schema
    if (currentVersion < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          scope TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated
          ON conversations(updated_at);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          user_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation
          ON messages(conversation_id, created_at);

        CREATE TABLE IF NOT EXISTS pending_confirmations (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          object_type TEXT NOT NULL,
          params TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pending_expires
          ON pending_confirmations(expires_at);

        CREATE TABLE IF NOT EXISTS org_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS clio_schema_cache (
          object_type TEXT PRIMARY KEY,
          schema TEXT NOT NULL,
          custom_fields TEXT,
          fetched_at INTEGER NOT NULL
        );

        PRAGMA user_version = 1;
      `);
    }

    // Future migrations go here:
    // if (currentVersion < 2) { ... PRAGMA user_version = 2; }
  }

  /**
   * Load Clio schema from SQLite into memory for fast access.
   * Called once in constructor, refreshed via /refresh-schema endpoint.
   */
  private async loadSchemaCache(): Promise<void> {
    const rows = this.sql.exec(
      "SELECT object_type, schema FROM clio_schema_cache"
    ).toArray();

    this.schemaCache.clear();
    for (const row of rows) {
      this.schemaCache.set(
        row.object_type as string,
        JSON.parse(row.schema as string)
      );
    }
  }

  /**
   * Main request handler. Routes to specific methods based on path.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/process-message":
          return this.handleProcessMessage(request);

        case "/audit":
          return this.handleAudit(request);

        case "/refresh-schema":
          return this.handleRefreshSchema(request);

        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      console.error(`[TenantDO:${this.orgId}] Error:`, error);
      return Response.json(
        { error: "Internal error" },
        { status: 500 }
      );
    }
  }

  // ... methods continued in next section
}
```

### Understanding `blockConcurrencyWhile`

This is a Cloudflare-specific pattern. When a DO starts (or wakes from hibernation), it might receive multiple requests simultaneously. Without blocking:

```
Request 1 arrives → starts migration
Request 2 arrives → starts migration (duplicate!)
Request 3 arrives → queries non-existent tables (crash!)
```

With `blockConcurrencyWhile`:

```
Request 1 arrives → triggers constructor
                 → migration runs
                 → schema cache loads
                 → Request 1, 2, 3 all process (in order)
```

**The callback blocks ALL concurrent requests** until it resolves. Keep it fast — storage operations only, no external HTTP calls.

---

## Part 4: Processing Messages

Add this method to your TenantDO class:

```typescript
/**
 * Process an incoming message from a channel adapter.
 *
 * This is the core logic path:
 * 1. Validate and parse request
 * 2. Verify org identity matches
 * 3. Check user permissions
 * 4. Check for pending confirmations
 * 5. Retrieve RAG context
 * 6. Build prompt with history
 * 7. Call LLM
 * 8. Handle tool calls if any
 * 9. Store message and response
 * 10. Return response
 */
private async handleProcessMessage(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 1. Parse and validate
  const body = await request.json();
  const parseResult = ChannelMessageSchema.safeParse(body);

  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid message format", details: parseResult.error.issues },
      { status: 400 }
    );
  }

  const msg = parseResult.data;

  // 2. CRITICAL SECURITY CHECK: Verify orgId matches this DO's identity
  if (msg.orgId !== this.orgId) {
    console.error(
      `[TenantDO:${this.orgId}] OrgId mismatch: ` +
      `received ${msg.orgId}, expected ${this.orgId}`
    );
    return Response.json(
      { error: "Organization mismatch" },
      { status: 403 }
    );
  }

  // 3. Ensure conversation exists
  await this.ensureConversation(msg);

  // 4. Check for pending confirmation from this user
  const pendingConfirmation = await this.getPendingConfirmation(
    msg.conversationId,
    msg.userId
  );

  // 5. Store the user's message
  await this.storeMessage(msg.conversationId, {
    role: "user",
    content: msg.message,
    userId: msg.userId,
  });

  // 6. Handle based on whether there's a pending confirmation
  let response: string;

  if (pendingConfirmation) {
    response = await this.handleConfirmationResponse(
      msg,
      pendingConfirmation
    );
  } else {
    response = await this.generateResponse(msg);
  }

  // 7. Store the assistant's response
  await this.storeMessage(msg.conversationId, {
    role: "assistant",
    content: response,
    userId: null,
  });

  return Response.json({ response });
}
```

### Helper Methods

```typescript
/**
 * Ensure a conversation record exists for this conversationId.
 * Creates one if it doesn't exist, updates timestamp if it does.
 */
private async ensureConversation(msg: ChannelMessage): Promise<void> {
  const now = Date.now();

  // Try to update first (most common case)
  const updateResult = this.sql.exec(
    "UPDATE conversations SET updated_at = ? WHERE id = ?",
    now,
    msg.conversationId
  );

  // If no rows updated, insert
  if (updateResult.rowsWritten === 0) {
    this.sql.exec(
      `INSERT INTO conversations (id, channel_type, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      msg.conversationId,
      msg.channel,
      msg.conversationScope,
      now,
      now
    );
  }
}

/**
 * Get any non-expired pending confirmation for this user in this conversation.
 */
private async getPendingConfirmation(
  conversationId: string,
  userId: string
): Promise<PendingConfirmation | null> {
  const now = Date.now();

  // Clean up expired confirmations first
  this.sql.exec(
    "DELETE FROM pending_confirmations WHERE expires_at < ?",
    now
  );

  // Check for active confirmation
  const row = this.sql.exec(
    `SELECT id, action, object_type, params, expires_at
     FROM pending_confirmations
     WHERE conversation_id = ? AND user_id = ?
     LIMIT 1`,
    conversationId,
    userId
  ).one();

  if (!row) return null;

  return {
    id: row.id as string,
    action: row.action as string,
    objectType: row.object_type as string,
    params: JSON.parse(row.params as string),
    expiresAt: row.expires_at as number,
  };
}

/**
 * Store a message in the conversation history.
 */
private async storeMessage(
  conversationId: string,
  message: { role: string; content: string; userId: string | null }
): Promise<void> {
  this.sql.exec(
    `INSERT INTO messages (id, conversation_id, role, content, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    conversationId,
    message.role,
    message.content,
    message.userId,
    Date.now()
  );
}

/**
 * Get the last N messages from a conversation for LLM context.
 */
private async getRecentMessages(
  conversationId: string,
  limit: number = 15
): Promise<Array<{ role: string; content: string }>> {
  const rows = this.sql.exec(
    `SELECT role, content FROM messages
     WHERE conversation_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    conversationId,
    limit
  ).toArray();

  // Reverse to get chronological order
  return rows.reverse().map(row => ({
    role: row.role as string,
    content: row.content as string,
  }));
}
```

---

## Part 5: Generating LLM Responses

This is where everything comes together:

```typescript
/**
 * Generate a response using RAG context and LLM.
 */
private async generateResponse(msg: ChannelMessage): Promise<string> {
  // 1. Retrieve RAG context (KB + Org Context)
  const ragContext = await retrieveRAGContext(
    this.env,
    msg.message,
    this.orgId,
    {
      jurisdictions: msg.jurisdictions,
      practiceTypes: msg.practiceTypes,
      firmSize: msg.firmSize,
    }
  );

  // 2. Format context for prompt
  const formattedContext = formatRAGContext(ragContext);

  // 3. Get conversation history
  const recentMessages = await this.getRecentMessages(msg.conversationId);

  // 4. Build the system prompt
  const systemPrompt = this.buildSystemPrompt(formattedContext, msg.userRole);

  // 5. Prepare messages for LLM
  const messages = [
    { role: "system", content: systemPrompt },
    ...recentMessages,
  ];

  // 6. Define available tools
  const tools = this.getClioTools(msg.userRole);

  // 7. Call Workers AI
  const llmResponse = await this.callLLM(messages, tools);

  // 8. Handle tool calls if present
  if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
    return this.handleToolCalls(msg, llmResponse.toolCalls);
  }

  // 9. Return text response
  return llmResponse.content;
}

/**
 * Build the system prompt with RAG context and instructions.
 */
private buildSystemPrompt(ragContext: string, userRole: string): string {
  // Build Clio schema reference from cache
  const schemaEntries: string[] = [];
  for (const [objectType, schema] of this.schemaCache) {
    schemaEntries.push(`### ${objectType}\n${JSON.stringify(schema, null, 2)}`);
  }
  const clioSchemaRef = schemaEntries.join("\n\n");

  const roleNote = userRole === "admin"
    ? "This user is an Admin and can perform create/update/delete operations with confirmation."
    : "This user is a Member with read-only access to Clio.";

  return `You are Docket, a case management assistant for legal teams using Clio.

**Tone:** Helpful, competent, deferential. You assist—you don't lead.

**User Role:** ${userRole}
${roleNote}

**Knowledge Base Context:**
${ragContext || "No relevant context found."}

**Clio Schema Reference:**
${clioSchemaRef || "Schema not yet loaded. User needs to connect Clio first."}

**Instructions:**
- Use Knowledge Base and firm context for case management questions
- Query Clio using the clioQuery tool per the schema above
- For write operations (create, update, delete), always confirm first
- NEVER give legal advice—you manage cases, not law
- Stay in scope: case management, Clio operations, firm procedures
- If Clio is not connected, guide user to connect at docket.com/settings`;
}
```

### Calling Workers AI

```typescript
// LLMResponse is defined in src/types/index.ts:
// interface LLMResponse {
//   content: string;
//   toolCalls?: ToolCall[];
// }

/**
 * Call Workers AI with messages and optional tools.
 */
private async callLLM(
  messages: Array<{ role: string; content: string }>,
  tools?: Array<object>
): Promise<LLMResponse> {
  try {
    const response = await this.env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct",
      {
        messages,
        tools: tools?.length ? tools : undefined,
        max_tokens: 2000,
      }
    );

    // Handle the response format
    if (typeof response === "string") {
      return { content: response };
    }

    // Workers AI returns an object with response and optionally tool_calls
    const result = response as {
      response?: string;
      tool_calls?: Array<{
        name: string;
        arguments: string | Record<string, unknown>;
      }>;
    };

    return {
      content: result.response || "",
      toolCalls: result.tool_calls?.map(tc => ({
        name: tc.name,
        arguments: typeof tc.arguments === "string"
          ? JSON.parse(tc.arguments)
          : tc.arguments,
      })),
    };
  } catch (error) {
    console.error(`[TenantDO:${this.orgId}] LLM error:`, error);

    // Graceful degradation
    return {
      content: "I'm having trouble processing your request right now. Please try again in a moment.",
    };
  }
}
```

---

## Part 6: The Clio Tool

The LLM has one tool: `clioQuery`. It specifies what it wants, and the DO builds the actual API call:

```typescript
/**
 * Define the clioQuery tool for the LLM.
 * The tool accepts structured parameters that the DO validates and executes.
 */
private getClioTools(userRole: string): object[] {
  return [{
    type: "function",
    function: {
      name: "clioQuery",
      description: `Query or modify Clio data. ${
        userRole === "admin"
          ? "Create/update/delete operations will require user confirmation."
          : "As a Member, only read operations are permitted."
      }`,
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
  }];
}
```

### Handling Tool Calls

```typescript
// ToolCall is defined in src/types/index.ts:
// interface ToolCall {
//   name: string;
//   arguments: {
//     operation: "read" | "create" | "update" | "delete";
//     objectType: string;
//     id?: string;
//     filters?: Record<string, unknown>;
//     data?: Record<string, unknown>;
//   };
// }

/**
 * Handle tool calls from the LLM.
 * Enforces permissions and manages confirmation flow for CUD operations.
 */
private async handleToolCalls(
  msg: ChannelMessage,
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
    if (args.operation !== "read" && msg.userRole !== "admin") {
      results.push(
        `You don't have permission to ${args.operation} ${args.objectType}s. ` +
        "Only Admins can make changes."
      );
      continue;
    }

    // Read operations execute immediately
    if (args.operation === "read") {
      const result = await this.executeClioRead(msg.userId, args);
      results.push(result);
      continue;
    }

    // CUD operations require confirmation
    const confirmationId = await this.createPendingConfirmation(
      msg.conversationId,
      msg.userId,
      args.operation,
      args.objectType,
      args.data || {}
    );

    const description = this.describeOperation(args);
    results.push(
      `I'd like to ${description}.\n\n` +
      "**Please confirm:**\n" +
      "- Reply 'yes' to proceed\n" +
      "- Reply 'no' to cancel\n" +
      "- Or describe any changes you'd like\n\n" +
      "*This request expires in 5 minutes.*"
    );
  }

  return results.join("\n\n");
}

/**
 * Create a pending confirmation for a CUD operation.
 */
private async createPendingConfirmation(
  conversationId: string,
  userId: string,
  action: string,
  objectType: string,
  params: Record<string, unknown>
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000; // 5 minutes

  this.sql.exec(
    `INSERT INTO pending_confirmations
     (id, conversation_id, user_id, action, object_type, params, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    conversationId,
    userId,
    action,
    objectType,
    JSON.stringify(params),
    now,
    expiresAt
  );

  return id;
}

/**
 * Generate a human-readable description of an operation.
 */
private describeOperation(args: ToolCall["arguments"]): string {
  const verb = {
    create: "create a new",
    update: "update the",
    delete: "delete the",
  }[args.operation] || args.operation;

  const objectName = args.objectType.toLowerCase();

  if (args.data) {
    const summary = Object.entries(args.data)
      .slice(0, 3)
      .map(([k, v]) => `${k}: "${v}"`)
      .join(", ");
    return `${verb} ${objectName} with ${summary}`;
  }

  return `${verb} ${objectName} ${args.id || ""}`.trim();
}
```

---

## Part 7: Handling Confirmations

When a user responds to a confirmation prompt:

```typescript
// PendingConfirmation is defined in src/types/index.ts:
// interface PendingConfirmation {
//   id: string;
//   action: "create" | "update" | "delete";
//   objectType: string;
//   params: Record<string, unknown>;
//   expiresAt: number;
// }

/**
 * Handle user response to a pending confirmation.
 *
 * Uses the LLM to classify the response:
 * - approve: Execute the operation
 * - reject: Cancel and acknowledge
 * - modify: Cancel and process as new request with changes
 * - unrelated: Keep pending, process message normally
 */
private async handleConfirmationResponse(
  msg: ChannelMessage,
  confirmation: PendingConfirmation
): Promise<string> {
  // Ask LLM to classify the user's intent
  const classification = await this.classifyConfirmationResponse(
    msg.message,
    confirmation
  );

  switch (classification.intent) {
    case "approve":
      return this.executeConfirmedOperation(msg.userId, confirmation);

    case "reject":
      await this.clearPendingConfirmation(confirmation.id);
      return "Got it, I've cancelled that operation.";

    case "modify":
      await this.clearPendingConfirmation(confirmation.id);
      // Process the modification as a new request
      return this.generateResponse({
        ...msg,
        message: classification.modifiedRequest || msg.message,
      });

    case "unrelated":
      // Keep the confirmation, process message normally
      return this.generateResponse(msg);

    default:
      return "I'm not sure if you want to proceed. " +
             "Please reply 'yes' to confirm or 'no' to cancel.";
  }
}

/**
 * Use LLM to classify whether the user's response approves/rejects/modifies.
 */
private async classifyConfirmationResponse(
  userMessage: string,
  confirmation: PendingConfirmation
): Promise<{ intent: string; modifiedRequest?: string }> {
  const prompt = `A user was asked to confirm this operation:
${confirmation.action} a ${confirmation.objectType} with: ${JSON.stringify(confirmation.params)}

The user responded: "${userMessage}"

Classify their intent as ONE of:
- approve (they said yes, do it, looks good, proceed, etc.)
- reject (they said no, cancel, nevermind, stop, etc.)
- modify (they want changes, e.g. "yes but change the date to tomorrow")
- unrelated (they're asking about something else entirely)

Respond with JSON: {"intent": "...", "modifiedRequest": "..."}
Only include modifiedRequest if intent is "modify".`;

  const response = await this.env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    { prompt, max_tokens: 100 }
  );

  try {
    const text = typeof response === "string"
      ? response
      : (response as { response: string }).response;

    // Extract JSON from response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Default to asking for clarification
  }

  return { intent: "unclear" };
}

/**
 * Execute a confirmed CUD operation.
 */
private async executeConfirmedOperation(
  userId: string,
  confirmation: PendingConfirmation
): Promise<string> {
  try {
    // Execute the Clio operation
    const result = await this.executeClioCUD(
      userId,
      confirmation.action,
      confirmation.objectType,
      confirmation.params
    );

    // Log to audit
    await this.appendAuditLog({
      userId,
      action: confirmation.action,
      objectType: confirmation.objectType,
      params: confirmation.params,
      result: "success",
    });

    // Clear the confirmation
    await this.clearPendingConfirmation(confirmation.id);

    return `Done! I've ${confirmation.action}d the ${confirmation.objectType}.` +
           (result.details ? `\n\n${result.details}` : "");
  } catch (error) {
    // Log the error
    await this.appendAuditLog({
      userId,
      action: confirmation.action,
      objectType: confirmation.objectType,
      params: confirmation.params,
      result: "error",
      errorMessage: String(error),
    });

    await this.clearPendingConfirmation(confirmation.id);

    return `There was a problem: ${error}. The operation was not completed.`;
  }
}

private async clearPendingConfirmation(id: string): Promise<void> {
  this.sql.exec("DELETE FROM pending_confirmations WHERE id = ?", id);
}
```

---

## Part 8: Clio API Integration (Placeholder)

The full Clio integration is Phase 8, but you need placeholders now:

```typescript
/**
 * Execute a read operation against Clio API.
 * Full implementation in Phase 8.
 */
private async executeClioRead(
  userId: string,
  args: { objectType: string; id?: string; filters?: Record<string, unknown> }
): Promise<string> {
  // Check if user has Clio connected
  const hasClioToken = await this.hasClioToken(userId);

  if (!hasClioToken) {
    return "You haven't connected your Clio account yet. " +
           "Please connect at docket.com/settings to enable Clio queries.";
  }

  // Placeholder - full implementation in Phase 8
  return `[Clio read placeholder] Would query ${args.objectType}` +
         (args.id ? ` with ID ${args.id}` : "") +
         (args.filters ? ` with filters ${JSON.stringify(args.filters)}` : "");
}

/**
 * Execute a CUD operation against Clio API.
 * Full implementation in Phase 8.
 */
private async executeClioCUD(
  userId: string,
  action: string,
  objectType: string,
  data: Record<string, unknown>
): Promise<{ success: boolean; details?: string }> {
  // Placeholder - full implementation in Phase 8
  console.log(`[Clio ${action}]`, { userId, objectType, data });

  return {
    success: true,
    details: `[Placeholder] ${action} ${objectType} would execute here`,
  };
}

/**
 * Check if user has a stored Clio token.
 * Tokens are stored encrypted in DO Storage.
 */
private async hasClioToken(userId: string): Promise<boolean> {
  const key = `clio_token:${userId}`;
  const token = await this.ctx.storage.get(key);
  return token !== undefined;
}
```

---

## Part 9: Audit Logging

```typescript
// AuditEntry is defined in src/types/index.ts:
// interface AuditEntry {
//   id: string;
//   userId: string;
//   action: string;
//   objectType: string;
//   params: Record<string, unknown>;
//   result: "success" | "error";
//   errorMessage?: string;
//   createdAt: string;
// }

/**
 * Append an entry to the org's audit log in R2.
 * One JSON file per entry for simple writes.
 */
private async appendAuditLog(entry: AuditEntry): Promise<void> {
  const now = new Date();
  const id = crypto.randomUUID();

  // Path: orgs/{orgId}/audit/{year}/{month}/{day}/{timestamp}-{id}.json
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  const path = `orgs/${this.orgId}/audit/${year}/${month}/${day}/${now.getTime()}-${id}.json`;

  const logEntry = {
    id,
    orgId: this.orgId,
    createdAt: now.toISOString(),
    ...entry,
  };

  await this.env.R2.put(path, JSON.stringify(logEntry), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Handle audit endpoint (for external logging).
 */
private async handleAudit(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const body = await request.json();
  const result = AuditEntryInputSchema.safeParse(body);

  if (!result.success) {
    return Response.json(
      { error: "Invalid audit entry", details: result.error.issues },
      { status: 400 }
    );
  }

  await this.appendAuditLog(result.data as AuditEntry);
  return Response.json({ success: true });
}
```

---

## Part 10: DO Alarms

Alarms handle scheduled work per-org:

```typescript
/**
 * Alarm handler for scheduled maintenance.
 *
 * Tasks:
 * 1. Archive old conversations (>30 days)
 * 2. Clean expired pending confirmations
 */
async alarm(): Promise<void> {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // 1. Find conversations to archive
  const toArchive = this.sql.exec(
    `SELECT id FROM conversations
     WHERE updated_at < ? AND archived_at IS NULL`,
    thirtyDaysAgo
  ).toArray();

  for (const row of toArchive) {
    await this.archiveConversation(row.id as string);
  }

  // 2. Clean expired confirmations (already done in getPendingConfirmation,
  //    but do a sweep here too)
  this.sql.exec(
    "DELETE FROM pending_confirmations WHERE expires_at < ?",
    now
  );

  // 3. Schedule next alarm (daily)
  await this.ctx.storage.setAlarm(now + 24 * 60 * 60 * 1000);
}

/**
 * Archive a conversation to R2 and mark as archived in SQLite.
 */
private async archiveConversation(conversationId: string): Promise<void> {
  // Get all messages
  const messages = this.sql.exec(
    `SELECT id, role, content, user_id, created_at
     FROM messages WHERE conversation_id = ?
     ORDER BY created_at`,
    conversationId
  ).toArray();

  const conversation = this.sql.exec(
    "SELECT * FROM conversations WHERE id = ?",
    conversationId
  ).one();

  if (!conversation) return;

  // Store in R2
  const archive = {
    conversation,
    messages,
    archivedAt: new Date().toISOString(),
  };

  const path = `orgs/${this.orgId}/conversations/${conversationId}.json`;
  await this.env.R2.put(path, JSON.stringify(archive), {
    httpMetadata: { contentType: "application/json" },
  });

  // Mark as archived (don't delete - we might need to look it up)
  this.sql.exec(
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    Date.now(),
    conversationId
  );

  // Delete messages to save space
  this.sql.exec(
    "DELETE FROM messages WHERE conversation_id = ?",
    conversationId
  );
}

/**
 * Initialize alarm on first request (called from constructor or first fetch).
 */
private async ensureAlarmSet(): Promise<void> {
  const currentAlarm = await this.ctx.storage.getAlarm();
  if (!currentAlarm) {
    // Set initial alarm for 24 hours from now
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }
}
```

---

## Part 11: Channel Adapter (Worker Routing)

Update `src/index.ts` to route messages to the correct DO:

```typescript
import { TenantDO } from "./durable-objects/tenant-do";
import type { ChannelMessage } from "./types";

// Re-export DO class
export { TenantDO };

/**
 * Look up user identity from channel-specific ID.
 * Returns null if user is not linked.
 */
async function lookupChannelUser(
  env: Env,
  channelType: string,
  channelUserId: string
): Promise<{
  userId: string;
  orgId: string;
  role: "admin" | "member";
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: string | null;
} | null> {
  // Find user from channel link
  const linkResult = await env.DB.prepare(
    `SELECT cul.user_id, om.org_id, om.role
     FROM channel_user_links cul
     JOIN org_members om ON om.user_id = cul.user_id
     WHERE cul.channel_type = ? AND cul.channel_user_id = ?
     LIMIT 1`
  ).bind(channelType, channelUserId).first<{
    user_id: string;
    org_id: string;
    role: "admin" | "member";
  }>();

  if (!linkResult) return null;

  // Get org settings for KB filtering
  // Note: jurisdictions and practice_types are stored as JSON arrays in D1
  const orgResult = await env.DB.prepare(
    `SELECT jurisdictions, practice_types, firm_size
     FROM org WHERE id = ?`
  ).bind(linkResult.org_id).first<{
    jurisdictions: string; // JSON array string
    practice_types: string; // JSON array string
    firm_size: string | null;
  }>();

  if (!orgResult) return null;

  return {
    userId: linkResult.user_id,
    orgId: linkResult.org_id,
    role: linkResult.role,
    jurisdictions: JSON.parse(orgResult.jurisdictions || "[]"),
    practiceTypes: JSON.parse(orgResult.practice_types || "[]"),
    firmSize: orgResult.firm_size,
  };
}

/**
 * Route a message to the appropriate org's Durable Object.
 */
async function routeToDO(
  env: Env,
  message: ChannelMessage
): Promise<Response> {
  // Get DO stub using org ID as the DO identifier
  const doId = env.TENANT.idFromName(message.orgId);
  const stub = env.TENANT.get(doId);

  // Forward to DO
  return stub.fetch(new Request("https://do/process-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  }));
}

/**
 * Handle Teams bot messages.
 */
async function handleTeamsMessage(
  request: Request,
  env: Env
): Promise<Response> {
  const activity = await request.json();

  // Only handle message activities
  if (activity.type !== "message" || !activity.text) {
    return new Response(null, { status: 200 });
  }

  // Extract Teams-specific identifiers
  const aadObjectId = activity.from?.aadObjectId;
  const conversationId = activity.conversation?.id;

  if (!aadObjectId || !conversationId) {
    return new Response(null, { status: 200 });
  }

  // Look up user
  const user = await lookupChannelUser(env, "teams", aadObjectId);

  if (!user) {
    // User not linked - send welcome message
    // (Teams Bot Framework reply omitted for brevity)
    return new Response(null, { status: 200 });
  }

  // Determine conversation scope
  const conversationType = activity.conversation?.conversationType;
  const scope = conversationType === "personal"
    ? "personal"
    : conversationType === "groupChat"
    ? "groupChat"
    : "teams";

  // Build ChannelMessage
  const channelMessage: ChannelMessage = {
    channel: "teams",
    orgId: user.orgId,
    userId: user.userId,
    userRole: user.role,
    conversationId,
    conversationScope: scope,
    message: activity.text,
    jurisdictions: user.jurisdictions,
    practiceTypes: user.practiceTypes,
    firmSize: user.firmSize as "solo" | "small" | "mid" | "large" | null,
    metadata: {
      threadId: activity.conversation?.id,
      teamsChannelId: activity.channelId,
    },
  };

  // Route to DO
  const doResponse = await routeToDO(env, channelMessage);
  const result = await doResponse.json() as { response: string };

  // Send reply via Bot Framework
  // (Implementation depends on your Teams setup)

  return new Response(null, { status: 200 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Teams messages
    if (url.pathname === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // ... other routes

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
```

---

## Part 12: Testing

### Unit Tests

Create `test/tenant-do.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

describe("TenantDO", () => {
  describe("message processing", () => {
    it("rejects messages with mismatched orgId", async () => {
      const doId = env.TENANT.idFromName("org-123");
      const stub = env.TENANT.get(doId);

      const response = await stub.fetch(
        new Request("https://do/process-message", {
          method: "POST",
          body: JSON.stringify({
            channel: "teams",
            orgId: "different-org", // Wrong org!
            userId: "user-1",
            userRole: "member",
            conversationId: "conv-1",
            conversationScope: "personal",
            message: "Hello",
            jurisdictions: ["CA"],
            practiceTypes: ["general"],
            firmSize: "small",
          }),
        })
      );

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("Organization mismatch");
    });

    it("creates conversation on first message", async () => {
      const doId = env.TENANT.idFromName("org-123");
      const stub = env.TENANT.get(doId);

      const response = await stub.fetch(
        new Request("https://do/process-message", {
          method: "POST",
          body: JSON.stringify({
            channel: "teams",
            orgId: "org-123",
            userId: "user-1",
            userRole: "member",
            conversationId: "new-conv",
            conversationScope: "personal",
            message: "Hello",
            jurisdictions: ["CA"],
            practiceTypes: ["general"],
            firmSize: "small",
          }),
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.response).toBeDefined();
    });
  });

  describe("permissions", () => {
    it("denies CUD operations for members", async () => {
      // Mock LLM to return a tool call
      vi.spyOn(env.AI, "run").mockResolvedValueOnce({
        tool_calls: [{
          name: "clioQuery",
          arguments: JSON.stringify({
            operation: "create",
            objectType: "Task",
            data: { description: "New task" },
          }),
        }],
      });

      const doId = env.TENANT.idFromName("org-123");
      const stub = env.TENANT.get(doId);

      const response = await stub.fetch(
        new Request("https://do/process-message", {
          method: "POST",
          body: JSON.stringify({
            channel: "teams",
            orgId: "org-123",
            userId: "user-1",
            userRole: "member", // Member, not admin
            conversationId: "conv-1",
            conversationScope: "personal",
            message: "Create a task for me",
            jurisdictions: ["CA"],
            practiceTypes: ["general"],
            firmSize: "small",
          }),
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.response).toContain("don't have permission");
    });
  });

  describe("pending confirmations", () => {
    it("stores confirmation for admin CUD operations", async () => {
      vi.spyOn(env.AI, "run").mockResolvedValueOnce({
        tool_calls: [{
          name: "clioQuery",
          arguments: JSON.stringify({
            operation: "create",
            objectType: "Task",
            data: { description: "New task" },
          }),
        }],
      });

      const doId = env.TENANT.idFromName("org-123");
      const stub = env.TENANT.get(doId);

      const response = await stub.fetch(
        new Request("https://do/process-message", {
          method: "POST",
          body: JSON.stringify({
            channel: "teams",
            orgId: "org-123",
            userId: "user-1",
            userRole: "admin",
            conversationId: "conv-1",
            conversationScope: "personal",
            message: "Create a task for me",
            jurisdictions: ["CA"],
            practiceTypes: ["general"],
            firmSize: "small",
          }),
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.response).toContain("confirm");
    });

    it("expires confirmations after 5 minutes", async () => {
      // Create confirmation, wait, verify it's gone
      // (Test with mocked time)
    });
  });
});
```

### Integration Tests

Create `test/integration/message-flow.spec.ts`:

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { unstable_dev } from "wrangler";

describe("Message Flow Integration", () => {
  let worker: Awaited<ReturnType<typeof unstable_dev>>;

  beforeAll(async () => {
    worker = await unstable_dev("src/index.ts", {
      experimental: { disableExperimentalWarning: true },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it("routes Teams message through full flow", async () => {
    // This requires D1/Vectorize to be available
    // Run with: npx vitest --config vitest.integration.config.ts

    const response = await worker.fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        text: "What deadlines do I have this week?",
        from: { aadObjectId: "test-aad-id" },
        conversation: { id: "test-conv-id" },
        recipient: { id: "bot-id" },
        serviceUrl: "https://smba.trafficmanager.net/test/",
      }),
    });

    expect(response.status).toBe(200);
  });
});
```

### E2E Tests

Create `test/e2e/demo-flow.spec.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("E2E Demo Flow", () => {
  const BASE_URL = process.env.WORKER_URL || "http://localhost:8787";

  it("demonstrates full conversation flow", async () => {
    // 1. Simulate Teams message arrival
    const msg1 = await fetch(`${BASE_URL}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        text: "Show me my open matters",
        from: { aadObjectId: "demo-user" },
        conversation: { id: "demo-conv" },
        recipient: { id: "bot" },
        serviceUrl: "https://test.local/",
      }),
    });

    expect(msg1.status).toBe(200);

    // 2. Follow-up message (tests conversation history)
    const msg2 = await fetch(`${BASE_URL}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        text: "What about the Smith case specifically?",
        from: { aadObjectId: "demo-user" },
        conversation: { id: "demo-conv" },
        recipient: { id: "bot" },
        serviceUrl: "https://test.local/",
      }),
    });

    expect(msg2.status).toBe(200);
  });
});
```

---

## Part 13: Demo Endpoint

Create a demo endpoint for stakeholder demonstrations:

```typescript
// Add to src/index.ts

/**
 * Demo endpoint showing Phase 6 capabilities.
 * Returns diagnostic info about DO state.
 */
async function handleDemo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org") || "demo-org";

  // Get DO for this org
  const doId = env.TENANT.idFromName(orgId);
  const stub = env.TENANT.get(doId);

  // Send a test message
  const testMessage = {
    channel: "web",
    orgId,
    userId: "demo-user",
    userRole: "admin",
    conversationId: "demo-conversation",
    conversationScope: "api",
    message: url.searchParams.get("message") || "What can you help me with?",
    jurisdictions: ["CA"],
    practiceTypes: ["general"],
    firmSize: "small",
  };

  const startTime = Date.now();

  const response = await stub.fetch(
    new Request("https://do/process-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(testMessage),
    })
  );

  const elapsed = Date.now() - startTime;
  const result = await response.json();

  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <title>Docket Phase 6 Demo</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #f5f5f5; padding: 1rem; border-radius: 8px; margin: 1rem 0; }
    .success { border-left: 4px solid #22c55e; }
    .info { border-left: 4px solid #3b82f6; }
    pre { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 4px; overflow-x: auto; }
    .metric { display: inline-block; margin-right: 2rem; }
    .metric-value { font-size: 2rem; font-weight: bold; }
    .metric-label { color: #666; }
  </style>
</head>
<body>
  <h1>Docket Phase 6 Demo</h1>
  <p>Core Worker + Durable Object</p>

  <div class="card info">
    <div class="metric">
      <div class="metric-value">${elapsed}ms</div>
      <div class="metric-label">Response Time</div>
    </div>
    <div class="metric">
      <div class="metric-value">${orgId}</div>
      <div class="metric-label">Org ID</div>
    </div>
  </div>

  <h2>Test Message</h2>
  <div class="card">
    <strong>Input:</strong> ${testMessage.message}
  </div>

  <h2>Response</h2>
  <div class="card success">
    ${(result as { response?: string }).response || "No response"}
  </div>

  <h2>Architecture Demonstrated</h2>
  <ul>
    <li>Worker routes message to org's Durable Object</li>
    <li>DO validates org identity (security check)</li>
    <li>DO retrieves RAG context (KB + Org Context)</li>
    <li>DO calls Workers AI for LLM response</li>
    <li>DO stores conversation history in SQLite</li>
    <li>Response returned through Worker</li>
  </ul>

  <h2>Try Different Messages</h2>
  <form method="get">
    <input type="hidden" name="org" value="${orgId}">
    <input type="text" name="message" placeholder="Your message..." style="width: 70%; padding: 0.5rem;">
    <button type="submit" style="padding: 0.5rem 1rem;">Send</button>
  </form>

  <h2>Raw Response</h2>
  <pre>${JSON.stringify(result, null, 2)}</pre>
</body>
</html>
  `, {
    headers: { "Content-Type": "text/html" },
  });
}

// Add route in fetch handler:
if (url.pathname === "/demo") {
  return handleDemo(request, env);
}
```

---

## Checklist

Use this to verify your implementation:

- [ ] DO bindings configured in `wrangler.jsonc`
- [ ] One DO per organization (DO ID = org identity)
- [ ] DO derives `orgId` from DO ID, rejects mismatched `ChannelMessage.orgId`
- [ ] Constructor uses `blockConcurrencyWhile()` for migrations + schema loading
- [ ] `PRAGMA user_version` for DO SQLite migration tracking
- [ ] DO SQLite tables (conversations, messages, pending_confirmations, org_settings, clio_schema_cache)
- [ ] `ChannelMessage` interface implemented
- [ ] `POST /process-message` endpoint working
- [ ] Channel Adapter routing (unified format)
- [ ] ChannelMessage validation with Zod
- [ ] Workspace binding validation (D1 lookup)
- [ ] Conversation isolation per `conversationId`
- [ ] Permission enforcement in DO (role check before LLM)
- [ ] Generic error responses ("I'm having trouble processing your request")
- [ ] Audit logging to R2
- [ ] User leaves org: `POST /remove-user` expires `pending_confirmations`
- [ ] Org deletion: `POST /delete-org` clears DO SQLite + KV storage
- [ ] GDPR: `POST /purge-user-data` purges user's conversations/messages
- [ ] Unit tests passing (unskip TenantDO tests)
- [ ] Integration tests passing
- [ ] Demo endpoint deployed

**Phase 8 Dependencies (deferred):**

- [ ] Clio-specific error responses (401 expired, 429 rate limit, connection errors)
- [ ] User leaves org: delete Clio token from DO KV Storage

**Note:** Clio token storage doesn't exist until Phase 8. Generic error handling covers LLM/RAG failures; Clio-specific errors require Phase 8's OAuth and API integration.

---
