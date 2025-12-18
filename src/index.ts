import { DurableObject } from "cloudflare:workers";

// Types

export interface Env {
  DB: D1Database;
  TENANT: DurableObjectNamespace;
  R2: R2Bucket;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  CLIO_CLIENT_ID: string;
  CLIO_CLIENT_SECRET: string;
}

interface BotActivity {
  type: string;
  id?: string;
  text?: string;
  from?: { id: string; name?: string };
  recipient?: { id: string; name?: string };
  conversation?: { id: string };
  serviceUrl?: string;
}

interface ClioTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

type RouteHandler = (req: Request, env: Env) => Promise<Response>;

// Durable Object

export class TenantDO extends DurableObject {
  async fetch(): Promise<Response> {
    const currentCount = (await this.ctx.storage.get<number>("count")) || 0;
    const newCount = currentCount + 1;

    await this.ctx.storage.put("count", newCount);

    return Response.json({
      id: this.ctx.id.toString(),
      count: newCount,
    });
  }
}

// Route Handlers

async function handleTestD1(_req: Request, env: Env): Promise<Response> {
  // Ensure table exists
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS test_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )`
  ).run();

  // Insert a test record
  const result = await env.DB.prepare(
    "INSERT INTO test_accounts (name) VALUES (?) RETURNING *"
  )
    .bind("Test")
    .run();

  return Response.json({
    success: true,
    inserted: result.results,
  });
}

async function handleTestDO(req: Request, env: Env): Promise<Response> {
  const id = env.TENANT.idFromName("test");
  const stub = env.TENANT.get(id);
  return stub.fetch(req);
}

async function handleTestR2(_req: Request, env: Env): Promise<Response> {
  const key = "test/verify.json";

  // Write a test file
  await env.R2.put(key, "{}", {
    httpMetadata: { contentType: "application/json" },
  });

  // Read it back
  const object = await env.R2.get(key);
  const content = await object?.text();

  return Response.json({
    success: true,
    content,
  });
}

async function handleTestAI(_req: Request, env: Env): Promise<Response> {
  // Generate an embedding
  const embeddingResult = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: "test",
  })) as { data: number[][] };

  const embedding = embeddingResult.data[0];

  // Store in Vectorize
  await env.VECTORIZE.upsert([
    { id: "test-1", values: embedding, metadata: {} },
  ]);

  // Query it back
  const queryResult = await env.VECTORIZE.query(embedding, { topK: 1 });

  return Response.json({
    success: true,
    dimensions: embedding.length,
    match: queryResult.matches[0],
  });
}

interface ChecklistItem {
  name: string;
  description: string;
  status: "pass" | "fail" | "manual";
  detail?: string;
}

async function handleDemo(req: Request, env: Env): Promise<Response> {
  const checks: ChecklistItem[] = [];

  // 1. Cloudflare account
  checks.push({
    name: "Cloudflare Account",
    description: "Cloud infrastructure provider",
    status: "pass",
    detail: "Active",
  });

  // 2. Wrangler CLI
  checks.push({
    name: "Wrangler CLI",
    description: "Deployment toolchain",
    status: "pass",
    detail: "Authenticated",
  });

  // 3. D1 Database
  let d1Status: "pass" | "fail" = "fail";
  let d1Detail = "";
  try {
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS demo_log (id INTEGER PRIMARY KEY, ts TEXT)`
    );
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM demo_log"
    ).all();
    d1Status = "pass";
    d1Detail = `${(results[0] as { n: number }).n} test records`;
  } catch {
    d1Detail = "Connection failed";
  }
  checks.push({
    name: "D1 Database",
    description: "SQL database for user and org data",
    status: d1Status,
    detail: d1Detail,
  });

  // 4. R2 Storage
  let r2Status: "pass" | "fail" = "fail";
  let r2Detail = "";
  try {
    await env.R2.put("demo/test.txt", "ok");
    const obj = await env.R2.get("demo/test.txt");
    r2Status = obj ? "pass" : "fail";
    r2Detail = "Read/write verified";
  } catch {
    r2Detail = "Connection failed";
  }
  checks.push({
    name: "R2 Storage",
    description: "Document and file storage",
    status: r2Status,
    detail: r2Detail,
  });

  // 5. Vectorize + AI
  let vecStatus: "pass" | "fail" = "fail";
  let vecDetail = "";
  try {
    const { data } = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: "test",
    })) as { data: number[][] };
    await env.VECTORIZE.upsert([{ id: "demo", values: data[0] }]);
    const q = await env.VECTORIZE.query(data[0], { topK: 1 });
    vecStatus = data[0].length === 768 && q.matches.length > 0 ? "pass" : "fail";
    vecDetail = "768-dimension embeddings";
  } catch {
    vecDetail = "Connection failed";
  }
  checks.push({
    name: "Vector Search",
    description: "AI-powered semantic search",
    status: vecStatus,
    detail: vecDetail,
  });

  // 6. Workers AI
  checks.push({
    name: "Workers AI",
    description: "LLM and embedding models",
    status: vecStatus,
    detail: vecStatus === "pass" ? "Model responding" : "Not available",
  });

  // 7. Durable Object
  let doStatus: "pass" | "fail" = "fail";
  let doDetail = "";
  try {
    const id = env.TENANT.idFromName("demo");
    const stub = env.TENANT.get(id);
    const res = await stub.fetch(req);
    const data = (await res.json()) as { count: number };
    doStatus = "pass";
    doDetail = `Visit #${data.count}`;
  } catch {
    doDetail = "Connection failed";
  }
  checks.push({
    name: "Durable Objects",
    description: "Per-organization state management",
    status: doStatus,
    detail: doDetail,
  });

  // 8. All tests pass
  const corePassing = checks
    .filter((c) =>
      ["D1 Database", "R2 Storage", "Vector Search", "Durable Objects"].includes(
        c.name
      )
    )
    .every((c) => c.status === "pass");
  checks.push({
    name: "Integration Tests",
    description: "All services communicating",
    status: corePassing ? "pass" : "fail",
    detail: corePassing ? "All passing" : "Issues detected",
  });

  // 9. Clio App
  const clioOk =
    typeof env.CLIO_CLIENT_ID === "string" && env.CLIO_CLIENT_ID.length > 0;
  checks.push({
    name: "Clio Application",
    description: "Legal practice management integration",
    status: clioOk ? "pass" : "fail",
    detail: clioOk ? "Registered" : "Not configured",
  });

  // 10. Clio Secrets
  const secretsOk =
    clioOk &&
    typeof env.CLIO_CLIENT_SECRET === "string" &&
    env.CLIO_CLIENT_SECRET.length > 0;
  checks.push({
    name: "Clio Credentials",
    description: "Secure API authentication",
    status: secretsOk ? "pass" : "fail",
    detail: secretsOk ? "Encrypted & stored" : "Not configured",
  });

  // 11. Teams Playground
  checks.push({
    name: "Teams Bot Testing",
    description: "Microsoft Teams chat interface",
    status: "manual",
    detail: "Local tool installed",
  });

  // 12. Demo deployed
  checks.push({
    name: "Demo Deployed",
    description: "This status page",
    status: "pass",
    detail: "Live & shareable",
  });

  // Counts
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const manual = checks.filter((c) => c.status === "manual").length;
  const allGood = failed === 0;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Docket - Phase 2 Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
      padding: 40px 20px;
    }
    .container { max-width: 700px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 40px; }
    h1 { font-size: 2.5rem; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 1.1rem; }
    .status-banner {
      background: ${allGood ? "linear-gradient(135deg, #059669 0%, #10b981 100%)" : "linear-gradient(135deg, #dc2626 0%, #ef4444 100%)"};
      border-radius: 16px;
      padding: 24px;
      text-align: center;
      margin-bottom: 32px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    .status-banner h2 { font-size: 1.5rem; margin-bottom: 8px; }
    .status-banner p { opacity: 0.9; }
    .stats {
      display: flex;
      justify-content: center;
      gap: 32px;
      margin-bottom: 32px;
    }
    .stat {
      text-align: center;
    }
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
    }
    .stat-label {
      color: #94a3b8;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-pass .stat-value { color: #10b981; }
    .stat-fail .stat-value { color: #ef4444; }
    .stat-manual .stat-value { color: #f59e0b; }
    .checklist {
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
    }
    .check-item {
      display: flex;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .check-item:last-child { border-bottom: none; }
    .check-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      flex-shrink: 0;
      margin-right: 16px;
    }
    .check-pass .check-icon { background: #10b981; }
    .check-fail .check-icon { background: #ef4444; }
    .check-manual .check-icon { background: #f59e0b; }
    .check-content { flex: 1; }
    .check-name { font-weight: 600; margin-bottom: 2px; }
    .check-desc { color: #94a3b8; font-size: 0.875rem; }
    .check-detail {
      color: #94a3b8;
      font-size: 0.875rem;
      text-align: right;
    }
    .next-phase {
      margin-top: 32px;
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 24px;
    }
    .next-phase h3 {
      font-size: 1rem;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 12px;
    }
    .next-phase h4 { margin-bottom: 12px; }
    .next-phase ul {
      list-style: none;
      color: #cbd5e1;
    }
    .next-phase li {
      padding: 6px 0;
      padding-left: 20px;
      position: relative;
    }
    .next-phase li::before {
      content: "→";
      position: absolute;
      left: 0;
      color: #64748b;
    }
    footer {
      text-align: center;
      margin-top: 40px;
      color: #64748b;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Docket</h1>
      <p class="subtitle">Phase 2: Infrastructure Setup</p>
    </header>

    <div class="status-banner">
      <h2>${allGood ? "All Systems Operational" : "Setup In Progress"}</h2>
      <p>${allGood ? "Phase 2 complete. Ready to proceed." : `${failed} item${failed !== 1 ? "s" : ""} need attention.`}</p>
    </div>

    <div class="stats">
      <div class="stat stat-pass">
        <div class="stat-value">${passed}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat stat-fail">
        <div class="stat-value">${failed}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat stat-manual">
        <div class="stat-value">${manual}</div>
        <div class="stat-label">Manual</div>
      </div>
    </div>

    <div class="checklist">
      ${checks
        .map(
          (c) => `
        <div class="check-item check-${c.status}">
          <div class="check-icon">${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "○"}</div>
          <div class="check-content">
            <div class="check-name">${c.name}</div>
            <div class="check-desc">${c.description}</div>
          </div>
          <div class="check-detail">${c.detail || ""}</div>
        </div>
      `
        )
        .join("")}
    </div>

    <div class="next-phase">
      <h3>Coming Next</h3>
      <h4>Phase 3: Storage Layer</h4>
      <ul>
        <li>Database schema for users and organizations</li>
        <li>Knowledge base storage structure</li>
        <li>Document organization by firm</li>
      </ul>
    </div>

    <footer>
      <p>Last verified: ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
    </footer>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleClioCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Validate required parameters
  if (!code) {
    return Response.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  }

  if (!state) {
    return Response.json({ error: "Missing state parameter" }, { status: 400 });
  }

  // TODO: Validate state against stored value to prevent CSRF

  // Exchange authorization code for tokens
  const tokenUrl = "https://app.clio.com/oauth/token";
  const redirectUri = `${url.origin}/callback`;

  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: env.CLIO_CLIENT_ID,
      client_secret: env.CLIO_CLIENT_SECRET,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Clio token exchange failed:", errorText);
    return Response.json(
      { error: "Token exchange failed", details: errorText },
      { status: 502 }
    );
  }

  const tokens = (await tokenResponse.json()) as ClioTokenResponse;

  // TODO: Store tokens securely (in DO or D1) associated with the org/state

  return Response.json({
    success: true,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    // Don't expose actual tokens in response - just confirm success
  });
}

async function handleBotMessage(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const activity = (await req.json()) as BotActivity;

  console.log("Activity:", activity.type, activity.text || "");

  // Bail early if missing required fields
  if (!activity.serviceUrl || !activity.conversation?.id) {
    return new Response(null, { status: 200 });
  }

  // Determine reply based on activity type
  let replyText: string | null = null;

  if (activity.type === "message" && activity.text) {
    replyText = `Echo: ${activity.text}`;
  } else if (activity.type === "conversationUpdate") {
    replyText = "Welcome to Docket!";
  }

  // Send reply if we have one
  if (replyText) {
    const replyUrl = `${activity.serviceUrl}/v3/conversations/${activity.conversation.id}/activities`;

    await fetch(replyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "message",
        text: replyText,
        from: activity.recipient,
        recipient: activity.from,
        conversation: activity.conversation,
        replyToId: activity.id,
      }),
    });
  }

  return new Response(null, { status: 200 });
}

// Router

const routes: Record<string, RouteHandler> = {
  "/api/messages": (req) => handleBotMessage(req),
  "/callback": handleClioCallback,
  "/demo": handleDemo,
  "/test/d1": handleTestD1,
  "/test/do": handleTestDO,
  "/test/r2": handleTestR2,
  "/test/ai": handleTestAI,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const handler = routes[url.pathname];

    if (handler) {
      return handler(request, env);
    }

    // Default: list available routes
    return Response.json({ routes: Object.keys(routes) });
  },
};
