# Phase 9b: Web Chat Interface Tutorial

A hands-on guide to building a real-time chat interface for Docket. This tutorial explains the **why** behind each component, not just the **how**.

## What You're Building

By the end of this tutorial, you'll have:

1. **A three-column chat interface** — conversations list, message area, and process log
2. **Real-time streaming responses** — Server-Sent Events (SSE) from Cloudflare Workers
3. **Clio operation confirmations** — inline cards for create/update/delete approval
4. **Conversation persistence** — chat history stored in Durable Object SQLite

The architecture looks like this:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Browser                                     │
│  ┌──────────────┬─────────────────────────┬──────────────────────────┐  │
│  │ ChatSidebar  │     ChatMessages        │     ProcessLog           │  │
│  │              │                         │                          │  │
│  │ [New Chat]   │  User: What matters...  │  Step 1: RAG lookup      │  │
│  │ - Conv 1     │  Bot: Here are your...  │  Step 2: LLM thinking    │  │
│  │ - Conv 2     │                         │  Step 3: Clio call       │  │
│  │              │  [Input box]            │                          │  │
│  └──────────────┴─────────────────────────┴──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ POST /api/chat (SSE)
┌─────────────────────────────────────────────────────────────────────────┐
│                          API Worker (apps/api)                           │
│  src/index.ts → src/handlers/chat.ts → DO.fetch("/process-message")     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Durable Object (TenantDO)                            │
│  - SQLite: conversations, messages, pending_confirmations               │
│  - RAG retrieval → Workers AI → Clio API → Response stream              │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Part 1: Understanding the Data Flow

Before writing code, understand how data moves through the system.

### 1.1 The Request Lifecycle

When a user sends a message, here's what happens:

```
1. User types message → ChatInput component
2. ChatInput calls POST /api/chat with { conversationId, message }
3. API Worker receives request, validates auth session
4. Worker looks up user's org membership and role from D1
5. Worker forwards ChannelMessage to org's Durable Object
6. DO generates embedding, queries Vectorize for KB + Org Context
7. DO loads Clio schema from memory, builds system prompt
8. DO calls Workers AI with tools enabled
9. If LLM requests Clio data: DO executes API call, feeds result back
10. If LLM requests write: DO creates pending_confirmation, asks user
11. Response streams back via SSE events
12. ChatMessages component renders each chunk as it arrives
```

### 1.2 Why Server-Sent Events?

SSE is simpler than WebSockets for this use case:

| Feature            | SSE                  | WebSockets               |
| ------------------ | -------------------- | ------------------------ |
| Direction          | Server → Client only | Bidirectional            |
| Reconnection       | Automatic            | Manual                   |
| Protocol           | HTTP                 | Separate protocol        |
| Cloudflare Workers | Native support       | Requires Durable Objects |

For chat, we only need server-to-client streaming. The user's messages go via regular POST requests.

### 1.3 The ChannelMessage Contract

All chat channels (web, Teams, Slack) use the same message format:

```typescript
interface ChannelMessage {
  channel: "teams" | "slack" | "mcp" | "chatgpt" | "web";
  orgId: string;
  userId: string;
  userRole: "admin" | "member";
  conversationId: string;
  conversationScope:
    | "personal"
    | "groupChat"
    | "teams"
    | "dm"
    | "channel"
    | "api";
  message: string;
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: "solo" | "small" | "mid" | "large" | null;
}
```

For web chat:

- `channel` = `"web"`
- `conversationScope` = `"personal"` (web is always 1:1 with the bot)
- Client generates `conversationId` as a UUID

This unified format means the DO's message processing logic works identically for all channels.

---

## Part 2: Building the API Layer

### 2.1 Create the Chat Handler

Create `apps/api/src/handlers/chat.ts`:

