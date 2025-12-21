## Developer Experience (Fix Before Phase 6)

### 10. Create Development Seed Script

**Location:** `/scripts/seed.ts` (create)

No way to quickly set up test data.

---

### 11. Add Structured Logging

**Location:** Throughout codebase

Uses `console.error` with no structure.

**Fix:** Create `/src/lib/logger.ts` with structured JSON output.

---

### 12. Restructure /src

**Current:** 576-line `index.ts` mixing worker, DO, routes, demos.

**Proposed:**

```
/src/
  worker.ts
  /durable-objects/tenant.ts
  /routes/auth.ts, clio.ts, api.ts
  /services/
  /lib/
  /types/
  /config/index.ts
  /demo/
```
