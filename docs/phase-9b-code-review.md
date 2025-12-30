# Phase 9b Web Chat Interface - Consolidated Code Review

## 13. Missing `llm_thinking` Complete Event

**Identified by:** 🌴
**File:** `tenant.ts:1725-1727`

RAG lookup emits started/complete, but LLM thinking only emits started. ProcessLog shows "Thinking..." indefinitely.

## 14. Undocumented `started` Process Event

**Identified by:** ☯️
**File:** `tenant.ts:1624`

Emits `{ type: "started" }` which is not in the spec's event list. Scope creep (harmless but undocumented).

## 22. No Message Storage on Confirmation Accept/Reject

**Identified by:** 🌴
**File:** `tenant.ts:2175-2337`

Results from accepting/rejecting confirmations not stored in conversation history. Lost on page refresh.

## 27. Type Definitions Diverge from Runtime

**Identified by:** ☯️
SSE types in `types/index.ts` don't match actual emissions (e.g., `success` field not in type).