- Handles POST /api/chat
  - This is the main entry point for web chat messages. It:
    - Validates the request body
    - Builds a ChannelMessage from the authenticated user's context
    - Forwards to the organization's Durable Object
    - Returns the DO's response as an SSE stream
  - Parse the incoming message
  - Build the ChannelMessage from authenticated context
  - The withMember middleware has already validated:
    - User is logged in
    - User belongs to an organization
    - User has at least "member" role
  - Validate against the schema (defense in depth)
  - Get the organization's Durable Object
    - Each org has exactly one DO, identified by org ID
  - Forward to the DO and return its streaming response
  - Pass through the SSE response

Key points:

1. Context comes from middleware — The `withMember` wrapper has already verified auth and loaded org data. We don't repeat that work.
2. Org settings flow through — `jurisdictions`, `practiceTypes`, and `firmSize` filter which KB chunks the RAG retrieval returns. A New York family law firm shouldn't see California corporate law docs.
3. DO ID is deterministic — `idFromName(orgId)` always returns the same DO for a given org. No lookup needed.

### 2.2 Conversation List Endpoints

- GET /api/conversations
  - Returns the user's conversations, most recent first.
  - Each conversation shows title (first message truncated), updated time, and message count.
- GET /api/conversations/:id
  - Returns a single conversation with all its messages.
  - Used when user clicks a conversation in the sidebar.
- DELETE /api/conversations/:id
  - Deletes a conversation and all its messages.
  - Users can only delete their own conversations.

### 2.3 Confirmation Endpoints

- POST /api/confirmations/:id/accept
  - Accepts a pending Clio operation.
  - Returns an SSE stream with the operation result.
- POST /api/confirmations/:id/reject
  - Rejects a pending Clio operation.
  - Simple JSON response (no streaming needed).

### 2.4 Register Routes in index.ts

Add to `apps/api/src/index.ts`:

```typescript
import {
  handleChatMessage,
  handleGetConversations,
  handleGetConversation,
  handleDeleteConversation,
  handleAcceptConfirmation,
  handleRejectConfirmation,
} from "./handlers/chat";

// Add to staticRoutes:
"/api/chat": {
  POST: withMember(handleChatMessage),
},
"/api/conversations": {
  GET: withMember(handleGetConversations),
},

// Add to matchDynamicRoute:
const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
if (conversationMatch) {
  const conversationId = conversationMatch[1];

  if (method === "GET") {
    return withMember((req, e, ctx) =>
      handleGetConversation(req, e, ctx, conversationId)
    )(request, env);
  }

  if (method === "DELETE") {
    return withMember((req, e, ctx) =>
      handleDeleteConversation(req, e, ctx, conversationId)
    )(request, env);
  }
}

const confirmationAcceptMatch = path.match(/^\/api\/confirmations\/([^/]+)\/accept$/);
if (confirmationAcceptMatch && method === "POST") {
  const confirmationId = confirmationAcceptMatch[1];
  return withMember((req, e, ctx) =>
    handleAcceptConfirmation(req, e, ctx, confirmationId)
  )(request, env);
}

const confirmationRejectMatch = path.match(/^\/api\/confirmations\/([^/]+)\/reject$/);
if (confirmationRejectMatch && method === "POST") {
  const confirmationId = confirmationRejectMatch[1];
  return withMember((req, e, ctx) =>
    handleRejectConfirmation(req, e, ctx, confirmationId)
  )(request, env);
}
```

---

## Part 3: Extending the Durable Object

### 3.1 Understanding DO Storage

The TenantDO uses SQLite for conversations and messages. The schema includes `user_id` and `title` columns for web chat:

