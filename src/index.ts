import { DurableObject } from "cloudflare:workers";
import { getAuth } from "./lib/auth";

export interface Env {
  DB: D1Database;
  TENANT: DurableObjectNamespace;
  R2: R2Bucket;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  CLIO_CLIENT_ID: string;
  CLIO_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APPLE_CLIENT_ID: string;
  APPLE_CLIENT_SECRET: string;
  APPLE_APP_BUNDLE_IDENTIFIER: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
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

export interface AuditEntry {
  id: string;
  user_id: string;
  action: string;
  object_type: string;
  params: Record<string, unknown>;
  result: "success" | "error";
  error_message?: string;
  created_at: string;
}

type AuditEntryInput = Omit<AuditEntry, "id" | "created_at">;

const DO_SCHEMA_VERSION = 1;

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      await this.migrate();
    });
  }

  private async migrate(): Promise<void> {
    const current = this.sql.exec("PRAGMA user_version").one()
      .user_version as number;
    if (current >= DO_SCHEMA_VERSION) return;

    if (current < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          channel_type TEXT NOT NULL,
          scope TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          user_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

        CREATE TABLE IF NOT EXISTS pending_confirmations (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          object_type TEXT NOT NULL,
          params TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_confirmations(expires_at);

        CREATE TABLE IF NOT EXISTS org_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS clio_schema_cache (
          object_type TEXT PRIMARY KEY,
          schema TEXT NOT NULL,
          custom_fields TEXT,
          fetched_at INTEGER NOT NULL
        );
      `);
    }

    this.sql.exec(`PRAGMA user_version = ${DO_SCHEMA_VERSION}`);
  }

  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const orgId = this.ctx.id.toString();
    const now = new Date();
    const id = crypto.randomUUID();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const path = `orgs/${orgId}/audit/${year}/${month}/${day}/${now.getTime()}-${id}.json`;

    await this.env.R2.put(
      path,
      JSON.stringify({ id, created_at: now.toISOString(), ...entry }),
      {
        httpMetadata: { contentType: "application/json" },
      }
    );

    return { id };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/audit") {
      const entry = (await request.json()) as AuditEntryInput;
      const result = await this.appendAuditLog(entry);
      return Response.json(result);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

async function handleClioCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code)
    return Response.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  if (!state)
    return Response.json({ error: "Missing state parameter" }, { status: 400 });

  const tokenResponse = await fetch("https://app.clio.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/callback`,
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

  const tokens = (await tokenResponse.json()) as {
    token_type: string;
    expires_in: number;
  };
  return Response.json({
    success: true,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
  });
}

async function handleBotMessage(req: Request): Promise<Response> {
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });

  const activity = (await req.json()) as BotActivity;
  console.log("Activity:", activity.type, activity.text || "");

  if (!activity.serviceUrl || !activity.conversation?.id)
    return new Response(null, { status: 200 });

  let replyText: string | null = null;
  if (activity.type === "message" && activity.text) {
    replyText = `Echo: ${activity.text}`;
  } else if (activity.type === "conversationUpdate") {
    replyText = "Welcome to Docket!";
  }

  if (replyText) {
    await fetch(
      `${activity.serviceUrl}/v3/conversations/${activity.conversation.id}/activities`,
      {
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
      }
    );
  }

  return new Response(null, { status: 200 });
}

