# Comprehensive LLM System Review

**Date:** 2026-01-02
**Scope:** Phase 9b Web Chat Interface, LLM System Implementation
**Reviewers:** Four perspectives (Security, Simplicity, Compliance, Practicality)

---

## Executive Summary

This review consolidates findings from four independent analyses of the Docket LLM system. The codebase demonstrates solid foundational architecture but contains critical gaps that must be addressed before production deployment.

**Overall Risk Level:** HIGH - Multiple liability and security exposures requiring immediate mitigation.

### Critical Blockers (Must Fix Before Production)

| Issue | Category | Impact |
|-------|----------|--------|
| No UPL output filtering | Compliance | Legal liability |
| Missing orgId validation in DO | Security | Cross-org data access |
| No attorney-client privilege protection | Compliance | Privilege waiver risk |
| No Terms of Service or disclaimers | Compliance | User reliance risk |
| RAG token budget prioritizes KB over Org Context | Logic | Wrong context served |
| No DO SQLite testing | Quality | Untested critical paths |

---

## Part 1: Security & Technical Accuracy

*Perspective: Christian Senior Software Engineer*

### CRITICAL

#### 1.1 Missing orgId Validation in TenantDO
**Location:** `apps/api/src/do/tenant.ts:208-252`
**Severity:** CRITICAL

The TenantDO receives ChannelMessages with an `orgId` field but never verifies that `message.orgId === this.orgId`. A compromised adapter could route messages to the wrong organization's DO.

**Attack Scenario:** Malicious adapter sends message intended for Org A to Org B's TenantDO. Since DO doesn't validate, it executes queries against Org B's data.

**Fix:**
```typescript
if (message.orgId !== this.orgId) {
  return Response.json({ error: "Organization mismatch" }, { status: 403 });
}
```

#### 1.2 Conversation Scope Not Enforced Per-User
**Location:** `apps/api/src/do/tenant.ts:2149-2177`

For Teams/Slack, `user_id` is NULL even for "personal" scope conversations. Someone could manipulate `conversationId` to access another user's conversation history.

**Fix:** Always store `user_id` regardless of channel and enforce ownership check on retrieval.

### HIGH

#### 1.3 Weak Timing Attack Mitigation
**Location:** `apps/api/src/lib/encryption.ts:271-284`

The `constantTimeEqual` function attempts timing attack prevention but still leaks length information via early return after length check.

**Fix:** Pad both buffers to same length before comparison.

#### 1.4 No Request Ownership Verification in Chat Handler
**Location:** `apps/api/src/handlers/chat.ts:224-248`

Handler forwards `userId` to DO without verifying the conversation belongs to that user. If DO has a bug, users could read each other's conversations.

**Fix:** Verify conversation ownership at handler level before forwarding to DO.

### MEDIUM

#### 1.5 Clio Token Refresh - Missing Pre-Expiration Check
**Location:** `apps/api/src/do/tenant.ts:1435-1483`

Code only handles 401 reactively. Should proactively refresh tokens before making calls if near expiration.

#### 1.6 No Rate Limiting on DO Endpoints
**Location:** `apps/api/src/do/tenant.ts:177-200`

The DO exposes 12 endpoints with no per-user rate limiting. Cloudflare rate limiting at Worker layer (Phase 11) is deferred.

#### 1.7 OAuth State Parameter Not Single-Use
**Location:** `apps/api/src/services/clio-oauth.ts:222-263`

State parameter has 10-minute TTL but no single-use tracking. Attacker could reuse intercepted state within the window.

---

## Part 2: Flow & Simplicity

*Perspective: Taoist Project Manager*

### CRITICAL

#### 2.1 RAG Token Budget Processing Is Backward
**Location:** `apps/api/src/services/rag-retrieval.ts:353-381`

KB chunks always receive priority; Org Context is secondary. Firm-specific context (more relevant) may be truncated in favor of generic KB content.

**Current:**
```typescript
// Process KB chunks first
for (const chunk of context.kbChunks) { ... }
// Then process org chunks with remaining budget
for (const chunk of context.orgChunks) { ... }
```

**The Simpler Way:** Interleave by relevance score regardless of source.

#### 2.2 Dual LLM Calls for Tool Result Summarization
**Location:** `apps/api/src/do/tenant.ts:877-902`