```sql
-- Created in runMigrations()
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  user_id TEXT,              -- For filtering by user
  title TEXT,                -- First message truncated to 50 chars
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  user_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE pending_confirmations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

The schema uses `CREATE TABLE IF NOT EXISTS` for idempotency — no version tracking needed during development.

### 3.2 Add Streaming Message Processing

Modify `handleProcessMessage` to support SSE streaming:

- Handles streaming message processing for web chat.
  - The key difference from the original handleProcessMessage:
    - Returns a ReadableStream instead of waiting for full response
    - Emits SSE events as processing happens
    - Supports step-by-step visibility (RAG, LLM, Clio)
- Create the SSE stream
  - Helper to send SSE events
  - Process in background, stream results
- Processes a message and streams events to the client.
  - Ensure conversation exists
  - Store user's message
  - Check for pending confirmation
  - Store assistant's response
  - Signal completion
- Generates a response with step-by-step streaming.
  - Step 1: RAG Retrieval
  - Step 2: Build context
  - Step 3: LLM Call
  - Step 4: Handle tool calls if any
- Stream the final content
- Handles tool calls with streaming visibility.
  - Permission check
  - Read operations
  - Write operations need confirmation

### 3.3 Add Conversation Query Endpoints

Add these handlers to the DO's fetch router:

```typescript
// In TenantDO.fetch():
case "/conversations":
  return this.handleGetConversations(request);

case `/conversation/${url.pathname.split("/")[2]}`:
  if (request.method === "DELETE") {
    return this.handleDeleteConversation(request, url.pathname.split("/")[2]);
  }
  return this.handleGetConversation(request, url.pathname.split("/")[2]);

// Implementation:

private async handleGetConversations(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  if (!userId) {
    return Response.json({ error: "Missing userId" }, { status: 400 });
  }

  const rows = this.sql.exec(`
    SELECT
      c.id,
      c.title,
      c.updated_at as updatedAt,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as messageCount
    FROM conversations c
    WHERE c.user_id = ? AND c.channel_type = 'web'
    ORDER BY c.updated_at DESC
    LIMIT 50
  `, userId).toArray();

  return Response.json({ conversations: rows });
}

private async handleGetConversation(
  request: Request,
  conversationId: string
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  // Verify ownership
  const conv = this.sql.exec(
    "SELECT * FROM conversations WHERE id = ? AND user_id = ?",
    conversationId,
    userId
  ).one();

  if (!conv) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  const messages = this.sql.exec(`
    SELECT id, role, content, created_at as createdAt, status
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `, conversationId).toArray();

  // Check for pending confirmations
  const pending = this.sql.exec(`
    SELECT id, action, object_type as objectType, params
    FROM pending_confirmations
    WHERE conversation_id = ? AND user_id = ? AND expires_at > ?
  `, conversationId, userId, Date.now()).toArray();

  return Response.json({
    conversation: conv,
    messages,
    pendingConfirmations: pending.map(p => ({
      ...p,
      params: JSON.parse(p.params as string),
    })),
  });
}

private async handleDeleteConversation(
  request: Request,
  conversationId: string
): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("userId");

  // Verify ownership before delete
  const conv = this.sql.exec(
    "SELECT id FROM conversations WHERE id = ? AND user_id = ?",
    conversationId,
    userId
  ).one();

  if (!conv) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }

  // Delete messages first (foreign key)
  this.sql.exec("DELETE FROM messages WHERE conversation_id = ?", conversationId);
  this.sql.exec("DELETE FROM pending_confirmations WHERE conversation_id = ?", conversationId);
  this.sql.exec("DELETE FROM conversations WHERE id = ?", conversationId);

  return Response.json({ success: true });
}
```

---

## Part 4: Building the Frontend

### 4.1 Understanding React Router 7 Patterns

Docket uses React Router 7 with these patterns:

1. **Loaders** — Server-side data fetching before render
2. **Actions** — Form submissions and mutations
3. **useFetcher** — Client-side data without navigation

Example from the codebase (`apps/web/app/lib/loader-auth.ts`):

```typescript
// protectedLoader wraps your loader with auth checks
export const loader = protectedLoader(({ user, org }) => ({ user, org }));

// orgLoader requires both auth AND org membership
export const loader = orgLoader(async ({ user, org, fetch }) => {
  const data = await fetch("/api/some-endpoint").then((r) => r.json());
  return { user, org, data };
});
```

### 4.2 Create the Chat Route

Create `apps/web/app/routes/chat.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useParams } from "react-router";
import type { Route } from "./+types/chat";
import { orgLoader } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { ChatSidebar } from "~/components/ChatSidebar";
import { ChatMessages } from "~/components/ChatMessages";
import { ChatInput } from "~/components/ChatInput";
import { ProcessLog } from "~/components/ProcessLog";
import { useChat } from "~/lib/use-chat";
import styles from "~/styles/chat.module.css";

