# Phase 9b: Web Chat Interface

## Overview

Build a web chat interface for Docket. Users chat with the bot through a three-column layout: conversation list, message area, and process log. Messages stream via Server-Sent Events (SSE). Clio write operations require inline confirmation.

The architecture:

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

## Part 1: Database Migration

Web chat requires `user_id` and `title` on conversations for per-user filtering, and `status` on messages for error handling. These tables live in the DO's SQLite (not D1), so update `runMigrations()` in `apps/api/src/do/tenant.ts`.

Add v2 migration after the v1 block:

```typescript
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
```

Update the early return check from `currentVersion >= 1` to `currentVersion >= 2`.

The migration runs automatically when the DO is accessed—no wrangler command needed.

---

## Part 2: API Layer

### 2.1 Create Chat Handler

Create `apps/api/src/handlers/chat.ts`:

**`handleChatMessage`** — POST /api/chat (SSE streaming)
- Parse request body: `{ conversationId: string, message: string }`
- Validate `conversationId` is UUID format, `message` is 1-10000 chars
- Build `ChannelMessage` from authenticated context:
  - `channel`: `"web"`
  - `orgId`: from middleware context
  - `userId`: from session
  - `userRole`: from org membership
  - `conversationId`: from request
  - `conversationScope`: `"personal"`
  - `jurisdictions`, `practiceTypes`, `firmSize`: from org settings in D1
- Get org's Durable Object via `env.TENANT.idFromName(orgId)`
- Forward to DO's `/process-message-stream` endpoint
- Return SSE response with headers:
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`

**`handleGetConversations`** — GET /api/conversations
- Get user's conversations from DO via `/conversations?userId={userId}`
- Return `{ conversations: [{ id, title, updatedAt, messageCount }] }`

**`handleGetConversation`** — GET /api/conversations/:id
- Get single conversation with messages from DO via `/conversation/{id}?userId={userId}`
- Return `{ conversation, messages, pendingConfirmations }`

**`handleDeleteConversation`** — DELETE /api/conversations/:id
- Delete conversation via DO `/conversation/{id}?userId={userId}` DELETE
- Return `{ success: true }`

**`handleAcceptConfirmation`** — POST /api/confirmations/:id/accept
- Forward to DO `/confirmation/{id}/accept` with `userId`
- Return SSE stream with operation result

**`handleRejectConfirmation`** — POST /api/confirmations/:id/reject
- Forward to DO `/confirmation/{id}/reject` with `userId`
- Return `{ success: true }`

### 2.2 Helper: Get Org Settings

Create a helper to fetch org settings from D1 for the ChannelMessage:

```typescript
async function getOrgSettings(db: D1Database, orgId: string) {
  const org = await db
    .prepare("SELECT jurisdictions, practice_types, firm_size FROM org WHERE id = ?")
    .bind(orgId)
    .first<{ jurisdictions: string; practice_types: string; firm_size: string | null }>();

  if (!org) return null;

  return {
    jurisdictions: JSON.parse(org.jurisdictions || "[]"),
    practiceTypes: JSON.parse(org.practice_types || "[]"),
    firmSize: org.firm_size as FirmSize | null,
  };
}
```

### 2.3 Register Routes

Update `apps/api/src/index.ts`:

**Static routes:**
- `"/api/chat"`: `{ POST: withMember(handleChatMessage) }`
- `"/api/conversations"`: `{ GET: withMember(handleGetConversations) }`

**Dynamic routes in `matchDynamicRoute`:**
- `/api/conversations/:id` GET → `handleGetConversation`
- `/api/conversations/:id` DELETE → `handleDeleteConversation`
- `/api/confirmations/:id/accept` POST → `handleAcceptConfirmation`
- `/api/confirmations/:id/reject` POST → `handleRejectConfirmation`

---

## Part 3: Durable Object Streaming

### 3.1 Add Streaming Message Endpoint

Add to `TenantDO.fetch()` router:

```typescript
case "/process-message-stream":
  return this.handleProcessMessageStream(request);

case "/conversations":
  return this.handleGetConversations(request);

case `/conversation/${url.pathname.split("/")[2]}`:
  if (request.method === "DELETE") {
    return this.handleDeleteConversation(request, url.pathname.split("/")[2]);
  }
  return this.handleGetConversation(request, url.pathname.split("/")[2]);

case `/confirmation/${url.pathname.split("/")[2]}/accept`:
  return this.handleAcceptConfirmation(request, url.pathname.split("/")[2]);

case `/confirmation/${url.pathname.split("/")[2]}/reject`:
  return this.handleRejectConfirmation(request, url.pathname.split("/")[2]);
