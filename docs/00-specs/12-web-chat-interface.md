# Chat Interface (Phase 9b)

## Overview

Build a web chat interface for Docketbot. The "web" channel storage (conversations, messages, pending_confirmations) exists in DO SQLite. Add API endpoints and frontend.

## Storage

Conversations:

- Client generates UUID
- Stored in DO SQLite `conversations`
- Title: first user message, truncated to 50 characters
  - `title = userMessage.slice(0, 50) + (userMessage.length > 50 ? '...' : '')`
- Per-user, not per-org (matches Teams behavior)
  - `SELECT * FROM conversations WHERE userId = ? AND channel = 'web'`

Messages:

- Stored in DO SQLite `messages`
- Save user message before streaming starts
- Save assistant message after stream completes
- On error, save partial content with error flag
- Add `status: 'complete' | 'partial' | 'error'` column

Confirmations:

- Stored in DO SQLite `pending_confirmations`
- Clio writes (create, update, delete) require confirmation; reads do not
- 24-hour timeout; load pending confirmations with conversation history on return
- Process multiple confirmations sequentially
- Columns should include: `id`, `conversationId`, `action`, `objectType`, `params`, `status`, `createdAt`

## Frontend

Three-column layout:

```text
+------------------+------------------------+------------------+
| Conversations    | Chat                   | Process Log      |
| [New Chat]       |                        |                  |
| - Conv 1         | [Messages scroll]      | Step 1: RAG      |
| - Conv 2         |                        | Step 2: LLM      |
| - Conv 3         | [Input box]            | Step 3: Clio     |
+------------------+------------------------+------------------+
```

Styling:

- Use existing CSS classes.

Conversations:

- Client generates UUID and navigates to `/chat/${id}`.
- First message creates the conversation record via `ensureConversationExists`.

Process Log:

- Process event types:
  - `started` — Emitted when message processing begins
  - `rag_lookup` — `{ status, chunks?: [{ text, source }] }`
  - `llm_thinking` — `{ status }`
  - `clio_call` — `{ operation, objectType, filters? }`
  - `clio_result` — `{ count, preview }` (read) or `{ success }` (write)
  - `confirmation_required` — `{ confirmationId, action, objectType, params }`

Confirmations:

- Appear inline as message cards.
- Input disabled while pending.

```text
+------------------------------------------+
| Docketbot wants to create a Task         |
|                                          |
| Matter: Smith v. Jones                   |
| Due: Tomorrow                            |
| Description: Draft motion                |
|                                          |
| [Cancel]                    [Confirm]    |
+------------------------------------------+
```

## API

POST `/api/chat` — Send message (SSE streaming)

- Body: `{ conversationId: string, message: string }`

GET `/api/conversations` — List conversations

- Response: `{ conversations: [{ id, title, updatedAt, messageCount }] }`

GET `/api/conversations/:id` — Get conversation with messages

- Response: `{ conversation: { id, createdAt, updatedAt }, messages: [{ id, role, content, createdAt, status }] }`

DELETE `/api/conversations/:id` — Delete conversation

- Response: `{ success: true }`

POST `/api/confirmations/:id/accept` — Accept confirmation

- Response: SSE stream with operation result

POST `/api/confirmations/:id/reject` — Reject confirmation

- Response: `{ success: true }`

## SSE Events

Flow:

1. Stream emits `confirmation_required` with details
2. Stream emits `done`
3. User accepts or rejects via API
4. If accepted, new SSE stream returns result

Event types:

- `content` — `{ text: "Here are your open matters..." }`
- `process` — `{ type: "started" | "rag_lookup" | "llm_thinking" | "clio_call" | "clio_result", ... }`
- `confirmation_required` — `{ confirmationId, action, objectType, params }`
- `error` — `{ message: "Clio API unavailable" }`
- `done` — `{}`

All events include optional `requestId` for debugging.

## Authentication

All endpoints use existing Better Auth session middleware (`userId`, `orgId`, `role`).
