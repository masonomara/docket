# Docket

## Metadata

Title: Docket
Subtitle: AI legal assistant with RAG and third-party API integration
URL: docket.omaratechnologydesign.com

---

## The E-Myth Revisited

Docket began as a collaboration with Joe, a tech-savvy friend who runs a nonprofit fundraising agency. We both read "The E-Myth" by Michael Gerber around the same time and were completely enthralled.

Gerber's thesis is that most small businesses need another version of yourself to run. Your ultimate goal is to remove yourself from the business. Small business owners struggle with becoming too tightly absorbed within their own operations. The e-myth system is tightly documenting everything you do, identifying what can be delegated, identifying what is needless, and then focusing on delegation.

When Gerber wrote the book in 1998, delegation meant hiring people. Having an assistant to read and revise all your emails included the overhead of at least a part-time employee. Reading this book in 2025 expands the possibilities. Now that's available for free on ChatGPT. Take it another layer deeper and we have agentic engineers working on replacing entire software teams.

Joe spent a year documenting his work and organizing it into a KNOWLEDGE BASE of fundraising best practices and processes. This was as granular as how to format and date a document. How would you define what is fundraising? How would you define what is a large donor? How would you describe when to reengage? These are Joe's best practices, not the best practices you'll find in a textbook

Joe was also concerned that every company has their own set of operating procedures and foundaional context that woudl be neccesary to be genuinely helpful. The ORGANIZATIONAL CONTEXT was born.

There needed to be a hook, what started as read calls from Salesforce, a CRM joes clients are exclusive to. The ability to pull of context from people's crm woudl be super helpful. As a hook, it grew into something a little more ambitous with full CRUD operations.

The fourth thing Joe came up with was that his clients exclusively use slack. How can we make them nto switch context? This would be the definive hook. Building out a chatbot for slack in soe,m ways proved less complicated then a web chatbot, setting up proper observability tools woyuld have beena. good call here, isntead i releid on web for more simple observability.

Industry Knolwedge Base + Practical API Calls + Organizational Context was the trio rtet that woudl make yourself integrated and useful for businesses, and the slack/team integration would be the interface you woudl connect with.

## The First Iteration

Joe's documentation was wonderful, and even formatted for RAG really well. I built out a chatbot that connected to Slack and could communicate through RAG and vector embeddings. This was my first introduction to Cloudflare architecture.

Durable Objects are stateful storage objects delivered by Cloudflare. I chose them over other storage options because the idea that each tenant would have their own object to work out of was very appealing. Durable Objects are like a blender of different storage types—D1 database, R2 storage buckets, vectorized database, alarms, and seamless connection to Workers.

The FundraisingAgent DO sets up one instance per tenant. When a message from Slack is received, the Worker initially handles it. The Worker calls the FundraisingAgent DO which loads up from hibernating. The constructor runs, the schema creates all tables, the schemaCache loads all the Salesforce schema into memory, concurrency is blocked while everything is initializing, and then everything is fetched and ready to roll.

**Operations always appear in sequence.** This is the magic of Durable Objects.

The multichannel architecture exists so users' Durable Objects maintain state between Slack and MCP calls (ChatGPT/Claude Desktop). But more importantly, it maintains flexibility so end users can be "met where they like to be"—users do not need to download an app. Unified messages make the medium of interaction agnostic.

Users thought it was extremely interesting, but it needed a lot of refinement. The knowledge base was incomplete and the Salesforce API calls were functional but did not work as well as expected.

One quote stuck with me:

> "Now you can get rid of the middle man, be it a developer or a content editor, and screw your site up totally by yourself. You'll just have to get used to describing things in a very specific way to get what you want, which will take up all of your time. It'll produce poorer results, and you have nobody to blame. Please take my money."

People were excited. The solution forward seemed to niche down, create a separate CMS tightly coupled with the chatbot AI functionalities.

---

## Pivot to Legal

The project with Joe ended. I took his hypothesis and started thinking about ways to apply this formula to other domains.

