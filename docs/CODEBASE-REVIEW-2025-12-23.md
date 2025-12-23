# Docket Codebase Review - Production Readiness Audit

## Review Panel

| Agent        | Perspective                        | Focus Areas                                                           |
| ------------ | ---------------------------------- | --------------------------------------------------------------------- |
| **Marcus**   | Christian Senior Software Engineer | Security, technical correctness, type safety, data integrity          |
| **Wei**      | Taoist Project Manager             | Simplicity, flow, scope discipline, over-engineering                  |
| **Patricia** | Lawyerly Supervisor                | GDPR compliance, legal industry requirements, liability, audit trails |
| **Carlos**   | Nicaraguan Coworker                | Developer experience, debugging, configuration, operations            |

## OVERDUE: Should Have Been Resolved (Phases 2-8)

These items were claimed complete in earlier phases but have implementation gaps:

### From Phase 6 (Core Worker + DO) - Marked 100% Complete

| ID  | Issue | Phase 6 Claim | Actual Status |
| --- | ----- | ------------- | ------------- |

| DEV-03 | Generic errors without context | "Generic error responses" ✓ | Too generic, no logging/IDs |
| GDPR-01 | GDPR erasure incomplete | "GDPR purge-user-data" ✓ | Vectorize embeddings not deleted |


### From Phase 7 (Workers AI + RAG) - Marked 100% Complete

| ID     | Issue                     | Phase 7 Claim                  | Actual Status                   |
| ------ | ------------------------- | ------------------------------ | ------------------------------- |
| SEC-06 | RAG prompt injection risk | "System prompt construction" ✓ | No sanitization of user content |
| SEC-14 | Tool calls unvalidated    | "clioQuery tool" ✓             | No Zod validation on LLM output |

### From Phase 8 (Clio Integration) - Marked 100% Complete

| ID     | Issue                        | Phase 8 Claim              | Actual Status                   |
| ------ | ---------------------------- | -------------------------- | ------------------------------- |
| SEC-13 | Token refresh race condition | "Reactive token refresh" ✓ | No concurrency lock             |
| DEV-15 | Rate limit headers ignored   | "Rate limit awareness" ✓   | Only 429, not proactive headers |

---

## BLOCKS PHASE 9: Must Fix Before Website MVP

Phase 9 requires Auth UI, OAuth flows, and Org Context management. These issues block that work:

### SEC-07: Missing CORS Configuration

**Identified by:** Marcus
**Why it blocks:** Web UI cannot make API calls without CORS headers.
**Action:**

- [ ] Add strict CORS policy matching Better Auth `trustedOrigins`
- [ ] Configure for web app origin

### DEV-01: No .env.example Files

**Identified by:** Carlos
**Why it blocks:** Cannot set up web app development environment.
**Action:**

- [ ] Create `.env.example` at project root and `apps/web/`
- [ ] Document all required credentials for web development

### DEV-02: No Local Development Guide

**Identified by:** Carlos
**Why it blocks:** Phase 9 developer cannot start work efficiently.
**Action:**

- [ ] Create `/docs/development.md` covering web + API setup

### SEC-12: Input Validation Missing on ChannelMessage

**Identified by:** Marcus
**Why it blocks:** Web UI will send messages; needs validation.
**Action:**

- [ ] Add max length validation (10,000 chars for message)

### ARCH-01: 2300-Line index.ts File

**Identified by:** Wei, Carlos
**Why it blocks:** Adding web-facing endpoints to this file is unmaintainable.
**Action:**

- [ ] Extract TenantDO to `apps/api/src/do/tenant.ts`
- [ ] Extract OAuth handlers to separate file
- [ ] Leave Worker routing in index.ts (<200 lines)

### SEC-08: Demo Endpoints in Production Code

**Identified by:** Marcus, Wei
**Why it blocks:** Demo endpoints conflict with real web UI routes.
**Action:**

- [ ] Gate behind `env.ENVIRONMENT === 'development'`
- [ ] Or remove before Phase 9 deploys

### DEV-04: No Structured Logging

**Identified by:** Carlos
**Why it blocks:** Cannot debug web UI issues without proper logging.
**Action:**

- [ ] Implement structured logging with JSON output
- [ ] Include context fields (orgId, userId, endpoint)

### DEV-05: No Health Check Endpoints

**Identified by:** Carlos
**Why it blocks:** Web app needs to verify API availability.
**Action:**

- [ ] Add `/health` endpoint (quick D1 check)
- [ ] Add `/ready` endpoint (thorough checks)

---

## NEW FINDINGS: Not in Development Plan

