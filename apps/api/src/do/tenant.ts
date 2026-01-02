import { DurableObject } from "cloudflare:workers";
import { AuditEntryInputSchema, type AuditEntryInput } from "../types/requests";
import {
  ChannelMessageSchema,
  type ChannelMessage,
  type PendingConfirmation,
  type LLMResponse,
  type ToolCall,
} from "../types";
import {
  generateQueryEmbedding,
  searchKnowledgeBase,
  searchOrgContext,
  finalizeContext,
  formatRAGContext,
  type OrgSettings,
} from "../services/rag-retrieval";
import {
  fetchAllCustomFields,
  CLIO_SCHEMA_VERSION,
  customFieldsNeedRefresh,
  formatCustomFieldsForLLM,
  type ClioCustomField,
} from "../services/clio-schema";
import {
  getClioToolSchema,
  validateFilters,
  normalizeFilters,
} from "../services/clio-static-schema";
import {
  getOrgContextToolSchema,
  executeOrgContextQuery,
  type OrgContextQueryArgs,
} from "../services/org-context-tools";
import {
  getKnowledgeBaseToolSchema,
  executeKnowledgeBaseQuery,
  type KBQueryArgs,
} from "../services/kb-tools";
import {
  storeClioTokens,
  getClioTokens,
  deleteClioTokens,
  tokenNeedsRefresh,
  refreshAccessToken,
  type ClioTokens,
} from "../services/clio-oauth";
import {
  parseClassificationJSON,
  isConfirmationExpired,
} from "../lib/confirmation";
import {
  executeClioCall,
  buildReadQuery,
  buildCreateBody,
  buildUpdateBody,
  buildDeleteEndpoint,
  formatClioResponse,
} from "../services/clio-api";
import { createLogger, type Logger } from "../lib/logger";
import type { Env } from "../types/env";
import { sanitizeAuditParams } from "../lib/sanitize";
import { TENANT_CONFIG } from "../config/tenant";

// =============================================================================
// Timing Helper
// =============================================================================

function createTimer() {
  const start = Date.now();
  return { elapsed: () => Date.now() - start };
}