```

### 3.2 Streaming Message Handler

**`handleProcessMessageStream`** — Returns SSE stream instead of JSON:

- Parse and validate `ChannelMessage` (same as existing `handleProcessMessage`)
- Verify org ID matches DO identity
- Create `ReadableStream` with `TransformStream` pattern
- Start async processing in background via `waitUntil()`
- Return Response with SSE headers immediately

**SSE Event Emitter:**

```typescript
function createSSEStream() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const emit = async (event: string, data: unknown) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };

  const close = async () => {
    await writer.close();
  };

  return { readable, emit, close };
}
```

**Processing Flow:**

- Emit `process` event: `{ type: "started" }`
- Ensure conversation exists, set `user_id` and `title` if new
- Store user message with `status: 'complete'`
- Check for pending confirmation
- If pending: classify response and handle
- Else: generate assistant response with streaming
- Store assistant message
- Emit `done` event
- Close stream

### 3.3 Streaming Response Generation

Modify `generateAssistantResponse` to accept an emit function:

**`generateAssistantResponseWithStream`:**

- Emit `process` event: `{ type: "rag_lookup", status: "started" }`
- Retrieve RAG context (KB + Org Context)
- Emit `process` event: `{ type: "rag_lookup", status: "complete", chunks: [...] }`
- Build system prompt
- Emit `process` event: `{ type: "llm_thinking", status: "started" }`
- Call LLM with tools
- If LLM returns tool calls:
  - Emit `process` event: `{ type: "clio_call", operation, objectType }`
  - Handle tool call (may create confirmation)
  - Emit `process` event: `{ type: "clio_result", ... }` or `confirmation_required`
- Emit `content` events as response chunks
- Return final response string

### 3.4 Conversation Query Endpoints

**`handleGetConversations`:**
- Extract `userId` from query params
- Query: `SELECT id, title, updated_at, (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as messageCount FROM conversations c WHERE user_id = ? AND channel_type = 'web' ORDER BY updated_at DESC LIMIT 50`
- Return JSON response

**`handleGetConversation`:**
- Extract `userId` from query params, `conversationId` from path
- Verify ownership: `WHERE id = ? AND user_id = ?`
- Get messages: `SELECT id, role, content, created_at, status FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
- Get pending confirmations: `SELECT * FROM pending_confirmations WHERE conversation_id = ? AND user_id = ? AND expires_at > ?`
- Return combined JSON response

**`handleDeleteConversation`:**
- Verify ownership before delete
- Delete messages first (foreign key)
- Delete pending confirmations
- Delete conversation
- Return success

### 3.5 Confirmation Endpoints

**`handleAcceptConfirmation`:**
- Extract `confirmationId` from path, `userId` from body
- Look up confirmation, verify user owns it
- Execute the confirmed Clio operation
- Return SSE stream with result
- Emit audit log

**`handleRejectConfirmation`:**
- Extract `confirmationId` from path, `userId` from body
- Delete the confirmation
- Return `{ success: true }`

### 3.6 Update Conversation Creation

Modify `ensureConversationExists` to handle web channel:

- On INSERT, if `channel === 'web'`:
  - Set `user_id` from message
  - Set `title` from first message (truncated to 50 chars + ellipsis if longer)
- On UPDATE, update `updated_at` timestamp

---

## Part 4: SSE Event Types

Define the SSE event contract between server and client:

**`content`** — Assistant response text chunk
```json
{ "text": "Here are your open matters..." }
```

**`process`** — Internal processing step visibility
```json
{ "type": "rag_lookup", "status": "started" }
{ "type": "rag_lookup", "status": "complete", "chunks": [{ "text": "...", "source": "..." }] }
{ "type": "llm_thinking", "status": "started" }
{ "type": "clio_call", "operation": "read", "objectType": "Matter", "filters": {...} }
{ "type": "clio_result", "count": 5, "preview": [...] }
```

**`confirmation_required`** — Clio write needs approval
```json
{
  "confirmationId": "uuid",
  "action": "create",
  "objectType": "Task",
  "params": { "name": "Draft motion", "due_at": "..." }
}
```

**`error`** — Processing error
```json
{ "message": "Clio API unavailable" }
```

**`done`** — Stream complete (no data)

---

## Part 5: Frontend

### 5.1 Create Chat Route

Create `apps/web/app/routes/chat.tsx`:

**Loader:**
- Use `orgLoader` (requires org membership)
- Fetch conversations list via `/api/conversations`
- Return `{ user, org, conversations }`

**Component:**
- Three-column grid layout
- Left: `ChatSidebar` with conversation list
- Center: `ChatMessages` with current conversation
- Right: `ProcessLog` with step visibility
- State: current conversation ID, messages, process events, pending confirmations

**Handlers:**
- `handleNewChat`: Generate UUID, navigate to `/chat/{id}`
- `handleSelectConversation`: Fetch messages, update state
- `handleSendMessage`: POST to `/api/chat`, parse SSE stream
- `handleAcceptConfirmation`: POST to `/api/confirmations/{id}/accept`
- `handleRejectConfirmation`: POST to `/api/confirmations/{id}/reject`
- `handleDeleteConversation`: DELETE `/api/conversations/{id}`, refresh list

### 5.2 Create Chat Route with ID

Create `apps/web/app/routes/chat.$conversationId.tsx`:

- Same as `chat.tsx` but loads specific conversation on mount
- Fetch conversation messages in loader if `conversationId` provided

### 5.3 useChat Hook

Create `apps/web/app/lib/use-chat.ts`:

**State:**
- `messages`: Array of `{ id, role, content, status, createdAt }`
- `processEvents`: Array of process log entries
- `pendingConfirmations`: Array of awaiting confirmations
- `isStreaming`: Boolean for loading state
- `error`: Error message if any

**`sendMessage(conversationId, message)`:**
- Add user message to state immediately (optimistic)
- Create placeholder assistant message with `status: 'streaming'`
- POST to `/api/chat` with fetch
- Parse SSE stream:
  - On `content`: Append text to streaming message
  - On `process`: Add to process events
  - On `confirmation_required`: Add to pending confirmations, disable input
  - On `error`: Update streaming message status to `'error'`
  - On `done`: Mark streaming message as `'complete'`
- On stream close: Finalize state

**`acceptConfirmation(confirmationId)`:**
- POST to `/api/confirmations/{id}/accept`
- Parse SSE stream same as `sendMessage`
- Remove confirmation from pending list

**`rejectConfirmation(confirmationId)`:**
- POST to `/api/confirmations/{id}/reject`
- Remove confirmation from pending list
- Add cancellation message to chat

**`loadConversation(conversationId)`:**
- GET `/api/conversations/{id}`
- Set messages, pendingConfirmations from response
- Clear process events

**SSE Parsing:**
```typescript
async function parseSSE(
  response: Response,
  onEvent: (event: string, data: unknown) => void
) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = "";
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7);
      } else if (line.startsWith("data: ") && currentEvent) {
        try {
          const data = JSON.parse(line.slice(6));
          onEvent(currentEvent, data);
        } catch {}
        currentEvent = "";
      }
    }
  }
}
```

### 5.4 Chat Components

**`ChatSidebar.tsx`:**
- Props: `conversations`, `currentId`, `onSelect`, `onNew`, `onDelete`
- "New Chat" button at top
- Conversation list sorted by `updatedAt` DESC
- Each item shows title, relative time, message count
- Active conversation highlighted
- Delete button on hover (with confirmation)

**`ChatMessages.tsx`:**
- Props: `messages`, `isStreaming`, `pendingConfirmations`, `onAccept`, `onReject`
- Auto-scroll to bottom on new messages
- User messages aligned right, assistant aligned left
- Streaming message shows typing indicator
- Error messages styled distinctly
- Pending confirmations render as inline cards:
  ```
  ┌─────────────────────────────────────────┐
  │ Docketbot wants to create a Task        │
  │                                         │
  │ Matter: Smith v. Jones                  │
  │ Due: Tomorrow                           │
  │ Description: Draft motion               │
  │                                         │
  │ [Cancel]                    [Confirm]   │
  └─────────────────────────────────────────┘
  ```

**`ChatInput.tsx`:**
- Props: `onSend`, `disabled`, `placeholder`
- Textarea with auto-resize
- Submit on Enter (Shift+Enter for newline)
- Disabled while streaming or awaiting confirmation
- Submit button with loading state

**`ProcessLog.tsx`:**
- Props: `events`
- Show events chronologically
- Each event type has distinct styling:
  - `rag_lookup`: "Searching knowledge base..."
  - `llm_thinking`: "Thinking..."
  - `clio_call`: "Querying Clio: {objectType}..."
  - `clio_result`: "Found {count} results"
  - `confirmation_required`: "Awaiting confirmation..."

### 5.5 Update Sidebar Navigation

Modify `apps/web/app/components/AppLayout.tsx`:

- If user has org: Show "Chat" link instead of "Dashboard"
- Chat link goes to `/chat`
- Keep other org links (Clio, Knowledge Base, etc.)

### 5.6 Update API Endpoints

Add to `apps/web/app/lib/api.ts`:

```typescript
export const ENDPOINTS = {
  // ... existing
  chat: {
    send: "/api/chat",
    conversations: "/api/conversations",
    conversation: (id: string) => `/api/conversations/${id}`,
    acceptConfirmation: (id: string) => `/api/confirmations/${id}/accept`,
    rejectConfirmation: (id: string) => `/api/confirmations/${id}/reject`,
  },
} as const;
```

---

## Part 6: Styling

Use existing CSS classes from the project. Add minimal new styles for chat-specific layout.

Create `apps/web/app/styles/chat.css`:

```css
.chat-layout {
  display: grid;
  grid-template-columns: 280px 1fr 260px;
  height: 100vh;
  overflow: hidden;
}

.chat-sidebar {
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.chat-input-area {
  border-top: 1px solid var(--color-border);
  padding: 16px;
}

.process-log {
  border-left: 1px solid var(--color-border);
  overflow-y: auto;
  padding: 16px;
}

/* Responsive */
@media (max-width: 1024px) {
  .chat-layout {
    grid-template-columns: 260px 1fr;
  }
  .process-log {
    display: none;
  }
}

@media (max-width: 768px) {
  .chat-layout {
    grid-template-columns: 1fr;
  }
  .chat-sidebar {
    display: none;
  }
}
```

---

## Part 7: Testing

### 7.1 Unit Tests

Create `apps/api/test/chat.spec.ts`:

**`handleChatMessage`:**
- Rejects missing `conversationId`
- Rejects missing `message`
- Rejects message over 10000 chars
- Returns SSE content-type header
- Requires org membership (401 without session)

**`handleGetConversations`:**
- Returns empty array for user with no conversations
- Returns conversations sorted by `updatedAt` DESC
- Only returns user's own conversations

**`handleDeleteConversation`:**
- Returns 404 for non-existent conversation
- Returns 404 for conversation owned by different user
- Successfully deletes conversation and messages

### 7.2 Integration Tests

```typescript
describe("Chat E2E", () => {
  it("should stream a response", async () => {
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

    const events = await collectSSEEvents(response);
    expect(events).toContainEqual(expect.objectContaining({ event: "process" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "done" }));
  });

  it("should persist conversation", async () => {
    const conversationId = crypto.randomUUID();

    // Send first message
    await sendChatMessage(conversationId, "Hello");

    // Check conversation exists
    const listResponse = await fetch(`${API_URL}/api/conversations`, {
      headers: { Cookie: testUserCookie },
    });
    const { conversations } = await listResponse.json();

    expect(conversations).toContainEqual(
      expect.objectContaining({ id: conversationId })
    );
  });
});
```

### 7.3 Manual Testing Checklist

- [ ] New conversation creates UUID and navigates to `/chat/{id}`
- [ ] First message creates conversation record with title
- [ ] Messages stream character by character
- [ ] Process log shows RAG, LLM, Clio steps in real-time
- [ ] Clio read queries work without confirmation
- [ ] Clio write shows confirmation card inline
- [ ] Accept confirmation executes and streams result
- [ ] Reject confirmation shows cancellation message
- [ ] Conversation list updates after messages
- [ ] Selecting conversation loads history correctly
- [ ] Delete conversation removes from list
- [ ] Multiple browser tabs don't interfere
- [ ] Error states display appropriately
- [ ] Keyboard navigation works (Enter to send, Shift+Enter for newline)
- [ ] Responsive layout hides columns appropriately

---

## Part 8: Security Considerations

**Auth happens at the Worker:**
- All chat endpoints use `withMember` middleware
- DO trusts that Worker validated the session
- Org ID comes from middleware context, not request body

**User can only see their own conversations:**
- All queries filter by `user_id`
- Ownership verified before delete/view operations

**Clio operations require role check:**
- Members can only read
- Admins can write with confirmation
- DO enforces permissions, not just frontend

**Input validation:**
- Message length capped at 10000 chars
- ConversationId must be valid UUID
- All inputs validated with Zod schemas

---

## Part 9: Implementation Order

1. **DO Migration** — Add v2 migration to `runMigrations()` in `tenant.ts`
2. **DO Streaming** — Add `handleProcessMessageStream` and SSE helpers
3. **DO Conversation Endpoints** — Add query/delete handlers
4. **DO Confirmation Endpoints** — Add accept/reject handlers
5. **API Handlers** — Create `chat.ts` with all handlers
6. **API Routes** — Register routes in `index.ts`
7. **Frontend Types** — Add types for SSE events and chat state
8. **useChat Hook** — Implement SSE parsing and state management
9. **Chat Components** — Build sidebar, messages, input, process log
10. **Chat Route** — Wire everything together
11. **Styling** — Add chat-specific CSS
12. **Testing** — Unit tests, integration tests, manual verification
