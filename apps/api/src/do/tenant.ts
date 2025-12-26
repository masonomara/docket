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
  retrieveRAGContext,
  formatRAGContext,
} from "../services/rag-retrieval";
import {
  fetchAllCustomFields,
  CLIO_SCHEMA_VERSION,
  customFieldsNeedRefresh,
  formatCustomFieldsForLLM,
  type ClioCustomField,
} from "../services/clio-schema";
import {
  storeClioTokens,
  getClioTokens,
  deleteClioTokens,
  tokenNeedsRefresh,
  refreshAccessToken,
  type ClioTokens,
} from "../services/clio-oauth";
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

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private orgId: string;
  private customFieldsCache: ClioCustomField[] = [];
  private customFieldsFetchedAt: number | null = null;
  private schemaVersion: number | null = null;
  private log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.orgId = ctx.id.toString();
    this.log = createLogger({ orgId: this.orgId, component: "TenantDO" });

    // Check if SQLite storage is available
    if (!ctx.storage.sql) {
      this.log.error("SQLite storage not available - DO may not be configured for SQLite");
      throw new Error("SQLite storage not available for this Durable Object");
    }
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      try {
        await this.runMigrations();
        await this.loadSchemaCache();
        await this.ensureAlarmIsSet();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error("DO initialization failed", { error: message });
        throw error;
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Request Router
  // ─────────────────────────────────────────────────────────────────────────────

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
        case "/provision-schema":
          return this.handleProvisionSchema(request);
        case "/force-schema-refresh":
          return this.handleForceSchemaRefresh(request);
        case "/remove-user":
          return this.handleRemoveUser(request);
        case "/delete-org":
          return this.handleDeleteOrg(request);
        case "/purge-user-data":
          return this.handlePurgeUserData(request);
        case "/store-clio-token":
          return this.handleStoreClioToken(request);
        case "/get-clio-status":
          return this.handleGetClioStatus(request);
        case "/delete-clio-token":
          return this.handleDeleteClioToken(request);
        default:
          return Response.json({ error: "Not found" }, { status: 404 });
      }
    } catch (error) {
      console.error(`[TenantDO:${this.orgId}] Error:`, error);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Message Processing
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleProcessMessage(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json();
    const parseResult = ChannelMessageSchema.safeParse(body);

    if (!parseResult.success) {
      return Response.json(
        { error: "Invalid message format", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const message = parseResult.data;

    if (message.orgId !== this.orgId) {
      return Response.json({ error: "Organization mismatch" }, { status: 403 });
    }

    // Set up conversation and check for pending confirmations
    await this.ensureConversationExists(message);
    const pendingConfirmation = await this.claimPendingConfirmation(
      message.conversationId,
      message.userId
    );

    // Store the user's message
    await this.storeMessage(message.conversationId, {
      role: "user",
      content: message.message,
      userId: message.userId,
    });

    // Generate response based on whether there's a pending confirmation
    let response: string;
    if (pendingConfirmation) {
      response = await this.handleConfirmationResponse(
        message,
        pendingConfirmation
      );
    } else {
      response = await this.generateAssistantResponse(message);
    }

    // Store and return the assistant's response
    await this.storeMessage(message.conversationId, {
      role: "assistant",
      content: response,
      userId: null,
    });

    return Response.json({ response });
  }

  private async generateAssistantResponse(
    message: ChannelMessage
  ): Promise<string> {
    // Retrieve relevant context from knowledge base
    const ragContext = await retrieveRAGContext(
      this.env,
      message.message,
      this.orgId,
      {
        jurisdictions: message.jurisdictions,
        practiceTypes: message.practiceTypes,
        firmSize: message.firmSize,
      }
    );

    // Build conversation history
    const conversationHistory = await this.getRecentMessages(
      message.conversationId
    );
    const systemPrompt = this.buildSystemPrompt(
      formatRAGContext(ragContext),
      message.userRole
    );

    // Call the LLM
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];
    const tools = this.getClioTools(message.userRole);
    const llmResponse = await this.callLLM(messages, tools);

    // Handle tool calls if present
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      return this.handleToolCalls(message, llmResponse.toolCalls);
    }

    return llmResponse.content;
  }

  private buildSystemPrompt(ragContext: string, userRole: string): string {
    const customFieldsSection = formatCustomFieldsForLLM(this.customFieldsCache);

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

${customFieldsSection ? `**Firm Custom Fields:**\n${customFieldsSection}` : ""}

**Instructions:**
- Use Knowledge Base and firm context for case management questions
- Query Clio using the clioQuery tool for matters, contacts, tasks, calendar entries, time entries
- For write operations (create, update, delete), always confirm first
- NEVER give legal advice—you manage cases, not law
- Stay in scope: case management, Clio operations, firm procedures
- If Clio is not connected, guide user to connect at docket.com/settings`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LLM Interaction
  // ─────────────────────────────────────────────────────────────────────────────

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
          tools: tools && tools.length > 0 ? tools : undefined,
          max_tokens: 2000,
        }
      );

      // Handle string response
      if (typeof response === "string") {
        return { content: response };
      }

      // Handle object response
      const result = response as {
        response?: string;
        tool_calls?: Array<{
          name: string;
          arguments: string | Record<string, unknown>;
        }>;
      };

      if (!result || typeof result !== "object") {
        return {
          content: "I couldn't process that response. Please try again.",
        };
      }

      // Parse tool calls if present
      const toolCalls = this.parseToolCalls(result.tool_calls);
      const content =
        typeof result.response === "string" ? result.response : "";

      return { content, toolCalls };
    } catch (error) {
      return this.handleLLMError(error, messages, tools, isRetry);
    }
  }

  private parseToolCalls(
    rawToolCalls?: Array<{
      name: string;
      arguments: string | Record<string, unknown>;
    }>
  ): ToolCall[] | undefined {
    if (!rawToolCalls || rawToolCalls.length === 0) {
      return undefined;
    }

    const toolCalls: ToolCall[] = [];

    for (const tc of rawToolCalls) {
      if (!tc.name) {
        continue;
      }

      try {
        const args =
          typeof tc.arguments === "string"
            ? JSON.parse(tc.arguments)
            : (tc.arguments ?? {});

        toolCalls.push({ name: tc.name, arguments: args });
      } catch {
        console.error(
          `[TenantDO:${this.orgId}] Failed to parse tool arguments for ${tc.name}`
        );
      }
    }

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  private async handleLLMError(
    error: unknown,
    messages: Array<{ role: string; content: string }>,
    tools?: object[],
    isRetry = false
  ): Promise<LLMResponse> {
    const errorCode = (error as { code?: number }).code;

    // Retry on transient errors (rate limit, temporary failure)
    if (!isRetry && (errorCode === 3040 || errorCode === 3043)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return this.callLLM(messages, tools, true);
    }

    // Daily limit exceeded
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

  private getClioTools(userRole: string): object[] {
    const modifyNote =
      userRole === "admin"
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
                enum: [
                  "Matter",
                  "Contact",
                  "Task",
                  "CalendarEntry",
                  "TimeEntry",
                ],
                description: "The Clio object type",
              },
              id: {
                type: "string",
                description:
                  "Object ID (required for read single/update/delete)",
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Call Handling
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleToolCalls(
    message: ChannelMessage,
    toolCalls: ToolCall[]
  ): Promise<string> {
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.handleSingleToolCall(message, toolCall);
      results.push(result);
    }

    return results.join("\n\n");
  }

  private async handleSingleToolCall(
    message: ChannelMessage,
    toolCall: ToolCall
  ): Promise<string> {
    // Only handle clioQuery tool
    if (toolCall.name !== "clioQuery") {
      return `Unknown tool: ${toolCall.name}`;
    }

    const args = toolCall.arguments;

    // Check permissions for write operations
    if (args.operation !== "read" && message.userRole !== "admin") {
      return `You don't have permission to ${args.operation} ${args.objectType}s. Only Admins can make changes.`;
    }

    // Handle read operations directly
    if (args.operation === "read") {
      return this.executeClioRead(message.userId, args);
    }

    // For write operations, create a pending confirmation
    await this.createPendingConfirmation(
      message.conversationId,
      message.userId,
      args.operation,
      args.objectType,
      args.data || {}
    );

    const description = this.describeOperation(args);
    return `I'd like to ${description}.

**Please confirm:**
- Reply 'yes' to proceed
- Reply 'no' to cancel
- Or describe any changes you'd like

*This request expires in 5 minutes.*`;
  }

  private describeOperation(args: ToolCall["arguments"]): string {
    const verbs: Record<string, string> = {
      create: "create a new",
      update: "update the",
      delete: "delete the",
      read: "query",
    };

    const verb = verbs[args.operation] || args.operation;
    const objectType = args.objectType.toLowerCase();

    if (args.data) {
      const entries = Object.entries(args.data).slice(0, 3);
      const preview = entries
        .map(([key, value]) => `${key}: "${value}"`)
        .join(", ");
      return `${verb} ${objectType} with ${preview}`;
    }

    if (args.id) {
      return `${verb} ${objectType} ${args.id}`;
    }

    return `${verb} ${objectType}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Confirmation Handling
  // ─────────────────────────────────────────────────────────────────────────────

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
        // User wants to modify the request, process as new message
        const modifiedMessage =
          classification.modifiedRequest || message.message;
        return this.generateAssistantResponse({
          ...message,
          message: modifiedMessage,
        });

      case "unrelated":
        // User is asking about something else, restore the confirmation
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        return this.generateAssistantResponse(message);

      default:
        // Unclear response, restore confirmation and ask for clarification
        this.restorePendingConfirmation(
          message.conversationId,
          message.userId,
          confirmation
        );
        return "I'm not sure if you want to proceed. Please reply 'yes' to confirm or 'no' to cancel.";
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
        { prompt, max_tokens: 100 }
      );

      const text =
        typeof response === "string" ? response : (response?.response ?? "");
      if (!text) {
        return { intent: "unclear" };
      }

      return this.parseClassificationResponse(text);
    } catch (error) {
      console.error(`[TenantDO:${this.orgId}] Classification error:`, error);
      return { intent: "unclear" };
    }
  }

  private parseClassificationResponse(text: string): {
    intent: string;
    modifiedRequest?: string;
  } {
    // Find the JSON object in the response
    const startIdx = text.indexOf("{");
    if (startIdx === -1) {
      return { intent: "unclear" };
    }

    // Find matching closing brace
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}") depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }

    if (endIdx === -1) {
      return { intent: "unclear" };
    }

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx + 1)) as Record<
        string,
        unknown
      >;

      const validIntents = ["approve", "reject", "modify", "unrelated"];
      const intent =
        typeof parsed.intent === "string" &&
        validIntents.includes(parsed.intent)
          ? parsed.intent
          : "unclear";

      const modifiedRequest =
        intent === "modify" && typeof parsed.modifiedRequest === "string"
          ? parsed.modifiedRequest
          : undefined;

      return { intent, modifiedRequest };
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Clio API Operations
  // ─────────────────────────────────────────────────────────────────────────────

  private async executeClioRead(
    userId: string,
    args: { objectType: string; id?: string; filters?: Record<string, unknown> }
  ): Promise<string> {
    const accessToken = await this.getValidClioToken(userId);
    if (!accessToken) {
      return "You haven't connected your Clio account yet. Please connect at docket.com/settings to enable Clio queries.";
    }

    // Lazy refresh: update custom fields if stale (>1 hour) or version mismatch
    if (customFieldsNeedRefresh(this.schemaVersion, this.customFieldsFetchedAt)) {
      await this.refreshCustomFieldsWithToken(accessToken);
    }

    try {
      const endpoint = buildReadQuery(args.objectType, args.id, args.filters);
      let result = await executeClioCall("GET", endpoint, accessToken);

      // Handle 401 by refreshing token and retrying
      if (!result.success && result.error?.status === 401) {
        const refreshedToken = await this.handleClioUnauthorized(userId);

        if (refreshedToken) {
          result = await executeClioCall("GET", endpoint, refreshedToken);
          if (result.success) {
            return formatClioResponse(args.objectType, result.data);
          }
          return result.error?.message || "Failed to fetch data from Clio.";
        }

        return "Your Clio connection has expired. Please reconnect at docket.com/settings.";
      }

      if (result.success) {
        return formatClioResponse(args.objectType, result.data);
      }

      return result.error?.message || "Failed to fetch data from Clio.";
    } catch (error) {
      console.error("[Clio read error]", error);
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
      const { method, endpoint, body } = this.buildCUDRequest(
        action,
        objectType,
        data
      );
      if (!method) {
        return { success: false, details: `Unknown action: ${action}` };
      }
      if (endpoint === null) {
        return { success: false, details: `Missing record ID for ${action}.` };
      }

      let result = await executeClioCall(method, endpoint, accessToken, body);

      // Handle 401 by refreshing token and retrying
      if (!result.success && result.error?.status === 401) {
        const refreshedToken = await this.handleClioUnauthorized(userId);

        if (refreshedToken) {
          result = await executeClioCall(
            method,
            endpoint,
            refreshedToken,
            body
          );
          if (result.success) {
            return {
              success: true,
              details: `Successfully ${action}d ${objectType}.`,
            };
          }
          return {
            success: false,
            details:
              result.error?.message || `Failed to ${action} ${objectType}.`,
          };
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
    } catch (error) {
      console.error(`[Clio ${action} error]`, error);
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
        const req = buildCreateBody(objectType, data);
        return { method: "POST", endpoint: req.endpoint, body: req.body };
      }

      case "update": {
        const id = data.id as string;
        if (!id) {
          return { method: null, endpoint: null };
        }
        const updateData = { ...data };
        delete updateData.id;
        const req = buildUpdateBody(objectType, id, updateData);
        return { method: "PATCH", endpoint: req.endpoint, body: req.body };
      }

      case "delete": {
        const id = data.id as string;
        if (!id) {
          return { method: null, endpoint: null };
        }
        return {
          method: "DELETE",
          endpoint: buildDeleteEndpoint(objectType, id),
        };
      }

      default:
        return { method: null, endpoint: null };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clio Token Management
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleStoreClioToken(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const { userId, tokens, requestId } = (await request.json()) as {
      userId: string;
      tokens: ClioTokens;
      requestId?: string;
    };

    const log = requestId ? this.log.child({ requestId }) : this.log;

    if (!userId || !tokens) {
      log.warn("Store token called with missing data", {
        hasUserId: !!userId,
        hasTokens: !!tokens,
      });
      return Response.json(
        { error: "Missing userId or tokens" },
        { status: 400 }
      );
    }

    log.info("Storing Clio tokens", {
      userId,
      tokenType: tokens.token_type,
      expiresAt: new Date(tokens.expires_at).toISOString(),
    });

    try {
      await storeClioTokens(
        this.ctx.storage,
        userId,
        tokens,
        this.env.ENCRYPTION_KEY
      );
      log.info("Clio tokens stored successfully", { userId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to store Clio tokens", { userId, error: message });
      return Response.json({ error: "Failed to store tokens" }, { status: 500 });
    }

    await this.appendAuditLog({
      user_id: userId,
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

    const { userId } = (await request.json()) as { userId: string };
    if (!userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const tokens = await getClioTokens(this.ctx.storage, userId, this.env);
    return Response.json({
      connected: tokens !== null,
      customFieldsCount: this.customFieldsCache.length,
      schemaVersion: this.schemaVersion,
    });
  }

  private async handleDeleteClioToken(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const { userId, requestId } = (await request.json()) as {
      userId: string;
      requestId?: string;
    };
    const log = requestId ? this.log.child({ requestId }) : this.log;

    if (!userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    log.info("Deleting Clio tokens", { userId });

    try {
      await deleteClioTokens(this.ctx.storage, userId);
      log.info("Clio tokens deleted successfully", { userId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Failed to delete Clio tokens", { userId, error: message });
      return Response.json({ error: "Failed to delete tokens" }, { status: 500 });
    }

    await this.appendAuditLog({
      user_id: userId,
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
      this.log.debug("No Clio tokens found for user", { userId });
      return null;
    }

    // Refresh if needed
    if (tokenNeedsRefresh(tokens)) {
      this.log.info("Clio token needs refresh", {
        userId,
        expiresAt: new Date(tokens.expires_at).toISOString(),
      });

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

        this.log.info("Clio token refreshed successfully", { userId });
        return newTokens.access_token;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error("Clio token refresh failed", { userId, error: message });
        await deleteClioTokens(this.ctx.storage, userId);
        return null;
      }
    }

    return tokens.access_token;
  }

  private async handleClioUnauthorized(userId: string): Promise<string | null> {
    this.log.info("Handling Clio 401 unauthorized - attempting token refresh", {
      userId,
    });

    const tokens = await getClioTokens(this.ctx.storage, userId, this.env);
    if (!tokens?.refresh_token) {
      this.log.warn("No refresh token available for retry", { userId });
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

      this.log.info("Token refreshed after 401", { userId });
      return newTokens.access_token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Token refresh failed after 401", { userId, error: message });
      await deleteClioTokens(this.ctx.storage, userId);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Schema Management
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleProvisionSchema(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const { userId } = (await request.json()) as { userId: string };
    const accessToken = await this.getValidClioToken(userId);

    if (!accessToken) {
      return Response.json({ error: "No valid Clio token" }, { status: 401 });
    }

    const customFields = await fetchAllCustomFields(accessToken);
    await this.saveCustomFields(customFields);

    await this.appendAuditLog({
      user_id: userId,
      action: "schema_provision",
      object_type: "clio_custom_fields",
      params: { count: customFields.length },
      result: "success",
    });

    return Response.json({
      success: true,
      count: customFields.length,
    });
  }

  private async handleRefreshSchema(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const { userId } = (await request.json()) as { userId: string };
    if (!userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const accessToken = await this.getValidClioToken(userId);
    if (!accessToken) {
      return Response.json({ error: "No valid Clio token" }, { status: 401 });
    }

    const customFields = await fetchAllCustomFields(accessToken);
    await this.saveCustomFields(customFields);

    await this.appendAuditLog({
      user_id: userId,
      action: "schema_refresh",
      object_type: "clio_custom_fields",
      params: { count: customFields.length },
      result: "success",
    });

    return Response.json({
      success: true,
      count: customFields.length,
    });
  }

  private async handleForceSchemaRefresh(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const previousVersion = this.schemaVersion;

    // Clear all cached custom field data
    this.sql.exec("DELETE FROM clio_schema_cache");
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;
    this.sql.exec(
      `INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('clio_schema_version', '0', ?)`,
      Date.now()
    );
    this.schemaVersion = 0;

    await this.appendAuditLog({
      user_id: "system",
      action: "schema_force_refresh",
      object_type: "clio_custom_fields",
      params: { previousVersion, targetVersion: CLIO_SCHEMA_VERSION },
      result: "success",
    });

    return Response.json({
      success: true,
      message: "Custom fields cache invalidated. Will refresh on next Clio API call.",
      previousVersion,
      targetVersion: CLIO_SCHEMA_VERSION,
    });
  }

  private async refreshCustomFieldsWithToken(accessToken: string): Promise<void> {
    try {
      const customFields = await fetchAllCustomFields(accessToken);
      await this.saveCustomFields(customFields);
      this.log.info("Auto-refreshed custom fields", {
        version: CLIO_SCHEMA_VERSION,
        count: customFields.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Custom fields auto-refresh failed", { error: message });
    }
  }

  private async saveCustomFields(customFields: ClioCustomField[]): Promise<void> {
    const now = Date.now();

    // Clear existing and store new custom fields as a single JSON blob
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

    // Load version
    const versionRows = this.sql
      .exec("SELECT value FROM org_settings WHERE key = 'clio_schema_version'")
      .toArray();
    const versionRow = versionRows[0] as { value: string } | undefined;
    this.schemaVersion = versionRow ? Number(versionRow.value) : null;

    // Load cached custom fields and fetchedAt
    const rows = this.sql
      .exec("SELECT schema, fetched_at FROM clio_schema_cache WHERE object_type = 'custom_fields'")
      .toArray();

    if (rows.length > 0) {
      try {
        this.customFieldsCache = JSON.parse(rows[0].schema as string);
        this.customFieldsFetchedAt = rows[0].fetched_at as number;
      } catch {
        this.log.warn("Failed to parse cached custom fields");
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Conversation Management
  // ─────────────────────────────────────────────────────────────────────────────

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

    // Create new conversation if it doesn't exist
    if (updateResult.rowsWritten === 0) {
      this.sql.exec(
        `INSERT INTO conversations (id, channel_type, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        message.conversationId,
        message.channel,
        message.conversationScope,
        now,
        now
      );
    }
  }

  private async storeMessage(
    conversationId: string,
    msg: { role: string; content: string; userId: string | null }
  ): Promise<void> {
    this.sql.exec(
      `INSERT INTO messages (id, conversation_id, role, content, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      conversationId,
      msg.role,
      msg.content,
      msg.userId,
      Date.now()
    );
  }

  private async getRecentMessages(
    conversationId: string,
    limit = 15
  ): Promise<Array<{ role: string; content: string }>> {
    const rows = this.sql
      .exec(
        `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Pending Confirmations
  // ─────────────────────────────────────────────────────────────────────────────

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

      // Claim and delete the user's pending confirmation
      return this.sql
        .exec(
          `DELETE FROM pending_confirmations WHERE conversation_id = ? AND user_id = ? RETURNING id, action, object_type, params, expires_at`,
          conversationId,
          userId
        )
        .one();
    });

    if (!row) {
      return null;
    }

    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params as string);
    } catch {
      // Use empty params if parsing fails
    }

    return {
      id: row.id as string,
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
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes

    this.sql.exec(
      `INSERT INTO pending_confirmations (id, conversation_id, user_id, action, object_type, params, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      `INSERT INTO pending_confirmations (id, conversation_id, user_id, action, object_type, params, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Audit Logging
  // ─────────────────────────────────────────────────────────────────────────────

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

    const auditResult = await this.appendAuditLog(result.data);
    return Response.json(auditResult);
  }

  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const now = new Date();
    const id = crypto.randomUUID();

    // Build path: orgs/{orgId}/audit/{year}/{month}/{day}/{timestamp}-{id}.json
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const path = `orgs/${this.ctx.id}/audit/${year}/${month}/${day}/${now.getTime()}-${id}.json`;

    const auditData = {
      id,
      created_at: now.toISOString(),
      ...entry,
      params: sanitizeAuditParams(entry.params),
    };

    await this.env.R2.put(path, JSON.stringify(auditData), {
      httpMetadata: { contentType: "application/json" },
    });

    return { id };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // User & Org Management
  // ─────────────────────────────────────────────────────────────────────────────

  private async handleRemoveUser(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId?: string };
    const userId = body.userId;

    if (!userId || typeof userId !== "string") {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    const result = this.sql.exec(
      "DELETE FROM pending_confirmations WHERE user_id = ?",
      userId
    );

    return Response.json({
      success: true,
      userId,
      expiredConfirmations: result.rowsWritten,
    });
  }

  private async handleDeleteOrg(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Count records before deletion
    const conversationCount =
      (this.sql.exec("SELECT COUNT(*) as count FROM conversations").one()
        ?.count as number) ?? 0;
    const messageCount =
      (this.sql.exec("SELECT COUNT(*) as count FROM messages").one()
        ?.count as number) ?? 0;
    const confirmationCount =
      (this.sql
        .exec("SELECT COUNT(*) as count FROM pending_confirmations")
        .one()?.count as number) ?? 0;

    // Delete all data
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM pending_confirmations");
    this.sql.exec("DELETE FROM conversations");
    this.sql.exec("DELETE FROM org_settings");
    this.sql.exec("DELETE FROM clio_schema_cache");

    // Delete KV entries
    const kvKeys = await this.ctx.storage.list();
    let kvDeletedCount = 0;
    for (const key of kvKeys.keys()) {
      await this.ctx.storage.delete(key);
      kvDeletedCount++;
    }

    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    return Response.json({
      success: true,
      deleted: {
        conversations: conversationCount,
        messages: messageCount,
        pendingConfirmations: confirmationCount,
        kvEntries: kvDeletedCount,
      },
    });
  }

  private async handlePurgeUserData(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const body = (await request.json()) as { userId?: string };
    const userId = body.userId;

    if (!userId || typeof userId !== "string") {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    // Count records before deletion
    const messageCount =
      (this.sql
        .exec(
          "SELECT COUNT(*) as count FROM messages WHERE user_id = ?",
          userId
        )
        .one()?.count as number) ?? 0;
    const confirmationCount =
      (this.sql
        .exec(
          "SELECT COUNT(*) as count FROM pending_confirmations WHERE user_id = ?",
          userId
        )
        .one()?.count as number) ?? 0;

    // Delete user's data
    this.sql.exec("DELETE FROM messages WHERE user_id = ?", userId);
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE user_id = ?",
      userId
    );

    // Delete Clio token if present
    const clioTokenKey = `clio_token:${userId}`;
    const hadClioToken =
      (await this.ctx.storage.get(clioTokenKey)) !== undefined;
    if (hadClioToken) {
      await this.ctx.storage.delete(clioTokenKey);
    }

    return Response.json({
      success: true,
      purged: {
        messages: messageCount,
        pendingConfirmations: confirmationCount,
        clioToken: hadClioToken,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Database Migrations
  // ─────────────────────────────────────────────────────────────────────────────

  private async runMigrations(): Promise<void> {
    this.log.debug("Running migrations - checking version");

    // First, try a simple query to test SQLite access
    try {
      this.log.debug("Testing basic SQLite access with SELECT 1");
      const testResult = this.sql.exec("SELECT 1 as test").one();
      this.log.debug("Basic SQLite test passed", { result: testResult });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Basic SQLite access failed", { error: message });
      throw error;
    }

    // Create migration tracking table if it doesn't exist
    try {
      this.log.debug("Creating schema_version table");
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)
      `);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to create schema_version table", { error: message });
      throw error;
    }

    // Check current version
    let currentVersion: number;
    try {
      const versionResult = this.sql
        .exec("SELECT version FROM schema_version WHERE id = 1")
        .one() as { version: number } | null;
      currentVersion = versionResult?.version ?? 0;
      this.log.debug("Current schema version", { version: currentVersion });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error("Failed to read schema version", { error: message });
      throw error;
    }

    if (currentVersion >= 1) {
      this.log.debug("Schema already migrated", { version: currentVersion });
      return;
    }

    this.log.info("Running initial schema migration");
    // Run initial migration
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        user_id TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

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

      CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_confirmations(expires_at);

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

    // Update version
    this.sql.exec("UPDATE schema_version SET version = 1 WHERE id = 1");
    this.log.info("Schema migration completed", { version: 1 });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Alarm Handler (Background Tasks)
  // ─────────────────────────────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    const now = Date.now();

    // Schedule next alarm
    await this.ctx.storage.setAlarm(now + 24 * 60 * 60 * 1000);

    // Archive stale conversations (30 days old)
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const staleConversations = this.sql
      .exec(
        `SELECT id FROM conversations WHERE updated_at < ? AND archived_at IS NULL`,
        thirtyDaysAgo
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
    const conversation = this.sql
      .exec("SELECT * FROM conversations WHERE id = ?", conversationId)
      .one();

    if (!conversation) {
      return;
    }

    const messages = this.sql
      .exec(
        `SELECT id, role, content, user_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at`,
        conversationId
      )
      .toArray();

    const archiveData = {
      conversation,
      messages,
      archivedAt: new Date().toISOString(),
    };

    const path = `orgs/${this.orgId}/conversations/${conversationId}.json`;
    const result = await this.env.R2.put(path, JSON.stringify(archiveData), {
      httpMetadata: { contentType: "application/json" },
    });

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
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
  }
}
