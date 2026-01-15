# Docket: A Case Study in Spec-Driven AI Product Development

## Executive Summary

Docket is a multi-tenant AI assistant for law firms using Clio (legal practice management software). This case study examines how a simple thesis—that AI can delegate expert knowledge through documented systems—evolved into a production-grade legal AI platform built on Cloudflare's edge infrastructure.

**Core Thesis:** Industry knowledge base + practical API calls + organizational context = delegatable expertise.

---

## Part 1: Origin Story

### 1.1 The E-Myth Revelation

Docket began as a collaboration with Joe, a tech-savvy friend who runs a nonprofit fundraising agency. We both read "The E-Myth" by Michael Gerber around the same time and were completely enthralled.

Gerber's thesis: most small businesses need another version of yourself to run. Your ultimate goal is to remove yourself from the business. Small business owners struggle with becoming too tightly absorbed within their own operations. The E-Myth system is tightly documenting everything you do, identifying what can be delegated, identifying what is needless, and then focusing on how to delegate those roles.

When Gerber wrote the book in 1998, delegation meant hiring people. Having an assistant to read and revise all your emails included the overhead of at least a part-time employee. Reading this book in 2024 expands the possibilities. Now that's available for free on ChatGPT. Take it another layer deeper and we have agentic engineers working on replacing entire software teams.

### 1.2 Joe's Knowledge Base

Joe spent a year meticulously documenting everything he does, recording it in a 20,000-word organized knowledge base. He came to me with this documentation and we started working on implementing a chatbot that:

- Pulls from the knowledge base (industry expertise)
- Connects directly to the Salesforce API (practical operations)
- Pulls from organizational context that users share about their company (firm-specific rules)

Research from working with Joe revealed something critical: every company he works with has their own set of organizational rules. How would you define what is fundraising? How would you define what is a large donor? How would you describe when to reengage? These are Joe's best practices, not the best practices you'll find in a textbook. Joe also has his own set of rules—how to format and date a document.

**The formula emerged: Industry Knowledge Base + Practical API Calls + Organizational Context.**

### 1.3 First Iteration: The Salesforce Bot

Joe's documentation was wonderful, and even formatted for RAG really well. I built out a chatbot that connected to Slack and could communicate through RAG and vector embeddings.

This was my first introduction to Cloudflare architecture.

**What I Learned:**

Durable Objects are stateful storage objects delivered by Cloudflare. I chose them over other storage options because the idea that each tenant would have their own object to work out of was very appealing. Durable Objects are like a blender of different storage types—D1 database, R2 storage buckets, vectorized database, alarms, and seamless connection to Workers.

The FundraisingAgent DO sets up one instance per tenant (nonprofit org looking for fundraising):

- SQLite storage for structured data (conversations, confirmations, audit logs)
- KV storage for encrypted OAuth tokens
- In-memory cache for the Salesforce schema
- Channel-agnostic message processing

When a message from Slack is received, the Worker initially handles it. The Worker calls the FundraisingAgent DO which loads up from hibernating (if hibernating in the first place). The constructor runs, the schema creates all tables, the schemaCache loads all the Salesforce schema into memory, concurrency is blocked while everything is initializing, and then the tables and schema cache are fetched and ready to roll.

**Operations always appear in sequence.** This is the magic of Durable Objects.

### 1.4 User Feedback

Users thought it was extremely interesting, but it needed a lot of refinement. The knowledge base was incomplete and the Salesforce API calls were functional but did not work as well as expected.

One quote stuck with me:

> "Now you can get rid of the middle man, be it a developer or a content editor, and screw your site up totally by yourself. You'll just have to get used to describing things in a very specific way to get what you want, which will take up all of your time. It'll produce poorer results, and you have nobody to blame. Please take my money."

People were excited. The solution forward seemed to niche down, create a separate CMS tightly coupled with the chatbot AI functionalities.

**Initial results were impressive but impractical. Looking for ways to improve and learn from it.**

---

## Part 2: Pivot to Legal

### 2.1 Applying the Pattern

The project with Joe ended. I took his hypothesis and started thinking about ways to apply this "industry knowledge base + practical API calls + organizational context" formula to other domains.

Legal work emerged as the target. Law firms using Clio (legal practice management software) face the same documentation and delegation challenges Joe faced with Salesforce.

### 2.2 Deep Dive on Cloudflare AI Architecture

I became obsessed with Cloudflare after working on the personal project. The architecture enables:

- **Edge-first deployment** — Low latency for real-time chat
- **Stateful isolation** — One Durable Object per organization
- **Integrated AI** — Workers AI for LLM and embeddings without external API calls
- **Unified storage** — D1, R2, Vectorize, DO SQLite all working together

