# Clio Schema Generator

**LONGER DOC:** Code examples

## Problem

The LLM generates invalid Clio API parameters. Current `getClioTools()` in `tenant.ts:764` provides minimal guidance, and the hardcoded schema drifts from the API.

## Solution

Extract ALL parameters from `openapi.json`. Use examples (not param lists) in the tool description.

**Reference:** `openapi.json` (root directory)

**Philosophy:**

- Extract all params automatically (no manual documentation)
- Validate enum values with suggestions
- Fail open on unknown params (OpenAPI may be incomplete)
- Examples in tool description (concise, pattern-based)

## Architecture

```text
openapi.json
    ↓
scripts/extract-clio-params.ts (extracts ALL query params)
    ↓
apps/api/src/generated/clio-params.json (committed)
    ↓
apps/api/src/services/clio-static-schema.ts (validation + examples)
    ↓
tenant.ts
```

**Separate from:** `clio-schema.ts` (per-org custom fields at runtime)

---

## Task 1: Create Directories

```bash
mkdir -p scripts
mkdir -p apps/api/src/generated
```

---

## Task 2: Create Extraction Script

**File:** `scripts/extract-clio-params.ts`

Extracts ALL query parameters from OpenAPI spec.

```typescript
import * as fs from "fs";
import * as path from "path";

const OPENAPI_PATH = path.join(__dirname, "..", "openapi.json");
const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "apps/api/src/generated/clio-params.json"
);

const openapi = JSON.parse(fs.readFileSync(OPENAPI_PATH, "utf-8"));

const ENDPOINTS: Record<string, string> = {
  Matter: "/matters.json",
  Contact: "/contacts.json",
  Task: "/tasks.json",
  CalendarEntry: "/calendar_entries.json",
  Activity: "/activities.json",
};

// Skip meta params (handled separately)
const SKIP_PARAMS = new Set([
  "fields",
  "limit",
  "page_token",
  "order",
  "X-API-VERSION",
]);

interface ParamInfo {
  name: string;
  type: string;
  format?: string;
  enum?: string[];
}

interface ObjectSchema {
  endpoint: string;
  params: Record<string, ParamInfo>;
}

function extractParams(apiPath: string): Record<string, ParamInfo> {
  const endpoint = openapi.paths?.[apiPath]?.get;
  if (!endpoint?.parameters) return {};

  const params: Record<string, ParamInfo> = {};

  for (const p of endpoint.parameters) {
    if (p.in !== "query") continue;
    if (SKIP_PARAMS.has(p.name)) continue;

    const key = p.name.replace("[]", "");
    params[key] = {
      name: p.name,
      type: p.schema?.type || "string",
      format: p.schema?.format,
      enum: p.schema?.enum,
    };
  }

  return params;
}

const clioParams: Record<string, ObjectSchema> = {};

for (const [objectType, apiPath] of Object.entries(ENDPOINTS)) {
  clioParams[objectType] = {
    endpoint: apiPath,
    params: extractParams(apiPath),
  };
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(clioParams, null, 2));

console.log("Generated clio-params.json");
for (const [type, schema] of Object.entries(clioParams)) {
  const total = Object.keys(schema.params).length;
  const withEnum = Object.values(schema.params).filter((p) => p.enum).length;
  console.log(`  ${type}: ${total} params (${withEnum} with enums)`);
}
```

**Run:**

```bash
node --experimental-strip-types scripts/extract-clio-params.ts
```

**Expected output:** All params per type (~20-25 each), with enum info where applicable.

---

## Task 3: Create Static Schema Service

**File:** `apps/api/src/services/clio-static-schema.ts`

