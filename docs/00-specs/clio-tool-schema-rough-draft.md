# Clio Tool Schema Enhancement

## Problem

The LLM generates invalid Clio API parameters because the tool schema provides minimal guidance. Current `filters` description:

```
"Query filters for list operations. Use 'query' for text search...
Other filters: 'status', 'created_since', 'updated_since'."
```

The LLM doesn't know valid status values, date formats, or object-specific filters. It guesses.

## Solution

Embed Clio API filter reference directly in the tool schema's `filters` parameter description. This follows the proven "SQL Agent" pattern from the OpenAI Cookbook, where database schema is embedded in the tool definition.

## Why Tool Schema (Not System Prompt)

1. **Context efficiency** — Tool schemas only processed when LLM considers using that tool. No token cost on non-Clio queries.
2. **Proximity** — Documentation is at the decision point when LLM builds parameters.
3. **Focused** — System prompts get long; important details get buried. Tool schema is dedicated space for "how to use this tool."

## Implementation

Update `getClioTools()` in `apps/api/src/do/tenant.ts`:

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

## Error Feedback

When Clio returns 400/422, include the error in the tool result so the LLM can self-correct:

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

The LLM receives this feedback and can retry with corrected parameters or explain the issue to the user.

## Validation

Test queries that previously failed:

| Query                         | Expected Tool Call                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| "Show me open matters"        | `objectType: "Matter", filters: { status: "Open" }`                                          |
| "Tasks due this week"         | `objectType: "Task", filters: { due_at_from: "<monday>", due_at_to: "<sunday>" }`            |
| "Find John Smith"             | `objectType: "Contact", filters: { query: "John Smith" }`                                    |
| "My calendar for tomorrow"    | `objectType: "CalendarEntry", filters: { from: "<tomorrow 00:00>", to: "<tomorrow 23:59>" }` |
| "Time entries for matter 123" | `objectType: "TimeEntry", filters: { matter_id: 123 }`                                       |

## Token Cost

Filter documentation adds ~400 tokens to the tool schema. This is only processed when:

1. LLM is considering tool use (not on greetings/explanations)
2. Tools are included in the request

Compared to system prompt inclusion (every request), this is more efficient.

## Future Enhancements

If queries remain unreliable after this change:

1. **Separate tools per object type** — `searchMatters`, `searchContacts`, etc. with object-specific schemas and enums
2. **Few-shot examples** — Add 2-3 example tool calls to system prompt
3. **Intent extraction** — Two-step: LLM outputs intent, code builds query
