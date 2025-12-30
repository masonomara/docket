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
import { TENANT_CONFIG } from "../config/tenant";

/**
 * TenantDO is a Durable Object that manages per-organization state.
 *
 * Each organization gets its own TenantDO instance, which provides:
 * - SQLite storage for conversations, messages, and confirmations
 * - KV storage for encrypted Clio OAuth tokens
 * - Clio custom fields schema caching
 * - LLM-powered chat with tool calling for Clio operations
 * - Audit logging to R2
 */
export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private orgId: string;

  // Clio schema caching - keeps custom fields in memory for LLM context
  private customFieldsCache: ClioCustomField[] = [];
  private customFieldsFetchedAt: number | null = null;
  private schemaVersion: number | null = null;

  private log: Logger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Use ctx.id.name to get the original org ID passed to idFromName()
    this.orgId = ctx.id.name!;
    this.log = createLogger({ orgId: this.orgId, component: "TenantDO" });

    // Ensure SQLite is available (required for this DO)
    if (!ctx.storage.sql) {
      throw new Error("SQLite storage not available for this Durable Object");
    }
    this.sql = ctx.storage.sql;

    // Initialize the DO state before handling any requests
    ctx.blockConcurrencyWhile(async () => {
      await this.runMigrations();
      await this.loadSchemaCache();
      await this.ensureAlarmIsSet();
    });
  }

  // ============================================================
  // HTTP Request Router
  // ============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Handle dynamic routes first
      const pathParts = url.pathname.split("/").filter(Boolean);

      // /conversation/:id or /conversation/:id (DELETE)
      if (pathParts[0] === "conversation" && pathParts.length === 2) {
        const conversationId = pathParts[1];
        if (request.method === "DELETE") {
          return this.handleDeleteConversation(request, conversationId);
        }
        return this.handleGetConversation(request, conversationId);
      }

      // /confirmation/:id/accept
      if (
        pathParts[0] === "confirmation" &&
        pathParts.length === 3 &&
        pathParts[2] === "accept"
      ) {
        return this.handleAcceptConfirmation(request, pathParts[1]);
      }

      // /confirmation/:id/reject
      if (
        pathParts[0] === "confirmation" &&
        pathParts.length === 3 &&
        pathParts[2] === "reject"
      ) {
        return this.handleRejectConfirmation(request, pathParts[1]);
      }

      // Static routes
      switch (url.pathname) {
        case "/process-message":
          return this.handleProcessMessage(request);

        case "/process-message-stream":
          return this.handleProcessMessageStream(request);

        case "/conversations":
          return this.handleGetConversations(request);

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
      this.log.error("Request failed", { error, path: url.pathname });
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  }

  // ============================================================
  // Message Processing - Main Chat Flow
  // ============================================================

  /**
   * Handles incoming chat messages from Teams/Slack/etc.
   * This is the main entry point for user conversations.
   */
  private async handleProcessMessage(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Parse and validate the incoming message
    const body = await request.json();
    const parseResult = ChannelMessageSchema.safeParse(body);

    if (!parseResult.success) {
      return Response.json(
        { error: "Invalid message format", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const message = parseResult.data;

    // Note: Org validation is handled by the Worker's withMember middleware
    // The DO trusts that requests are already authenticated and authorized

    // Create conversation if it doesn't exist, or update timestamp
    await this.ensureConversationExists(message);

    // Check if user has a pending confirmation to respond to
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

    // Generate response - either handle confirmation or generate new response
    let response: string;

    if (pendingConfirmation) {
      response = await this.handleConfirmationResponse(
        message,
        pendingConfirmation
      );
    } else {
      response = await this.generateAssistantResponse(message);
    }

    // Store the assistant's response
    await this.storeMessage(message.conversationId, {
      role: "assistant",
      content: response,
      userId: null,
    });

    return Response.json({ response });
  }

  /**
   * Generates an AI response to a user message.
   * Includes RAG context from KB and org docs, plus Clio tool calling.
   */
  private async generateAssistantResponse(
    message: ChannelMessage
  ): Promise<string> {
    // Retrieve relevant context from Knowledge Base and org documents
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

    // Get recent conversation history for context
    const conversationHistory = await this.getRecentMessages(
      message.conversationId
    );

    // Build the system prompt with RAG context and user role info
    const systemPrompt = this.buildSystemPrompt(
      formatRAGContext(ragContext),
      message.userRole
    );

    // Construct the full message array for the LLM
    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    // Get available tools based on user's role (admins can write, members read-only)
    const tools = this.getClioTools(message.userRole);

    // Call the LLM
    const llmResponse = await this.callLLM(messages, tools);

    // If the LLM wants to call tools, handle them
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      return this.handleToolCalls(message, llmResponse.toolCalls);
    }

    return llmResponse.content;
  }

  /**
   * Builds the system prompt that tells the LLM how to behave.
   * Includes RAG context and role-specific instructions.
   */
  private buildSystemPrompt(ragContext: string, userRole: string): string {
    const customFieldsSection = formatCustomFieldsForLLM(
      this.customFieldsCache
    );

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

  // ============================================================
  // LLM Interaction
  // ============================================================

  /**
   * Calls the LLM (Llama 3.1 8B) with messages and optional tools.
   * Includes retry logic for transient errors.
   */
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
          max_tokens: 2000,
        }
      );

      // Handle string responses (simple text output)
      if (typeof response === "string") {
        return { content: response };
      }

      // Handle structured responses with potential tool calls
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

      const toolCalls = this.parseToolCalls(result.tool_calls);

      return {
        content: typeof result.response === "string" ? result.response : "",
        toolCalls,
      };
    } catch (error) {
      return this.handleLLMError(error, messages, tools, isRetry);
    }
  }

  /**
   * Parses raw tool calls from the LLM response into a clean format.
   * Handles both string and object argument formats.
   */
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
      // Skip malformed tool calls without a name
      if (!tc.name) {
        continue;
      }

      try {
        // Parse arguments - could be a JSON string or already an object
        const args =
          typeof tc.arguments === "string"
            ? JSON.parse(tc.arguments)
            : (tc.arguments ?? {});

        toolCalls.push({ name: tc.name, arguments: args });
      } catch {
        // Skip tool calls with unparseable arguments
      }
    }

    return toolCalls.length > 0 ? toolCalls : undefined;
  }

  /**
   * Handles LLM errors with appropriate retry logic and user-friendly messages.
   */
  private async handleLLMError(
    error: unknown,
    messages: Array<{ role: string; content: string }>,
    tools?: object[],
    isRetry = false
  ): Promise<LLMResponse> {
    const errorCode = (error as { code?: number }).code;

    // Retry once for rate limiting (3040) or temporary errors (3043)
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

    // Configuration issue
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

  /**
   * Returns the Clio tools available to the LLM based on user role.
   */
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

  // ============================================================
  // Tool Call Handling
  // ============================================================

  /**
   * Processes all tool calls from the LLM and returns combined results.
   */
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

  /**
   * Handles a single tool call from the LLM.
   */
  private async handleSingleToolCall(
    message: ChannelMessage,
    toolCall: ToolCall
  ): Promise<string> {
    // Only clioQuery is supported
    if (toolCall.name !== "clioQuery") {
      return `Unknown tool: ${toolCall.name}`;
    }

    const args = toolCall.arguments;

    // Permission check: only admins can perform write operations
    if (args.operation !== "read" && message.userRole !== "admin") {
      return `You don't have permission to ${args.operation} ${args.objectType}s. Only Admins can make changes.`;
    }

    // Read operations execute immediately
    if (args.operation === "read") {
      return this.executeClioRead(message.userId, args);
    }

    // Write operations require confirmation
    await this.createPendingConfirmation(
      message.conversationId,
      message.userId,
      args.operation,
      args.objectType,
      args.data || {}
    );

    const operationDescription = this.describeOperation(args);

    return `I'd like to ${operationDescription}.

**Please confirm:**
- Reply 'yes' to proceed
- Reply 'no' to cancel
- Or describe any changes you'd like

*This request expires in 24 hours.*`;
  }

  /**
   * Creates a human-readable description of a Clio operation.
   */
  private describeOperation(args: ToolCall["arguments"]): string {
    const verbs: Record<string, string> = {
      create: "create a new",
      update: "update the",
      delete: "delete the",
      read: "query",
    };

    const verb = verbs[args.operation] || args.operation;
    const objectType = args.objectType.toLowerCase();

    // Include a preview of the data if available
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

  // ============================================================
  // Confirmation Flow
  // ============================================================

  /**
   * Handles a user's response to a pending confirmation.
   * Classifies the intent and takes appropriate action.
   */
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
        // User wants to modify the request - regenerate response with their changes
        return this.generateAssistantResponse({
          ...message,
          message: classification.modifiedRequest || message.message,
        });

      case "unrelated":
        // User is asking about something else - restore the confirmation for later
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

  /**
   * Uses the LLM to classify the user's response to a confirmation prompt.
   */
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
    } catch {
      return { intent: "unclear" };
    }
  }

  /**
   * Parses the LLM's classification response, extracting the JSON.
   */
  private parseClassificationResponse(text: string): {
    intent: string;
    modifiedRequest?: string;
  } {
    // Find the start of the JSON object
    const startIdx = text.indexOf("{");
    if (startIdx === -1) {
      return { intent: "unclear" };
    }

    // Find the matching closing brace
    let depth = 0;
    let endIdx = -1;

    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === "{") {
        depth++;
      }
      if (text[i] === "}") {
        depth--;
      }
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }

    if (endIdx === -1) {
      return { intent: "unclear" };
    }

    try {
      const jsonStr = text.slice(startIdx, endIdx + 1);
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

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

  /**
   * Executes a confirmed Clio operation (create/update/delete).
   */
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

      // Log successful operation
      await this.appendAuditLog({
        user_id: userId,
        action: confirmation.action,
        object_type: confirmation.objectType,
        params: confirmation.params,
        result: "success",
      });

      if (result.details) {
        return `Done! I've ${confirmation.action}d the ${confirmation.objectType}.\n\n${result.details}`;
      }

      return `Done! I've ${confirmation.action}d the ${confirmation.objectType}.`;
    } catch (error) {
      // Log failed operation
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

  // ============================================================
  // Clio API Operations
  // ============================================================

  /**
   * Executes a Clio read operation (list or get single record).
   */
  private async executeClioRead(
    userId: string,
    args: { objectType: string; id?: string; filters?: Record<string, unknown> }
  ): Promise<string> {
    const accessToken = await this.getValidClioToken(userId);

    if (!accessToken) {
      return "You haven't connected your Clio account yet. Please connect at docket.com/settings to enable Clio queries.";
    }

    // Refresh custom fields if needed
    if (
      customFieldsNeedRefresh(this.schemaVersion, this.customFieldsFetchedAt)
    ) {
      await this.refreshCustomFieldsWithToken(accessToken);
    }

    try {
      const endpoint = buildReadQuery(args.objectType, args.id, args.filters);
      let result = await executeClioCall("GET", endpoint, accessToken);

      // Handle expired token - try to refresh and retry
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
    } catch {
      return "An error occurred while fetching data from Clio. Please try again.";
    }
  }

  /**
   * Executes a Clio create/update/delete operation.
   */
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

      // Handle expired token - try to refresh and retry
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
    } catch {
      return {
        success: false,
        details: `An error occurred while trying to ${action} the ${objectType}.`,
      };
    }
  }

  /**
   * Builds the HTTP request parameters for a Clio CUD operation.
   */
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

        // Remove id from update data
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

  // ============================================================
  // Clio Token Management
  // ============================================================

  /**
   * Stores encrypted Clio OAuth tokens for a user.
   */
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
      return Response.json(
        { error: "Missing userId or tokens" },
        { status: 400 }
      );
    }

    try {
      await storeClioTokens(
        this.ctx.storage,
        userId,
        tokens,
        this.env.ENCRYPTION_KEY
      );
      log.info("Clio tokens stored", { userId });
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
      user_id: userId,
      action: "clio_connect",
      object_type: "oauth",
      params: {},
      result: "success",
    });

    return Response.json({ success: true });
  }

  /**
   * Returns the Clio connection status for a user.
   */
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
      lastSyncedAt: this.customFieldsFetchedAt,
    });
  }

  /**
   * Deletes a user's Clio OAuth tokens (disconnect).
   */
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

    try {
      await deleteClioTokens(this.ctx.storage, userId);
      log.info("Clio tokens deleted", { userId });
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
      user_id: userId,
      action: "clio_disconnect",
      object_type: "oauth",
      params: {},
      result: "success",
    });

    return Response.json({ success: true });
  }

  /**
   * Gets a valid Clio access token for a user.
   * Automatically refreshes if the token is expired or about to expire.
   */
  private async getValidClioToken(userId: string): Promise<string | null> {
    const tokens = await getClioTokens(this.ctx.storage, userId, this.env);

    if (!tokens) {
      return null;
    }

    // Check if token needs refresh
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
        // Refresh failed - delete invalid tokens
        await deleteClioTokens(this.ctx.storage, userId);
        return null;
      }
    }

    return tokens.access_token;
  }

  /**
   * Handles a 401 response from Clio by attempting to refresh the token.
   */
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
      // Refresh failed - delete invalid tokens
      await deleteClioTokens(this.ctx.storage, userId);
      return null;
    }
  }

  // ============================================================
  // Clio Schema Management
  // ============================================================

  /**
   * Provisions the Clio schema (custom fields) for a new connection.
   */
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

    return Response.json({ success: true, count: customFields.length });
  }

  /**
   * Refreshes the Clio schema (custom fields) on user request.
   */
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

    return Response.json({ success: true, count: customFields.length });
  }

  /**
   * Forces a schema refresh by invalidating the cache.
   * Used when the schema version changes.
   */
  private async handleForceSchemaRefresh(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const previousVersion = this.schemaVersion;

    // Clear the schema cache
    this.sql.exec("DELETE FROM clio_schema_cache");
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    // Reset version to 0 to force refresh on next API call
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
      message:
        "Custom fields cache invalidated. Will refresh on next Clio API call.",
      previousVersion,
      targetVersion: CLIO_SCHEMA_VERSION,
    });
  }

  /**
   * Refreshes custom fields using an existing access token.
   */
  private async refreshCustomFieldsWithToken(
    accessToken: string
  ): Promise<void> {
    try {
      const customFields = await fetchAllCustomFields(accessToken);
      await this.saveCustomFields(customFields);
    } catch {
      // Silently fail - will retry on next request
    }
  }

  /**
   * Saves custom fields to the database and updates the cache.
   */
  private async saveCustomFields(
    customFields: ClioCustomField[]
  ): Promise<void> {
    const now = Date.now();

    // Clear existing cache
    this.sql.exec("DELETE FROM clio_schema_cache");

    // Store new cache
    this.sql.exec(
      `INSERT INTO clio_schema_cache (object_type, schema, fetched_at) VALUES (?, ?, ?)`,
      "custom_fields",
      JSON.stringify(customFields),
      now
    );

    // Update in-memory cache
    this.customFieldsCache = customFields;
    this.customFieldsFetchedAt = now;

    // Update schema version
    this.sql.exec(
      `INSERT OR REPLACE INTO org_settings (key, value, updated_at) VALUES ('clio_schema_version', ?, ?)`,
      String(CLIO_SCHEMA_VERSION),
      now
    );
    this.schemaVersion = CLIO_SCHEMA_VERSION;
  }

  /**
   * Loads the schema cache from the database into memory.
   */
  private async loadSchemaCache(): Promise<void> {
    // Reset to defaults
    this.customFieldsCache = [];
    this.customFieldsFetchedAt = null;

    // Load schema version
    const versionRows = this.sql
      .exec("SELECT value FROM org_settings WHERE key = 'clio_schema_version'")
      .toArray();

    const versionRow = versionRows[0] as { value: string } | undefined;
    this.schemaVersion = versionRow ? Number(versionRow.value) : null;

    // Load custom fields
    const rows = this.sql
      .exec(
        "SELECT schema, fetched_at FROM clio_schema_cache WHERE object_type = 'custom_fields'"
      )
      .toArray();

    if (rows.length > 0) {
      try {
        this.customFieldsCache = JSON.parse(rows[0].schema as string);
        this.customFieldsFetchedAt = rows[0].fetched_at as number;
      } catch {
        // Invalid cache data - will be refreshed on next request
      }
    }
  }

  // ============================================================
  // Conversation & Message Storage
  // ============================================================

  /**
   * Creates a new conversation or updates the timestamp of an existing one.
   * For web channel, also sets user_id and generates title from first message.
   */
  private async ensureConversationExists(
    message: ChannelMessage
  ): Promise<void> {
    const now = Date.now();

    // Try to update existing conversation's timestamp
    const updateResult = this.sql.exec(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
      now,
      message.conversationId
    );

    // If no rows were updated, create a new conversation
    if (updateResult.rowsWritten === 0) {
      // For web channel, set user_id and generate title from first message
      const isWebChannel = message.channel === "web";
      const title = isWebChannel
        ? this.generateConversationTitle(message.message)
        : null;
      const userId = isWebChannel ? message.userId : null;

      this.sql.exec(
        `INSERT INTO conversations (id, channel_type, scope, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        message.conversationId,
        message.channel,
        message.conversationScope,
        userId,
        title,
        now,
        now
      );
    }
  }

  /**
   * Gets recent messages from a conversation for LLM context.
   */
  private async getRecentMessages(
    conversationId: string,
    limit = TENANT_CONFIG.RECENT_MESSAGES_LIMIT
  ): Promise<Array<{ role: string; content: string }>> {
    const rows = this.sql
      .exec(
        `SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
        conversationId,
        limit
      )
      .toArray();

    // Reverse to get chronological order (oldest first)
    return rows.reverse().map((row) => ({
      role: row.role as string,
      content: row.content as string,
    }));
  }

  // ============================================================
  // Pending Confirmation Management
  // ============================================================

  /**
   * Claims a pending confirmation for a user, removing it from the database.
   * Returns null if no valid confirmation exists.
   */
  private async claimPendingConfirmation(
    conversationId: string,
    userId: string
  ): Promise<PendingConfirmation | null> {
    // Use a transaction to atomically clean up expired and claim valid
    const row = this.ctx.storage.transactionSync(() => {
      // Clean up expired confirmations
      this.sql.exec(
        "DELETE FROM pending_confirmations WHERE expires_at < ?",
        Date.now()
      );

      // Claim the confirmation by deleting and returning it
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

    // Parse the params JSON
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params as string);
    } catch {
      // Use empty params if parsing fails
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

  /**
   * Creates a new pending confirmation for a write operation.
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
    const expiresAt = now + TENANT_CONFIG.CONFIRMATION_TTL_MS;

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

  /**
   * Restores a pending confirmation (used when user's response was unrelated).
   */
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

  // ============================================================
  // Web Chat Streaming Endpoints
  // ============================================================

  /**
   * Creates an SSE stream with emit and close helpers.
   * If requestId is provided, it's included in every event for debugging.
   */
  private createSSEStream(requestId?: string): {
    readable: ReadableStream;
    emit: (event: string, data: unknown) => Promise<void>;
    close: () => Promise<void>;
  } {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const emit = async (event: string, data: unknown) => {
      const payload = requestId ? { ...(data as object), requestId } : data;
      await writer.write(
        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      );
    };

    const close = async () => {
      await writer.close();
    };

    return { readable, emit, close };
  }

  /**
   * Handles streaming chat messages via SSE.
   * Returns Server-Sent Events instead of JSON.
   */
  private async handleProcessMessageStream(
    request: Request
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Parse and validate the incoming message
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

    // Note: Org validation is handled by the Worker's withMember middleware
    // The DO trusts that requests are already authenticated and authorized

    // Create SSE stream with requestId for debugging
    const { readable, emit, close } = this.createSSEStream(requestId);

    // Start async processing in background
    this.ctx.waitUntil(this.processMessageWithStream(message, emit, close));

    // Return SSE response immediately
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Processes a message and emits SSE events throughout.
   */
  private async processMessageWithStream(
    message: ChannelMessage,
    emit: (event: string, data: unknown) => Promise<void>,
    close: () => Promise<void>
  ): Promise<void> {
    try {
      // Emit start event
      await emit("process", { type: "started" });

      // Ensure conversation exists
      await this.ensureConversationExists(message);

      // Store the user's message
      await this.storeMessage(message.conversationId, {
        role: "user",
        content: message.message,
        userId: message.userId,
        status: "complete",
      });

      // Check if user has a pending confirmation to respond to
      const pendingConfirmation = await this.claimPendingConfirmation(
        message.conversationId,
        message.userId
      );

      let response: string;

      if (pendingConfirmation) {
        response = await this.handleConfirmationResponseWithStream(
          message,
          pendingConfirmation,
          emit
        );
      } else {
        response = await this.generateAssistantResponseWithStream(
          message,
          emit
        );
      }

      // Store the assistant's response
      await this.storeMessage(message.conversationId, {
        role: "assistant",
        content: response,
        userId: null,
        status: "complete",
      });

      // Emit done event
      await emit("done", {});
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : "Processing failed";

      // Store error message so conversation history is complete
      try {
        await this.storeMessage(message.conversationId, {
          role: "assistant",
          content: `I encountered an error: ${errorMsg}`,
          userId: null,
          status: "error",
        });
      } catch {
        // Conversation may not exist yet if error occurred early - skip storing
      }

      await emit("error", { message: errorMsg });
    } finally {
      await close();
    }
  }

  /**
   * Generates an AI response with streaming process events.
   */
  private async generateAssistantResponseWithStream(
    message: ChannelMessage,
    emit: (event: string, data: unknown) => Promise<void>
  ): Promise<string> {
    // RAG lookup
    await emit("process", { type: "rag_lookup", status: "started" });

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

    const allChunks = [...ragContext.kbChunks, ...ragContext.orgChunks];
    await emit("process", {
      type: "rag_lookup",
      status: "complete",
      chunks: allChunks.map((c) => ({
        text:
          c.content.slice(0, TENANT_CONFIG.CHUNK_PREVIEW_LENGTH) +
          (c.content.length > TENANT_CONFIG.CHUNK_PREVIEW_LENGTH ? "..." : ""),
        source: c.source,
      })),
    });

    // Get conversation history
    const conversationHistory = await this.getRecentMessages(
      message.conversationId
    );

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(
      formatRAGContext(ragContext),
      message.userRole
    );

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ];

    const tools = this.getClioTools(message.userRole);

    // LLM thinking
    await emit("process", { type: "llm_thinking", status: "started" });

    const llmResponse = await this.callLLM(messages, tools);

    await emit("process", { type: "llm_thinking", status: "complete" });

    // Handle tool calls
    if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
      return this.handleToolCallsWithStream(
        message,
        llmResponse.toolCalls,
        emit
      );
    }

    // Emit content
    await emit("content", { text: llmResponse.content });

    return llmResponse.content;
  }

  /**
   * Handles tool calls with streaming events.
   */
  private async handleToolCallsWithStream(
    message: ChannelMessage,
    toolCalls: ToolCall[],
    emit: (event: string, data: unknown) => Promise<void>
  ): Promise<string> {
    const results: string[] = [];

    for (const toolCall of toolCalls) {
      const result = await this.handleSingleToolCallWithStream(
        message,
        toolCall,
        emit
      );
      results.push(result);
    }

    const fullResponse = results.join("\n\n");
    await emit("content", { text: fullResponse });

    return fullResponse;
  }

  /**
   * Handles a single tool call with streaming events.
   */
  private async handleSingleToolCallWithStream(
    message: ChannelMessage,
    toolCall: ToolCall,
    emit: (event: string, data: unknown) => Promise<void>
  ): Promise<string> {
    if (toolCall.name !== "clioQuery") {
      return `Unknown tool: ${toolCall.name}`;
    }

    const args = toolCall.arguments;

    // Permission check
    if (args.operation !== "read" && message.userRole !== "admin") {
      return `You don't have permission to ${args.operation} ${args.objectType}s. Only Admins can make changes.`;
    }

    // Emit Clio call event
    await emit("process", {
      type: "clio_call",
      operation: args.operation,
      objectType: args.objectType,
      filters: args.filters,
    });

    // Read operations execute immediately
    if (args.operation === "read") {
      const result = await this.executeClioRead(message.userId, args);

      // Parse result to get count for preview
      const lines = result.split("\n").filter((l) => l.trim());
      await emit("process", {
        type: "clio_result",
        count: lines.length,
        preview: lines.slice(0, 3),
      });

      return result;
    }

    // Write operations require confirmation
    const confirmationId = await this.createPendingConfirmation(
      message.conversationId,
      message.userId,
      args.operation,
      args.objectType,
      args.data || {}
    );

    // Emit confirmation required event with the stored ID
    await emit("confirmation_required", {
      confirmationId,
      action: args.operation,
      objectType: args.objectType,
      params: args.data || {},
    });

    const operationDescription = this.describeOperation(args);

    return `I'd like to ${operationDescription}.

**Please confirm:**
- Reply 'yes' to proceed
- Reply 'no' to cancel
- Or describe any changes you'd like

*This request expires in 24 hours.*`;
  }

  /**
   * Handles confirmation response with streaming.
   */
  private async handleConfirmationResponseWithStream(
    message: ChannelMessage,
    confirmation: PendingConfirmation,
    emit: (event: string, data: unknown) => Promise<void>
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

        await emit("process", {
          type: "clio_result",
          success: !result.includes("problem"),
        });
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

      default:
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

  /**
   * Generates a conversation title from the first message.
   * Truncates to 50 chars with ellipsis if longer.
   */
  private generateConversationTitle(message: string): string {
    const cleaned = message.trim().replace(/\s+/g, " ");
    if (cleaned.length <= 50) {
      return cleaned;
    }
    return cleaned.slice(0, 47) + "...";
  }

  /**
   * Stores a message in the conversation.
   */
  private async storeMessage(
    conversationId: string,
    msg: {
      role: string;
      content: string;
      userId: string | null;
      status?: "complete" | "partial" | "error";
    }
  ): Promise<void> {
    this.sql.exec(
      `INSERT INTO messages (id, conversation_id, role, content, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      conversationId,
      msg.role,
      msg.content,
      msg.userId,
      msg.status ?? "complete",
      Date.now()
    );
  }

  /**
   * Returns list of conversations for a user.
   * GET /conversations?userId={userId}
   */
  private async handleGetConversations(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

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

  /**
   * Returns a single conversation with messages.
   * GET /conversation/:id?userId={userId}
   */
  private async handleGetConversation(
    request: Request,
    conversationId: string
  ): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { error: "Missing required query param: userId" },
        { status: 400 }
      );
    }

    // Verify ownership
    const conversation = this.sql
      .exec(
        `SELECT id, title, channel_type, scope, created_at, updated_at
        FROM conversations
        WHERE id = ? AND user_id = ?`,
        conversationId,
        userId
      )
      .one();

    if (!conversation) {
      return Response.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

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

    const messages = messageRows.map((row) => ({
      id: row.id as string,
      role: row.role as string,
      content: row.content as string,
      createdAt: row.created_at as number,
      status: row.status as string,
    }));

    // Get pending confirmations
    const now = Date.now();
    const confirmationRows = this.sql
      .exec(
        `SELECT id, action, object_type, params, expires_at
        FROM pending_confirmations
        WHERE conversation_id = ? AND user_id = ? AND expires_at > ?`,
        conversationId,
        userId,
        now
      )
      .toArray();

    const pendingConfirmations = confirmationRows.map((row) => {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(row.params as string);
      } catch {
        // Use empty params if parsing fails
      }
      return {
        id: row.id as string,
        action: row.action as string,
        objectType: row.object_type as string,
        params,
        expiresAt: row.expires_at as number,
      };
    });

    return Response.json({
      conversation: {
        id: conversation.id as string,
        title: conversation.title as string | null,
        channelType: conversation.channel_type as string,
        scope: conversation.scope as string,
        createdAt: conversation.created_at as number,
        updatedAt: conversation.updated_at as number,
      },
      messages,
      pendingConfirmations,
    });
  }

  /**
   * Deletes a conversation and its messages.
   * DELETE /conversation/:id?userId={userId}
   */
  private async handleDeleteConversation(
    request: Request,
    conversationId: string
  ): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return Response.json(
        { error: "Missing required query param: userId" },
        { status: 400 }
      );
    }

    // Verify ownership before delete
    const conversation = this.sql
      .exec(
        `SELECT id FROM conversations WHERE id = ? AND user_id = ?`,
        conversationId,
        userId
      )
      .one();

    if (!conversation) {
      return Response.json(
        { error: "Conversation not found" },
        { status: 404 }
      );
    }

    // Delete atomically (respecting foreign key relationships)
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

  /**
   * Accepts a pending confirmation and executes the operation.
   * Returns SSE stream with operation result.
   */
  private async handleAcceptConfirmation(
    request: Request,
    confirmationId: string
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const requestId = request.headers.get("X-Request-Id") ?? undefined;

    // Extract userId from body
    const body = (await request.json()) as { userId?: string };
    const userId = body.userId;

    if (!userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    // Look up confirmation and verify ownership
    const row = this.sql
      .exec(
        `SELECT id, conversation_id, user_id, action, object_type, params, expires_at
        FROM pending_confirmations
        WHERE id = ? AND user_id = ?`,
        confirmationId,
        userId
      )
      .one();

    if (!row) {
      return Response.json(
        { error: "Confirmation not found or expired" },
        { status: 404 }
      );
    }

    // Check if expired
    if ((row.expires_at as number) < Date.now()) {
      // Clean up expired confirmation
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
      // Use empty params if parsing fails
    }

    const confirmation: PendingConfirmation = {
      id: row.id as string,
      conversationId: row.conversation_id as string,
      action: row.action as "create" | "update" | "delete",
      objectType: row.object_type as string,
      params,
      expiresAt: row.expires_at as number,
    };

    // Delete the confirmation before executing
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE id = ?",
      confirmationId
    );

    // Create SSE stream for result with requestId for debugging
    const { readable, emit, close } = this.createSSEStream(requestId);

    // Start async processing in background
    this.ctx.waitUntil(
      this.executeAcceptedConfirmation(userId, confirmation, emit, close)
    );

    // Return SSE response immediately
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Executes an accepted confirmation and streams the result.
   */
  private async executeAcceptedConfirmation(
    userId: string,
    confirmation: PendingConfirmation,
    emit: (event: string, data: unknown) => Promise<void>,
    close: () => Promise<void>
  ): Promise<void> {
    try {
      // Emit start event
      await emit("process", { type: "started" });

      // Emit Clio call event
      await emit("process", {
        type: "clio_call",
        operation: confirmation.action,
        objectType: confirmation.objectType,
      });

      // Execute the confirmed operation
      const result = await this.executeConfirmedOperation(userId, confirmation);
      const success = !result.includes("problem");

      // Emit result
      await emit("process", {
        type: "clio_result",
        success,
      });

      // Store the result in conversation history
      await this.storeMessage(confirmation.conversationId, {
        role: "assistant",
        content: result,
        userId: null,
        status: success ? "complete" : "error",
      });

      await emit("content", { text: result });
      await emit("done", {});
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Operation failed";

      // Store error in conversation history
      await this.storeMessage(confirmation.conversationId, {
        role: "assistant",
        content: `Operation failed: ${errorMsg}`,
        userId: null,
        status: "error",
      });

      await emit("error", { message: errorMsg });
    } finally {
      await close();
    }
  }

  /**
   * Rejects a pending confirmation.
   */
  private async handleRejectConfirmation(
    request: Request,
    confirmationId: string
  ): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Extract userId from body
    const body = (await request.json()) as { userId?: string };
    const userId = body.userId;

    if (!userId) {
      return Response.json(
        { error: "Missing required field: userId" },
        { status: 400 }
      );
    }

    // Get confirmation details before deleting (for the rejection message)
    const row = this.sql
      .exec(
        `SELECT conversation_id, action, object_type FROM pending_confirmations WHERE id = ? AND user_id = ?`,
        confirmationId,
        userId
      )
      .one();

    if (!row) {
      return Response.json(
        { error: "Confirmation not found" },
        { status: 404 }
      );
    }

    // Delete the confirmation
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE id = ?",
      confirmationId
    );

    // Store rejection message in conversation history
    const action = row.action as string;
    const objectType = row.object_type as string;
    await this.storeMessage(row.conversation_id as string, {
      role: "assistant",
      content: `The ${action} ${objectType} operation was cancelled.`,
      userId: null,
    });

    return Response.json({ success: true });
  }

  // ============================================================
  // Audit Logging
  // ============================================================

  /**
   * Handles POST /audit requests from the Worker.
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

    return Response.json(await this.appendAuditLog(result.data));
  }

  /**
   * Appends an audit log entry to R2.
   * Logs are organized by date: orgs/{orgId}/audit/{year}/{month}/{day}/{timestamp}-{id}.json
   */
  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const now = new Date();
    const id = crypto.randomUUID();

    // Build date-based path
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const path = `orgs/${this.ctx.id}/audit/${year}/${month}/${day}/${now.getTime()}-${id}.json`;

    // Sanitize params to remove sensitive data before logging
    const sanitizedParams = sanitizeAuditParams(entry.params);

    await this.env.R2.put(
      path,
      JSON.stringify({
        id,
        created_at: now.toISOString(),
        ...entry,
        params: sanitizedParams,
      }),
      { httpMetadata: { contentType: "application/json" } }
    );

    return { id };
  }

  // ============================================================
  // User & Organization Cleanup
  // ============================================================

  /**
   * Removes a user's pending confirmations (used when user leaves org).
   */
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

  /**
   * Deletes all organization data (used when org is deleted).
   */
  private async handleDeleteOrg(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    // Count records before deletion for reporting
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

    // Delete all SQLite data
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM pending_confirmations");
    this.sql.exec("DELETE FROM conversations");
    this.sql.exec("DELETE FROM org_settings");
    this.sql.exec("DELETE FROM clio_schema_cache");

    // Delete all KV data (including encrypted tokens)
    const kvKeys = await this.ctx.storage.list();
    let kvDeletedCount = 0;

    for (const key of kvKeys.keys()) {
      await this.ctx.storage.delete(key);
      kvDeletedCount++;
    }

    // Clear in-memory cache
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

  /**
   * Purges all data for a specific user (GDPR compliance).
   */
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

    // Delete user's messages and confirmations
    this.sql.exec("DELETE FROM messages WHERE user_id = ?", userId);
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE user_id = ?",
      userId
    );

    // Delete Clio token
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

  // ============================================================
  // Database Migrations
  // ============================================================

  /**
   * Runs database migrations to set up or upgrade the schema.
   */
  private async runMigrations(): Promise<void> {
    // Verify SQLite is working
    this.sql.exec("SELECT 1 as test");

    // Create schema version table
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0)`
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)`
    );

    // Check current version
    const versionResult = this.sql
      .exec("SELECT version FROM schema_version WHERE id = 1")
      .one() as { version: number } | null;

    const currentVersion = versionResult?.version ?? 0;

    // Already at latest version
    if (currentVersion >= 2) {
      return;
    }

    // Run v1 migration - create all initial tables
    if (currentVersion < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, scope TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER);
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
        CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')), content TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
        CREATE TABLE IF NOT EXISTS pending_confirmations (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL, action TEXT NOT NULL, object_type TEXT NOT NULL, params TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_confirmations(expires_at);
        CREATE TABLE IF NOT EXISTS org_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS clio_schema_cache (object_type TEXT PRIMARY KEY, schema TEXT NOT NULL, custom_fields TEXT, fetched_at INTEGER NOT NULL);
      `);
      this.sql.exec("UPDATE schema_version SET version = 1 WHERE id = 1");
    }

    // Run v2 migration - add web chat columns
    if (currentVersion < 2) {
      this.sql.exec(`
        ALTER TABLE conversations ADD COLUMN user_id TEXT;
        ALTER TABLE conversations ADD COLUMN title TEXT;
        CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);
        ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'complete' CHECK(status IN ('complete', 'partial', 'error'));
      `);
      this.sql.exec("UPDATE schema_version SET version = 2 WHERE id = 1");
    }
  }

  // ============================================================
  // Durable Object Alarm - Background Maintenance
  // ============================================================

  /**
   * Runs daily maintenance tasks:
   * - Archives stale conversations to R2
   * - Cleans up expired pending confirmations
   */
  async alarm(): Promise<void> {
    const now = Date.now();

    // Schedule next alarm
    await this.ctx.storage.setAlarm(now + TENANT_CONFIG.ALARM_INTERVAL_MS);

    // Find stale conversations
    const thirtyDaysAgo = now - TENANT_CONFIG.STALE_CONVERSATION_MS;

    const staleConversations = this.sql
      .exec(
        `SELECT id FROM conversations WHERE updated_at < ? AND archived_at IS NULL`,
        thirtyDaysAgo
      )
      .toArray();

    // Archive each stale conversation
    for (const row of staleConversations) {
      await this.archiveConversation(row.id as string);
    }

    // Clean up expired pending confirmations
    this.sql.exec(
      "DELETE FROM pending_confirmations WHERE expires_at < ?",
      now
    );
  }

  /**
   * Archives a conversation to R2 and removes its messages from SQLite.
   */
  private async archiveConversation(conversationId: string): Promise<void> {
    // Get conversation metadata
    const conversation = this.sql
      .exec("SELECT * FROM conversations WHERE id = ?", conversationId)
      .one();

    if (!conversation) {
      return;
    }

    // Get all messages
    const messages = this.sql
      .exec(
        `SELECT id, role, content, user_id, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at`,
        conversationId
      )
      .toArray();

    // Store to R2
    const path = `orgs/${this.orgId}/conversations/${conversationId}.json`;

    const result = await this.env.R2.put(
      path,
      JSON.stringify({
        conversation,
        messages,
        archivedAt: new Date().toISOString(),
      }),
      { httpMetadata: { contentType: "application/json" } }
    );

    if (!result) {
      throw new Error(`Failed to archive conversation ${conversationId} to R2`);
    }

    // Mark as archived
    this.sql.exec(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      conversationId
    );

    // Delete messages (keep conversation record for reference)
    this.sql.exec(
      "DELETE FROM messages WHERE conversation_id = ?",
      conversationId
    );
  }

  /**
   * Ensures the daily maintenance alarm is set.
   */
  private async ensureAlarmIsSet(): Promise<void> {
    const existingAlarm = await this.ctx.storage.getAlarm();

    if (!existingAlarm) {
      await this.ctx.storage.setAlarm(
        Date.now() + TENANT_CONFIG.ALARM_INTERVAL_MS
      );
    }
  }
}