System prompt teaches LLM to use tools → tool results re-summarized → two LLM calls where one should work.

**Impact:** +20-50% API usage, doubled latency on tool-heavy queries.

**The Simpler Way:** Feed tool results back into conversation history, continue with same LLM call.

#### 2.3 Three Nearly Identical Search Tool Schemas
**Location:** Tool definitions scattered across files

`clioQuery`, `orgContextQuery`, `knowledgeBaseQuery` implement nearly identical search patterns with duplicated validation, execution, and formatting logic.

**The Simpler Way:** One generic `search` tool that routes based on `source: "clio" | "org" | "kb"`.

### MAJOR

#### 2.4 System Prompt Missing Critical Context
**Location:** `apps/api/src/do/tenant.ts:619-684`

Missing from prompt:
- Current date/time (breaks "tasks due this week" queries)
- User's Clio ID (forces extra lookup)
- Explicit source hierarchy guidance

**Impact:** Unnecessary tool calls for information that should be injected.

**Fix:** Add 3 lines:
```typescript
const today = new Date().toISOString().split('T')[0];
const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
// In prompt: Today: ${today} (${dayOfWeek})
```

#### 2.5 15 SSE Event Types (Spec Says 6)
**Location:** `apps/api/src/do/tenant.ts:441-526`

Implementation emits: `kb_search`, `org_context_search`, `clio_call`, `clio_result`, `llm_thinking`, `llm_response`, `thinking`, `auto_correct`, `summarizing`, etc.

Spec 12 defines only: `started`, `rag_lookup`, `llm_thinking`, `clio_call`, `clio_result`, `confirmation_required`.

**The Simpler Way:** Consolidate to spec's 6 event types.

#### 2.6 Token Budget Config Mismatch
**Location:** `apps/api/src/config/kb.ts:17` vs `docs/00-specs/07-knowledge-base.md:155`

Code: `TOKEN_BUDGET: 1000`
Spec: "Token budget: 3,000 tokens for RAG context"

66% less context than designed.

---

## Part 3: Compliance & Liability

*Perspective: Lawyerly Supervisor*

### CRITICAL

#### 3.1 No Active Output Filtering for Legal Advice
**Location:** `apps/api/src/do/tenant.ts:619-684`

System prompt says "No legal advice" but there's NO mechanism to detect or filter LLM responses that violate this constraint. LLM can hallucinate legal advice despite the constraint.

**Example Violations:**
- User: "Should I settle for $50,000?" → Bot generates risk-benefit analysis
- User: "Am I liable?" → Bot analyzes facts and legal standards

**Mitigation:**
1. Implement output validation scanning for legal advice patterns
2. Add content filter post-LLM blocking legal opinions, strategy advice, statutory analysis
3. Add explicit disclaimer in EVERY response

**Applicable Authority:** Model Rule 5.3, ABA Formal Opinion 512F

#### 3.2 Attorney-Client Privilege Not Protected
**Location:** `apps/api/src/db/schema.ts`, `docs/00-specs/10-development-plan.md:378`

Phase 12 defers `is_privileged` flag indefinitely. Users may share privileged communications expecting protection. Without it:
- Communications with bot could be discoverable
- Privilege may be waived if bot shares privileged info in RAG context

**Mitigation (Before Production):**
1. Implement `is_privileged` flag in conversations table
2. Modify RAG retrieval to exclude privileged messages
3. Add explicit disclaimer: "Conversations with Docket are NOT privileged"

#### 3.3 No Visible Terms of Service or Disclaimers
**Location:** `apps/web/app/routes/_app.chat.tsx`

Users interact with bot without seeing:
- Notice that AI is used
- Notice that communications are not privileged
- Data retention/usage notice
- Limitation of liability

**Mitigation:**
1. Add visible disclaimer in chat UI requiring acceptance
2. Add Terms of Service page with limitation of liability
3. Add inline disclaimer after every response

### HIGH

#### 3.4 KB Content Not Reviewed for Legal Accuracy
**Location:** `/kb/` folder, `docs/00-specs/10-development-plan.md:161`

Spec defers KB content review: "requires legal expert review. Use placeholder content if unavailable."

