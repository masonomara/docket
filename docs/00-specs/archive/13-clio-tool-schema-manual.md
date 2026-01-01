# Clio Tool Schema Improvement

## Problem

The LLM generates invalid Clio API parameters because the current tool schema provides minimal guidance. The `filters` description says only:

```
"Query filters for list operations. Use 'query' for text search...
Other filters: 'status', 'created_since', 'updated_since'."
```

The LLM doesn't know valid status values, date formats, or object-specific filters—so it guesses incorrectly.

## Solution

1. Embed Clio API filter reference in the tool schema's `filters` parameter
2. Validate filters before calling Clio
3. Format Clio errors as actionable feedback for LLM retry

## Task 1: Update Tool Schema

**File:** `apps/api/src/do/tenant.ts`
**Function:** `getClioTools()` (line 764)

Replace the `filters` property definition:

```typescript
filters: {
  type: "object",
  description: `Query filters (vary by objectType):

MATTER:
- query: text search in description/display_number/client name
- status: "open" | "pending" | "closed" (lowercase, comma-separated ok)
- client_id: number
- responsible_attorney_id: number
- practice_area_id: number
- open_date[]: ">=YYYY-MM-DD" or "<=YYYY-MM-DD"
- close_date[]: ">=YYYY-MM-DD" or "<=YYYY-MM-DD"
- created_since: ISO 8601 datetime
- updated_since: ISO 8601 datetime

CONTACT:
- query: text search (name, email, phone, address, company)
- type: "Person" | "Company"
- client_only: boolean (true = only clients)
- created_since: ISO 8601 datetime
- updated_since: ISO 8601 datetime

TASK:
- query: text search in name/description
- status: "pending" | "in_progress" | "in_review" | "complete" | "draft"
- complete: boolean (simpler alternative to status)
- assignee_id: number (requires assignee_type)
- assignee_type: "user" | "contact" (required with assignee_id)
- assigner_id: number
- matter_id: number
- priority: "high" | "normal" | "low"
- due_at_from: YYYY-MM-DD
- due_at_to: YYYY-MM-DD

CALENDARENTRY:
- from: ISO 8601 datetime (filter events ending on/after)
- to: ISO 8601 datetime (filter events starting on/before)
- matter_id: number
- query: text search
- is_all_day: boolean

ACTIVITY (for time entries):
- type: "TimeEntry" | "ExpenseEntry"
- matter_id: number
- user_id: number
- start_date: YYYY-MM-DD
- end_date: YYYY-MM-DD
- status: "billed" | "unbilled" | "draft" | "non_billable"
- created_since: ISO 8601 datetime

All endpoints: limit 1-200 (default 200), query returns max 200 results.
Date: YYYY-MM-DD | Datetime: ISO 8601 (2024-01-15T14:00:00Z)`
}
```

## Task 2: Update Endpoint Mapping

**File:** `apps/api/src/services/clio-api.ts`

The current `OBJECT_ENDPOINTS` mapping needs updating. TimeEntry queries should use the Activities endpoint:

```typescript
const OBJECT_ENDPOINTS: Record<string, string> = {
  matter: "matters",
  contact: "contacts",
  task: "tasks",
  calendar_entry: "calendar_entries",
  calendarentry: "calendar_entries",  // alias
  activity: "activities",             // for time entries
  timeentry: "activities",            // alias - routes to activities
  time_entry: "activities",           // alias
  document: "documents",
  practice_area: "practice_areas",
  activity_description: "activity_descriptions",
  user: "users",
};
```

## Task 3: Add Filter Validation

**File:** `apps/api/src/services/clio-api.ts`

Add validation function after the endpoint mapping:

```typescript
interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
}

const VALID_STATUS: Record<string, string[]> = {
  matter: ["open", "pending", "closed"],
  task: ["pending", "in_progress", "in_review", "complete", "draft"],
  activity: ["billed", "unbilled", "draft", "non_billable", "billable", "written_off"],
};

const VALID_ENUMS: Record<string, Record<string, string[]>> = {
  contact: { type: ["Person", "Company"] },
  task: {
    priority: ["high", "normal", "low"],
    assignee_type: ["user", "contact"],
  },
  activity: { type: ["TimeEntry", "ExpenseEntry"] },
};

export function validateFilters(
  objectType: string,
  filters?: Record<string, unknown>
): ValidationResult {
  const type = objectType.toLowerCase().replace("_", "");

  if (!filters) return { valid: true };

  // Validate status values
  if (filters.status && VALID_STATUS[type]) {
    const status = String(filters.status).toLowerCase();
    const validValues = VALID_STATUS[type];
    if (!validValues.includes(status)) {
      return {
        valid: false,
        error: `Invalid status "${filters.status}" for ${objectType}.`,
        suggestion: `Valid values: ${validValues.join(", ")}`,
      };
    }
  }

  // Validate enum fields
  const typeEnums = VALID_ENUMS[type];
  if (typeEnums) {
    for (const [field, validValues] of Object.entries(typeEnums)) {
      if (filters[field] && !validValues.includes(filters[field] as string)) {
        return {
          valid: false,
          error: `Invalid ${field} "${filters[field]}" for ${objectType}.`,
          suggestion: `Valid values: ${validValues.join(", ")}`,
        };
      }
    }
  }

  // Task-specific: assignee_id requires assignee_type
  if (type === "task" && filters.assignee_id && !filters.assignee_type) {
    return {
      valid: false,
      error: "assignee_id requires assignee_type to be specified.",
      suggestion: 'Add assignee_type: "user" or "contact"',
    };
  }

  return { valid: true };
}
```