/**
 * Loader fetches initial data:
 * - User and org info (for auth/nav)
 * - List of conversations (for sidebar)
 * - Current conversation if URL has conversationId
 */
export const loader = orgLoader(async ({ user, org, fetch }) => {
  const conversationsRes = await fetch("/api/conversations");
  const conversations = conversationsRes.ok
    ? await conversationsRes.json()
    : { conversations: [] };

  return { user, org, conversations: conversations.conversations };
});

export default function Chat({ loaderData }: Route.ComponentProps) {
  const { user, org, conversations: initialConversations } = loaderData;
  const navigate = useNavigate();
  const params = useParams();

  const [conversations, setConversations] = useState(initialConversations);
  const [currentConversationId, setCurrentConversationId] = useState<
    string | null
  >(params.conversationId || null);

  // The useChat hook manages:
  // - SSE connection
  // - Message state
  // - Process log events
  // - Pending confirmations
  const {
    messages,
    processLog,
    pendingConfirmation,
    isStreaming,
    error,
    sendMessage,
    acceptConfirmation,
    rejectConfirmation,
    loadConversation,
  } = useChat(currentConversationId);

  // Handle new chat creation
  function handleNewChat() {
    const newId = crypto.randomUUID();
    setCurrentConversationId(newId);
    navigate(`/chat/${newId}`);
  }

  // Handle conversation selection from sidebar
  async function handleSelectConversation(conversationId: string) {
    setCurrentConversationId(conversationId);
    navigate(`/chat/${conversationId}`);
    await loadConversation(conversationId);
  }

  // Handle message send
  async function handleSend(message: string) {
    if (!currentConversationId) {
      // Create new conversation on first message
      const newId = crypto.randomUUID();
      setCurrentConversationId(newId);
      navigate(`/chat/${newId}`, { replace: true });
      await sendMessage(newId, message);
    } else {
      await sendMessage(currentConversationId, message);
    }

    // Refresh conversations list
    const res = await fetch("/api/conversations", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      setConversations(data.conversations);
    }
  }

  // Handle conversation deletion
  async function handleDeleteConversation(conversationId: string) {
    const res = await fetch(`/api/conversations/${conversationId}`, {
      method: "DELETE",
      credentials: "include",
    });

    if (res.ok) {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (currentConversationId === conversationId) {
        setCurrentConversationId(null);
        navigate("/chat");
      }
    }
  }

  return (
    <AppLayout org={org} currentPath="/chat">
      <div className={styles.chatLayout}>
        {/* Left column: Conversation list */}
        <ChatSidebar
          conversations={conversations}
          currentConversationId={currentConversationId}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={handleDeleteConversation}
        />

        {/* Center column: Chat messages */}
        <div className={styles.chatMain}>
          <ChatMessages
            messages={messages}
            pendingConfirmation={pendingConfirmation}
            isStreaming={isStreaming}
            onAcceptConfirmation={acceptConfirmation}
            onRejectConfirmation={rejectConfirmation}
          />

          <ChatInput
            onSend={handleSend}
            disabled={isStreaming || !!pendingConfirmation}
          />

          {error && <div className={styles.error}>{error}</div>}
        </div>

        {/* Right column: Process log */}
        <ProcessLog events={processLog} />
      </div>
    </AppLayout>
  );
}
```

### 4.3 The useChat Hook

Create `apps/web/app/lib/use-chat.ts`:

```typescript
import { useState, useCallback, useRef } from "react";
import { API_URL } from "./auth-client";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "complete" | "partial" | "streaming";
}

interface ProcessEvent {
  type: "rag_lookup" | "llm_thinking" | "clio_call" | "clio_result";
  status: "started" | "completed";
  data?: unknown;
}

interface PendingConfirmation {
  confirmationId: string;
  action: string;
  objectType: string;
  params: Record<string, unknown>;
}

