[docketadmin.com](https://docketadmin.com)

Doket began as a collabroation with my friend who runs a nonprofit fundraising agency, WE both read "The E-Myth Revisited" by Michael Gerber around the same time and both were compeltley enthralled. The book laid a gameplan on how most small businesses need another version of yourself to run. Your ultimate goal is to remove yourself from the business. Small business owners struggle with becoming too tightly absorbed within their own operations. Gerber teaches how to document what you do, identify what can be dleegated, removing what is needless, and focusing n deleagting remaineing roles.

where the idea cam efrom (gerber's book leading to documenting what you do, reading the book sparking collaboration, mapping out knowledge base, org context, api commands, and interfaces for it)

In 1998 when gerber wrot ethe book, delegation meant hiring people. In 2026, we can do that with AI.

Joe spent a year documenting everythign he does, recording it in an organzied knowledge base. He had a vision for a chatbot that woudl pull industry expertise from his knowledge base, pull from organizatial cotext that users upload (operating procedures), connect directly to the Salesforce API, and then be able to use via Slack.

Industry Knowledge + Practical API calls + Organziational Context delivered via the interface users are familair with was our hypothesis for a winning product, so we got started uilding.

## on first version

With joe for his business, i started tohelp - ultiamtely he decided it woudl be best to continue with soeone who wasnt his friend to avoid any conflicts of itnerest but the door remains open to work together later. I am actively cooperating and sharing my research with him and his devleoper who I recommended to him.

what the FIRST VERSION could do, soemthign that can go slack to worker, can read the knwoledge base, can read the org context, and shoddily execute API calls, the llm running through the data worked wonderfully, and it all happended fast, authenticating through slack via linkw as accomplished {{ need details on auth}}

## on waht was learned from the first version

so FIRST VERSION problems we identified from it (salck fundraising bot), communciating and executing api cals with slack was possible - the org context uploadingwass an issue,

how what we learned from an unsuccessful first version woudl apply to the second to contineu workign ont he proejct i needed to find another industry to study

## why laywers and intial talks with lawyers

i needed to find a salesforce-like tool that was specific to an ndustry, I know a lot of laywers (for better or worse) and knew that Clio was a growing CRM that most users were really happy with, some administrative assistants honeslty live on it, There were adminsitrative assistance, small business owners that utilized it. I also explored waht thsi tool would look like as a learning tool for legal clinics - i amde sure to have two seperate logins for legal clinics and law firms.

One fo the difficulties in soem lawyers actual practices were distinguishing between different jursidictions, i didnt realize how much different jursidictions determine how to prcoeede through cases, the ins and out of each, why that can create issues for lawyers. There had to be seperate knowledge bases for different jursidictions and different industries. what was not important was making sure the knowledge base was pecise - that duty woudl have to be for a legaltech cofounder - what could be solved for is seeing if the LLm could disticguish between the two

## Multichannel Architecture

This project taught me how useful cloudlfare workers and durable objects are. I do beleive they will really become the leaders in the AI infsatucure space. Durable objects are sateful storage objects. Imagine Durable Objects as a blender of different storage types - SQL, key value storage, object storage, vector databases, cron jobs, all sharing access to the same state and order of execution.

I designed the cloudlfare worker to create a Durable Object for each orgnaization that woudl enter the system. Within each

There was a channel interface constructor function that woudl receive the messages from slack and teams, and format in a way the chatbot coudl udnerstand.

Docket would connect to a collection of different interfaces that users were familair with - this included plans for Claude Desktop with MCP capabilities along with slack and microsoft teams, and a web app.

Users woudl interact with docket through these itnerfaces, each intionally designed interface woudl have a amtching service adapter that would take the interface specific data and convert it to normalized data, for a worker to recieve

## Multitenant Architecture

Each law organization had their own isolated Durable Obejct instance. Dockets Durable Obejct managed conversation and message hitory with SQLite, custom field scehmas, audit logs, confirmation states. Durable objects allows users to ensure that operations appear in sequence, critical for making sure that context from a users message is properly distributed as the llm worker will have access to all the durable obejct at once.

Our durable object used d1 storage as the go-to for, the durable objects holds its own SQLite so data is restrictred to each org, there is no way another org coudl ever get this data. In teh sqlite we held conversations, messages, and message confirmations

then sent to a cloudflare worker that had access to ech tenants Durable Object representing their organziation.

There was a processign worker that orchestrated the durable object, the durable obejct had its own worker for receving messages from the entrypoint worker.

## Workign with RAG

Joe's documentation was organized and worked really well with Retrival Augmented Generation (RAG). The knowledge base was processed into Cloudlfares Vdector Storage, essentially "training"" the data as AI could preprocess the data while warming up.

## Agentic Developing

Most of this was developed with Claude following spec driven development. It was an introduction to learn more abotu testing for me as test-driven development has been a huge

how i used spec-dreven development o explore what could be done - reflection how a lot of this was doen trhough spec-driven development. this is an unfamilair technology and idea, writing specs helped me understand the high level architecture, beign able to recognize problems I would need to solve in teh future earlier int he rpocess. I ran a test suite as well, focised more on ddeveloping the tests and makign sure tI iderstood wajj tjeu needed to be bofre proceeding with them. Development moed faster because of it, its a tool to use, but taking the time to understand when something goes wrong is important

## on Tecnical Architecture

Durable Objects are isolated stateful compute units with their own embedded SQlite stroage that is great for tenant data (tenant being a law organization, data that needs to be tightly coupled with state like status, pending actions, conversation messages)

Workers are stateless servers that are also binded to durable objects (stateful data that exists per org) and then attatches itself to external vervices via bindings, the same services like

- D1 (global database is tored user and org metadata, chunsk fo the knwoledge base that the LLm woudl access)
- r2 database which would store objects that wouldnt be accessed often like uplaoded (which are parsed and embedded into d1), autdit logs, and archives.
- Vectorize database pre-processed the knowledge base and the organizational embedded data from uplaoded docs

Cloudlafre also has an insane workers Ai tool that stored teh LLM (the prices are unbeatable) and then embedding tool

Cloudlfare offers D1 storate, R2 Storage, and Vectorize storage taht can be binded direclty to durable obejcts

D1 handled user and org metadata, auth sessions, kn cjunks, initations, and subscripttions
The Durable object sqlite held conversations, messsages, ending confirmations, and the custom clio schema cahces that each law firm had

d1 was fro cross tenant global lookups (user and org metadata). DO Sqlite is physically istalated, org a's DO's literally cannot acces other org's SQLite. Legal supervisors woudl be ecstatic.

Workers are stateless, they receive normalized message data from the channel adapter

Durable obejcts are single trheaded, only oen requests executes at a time, when a DO wakes from hibernation - on first llm message - the cosntructor runs migrations and loads schema inside blockConcureencyWhike()

Durable object enforce the sequential exectuion, - when a message arrives, the DO processes it comeptlely before the next mesage

## on teh chunks

the knwoldge base dvidied by jurisdiction and indursty wwould be manually uploaded by me through a tool i built, essetially reding from markdown files. The data was added to vectorize to make sure it was findable by RAG, and then chnked up and split into d1 databases. teh goal was that rag could "locate" through vector the chunks that it needed to read, and "hold: that context ready in teh conversation state to applu if needed later. Im not sure why thsi was an advatage - need to crystallize this better

The org context upload pattern ahd to atch, i built a server-side fucntion with the cloudlfare ai file aprsing tool that inserted the information and reran the vector database to prep for LLMs that were all binded together.

the chunks served an extra huge purpose, each chunk codul be assigned a metadata filter containing the jurisdiction and industry for each chunk - that allowed the LLm to sort the quried chuncks and ignore ones that coudl be potentially dangerous

add chart of mapping from ai looking up the vector databases, finding the chunks, filtering the chunks, thenr eadng the chunks.

worker recieves use rmessage → search Vectorize → get IDs → could fetch full chunks from D1 if needed.

## on the tool calls

Tools are super imprtant for MCPs and I wante dto keep taht avenue open. Beyond MCP, tools also servded a practical way forAI to interact with database. Imagine a tool as a super strict command that the Ai can toss paramters into

Int eh first verrsion, I had the idea of creating 4 tools that coudl execute specific commands. There was a lto fo friction for developing each tool call, and i was underwhelmed with the work to create one and the individual imapct fo each tool. the first version the tools were executed, teh scope was small, but best of all the ai tool struggled with deciding what tool to use

Fro docket, I tried toa ttack it differently, i wanted to experiment with teh idea of a "API call knwoledge base" that the tool call woudl use to create a perfect API call paramter. This was a failure, teh LLM coudl nto reliably build out a proper tool call ont he fly - with all the context floating aroudn in converstaions and exect instructions - it proved to omuch for an llm in a single call to define waht they need, read the instructions and follow them releiably.

Setting up mutliple tool calls is the right way to go about this - but there is a huge overhead if they ever change which needs to be accounted for (maybe polling for the API docs to make sure they are the same, if not, auto shutdown, then developer needs to manuallys crambel to turn back on all the tools. This is soemthign someoen needed to be available for.)

It woudl have been easier to create a directory on what tool to call and why rather than paramter buidlign instructions. Make the orchestration of waht tool to call non-deterministic, and then the actual tool call would be purely deterministic. Trying to cosnolidate all teh tools cleverly backfired.

## On commanding clio

_side note this is a really good example of end to end thinking, take care with this_

_this parses trhough pricing strategy/business needs - to the user experience with accepting commands like claude - to the technical execution_

As soemting to potentially price out later (plan was everyone in rog would have access to knwledge base and org context, as well as run "read" operation with clio - "what are upcomign cases ont eh calendar) only admins should be able to run commands with clio - like "add a date to my calnedar".

I had to set up safeguards for docket to use clio data.

I dicvoered alter trhough testing that this shoudl have taken more seriously - I knew I coudl get the api to run the full suite of Create/Read/deleete functions. I had to amke sure the user consneted to it actually being executes and present it to tehem in a way they understand. The docket bot had to communciate back to the user before doing an edit, simialr to how claude code asks before editong code. i tried to emulate that, the pendign confrmatiosn were held in durable object state with message, the channel adpter had to be modified to work two ways and work quickly, an ez-pass lane had to be set up for this to run fast.

## technical Flow

CHANNEL INTERFACE
[ [Slack] [Microsft teams] [web ui] ]

_sends MESSAGE to_

CHANNEL ADAPTER
extracts user/org context from message, normalizes message strucure, queries d1 for `user_id`, `org_id`, and `role`.

_sends NORMALIZED MESSAGE to_

WORKER
using the normalized message information

_ROUTES to_

TENANT DURABLE OBJECT
The DO stores the message in SQLite

- generates EMBEDDING with WORKERS AI
- Queries VECTORIZE for knowldge base + org context chunks
- Builds a prompt with a schema for prompt building from the DO memory cache
- Calls LLm again (WORKERS AI)
- If needed to make a tool call, validates the users permissions and executes the Clio API
- if the command to CLio was a Create/Update/Delete callr ather than just a read function, the ask the user a folowup question - simialr to how claude code asks you to validate before it commits to something {{ screenshto of this }}

## on Restrospective

Our winnign structure enever really palyed out, im continuing to work on docket in active development becuase I beleive in the infastructure and teh goal to combien org context, knowledge base, and api calls. I think the scope needs to be majorly reduced.

Giving an LLM model unconstrained access to an api not controleld by you is a recipe for a disaster. Patterns emerged whiel talking to it felt like relearning how to execute the Clio commands.

reflection: note how ims tarting to relaize the problems of shoehoring this technology, reflection on better appications for it (personal api that you control, big danger letting the robot runw ild, even with wurying parameters, its really unchecksd and creating those guardrails wasnt tsoemthign i relaly cared to explore) - rag was ahuge success, cloudlfare parsing files and doing it was also a huge success