These are legitimate gaps discovered by the review that aren't covered in any phase:

### Critical (Add to Phase 9 or Earlier)

### SEC-02: SQL Injection Risk in RAG Retrieval

**Identified by:** Marcus
**File:** `apps/api/src/services/rag-retrieval.ts:281, 341`

Dynamic SQL construction with `chunkIds` array could bypass parameter binding.

**Action:**

- [ ] Validate `chunkIds` against strict UUID pattern before query construction
- [ ] Add input sanitization layer

---

### SEC-03: Cross-Tenant Data Leakage Risk via Vectorize

**Identified by:** Marcus, Patricia
**File:** `apps/api/src/services/rag-retrieval.ts:141-213`

KB and Org Context embeddings share same Vectorize index with only metadata filtering.

**Action:**

- [ ] Re-fetch org settings from D1 inside DO instead of trusting message
- [ ] Add query result validation before returning chunks
- [ ] Consider separate Vectorize indexes per org (Phase 11?)

---

### LEGAL-01: No Attorney-Client Privilege Protection

**Identified by:** Patricia
**File:** None - Feature Missing

Attorney-client communications require special handling. Not in any phase.

**Recommendation:** Add to Phase 12 (Compliance Review) or create Phase 12.5
**Action:**

- [ ] Add `is_privileged` flag to conversations
- [ ] Exclude privileged messages from RAG context
- [ ] Add privilege log export for litigation

---

### LEGAL-02: No Conflict of Interest Detection

**Identified by:** Marcus, Patricia
**File:** None - Feature Missing

No mechanism to detect opposing party conflicts. Not in any phase.

**Recommendation:** Add to Phase 12 (Compliance Review)
**Action:**

- [ ] Consider preventing multi-org membership
- [ ] Or add matter tracking with party names

---

### LEGAL-04: UPL Risk - No Output Filtering

**Identified by:** Marcus, Patricia
**File:** `apps/api/src/index.ts:264-283`

LLM can hallucinate legal opinions despite prompt instructions.

**Recommendation:** Add to Phase 11 (Production Hardening)
**Action:**

- [ ] Add output filtering for legal advice patterns
- [ ] Prepend disclaimer to all responses

---

### GDPR-04: PII Exposure in Audit Logs

**Identified by:** Patricia
**File:** `apps/api/src/index.ts:1450-1470`

Audit logs may contain PII in `params` field.

**Recommendation:** Fix in Phase 9 (before real users)
**Action:**

- [ ] Redact PII from params before logging

---

### High Priority (Add to Appropriate Phase)

### ARCH-02: Premature Monorepo Split

**Identified by:** Wei
**Decision needed:** Keep structure for Phase 9 web app, or flatten?
**Action:**

- [ ] Document why structure exists, or flatten before Phase 9

---

### DEV-06: 19 DO Tests Skipped

**Identified by:** Carlos
**Recommendation:** Document workaround, add to Phase 11
**Action:**

- [ ] Create `/docs/manual-testing.md` (Phase 9)
- [ ] Consider service class extraction (Phase 11)

---

### DEV-07: No Deployment Verification

**Identified by:** Carlos
**Recommendation:** Add to Phase 9 (before real deploys)
**Action:**

- [ ] Create post-deploy smoke test script

---

### DEV-13: No CI/CD Pipeline

**Identified by:** Carlos
**Recommendation:** Add to Phase 9
**Action:**

- [ ] Create GitHub Actions workflow for tests

---

## LOW Priority (Backlog)

| ID     | Issue                                         | Identified By  |
| ------ | --------------------------------------------- | -------------- |
| LOW-01 | Missing API versioning                        | Marcus         |
| LOW-02 | Unused `restorePendingConfirmation` function  | Wei            |
| LOW-03 | Unused `OrgMemberRow` conversion              | Wei            |
| LOW-04 | Zod in shared package but not used there      | Wei            |
| LOW-05 | Environment variable validation missing       | Marcus         |
| LOW-06 | Hardcoded pagination limits                   | Marcus         |
| LOW-07 | Inconsistent error handling patterns          | Marcus         |
| LOW-08 | Magic strings for status codes                | Carlos         |
| LOW-09 | No custom error classes                       | Carlos         |
| LOW-10 | Incomplete JSDoc comments                     | Carlos         |
| LOW-11 | Better Auth dependency unused (until Phase 9) | Wei            |
| LOW-13 | Type safety gaps (unknown, as casts)          | Marcus, Carlos |
| LOW-14 | Naming inconsistencies (tenant vs org)        | Carlos         |