The Durable Object model was particularly compelling for legal:

- Each law firm gets isolated state
- Conversations and operations maintain sequence
- Audit trails are natural (every operation flows through the DO)
- OAuth tokens stay encrypted per-tenant

### 2.3 Multi-Channel Philosophy

The multichannel architecture exists so users' Durable Objects maintain state between Slack, Teams, and MCP calls (ChatGPT/Claude Desktop). But more importantly, it maintains flexibility so end users can be "met where they like to be."

Users do not need to download an app. They just need their typical ChatGPT/Slack/Teams workflow and all Tenant DOs are modified appropriately. Unified messages make the medium of interaction agnostic.

A message from Slack goes through the SlackBot UI and is received by a webhook set up in the workspace. The Slack Channel adapter extracts the message to the unified format for Durable Object processing. The adapter handles webhook verification, event routing, and response formatting.

The web chatbot wasn't the original plan, but development was taking longer and I wanted something frictionless for users to test with.

### 2.4 Legal Consciousness

Legality was staring me down throughout the process. I considered legal structures throughout but didn't really act upon it other than writing. Fair to say I was conscious of it and knew it wouldn't be a cakewalk.

Key constraints I held in mind:

- **Attorney-client privilege** — Conversations may be privileged
- **Unauthorized practice of law (UPL)** — The bot cannot give legal advice
- **Malpractice liability** — Errors have real consequences
- **Data residency** — Some firms have jurisdiction requirements
- **Audit requirements** — Every operation must be traceable

---

## Part 3: Spec-Driven Development

### 3.1 Documentation Philosophy

Following the E-Myth principle, Docket uses a rigorous documentation-first approach. Numbered specification documents serve as the source of truth. Lower-numbered documents take precedence over higher-numbered ones.

**Document Hierarchy:**

```
00-devlog.md       → Running development log
00-overview.md     → Core product vision (highest authority)
01-user-flows.md   → User journeys and permissions
02-technical-foundation.md → Architecture decisions
...
13-clio-schema-generator.md → Latest implementation details
```

Each document follows a strict format: problem statement, constraints, solution, and explicit trade-offs.

### 3.2 Phase-Based Implementation

Development proceeds through 14 discrete phases, each with explicit completion criteria:

| Phase | Focus | Status |
| ----- | ----- | ------ |
| 1 | Validate Plan | 20% |
| 2 | Accounts & Init | 100% |
| 3 | Storage Layer | 100% |
| 4 | Auth Foundation | 100% |
| 5 | Knowledge Base | 100% |
| 6 | Core Worker + DO | 100% |
| 7 | Workers AI + RAG | 100% |
| 8 | Clio Integration | 100% |
| 9 | Website MVP | 100% |
| 9b | Web Chat | 100% |
| 10 | Teams Adapter | 0% |
| 11 | Production Hardening | 0% |
| 12 | Compliance Review | 0% |
| 13 | Teams App Store | 0% |
| 14 | MCP Channel | 0% |

**Completion Criteria Pattern:**

Each phase requires:

1. Simple unit tests (fast, local)
2. Integration tests (live bindings)
3. E2E tests (full workflow)
4. Interactive demo endpoint for stakeholder validation

### 3.3 Demo-Driven Validation

Rather than fragile E2E test suites, each phase ships interactive `/demo/*` endpoints:

- `/demo/storage` — D1 tables, permissions, R2, Vectorize
- `/demo/auth` — Signup, verification, password reset
- `/demo/kb` — Upload documents, test RAG retrieval
- `/demo/clio` — Sandbox Clio API calls

Stakeholders validate real workflows without running local development environments.

### 3.4 Code Philosophy

From the project's CLAUDE.md:

> "Omit needless code. A file should have no unnecessary functions. Vigorous writing is concise. A line should contain no unnecessary characters, a file no unnecessary functions, for the same reason that a drawing should have no unnecessary lines and a machine no unnecessary parts."

---

## Part 4: Technical Architecture

### 4.1 The Durable Object Model

Each law firm gets an isolated DO instance identified by `orgId`. The DO manages:

- Conversations and message history (SQLite)
- Pending CUD confirmations
- Clio custom field schema cache
- Encrypted OAuth tokens (KV storage)
- Audit logging

**Constructor Pattern:**

```typescript
constructor(ctx: DurableObjectState, env: Env) {
  this.orgId = ctx.id.toString();

  ctx.blockConcurrencyWhile(async () => {
    await this.runMigrations();
    await this.loadSchemaCache();
    await this.ensureAlarmIsSet();
  });
}
```