If KB contains incorrect deadline information → bot gives wrong advice → malpractice risk.

**Mitigation:** Hire legal expert to review ALL KB content before production.

#### 3.5 Audit Logs Are Write-Only
**Location:** `apps/api/src/do/tenant.ts`, `docs/00-specs/10-development-plan.md:352`

Audit logs stored in R2 but no retrieval endpoint. Firms cannot:
- Demonstrate compliance
- Investigate incidents
- Export for litigation holds

**Mitigation:** Implement `GET /api/audit` endpoint with filtering and export.

### MEDIUM

#### 3.6 Confirmation Cards Lack Sufficient Context
**Location:** `apps/api/src/do/tenant.ts:1191-1198`

When asking user to confirm Clio write, prompt may be vague. User might confirm wrong operation.

**Mitigation:** Show full context: object type, key fields, values, before/after comparison.

#### 3.7 PII in Tool Call Arguments Not Sanitized
**Location:** `apps/api/src/do/tenant.ts:1160-1166`

User says "Find tasks for John Smith" → filters include `{query: "John Smith"}` → logged without redaction.

**Mitigation:** Apply `sanitizeAuditParams()` to tool call arguments before logging.

#### 3.8 No Conflict of Interest Checking
**Location:** `docs/00-specs/10-development-plan.md:381`

System allows multi-org membership without conflict checking. Deferred to Phase 12.

**Risk:** User could access opposing party information across firms.

---

## Part 4: Developer Practicality

*Perspective: Nicaraguan Coworker*

### CRITICAL

#### 4.1 No Testing for DO SQLite Operations
**Location:** `apps/api/test/`, `docs/00-specs/10-development-plan.md` Phase 6

Development plan states: "TenantDO (19 tests), Message Flow E2E (7 tests) — skipped. DO SQLite blocked by vitest-pool-workers SQLITE_AUTH limitation."

**Untested:**
- Conversation storage/retrieval
- Pending confirmation lifecycle
- Message history loading
- Clio token storage/retrieval
- Alarm handling

**Pain Level:** 5 (will cause production incidents)

**Practical Fix:**
1. Short-term: Create `/demo/clio` endpoint that exercises all DO paths
2. Medium-term: Docker-based integration tests with real SQLite
3. Long-term: Advocate for vitest-pool-workers fix

### HIGH

#### 4.2 Spec Drift: Multiple Mismatches
**Location:** Multiple files

| Spec (doc 12) | Code |
|---|---|
| Confirmation expires 5 min | 24 hours (config/tenant.ts) |
| RAG budget: 3,000 tokens | 1,000 tokens (config/kb.ts) |
| 6 SSE event types | 15+ emitted |

**Pain Level:** 3

**Fix:** Audit and update specs to match implementation (or vice versa).

### MEDIUM

#### 4.3 Error Classification is Silent
**Location:** `apps/api/src/do/tenant.ts:1349-1376`

If LLM fails to classify confirmation intent, code returns `{ intent: "unclear" }` without logging. Makes debugging user confusion impossible.

**Fix:** Add logging before returning unclear.

#### 4.4 Clio Result Summarization Uses Fragile Regex
**Location:** `apps/api/src/do/tenant.ts:569-613`

Preview generation uses regex to extract JSON from formatted responses:
```typescript
const match = result.match(/\[[\s\S]*\]/);
```

If Clio response format changes or includes nested arrays, this breaks.

**Fix:** Return structured data from `formatClioResponse()`, then extract preview.

#### 4.5 No Observability for RAG Performance
**Location:** `apps/api/src/services/rag-retrieval.ts`

Code doesn't track:
- How often KB/org context is used
- Cache hit rate
- Token budget waste (chunks dropped)
- Score distribution

**Fix:** Add RAG metrics logging.

### LOW

#### 4.6 Message Status Field Not Always Set
**Location:** `apps/api/src/do/tenant.ts:234-250, 310-342`

Non-streaming path doesn't set message status; streaming path does. Frontend initializes to "streaming" but DB may have undefined.

**Fix:** Always set status explicitly.

#### 4.7 LLM Response Parsing Has Fallback-to-Fallback Logic
**Location:** `apps/api/src/do/tenant.ts:712-750`

Multiple fallback paths that mask errors. Hard to debug what LLM actually returned.

