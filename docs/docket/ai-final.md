[docketadmin.com](https://docketadmin.com)


Joe spent a year documenting everything he does into an organized knowledge base. He envisioned a chatbot that would pull industry expertise from his knowledge base, access organizational context users uploaded, connect to Salesforce, and work through Slack.

We hypothesized that combining industry knowledge, API calls, and organizational context through familiar interfaces would win. So we started building.

## on first version

I started helping Joe build this. He eventually decided to work with someone who wasn't a friend to avoid conflicts of interest. The door remains open to collaborate later. I'm sharing my research with him and the developer I recommended.

The first version connected Slack to a worker, read the knowledge base and org context, and executed API calls (shoddily). The LLM processed data well and responded fast. Authentication happened through a Slack link.

## on what was learned from the first version

The first version (a Slack fundraising bot) proved that API calls through Slack worked. Org context uploading was the problem.

To continue with a second version, I needed to find another industry to study.

## why lawyers and initial talks with lawyers

I needed to find a Salesforce-like tool specific to an industry. I know many lawyers. Clio is a growing CRM they love—some administrative assistants live on it.

I explored using Docket as a teaching tool for legal clinics. I created separate logins for clinics and firms.

One difficulty lawyers face is distinguishing between jurisdictions. I hadn't realized how much jurisdictions affect how cases proceed, or why that creates problems for lawyers. This meant separate knowledge bases per jurisdiction and practice type.

I didn't need precise legal content—a legaltech cofounder would handle that. I needed to test whether the LLM could distinguish between jurisdictions.

## Multichannel Architecture

This project taught me how useful Cloudflare Workers and Durable Objects are. They will lead AI infrastructure.

Durable Objects are stateful. They combine SQL, key-value storage, object storage, and vector databases—all sharing state and execution order.

The Worker creates a Durable Object for each organization. A channel interface function receives messages from Slack and Teams and normalizes them for the chatbot.

Docket connects to Slack, Teams, a web app, and Claude Desktop via MCP. Each interface has a service adapter that normalizes messages for the Worker.

## Multitenant Architecture

Each law organization has its own isolated Durable Object instance. Each Durable Object stores conversation history, custom field schemas, audit logs, and confirmation states in SQLite.

Durable Objects guarantee sequential execution—critical because the LLM accesses all state at once. Each Durable Object uses its own SQLite. Another org cannot access it. SQLite stores conversations, messages, and pending confirmations.

A processing worker orchestrates the Durable Object. The DO receives messages from the entrypoint worker.

## Auth Architecture

For Docket accounts, I chose Better Auth because it's free and has native Cloudflare Workers + D1 support. Better Auth stores user accounts, passwords, and sessions in D1. I liked owning the data instead of relying on an external service.

Better Auth handles web session cookies. I knew Slack and Teams would be harder, so owning the data gave flexibility to focus on those integrations.

For Teams, I used Microsoft's Bot Framework OAuthCard. This generated an access token and user profile, including their Microsoft email. The Worker receives this from Bot Framework and adds the email to D1 for future conversations.

Slack lacks a built-in SSO helper. The bot sends a Better Auth magic link to unrecognized users. When they click it, the Worker receives their Slack ID and stores it like the Teams email.

Adding a channel requires initial setup. Once auth works, the Channel Adapter normalizes messages and catches interface-specific issues. The Worker stays interface-agnostic.


## Working with RAG

Joe's documentation worked well with RAG. The knowledge base was embedded into Cloudflare Vectorize for semantic search.

## Agentic Developing

I developed most of this with Claude using spec-driven development. The technology was unfamiliar. Writing specs helped me understand the architecture and spot future problems early.

I wrote tests and made sure I understood what they should verify before running them. Development moved faster. But when tests fail, you need to understand why.

## On Interfaces

The first version targeted Slack exclusively. It validated that Slack could receive messages and execute API calls. From talking to lawyers, I learned Teams was their main work chat. Docket needed to support Teams.

I built a Teams proof of concept: created the app, got permissions, and validated OAuth with Clio.

During development, I pivoted to the web app. I needed a website anyway for account management, org context uploads, and future payments. The framework existed. Teams had high onboarding friction and felt like a black box.

The web chat was easier to debug for me and easier to understand for users. I built a web UI with conversation history, chat messages, and a real-time process log showing what sources the LLM reads. The process log made the LLM's reasoning visible.

{{ include photos of process log }}

The web UI uses Server-Sent Events (SSE). Message goes in, events stream back - content tokens as the LLM generates them, process updates for the sidebar, confirmation requests when the bot wants to write to Clio.

{{ confirmation messages }}

Users could test the bot without onboarding friction. The web app wasn't meant to be the main interface—just the easiest way to test.

Testing went from "Link your Teams, authenticate, tell me what it says" to "Go to docket.com, upload docs, tell me what you think."

## on Technical Architecture

Durable Objects are isolated stateful compute units with embedded SQLite—ideal for per-org data like conversations, pending actions, and status.

Workers are stateless and bind to Durable Objects and external services:

- D1 (global database stored user and org metadata, chunks of the knowledge base that the LLM would access)
- R2 database which would store objects that wouldn't be accessed often like uploaded files (which are parsed and embedded into D1), audit logs, and archives.
- Vectorize database pre-processed the knowledge base and the organizational embedded data from uploaded docs

Workers AI hosts the LLM and embedding model at unbeatable prices.

D1 handled user and org metadata, auth sessions, KB chunks, invitations, and subscriptions. The Durable Object SQLite held conversations, messages, pending confirmations, and the custom Clio schema caches that each law firm had.

D1 was for cross-tenant global lookups (user and org metadata). DO SQLite is physically isolated. Org A cannot access Org B's data. This satisfies data isolation requirements.

Workers are stateless. They receive normalized messages from the channel adapter.

Durable Objects are single-threaded—one request at a time. When a DO wakes from hibernation, the constructor runs migrations and loads schema inside `blockConcurrencyWhile()`. When a message arrives, the DO processes it completely before handling the next.

## on the chunks

I built a tool to upload the knowledge base from markdown files. Folder paths determine metadata—files in `/kb/jurisdictions/CA/` get tagged `jurisdiction: "CA"`, files in `/kb/practice-types/family-law/` get `practice_type: "family-law"`. General content and federal jurisdiction always get included for every org. When a California family law firm asks a question, Vectorize returns chunks from general, federal, California, and family law folders.

Vectorize doesn't support OR filters. If I want general OR federal OR California content, I can't write that as one query. I run parallel queries—one per filter—then merge results by score and deduplicate. An org with multiple jurisdictions might trigger 10+ parallel queries. They're fast and deduplication handles overlap.

Text is chunked at ~500 characters, stored in D1, and embedded in Vectorize. RAG locates relevant chunks through vector similarity, fetches the full text from D1, and injects it into the system prompt. Token budget caps it at ~3,000 tokens for RAG context - if there's too much relevant content, lower-scored chunks get dropped.

For org context uploads, I built the full pipeline: admin uploads a file through the web interface, server validates it (MIME type, magic bytes, 25MB limit), stores the raw file in R2 at `/orgs/{org_id}/docs/{file_id}`. Then Workers AI's `toMarkdown()` parses PDFs, DOCX, XLSX, and other formats into text. The text gets chunked, stored in D1's `org_context_chunks` table, embedded, and upserted to Vectorize with metadata `{ type: "org", org_id, source }`. The `type: "org"` filter keeps org context completely separate from the shared knowledge base in queries. Deletes work by removing all chunks with matching IDs from both D1 and Vectorize, then deleting the raw file from R2. Updates are just delete-then-reupload.

Worker receives user message → search Vectorize → get IDs → fetch full chunks from D1 → inject into prompt.

## on the tool calls

MCP requires tools, so I built with that in mind. Tools also let the AI interact with the database. A tool is a strict command the AI can call with parameters.

In the first version, I had the idea of creating 4 tools that could execute specific commands. Each tool took significant effort to build but had limited individual impact. The first version executed tools, but the scope was small. Worse, the AI struggled to choose which tool to use.

For Docket, I tried something different: an API call knowledge base that would help the tool build correct parameters. This failed. With conversation context and instructions combined, the LLM couldn't reliably build a proper tool call in one shot.

Multiple dedicated tools is the right approach. But if the API changes, you need monitoring—poll the docs, auto-shutdown on mismatch, manual restart. Someone must be available for that.

It would have been easier to build a routing layer that picks the tool, then let each tool handle its own parameters. Let the LLM choose which tool to call (non-deterministic), but make each tool's execution deterministic. Trying to consolidate all the tools cleverly backfired.

## On commanding Clio

The plan: everyone reads from Clio and the knowledge base. Only admins write to Clio. This becomes a pricing lever later.

I had to set up safeguards for Docket to use Clio data.

Testing revealed I'd underestimated the confirmation flow. The API could run Create, Read, and Delete—but I needed user consent before writes. Users needed to consent before execution, in terms they understood.

The Docket bot had to communicate back to the user before doing an edit, similar to how Claude Code asks before editing code. I emulated that. Pending confirmations live in DO state. The channel adapter needed bidirectional communication and a fast path for confirmations.

## technical Flow

CHANNEL INTERFACE
(Slack, Microsoft Teams, Web UI)

_sends MESSAGE to_

CHANNEL ADAPTER
The adapter extracts user/org context, normalizes the message, and queries D1 for `user_id`, `org_id`, and `role`.

_sends NORMALIZED MESSAGE to_

WORKER
Using the normalized message information

_ROUTES to_

TENANT DURABLE OBJECT
The DO stores the message in SQLite

- generates EMBEDDING with WORKERS AI
- Queries VECTORIZE for knowledge base + org context chunks
- Builds a prompt with a schema for prompt building from the DO memory cache
- Calls LLM again (WORKERS AI)
- If a tool call is needed, it validates user permissions and executes the Clio API
- if the command to Clio was a Create/Update/Delete call rather than just a read function, ask the user a follow-up question - similar to how Claude Code asks you to validate before it commits to something {{ screenshot of this }}

## Example Flow

A user messages "What cases do I have next week" in a channel such as Microsoft Teams, Slack, or the Web App. The message arrives at the Slack adapter as JSON with channel ID, user metadata, and timestamps. The Channel Adapter normalizes the message and queries D1 for the user record, org metadata, and role. The adapter sends a clean, normalized message with user and org context to the Worker.

The Worker routes this message directly to the correct Durable Object. The Durable Object wakes from hibernation and stores the message in SQLite. This becomes conversation history the LLM can access. The DO generates an embedding of the message using Workers AI—a vector representation for RAG.

The embedding queries Vectorize twice in parallel: once against the shared Knowledge Base, once against the org's uploaded context. Vectorize returns IDs of semantically similar chunks. D1 stores the full chunk text, which gets retrieved.

The chunks, user message, and conversation history become parameters for the system prompt. The Clio schema from the memory cache attaches to the prompt so the LLM knows what objects exist in the org's Clio. All of this fits in one context window—whether a web conversation or a Slack/Teams thread.

Cloudflare's Workers AI runs the LLM. If the LLM decides to call the Clio API, we validate user permissions. Reads execute immediately. Writes store a pending confirmation in the DO and send back "Are you sure you want to ___?" for the user to accept or deny.

The LLM response flows through the Worker to the Channel Adapter, which reformats it for the channel and sends it to the user.

Durable Objects ensure sequential execution—no race conditions. The DO processes each message completely before the next. Every operation is logged.

## on Retrospective

The winning structure didn't materialize. I'm still building Docket because I believe in combining org context, knowledge base, and API calls. The scope needs to shrink.

Giving an LLM unconstrained access to an API you don't control is dangerous. Talking to it felt like relearning Clio's commands.

Shoehorning this technology into third-party APIs was a mistake. RAG worked well. Cloudflare's file parsing worked well. But giving an AI unchecked access to an external API needs guardrails I didn't want to build.

The tool felt needless. You had to describe things a specific way to get results—might as well learn Clio directly. Poor results with no one to blame.
