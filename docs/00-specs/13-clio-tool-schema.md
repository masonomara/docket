# Clio Tool Schema Improvement

## Overview

Replace the minimal tool schema guidance for the LLM with an embedded CLio API database schema reference directly in the tool schemas `filters` parameter description.

- Tool schemas are only processed only when the LLM considers using that tool. When:
  - LLM is considering tool use (not on greetings/explanations)
  - Tools are included in the request
- Documentation is at the decision point when LLM builds paramters.
- Tool schema is dedeicated space on "how to use this tool.

## Implementation

Update `getClioTools()` in `apps/api/src/do/tenant.ts`. Example implementaton:

```typescript
filters: {
  type: "object",
  description: `Query filters (vary by objectType):

MATTER:
- query: text search in description/display_number
- status: "Open" | "Pending" | "Closed"
- client_id: number (client's Contact ID)
- responsible_attorney: number (User ID)
- practice_area_id: number
- open_date: YYYY-MM-DD
- close_date: YYYY-MM-DD
- created_since: ISO 8601 datetime
- updated_since: ISO 8601 datetime

CONTACT:
- query: text search in name fields
- type: "Person" | "Company"
- is_client: boolean
- created_since: ISO 8601 datetime
- updated_since: ISO 8601 datetime

TASK:
- query: text search in name/description
- status: "pending" | "complete"
- assignee_id: number (User ID)
- assigner_id: number (User ID)
- matter_id: number
- due_at_from: ISO 8601 datetime
- due_at_to: ISO 8601 datetime

CALENDARENTRY:
- from: ISO 8601 datetime (required for list)
- to: ISO 8601 datetime (required for list)
- matter_id: number
- attendee_id: number (User ID)

TIMEENTRY:
- matter_id: number
- user_id: number
- date: YYYY-MM-DD
- created_since: ISO 8601 datetime

Date format: YYYY-MM-DD (e.g., 2024-01-15)
Datetime format: ISO 8601 (e.g., 2024-01-15T14:00:00Z)`
}
```

## Errors

When CLio returns `400`/`422`, include the error in the tool result to the LLM can self-correct. The LLM receives this feedback and can retry with corrected parameters or explain the issue to the user. Example implementaton:

```typescript
// In executeClioRead error handling
if (!result.success && result.error) {
  return {
    success: false,
    error: result.error.message,
    hint: result.error.clioError, // Clio's specific error message
  };
}
```