**Fix:** Add logging and simplify to one clear path.

---

## Priority Matrix

### Immediate (Before Production)

| Issue | Effort | Impact |
|-------|--------|--------|
| 3.1 UPL output filtering | 4h | Legal liability |
| 3.3 Terms of Service & disclaimers | 2h | Legal liability |
| 1.1 orgId validation in DO | 15m | Security |
| 1.2 Conversation ownership enforcement | 1h | Security |
| 3.2 Attorney-client privilege flag | 4h | Legal liability |
| 2.4 Date/time in system prompt | 15m | UX |
| 3.5 Audit log retrieval endpoint | 4h | Compliance |

### High Priority (Next Sprint)

| Issue | Effort | Impact |
|-------|--------|--------|
| 2.1 RAG token budget rebalancing | 1h | Quality |
| 2.2 Eliminate dual LLM calls | 2h | Performance |
| 4.1 DO testing workaround | 4h | Quality |
| 4.2 Spec drift audit | 2h | Documentation |
| 1.4 Handler ownership verification | 1h | Security |

### Medium Priority

| Issue | Effort | Impact |
|-------|--------|--------|
| 2.5 Consolidate SSE event types | 2h | Simplicity |
| 1.5 Proactive token refresh | 1h | Reliability |
| 1.6 DO rate limiting | 2h | Security |
| 3.6 Confirmation context | 2h | UX |
| 4.5 RAG observability | 2h | Debugging |

### Technical Debt

| Issue | Effort | Impact |
|-------|--------|--------|
| 2.3 Consolidate search tools | 4h | Maintainability |
| 2.6 Token budget config alignment | 15m | Documentation |
| 1.3 Timing attack fix | 1h | Security |
| 4.4 Clio result parsing | 1h | Reliability |

---

## Recommended Implementation Order

### Phase 1: Legal & Security Blockers (Week 1)
1. Add orgId validation to TenantDO (15 min)
2. Add conversation ownership verification in handlers (1 hr)
3. Implement UPL output filtering with pattern detection (4 hrs)
4. Add Terms of Service page and chat disclaimer (2 hrs)
5. Inject current date into system prompt (15 min)

### Phase 2: Compliance & Quality (Week 2)
1. Implement attorney-client privilege flag (4 hrs)
2. Implement audit log retrieval endpoint (4 hrs)
3. Fix RAG token budget to interleave by score (1 hr)
4. Create DO testing workaround (4 hrs)
5. Audit and fix spec drift (2 hrs)

### Phase 3: Performance & Polish (Week 3)
1. Eliminate dual LLM calls for tool summarization (2 hrs)
2. Consolidate SSE event types to match spec (2 hrs)
3. Add RAG observability metrics (2 hrs)
4. Fix confirmation context display (2 hrs)
5. Add proactive token refresh (1 hr)

---

## Deferred Tasks That Must Not Remain Deferred

From development plan, these items need earlier implementation:

| Current Phase | Task | Move To |
|---------------|------|---------|
| Phase 11 | UPL output filtering | Phase 9 |
| Phase 11 | Response disclaimers | Phase 9 |
| Phase 12 | Legal counsel review | Phase 9 |
| Phase 12 | Attorney-client privilege | Phase 9 |
| Phase 12 | Conflict of interest checking | Phase 10 |
| Phase 11 | Audit log retrieval | Phase 10 |

---

## Appendix: Files Reviewed

### Core LLM System
- `apps/api/src/do/tenant.ts` (2938 lines)
- `apps/api/src/services/rag-retrieval.ts`
- `apps/api/src/handlers/chat.ts`
- `apps/api/src/services/clio-oauth.ts`
- `apps/api/src/lib/encryption.ts`
- `apps/api/src/lib/sanitize.ts`
- `apps/api/src/config/kb.ts`
- `apps/api/src/config/tenant.ts`

### Specifications
- `docs/00-specs/00-overview.md` through `14-chatbot-analysis.md`
- `docs/00-specs/10-development-plan.md`
- `docs/00-specs/12-web-chat-interface.md`

### Frontend
- `apps/web/app/routes/_app.chat.tsx`
- `apps/web/app/lib/use-chat.ts`

---

**End of Consolidated Review**