interface UseChatReturn {
  messages: Message[];
  processLog: ProcessEvent[];
  pendingConfirmation: PendingConfirmation | null;
  isStreaming: boolean;
  error: string | null;
  sendMessage: (conversationId: string, message: string) => Promise<void>;
  acceptConfirmation: () => Promise<void>;
  rejectConfirmation: () => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
}

/**
 * Custom hook for managing chat state and SSE streaming.
 *
 * This is the core of the chat interface. It handles:
 * 1. Sending messages via POST and receiving SSE responses
 * 2. Parsing SSE events and updating UI state
 * 3. Managing pending Clio confirmations
 * 4. Loading existing conversations
 */
export function useChat(initialConversationId: string | null): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [processLog, setProcessLog] = useState<ProcessEvent[]>([]);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep track of the current streaming message
  const streamingMessageRef = useRef<string>("");

  /**
   * Sends a message and handles the SSE response stream.
   */
  const sendMessage = useCallback(
    async (conversationId: string, message: string) => {
      setError(null);
      setProcessLog([]);

      // Add user message immediately
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
        createdAt: Date.now(),
        status: "complete",
      };
      setMessages((prev) => [...prev, userMessage]);

      // Create placeholder for assistant response
      const assistantMessageId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          status: "streaming",
        },
      ]);

      setIsStreaming(true);
      streamingMessageRef.current = "";

      try {
        const response = await fetch(`${API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ conversationId, message }),
        });

        if (!response.ok) {
          throw new Error("Failed to send message");
        }

        // Handle SSE stream
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const events = parseSSEEvents(buffer);
          buffer = events.remaining;

          for (const event of events.parsed) {
            handleSSEEvent(event, assistantMessageId);
          }
        }

        // Mark message as complete
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? {
                  ...m,
                  content: streamingMessageRef.current,
                  status: "complete",
                }
              : m
          )
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
        // Mark message as error
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId ? { ...m, status: "partial" } : m
          )
        );
      } finally {
        setIsStreaming(false);
      }
    },
    []
  );

  /**
   * Parses SSE events from a buffer string.
   */
  function parseSSEEvents(buffer: string): {
    parsed: SSEEvent[];
    remaining: string;
  } {
    const events: SSEEvent[] = [];
    const lines = buffer.split("\n");
    let currentEvent: Partial<SSEEvent> = {};
    let remaining = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this is the last incomplete line
      if (i === lines.length - 1 && !line.endsWith("\n")) {
        remaining = line;
        break;
      }

      if (line.startsWith("event: ")) {
        currentEvent.type = line.slice(7);
      } else if (line.startsWith("data: ")) {
        try {
          currentEvent.data = JSON.parse(line.slice(6));
        } catch {
          currentEvent.data = line.slice(6);
        }
      } else if (line === "") {
        // Empty line = end of event
        if (currentEvent.type) {
          events.push(currentEvent as SSEEvent);
        }
        currentEvent = {};
      }
    }

    return { parsed: events, remaining };
  }

  interface SSEEvent {
    type: string;
    data: unknown;
  }

  /**
   * Handles a single SSE event, updating appropriate state.
   */
  function handleSSEEvent(event: SSEEvent, messageId: string) {
    switch (event.type) {
      case "content":
        // Append content to the streaming message
        const { text } = event.data as { text: string };
        streamingMessageRef.current += text;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, content: streamingMessageRef.current }
              : m
          )
        );
        break;

      case "process":
        // Add to process log
        const processEvent = event.data as ProcessEvent;
        setProcessLog((prev) => [...prev, processEvent]);
        break;

      case "confirmation_required":
        // Store pending confirmation
        setPendingConfirmation(event.data as PendingConfirmation);
        break;

      case "error":
        const { message } = event.data as { message: string };
        setError(message);
        break;

      case "done":
        // Stream complete
        break;
    }
  }

  /**
   * Accepts a pending Clio confirmation.
   */
  const acceptConfirmation = useCallback(async () => {
    if (!pendingConfirmation) return;

    setIsStreaming(true);
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}/api/confirmations/${pendingConfirmation.confirmationId}/accept`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) throw new Error("Failed to accept confirmation");

      // Handle the response stream (same as sendMessage)
      const assistantMessageId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantMessageId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          status: "streaming",
        },
      ]);

      streamingMessageRef.current = "";

      // ... same streaming logic as sendMessage

      setPendingConfirmation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsStreaming(false);
    }
  }, [pendingConfirmation]);

  /**
   * Rejects a pending Clio confirmation.
   */
  const rejectConfirmation = useCallback(async () => {
    if (!pendingConfirmation) return;

    try {
      const response = await fetch(
        `${API_URL}/api/confirmations/${pendingConfirmation.confirmationId}/reject`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) throw new Error("Failed to reject confirmation");

      // Add cancellation message
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Got it, I've cancelled that operation.",
          createdAt: Date.now(),
          status: "complete",
        },
      ]);

      setPendingConfirmation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }, [pendingConfirmation]);

  /**
   * Loads an existing conversation's messages.
   */
  const loadConversation = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(
        `${API_URL}/api/conversations/${conversationId}`,
        { credentials: "include" }
      );

      if (!response.ok) {
        setMessages([]);
        return;
      }

      const data = await response.json();
      setMessages(data.messages);

      // Load any pending confirmations
      if (data.pendingConfirmations?.length > 0) {
        const pending = data.pendingConfirmations[0];
        setPendingConfirmation({
          confirmationId: pending.id,
          action: pending.action,
          objectType: pending.objectType,
          params: pending.params,
        });
      } else {
        setPendingConfirmation(null);
      }
    } catch {
      setMessages([]);
    }
  }, []);

  return {
    messages,
    processLog,
    pendingConfirmation,
    isStreaming,
    error,
    sendMessage,
    acceptConfirmation,
    rejectConfirmation,
    loadConversation,
  };
}
```

### 4.4 Chat Components

Create `apps/web/app/components/ChatSidebar.tsx`:

```tsx
import { Trash2 } from "lucide-react";
import styles from "~/styles/chat-sidebar.module.css";