## Task 4: Update executeClioRead for Validation and Error Feedback

**File:** `apps/api/src/do/tenant.ts`
**Function:** `executeClioRead()` (line 1197)

```typescript
private async executeClioRead(
  userId: string,
  args: {
    objectType: string;
    id?: string;
    filters?: Record<string, unknown>;
  }
): Promise<string> {
  // Validate filters before calling Clio
  if (!args.id) {
    const validation = validateFilters(args.objectType, args.filters);
    if (!validation.valid) {
      if (validation.missingRequired) {
        return `I need more information to search ${args.objectType}s. Please provide: ${validation.missingRequired.join(", ")}.`;
      }
      return `Filter error: ${validation.error}`;
    }
  }

  const accessToken = await this.getValidClioToken(userId);
  if (!accessToken) {
    return "You haven't connected your Clio account yet. Please connect at docket.com/settings to enable Clio queries.";
  }

  // Refresh schema if needed
  if (customFieldsNeedRefresh(this.schemaVersion, this.customFieldsFetchedAt)) {
    await this.refreshCustomFieldsWithToken(accessToken);
  }

  try {
    const endpoint = buildReadQuery(args.objectType, args.id, args.filters);
    let result = await executeClioCall("GET", endpoint, accessToken);

    // Handle token expiration (unchanged)
    if (!result.success && result.error?.status === 401) {
      const refreshedToken = await this.handleClioUnauthorized(userId);
      if (refreshedToken) {
        result = await executeClioCall("GET", endpoint, refreshedToken);
        if (result.success) {
          return formatClioResponse(args.objectType, result.data);
        }
      }
      return "Your Clio connection has expired. Please reconnect at docket.com/settings.";
    }

    if (result.success) {
      return formatClioResponse(args.objectType, result.data);
    }

    // Format error for LLM self-correction
    const errorDetail = result.error?.clioError
      ? ` Clio says: "${result.error.clioError}"`
      : "";
    return `Clio query failed: ${result.error?.message}${errorDetail} Please check the filters and try again.`;

  } catch {
    return "An error occurred while fetching data from Clio. Please try again.";
  }
}
```

## Task 5: Update Tool objectType Enum

**File:** `apps/api/src/do/tenant.ts`
**Function:** `getClioTools()` (line 764)

Update the objectType enum to include Activity and clarify TimeEntry routing:

```typescript
objectType: {
  type: "string",
  enum: [
    "Matter",
    "Contact",
    "Task",
    "CalendarEntry",
    "Activity",  // Use for time entries and expenses
  ],
  description: "The Clio object type. Use Activity for time entries.",
},
```

## Task 6: Add Retry Logic to Tool Call Handler

**File:** `apps/api/src/do/tenant.ts`
**Function:** `executeSingleToolCall()` (line 858)

Add retry tracking and limit retries to 1:

```typescript
private async executeSingleToolCall(
  message: ChannelMessage,
  toolCall: ToolCall,
  retryCount = 0
): Promise<string> {
  if (toolCall.name !== "clioQuery") {
    return `Unknown tool: ${toolCall.name}`;
  }

  const { operation, objectType, id, filters, data } = toolCall.arguments;

  if (operation !== "read" && message.userRole !== "admin") {
    return `You don't have permission to ${operation} ${objectType}s. Only Admins can make changes.`;
  }

  if (operation === "read") {
    const result = await this.executeClioRead(message.userId, { objectType, id, filters });

    // If error and haven't retried, let LLM try to self-correct
    const isError = result.includes("failed") || result.includes("error") || result.includes("Invalid");
    if (isError && retryCount === 0) {
      // Return error to LLM for potential self-correction in next turn
      return result;
    }

    return result;
  }

  // Write operations unchanged...
  await this.createPendingConfirmation(
    message.conversationId,
    message.userId,
    operation,
    objectType,
    data || {}
  );

  return this.buildConfirmationPrompt(operation, objectType, data);
}
```

## Verification

Test these queries after implementation:

| User Query | Expected Tool Call |
|------------|-------------------|
| "Show me open matters" | `objectType: "Matter", filters: { status: "open" }` |
| "Tasks due this week" | `objectType: "Task", filters: { due_at_from: "2024-01-15", due_at_to: "2024-01-21" }` |
| "My calendar tomorrow" | `objectType: "CalendarEntry", filters: { from: "2024-01-16T00:00:00Z", to: "2024-01-16T23:59:59Z" }` |
| "Find client John Smith" | `objectType: "Contact", filters: { query: "John Smith", client_only: true }` |
| "Time entries for matter 123" | `objectType: "Activity", filters: { matter_id: 123, type: "TimeEntry" }` |
| "Tasks assigned to me" | `objectType: "Task", filters: { assignee_id: <user_id>, assignee_type: "user" }` |

**Error cases:**

| Input | Expected Behavior |
|-------|-------------------|
| `status: "Open"` (Title Case) | Validation normalizes to lowercase, query succeeds |
| `assignee_id: 123` without `assignee_type` | Validation error: "assignee_id requires assignee_type" |
| `status: "active"` for Matter | Validation error with suggestion: "Valid values: open, pending, closed" |

## Task 7: Add `fields` Parameter for Efficient Queries

**File:** `apps/api/src/do/tenant.ts`
**Function:** `getClioTools()` (line 764)

Add `fields` parameter to tool schema. This lets the LLM request only needed data:

```typescript
fields: {
  type: "string",
  description: `Optional: comma-separated fields to return. Reduces response size.

MATTER fields: id, display_number, description, status, open_date, close_date, billable, billing_method
  Nested: client{id,name}, responsible_attorney{id,name}, practice_area{id,name}, matter_stage{name}

CONTACT fields: id, name, first_name, last_name, type, title, company, email, phone
  Nested: primary_email_address{address}, primary_phone_number{number}

TASK fields: id, name, description, status, priority, due_at, completed_at
  Nested: matter{id,display_number}, assignee{id,name}

CALENDARENTRY fields: id, summary, description, start_at, end_at, all_day, location
  Nested: matter{id,display_number}, attendees{id,name,type}

ACTIVITY fields: id, type, date, quantity, note, total, billed
  Nested: matter{id,display_number}, user{id,name}

Example: fields=id,display_number,client{name},status`
}
```

**File:** `apps/api/src/services/clio-api.ts`
**Function:** `buildReadQuery()`

Add fields parameter support:

```typescript
export function buildReadQuery(
  objectType: string,
  id?: string,
  filters?: Record<string, unknown>,
  fields?: string  // NEW
): string {
  const endpoint = OBJECT_ENDPOINTS[objectType.toLowerCase()];
  if (!endpoint) {
    throw new Error(`Unknown object type: ${objectType}`);
  }

  const params = new URLSearchParams();

  // Add fields parameter if specified
  if (fields) {
    params.append("fields", fields);
  }

  // ... rest of filter handling
}
```

## Task 8: Add Default Fields per Object Type

**File:** `apps/api/src/services/clio-api.ts`

Define sensible defaults to reduce response size when LLM doesn't specify fields:

```typescript
const DEFAULT_FIELDS: Record<string, string> = {
  matter: "id,display_number,description,status,open_date,client{id,name},responsible_attorney{id,name}",
  contact: "id,name,type,primary_email_address{address},primary_phone_number{number}",
  task: "id,name,status,priority,due_at,matter{id,display_number},assignee{id,name}",
  calendarentry: "id,summary,start_at,end_at,all_day,matter{id,display_number}",
  activity: "id,type,date,quantity,note,total,matter{id,display_number},user{id,name}",
};

export function buildReadQuery(
  objectType: string,
  id?: string,
  filters?: Record<string, unknown>,
  fields?: string
): string {
  const type = objectType.toLowerCase();
  const endpoint = OBJECT_ENDPOINTS[type];

  const params = new URLSearchParams();

  // Use specified fields or defaults
  const requestFields = fields || DEFAULT_FIELDS[type];
  if (requestFields) {
    params.append("fields", requestFields);
  }

  // ... rest
}
```

## Future: Generate Schema from OpenAPI

The `openapi (1).json` file (2.8MB) is the authoritative Clio API spec. Consider:

1. **Build-time extraction**: Script to parse OpenAPI and generate `clio-schema.json`
2. **Auto-generate tool schema**: Build the filters description from extracted data
3. **Auto-generate validation**: VALID_STATUS, VALID_ENUMS derived from OpenAPI enums
4. **Stay in sync**: Re-run when Clio updates their API

Benefits:
- Single source of truth
- Eliminates manual maintenance errors
- Richer validation (all enums, all parameters)
- Type safety

This is a larger refactor for a future iteration.

## Important: Status Value Casing

From OpenAPI spec:
- **Query filters**: lowercase (`open`, `pending`, `closed`)
- **Response values**: Title Case (`Open`, `Pending`, `Closed`)

Validation should normalize input to lowercase. LLM responses should expect Title Case in returned data.

## Source

Filter parameters verified against Clio OpenAPI spec (`openapi (1).json`).

## Token Cost

Filter documentation adds ~600 tokens to tool schema (with fields). Only processed when LLM considers tool use—not on greetings or explanations.
