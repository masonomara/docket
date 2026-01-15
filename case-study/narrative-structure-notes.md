## On Docket

Docket began as a collaboration with my tech-savvy friend who runs an agency for non-rofit fundraising. We both read "the E-Myth" by David gerber around the same time and were compeltley enthralled. We were both goign through interesting times tryign to grow out agencies and looking how to hire. E-Myth is agreat book on how to start

E-Myth is about to to create documentation and systems for your small business that woudl allow you to replicate yourself withint eh company, Gerber's thesis is that msot small businesses need another version of yourself to to be to run, and that your ultiamt egoal of the busienss is to remove yourself from it and sell it. Small business woners struggle with becoming too tightly absrobed within their own buisnesses. The Emyth system is tightly documenting everything that you do, identifyign waht can be deleagated, identyfing what is needless, and then focusining on hwo to delegate those roles and then consider getting rid of or consolidating the roles you cannot see a path to delegate/have soemone be able to replicate

Wheile Gerber meant and likely only imagined in 1998 when the bookw as written was how to hire people. reading this book in 2024 expands the possibilities of delegation. When Gebrer wrot ethe book, having an assistant to read and revise all your emails included the overhead of at least a part time employee, and woudlnt be that feasable to ask that person to drop everything that they are doing to sor tthrough your shit. Now thats available for free on ChatGPT. Take it anothe layer deeper and we have agentic engineers working on repalcing entire software teams.

Joe spent his next year meticously documenting everything he does and recordign it in a 20,000 word organized knowledge base. Joe came to me witht he knowledge base and we started working on implmenting soem sort of chatbot that pulsl fromt eh knowledge base, connects directly to the salesforce api, and then pulls from an aorgnaizational context that users share abotu their company,

Research from workign with joe showed that every one of the comapnyes he works with has their own set of organziational rules. how woudl you defien what is fundrasing, how woudl you defien what is a large donor, how woudl youdescrieb when to reengage. These are joe;s best practices, not the best practices youll find in a textbook. Joe also has his own set of rules - how to format and date a document.

Joes documentation was absolutelyw ornderful,, and even formatted for rag really well. I built out a chatbot that connected to Slack and could communciate to through RAG, Vector Images, this was my first intro into cloudlfare architecture. The proejct with Joe ended, I took his hypothesis and started thinking about ways to apply this "industry knowledge base" + "practical api calls" +

## On talking to people

"now you cna get rid of the middle man, be it a developer or a content editor, and screw your site upo totally by yourslef. Youll just have to get used tto dscribing things in a very specific way to get what you want, which will take up all of your time. it'll product poorer results, and you have nobody to blame. Please take my money". - this quote stuck with me.

Users thought it was extremely itneresting, but needed a lot of refinement. The knowledge base was incomplete and the clio api calls were fucntional but did not work as well as expected.

Peopel were excited, the solution forward seems to niche down, create a seperate CMS (huge undertaking) that is tightly coupled with the chatbot AI functionalitoes. I also am passively seeking a partner to help create a larger knowledge base.

## narrative strucutre

Research with joe for salesfroce, then creating a tandup example that coudl communciate and execute API calls through slack. Idea validated. check out "what I learned from the first iteration"

Then moving on to applying this to legal work, deep dive on cloudlfare AI architecture, designing an interface that works with chatbots, and wiring it up with teams, slack, and an onscreen cahtbot. doing the website chatbot wasnt origianl plan or best, but development was takign lnger and I wanted somethign frictionless for users. Legality was also staring me down, i considered legal structures throughotut he rcoess but didnt realy act upon it other than writing, fair to say i was concious of it. and knew it wouldnt be a cakewalk.

Initial resutls were impressive but impractical. looking for ways to improve and learn from it


## What i learned from the first iteration:

Durable Objects are stateful storage objects delivered by cloudflare. This was chosen over other storage options because the idea that each tenant would have their own object to work out of was very appealing, durable objects are like a blender of different storage types like the D1 database, R2 storage buckets, vectorized database, alarms, and seamless connection to workers. The FundraisingAgent DO sets up one instance per tenant (nonprofit org looking for fundraising), They use SQLite storage for structured data (conversations, confirmations, audit logs), they use KV storage for encrypted OAuth tokens, they use in-memory cache for the Salesforce schema, and then channel agnostic message processing. 

When a message from Slack (request) is received the worker initially handles it. The worker calls the FundraisingAgent DO which loads up from hibernating (if hibernating in the first place), the constructor runs, the schema creates all tables, the schemaCache loads all the salesforce schema into memory, concurrency is blocked while everything is initializing, and then the tables and schema cache are fetched and ready to roll.
The multichannel architecture exists so user’s durable objects maintain state between Slack and MCP calls (ChatGPT/Claude Desktop) but more importantly it maintains flexibility so the end users can be “met where they like to be” - users do not need to download an app, they just need their typical ChatGPT/Slack workflow and all Tenant DO’s are modified appropriately. Unified messages make the medium of interaction from the user agnostic.
A message from slack goes through the SlackBot UI and is received by a webhook set up in our workspace. The Slack Channel adapter then extracts the message to the unified format for Durable Object processing. The adapter handles webhook verification, event routing, and response formatting.


The two-tier storage architecture is underselling it. The system uses both D1, DO SQLite, Vectorized Databases, R2 Storage Buckets, and more to separate and maintain consistency and latency for each Durable Object. 


The token encryption strategy is PKDDF2 which is designed to prevent brute force attacks by encrypting the user password and truncating it with the tenant ID and the master secret. This makes it so if any point of failure (tenant org hacked, master secret discovered, encryption strategy reverse engineered) fails, it makes it impossible to break the encryption without knowing all three points of attack. The tenant ID is unique to each organization.

The Slack webhook verification works by using the Slack Events API. We are using the HTTP version of the Slack Events API. My server receives a trigger that the event occurred, and then mcp server receives a JSON payload from Slack with information that contains the message. My server acknowledges receipt of the message, and then the Durable Object makes a business decision based on the message (fire a tool, access the knowledge base, etc)

If I lose the MASTER_ENCRYPTION_SECRET I would need to revalidate every single user password because every single encryption is tied to the MASTER_ENCRYPTION_SECRET. It would be a big mess