# Docket Clio Integration

## Clio Development

To build with the Clio API, you need a Clio account. Then create a Clio developer application from the developer portal.

## Clio API

Base URL: `https://app.clio.com/api/v4/`

**Core objects** (read/write via tools):

- Matters - cases/files
- Contacts - clients, opposing parties, witnesses
- Tasks - todos, deadlines
- Calendar Entries - appointments, court dates
- Time Entries - billable time
- Documents - file metadata (content via separate endpoint)

**Read-only objects** (reference data):

- Practice Areas
- Activity Descriptions
- Users (firm staff)

## Clio Custom Fields

Clio has no schema introspection API - base object fields are documented in the API Reference and known to the LLM. Only custom fields (firm-specific) need to be fetched dynamically.

**Fetch custom fields per-org:**

```
GET /api/v4/custom_fields.json?parent_type=Matter&deleted=false
GET /api/v4/custom_fields.json?parent_type=Contact&deleted=false
```

Cached in DO SQLite with `fetched_at` timestamp. Lazy refresh (automatic, no user action):

- First Clio API call (no cached custom fields)
- Cache older than 1 hour (checked on each Clio API call)
- Developer bumps `CLIO_SCHEMA_VERSION`

## Clio OAuth

Per-user tokens stored encrypted in DO Storage (AES-GCM). Access tokens expire after 7 days; refresh tokens don't expire but can be revoked. For security: PKCE required (S256), state signed with HMAC-SHA256 (10-min expiry).

## Clio Multi-Tenant Architecture

Clio's OAuth model supports multi-tenant applications. Each user authorizes Docket independently via OAuth, so each authorization creates a distinct `access_token` for that user. Tokens are per-user, not per-firm. Docket stores tokens in DO Storage keyed by `user_id`. Rate limits apply per access token, so heavy usage by one firm doesn't affect others. Each org's DO stores its users' Clio tokens in DO Storage (encrypted AES-GCM). Cross-org token access is architecturally impossible—DOs are isolated by `org_id`

## Clio Request Body Format

**POST/PATCH body structure:**

```json
{
  "data": {
    "field1": "value1",
    "field2": "value2"
  }
}
```

Do NOT nest under object type. This is wrong:

```json
{
  "data": {
    "contact": { "first_name": "Test" }
  }
}
```

This is correct:

```json
{
  "data": {
    "first_name": "Test",
    "last_name": "Smith",
    "type": "Person"
  }
}
```

**Contact required fields:**

- `type`: Must be `"Person"` or `"Company"`
- For Person: `first_name` and `last_name`
- For Company: `name`

**Matter required fields:**

- `description`: Matter title
- `client`: Contact ID reference (the client must exist first)

## Clio Error Handling

**HTTP error codes and responses:**

- 400 (Bad Request): "The request was invalid. Please try rephrasing.", log, don't retry
- 401 (Unauthorized): "Your Clio connection expired. Please reconnect at docket.com/settings.", attempt token refresh; if fails, mark `clio_connected=false`
- 403 (Forbidden): "You don't have permission to access this in Clio.", log, don't retry
- 404 (Not Found): "That record wasn't found in Clio.", don't retry
- 410 (Gone): "This API version is no longer supported.", alert ops, critical error
- 422 (Unprocessable): "Clio rejected the request—some fields may be missing or invalid.", don't retry
- 429 (Rate Limited): "Clio is busy. Please wait a moment and try again.", wait `Retry-After` seconds
- 500+ (Server Error): "Clio is having issues. Please try again shortly.", retry once after 2s

**API Rate Limits:**

50 requests/minute per access token on peak hours is no cause for concern
