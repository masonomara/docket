# Chatbot Analysis & Testing Spec

## Executive Summary

After reviewing all numbered specs (00-13) and the chat implementation (`tenant.ts`, `chat.ts`, RAG services, and tool schemas), this document provides:

1. Tool inventory and gap analysis
2. Sample questions for testing response quality
3. Clio CRUD test cases
4. Recommendations for source weighting

---

## Current Architecture

### Data Sources (Priority Order in Current Implementation)

| Source                    | Purpose                                | When Used                   |
| ------------------------- | -------------------------------------- | --------------------------- |
| RAG (auto-injected)       | KB + Org Context chunks                | Every message (pre-fetched) |
| `clioQuery` tool          | Read/Create/Update/Delete Clio records | LLM-initiated               |
| `orgContextQuery` tool    | Search/list/get firm documents         | LLM-initiated               |
| `knowledgeBaseQuery` tool | Search shared KB                       | LLM-initiated               |

### Current Tools

```
1. clioQuery          - Clio CRUD operations
2. orgContextQuery    - Firm document search
3. knowledgeBaseQuery - Shared KB search
```

---

## Gap Analysis

### Tools: Do We Have Enough?

**Current state:** Three tools cover the core use cases. The architecture is sound.

**Missing capabilities:**

| Gap                    | Impact                                                        | Recommendation                                  |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| No date/time awareness | "Tasks due this week" fails without current date              | Inject `today: "2024-01-15"` into system prompt |
| No user context        | "My tasks" requires knowing user's Clio ID                    | Inject `clioUserId` when available              |
| No matter context      | "Add a task to the Smith case" requires matter lookup first   | Working as designed (LLM chains calls)          |
| No calendar synthesis  | "What's on my schedule today?" requires date + calendar query | Working as designed (LLM chains calls)          |

**Verdict:** Tool count is adequate. The gaps are context injection, not missing tools.

### System Prompt Gaps

Current prompt (`tenant.ts:619-684`) is missing:

1. **Current date/time** - Critical for "this week", "today", "overdue"
2. **User's Clio identity** - For "my matters", "my tasks"
3. **Explicit source hierarchy** - When to prefer which source

### RAG Weighting Problem

Current implementation in `applyTokenBudget()` (`rag-retrieval.ts:353-380`):

```typescript
// Process KB chunks first
for (const chunk of context.kbChunks) { ... }

// Then process org chunks with remaining budget
for (const chunk of context.orgChunks) { ... }
```

**Problem:** KB chunks always get priority. Org Context (firm-specific) may be more relevant.

**Current token budget:** 3,000 tokens (~12,000 chars)

---

## Recommendations

### 1. Inject Date Context

Add to system prompt construction:

```typescript
const today = new Date().toISOString().split('T')[0];
const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

// In prompt:
## Current Context
Today: ${today} (${dayOfWeek})
```

### 2. Inject User's Clio ID

When fetching Clio tokens, also store user's Clio account ID. Inject:

```typescript
## Current Context
Your Clio User ID: ${clioUserId || "Unknown - look up by name if needed"}
```

### 3. Rebalance RAG Priority

Change `applyTokenBudget()` to interleave sources by score:

```typescript
// Merge KB and Org chunks by score
const allChunks = [
  ...context.kbChunks.map((c) => ({ ...c, type: "kb" })),
  ...context.orgChunks.map((c) => ({ ...c, type: "org" })),
].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

// Take top chunks regardless of source
```

Or split budget 50/50:

```typescript
const kbBudget = budgetInChars * 0.5;
const orgBudget = budgetInChars * 0.5;
```

### 4. Clarify Source Hierarchy in Prompt

Add explicit decision guidance:

```
## When to Use What

1. **Firm-specific questions** (policies, procedures, templates):
   - First: Check Org Context below
   - Then: Use orgContextQuery tool if not found

2. **Clio how-to questions** (features, workflows):
   - First: Check Knowledge Base below
   - Then: Use knowledgeBaseQuery tool if not found

3. **Record lookup** (matters, contacts, tasks):
   - Use clioQuery tool

4. **Record modification** (create, update, delete):
   - Use clioQuery tool (admin only, requires confirmation)
```

---

## Sample Questions for Testing

### Category A: Knowledge Base Questions

These should be answered from KB without Clio calls.

| Question                                                             | Expected Behavior           | Source            |
| -------------------------------------------------------------------- | --------------------------- | ----------------- |
| "How do I create a new matter in Clio?"                              | Step-by-step from KB        | KB                |
| "What's the best way to track billable time?"                        | Guidance from KB            | KB                |
| "How do retainers work in Clio?"                                     | Trust accounting guidance   | KB                |
| "What are the deadline rules for discovery responses in California?" | CA-specific filing rules    | KB (jurisdiction) |
| "How should a solo practitioner handle conflict checks?"             | Firm-size specific guidance | KB (firm_size)    |