async function handleAuthDemo(req: Request, env: Env): Promise<Response> {
  const auth = getAuth(env);
  const session = await auth.api.getSession({ headers: req.headers });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Docket - Auth Demo</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:"Inter",-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f7f7f7;min-height:100vh;color:#fff;padding:40px 20px}
    .container{max-width:500px;margin:0 auto}
    h1{font-size:2rem;text-align:center;margin-bottom:8px}
    .subtitle{text-align:center;color:#94a3b8;margin-bottom:32px}
    .card{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid rgba(0,0,0,.1)}
    .card h2{font-size:1rem;color:#000;margin-bottom:16px;text-transform:uppercase;letter-spacing:.05em}
    .status{padding:12px 16px;border-radius:8px;font-weight:500}
    .status-auth{background:rgba(16,185,129,.2);color:#10b981}
    .status-unauth{background:rgba(239,68,68,.2);color:#ef4444}
    .user-details{background:#f5f5f5;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;white-space:pre-wrap;word-break:break-all;margin-top:16px}
    .btn{display:inline-block;padding:12px 24px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;text-decoration:none;transition:all .2s;margin:4px}
    .btn-google{background:#fff;color:#333}.btn-google:hover{background:#f1f1f1}
    .btn-apple{background:#000;color:#fff}.btn-apple:hover{background:#222}
    .btn-primary{background:#3b82f6;color:#fff}.btn-primary:hover{background:#2563eb}
    .btn-secondary{background:#64748b;color:#fff}.btn-secondary:hover{background:#475569}
    .btn-danger{background:#ef4444;color:#fff}.btn-danger:hover{background:#dc2626}
    .divider{display:flex;align-items:center;margin:20px 0;color:#64748b}
    .divider::before,.divider::after{content:"";flex:1;border-bottom:1px solid #334155}
    .divider span{padding:0 16px;font-size:12px;text-transform:uppercase}
    .form-group{margin-bottom:16px}
    .form-group label{display:block;margin-bottom:6px;font-size:14px;color:#94a3b8}
    .input{width:100%;padding:12px;border:1px solid #9d9d9dff;border-radius:8px;background:#fff;color:#000;font-size:14px}
    .input:focus{outline:none;border-color:#3b82f6}
    .btn-row{display:flex;gap:8px;flex-wrap:wrap}
    .error{background:rgba(239,68,68,.2);color:#ef4444;padding:12px;border-radius:8px;margin-bottom:16px;display:none}
    .success{background:rgba(16,185,129,.2);color:#10b981;padding:12px;border-radius:8px;margin-bottom:16px;display:none}
  </style>
</head>
<body>
  <div class="container">
    <h1>Docket</h1>
    <p class="subtitle">Phase 4: Auth Foundation</p>
    <div class="card">
      <h2>Session Status</h2>
      <div class="status ${session ? "status-auth" : "status-unauth"}">
        ${session ? `Signed in as ${session.user.email}` : "Not signed in"}
      </div>
    </div>
    ${
      session
        ? `
    <div class="card">
      <h2>User Details</h2>
      <div class="user-details">${JSON.stringify(session.user, null, 2)}</div>
      <div style="margin-top:16px"><button class="btn btn-danger" onclick="signOut()">Sign Out</button></div>
    </div>
    <div class="card">
      <h2>Session Info</h2>
      <div class="user-details">${JSON.stringify(
        { id: session.session.id, expiresAt: session.session.expiresAt },
        null,
        2
      )}</div>
    </div>`
        : `
    <div class="card">
      <h2>Single Sign-On</h2>
      <div class="btn-row">
        <button class="btn btn-google" onclick="signInGoogle()">Sign in with Google</button>
        <button class="btn btn-apple" onclick="signInApple()">Sign in with Apple</button>
      </div>
    </div>
    <div class="divider"><span>or</span></div>
    <div class="card">
      <h2>Email Sign Up</h2>
      <div id="signup-error" class="error"></div>
      <div id="signup-success" class="success"></div>
      <form id="signup-form" onsubmit="signUp(event)">
        <div class="form-group"><label for="name">Name</label><input type="text" id="name" class="input" placeholder="Your name" required></div>
        <div class="form-group"><label for="email">Email</label><input type="email" id="email" class="input" placeholder="you@example.com" required></div>
        <div class="form-group"><label for="password">Password</label><input type="password" id="password" class="input" placeholder="Min 8 characters" required minlength="8"></div>
        <button type="submit" class="btn btn-primary">Create Account</button>
      </form>
    </div>
    <div class="card">
      <h2>Email Sign In</h2>
      <div id="signin-error" class="error"></div>
      <form id="signin-form" onsubmit="signIn(event)">
        <div class="form-group"><label for="signin-email">Email</label><input type="email" id="signin-email" class="input" placeholder="you@example.com" required></div>
        <div class="form-group"><label for="signin-password">Password</label><input type="password" id="signin-password" class="input" placeholder="Your password" required></div>
        <button type="submit" class="btn btn-secondary">Sign In</button>
      </form>
    </div>`
    }
  </div>
  <script>
    async function signInGoogle(){
      const res=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'google',callbackURL:window.location.href})});
      const data=await res.json();
      if(data.url)window.location.href=data.url;
    }
    async function signInApple(){
      const res=await fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'apple',callbackURL:window.location.href})});
      const data=await res.json();
      if(data.url)window.location.href=data.url;
    }
    async function signUp(e){
      e.preventDefault();
      const err=document.getElementById('signup-error'),ok=document.getElementById('signup-success');
      err.style.display='none';ok.style.display='none';
      const res=await fetch('/api/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('name').value,email:document.getElementById('email').value,password:document.getElementById('password').value})});
      const data=await res.json();
      if(data.user){ok.textContent='Account created! Redirecting...';ok.style.display='block';setTimeout(()=>window.location.reload(),1000)}
      else{err.textContent=data.error?.message||data.message||'Sign up failed';err.style.display='block'}
    }
    async function signIn(e){
      e.preventDefault();
      const err=document.getElementById('signin-error');err.style.display='none';
      const res=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('signin-email').value,password:document.getElementById('signin-password').value})});
      const data=await res.json();
      if(data.user){window.location.reload()}else{err.textContent=data.error?.message||data.message||'Invalid credentials';err.style.display='block'}
    }
    async function signOut(){await fetch('/api/auth/sign-out',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',credentials:'include'});window.location.reload()}
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

type RouteHandler = (req: Request, env: Env) => Promise<Response>;

const routes: Record<string, RouteHandler> = {
  "/api/messages": (req) => handleBotMessage(req),
  "/callback": handleClioCallback,
  "/": handleAuthDemo,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth")) {
      const auth = getAuth(env);
      try {
        return await auth.handler(request);
      } catch (e) {
        console.error("Auth error:", e);
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    const handler = routes[url.pathname];
    if (handler) return handler(request, env);

    return Response.json({ routes: Object.keys(routes) });
  },
};
