# Docket

An AI assistant for law firms that use Clio. Users chat through Microsoft Teams, Slack, or MCP clients. The bot can answer questions about cases, look up firm procedures, and execute operations in Clio.

## How It Works

```
User → Chat Channel → Worker → Durable Object → AI + Clio → Response
```

Each organization gets its own Durable Object that manages conversations, settings, and Clio credentials. The Worker routes incoming messages to the right org's DO.

## Storage

| Store     | Scope             | Contents                                             |
| --------- | ----------------- | ---------------------------------------------------- |
| D1        | Shared            | Auth, org registry, Knowledge Base chunks            |
| Vectorize | Shared (filtered) | Embeddings for KB and org documents                  |
| DO SQLite | Per-org           | Conversations, messages, settings, Clio schema cache |
| DO KV     | Per-org           | Encrypted Clio OAuth tokens                          |
| R2        | Per-org paths     | Uploaded documents, audit logs                       |

## Getting Started

```bash
git clone <repo-url>
cd docket
npm install
```

Copy the example env files:

```bash
cp apps/api/.dev.vars.example apps/api/.dev.vars
# Edit .dev.vars with your Clio credentials and secrets
```

Run the API and web app in separate terminals:

```bash
npm run dev:api   # http://localhost:8787
npm run dev:web   # http://localhost:5173
```

## Running Tests

```bash
npm test          # Unit tests
npm run test:e2e  # End-to-end tests
npm run test:all  # Both
```

## Database Migrations

```bash
cd apps/api

# Local development
npx wrangler d1 migrations apply docket-db --local

# Production
npx wrangler d1 migrations apply docket-db --remote
```

## User Roles

- **Owner** — Full Clio access, can manage the organization and transfer ownership
- **Admin** — Full Clio access, can manage settings and invite users
- **Member** — Read-only Clio access, no org management

## Documentation

Detailed specs are in `/docs/00-specs/`:

- `00-overview` — Product overview
- `01-user-flows` — User journeys
- `02-technical-foundation` — Architecture
- `03-storage-schemas` — Database schemas
- `04-auth` — Authentication
- `05-channel-adapter` — Teams/Slack/MCP adapters
- `06-durable-objects` — Per-org state
- `07-knowledge-base` — RAG implementation
- `08-workers-ai` — LLM integration
- `09-clio-integration` — Clio API

## Tech Stack

Cloudflare Workers, Durable Objects, D1, Vectorize, R2, Workers AI (Llama 3.1), React Router 7, TypeScript, Zod, Drizzle ORM, Better Auth.
