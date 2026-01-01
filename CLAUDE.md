# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

**Before starting work, read the numbered docs in `/docs/00-specs`.**

## What is Docket?

Docket is an AI assistant for law firms that use Clio (legal practice management software). Users chat with the bot through the web interface, Teams, Slack, or MCP clients. The bot can look up case information, answer questions about firm procedures, and perform operations in Clio.

**Current status:** Phases 2-9 complete. Phase 9b (web chat interface) in progress.

## Project Structure

```
apps/api/      Cloudflare Worker + Durable Object
apps/web/      React Router 7 frontend on Cloudflare Workers
packages/shared/   Shared types and Zod schemas
```

## How Data is Stored

- **D1** — Shared database for auth, organizations, and Knowledge Base content
- **Vectorize** — Embeddings for semantic search (filtered by org)
- **DO SQLite** — Per-organization conversations, messages, and settings
- **DO KV** — Encrypted Clio OAuth tokens (per-organization)
- **R2** — Document storage and audit logs

## Naming Conventions

Use Title Case for product components: Knowledge Base, Org Context, Clio Schema, Durable Object, Workers AI.

Common abbreviations: DO (Durable Object), KB (Knowledge Base).

## Logging

Use the structured logger from `lib/logger.ts`. All logs are JSON and include a `requestId` for tracing requests through the system.

## Known Issues

1. **DO SQLite in vitest** — The vitest-pool-workers plugin can't test Durable Object SQLite (SQLITE_AUTH error). Use the `/demo/clio` endpoint for manual testing instead.

2. **RAG integration tests** — Require remote Vectorize bindings and metadata indexes. Setup:
   - `CLOUDFLARE_ACCOUNT_ID` in test command (already set in package.json)
   - `remoteBindings: true` in vitest.config.mts (already configured)
   - Metadata indexes created on `docket-kb` Vectorize index for: `type`, `category`, `jurisdiction`, `practice_type`, `firm_size`, `org_id`
   - Tests may be flaky due to Vectorize eventual consistency (45s wait)

## Code Philosophy

Omit needless code. A file should have no unnecessary functions. Lower numbered docs are sources of truth over higher numbered ones.

Vigorous writing is concise. A line should contain no unnecessary characters, a file no unnecessary functions, for the same reason that a drawing should have no unnecessary lines and a machine no unnecessary parts. Happy talk must die. Instructions must die. Omit needless code.
Check consistency often between documents. Remove unnecessary interdependencies and relationships. Lower numbered documents serve as sources of truths over higher numbers documents.