```typescript
import clioParams from "../generated/clio-params.json";

type ObjectType = keyof typeof clioParams;

interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

/**
 * Validates filters against extracted schema.
 * - Enum params: validate and suggest corrections
 * - Non-enum params: pass through (fail open)
 */
export function validateFilters(
  objectType: string,
  filters?: Record<string, unknown>
): ValidationResult {
  const schema = clioParams[objectType as ObjectType];

  if (!schema) {
    return {
      valid: false,
      error: `Unknown objectType "${objectType}".`,
      suggestion: `Valid: ${Object.keys(clioParams).join(", ")}`,
    };
  }

  if (!filters) return { valid: true };

  for (const [key, value] of Object.entries(filters)) {
    const param = schema.params[key];
    // Fail open: unknown params pass through to Clio
    if (!param?.enum) continue;

    const normalized = String(value).toLowerCase();
    const valid = param.enum.map((v: string) => v.toLowerCase());

    if (!valid.includes(normalized)) {
      return {
        valid: false,
        error: `Invalid ${key}="${value}".`,
        suggestion: `Valid: ${param.enum.join(", ")}`,
      };
    }
  }

  // Business rule: Task assignee_id requires assignee_type
  if (objectType === "Task" && filters.assignee_id && !filters.assignee_type) {
    return {
      valid: false,
      error: "assignee_id requires assignee_type.",
      suggestion: "Add assignee_type: User or Contact",
    };
  }

  return { valid: true };
}

/**
 * Normalizes enum values to lowercase (Clio query param convention).
 */
export function normalizeFilters(
  objectType: string,
  filters?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!filters) return undefined;

  const schema = clioParams[objectType as ObjectType];
  if (!schema) return filters;

  const normalized = { ...filters };

  for (const [key, value] of Object.entries(normalized)) {
    const param = schema.params[key];
    if (!param?.enum || value === undefined) continue;
    normalized[key] = String(value).toLowerCase();
  }

  return normalized;
}

/**
 * Returns the clioQuery tool definition.
 * Uses examples (not exhaustive param lists) for concise prompts.
 */
export function getClioToolSchema(userRole: string): object {
  const permissionNote =
    userRole === "admin"
      ? "Create/update/delete require confirmation."
      : "Members: read only.";

  return {
    type: "function",
    function: {
      name: "clioQuery",
      description: `Query or modify Clio data. ${permissionNote}`,
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["read", "create", "update", "delete"],
          },
          objectType: {
            type: "string",
            enum: Object.keys(clioParams),
            description: "Clio object type. Use Activity for time entries.",
          },
          id: {
            type: "string",
            description: "Object ID (required for update/delete)",
          },
          filters: {
            type: "object",
            description: `Query filters. Examples:
- {"query": "Smith"} - text search
- {"status": "open"} - status (open | closed | pending)
- {"matter_id": 123} - filter by matter
- {"user_id": 456} - filter by user
- {"created_since": "2024-01-01"} - date filter`,
          },
          data: {
            type: "object",
            description: "Data for create/update",
          },
        },
        required: ["operation", "objectType"],
      },
    },
  };
}
```

---

## Task 4: Update tenant.ts

**File:** `apps/api/src/do/tenant.ts`

### 4a. Add import after line 24

```typescript
import {
  getClioToolSchema,
  validateFilters,
  normalizeFilters,
} from "../services/clio-static-schema";
```

### 4b. Replace getClioTools (~line 764)

Delete lines 764-815. Replace with:

```typescript
private getClioTools(userRole: string): object[] {
  return [getClioToolSchema(userRole)];
}
```

### 4c. Add validation in executeSingleToolCall (~line 867)

After `const { operation, objectType, id, filters, data } = toolCall.arguments;`:

```typescript
// Validate and normalize filters
if (operation === "read" && !id) {
  const validation = validateFilters(objectType, filters);
  if (!validation.valid) {
    const hint = validation.suggestion ? ` ${validation.suggestion}` : "";
    return `Filter error: ${validation.error}${hint}`;
  }
}
const normalizedFilters = normalizeFilters(objectType, filters);
```

Use `normalizedFilters` in subsequent code.

### 4d. Update system prompt examples (~line 624)

Change `TimeEntry` to `Activity`:

```typescript
- "Log my time" → clioQuery with objectType="Activity"
```

---

## Task 5: Add npm script

**File:** `package.json` (root)

```json
"generate:clio-params": "node --experimental-strip-types scripts/extract-clio-params.ts"
```

---

## Task 6: Generate and Commit