// =============================================================================
// TenantDO - Per-Organization Durable Object
// =============================================================================
//
// Each organization gets its own TenantDO instance, identified by orgId.
// This DO manages:
// - Conversations and messages (SQLite)
// - Clio OAuth tokens (KV storage, encrypted)
// - Clio custom field schema cache
// - Pending confirmations for write operations
// - Audit logging to R2
//
// The DO handles incoming chat messages by:
// 1. Storing the user message
// 2. Retrieving relevant RAG context
// 3. Calling the LLM with conversation history
// 4. Handling any tool calls (Clio queries)
// 5. Storing and returning the assistant response
//
// =============================================================================

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private orgId: string;
  private log: Logger;

  // Clio schema cache (custom fields)
  private customFieldsCache: ClioCustomField[] = [];
  private customFieldsFetchedAt: number | null = null;
  private schemaVersion: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Use DO ID string as org identifier (idFromName derives deterministic ID from orgId)
    this.orgId = ctx.id.toString();
    this.log = createLogger({ orgId: this.orgId, component: "TenantDO" });

    if (!ctx.storage.sql) {
      throw new Error("SQLite storage not available");
    }
    this.sql = ctx.storage.sql;

    // Initialize database and cache during construction
    ctx.blockConcurrencyWhile(async () => {
      await this.runMigrations();
      await this.loadSchemaCache();
      await this.ensureAlarmIsSet();
    });
  }

  // ===========================================================================
  // Request Router
  // ===========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Handle dynamic routes first
      const dynamicResponse = this.handleDynamicRoute(request, path);
      if (dynamicResponse) {
        return dynamicResponse;
      }

      // Handle static routes
      return this.handleStaticRoute(request, path);
    } catch (error) {
      this.log.error("Request failed", { error, path });
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  }

  private handleDynamicRoute(
    request: Request,
    path: string
  ): Promise<Response> | null {
    const parts = path.split("/").filter(Boolean);

    // /conversation/:id
    if (parts[0] === "conversation" && parts.length === 2) {
      const conversationId = parts[1];
      if (request.method === "DELETE") {
        return this.handleDeleteConversation(request, conversationId);
      }
      return this.handleGetConversation(request, conversationId);
    }

    // /confirmation/:id/accept or /confirmation/:id/reject
    if (parts[0] === "confirmation" && parts.length === 3) {
      const confirmationId = parts[1];
      if (parts[2] === "accept") {
        return this.handleAcceptConfirmation(request, confirmationId);
      }
      if (parts[2] === "reject") {
        return this.handleRejectConfirmation(request, confirmationId);
      }
    }

    return null;
  }

  private handleStaticRoute(request: Request, path: string): Promise<Response> {
    const routes: Record<string, () => Promise<Response>> = {
      "/process-message": () => this.handleProcessMessage(request),
      "/process-message-stream": () => this.handleProcessMessageStream(request),
      "/conversations": () => this.handleGetConversations(request),
      "/audit": () => this.handleAudit(request),
      "/refresh-schema": () => this.handleRefreshSchema(request),
      "/provision-schema": () => this.handleProvisionSchema(request),
      "/force-schema-refresh": () => this.handleForceSchemaRefresh(request),
      "/remove-user": () => this.handleRemoveUser(request),
      "/delete-org": () => this.handleDeleteOrg(request),
      "/purge-user-data": () => this.handlePurgeUserData(request),
      "/store-clio-token": () => this.handleStoreClioToken(request),
      "/get-clio-status": () => this.handleGetClioStatus(request),
      "/delete-clio-token": () => this.handleDeleteClioToken(request),
    };

    const handler = routes[path];
    if (handler) {
      return handler();
    }

    return Promise.resolve(
      Response.json({ error: "Not found" }, { status: 404 })
    );
  }

  // ===========================================================================
  // Message Processing - Non-Streaming
  // ===========================================================================

  private async handleProcessMessage(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Validate request body
    const body = await request.json();
    const parseResult = ChannelMessageSchema.safeParse(body);
    if (!parseResult.success) {
      return Response.json(
        { error: "Invalid message format", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const message = parseResult.data;

    // Store user message and process
    await this.ensureConversationExists(message);

    // Check for pending confirmation
    const pendingConfirmation = await this.claimPendingConfirmation(
      message.conversationId,
      message.userId
    );

    await this.storeMessage(message.conversationId, {
      role: "user",
      content: message.message,
      userId: message.userId,
    });

    // Generate response
    const response = pendingConfirmation
      ? await this.handleConfirmationResponse(message, pendingConfirmation)
      : await this.generateAssistantResponse(message);

    await this.storeMessage(message.conversationId, {
      role: "assistant",
      content: response,
      userId: null,
    });

    return Response.json({ response });
  }

  // ===========================================================================
  // Message Processing - Streaming (SSE)
  // ===========================================================================

  private async handleProcessMessageStream(
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Validate request body
    const body = await request.json();
    const parseResult = ChannelMessageSchema.safeParse(body);
    if (!parseResult.success) {
      return Response.json(
        { error: "Invalid message format", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const message = parseResult.data;
    const requestId = request.headers.get("X-Request-Id") ?? undefined;

    // Create SSE stream and start processing in background
    const stream = this.createSSEStream(requestId);

    this.ctx.waitUntil(
      this.processMessageWithStream(
        message,
        stream.emit,
        stream.close,
        requestId
      )
    );

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async processMessageWithStream(
    message: ChannelMessage,
    emit: SSEEmitter,
    close: () => Promise<void>,
    requestId?: string
  ): Promise<void> {
    try {
      await emit("process", { type: "started" });

      // Store user message
      await this.ensureConversationExists(message);
      await this.storeMessage(message.conversationId, {
        role: "user",
        content: message.message,
        userId: message.userId,
        status: "complete",
      });

      // Check for pending confirmation
      const pendingConfirmation = await this.claimPendingConfirmation(
        message.conversationId,
        message.userId
      );

      // Generate response
      const response = pendingConfirmation
        ? await this.handleConfirmationResponseWithStream(
            message,
            pendingConfirmation,
            emit
          )
        : await this.generateAssistantResponseWithStream(
            message,
            emit,
            requestId
          );

      // Store assistant response
      await this.storeMessage(message.conversationId, {
        role: "assistant",
        content: response,
        userId: null,
        status: "complete",
      });

      await emit("done", {});
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Processing failed";

      // Store error message
      try {
        await this.storeMessage(message.conversationId, {
          role: "assistant",
          content: `I encountered an error: ${errorMessage}`,
          userId: null,
          status: "error",
        });
      } catch {
        // Ignore storage errors during error handling
      }

      await emit("error", { message: errorMessage });
    } finally {
      await close();
    }
  }

  // ===========================================================================
  // Response Generation
  // ===========================================================================

  private async generateAssistantResponse(
    message: ChannelMessage
  ): Promise<string> {
    const orgSettings: OrgSettings = {
      jurisdictions: message.jurisdictions,
      practiceTypes: message.practiceTypes,
      firmSize: message.firmSize,
    };

    // Generate embedding
    const { vector } = await generateQueryEmbedding(this.env, message.message);

    // Search both sources in parallel
    const [kbResult, orgResult] = await Promise.all([
      searchKnowledgeBase(this.env, vector, orgSettings),
      searchOrgContext(this.env, vector, message.orgId),
    ]);

    // Finalize context with token budget
    const ragContext = finalizeContext({
      kbChunks: kbResult.chunks,
      orgChunks: orgResult.chunks,
    });

    // Build messages for LLM
    const history = await this.getRecentMessages(message.conversationId);
    const systemPrompt = this.buildSystemPrompt(
      formatRAGContext(ragContext),
      message.userRole
    );

    const messages = [{ role: "system", content: systemPrompt }, ...history];

    // Call LLM
    const llmResponse = await this.callLLM(
      messages,
      this.getTools(message.userRole)
    );

    // Handle tool calls or return content
    if (llmResponse.toolCalls?.length) {
      return this.handleToolCalls(message, llmResponse.toolCalls);
    }

    return llmResponse.content;
  }

  private async generateAssistantResponseWithStream(
    message: ChannelMessage,
    emit: SSEEmitter,
    requestId?: string
  ): Promise<string> {
    const requestLog = this.log.child({
      requestId,
      conversationId: message.conversationId,
    });

    const orgSettings: OrgSettings = {
      jurisdictions: message.jurisdictions,
      practiceTypes: message.practiceTypes,
      firmSize: message.firmSize,
    };

    // --- Step 1: Generate query embedding ---
    const embeddingResult = await generateQueryEmbedding(
      this.env,
      message.message
    );

    // --- Step 2: Search Knowledge Base ---
    await emit("process", { type: "kb_search", status: "started" });

    const kbResult = await searchKnowledgeBase(
      this.env,
      embeddingResult.vector,
      orgSettings
    );

    await emit("process", {
      type: "kb_search",
      status: "complete",
      matchCount: kbResult.chunks.length,
      chunks: kbResult.chunks.map((chunk) => ({
        source: chunk.source,
        preview: this.truncateText(chunk.content, 200),
        score: chunk.score ? Math.round(chunk.score * 100) / 100 : undefined,
      })),
      durationMs: kbResult.durationMs,
    });

    // --- Step 3: Search Org Context ---
    await emit("process", { type: "org_context_search", status: "started" });

    const orgResult = await searchOrgContext(
      this.env,
      embeddingResult.vector,
      message.orgId
    );

    await emit("process", {
      type: "org_context_search",
      status: "complete",
      matchCount: orgResult.chunks.length,
      chunks: orgResult.chunks.map((chunk) => ({
        source: chunk.source,
        preview: this.truncateText(chunk.content, 200),
        score: chunk.score ? Math.round(chunk.score * 100) / 100 : undefined,
      })),
      durationMs: orgResult.durationMs,
    });

    // --- Step 4: Finalize context with token budget ---
    const ragContext = finalizeContext({
      kbChunks: kbResult.chunks,
      orgChunks: orgResult.chunks,
    });

    requestLog.info("RAG retrieval complete", {
      phase: "rag",
      kbChunks: ragContext.kbChunks.length,
      orgChunks: ragContext.orgChunks.length,
    });

    // --- Step 5: Check Clio configuration ---
    if (this.customFieldsCache?.length > 0) {
      await emit("process", {
        type: "clio_schema",
        status: "complete",
        customFieldCount: this.customFieldsCache.length,
      });
    }

    // --- Step 6: Load conversation history and build prompt ---
    const history = await this.getRecentMessages(message.conversationId);
    const formattedContext = formatRAGContext(ragContext);
    const tools = this.getTools(message.userRole);
    const systemPrompt = this.buildSystemPrompt(
      formattedContext,
      message.userRole
    );
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    // --- Step 7: Call LLM ---
    const llmTimer = createTimer();
    await emit("process", { type: "llm_thinking", status: "started" });

    const llmResponse = await this.callLLM(messages, tools);

    const llmDuration = llmTimer.elapsed();
    await emit("process", {
      type: "llm_thinking",
      status: "complete",
      durationMs: llmDuration,
      hasToolCalls: !!llmResponse.toolCalls?.length,
      toolCallCount: llmResponse.toolCalls?.length || 0,
    });

    requestLog.info("LLM response received", {
      phase: "llm",
      durationMs: llmDuration,
      hasToolCalls: !!llmResponse.toolCalls?.length,
      toolCalls: llmResponse.toolCalls?.map((t) => ({
        name: t.name,
        operation: t.arguments.operation,
        objectType: t.arguments.objectType,
      })),
    });

    // Handle tool calls or return content
    if (llmResponse.toolCalls?.length) {
      return this.handleToolCallsWithStream(
        message,
        llmResponse.toolCalls,
        emit,
        requestLog
      );
    }

    await emit("content", { text: llmResponse.content });
    return llmResponse.content;
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength - 3) + "...";
  }

  private formatFiltersForDisplay(filters?: Record<string, unknown>): string {
    if (!filters || Object.keys(filters).length === 0) {
      return "";
    }
    return Object.entries(filters)
      .map(([key, value]) => `${key}: "${value}"`)
      .join(", ");
  }

  private summarizeClioResult(
    result: string,
    objectType: string
  ): { items: Array<{ name: string; id?: string }>; totalCount: number } {
    const items: Array<{ name: string; id?: string }> = [];
    let totalCount = 0;

    // Try to extract data from the formatted response
    try {
      const match = result.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as Array<{
          display_number?: string;
          name?: string;
          description?: string;
          id?: number;
        }>;
        totalCount = parsed.length;

        for (const item of parsed.slice(0, 3)) {
          items.push({
            name:
              item.display_number ||
              item.name ||
              item.description ||
              `${objectType} record`,
            id: item.id ? String(item.id) : undefined,
          });
        }
      } else if (result.includes("No ") && result.includes("records found")) {
        totalCount = 0;
      } else {
        // Single record or other format
        totalCount = 1;
        items.push({ name: `${objectType} record` });
      }
    } catch {
      // Fallback - count lines as rough approximation
      const lines = result.split("\n").filter((line) => line.trim());
      totalCount = Math.max(1, lines.length);
      items.push({ name: `${totalCount} lines of data` });
    }

    return { items, totalCount };
  }

  // ===========================================================================
  // System Prompt
  // ===========================================================================

  private buildSystemPrompt(ragContext: string, userRole: string): string {
    const customFieldsInfo = formatCustomFieldsForLLM(this.customFieldsCache);
    const isAdmin = userRole === "admin";

    return `You are Docket, a case management assistant for Clio.

## User Role
${isAdmin ? "Admin. Can create, update, delete with confirmation." : "Member. Read-only."}

## Available Tools

**orgContextQuery** - Search firm documents (policies, procedures, templates)
- list: See all uploaded documents
- search: Find content by topic
- getDocument: Read full document by filename

**knowledgeBaseQuery** - Search shared knowledge base
- search: Find Clio workflows, practice management, billing guidance
- listCategories: See available categories

**clioQuery** - Query Clio data (matters, contacts, tasks, calendar entries, activities)
- read: Search or get records
- create/update/delete: Modify records (admin only, requires confirmation)

## Decision Logic

**Use orgContextQuery when:**
- User asks about firm policies, procedures, or documents
- You need to find or read firm-specific content
- User asks "What documents do we have?"

**Use knowledgeBaseQuery when:**
- User asks about Clio features, workflows, or best practices
- User asks about legal practice management, billing, or deadlines
- Context provided below doesn't answer the question

**Use clioQuery when:**
- User asks about specific records: "Find the Johnson matter"
- User wants filtered lists: "Open matters", "Tasks due this week"
- User wants to create, update, or delete records

**Answer directly when:**
- The context below already contains the answer
- Simple questions about what you can do

## Presenting Document Results

When returning results from orgContextQuery or knowledgeBaseQuery:
- Summarize findings in natural language, don't paste raw content
- Reference source documents by name (e.g., "According to your billing policy...")
- For document lists, present as a clean list with descriptions if known
- If user wants details, offer to search for specific topics rather than dumping full content
- Keep responses conversational and helpful

${ragContext ? `## Relevant Context\n${ragContext}` : "## Note\nNo relevant context found. Use tools to search for information."}
${customFieldsInfo ? `## Firm Custom Fields\n${customFieldsInfo}` : ""}

## Clio Rules

1. **ID Resolution.** Look up IDs before create/update operations.
2. **Write Confirmation.** ${isAdmin ? "Confirm create/update/delete before executing." : "Inform user they lack write permissions."}
3. **Connection Check.** If Clio disconnected, direct to docket.com/settings.

## Constraints
- No legal advice. You manage cases, not law.
- Scope: case management, Clio operations, firm procedures only.`;
  }

  // ===========================================================================
  // LLM Interaction
  // ===========================================================================

  private async callLLM(
    messages: Array<{ role: string; content: string }>,
    tools?: object[],
    isRetry = false
  ): Promise<LLMResponse> {
    try {
      const response = await (this.env.AI.run as Function)(
        "@cf/meta/llama-3.1-8b-instruct",
        {
          messages,
          tools: tools?.length ? tools : undefined,
          max_tokens: TENANT_CONFIG.LLM.CHAT_MAX_TOKENS,
        }
      );

      return this.parseLLMResponse(response);
    } catch (error) {
      return this.handleLLMError(error, messages, tools, isRetry);
    }
  }

  private parseLLMResponse(response: unknown): LLMResponse {
    // Handle string response
    if (typeof response === "string") {
      // Check if string looks like a JSON tool call
      const toolCallFromString = this.tryParseToolCallFromString(response);
      if (toolCallFromString) {
        return { content: "", toolCalls: [toolCallFromString] };
      }
      return { content: response };
    }

    // Handle object response
    if (!response || typeof response !== "object") {
      return {
        content: "I couldn't process that response. Please try again.",
      };
    }

    const result = response as {
      response?: string;
      tool_calls?: Array<{
        name: string;
        arguments: string | Record<string, unknown>;
      }>;
    };

    const toolCalls = this.parseToolCalls(result.tool_calls);

    // If no structured tool calls, check if response content is a JSON tool call
    const content = typeof result.response === "string" ? result.response : "";
    if (!toolCalls?.length && content) {
      const toolCallFromContent = this.tryParseToolCallFromString(content);
      if (toolCallFromContent) {
        return { content: "", toolCalls: [toolCallFromContent] };
      }
    }

    return { content, toolCalls };
  }

  private tryParseToolCallFromString(text: string): ToolCall | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"name"')) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed.name &&
        parsed.arguments &&
        typeof parsed.arguments === "object"
      ) {
        return {
          name: parsed.name,
          arguments: parsed.arguments,
        };
      }
    } catch {
      // Not valid JSON, return null
    }
    return null;
  }

  private parseToolCalls(
    rawToolCalls?: Array<{
      name: string;
      arguments: string | Record<string, unknown>;
    }>
  ): ToolCall[] | undefined {
    if (!rawToolCalls?.length) {
      return undefined;
    }

    const parsed: ToolCall[] = [];

    for (const toolCall of rawToolCalls) {
      if (!toolCall.name) continue;

      try {
        const args =
          typeof toolCall.arguments === "string"
            ? JSON.parse(toolCall.arguments)
            : (toolCall.arguments ?? {});

        parsed.push({ name: toolCall.name, arguments: args });
      } catch {
        // Skip malformed tool calls
      }
    }

    return parsed.length ? parsed : undefined;
  }

  private async handleLLMError(
    error: unknown,
    messages: Array<{ role: string; content: string }>,
    tools?: object[],
    isRetry = false
  ): Promise<LLMResponse> {
    const errorCode = (error as { code?: number }).code;

    // Retry on rate limit errors
    if (!isRetry && (errorCode === 3040 || errorCode === 3043)) {
      await this.delay(1000);
      return this.callLLM(messages, tools, true);
    }

    // Daily limit reached
    if (errorCode === 3036) {
      return {
        content: "I've reached my daily limit. Please try again tomorrow.",
      };
    }

    // Configuration error
    if (errorCode === 5007) {
      return {
        content:
          "I'm experiencing a configuration issue. Please contact support.",
      };
    }

    // Generic error
    return {
      content:
        "I'm having trouble processing your request right now. Please try again in a moment.",
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // Tool Definitions
  // ===========================================================================

  private getTools(userRole: string): object[] {
    return [
      getClioToolSchema(userRole),
      getOrgContextToolSchema(),
      getKnowledgeBaseToolSchema(),
    ];
  }

  // ===========================================================================
  // Tool Call Handling
  // ===========================================================================

  private async handleToolCalls(
    message: ChannelMessage,
    toolCalls: ToolCall[]
  ): Promise<string> {
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.executeSingleToolCall(message, toolCall);
      results.push(`[${toolCall.name}]: ${result}`);
    }

    // Generate natural response from tool results
    return this.summarizeToolResults(message, results.join("\n\n"));
  }

  private async summarizeToolResults(
    message: ChannelMessage,
    toolResults: string
  ): Promise<string> {
    const prompt = `You are Docket, a helpful assistant. The user asked: "${message.message}"

You searched and found this information:
${toolResults}

Respond naturally to the user. Summarize the key points, reference source documents by name, and be conversational. Don't dump raw content - give a helpful answer.`;

    try {
      const response = await (this.env.AI.run as Function)(
        "@cf/meta/llama-3.1-8b-instruct",
        { prompt, max_tokens: TENANT_CONFIG.LLM.CHAT_MAX_TOKENS }
      );

      const text =
        typeof response === "string" ? response : (response?.response ?? "");

      return text || toolResults;
    } catch {
      // Fallback to raw results if summarization fails
      return toolResults;
    }
  }

  private async handleToolCallsWithStream(
    message: ChannelMessage,
    toolCalls: ToolCall[],
    emit: SSEEmitter,
    requestLog?: Logger
  ): Promise<string> {
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.executeSingleToolCallWithStream(
        message,
        toolCall,
        emit,
        requestLog
      );
      results.push(`[${toolCall.name}]: ${result}`);
    }

    // Generate natural response from tool results
    await emit("process", { type: "summarizing", status: "started" });
    const summary = await this.summarizeToolResults(
      message,
      results.join("\n\n")
    );
    await emit("process", { type: "summarizing", status: "complete" });

    await emit("content", { text: summary });
    return summary;
  }

  private async executeSingleToolCall(
    message: ChannelMessage,
    toolCall: ToolCall
  ): Promise<string> {
    // Handle knowledge query tools
    if (toolCall.name === "orgContextQuery") {
      return executeOrgContextQuery(
        this.env,
        message.orgId,
        toolCall.arguments as unknown as OrgContextQueryArgs
      );
    }

    if (toolCall.name === "knowledgeBaseQuery") {
      const orgSettings: OrgSettings = {
        jurisdictions: message.jurisdictions,
        practiceTypes: message.practiceTypes,
        firmSize: message.firmSize,
      };
      return executeKnowledgeBaseQuery(
        this.env,
        orgSettings,
        toolCall.arguments as unknown as KBQueryArgs
      );
    }

    // Handle clioQuery tool
    if (toolCall.name !== "clioQuery") {
      return `Unknown tool: ${toolCall.name}`;
    }

    const { operation, objectType, id, filters, data } = toolCall.arguments;

    // Validate and normalize filters
    let correctedFilters = filters ? { ...filters } : undefined;

    if (operation === "read" && !id) {
      const validation = validateFilters(objectType, filters);

      if (!validation.valid) {
        if (
          validation.correctedValue &&
          validation.invalidKey &&
          correctedFilters
        ) {
          // Auto-correct enum errors
          correctedFilters[validation.invalidKey] = validation.correctedValue;
        } else {
          // Can't auto-correct
          const friendlyTypes =
            "matters, contacts, tasks, calendar entries, or activities (time entries)";
          return `I can't search for that directly. I can look up ${friendlyTypes}. Which would you like?`;
        }
      }
    }

    const normalizedFilters = normalizeFilters(objectType, correctedFilters);

    // Check permissions for write operations
    if (operation !== "read" && message.userRole !== "admin") {
      return `You don't have permission to ${operation} ${objectType}s. Only Admins can make changes.`;
    }

    // Handle read operations directly
    if (operation === "read") {
      return this.executeClioRead(message.userId, {
        objectType,
        id,
        filters: normalizedFilters,
      });
    }

    // Handle write operations (require confirmation)
    await this.createPendingConfirmation(
      message.conversationId,
      message.userId,
      operation,
      objectType,
      data || {}
    );

    return this.buildConfirmationPrompt(operation, objectType, data);
  }

  private async executeSingleToolCallWithStream(
    message: ChannelMessage,
    toolCall: ToolCall,
    emit: SSEEmitter,
    requestLog?: Logger
  ): Promise<string> {
    // Handle knowledge query tools
    if (toolCall.name === "orgContextQuery") {
      const args = toolCall.arguments as unknown as OrgContextQueryArgs;
      await emit("process", {
        type: "org_context_query",
        operation: args.operation,
        query: args.query,
        source: args.source,
      });

      const result = await executeOrgContextQuery(this.env, message.orgId, args);

      await emit("process", {
        type: "org_context_result",
        operation: args.operation,
      });

      return result;
    }

    if (toolCall.name === "knowledgeBaseQuery") {
      const args = toolCall.arguments as unknown as KBQueryArgs;
      const orgSettings: OrgSettings = {
        jurisdictions: message.jurisdictions,
        practiceTypes: message.practiceTypes,
        firmSize: message.firmSize,
      };

      await emit("process", {
        type: "kb_query",
        operation: args.operation,
        query: args.query,
        category: args.category,
      });

      const result = await executeKnowledgeBaseQuery(this.env, orgSettings, args);

      await emit("process", {
        type: "kb_result",
        operation: args.operation,
      });

      return result;
    }

    // Handle clioQuery tool
    if (toolCall.name !== "clioQuery") {
      return `Unknown tool: ${toolCall.name}`;
    }

    const { operation, objectType, id, filters, data } = toolCall.arguments;

    // Emit thinking event
    const objectLabel = objectType.toLowerCase() + (id ? "" : "s");
    await emit("process", {
      type: "thinking",
      text: `Looking up ${objectLabel}...`,
    });

    // Validate and normalize filters
    let correctedFilters = filters ? { ...filters } : undefined;

    if (operation === "read" && !id) {
      const validation = validateFilters(objectType, filters);

      if (!validation.valid) {
        // If we can auto-correct (enum error), do so and notify user
        if (
          validation.correctedValue &&
          validation.invalidKey &&
          correctedFilters
        ) {
          const invalidValue = correctedFilters[validation.invalidKey];
          correctedFilters[validation.invalidKey] = validation.correctedValue;

          await emit("process", {
            type: "auto_correct",
            text: `"${invalidValue}" isn't an option. Showing ${validation.correctedValue} instead...`,
          });
        } else {
          // Can't auto-correct (e.g., unknown objectType) - return friendly error
          const friendlyTypes =
            "matters, contacts, tasks, calendar entries, or activities (time entries)";
          return `I can't search for that directly. I can look up ${friendlyTypes}. Which would you like?`;
        }
      }
    }

    const normalizedFilters = normalizeFilters(objectType, correctedFilters);

    // Check permissions
    if (operation !== "read" && message.userRole !== "admin") {
      return `You don't have permission to ${operation} ${objectType}s. Only Admins can make changes.`;
    }

    // Emit Clio call event with human-readable filter description
    const filterDesc = this.formatFiltersForDisplay(normalizedFilters);
    const searchText = filterDesc
      ? `Searching ${objectType}s: ${filterDesc}`
      : `Searching ${objectType}s...`;

    await emit("process", {
      type: "clio_call",
      text: searchText,
      operation,
      objectType,
      filters: normalizedFilters,
      id,
    });

    // Handle read operations
    if (operation === "read") {
      const clioTimer = createTimer();

      const result = await this.executeClioRead(message.userId, {
        objectType,
        id,
        filters: normalizedFilters,
      });

      const clioDuration = clioTimer.elapsed();
      const preview = this.summarizeClioResult(result, objectType);

      const resultText =
        preview.totalCount === 0
          ? `No ${objectType.toLowerCase()}s found`
          : `Found ${preview.totalCount} ${objectType.toLowerCase()}${preview.totalCount === 1 ? "" : "s"}`;

      await emit("process", {
        type: "clio_result",
        text: resultText,
        durationMs: clioDuration,
        count: preview.totalCount,
        preview,
      });

      requestLog?.info("Clio API call complete", {
        phase: "clio",
        durationMs: clioDuration,
        operation,
        objectType,
        resultCount: preview.totalCount,
        filters,
      });

      return result;
    }

    // Handle write operations
    const confirmationId = await this.createPendingConfirmation(
      message.conversationId,
      message.userId,
      operation,
      objectType,
      data || {}
    );

    await emit("confirmation_required", {
      confirmationId,
      action: operation,
      objectType,
      params: data || {},
    });

    return this.buildConfirmationPrompt(operation, objectType, data);
  }

  private buildConfirmationPrompt(
    operation: string,
    objectType: string,
    data?: Record<string, unknown>
  ): string {
    const description = this.describeOperation(operation, objectType, data);

    return `I'd like to ${description}.

**Please confirm:**
- Reply 'yes' to proceed
- Reply 'no' to cancel
- Or describe any changes you'd like

*This request expires in 24 hours.*`;
  }

  private describeOperation(
    operation: string,
    objectType: string,
    data?: Record<string, unknown>
  ): string {
    const verbs: Record<string, string> = {
      create: "create a new",
      update: "update the",
      delete: "delete the",
      read: "query",
    };

    const verb = verbs[operation] || operation;
    const obj = objectType.toLowerCase();

    if (data && Object.keys(data).length > 0) {
      const preview = Object.entries(data)
        .slice(0, 3)
        .map(([key, value]) => `${key}: "${value}"`)
        .join(", ");

      return `${verb} ${obj} with ${preview}`;
    }

    return `${verb} ${obj}`;
  }

  // ===========================================================================
  // Confirmation Handling
  // ===========================================================================

  private async handleConfirmationResponse(
    message: ChannelMessage,
    confirmation: PendingConfirmation
  ): Promise<string> {
    const classification = await this.classifyConfirmationResponse(
      message.message,
      confirmation
    );

    switch (classification.intent) {
      case "approve":
        return this.executeConfirmedOperation(message.userId, confirmation);

      case "reject":
        return "Got it, I've cancelled that operation.";

      case "modify":
        // Re-process with modified request
        return this.generateAssistantResponse({
          ...message,
          message: classification.modifiedRequest || message.message,
        });

      case "unrelated":
        // Restore confirmation and process as new message
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        return this.generateAssistantResponse(message);

      default:
        // Unclear response - restore confirmation and ask for clarification
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        return "I'm not sure if you want to proceed. Please reply 'yes' to confirm or 'no' to cancel.";
    }
  }

  private async handleConfirmationResponseWithStream(
    message: ChannelMessage,
    confirmation: PendingConfirmation,
    emit: SSEEmitter
  ): Promise<string> {
    const classification = await this.classifyConfirmationResponse(
      message.message,
      confirmation
    );

    switch (classification.intent) {
      case "approve": {
        await emit("process", {
          type: "clio_call",
          operation: confirmation.action,
          objectType: confirmation.objectType,
        });

        const result = await this.executeConfirmedOperation(
          message.userId,
          confirmation
        );

        const success = !result.includes("problem");
        await emit("process", { type: "clio_result", success });
        await emit("content", { text: result });

        return result;
      }

      case "reject": {
        const response = "Got it, I've cancelled that operation.";
        await emit("content", { text: response });
        return response;
      }

      case "modify":
        return this.generateAssistantResponseWithStream(
          {
            ...message,
            message: classification.modifiedRequest || message.message,
          },
          emit
        );

      case "unrelated":
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        return this.generateAssistantResponseWithStream(message, emit);

      default: {
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        const response =
          "I'm not sure if you want to proceed. Please reply 'yes' to confirm or 'no' to cancel.";
        await emit("content", { text: response });
        return response;
      }
    }
  }

  private async classifyConfirmationResponse(
    userMessage: string,
    confirmation: PendingConfirmation
  ): Promise<{ intent: string; modifiedRequest?: string }> {
    const prompt = `A user was asked to confirm: ${confirmation.action} a ${confirmation.objectType} with: ${JSON.stringify(confirmation.params)}
The user responded: "${userMessage}"
Classify as ONE of: approve, reject, modify, unrelated
Respond with JSON: {"intent": "...", "modifiedRequest": "..."}
Only include modifiedRequest if intent is "modify".`;

    try {
      const response = await (this.env.AI.run as Function)(
        "@cf/meta/llama-3.1-8b-instruct",
        { prompt, max_tokens: TENANT_CONFIG.LLM.CLASSIFICATION_MAX_TOKENS }
      );

      const text =
        typeof response === "string" ? response : (response?.response ?? "");

      if (!text) {
        return { intent: "unclear" };
      }

      return parseClassificationJSON(text);
    } catch {
      return { intent: "unclear" };
    }
  }

  private async executeConfirmedOperation(
    userId: string,
    confirmation: PendingConfirmation
  ): Promise<string> {
    try {
      const result = await this.executeClioCUD(
        userId,
        confirmation.action,
        confirmation.objectType,
        confirmation.params
      );

      if (!result.success) {
        await this.appendAuditLog({
          user_id: userId,
          action: confirmation.action,
          object_type: confirmation.objectType,
          params: confirmation.params,
          result: "error",
          error_message: result.details,
        });
        return (
          result.details ||
          `Failed to ${confirmation.action} the ${confirmation.objectType}.`
        );
      }

      await this.appendAuditLog({
        user_id: userId,
        action: confirmation.action,
        object_type: confirmation.objectType,
        params: confirmation.params,
        result: "success",
      });

      const baseMessage = `Done! I've ${confirmation.action}d the ${confirmation.objectType}.`;
      return result.details
        ? `${baseMessage}\n\n${result.details}`
        : baseMessage;
    } catch (error) {
      await this.appendAuditLog({
        user_id: userId,
        action: confirmation.action,
        object_type: confirmation.objectType,
        params: confirmation.params,
        result: "error",
        error_message: String(error),
      });

      return `There was a problem: ${error}. The operation was not completed.`;
    }
  }

  // ===========================================================================
  // Clio API Operations
  // ===========================================================================

  private async executeClioRead(
    userId: string,
    args: {
      objectType: string;
      id?: string;
      filters?: Record<string, unknown>;
    }
  ): Promise<string> {
    const accessToken = await this.getValidClioToken(userId);

    if (!accessToken) {
      return "You haven't connected your Clio account yet. Please connect at docket.com/settings to enable Clio queries.";
    }

    // Refresh schema if needed
    if (
      customFieldsNeedRefresh(this.schemaVersion, this.customFieldsFetchedAt)
    ) {
      await this.refreshCustomFieldsWithToken(accessToken);
    }

    try {
      const endpoint = buildReadQuery(args.objectType, args.id, args.filters);
      let result = await executeClioCall("GET", endpoint, accessToken);

      // Handle token expiration
      if (!result.success && result.error?.status === 401) {
        const refreshedToken = await this.handleClioUnauthorized(userId);

        if (refreshedToken) {
          result = await executeClioCall("GET", endpoint, refreshedToken);

          if (result.success) {
            return formatClioResponse(args.objectType, result.data);
          }
        }

        return "Your Clio connection has expired. Please reconnect at docket.com/settings.";
      }

      if (result.success) {
        return formatClioResponse(args.objectType, result.data);
      }

      return result.error?.message || "Failed to fetch data from Clio.";
    } catch {
      return "An error occurred while fetching data from Clio. Please try again.";
    }
  }

  private async executeClioCUD(
    userId: string,
    action: string,
    objectType: string,
    data: Record<string, unknown>
  ): Promise<{ success: boolean; details?: string }> {
    const accessToken = await this.getValidClioToken(userId);

    if (!accessToken) {
      return {
        success: false,
        details:
          "Clio account not connected. Please reconnect at docket.com/settings.",
      };
    }

    try {
      const request = this.buildCUDRequest(action, objectType, data);

      if (!request.method) {
        return { success: false, details: `Unknown action: ${action}` };
      }

      if (request.endpoint === null) {
        return { success: false, details: `Missing record ID for ${action}.` };
      }

      let result = await executeClioCall(
        request.method,
        request.endpoint,
        accessToken,
        request.body
      );

      // Handle token expiration
      if (!result.success && result.error?.status === 401) {
        const refreshedToken = await this.handleClioUnauthorized(userId);

        if (refreshedToken) {
          result = await executeClioCall(
            request.method,
            request.endpoint,
            refreshedToken,
            request.body
          );

          if (result.success) {
            return {
              success: true,
              details: `Successfully ${action}d ${objectType}.`,
            };
          }
        }

        return {
          success: false,
          details:
            "Clio connection expired. Please reconnect at docket.com/settings.",
        };
      }

      if (result.success) {
        return {
          success: true,
          details: `Successfully ${action}d ${objectType}.`,
        };
      }

      return {
        success: false,
        details: result.error?.message || `Failed to ${action} ${objectType}.`,
      };
    } catch {
      return {
        success: false,
        details: `An error occurred while trying to ${action} the ${objectType}.`,
      };
    }
  }

  private buildCUDRequest(
    action: string,
    objectType: string,
    data: Record<string, unknown>
  ): {
    method: "POST" | "PATCH" | "DELETE" | null;
    endpoint: string | null;
    body?: Record<string, unknown>;
  } {
    switch (action) {
      case "create": {
        const createRequest = buildCreateBody(objectType, data);
        return {
          method: "POST",
          endpoint: createRequest.endpoint,
          body: createRequest.body,
        };
      }

      case "update": {
        const recordId = data.id as string;
        if (!recordId) {
          return { method: null, endpoint: null };
        }

        const updateData = { ...data };
        delete updateData.id;

        const updateRequest = buildUpdateBody(objectType, recordId, updateData);
        return {
          method: "PATCH",
          endpoint: updateRequest.endpoint,
          body: updateRequest.body,
        };
      }

      case "delete": {
        const deleteId = data.id as string;
        if (!deleteId) {
          return { method: null, endpoint: null };
        }

        return {
          method: "DELETE",
          endpoint: buildDeleteEndpoint(objectType, deleteId),
        };
      }

      default:
        return { method: null, endpoint: null };
    }
  }

  // ===========================================================================
  // Clio OAuth Token Management
  // ===========================================================================

  private async handleStoreClioToken(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as {
      userId: string;
      tokens: ClioTokens;
      requestId?: string;
    };

    const log = body.requestId
      ? this.log.child({ requestId: body.requestId })
      : this.log;

    if (!body.userId || !body.tokens) {
      return Response.json(
        { error: "Missing userId or tokens" },
        { status: 400 }
      );
    }

    try {
      await storeClioTokens(
        this.ctx.storage,
        body.userId,
        body.tokens,
        this.env.ENCRYPTION_KEY
      );

      log.info("Clio tokens stored", { userId: body.userId });
    } catch (error) {
      log.error("Failed to store Clio tokens", {
        error: error instanceof Error ? error.message : String(error),
      });

      return Response.json(
        { error: "Failed to store tokens" },
        { status: 500 }
      );
    }

    await this.appendAuditLog({
      user_id: body.userId,
      action: "clio_connect",
      object_type: "oauth",
      params: {},
      result: "success",
    });

    return Response.json({ success: true });
  }

  private async handleGetClioStatus(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId: string };

    if (!body.userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const tokens = await getClioTokens(this.ctx.storage, body.userId, this.env);

    return Response.json({
      connected: tokens !== null,
      customFieldsCount: this.customFieldsCache.length,
      schemaVersion: this.schemaVersion,
      lastSyncedAt: this.customFieldsFetchedAt,
    });
  }

  private async handleDeleteClioToken(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as {
      userId: string;
      requestId?: string;
    };

    const log = body.requestId
      ? this.log.child({ requestId: body.requestId })
      : this.log;

    if (!body.userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    try {
      await deleteClioTokens(this.ctx.storage, body.userId);
      log.info("Clio tokens deleted", { userId: body.userId });
    } catch (error) {
      log.error("Failed to delete Clio tokens", {
        error: error instanceof Error ? error.message : String(error),
      });

      return Response.json(
        { error: "Failed to delete tokens" },
        { status: 500 }
      );
    }

    await this.appendAuditLog({
      user_id: body.userId,
      action: "clio_disconnect",
      object_type: "oauth",
      params: {},
      result: "success",
    });

    return Response.json({ success: true });
  }

  private async getValidClioToken(userId: string): Promise<string | null> {
    const tokens = await getClioTokens(this.ctx.storage, userId, this.env);

    if (!tokens) {
      return null;
    }

    // Refresh if needed
    if (tokenNeedsRefresh(tokens)) {
      try {
        const newTokens = await refreshAccessToken({
          refreshToken: tokens.refresh_token,
          clientId: this.env.CLIO_CLIENT_ID,
          clientSecret: this.env.CLIO_CLIENT_SECRET,
        });

        await storeClioTokens(
          this.ctx.storage,
          userId,
          newTokens,
          this.env.ENCRYPTION_KEY
        );

        return newTokens.access_token;
      } catch {
        await deleteClioTokens(this.ctx.storage, userId);
        return null;
      }
    }

    return tokens.access_token;
  }

  private async handleClioUnauthorized(userId: string): Promise<string | null> {
    const tokens = await getClioTokens(this.ctx.storage, userId, this.env);

    if (!tokens?.refresh_token) {
      return null;
    }

    try {
      const newTokens = await refreshAccessToken({
        refreshToken: tokens.refresh_token,
        clientId: this.env.CLIO_CLIENT_ID,
        clientSecret: this.env.CLIO_CLIENT_SECRET,
      });

      await storeClioTokens(
        this.ctx.storage,
        userId,
        newTokens,
        this.env.ENCRYPTION_KEY
      );

      return newTokens.access_token;
    } catch {
      await deleteClioTokens(this.ctx.storage, userId);
      return null;
    }
  }

  // ===========================================================================
  // Clio Schema Management
  // ===========================================================================

  private async handleProvisionSchema(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId: string };
    const accessToken = await this.getValidClioToken(body.userId);

    if (!accessToken) {
      return Response.json({ error: "No valid Clio token" }, { status: 401 });
    }

    const customFields = await fetchAllCustomFields(accessToken);
    await this.saveCustomFields(customFields);

    await this.appendAuditLog({
      user_id: body.userId,
      action: "schema_provision",
      object_type: "clio_custom_fields",
      params: { count: customFields.length },
      result: "success",
    });

    return Response.json({ success: true, count: customFields.length });
  }

  private async handleRefreshSchema(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId: string };

    if (!body.userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const accessToken = await this.getValidClioToken(body.userId);

    if (!accessToken) {
      return Response.json({ error: "No valid Clio token" }, { status: 401 });
    }

    const customFields = await fetchAllCustomFields(accessToken);
    await this.saveCustomFields(customFields);

    await this.appendAuditLog({
      user_id: body.userId,
      action: "schema_refresh",
      object_type: "clio_custom_fields",
      params: { count: customFields.length },
      result: "success",
    });

    return Response.json({ success: true, count: customFields.length });
  }

  private async handleForceSchemaRefresh(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const previousVersion = this.schemaVersion;

    // Clear schema cache
    this.sql.exec("DELETE FROM clio_schema_cache");
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    // Reset version to 0 to trigger refresh on next API call
    this.sql.exec(
      `INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('clio_schema_version', '0', ?)`,
      Date.now()
    );
    this.schemaVersion = 0;

    await this.appendAuditLog({
      user_id: "system",
      action: "schema_force_refresh",
      object_type: "clio_custom_fields",
      params: {
        previousVersion,
        targetVersion: CLIO_SCHEMA_VERSION,
      },
      result: "success",
    });

    return Response.json({
      success: true,
      message:
        "Custom fields cache invalidated. Will refresh on next Clio API call.",
      previousVersion,
      targetVersion: CLIO_SCHEMA_VERSION,
    });
  }

  private async refreshCustomFieldsWithToken(
    accessToken: string
  ): Promise<void> {
    try {
      const customFields = await fetchAllCustomFields(accessToken);
      await this.saveCustomFields(customFields);
    } catch {
      // Silently fail - schema refresh is not critical
    }
  }

  private async saveCustomFields(
    customFields: ClioCustomField[]
  ): Promise<void> {
    const now = Date.now();

    this.sql.exec("DELETE FROM clio_schema_cache");
    this.sql.exec(
      `INSERT INTO clio_schema_cache (object_type, schema, fetched_at) VALUES (?, ?, ?)`,
      "custom_fields",
      JSON.stringify(customFields),
      now
    );

    this.customFieldsCache = customFields;
    this.customFieldsFetchedAt = now;

    this.sql.exec(
      `INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('clio_schema_version', ?, ?)`,
      String(CLIO_SCHEMA_VERSION),
      now
    );
    this.schemaVersion = CLIO_SCHEMA_VERSION;
  }

  private async loadSchemaCache(): Promise<void> {
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    // Load schema version
    const versionRow = this.sql
      .exec("SELECT value FROM org_settings WHERE key = 'clio_schema_version'")
      .toArray()[0] as { value: string } | undefined;

    this.schemaVersion = versionRow ? Number(versionRow.value) : null;

    // Load cached custom fields
    const cacheRows = this.sql
      .exec(
        "SELECT schema, fetched_at FROM clio_schema_cache WHERE object_type = 'custom_fields'"
      )
      .toArray();

    if (cacheRows.length > 0) {
      try {
        this.customFieldsCache = JSON.parse(cacheRows[0].schema as string);
        this.customFieldsFetchedAt = cacheRows[0].fetched_at as number;
      } catch {
        // Invalid cache - will be refreshed on next request
      }
    }
  }

  // ===========================================================================
  // Conversation Management
  // ===========================================================================

  private async handleGetConversations(request: Request): Promise<Response> {
    const userId = new URL(request.url).searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { error: "Missing required query param: userId" },
        { status: 400 }
      );
    }

    const rows = this.sql
      .exec(
        `SELECT
          c.id,
          c.title,
          c.updated_at,
          (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as message_count
        FROM conversations c
        WHERE c.user_id = ? AND c.channel_type = 'web'
        ORDER BY c.updated_at DESC
        LIMIT ${TENANT_CONFIG.CONVERSATIONS_LIMIT}`,
        userId
      )
      .toArray();

    const conversations = rows.map((row) => ({
      id: row.id as string,
      title: row.title as string | null,
      updatedAt: row.updated_at as number,
      messageCount: row.message_count as number,
    }));

    return Response.json({ conversations });
  }

  private async handleGetConversation(
    request: Request,
    conversationId: string
  ): Promise<Response> {
    const userId = new URL(request.url).searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { error: "Missing required query param: userId" },
        { status: 400 }
      );
    }

    // Get conversation
    const conversationRows = this.sql
      .exec(
        `SELECT id, title, channel_type, scope, created_at, updated_at
        FROM conversations
        WHERE id = ? AND user_id = ?`,
        conversationId,
        userId
      )
      .toArray();

    // Conversation may not exist yet (new chat with no messages)
    if (conversationRows.length === 0) {
      return Response.json({
        conversation: null,
        messages: [],
        pendingConfirmations: [],
      });
    }

    const conversationRow = conversationRows[0];

    // Get messages
    const messageRows = this.sql
      .exec(
        `SELECT id, role, content, created_at, status
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC`,
        conversationId
      )
      .toArray();

    // Get pending confirmations
    const confirmationRows = this.sql
      .exec(
        `SELECT id, action, object_type, params, expires_at
        FROM pending_confirmations
        WHERE conversation_id = ? AND user_id = ? AND expires_at > ?`,
        conversationId,
        userId,
        Date.now()
      )
      .toArray();

    return Response.json({
      conversation: {
        id: conversationRow.id as string,
        title: conversationRow.title as string | null,
        channelType: conversationRow.channel_type as string,
        scope: conversationRow.scope as string,
        createdAt: conversationRow.created_at as number,
        updatedAt: conversationRow.updated_at as number,
      },
      messages: messageRows.map((row) => ({
        id: row.id as string,
        role: row.role as string,
        content: row.content as string,
        createdAt: row.created_at as number,
        status: row.status as string,
      })),
      pendingConfirmations: confirmationRows.map((row) => {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(row.params as string);
        } catch {
          // Invalid JSON - use empty params
        }

        return {
          id: row.id as string,
          action: row.action as string,
          objectType: row.object_type as string,
          params,
          expiresAt: row.expires_at as number,
        };
      }),
    });
  }

  private async handleDeleteConversation(
    request: Request,
    conversationId: string
  ): Promise<Response> {
    const userId = new URL(request.url).searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { error: "Missing required query param: userId" },
        { status: 400 }
      );
    }

    // Verify conversation exists and belongs to user
    const existsRows = this.sql
      .exec(
        `SELECT id FROM conversations WHERE id = ? AND user_id = ?`,
        conversationId,
        userId
      )
      .toArray();

    if (existsRows.length === 0) {
      return Response.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Delete in transaction
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "DELETE FROM messages WHERE conversation_id = ?",
        conversationId
      );
      this.sql.exec(
        "DELETE FROM pending_confirmations WHERE conversation_id = ?",
        conversationId
      );
      this.sql.exec("DELETE FROM conversations WHERE id = ?", conversationId);
    });

    return Response.json({ success: true });
  }

  private async ensureConversationExists(
    message: ChannelMessage
  ): Promise<void> {
    const now = Date.now();

    // Try to update existing conversation
    const updateResult = this.sql.exec(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      now,
      message.conversationId
    );

    // If no rows updated, create new conversation
    if (updateResult.rowsWritten === 0) {
      const isWebChannel = message.channel === "web";

      this.sql.exec(
        `INSERT INTO conversations (id, channel_type, scope, user_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        message.conversationId,
        message.channel,
        message.conversationScope,
        isWebChannel ? message.userId : null,
        isWebChannel ? this.generateConversationTitle(message.message) : null,
        now,
        now
      );
    }
  }

  private generateConversationTitle(message: string): string {
    const cleaned = message.trim().replace(/\s+/g, " ");

    if (cleaned.length <= 50) {
      return cleaned;
    }

    return cleaned.slice(0, 47) + "...";
  }

  private async getRecentMessages(
    conversationId: string,
    limit = TENANT_CONFIG.RECENT_MESSAGES_LIMIT
  ): Promise<Array<{ role: string; content: string }>> {
    const rows = this.sql
      .exec(
        `SELECT role, content
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
        conversationId,
        limit
      )
      .toArray();

    // Reverse to get chronological order
    return rows.reverse().map((row) => ({
      role: row.role as string,
      content: row.content as string,
    }));
  }

  private async storeMessage(
    conversationId: string,
    message: {
      role: string;
      content: string;
      userId: string | null;
      status?: "complete" | "partial" | "error";
    }
  ): Promise<void> {
    this.sql.exec(
      `INSERT INTO messages (id, conversation_id, role, content, user_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      conversationId,
      message.role,
      message.content,
      message.userId,
      message.status ?? "complete",
      Date.now()
    );
  }

  // ===========================================================================
  // Pending Confirmations
  // ===========================================================================

  private async claimPendingConfirmation(
    conversationId: string,
    userId: string
  ): Promise<PendingConfirmation | null> {
    const row = this.ctx.storage.transactionSync(() => {
      // Clean up expired confirmations
      this.sql.exec(
        "DELETE FROM pending_confirmations WHERE expires_at < ?",
        Date.now()
      );

      // Claim (delete and return) the confirmation for this conversation/user
      const rows = this.sql
        .exec(
          `DELETE FROM pending_confirmations
          WHERE conversation_id = ? AND user_id = ?
          RETURNING id, action, object_type, params, expires_at`,
          conversationId,
          userId
        )
        .toArray();
      return rows.length > 0 ? rows[0] : null;
    });

    if (!row) {
      return null;
    }

    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params as string);
    } catch {
      // Invalid JSON - use empty params
    }

    return {
      id: row.id as string,
      conversationId,
      action: row.action as "create" | "update" | "delete",
      objectType: row.object_type as string,
      params,
      expiresAt: row.expires_at as number,
    };
  }

  private async createPendingConfirmation(
    conversationId: string,
    userId: string,
    action: string,
    objectType: string,
    params: Record<string, unknown>
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + TENANT_CONFIG.CONFIRMATION_TTL_MS;

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

  private restorePendingConfirmation(
    conversationId: string,
    userId: string,
    confirmation: PendingConfirmation
  ): void {
    this.sql.exec(
      `INSERT INTO pending_confirmations
      (id, conversation_id, user_id, action, object_type, params, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      confirmation.id,
      conversationId,
      userId,
      confirmation.action,
      confirmation.objectType,
      JSON.stringify(confirmation.params),
      Date.now(),
      confirmation.expiresAt
    );
  }

  private async handleAcceptConfirmation(
    request: Request,
    confirmationId: string
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const requestId = request.headers.get("X-Request-Id") ?? undefined;
    const body = (await request.json()) as { userId?: string };

    if (!body.userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    // Find the confirmation
    const rows = this.sql
      .exec(
        `SELECT id, conversation_id, user_id, action, object_type, params, expires_at
        FROM pending_confirmations
        WHERE id = ? AND user_id = ?`,
        confirmationId,
        body.userId
      )
      .toArray();

    if (rows.length === 0) {
      return Response.json(
        { error: "Confirmation not found or expired" },
        { status: 404 }
      );
    }

    const row = rows[0];

    // Check if expired
    if (isConfirmationExpired(row.expires_at as number)) {
      this.sql.exec(
        "DELETE FROM pending_confirmations WHERE id = ?",
        confirmationId
      );
      return Response.json(
        { error: "Confirmation has expired" },
        { status: 410 }
      );
    }

    // Parse params
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params as string);
    } catch {
      // Invalid JSON - use empty params
    }

    const confirmation: PendingConfirmation = {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      action: row.action as "create" | "update" | "delete",
      objectType: row.object_type as string,
      params,
      expiresAt: row.expires_at as number,
    };

    // Delete the confirmation
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE id = ?",
      confirmationId
    );

    // Execute and stream results
    const stream = this.createSSEStream(requestId);

    this.ctx.waitUntil(
      this.executeAcceptedConfirmation(
        body.userId,
        confirmation,
        stream.emit,
        stream.close
      )
    );

    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private async executeAcceptedConfirmation(
    userId: string,
    confirmation: PendingConfirmation,
    emit: SSEEmitter,
    close: () => Promise<void>
  ): Promise<void> {
    try {
      await emit("process", { type: "started" });
      await emit("process", {
        type: "clio_call",
        operation: confirmation.action,
        objectType: confirmation.objectType,
      });

      const result = await this.executeConfirmedOperation(userId, confirmation);
      const success = !result.includes("problem");

      await emit("process", { type: "clio_result", success });

      await this.storeMessage(confirmation.conversationId, {
        role: "assistant",
        content: result,
        userId: null,
        status: success ? "complete" : "error",
      });

      await emit("content", { text: result });
      await emit("done", {});
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Operation failed";

      await this.storeMessage(confirmation.conversationId, {
        role: "assistant",
        content: `Operation failed: ${errorMessage}`,
        userId: null,
        status: "error",
      });

      await emit("error", { message: errorMessage });
    } finally {
      await close();
    }
  }

  private async handleRejectConfirmation(
    request: Request,
    confirmationId: string
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId?: string };

    if (!body.userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const rejectRows = this.sql
      .exec(
        `SELECT conversation_id, action, object_type
        FROM pending_confirmations
        WHERE id = ? AND user_id = ?`,
        confirmationId,
        body.userId
      )
      .toArray();

    if (rejectRows.length === 0) {
      return Response.json(
        { error: "Confirmation not found" },
        { status: 404 }
      );
    }

    const row = rejectRows[0];

    // Delete the confirmation
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE id = ?",
      confirmationId
    );

    // Store cancellation message
    await this.storeMessage(row.conversation_id as string, {
      role: "assistant",
      content: `The ${row.action} ${row.object_type} operation was cancelled.`,
      userId: null,
    });

    return Response.json({ success: true });
  }

  // ===========================================================================
  // SSE Stream Helper
  // ===========================================================================

  private createSSEStream(requestId?: string): SSEStream {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const emit: SSEEmitter = async (event: string, data: unknown) => {
      const payload = requestId ? { ...(data as object), requestId } : data;

      const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      await writer.write(encoder.encode(message));
    };

    const close = async () => {
      await writer.close();
    };

    return { readable, emit, close };
  }

  // ===========================================================================
  // Audit Logging
  // ===========================================================================

  private async handleAudit(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const result = AuditEntryInputSchema.safeParse(await request.json());

    if (!result.success) {
      return Response.json(
        { error: "Invalid audit entry", details: result.error.issues },
        { status: 400 }
      );
    }

    const auditResult = await this.appendAuditLog(result.data);
    return Response.json(auditResult);
  }

  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const now = new Date();
    const id = crypto.randomUUID();

    // Build R2 path with date hierarchy
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const timestamp = now.getTime();

    const path = `orgs/${this.ctx.id}/audit/${year}/${month}/${day}/${timestamp}-${id}.json`;

    await this.env.R2.put(
      path,
      JSON.stringify({
        id,
        created_at: now.toISOString(),
        ...entry,
        params: sanitizeAuditParams(entry.params),
      }),
      { httpMetadata: { contentType: "application/json" } }
    );

    return { id };
  }

  // ===========================================================================
  // User & Org Management
  // ===========================================================================

  private async handleRemoveUser(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId?: string };

    if (!body.userId || typeof body.userId !== "string") {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const result = this.sql.exec(
      "DELETE FROM pending_confirmations WHERE user_id = ?",
      body.userId
    );

    return Response.json({
      success: true,
      userId: body.userId,
      expiredConfirmations: result.rowsWritten,
    });
  }

  private async handleDeleteOrg(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Get counts before deletion
    const convCount =
      (this.sql.exec("SELECT COUNT(*) as count FROM conversations").one()
        ?.count as number) ?? 0;
    const msgCount =
      (this.sql.exec("SELECT COUNT(*) as count FROM messages").one()
        ?.count as number) ?? 0;
    const confCount =
      (this.sql
        .exec("SELECT COUNT(*) as count FROM pending_confirmations")
        .one()?.count as number) ?? 0;

    // Delete all data
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM pending_confirmations");
    this.sql.exec("DELETE FROM conversations");
    this.sql.exec("DELETE FROM org_settings");
    this.sql.exec("DELETE FROM clio_schema_cache");

    // Delete KV entries (Clio tokens)
    const kvKeys = await this.ctx.storage.list();
    let kvDeleted = 0;

    for (const key of kvKeys.keys()) {
      await this.ctx.storage.delete(key);
      kvDeleted++;
    }

    // Clear memory cache
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    return Response.json({
      success: true,
      deleted: {
        conversations: convCount,
        messages: msgCount,
        pendingConfirmations: confCount,
        kvEntries: kvDeleted,
      },
    });
  }

  private async handlePurgeUserData(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId?: string };

    if (!body.userId || typeof body.userId !== "string") {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const userId = body.userId;

    // Get counts
    const msgCount =
      (this.sql
        .exec(
          "SELECT COUNT(*) as count FROM messages WHERE user_id = ?",
          userId
        )
        .one()?.count as number) ?? 0;

    const confCount =
      (this.sql
        .exec(
          "SELECT COUNT(*) as count FROM pending_confirmations WHERE user_id = ?",
          userId
        )
        .one()?.count as number) ?? 0;

    // Delete user data
    this.sql.exec("DELETE FROM messages WHERE user_id = ?", userId);
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE user_id = ?",
      userId
    );

    // Delete Clio token
    const clioKey = `clio_token:${userId}`;
    const hadClioToken = (await this.ctx.storage.get(clioKey)) !== undefined;

    if (hadClioToken) {
      await this.ctx.storage.delete(clioKey);
    }

    return Response.json({
      success: true,
      purged: {
        messages: msgCount,
        pendingConfirmations: confCount,
        clioToken: hadClioToken,
      },
    });
  }

  // ===========================================================================
  // Database Migrations
  // ===========================================================================

  private async runMigrations(): Promise<void> {
    // Test SQLite connection
    this.sql.exec("SELECT 1 as test");

    // Create schema version table
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL DEFAULT 0
      )`
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)`
    );

    // Get current version
    const versionRow = this.sql
      .exec("SELECT version FROM schema_version WHERE id = 1")
      .one() as { version: number } | null;

    const currentVersion = versionRow?.version ?? 0;

    // Already at latest version
    if (currentVersion >= 2) {
      return;
    }

    // Migration v1: Initial schema
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
      `);

      this.sql.exec("UPDATE schema_version SET version = 1 WHERE id = 1");
    }

    // Migration v2: Add user_id and title to conversations, status to messages
    if (currentVersion < 2) {
      this.sql.exec(`
        ALTER TABLE conversations ADD COLUMN user_id TEXT;
        ALTER TABLE conversations ADD COLUMN title TEXT;

        CREATE INDEX IF NOT EXISTS idx_conversations_user
          ON conversations(user_id, updated_at DESC);

        ALTER TABLE messages ADD COLUMN status TEXT
          DEFAULT 'complete' CHECK(status IN ('complete', 'partial', 'error'));
      `);

      this.sql.exec("UPDATE schema_version SET version = 2 WHERE id = 1");
    }
  }

  // ===========================================================================
  // Background Tasks (Alarm)
  // ===========================================================================

  async alarm(): Promise<void> {
    const now = Date.now();

    // Schedule next alarm
    await this.ctx.storage.setAlarm(now + TENANT_CONFIG.ALARM_INTERVAL_MS);

    // Archive stale conversations
    const staleConversations = this.sql
      .exec(
        `SELECT id FROM conversations
        WHERE updated_at < ? AND archived_at IS NULL`,
        now - TENANT_CONFIG.STALE_CONVERSATION_MS
      )
      .toArray();

    for (const row of staleConversations) {
      await this.archiveConversation(row.id as string);
    }

    // Clean up expired confirmations
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE expires_at < ?",
      now
    );
  }

  private async archiveConversation(conversationId: string): Promise<void> {
    // Get conversation data
    const conversationRows = this.sql
      .exec("SELECT * FROM conversations WHERE id = ?", conversationId)
      .toArray();

    if (conversationRows.length === 0) {
      return;
    }

    const conversation = conversationRows[0];

    // Get messages
    const messages = this.sql
      .exec(
        `SELECT id, role, content, user_id, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at`,
        conversationId
      )
      .toArray();

    // Archive to R2
    const archiveData = {
      conversation,
      messages,
      archivedAt: new Date().toISOString(),
    };

    const result = await this.env.R2.put(
      `orgs/${this.orgId}/conversations/${conversationId}.json`,
      JSON.stringify(archiveData),
      { httpMetadata: { contentType: "application/json" } }
    );

    if (!result) {
      throw new Error(`Failed to archive conversation ${conversationId} to R2`);
    }

    // Mark as archived and delete messages
    this.sql.exec(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      conversationId
    );
    this.sql.exec(
      "DELETE FROM messages WHERE conversation_id = ?",
      conversationId
    );
  }

  private async ensureAlarmIsSet(): Promise<void> {
    const currentAlarm = await this.ctx.storage.getAlarm();

    if (!currentAlarm) {
      await this.ctx.storage.setAlarm(
        Date.now() + TENANT_CONFIG.ALARM_INTERVAL_MS
      );
    }
  }
}

// =============================================================================
// Type Definitions
// =============================================================================

type SSEEmitter = (event: string, data: unknown) => Promise<void>;

interface SSEStream {
  readable: ReadableStream;
  emit: SSEEmitter;
  close: () => Promise<void>;
}
