[docketadmin.com](https://docketadmin.com)

Docket began as a collaboration with my friend who runs a nonprofit fundraising agency. We both read "The E-Myth Revisited" by Michael Gerber around the same time and both were completely enthralled. The book laid a gameplan on how most small businesses need another version of yourself to run. Your ultimate goal is to remove yourself from the business. Small business owners struggle with becoming too tightly absorbed within their own operations. Gerber teaches how to document what you do, identify what can be delegated, removing what is needless, and focusing on delegating remaining roles.

where the idea came from (gerber's book leading to documenting what you do, reading the book sparking collaboration, mapping out knowledge base, org context, api commands, and interfaces for it)

In 1998 when Gerber wrote the book, delegation meant hiring people. In 2026, we can do that with AI.

Joe spent a year documenting everything he does, recording it in an organized knowledge base. He had a vision for a chatbot that would pull industry expertise from his knowledge base, pull from organizational context that users upload (operating procedures), connect directly to the Salesforce API, and then be able to use via Slack.

Industry Knowledge + Practical API calls + Organizational Context delivered via the interface users are familiar with was our hypothesis for a winning product, so we got started building.

## on first version

With Joe for his business, I started to help - ultimately he decided it would be best to continue with someone who wasn't his friend to avoid any conflicts of interest but the door remains open to work together later. I am actively cooperating and sharing my research with him and his developer who I recommended to him.

what the FIRST VERSION could do, something that can go Slack to worker, can read the knowledge base, can read the org context, and shoddily execute API calls, the LLM running through the data worked wonderfully, and it all happened fast, authenticating through Slack via link was accomplished {{ need details on auth}}

## on what was learned from the first version

so FIRST VERSION problems we identified from it (Slack fundraising bot), communicating and executing API calls with Slack was possible - the org context uploading was an issue,

how what we learned from an unsuccessful first version would apply to the second to continue working on the project I needed to find another industry to study

## why lawyers and initial talks with lawyers

I needed to find a Salesforce-like tool that was specific to an industry. I know a lot of lawyers (for better or worse) and knew that Clio was a growing CRM that most users were really happy with, some administrative assistants honestly live on it. There were administrative assistants, small business owners that utilized it. I also explored what this tool would look like as a learning tool for legal clinics - I made sure to have two separate logins for legal clinics and law firms.

One of the difficulties in some lawyers' actual practices were distinguishing between different jurisdictions. I didn't realize how much different jurisdictions determine how to proceed through cases, the ins and outs of each, why that can create issues for lawyers. There had to be separate knowledge bases for different jurisdictions and different industries. What was not important was making sure the knowledge base was precise - that duty would have to be for a legaltech cofounder - what could be solved for is seeing if the LLM could distinguish between the two

## Multichannel Architecture

This project taught me how useful Cloudflare Workers and Durable Objects are. I do believe they will really become the leaders in the AI infrastructure space. Durable Objects are stateful storage objects. Imagine Durable Objects as a blender of different storage types - SQL, key value storage, object storage, vector databases, cron jobs, all sharing access to the same state and order of execution.

I designed the Cloudflare Worker to create a Durable Object for each organization that would enter the system. Within each

There was a channel interface constructor function that would receive the messages from Slack and Teams, and format in a way the chatbot could understand.

Docket would connect to a collection of different interfaces that users were familiar with - this included plans for Claude Desktop with MCP capabilities along with Slack and Microsoft Teams, and a web app.

Users would interact with Docket through these interfaces, each intentionally designed interface would have a matching service adapter that would take the interface specific data and convert it to normalized data, for a worker to receive

## Multitenant Architecture

Each law organization had their own isolated Durable Object instance. Docket's Durable Object managed conversation and message history with SQLite, custom field schemas, audit logs, confirmation states. Durable Objects allows users to ensure that operations appear in sequence, critical for making sure that context from a user's message is properly distributed as the LLM worker will have access to all the Durable Object at once.

Our Durable Object used D1 storage as the go-to for, the Durable Objects holds its own SQLite so data is restricted to each org, there is no way another org could ever get this data. In the SQLite we held conversations, messages, and message confirmations

then sent to a Cloudflare Worker that had access to each tenant's Durable Object representing their organization.

There was a processing worker that orchestrated the Durable Object, the Durable Object had its own worker for receiving messages from the entrypoint worker.

## Working with RAG

Joe's documentation was organized and worked really well with Retrieval Augmented Generation (RAG). The knowledge base was processed into Cloudflare's Vector Storage, essentially "training" the data as AI could preprocess the data while warming up.

## Agentic Developing

Most of this was developed with Claude following spec driven development. It was an introduction to learn more about testing for me as test-driven development has been a huge

how I used spec-driven development to explore what could be done - reflection how a lot of this was done through spec-driven development. This is an unfamiliar technology and idea, writing specs helped me understand the high level architecture, being able to recognize problems I would need to solve in the future earlier in the process. I ran a test suite as well, focused more on developing the tests and making sure I understood what they needed to be before proceeding with them. Development moved faster because of it, it's a tool to use, but taking the time to understand when something goes wrong is important

## on Technical Architecture

Durable Objects are isolated stateful compute units with their own embedded SQLite storage that is great for tenant data (tenant being a law organization, data that needs to be tightly coupled with state like status, pending actions, conversation messages)

Workers are stateless servers that are also bound to Durable Objects (stateful data that exists per org) and then attaches itself to external services via bindings, the same services like

- D1 (global database stored user and org metadata, chunks of the knowledge base that the LLM would access)
- R2 database which would store objects that wouldn't be accessed often like uploaded files (which are parsed and embedded into D1), audit logs, and archives.
- Vectorize database pre-processed the knowledge base and the organizational embedded data from uploaded docs

Cloudflare also has an insane Workers AI tool that stored the LLM (the prices are unbeatable) and then embedding tool

Cloudflare offers D1 storage, R2 Storage, and Vectorize storage that can be bound directly to Durable Objects

D1 handled user and org metadata, auth sessions, KB chunks, invitations, and subscriptions
The Durable Object SQLite held conversations, messages, pending confirmations, and the custom Clio schema caches that each law firm had

D1 was for cross tenant global lookups (user and org metadata). DO SQLite is physically isolated, org A's DO literally cannot access other org's SQLite. Legal supervisors would be ecstatic.

Workers are stateless, they receive normalized message data from the channel adapter

Durable Objects are single threaded, only one request executes at a time, when a DO wakes from hibernation - on first LLM message - the constructor runs migrations and loads schema inside blockConcurrencyWhile()

Durable Objects enforce the sequential execution - when a message arrives, the DO processes it completely before the next message

## on the chunks

The knowledge base divided by jurisdiction and industry would be manually uploaded by me through a tool I built, essentially reading from markdown files. The data was added to Vectorize to make sure it was findable by RAG, and then chunked up and split into D1 databases. The goal was that RAG could "locate" through vector the chunks that it needed to read, and "hold" that context ready in the conversation state to apply if needed later. I'm not sure why this was an advantage - need to crystallize this better

The org context upload pattern had to match, I built a server-side function with the Cloudflare AI file parsing tool that inserted the information and reran the vector database to prep for LLMs that were all bound together.

The chunks served an extra huge purpose, each chunk could be assigned a metadata filter containing the jurisdiction and industry for each chunk - that allowed the LLM to sort the queried chunks and ignore ones that could be potentially dangerous

add chart of mapping from AI looking up the vector databases, finding the chunks, filtering the chunks, then reading the chunks.

worker receives user message → search Vectorize → get IDs → could fetch full chunks from D1 if needed.

## on the tool calls

Tools are super important for MCPs and I wanted to keep that avenue open. Beyond MCP, tools also served a practical way for AI to interact with database. Imagine a tool as a super strict command that the AI can toss parameters into

In the first version, I had the idea of creating 4 tools that could execute specific commands. There was a lot of friction for developing each tool call, and I was underwhelmed with the work to create one and the individual impact of each tool. The first version the tools were executed, the scope was small, but best of all the AI tool struggled with deciding what tool to use

For Docket, I tried to attack it differently, I wanted to experiment with the idea of an "API call knowledge base" that the tool call would use to create a perfect API call parameter. This was a failure, the LLM could not reliably build out a proper tool call on the fly - with all the context floating around in conversations and exact instructions - it proved too much for an LLM in a single call to define what they need, read the instructions and follow them reliably.

Setting up multiple tool calls is the right way to go about this - but there is a huge overhead if they ever change which needs to be accounted for (maybe polling for the API docs to make sure they are the same, if not, auto shutdown, then developer needs to manually scramble to turn back on all the tools. This is something someone needed to be available for.)

It would have been easier to create a directory on what tool to call and why rather than parameter building instructions. Make the orchestration of what tool to call non-deterministic, and then the actual tool call would be purely deterministic. Trying to consolidate all the tools cleverly backfired.

## On commanding Clio

_side note this is a really good example of end to end thinking, take care with this_

_this parses through pricing strategy/business needs - to the user experience with accepting commands like Claude - to the technical execution_

As something to potentially price out later (plan was everyone in org would have access to knowledge base and org context, as well as run "read" operation with Clio - "what are upcoming cases on the calendar") only admins should be able to run commands with Clio - like "add a date to my calendar".

I had to set up safeguards for Docket to use Clio data.

I discovered later through testing that this should have been taken more seriously - I knew I could get the API to run the full suite of Create/Read/Delete functions. I had to make sure the user consented to it actually being executed and present it to them in a way they understand. The Docket bot had to communicate back to the user before doing an edit, similar to how Claude Code asks before editing code. I tried to emulate that, the pending confirmations were held in Durable Object state with message, the channel adapter had to be modified to work two ways and work quickly, an ez-pass lane had to be set up for this to run fast.

## technical Flow

CHANNEL INTERFACE
(Slack, Microsoft Teams, Web UI)

_sends MESSAGE to_

CHANNEL ADAPTER
extracts user/org context from message, normalizes message structure, queries D1 for `user_id`, `org_id`, and `role`.

_sends NORMALIZED MESSAGE to_

WORKER
using the normalized message information

_ROUTES to_

TENANT DURABLE OBJECT
The DO stores the message in SQLite

- generates EMBEDDING with WORKERS AI
- Queries VECTORIZE for knowledge base + org context chunks
- Builds a prompt with a schema for prompt building from the DO memory cache
- Calls LLM again (WORKERS AI)
- If needed to make a tool call, validates the user's permissions and executes the Clio API
- if the command to Clio was a Create/Update/Delete call rather than just a read function, ask the user a follow-up question - similar to how Claude Code asks you to validate before it commits to something {{ screenshot of this }}

## Example Flow

A user messages "What cases do I have next week" in a channel sch as Microsoft Teams, Slack, or the Web App. That message hits the slack channel adapter in JSON format including the channel ID (Slack), the user metadata, and timestamps. The message is tranformed into a normalized format by teh Channel Adatper which queries the D1 database for the user record, the user's organization metadata (industry, jurisdiction, ID), and user's role (admin or member). The adapter sends a clean, normalized message with user and org context to the Worker.

The worker routes this message deirectly to the correct Durable Object. The Durable Object wakes up from hibernation and immediatley stores the mesage in it's SQLite - this becomes the covnersation history that the LLM can access. The Durable Obejct then genretes an embedding of the message using Workers AI, a vector representation of what the user asked for RAG.

That embedding is sent to the binded Vectorize databse twice in parallel - once to search the sahred Knowledge Base, the other embedding to search trhough the org's uploaded context documents. Vectorize returns chunk ID's of the semantically simialr context from the huge knowledge base and org documents libraries. The chunks themselves live in D1, where the full text is retreived from.

The D1 chunks, the user's message, and the conversaton history are quiried as paramters for teh system prompt that gives the LLM guardrails and instructions. The Clio schema from the emory cahce is attatched to the prompt to the LLM knows what objects exist in each organizations Clio. All of this is packed into one context window - a conversation ont he web UI or a Slack or Teams thread.

Cloudflare's Workers AI runs the LLM. If the LLM decided it shoudl call the Clio API, we valdiate that the user has permission (right orgniation, right org context). If its jsut a read oepration, its executed, if its a create/update/delete fucntion, the Worker stores a pending confirmation in the DO storage and a message is setn back to the user, "Are you sure you want to \_\_\_\_?" for them to accept or deny.

The response from the LLM flows abck trhough the worker to the Channel Adapter again, which reformats the message for the respective Channel and sends it abck to the user.

Durable Objects allows the whoel thing to happen in sequence, to race conditiosn. The Durable Object processes one message compeltely before touching the next one, every operation is logged.

## on Retrospective

Our winning structure never really played out, I'm continuing to work on Docket in active development because I believe in the infrastructure and the goal to combine org context, knowledge base, and API calls. I think the scope needs to be majorly reduced.

Giving an LLM model unconstrained access to an API not controlled by you is a recipe for disaster. Patterns emerged while talking to it felt like relearning how to execute the Clio commands.

reflection: note how I'm starting to realize the problems of shoehorning this technology, reflection on better applications for it (personal API that you control, big danger letting the robot run wild, even with querying parameters, it's really unchecked and creating those guardrails wasn't something I really cared to explore) - RAG was a huge success, Cloudflare parsing files and doing it was also a huge success

This tool felt needless, you had to get used to describing things in a specific way to get what you want, mgiht as well learn hwo to operate clio - it was producing poor results and there would be npobody to blame.