interface Conversation {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
}

interface ChatSidebarProps {
  conversations: Conversation[];
  currentConversationId: string | null;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
}

export function ChatSidebar({
  conversations,
  currentConversationId,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
}: ChatSidebarProps) {
  function formatDate(timestamp: number) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor(
      (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  }

  return (
    <aside className={styles.sidebar}>
      <button
        className={`btn btn-primary ${styles.newChatButton}`}
        onClick={onNewChat}
      >
        New Chat
      </button>

      <div className={styles.conversationList}>
        {conversations.map((conv) => (
          <div
            key={conv.id}
            className={`${styles.conversationItem} ${
              conv.id === currentConversationId ? styles.active : ""
            }`}
            onClick={() => onSelectConversation(conv.id)}
          >
            <div className={styles.conversationInfo}>
              <span className={styles.title}>
                {conv.title || "New conversation"}
              </span>
              <span className={styles.meta}>
                {formatDate(conv.updatedAt)} · {conv.messageCount} messages
              </span>
            </div>
            <button
              className={styles.deleteButton}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteConversation(conv.id);
              }}
              aria-label="Delete conversation"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        {conversations.length === 0 && (
          <p className={styles.emptyState}>
            No conversations yet. Start a new chat!
          </p>
        )}
      </div>
    </aside>
  );
}
```

Create `apps/web/app/components/ChatMessages.tsx`:

```tsx
import { useRef, useEffect } from "react";
import styles from "~/styles/chat-messages.module.css";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "partial" | "streaming";
}

interface PendingConfirmation {
  confirmationId: string;
  action: string;
  objectType: string;
  params: Record<string, unknown>;
}

interface ChatMessagesProps {
  messages: Message[];
  pendingConfirmation: PendingConfirmation | null;
  isStreaming: boolean;
  onAcceptConfirmation: () => void;
  onRejectConfirmation: () => void;
}

export function ChatMessages({
  messages,
  pendingConfirmation,
  isStreaming,
  onAcceptConfirmation,
  onRejectConfirmation,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pendingConfirmation]);

  return (
    <div className={styles.messagesContainer}>
      {messages.length === 0 && (
        <div className={styles.emptyState}>
          <h2>Welcome to Docket</h2>
          <p>Ask me about your cases, tasks, or Clio data.</p>
        </div>
      )}

      {messages.map((message) => (
        <div
          key={message.id}
          className={`${styles.message} ${styles[message.role]}`}
        >
          <div className={styles.messageContent}>
            {message.content}
            {message.status === "streaming" && (
              <span className={styles.cursor}>▋</span>
            )}
          </div>
        </div>
      ))}

      {/* Confirmation card */}
      {pendingConfirmation && (
        <div className={styles.confirmationCard}>
          <h3>Confirm {pendingConfirmation.action}</h3>
          <p>
            Docket wants to <strong>{pendingConfirmation.action}</strong> a{" "}
            <strong>{pendingConfirmation.objectType}</strong>:
          </p>
          <pre className={styles.confirmationParams}>
            {JSON.stringify(pendingConfirmation.params, null, 2)}
          </pre>
          <div className={styles.confirmationActions}>
            <button
              className="btn btn-secondary"
              onClick={onRejectConfirmation}
              disabled={isStreaming}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={onAcceptConfirmation}
              disabled={isStreaming}
            >
              Confirm
            </button>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
}
```

Create `apps/web/app/components/ChatInput.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import styles from "~/styles/chat-input.module.css";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [message]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || disabled) return;

    onSend(message.trim());
    setMessage("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Submit on Enter (without Shift)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <form className={styles.inputContainer} onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        className={styles.textarea}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? "Please wait..." : "Ask about your cases..."}
        disabled={disabled}
        rows={1}
      />
      <button
        type="submit"
        className={styles.sendButton}
        disabled={disabled || !message.trim()}
        aria-label="Send message"
      >
        <Send size={20} />
      </button>
    </form>
  );
}
```

Create `apps/web/app/components/ProcessLog.tsx`:

```tsx
import { Check, Loader2 } from "lucide-react";
import styles from "~/styles/process-log.module.css";

interface ProcessEvent {
  type: "rag_lookup" | "llm_thinking" | "clio_call" | "clio_result";
  status: "started" | "completed";
  data?: unknown;
}

interface ProcessLogProps {
  events: ProcessEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  rag_lookup: "Searching knowledge base",
  llm_thinking: "Generating response",
  clio_call: "Querying Clio",
  clio_result: "Processing Clio data",
};

export function ProcessLog({ events }: ProcessLogProps) {
  if (events.length === 0) {
    return (
      <aside className={styles.processLog}>
        <h3 className={styles.title}>Process Log</h3>
        <p className={styles.emptyState}>
          Steps will appear here as Docket processes your request.
        </p>
      </aside>
    );
  }

  // Group events by type to show latest status
  const eventsByType = new Map<string, ProcessEvent>();
  for (const event of events) {
    eventsByType.set(event.type, event);
  }

  return (
    <aside className={styles.processLog}>
      <h3 className={styles.title}>Process Log</h3>

      <ul className={styles.eventList}>
        {Array.from(eventsByType.entries()).map(([type, event]) => (
          <li key={type} className={styles.event}>
            {event.status === "completed" ? (
              <Check className={styles.completedIcon} size={16} />
            ) : (
              <Loader2 className={styles.loadingIcon} size={16} />
            )}
            <span>{EVENT_LABELS[type] || type}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

---

## Part 5: Styling

Create `apps/web/app/styles/chat.module.css`:

```css
.chatLayout {
  display: grid;
  grid-template-columns: 280px 1fr 260px;
  height: 100vh;
  overflow: hidden;
}

.chatMain {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-left: 1px solid var(--color-border);
  border-right: 1px solid var(--color-border);
}

.error {
  padding: 12px 16px;
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 14px;
}

/* Responsive: hide process log on smaller screens */
@media (max-width: 1024px) {
  .chatLayout {
    grid-template-columns: 260px 1fr;
  }
}

@media (max-width: 768px) {
  .chatLayout {
    grid-template-columns: 1fr;
  }
}
```

Create additional CSS files for each component following the existing patterns in `apps/web/app/styles/`.

---

## Part 6: Testing

### 6.1 Unit Tests

Create `apps/api/test/chat.spec.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handleChatMessage } from "../src/handlers/chat";

describe("handleChatMessage", () => {
  it("should reject missing conversationId", async () => {
    const request = new Request("https://api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hello" }),
    });

    const response = await handleChatMessage(request, mockEnv, mockContext);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Missing conversationId");
  });

  it("should return SSE content-type", async () => {
    const request = new Request("https://api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "test-id",
        message: "hello",
      }),
    });

    const response = await handleChatMessage(request, mockEnv, mockContext);

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });
});
```

### 6.2 Integration Tests

```typescript
describe("Chat E2E", () => {
  it("should stream a response", async () => {
    // This test requires INTEGRATION_TESTS_ENABLED=true
    // because it hits live Workers AI

    const response = await fetch(`${API_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: testUserCookie,
      },
      body: JSON.stringify({
        conversationId: crypto.randomUUID(),
        message: "What matters do I have?",
      }),
    });

    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    // Collect all SSE events
    const events: string[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      events.push(decoder.decode(value));
    }

    // Should have at least process events and a done event
    const allText = events.join("");
    expect(allText).toContain("event: process");
    expect(allText).toContain("event: done");
  });
});
```

### 6.3 Manual Testing Checklist

- [ ] New conversation creates UUID and navigates
- [ ] First message creates conversation record
- [ ] Messages stream character by character
- [ ] Process log shows RAG, LLM, Clio steps
- [ ] Clio read queries work without confirmation
- [ ] Clio write shows confirmation card
- [ ] Accept confirmation executes and streams result
- [ ] Reject confirmation shows cancellation message
- [ ] Conversation list updates after messages
- [ ] Selecting conversation loads history
- [ ] Delete conversation removes from list
- [ ] Multiple tabs don't interfere with each other
- [ ] Error states display appropriately

---

## Part 7: Key Concepts Recap

### 7.1 Why This Architecture?

1. **Durable Objects for isolation** — Each org's data lives in its own DO. Cross-org access is impossible by design.

2. **SSE over WebSockets** — Simpler, automatic reconnection, native HTTP. Perfect for unidirectional streaming.

3. **Channel-agnostic DO** — The same `handleProcessMessage` logic works for web, Teams, Slack. Only the adapter changes.

4. **Client-generated conversation IDs** — Eliminates a round-trip. The client knows the ID before the server creates the record.

5. **Pending confirmations in SQLite** — Survives page refreshes. User can come back later and still confirm/reject.

### 7.2 Security Considerations

- **Auth happens at the Worker** — DO trusts that the Worker validated the session
- **Org ID comes from DO identity** — Not from the request payload
- **User can only see their conversations** — Queries filter by `user_id`
- **Clio operations require role check** — Members can't write, even if they try

### 7.3 Performance Considerations

- **`waitUntil` for streaming** — Don't block the response while processing
- **Limit conversation history** — Last 15 messages, not entire history
- **RAG token budget** — 3000 tokens max to leave room for response
- **DO alarms for cleanup** — Archive old conversations, don't let SQLite grow unbounded

---

## Next Steps

After completing Phase 9b:

1. **Update `/dashboard` route** — Redirect to `/chat` if user has org
2. **Add chat link to sidebar** — In `AppLayout.tsx`
3. **Polish mobile experience** — Collapsible sidebar, swipe gestures
4. **Add typing indicators** — Show when bot is "typing"
5. **Implement conversation search** — Full-text search in messages

Then proceed to Phase 10 (Teams Adapter) which reuses all the DO logic you just built.