`blockConcurrencyWhile()` ensures operations appear in sequence. This is critical for legal compliance—you need to know exactly what happened and when.

### 4.2 Two-Tier Storage (Underselling It)

The system uses D1, DO SQLite, Vectorized databases, R2 storage buckets, and more to separate and maintain consistency and latency for each Durable Object.

| Store | Scope | Contents |
| ----- | ----- | -------- |
| D1 | Global | Auth, org registry, KB chunks, invitations |
| DO SQLite | Per-Org | Conversations, messages, confirmations |
| DO KV | Per-Org | Encrypted Clio tokens |
| R2 | Per-Org | Documents, audit logs, archived conversations |
| Vectorize | Global | Embeddings with org_id metadata filter |

### 4.3 Token Encryption Strategy

The encryption uses PBKDF2 which is designed to prevent brute force attacks by encrypting with the user password, tenant ID, and master secret. This makes it so if any single point of failure occurs (tenant org hacked, master secret discovered, encryption strategy reverse engineered), it's impossible to break the encryption without knowing all three points of attack.

The tenant ID is unique to each organization.

If I lose the `MASTER_ENCRYPTION_SECRET`, I would need to revalidate every single user password because every single encryption is tied to it.

### 4.4 Channel Adapter Architecture

All channels translate to a unified `ChannelMessage`:

```typescript
interface ChannelMessage {
  channel: "teams" | "slack" | "mcp" | "web";
  orgId: string;
  userId: string;
  userRole: "admin" | "member";
  conversationId: string;
  conversationScope: "personal" | "groupChat" | "teams" | "dm" | "channel" | "api";
  message: string;
  jurisdictions: string[];
  practiceTypes: string[];
  firmSize: "solo" | "small" | "mid" | "large" | null;
}
```

The Slack webhook verification works by using the Slack Events API (HTTP version). The server receives a trigger that the event occurred, receives a JSON payload from Slack with message information, acknowledges receipt, and then the Durable Object makes a business decision based on the message (fire a tool, access the knowledge base, etc).

---

## Part 5: AI Architecture

### 5.1 The Formula Applied

**Industry Knowledge Base:** Clio workflows, billing guidance, practice management best practices, deadline calculations.

**Practical API Calls:** Read matters, create tasks, update contacts, query calendar entries—all through Clio's API.

**Organizational Context:** Firm-specific templates, procedures, engagement letters, billing rates, staff routing preferences.

### 5.2 Single Tool Pattern

A critical architectural decision from the first iteration: rather than multiple tools (one per API operation), the LLM receives a single `clioQuery` tool with structured parameters:

```typescript
clioQuery({
  operation: "read" | "create" | "update" | "delete",
  objectType: "Matter" | "Contact" | "Task" | ...,
  id?: string,
  filters?: object,
  data?: object
})
```

**Benefits:**

1. Eliminates tool selection variance
2. Enforces structured parameters (prevents prompt injection)
3. Single validation point
4. Deterministic behavior

This pattern emerged from the Salesforce bot: multiple tools caused unpredictable tool selection, leading to user confusion.

### 5.3 CUD Confirmation Flow

All Create, Update, Delete operations require explicit user confirmation:

1. LLM returns CUD request → DO stores pending confirmation (24-hour TTL)
2. Human-readable summary → "Create Task: 'Review Contract' for Smith v. Jones?"
3. User responds → LLM classifies as approve/reject/modify/unrelated
4. Execution → Result logged to audit trail

This satisfies the legal requirement that humans authorize changes to case data.

### 5.4 RAG Pipeline

**Two parallel Vectorize queries (same embedding):**

1. Shared KB with metadata filters (category, jurisdiction, practice type, firm size)
2. Org Context filtered by `org_id`

Vectorize lacks `$or` support, so filtering requires parallel queries merged and deduped by score.

**Token Budget:** ~3,000 tokens for RAG context. Chunks exceeding budget are dropped by score, with overflow logged.

### 5.5 Context Window Management

With 128K tokens available, Docket uses ~10K:

| Component | Tokens | Purpose |
| --------- | ------ | ------- |
| System prompt | 500 | Instructions + persona |
| Clio Schema | 1,500 | Object definitions |
| KB Context | 1,500 | Shared knowledge base |
| Org Context | 1,500 | Organization documents |
| Conversation | 3,000 | Last 15 messages |
| Response buffer | 2,000 | Max output |

Conservative allocation prevents overflow while leaving room for expansion.

---

## Part 6: Trust, Safety & Compliance

### 6.1 Legal AI Constraints

The system prompt enforces:

> "NEVER give legal advice—you manage cases, not law."

But prompt instructions aren't sufficient. Additional safeguards:

- **Audit logging** — Every Clio operation logged with user, timestamp, params, result
- **Confirmation gates** — CUD operations require explicit human approval
- **Source attribution** — RAG chunks include source for traceability
- **Role-based permissions** — Members can read, only admins can write

### 6.2 Data Classification

- **Public** — Shared KB (no tenant restrictions)
- **Internal** — Org registry, permissions
- **Confidential** — User accounts, OAuth tokens
- **Privileged** — Conversations, Clio operations, audit logs

### 6.3 Identified Gaps (Phase 12)

- Data retention policy for legal ethics
- Breach notification procedures
- Attorney-client privilege marking on conversations
- Conflict of interest detection
- GDPR data portability
- UPL technical enforcement beyond prompts

---

## Part 7: Business Model

### 7.1 Pricing Strategy

- **Organization-based** — Pricing tied to org, not individual users
- **Tier-based** — Different tiers allow different numbers of Admins and Members

### 7.2 Channel Strategy

- **Teams** — Enterprise channel, requires app store listing
- **MCP** — Developer hook for Claude Desktop / Cursor users
- **Web** — Frictionless testing, no installation required
- **Slack** — Planned for teams not on Microsoft stack

### 7.3 Go-to-Market

The solution forward seems to niche down. Create a tightly coupled experience where the knowledge base, API integration, and organizational context work seamlessly together.

Passively seeking a partner to help create a larger knowledge base covering more jurisdictions and practice areas.

---

## Part 8: Lessons Learned

### 8.1 From the First Iteration

1. **Running software through chat apps works** — Users don't need a new app
2. **The architecture scales** — Channel Adapters → Workers → Vector DB → RAG → DOs
3. **Structured parameters prevent non-determinism** — LLMs picking tools is unreliable
4. **Single tool is more reliable than multiple tools** — Funnel everything through one interface

### 8.2 Development Patterns That Worked

1. **Lower-numbered docs as source of truth** — Prevents specification drift
2. **Demo endpoints over E2E tests** — Stakeholders validate real workflows
3. **Explicit trade-off documentation** — Every decision has recorded rationale
4. **Known issues upfront** — No surprises during implementation
5. **Graceful degradation** — Empty context > complete failure

### 8.3 What's Next

Initial results were impressive but impractical. Looking for ways to improve:

- More complete knowledge base
- Better Clio API call reliability
- Deeper integration with firm workflows
- Legal structure clarity

---

## Appendix A: Data Flow

```
User Message
    │
    ▼
┌─────────────────┐
│ Channel Adapter │ ─── Teams/Slack/MCP/Web
└────────┬────────┘
         │ ChannelMessage (unified format)
         ▼
┌─────────────────┐
│    Worker       │ ─── Route to org's DO
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   TenantDO      │ ─── Per-org isolation
├─────────────────┤
│ 1. Store msg    │
│ 2. Check pending│
│ 3. Generate emb │
│ 4. Query RAG    │ ←── Vectorize (KB + Org Context)
│ 5. Build prompt │
│ 6. Call LLM     │ ←── Workers AI
│ 7. Handle tool  │ ←── Clio API
│ 8. Store resp   │
│ 9. Audit log    │ ──► R2
└────────┬────────┘
         │
         ▼
    Response/Stream
```

---

## Appendix B: Technology Stack

**Runtime:**

- Cloudflare Workers (API + Web)
- Durable Objects (per-org state)
- D1 (SQLite database)
- R2 (object storage)
- Vectorize (vector database)
- Workers AI (LLM + embeddings)

**Frontend:**

- React 19
- React Router 7 (SSR)
- CSS Modules

**Development:**

- npm workspaces (monorepo)
- TypeScript (strict)
- Vitest (unit + integration)
- Wrangler (deployment)
- GitHub Actions (CI)

**External Integrations:**

- Clio API (legal practice management)
- Better Auth (authentication)
- Microsoft Teams (channel, planned)
- Slack (channel, planned)

---

## Appendix C: Cost Model

**Estimated: ~$8 per 500 messages**

| Service | Usage | Est. Cost |
| ------- | ----- | --------- |
| Workers | 500 requests | $0.00 |
| Durable Objects | 500 requests + storage | $0.08 |
| D1 | 2,500 reads, 500 writes | $0.01 |
| Vectorize | 500 queries | $0.03 |
| Workers AI | ~5M tokens | $1.50 |
| R2 | 500 objects | $0.01 |

---

*This case study documents the Docket project as of January 2026. Architecture and patterns continue to evolve.*
