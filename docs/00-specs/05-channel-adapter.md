# Docket Channel Adapter

**Channel Priority:** 1. Microsoft Teams, 2. MCP, 3. Slack, 4. ChatGPT, 5. Other

## Worker Routing Logic

Channel adapters handle transport-specific logic (Teams Bot Framework, MCP JSON-RPC, etc.) before data enters core logic (LLM + storage + Clio). Each channel has a custom adapter that translates requests to a unified format. This separation keeps core logic transport-agnostic and makes adding new channels (Email, SMS) straightforward.

The Durable Object (DO) request/response contract is handled by the Channel Adapter translating between channel-specific formats and the DO's unified format.

**Unified message format:**

DO Endpoint: `POST /process-message`

```ts
export interface ChannelMessage {
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
  // Org settings for KB filtering (from D1 org table)
  jurisdiction: string;
  practiceType: string;
  firmSize: "solo" | "small" | "mid" | "large";
  metadata?: {
    threadId?: string;
    teamsChannelId?: string;
    slackChannelId?: string;
  };
}
```

## Error Handling

**DO communication failure:** "I'm having trouble connecting. Please try again in a moment."

**Error from DO:** Actionable messages like:

- "Clio is currently unavailable"
- "Clio authentication failed"
- "Your login has expired. Please log in again: {oauth_link}"

## Microsoft Teams

Primary focus. Large market share in enterprise legal. Requires Microsoft app store approval. Data bound to workspace. Signals we understand enterprise legal, compliance, and security. Using CONVERSATIONAL BOT from Teams SDK (`@microsoft/teams-ai` v2).

**Conversation Scopes:**

- `personal` (1:1 chat, no @mention needed): Private case queries, Clio lookups
- `groupChat` (2+ users, @mention required): Team collaboration on matters
- `teams` (Channel-wide, @mention required): Firm-wide announcements, shared queries

Manifest declares supported scopes:

```json
{ "bots": [{ "scopes": ["personal", "groupChat", "team"] }] }
```

**Org Resolution:**

One user belongs to exactly one Docket org. Resolution path:

1. Extract `user.aadObjectId` from activity
2. Query D1: `user.aadObjectId` → `user_id` → `org_id` + `role`
3. Query D1: `org_id` → `jurisdiction` + `practice_type` + `firm_size` (for KB filtering)
4. For groupChat/teams: validate workspace is linked to user's org
5. Route to org's DO with `conversationId` from activity

**Conversation Isolation:**

Each `conversation.id` maintains isolated history. Bot responses in a channel draw only from that channel's history—never from user's personal chat or other channels. Privacy boundary is the conversation.

**@mention Handling:**

- `personal`: Bot receives all messages directly
- `groupChat`/`teams`: Bot receives only @mentioned messages. Activity includes `entities` array with mention data.

## MCP

Demonstrates utility to AI-native users. API-based. MCP is a protocol used by MCP Clients (Claude Desktop, Cursor, Windsurf). User configures MCP server once with Docket API key. Worker validates API key, looks up `user_id` + `org_id` + `role` in D1 before routing to DO. Signals we're AI-native and quick to try.

## Slack

Phase 2 priority. Similar structure to Teams with data bound to workspace. Similar implementation and use-case (albeit lower priority).

**Conversation Scopes:** Same isolation rules as Teams: history is per `conversationId`.

- DM maps to `conversationScope: "dm"`
- Channel maps to `conversationScope: "channel"`

**How Slack Works:** Slack message arrives with workspace context via Slack Events API. Slack webhook sends message to Worker. Verify signature and immediately return HTTP 200. Channel Adapter receives message, queries D1 for `user_id` → `org_id` + `role`, validates `slack_workspace_id` is linked to that org. Worker sends to DO with `conversationId`. DO executes Clio Query, Workers AI, and RAG, then replies via Slack Events API.

**Slack Requirements:**

- Slack signature verification uses `crypto.subtle.verify()` via Web Crypto API (not Node.js crypto)
- Track `event_id` in DO SQLite and skip already-processed events (Slack may retry)
- Cleanup old events (>30 days) via DO Alarm
- Slack Events API: 30,000 events per workspace per app per 60 minutes. Expected usage below this limit.
- Slack webhooks must receive HTTP 200 within 3 seconds or they retry (causing duplicates) and eventually disable endpoint if success rate drops below 5%. Use async acknowledgment: return 200 immediately, process via `waitUntil()`.
- During initial app configuration, Slack sends one-time verification. Echo back `challenge` value within 3 seconds.

## ChatGPT

API-based. Lower priority. Different from utility standpoint—auth required for implicit workspace context. MCP and Teams/Slack have context "hardcoded in". Auth via OAuth. Worker validates credentials, looks up `user_id`, `org_id`, and `role` in D1 before routing to DO. Signals we're AI-native and quick to try.
