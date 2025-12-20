import { DurableObject } from "cloudflare:workers";
import { getAuth } from "./lib/auth";
import {
  getOrgMembership,
  getOrgMembers,
  removeUserFromOrg,
  transferOwnership,
} from "./services/org-membership";
import { deleteOrg, getOrgDeletionPreview } from "./services/org-deletion";

// ============================================================================
// Environment & Type Definitions
// ============================================================================

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

// ============================================================================
// Tenant Durable Object
// ============================================================================

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(() => this.migrate());
  }

  private async migrate(): Promise<void> {
    const versionResult = this.sql.exec("PRAGMA user_version").one();
    const currentVersion = versionResult.user_version as number;

    if (currentVersion >= 1) {
      return;
    }

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

      PRAGMA user_version = 1;
    `);
  }

  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const now = new Date();
    const id = crypto.randomUUID();

    // Build date-based path: orgs/{orgId}/audit/{year}/{month}/{day}/{timestamp}-{id}.json
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, "0");
    const day = now.getDate().toString().padStart(2, "0");
    const timestamp = now.getTime();

    const path = `orgs/${this.ctx.id}/audit/${year}/${month}/${day}/${timestamp}-${id}.json`;

    const auditEntry = {
      id,
      created_at: now.toISOString(),
      ...entry,
    };

    await this.env.R2.put(path, JSON.stringify(auditEntry), {
      httpMetadata: { contentType: "application/json" },
    });

    return { id };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/audit") {
      const input = (await request.json()) as AuditEntryInput;
      const result = await this.appendAuditLog(input);
      return Response.json(result);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Handles Clio OAuth callback - exchanges auth code for tokens
 */
async function handleClioCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return Response.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  }

  if (!state) {
    return Response.json({ error: "Missing state parameter" }, { status: 400 });
  }

  // Exchange authorization code for tokens
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
    const errorDetails = await tokenResponse.text();
    return Response.json(
      { error: "Token exchange failed", details: errorDetails },
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

/**
 * Handles incoming bot messages (Teams Bot Framework format)
 */
async function handleBotMessage(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const activity = (await req.json()) as {
    type: string;
    id?: string;
    text?: string;
    from?: { id: string; name?: string };
    recipient?: { id: string };
    conversation?: { id: string };
    serviceUrl?: string;
  };

  // Validate required fields
  if (!activity.serviceUrl || !activity.conversation?.id) {
    return new Response(null, { status: 200 });
  }

  // Determine reply text based on activity type
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

/**
 * Renders the auth demo page with sign-in/sign-up forms
 */
async function handleAuthDemo(req: Request, env: Env): Promise<Response> {
  const session = await getAuth(env).api.getSession({ headers: req.headers });

  const html = buildAuthDemoPage(session);

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

/**
 * Builds the HTML for the auth demo page
 */
function buildAuthDemoPage(
  session: {
    user: { email: string; id: string };
    session: { id: string; expiresAt: Date };
  } | null
): string {
  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Inter, -apple-system, sans-serif;
      background: #f7f7f7;
      min-height: 100vh;
      color: #fff;
      padding: 40px 20px;
    }
    .container { max-width: 500px; margin: 0 auto; }
    h1 { font-size: 2rem; text-align: center; margin-bottom: 8px; }
    .subtitle { text-align: center; color: #94a3b8; margin-bottom: 32px; }
    .card {
      background: #fff;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      border: 1px solid rgba(0,0,0,.1);
    }
    .card h2 {
      font-size: 1rem;
      color: #000;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: .05em;
    }
    .status { padding: 12px 16px; border-radius: 8px; font-weight: 500; }
    .status-auth { background: rgba(16,185,129,.2); color: #10b981; }
    .status-unauth { background: rgba(239,68,68,.2); color: #ef4444; }
    .user-details {
      background: #f5f5f5;
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-all;
      margin-top: 16px;
    }
    .btn {
      display: inline-block;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      transition: all .2s;
      margin: 4px;
    }
    .btn-google { background: #fff; color: #333; }
    .btn-apple { background: #000; color: #fff; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-secondary { background: #64748b; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      color: #64748b;
    }
    .divider::before, .divider::after {
      content: "";
      flex: 1;
      border-bottom: 1px solid #334155;
    }
    .divider span {
      padding: 0 16px;
      font-size: 12px;
      text-transform: uppercase;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      margin-bottom: 6px;
      font-size: 14px;
      color: #94a3b8;
    }
    .input {
      width: 100%;
      padding: 12px;
      border: 1px solid #9d9d9d;
      border-radius: 8px;
      background: #fff;
      color: #000;
      font-size: 14px;
    }
    .input:focus { outline: none; border-color: #3b82f6; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .error, .success {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 16px;
      display: none;
    }
    .error { background: rgba(239,68,68,.2); color: #ef4444; }
    .success { background: rgba(16,185,129,.2); color: #10b981; }
  `;

  const js = `
    async function signInGoogle() {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: location.href })
      });
      const data = await res.json();
      if (data.url) location.href = data.url;
    }

    async function signInApple() {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'apple', callbackURL: location.href })
      });
      const data = await res.json();
      if (data.url) location.href = data.url;
    }

    async function signUp(e) {
      e.preventDefault();
      const errorEl = document.getElementById('signup-error');
      const successEl = document.getElementById('signup-success');
      errorEl.style.display = 'none';
      successEl.style.display = 'none';

      const res = await fetch('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('name').value,
          email: document.getElementById('email').value,
          password: document.getElementById('password').value
        })
      });

      const data = await res.json();
      if (data.user) {
        successEl.textContent = 'Account created! Redirecting...';
        successEl.style.display = 'block';
        setTimeout(() => location.reload(), 1000);
      } else {
        errorEl.textContent = data.error?.message || data.message || 'Sign up failed';
        errorEl.style.display = 'block';
      }
    }

    async function signIn(e) {
      e.preventDefault();
      const errorEl = document.getElementById('signin-error');
      errorEl.style.display = 'none';

      const res = await fetch('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('signin-email').value,
          password: document.getElementById('signin-password').value
        })
      });

      const data = await res.json();
      if (data.user) {
        location.reload();
      } else {
        errorEl.textContent = data.error?.message || data.message || 'Invalid credentials';
        errorEl.style.display = 'block';
      }
    }

    async function signOut() {
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'include'
      });
      location.reload();
    }
  `;

  const statusClass = session ? "status-auth" : "status-unauth";
  const statusText = session
    ? `Signed in as ${session.user.email}`
    : "Not signed in";

  let authContent: string;

  if (session) {
    // Authenticated view
    const userJson = JSON.stringify(session.user, null, 2);
    const sessionJson = JSON.stringify(
      { id: session.session.id, expiresAt: session.session.expiresAt },
      null,
      2
    );

    authContent = `
      <div class="card">
        <h2>User Details</h2>
        <div class="user-details">${userJson}</div>
        <div style="margin-top:16px">
          <button class="btn btn-danger" onclick="signOut()">Sign Out</button>
        </div>
      </div>
      <div class="card">
        <h2>Session Info</h2>
        <div class="user-details">${sessionJson}</div>
      </div>
    `;
  } else {
    // Unauthenticated view
    authContent = `
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
        <form onsubmit="signUp(event)">
          <div class="form-group">
            <label>Name</label>
            <input type="text" id="name" class="input" required>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="email" class="input" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="password" class="input" required minlength="8">
          </div>
          <button type="submit" class="btn btn-primary">Create Account</button>
        </form>
      </div>

      <div class="card">
        <h2>Email Sign In</h2>
        <div id="signin-error" class="error"></div>
        <form onsubmit="signIn(event)">
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="signin-email" class="input" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="signin-password" class="input" required>
          </div>
          <button type="submit" class="btn btn-secondary">Sign In</button>
        </form>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Docket - Auth Demo</title>
  <style>${css}</style>
</head>
<body>
  <div class="container">
    <h1>Docket</h1>
    <p class="subtitle">Phase 4: Auth Foundation</p>

    <div class="card">
      <h2>Session Status</h2>
      <div class="status ${statusClass}">${statusText}</div>
    </div>

    ${authContent}
  </div>
  <script>${js}</script>
</body>
</html>`;
}

/**
 * Handles org membership demo page - tests user leave/transfer flows
 */
async function handleOrgMembershipDemo(
  req: Request,
  env: Env
): Promise<Response> {
  const url = new URL(req.url);

  // Handle API actions
  if (req.method === "POST") {
    const body = (await req.json()) as {
      action: string;
      userId?: string;
      orgId?: string;
      toUserId?: string;
    };

    if (body.action === "get-membership" && body.userId && body.orgId) {
      const result = await getOrgMembership(env.DB, body.userId, body.orgId);
      return Response.json({ membership: result });
    }

    if (body.action === "get-members" && body.orgId) {
      const result = await getOrgMembers(env.DB, body.orgId);
      return Response.json({ members: result });
    }

    if (body.action === "remove" && body.userId && body.orgId) {
      const result = await removeUserFromOrg(env.DB, body.userId, body.orgId);
      return Response.json(result);
    }

    if (
      body.action === "transfer" &&
      body.orgId &&
      body.userId &&
      body.toUserId
    ) {
      const result = await transferOwnership(
        env.DB,
        body.orgId,
        body.userId,
        body.toUserId
      );
      return Response.json(result);
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  // GET: Render demo page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Org Membership Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, -apple-system, sans-serif; background: #f7f7f7; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .subtitle { color: #64748b; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid rgba(0,0,0,.1); }
    .card h2 { font-size: 1rem; margin-bottom: 16px; text-transform: uppercase; letter-spacing: .05em; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #64748b; }
    .input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin: 4px; }
    .btn-primary { background: #3b82f6; color: #fff; }
    .btn-secondary { background: #64748b; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .result { background: #f5f5f5; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-top: 16px; display: none; }
    .status { padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    .status-info { background: #e0f2fe; color: #0369a1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Org Membership Demo</h1>
    <p class="subtitle">Phase 4: User Leaves Org Flow</p>

    <div class="card">
      <div class="status status-info">
        This demo tests D1 cleanup when users leave organizations.
        Phase 6 will add DO cleanup (pending confirmations, Clio tokens).
      </div>
    </div>

    <div class="card">
      <h2>Get Org Members</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="members-org" class="input" placeholder="org-id">
      </div>
      <button class="btn btn-secondary" onclick="getMembers()">Get Members</button>
      <div id="members-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Get User Membership</h2>
      <div class="form-group">
        <label>User ID</label>
        <input type="text" id="membership-user" class="input" placeholder="user-id">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="membership-org" class="input" placeholder="org-id">
      </div>
      <button class="btn btn-secondary" onclick="getMembership()">Get Membership</button>
      <div id="membership-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Remove User from Org</h2>
      <div class="form-group">
        <label>User ID</label>
        <input type="text" id="remove-user" class="input" placeholder="user-id">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="remove-org" class="input" placeholder="org-id">
      </div>
      <button class="btn btn-danger" onclick="removeUser()">Remove from Org</button>
      <div id="remove-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Transfer Ownership</h2>
      <div class="form-group">
        <label>Current Owner User ID</label>
        <input type="text" id="transfer-from" class="input" placeholder="owner-user-id">
      </div>
      <div class="form-group">
        <label>New Owner User ID</label>
        <input type="text" id="transfer-to" class="input" placeholder="admin-user-id">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="transfer-org" class="input" placeholder="org-id">
      </div>
      <button class="btn btn-primary" onclick="transferOwner()">Transfer Ownership</button>
      <div id="transfer-result" class="result"></div>
    </div>
  </div>

  <script>
    async function post(action, data) {
      const res = await fetch('/demo/org-membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...data })
      });
      return res.json();
    }

    function showResult(id, data) {
      const el = document.getElementById(id);
      el.textContent = JSON.stringify(data, null, 2);
      el.style.display = 'block';
    }

    async function getMembers() {
      const orgId = document.getElementById('members-org').value;
      const result = await post('get-members', { orgId });
      showResult('members-result', result);
    }

    async function getMembership() {
      const userId = document.getElementById('membership-user').value;
      const orgId = document.getElementById('membership-org').value;
      const result = await post('get-membership', { userId, orgId });
      showResult('membership-result', result);
    }

    async function removeUser() {
      const userId = document.getElementById('remove-user').value;
      const orgId = document.getElementById('remove-org').value;
      const result = await post('remove', { userId, orgId });
      showResult('remove-result', result);
    }

    async function transferOwner() {
      const userId = document.getElementById('transfer-from').value;
      const toUserId = document.getElementById('transfer-to').value;
      const orgId = document.getElementById('transfer-org').value;
      const result = await post('transfer', { userId, toUserId, orgId });
      showResult('transfer-result', result);
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

/**
 * Handles org deletion demo page - tests org deletion flow
 */
async function handleOrgDeletionDemo(
  req: Request,
  env: Env
): Promise<Response> {
  // Handle API actions
  if (req.method === "POST") {
    const body = (await req.json()) as {
      action: string;
      orgId?: string;
      userId?: string;
    };

    if (body.action === "preview" && body.orgId) {
      const result = await getOrgDeletionPreview(env.DB, body.orgId);
      return Response.json(result);
    }

    if (body.action === "delete" && body.orgId && body.userId) {
      const result = await deleteOrg(env.DB, env.R2, body.orgId, body.userId);
      return Response.json(result);
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  // GET: Render demo page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Org Deletion Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, -apple-system, sans-serif; background: #f7f7f7; padding: 40px 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    .subtitle { color: #64748b; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; padding: 24px; margin-bottom: 20px; border: 1px solid rgba(0,0,0,.1); }
    .card h2 { font-size: 1rem; margin-bottom: 16px; text-transform: uppercase; letter-spacing: .05em; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; margin-bottom: 4px; font-size: 14px; color: #64748b; }
    .input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    .btn { padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin: 4px; }
    .btn-secondary { background: #64748b; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .result { background: #f5f5f5; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-top: 16px; display: none; }
    .status { padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    .status-warning { background: #fef3c7; color: #92400e; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Org Deletion Demo</h1>
    <p class="subtitle">Phase 4: Org Deletion Flow (D1 + R2)</p>

    <div class="card">
      <div class="status status-warning">
        This permanently deletes an organization and all its data.
        Phase 6 will add DO cleanup (conversations, Clio tokens).
      </div>
    </div>

    <div class="card">
      <h2>Preview Deletion</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="preview-org" class="input" placeholder="org-id">
      </div>
      <button class="btn btn-secondary" onclick="previewDeletion()">Preview</button>
      <div id="preview-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Delete Organization</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input type="text" id="delete-org" class="input" placeholder="org-id">
      </div>
      <div class="form-group">
        <label>Owner User ID (for authorization)</label>
        <input type="text" id="delete-user" class="input" placeholder="owner-user-id">
      </div>
      <button class="btn btn-danger" onclick="deleteOrg()">Delete Organization</button>
      <div id="delete-result" class="result"></div>
    </div>
  </div>

  <script>
    async function post(action, data) {
      const res = await fetch('/demo/org-deletion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...data })
      });
      return res.json();
    }

    function showResult(id, data) {
      const el = document.getElementById(id);
      el.textContent = JSON.stringify(data, null, 2);
      el.style.display = 'block';
    }

    async function previewDeletion() {
      const orgId = document.getElementById('preview-org').value;
      const result = await post('preview', { orgId });
      showResult('preview-result', result);
    }

    async function deleteOrg() {
      if (!confirm('Are you sure you want to delete this organization? This cannot be undone.')) {
        return;
      }
      const orgId = document.getElementById('delete-org').value;
      const userId = document.getElementById('delete-user').value;
      const result = await post('delete', { orgId, userId });
      showResult('delete-result', result);
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ============================================================================
// Route Configuration
// ============================================================================

const routes: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/api/messages": (req) => handleBotMessage(req),
  "/callback": handleClioCallback,
  "/demo/org-membership": handleOrgMembershipDemo,
  "/demo/org-deletion": handleOrgDeletionDemo,
  "/": handleAuthDemo,
};

// ============================================================================
// Main Worker Entry Point
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle Better Auth routes
    if (url.pathname.startsWith("/api/auth")) {
      try {
        return await getAuth(env).handler(request);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // Handle registered routes
    const handler = routes[url.pathname];
    if (handler) {
      return handler(request, env);
    }

    // Return available routes for unknown paths
    return Response.json({ routes: Object.keys(routes) });
  },
};