### Category B: Org Context Questions

These should use firm-uploaded documents.

| Question                                                    | Expected Behavior         | Source                               |
| ----------------------------------------------------------- | ------------------------- | ------------------------------------ |
| "What's our billing rate for associates?"                   | Look up in firm rate card | Org Context                          |
| "What's our intake checklist for new clients?"              | Firm-specific procedure   | Org Context                          |
| "Who handles real estate matters at the firm?"              | Firm routing document     | Org Context                          |
| "What documents do we have uploaded?"                       | List all org context docs | orgContextQuery (list)               |
| "What does our engagement letter template say about scope?" | Search then summarize     | orgContextQuery (search/getDocument) |

### Category C: Clio Read Operations

These require clioQuery tool calls.

| Question                             | Expected Tool Call                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| "Show me my open matters"            | `{ operation: "read", objectType: "Matter", filters: { status: "open" } }`                                                      |
| "Find the Smith case"                | `{ operation: "read", objectType: "Matter", filters: { query: "Smith" } }`                                                      |
| "What tasks are due this week?"      | `{ operation: "read", objectType: "Task", filters: { status: "pending", due_at_from: "2024-01-15", due_at_to: "2024-01-21" } }` |
| "Who is the client on matter 12345?" | `{ operation: "read", objectType: "Matter", id: "12345" }`                                                                      |
| "List my recent time entries"        | `{ operation: "read", objectType: "Activity", filters: { user_id: X } }`                                                        |
| "Show calendar for next week"        | `{ operation: "read", objectType: "CalendarEntry", filters: { from: "...", to: "..." } }`                                       |

### Category D: Clio Write Operations (Admin Only)

These require confirmation flow.

| Question                                                    | Expected Flow                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| "Create a new matter for John Smith"                        | 1. Tool call → 2. Confirmation prompt → 3. User confirms → 4. Execute               |
| "Add a task to the Jones case to file the motion by Friday" | 1. Look up Jones matter ID → 2. Create task with due date → 3. Confirm → 4. Execute |
| "Update the description on matter 12345"                    | 1. Tool call with id and data → 2. Confirm → 3. Execute                             |
| "Delete the duplicate contact record"                       | 1. Clarify which record → 2. Confirm → 3. Execute                                   |

### Category E: Hybrid Questions

These require multiple sources or tool chains.

| Question                                                                                                  | Expected Flow                                                                                      |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "According to our procedures, what should I do when opening a new PI case? Then create one for Jane Doe." | 1. Search Org Context for PI intake → 2. Summarize procedures → 3. Create Matter with confirmation |
| "How should I bill for the Johnson deposition according to our rate card?"                                | 1. Look up firm billing rates → 2. Optionally look up Johnson matter → 3. Guidance                 |
| "What matters are pending and need attention based on our firm's case management policy?"                 | 1. Search Org Context for case management policy → 2. Query open matters → 3. Cross-reference      |

### Category F: Edge Cases & Failures

| Question                                     | Expected Behavior                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| "Give me legal advice on this contract"      | Refuse politely, explain scope                                                              |
| "Delete all my contacts"                     | Refuse (dangerous), ask for clarification                                                   |
| "What's the weather today?"                  | Explain out of scope                                                                        |
| "Create a matter" (as Member)                | Explain need Admin role                                                                     |
| "What's on my calendar?" (no Clio connected) | Prompt to connect Clio                                                                      |
| "Find the XYZ matter" (no results)           | "I couldn't find any matters matching 'XYZ'. Would you like me to search contacts instead?" |

---

## Clio CRUD Test Matrix

### READ Operations

| Object Type   | Test Case               | Expected Filters                                               |
| ------------- | ----------------------- | -------------------------------------------------------------- |
| Matter        | All open                | `{ status: "open" }`                                           |
| Matter        | By client name          | `{ query: "Smith" }`                                           |
| Matter        | By responsible attorney | `{ responsible_attorney_id: X }`                               |
| Matter        | Single by ID            | `id: "12345"`                                                  |
| Contact       | By name                 | `{ query: "John" }`                                            |
| Contact       | By type                 | `{ type: "Person" }` or `{ type: "Company" }`                  |
| Task          | Pending for user        | `{ status: "pending", assignee_id: X, assignee_type: "user" }` |
| Task          | Due in date range       | `{ due_at_from: "...", due_at_to: "..." }`                     |
| Task          | By matter               | `{ matter_id: X }`                                             |
| CalendarEntry | Date range              | `{ from: "...", to: "..." }`                                   |
| CalendarEntry | By matter               | `{ matter_id: X }`                                             |
| Activity      | By user                 | `{ user_id: X }`                                               |
| Activity      | By matter               | `{ matter_id: X }`                                             |
| Activity      | Date range              | `{ date_from: "...", date_to: "..." }`                         |

