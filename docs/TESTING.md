# Testing Commands

Quick reference for E2E testing before Phase 9 onboarding UI exists.

## Create Test User

```bash
wrangler d1 execute DB --local --command="
INSERT INTO user (id, name, email, email_verified)
VALUES ('test-user-1', 'Test User', 'test@example.com', 0);
"
```

## Create Test Organization

Requires a user to exist first:

```bash
wrangler d1 execute DB --local --command="
INSERT INTO org (id, name, jurisdiction, practice_type, firm_size)
VALUES ('test-org-1', 'Test Firm', 'CA', 'personal-injury', 'small');

INSERT INTO org_members (id, user_id, org_id, role, is_owner)
VALUES ('mem-001', 'test-user-1', 'test-org-1', 'admin', 1);

INSERT INTO subscriptions (id, org_id, tier, status)
VALUES ('sub-001', 'test-org-1', 'free', 'active');
"
```

For remote, add `--remote` flag instead of `--local`.

## Verify Organization

```bash
wrangler d1 execute DB --local --command="
SELECT o.id, o.name, om.user_id, om.role, om.is_owner
FROM org o
JOIN org_members om ON om.org_id = o.id;
"
```

## Delete Test Organization

```bash
wrangler d1 execute DB --local --command="
DELETE FROM org WHERE id = 'test-org-1';
"
```

Cascades to: `org_members`, `subscriptions`, `workspace_bindings`, `invitations`, `api_keys`, `org_context_chunks`.

## Run Tests

```bash
# Unit tests (local)
npm test

# Integration tests (requires remote bindings)
npm test -- --remote
```

## Demo Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Auth demo (signup/login) |
| `/demo/kb` | Knowledge Base + RAG |
| `/demo/org-membership` | User leaves org |
| `/demo/org-deletion` | Org deletion |
