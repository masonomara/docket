# Phase 9b: Web Chat Interface Tutorial

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

### 3.1 Add Streaming Message Processing

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

### 3.2 Add Conversation Query Endpoints

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

### 4.1 Create the Chat Route

Create `apps/web/app/routes/chat.tsx`:

- Chat should be a page like Knowledge base and Clio connection are.
- Should replace dashbaord on the sidebar for users who have an org.

Structure:

- Loader fetches initial data:
  - User and org info (for auth/nav)
  - List of conversations (for sidebar)
  - Current conversation if URL has conversationId
- The useChat hook manages:
  - SSE connection
  - Message state
  - Process log events
  - Pending confirmations
- Handle new chat creation
- Handle conversation selection from sidebar
- Handle message send
  - Create new conversation on first message
  - Refresh conversations list
  - Handle conversation deletion
- Left column: Conversation list
- Center column: Chat messages
- Right column: Process log

### 4.2 The useChat Hook

Create `apps/web/app/lib/use-chat.ts`:

- Custom hook for managing chat state and SSE streaming.
  - This is the core of the chat interface. It handles:
    1. Sending messages via POST and receiving SSE responses
    2. Parsing SSE events and updating UI state
    3. Managing pending Clio confirmations
    4. Loading existing conversations
  - Keep track of the current streaming message
  - Sends a message and handles the SSE response stream.
    - Add user message immediately
    - Create placeholder for assistant response
    - Handle SSE stream
    - Parse SSE events from buffer
    - Mark message as complete
    - Mark message as error
  - Parses SSE events from a buffer string.
    - Check if this is the last incomplete line
      - Empty line = end of event
  - Handles a single SSE event, updating appropriate state.
    - Append content to the streaming message
    - Add to process log
    - Store pending confirmation
    - Stream complete
  - Accepts a pending Clio confirmation.
    - Handle the response stream (same as sendMessage)
    - ... same streaming logic as sendMessage
  - Rejects a pending Clio confirmation.
    - Add cancellation message
    - Loads an existing conversation's messages.
  - Load conversation
    - Load any pending confirmations

### 4.3 Chat Components

Create `apps/web/app/components/ChatSidebar.tsx`

Create `apps/web/app/components/ChatMessages.tsx`:

- Auto-scroll to bottom on new messages
- Show when bot is "typing"

Create `apps/web/app/components/ChatInput.tsx`:

- Auto-resize textarea
  - Submit on Enter (without Shift)

Create `apps/web/app/components/ProcessLog.tsx`:

- Show events chronologically

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
