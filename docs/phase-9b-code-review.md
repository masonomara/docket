# Phase 9b Web Chat Interface - Consolidated Code Review

## 14. Undocumented `started` Process Event

**Identified by:** ☯️
**File:** `tenant.ts:1624`

Emits `{ type: "started" }` which is not in the spec's event list. Scope creep (harmless but undocumented).