### CREATE Operations

| Object Type       | Required Fields                                                | Test Prompt                                          |
| ----------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Contact (Person)  | `type: "Person"`, `first_name`, `last_name`                    | "Add a new contact John Smith"                       |
| Contact (Company) | `type: "Company"`, `name`                                      | "Create a contact for Acme Corp"                     |
| Matter            | `description`, `client` (ID)                                   | "Create a matter 'Smith v. Jones' for client ID 123" |
| Task              | `name`, `matter` (ID)                                          | "Add a task 'File motion' to matter 456"             |
| CalendarEntry     | `summary`, `start_at`, `end_at`                                | "Schedule a meeting tomorrow at 2pm for 1 hour"      |
| Activity          | `date`, `quantity`, `matter` (ID), `activity_description` (ID) | "Log 1.5 hours to matter 789 for research"           |

### UPDATE Operations

| Object Type | Test Prompt                                      | Expected                                      |
| ----------- | ------------------------------------------------ | --------------------------------------------- |
| Matter      | "Change the status of matter 123 to closed"      | `{ id: "123", data: { status: "closed" } }`   |
| Contact     | "Update John Smith's email to john@example.com"  | Look up ID first, then update                 |
| Task        | "Mark task 456 complete"                         | `{ id: "456", data: { status: "complete" } }` |
| Task        | "Change the due date on task 456 to next Friday" | `{ id: "456", data: { due_at: "..." } }`      |

### DELETE Operations

| Object Type | Test Prompt                               | Expected              |
| ----------- | ----------------------------------------- | --------------------- |
| Contact     | "Delete the duplicate contact record 789" | Confirm before delete |
| Task        | "Remove task 456"                         | Confirm before delete |

---

## Source Weighting Definition

### What Each Source Provides

**Knowledge Base (KB):**

- Clio platform documentation and workflows
- Legal practice management best practices
- Billing and time tracking guidance
- Jurisdiction-specific procedural rules
- Firm-size appropriate recommendations

**Org Context:**

- Firm-specific policies and procedures
- Internal templates and checklists
- Billing rate cards
- Staff/team routing preferences
- Custom workflows

**Clio (via clioQuery):**

- Live matter and contact data
- Task and calendar information
- Time entries and billing records
- Real-time record creation/modification

### Weighting Guidance for LLM

The system prompt should clarify:

```
## Source Authority

When answering questions:

1. **Firm-specific facts** (rates, procedures, staff):
   - Org Context is authoritative
   - KB is secondary (generic guidance)
   - Clio provides live data

2. **Clio how-to** (how to use features):
   - KB is authoritative
   - Org Context may have firm-specific workflows
   - Don't guess - search if unsure

3. **Record lookups** (matters, contacts, tasks):
   - Clio is the source of truth
   - Use clioQuery tool

4. **Conflicts between sources**:
   - Org Context overrides KB for firm-specific practices
   - Clio data is always current (not KB or Org Context)
   - When unclear, state what each source says
```

---

## Implementation Checklist

### Quick Wins (< 1 hour each)

- [ ] Add current date to system prompt
- [ ] Add user's Clio ID to system prompt (when available)
- [ ] Clarify source hierarchy in prompt

### Medium Effort (2-4 hours)

- [ ] Rebalance RAG token budget (interleave by score or 50/50 split)
- [ ] Add explicit "when to use what" guidance to prompt
- [ ] Create test harness for sample questions

### Larger Changes

- [ ] Store and inject user's Clio account ID on OAuth
- [ ] Add semantic caching for repeated similar queries
- [ ] Improve LLM model (current: llama-3.1-8b-instruct, consider larger)

---

## Next Steps

1. **Manual Testing:** Run through Category A-F questions manually
2. **Log Analysis:** Review actual user questions to identify patterns
3. **Prompt Iteration:** A/B test prompt changes
4. **KB Content:** Ensure KB has adequate coverage for common questions

---

## Appendix: Current System Prompt (Reference)

From `tenant.ts:619-684`:

```
You are Docket, a case management assistant for Clio. Responses should be concise with clear points or a clear ask.

## User Role
{admin/member status}

## Available Tools
- orgContextQuery
- knowledgeBaseQuery
- clioQuery

## Decision Logic
{when to use each tool}

## Relevant Context
{RAG chunks injected here}

## Clio Rules
{ID resolution, confirmation, connection check}

## Constraints
{no legal advice, scope limits}
```