```bash
npm run generate:clio-params

git add scripts/extract-clio-params.ts
git add apps/api/src/generated/clio-params.json
git add apps/api/src/services/clio-static-schema.ts
```

---

## Verification

```bash
# 1. Generator runs
npm run generate:clio-params
# Expected: 5 object types, ~20-25 params each

# 2. Generated file contains all params
cat apps/api/src/generated/clio-params.json | grep -c '"name"'
# Expected: ~100+ (all params across all types)

# 3. TypeScript compiles
npm run build:api

# 4. Tests pass
npm test
```

**Manual validation tests:**

| Input                                    | Expected                             |
| ---------------------------------------- | ------------------------------------ |
| `status: "open"`                         | Pass                                 |
| `status: "Open"`                         | Pass (normalized to lowercase)       |
| `status: "active"`                       | Fail: "Valid: open, closed, pending" |
| `matter_id: 123`                         | Pass (known param, no enum)          |
| `unknown_param: "xyz"`                   | Pass (fail open)                     |
| `assignee_id: 1` without `assignee_type` | Fail: "Add assignee_type"            |

---

## Why Examples Over Param Lists

**Param lists (old approach):**

```text
Matter: status (open|closed|pending), responsible_attorney_id [int64],
client_id [int64], practice_area_id [int64], ...25 more params
```

**Examples (new approach):**

```text
{"query": "Smith"} - text search
{"status": "open"} - status filter
{"matter_id": 123} - filter by matter
```

**Benefits:**

1. **Concise** - 5 lines vs 100+
2. **Pattern-based** - LLMs generalize from examples
3. **Zero maintenance** - no curating which params to show
4. **Matches user intent** - users say "open matters" not "status=open"

**Validation still catches errors** via the enum extraction. Best of both worlds.

---

## When to Regenerate

Run `npm run generate:clio-params` when:

- New `openapi.json` from Clio
- Adding/removing object types

The generated JSON is committed. Regeneration is manual and explicit.

---

## Task 7: Process Log Improvements

**Files:**

- `apps/web/app/routes/chat.$conversationId.tsx`
- `apps/api/src/do/tenant.ts`

The process log should give users a friendly "under the hood" view of what's happening. Non-technical but informative.

### Log Events to Emit from tenant.ts

Add SSE events for each stage:

```typescript
// When LLM decides to query Clio
emit("process", { stage: "thinking", text: "Looking up your matters..." });

// When validation catches an error (before hitting Clio)
emit("process", { stage: "validation", text: "Checking query parameters..." });

// If validation fails
emit("process", {
  stage: "error",
  text: "Hmm, that filter isn't quite right. Adjusting...",
});

// When calling Clio API
emit("process", { stage: "querying", text: "Searching Clio..." });

// When results come back
emit("process", { stage: "found", text: "Found 12 open matters" });

// When LLM is formatting response
emit("process", {
  stage: "formatting",
  text: "Putting together your answer...",
});
```

### Process Log Display Examples

**User asks:** "Show me my open matters"

```text
💭 Looking up your matters...
🔍 Searching Clio...
📋 Found 12 open matters
✨ Putting together your answer...
```

**Validation catches error (internal, user doesn't see raw error):**

```text
💭 Looking up active cases...
🔧 Adjusting search parameters...
🔍 Searching Clio...
📋 Found 8 matters
```

**Clio returns error:**

```text
💭 Looking up the Johnson case...
🔍 Searching Clio...
⚠️ Couldn't find that one. Trying a broader search...
🔍 Searching Clio...
📋 Found 3 possible matches
```

### Frontend Component Updates

In `chat.$conversationId.tsx`, render process events:

```tsx
{
  processLog.map((event, i) => (
    <div key={i} className="process-step">
      <span className="process-icon">{getIcon(event.stage)}</span>
      <span className="process-text">{event.text}</span>
    </div>
  ));
}
```

### Design Principles

1. **Friendly language** - "Looking up" not "Executing clioQuery"
2. **Progress feeling** - Each step shows movement
3. **Hide technical errors** - Validation failures become "Adjusting..."
4. **Show counts** - "Found 12 matters" gives confidence
5. **Subtle animation** - Steps fade in sequentially