Legal work emerged as the target. Law firms using Clio face the same documentation and delegation challenges Joe faced with Salesforce.

I became obsessed with Cloudflare after working on the first iteration. The architecture enables edge-first deployment for low latency, stateful isolation with one Durable Object per organization, integrated AI without external API calls, and unified storage all working together.

The Durable Object model was particularly compelling for legal:

- Each law firm gets isolated state
- Conversations and operations maintain sequence
- Audit trails are natural (every operation flows through the DO)
- OAuth tokens stay encrypted per-tenant

---

## Designing for Chatbots

I wired it up with Teams, Slack, and an on-screen chatbot. The web chatbot wasn't the original plan or best approach, but development was taking longer and I wanted something frictionless for users to test with.

All channels translate to a unified message format. A message from Slack goes through the SlackBot UI and is received by a webhook set up in the workspace. The Slack Channel adapter extracts the message to the unified format for Durable Object processing. The adapter handles webhook verification, event routing, and response formatting.

A critical architectural decision from the first iteration: rather than multiple tools (one per API operation), the LLM receives a single tool with structured parameters. This pattern emerged from the Salesforce bot—multiple tools caused unpredictable tool selection, leading to user confusion. Single tool is more reliable.

All Create, Update, Delete operations require explicit user confirmation. The LLM returns a CUD request, the DO stores it as a pending confirmation with a 24-hour TTL, the user sees a human-readable summary, and only after approval does execution happen. This satisfies the legal requirement that humans authorize changes to case data.

---

## Legal Consciousness

Legality was staring me down throughout the process. I considered legal structures throughout but didn't really act upon it other than writing. Fair to say I was conscious of it and knew it wouldn't be a cakewalk.

Key constraints I held in mind:

- Attorney-client privilege—conversations may be privileged
- Unauthorized practice of law—the bot cannot give legal advice
- Malpractice liability—errors have real consequences
- Data residency—some firms have jurisdiction requirements
- Audit requirements—every operation must be traceable

The system prompt enforces: "NEVER give legal advice—you manage cases, not law." But prompt instructions aren't sufficient. Additional safeguards include audit logging for every Clio operation, confirmation gates for CUD operations, source attribution on RAG chunks, and role-based permissions where members can read but only admins can write.

The encryption uses PBKDF2 which is designed to prevent brute force attacks by encrypting with the user password, tenant ID, and master secret. This makes it so if any single point of failure occurs—tenant org hacked, master secret discovered, encryption strategy reverse engineered—it's impossible to break the encryption without knowing all three points of attack.

---

## What I Learned

**From the first iteration:**

1. Running software through chat apps works—users don't need a new app
2. The architecture scales—Channel Adapters → Workers → Vector DB → RAG → DOs
3. Structured parameters prevent non-determinism—LLMs picking tools is unreliable
4. Single tool is more reliable than multiple tools—funnel everything through one interface

**Development patterns that worked:**

1. Lower-numbered docs as source of truth—prevents specification drift
2. Demo endpoints over E2E tests—stakeholders validate real workflows
3. Explicit trade-off documentation—every decision has recorded rationale
4. Graceful degradation—empty context is better than complete failure

---

## Looking Forward

Initial results were impressive but impractical. Looking for ways to improve:

- More complete knowledge base covering more jurisdictions and practice areas
- Better Clio API call reliability
- Deeper integration with firm workflows
- Legal structure clarity

The solution forward seems to niche down. Create a tightly coupled experience where the knowledge base, API integration, and organizational context work seamlessly together. Passively seeking a partner to help create a larger knowledge base.

---

## Technical Summary

**Runtime:** Cloudflare Workers, Durable Objects, D1, R2, Vectorize, Workers AI

**Frontend:** React 19, React Router 7, CSS Modules

**External Integrations:** Clio API, Better Auth, Microsoft Teams, Slack

**Estimated cost:** ~$8 per 500 messages
