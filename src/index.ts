import { DurableObject } from "cloudflare:workers";
import { getAuth } from "./lib/auth";
import {
  getOrgMembership,
  getOrgMembers,
  removeUserFromOrg,
  transferOwnership,
} from "./services/org-membership";
import { deleteOrg, getOrgDeletionPreview } from "./services/org-deletion";
import { buildKB } from "./services/kb-builder";
import { loadKBFiles, getKBStats } from "./services/kb-loader";

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

// =============================================================================
// Durable Object: TenantDO
// =============================================================================

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(() => this.migrate());
  }

  private async migrate(): Promise<void> {
    const currentVersion = this.sql.exec("PRAGMA user_version").one()
      .user_version as number;

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

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const timestamp = now.getTime();

    const path = `orgs/${this.ctx.id}/audit/${year}/${month}/${day}/${timestamp}-${id}.json`;

    const auditData = {
      id,
      created_at: now.toISOString(),
      ...entry,
    };

    await this.env.R2.put(path, JSON.stringify(auditData), {
      httpMetadata: { contentType: "application/json" },
    });

    return { id };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/audit") {
      const entryInput = (await request.json()) as AuditEntryInput;
      const result = await this.appendAuditLog(entryInput);
      return Response.json(result);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// =============================================================================
// Clio OAuth Callback Handler
// =============================================================================

async function handleClioCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code) {
    return Response.json(
      { error: "Missing authorization code" },
      { status: 400 }
    );
  }

  if (!state) {
    return Response.json(
      { error: "Missing state parameter" },
      { status: 400 }
    );
  }

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

// =============================================================================
// Bot Message Handler (Teams)
// =============================================================================

interface BotActivity {
  type: string;
  id?: string;
  text?: string;
  from?: { id: string };
  recipient?: { id: string };
  conversation?: { id: string };
  serviceUrl?: string;
}

async function handleBotMessage(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const activity = (await request.json()) as BotActivity;

  if (!activity.serviceUrl || !activity.conversation?.id) {
    return new Response(null, { status: 200 });
  }

  let replyText: string | null = null;

  if (activity.type === "message" && activity.text) {
    replyText = `Echo: ${activity.text}`;
  } else if (activity.type === "conversationUpdate") {
    replyText = "Welcome to Docket!";
  }

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

// =============================================================================
// HTML Template Helpers
// =============================================================================

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Inter, -apple-system, sans-serif;
    background: #f7f7f7;
    padding: 40px 20px;
  }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .subtitle { color: #64748b; margin-bottom: 24px; }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 20px;
    border: 1px solid rgba(0,0,0,0.1);
  }
  .card h2 {
    font-size: 1rem;
    margin-bottom: 16px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .form-group { margin-bottom: 12px; }
  .form-group label {
    display: block;
    margin-bottom: 4px;
    font-size: 14px;
    color: #64748b;
  }
  .input {
    width: 100%;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 14px;
  }
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    margin: 4px;
  }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-secondary { background: #64748b; color: #fff; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn:disabled { background: #94a3b8; cursor: not-allowed; }
  .result {
    background: #f5f5f5;
    border-radius: 8px;
    padding: 16px;
    font-family: monospace;
    font-size: 13px;
    white-space: pre-wrap;
    margin-top: 16px;
    display: none;
  }
  .status {
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 14px;
    margin-bottom: 16px;
  }
`;

function renderHtmlPage(
  title: string,
  subtitle: string,
  bodyContent: string,
  scriptContent: string,
  extraCSS = ""
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${BASE_CSS}${extraCSS}</style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    ${bodyContent}
  </div>
  <script>${scriptContent}</script>
</body>
</html>`;
}

function createPostScript(endpoint: string): string {
  return `
    async function post(action, data) {
      const response = await fetch('${endpoint}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...data })
      });
      return response.json();
    }

    function showResult(elementId, data) {
      const element = document.getElementById(elementId);
      element.textContent = JSON.stringify(data, null, 2);
      element.style.display = 'block';
    }
  `;
}

// =============================================================================
// Auth Demo Page
// =============================================================================

const AUTH_EXTRA_CSS = `
  .status-auth { background: rgba(16,185,129,0.2); color: #10b981; }
  .status-unauth { background: rgba(239,68,68,0.2); color: #ef4444; }
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
  .btn-google { background: #fff; color: #333; }
  .btn-apple { background: #000; color: #fff; }
  .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
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
  .error, .success {
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 16px;
    display: none;
  }
  .error { background: rgba(239,68,68,0.2); color: #ef4444; }
  .success { background: rgba(16,185,129,0.2); color: #10b981; }
`;

const AUTH_SCRIPT = `
  async function socialSignIn(provider) {
    const response = await fetch('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, callbackURL: location.href })
    });
    const data = await response.json();
    if (data.url) {
      location.href = data.url;
    }
  }

  async function signUp(event) {
    event.preventDefault();
    const errorEl = document.getElementById('signup-error');
    const successEl = document.getElementById('signup-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    const response = await fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.getElementById('name').value,
        email: document.getElementById('email').value,
        password: document.getElementById('password').value
      })
    });

    const data = await response.json();

    if (data.user) {
      successEl.textContent = 'Account created!';
      successEl.style.display = 'block';
      setTimeout(() => location.reload(), 1000);
    } else {
      errorEl.textContent = data.error?.message || data.message || 'Failed';
      errorEl.style.display = 'block';
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const errorEl = document.getElementById('signin-error');
    errorEl.style.display = 'none';

    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('signin-email').value,
        password: document.getElementById('signin-password').value
      })
    });

    const data = await response.json();

    if (data.user) {
      location.reload();
    } else {
      errorEl.textContent = data.error?.message || data.message || 'Invalid';
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

async function handleAuthDemo(request: Request, env: Env): Promise<Response> {
  const session = await getAuth(env).api.getSession({ headers: request.headers });

  const statusClass = session ? "status-auth" : "status-unauth";
  const statusText = session
    ? `Signed in as ${session.user.email}`
    : "Not signed in";

  let authContent: string;

  if (session) {
    const userJson = JSON.stringify(session.user, null, 2);
    const sessionJson = JSON.stringify(
      { id: session.session.id, expiresAt: session.session.expiresAt },
      null,
      2
    );

    authContent = `
      <div class="card">
        <h2>User</h2>
        <div class="user-details">${userJson}</div>
        <div style="margin-top: 16px">
          <button class="btn btn-danger" onclick="signOut()">Sign Out</button>
        </div>
      </div>
      <div class="card">
        <h2>Session</h2>
        <div class="user-details">${sessionJson}</div>
      </div>
    `;
  } else {
    authContent = `
      <div class="card">
        <h2>SSO</h2>
        <div class="btn-row">
          <button class="btn btn-google" onclick="socialSignIn('google')">Google</button>
          <button class="btn btn-apple" onclick="socialSignIn('apple')">Apple</button>
        </div>
      </div>

      <div class="divider"><span>or</span></div>

      <div class="card">
        <h2>Sign Up</h2>
        <div id="signup-error" class="error"></div>
        <div id="signup-success" class="success"></div>
        <form onsubmit="signUp(event)">
          <div class="form-group">
            <label>Name</label>
            <input id="name" class="input" required>
          </div>
          <div class="form-group">
            <label>Email</label>
            <input type="email" id="email" class="input" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="password" class="input" required minlength="8">
          </div>
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>

      <div class="card">
        <h2>Sign In</h2>
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

  const bodyContent = `
    <div class="card">
      <h2>Status</h2>
      <div class="status ${statusClass}">${statusText}</div>
    </div>
    ${authContent}
  `;

  const html = renderHtmlPage("Docket", "Auth Demo", bodyContent, AUTH_SCRIPT, AUTH_EXTRA_CSS);

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

// =============================================================================
// Org Membership Demo Page
// =============================================================================

interface OrgMembershipRequest {
  action: string;
  userId?: string;
  orgId?: string;
  toUserId?: string;
}

async function handleOrgMembershipDemo(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json()) as OrgMembershipRequest;

    if (body.action === "get-membership" && body.userId && body.orgId) {
      const membership = await getOrgMembership(env.DB, body.userId, body.orgId);
      return Response.json({ membership });
    }

    if (body.action === "get-members" && body.orgId) {
      const members = await getOrgMembers(env.DB, body.orgId);
      return Response.json({ members });
    }

    if (body.action === "remove" && body.userId && body.orgId) {
      const result = await removeUserFromOrg(env.DB, body.userId, body.orgId);
      return Response.json(result);
    }

    if (body.action === "transfer" && body.orgId && body.userId && body.toUserId) {
      const result = await transferOwnership(env.DB, body.orgId, body.userId, body.toUserId);
      return Response.json(result);
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const bodyContent = `
    <div class="card">
      <div class="status" style="background: #e0f2fe; color: #0369a1">
        Tests D1 cleanup when users leave orgs.
      </div>
    </div>

    <div class="card">
      <h2>Get Members</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input id="members-org-id" class="input">
      </div>
      <button class="btn btn-secondary" onclick="post('get-members', { orgId: document.getElementById('members-org-id').value }).then(r => showResult('members-result', r))">
        Get
      </button>
      <div id="members-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Get Membership</h2>
      <div class="form-group">
        <label>User ID</label>
        <input id="membership-user-id" class="input">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input id="membership-org-id" class="input">
      </div>
      <button class="btn btn-secondary" onclick="post('get-membership', { userId: document.getElementById('membership-user-id').value, orgId: document.getElementById('membership-org-id').value }).then(r => showResult('membership-result', r))">
        Get
      </button>
      <div id="membership-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Remove User</h2>
      <div class="form-group">
        <label>User ID</label>
        <input id="remove-user-id" class="input">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input id="remove-org-id" class="input">
      </div>
      <button class="btn btn-danger" onclick="post('remove', { userId: document.getElementById('remove-user-id').value, orgId: document.getElementById('remove-org-id').value }).then(r => showResult('remove-result', r))">
        Remove
      </button>
      <div id="remove-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Transfer Ownership</h2>
      <div class="form-group">
        <label>From User</label>
        <input id="transfer-from-user" class="input">
      </div>
      <div class="form-group">
        <label>To User</label>
        <input id="transfer-to-user" class="input">
      </div>
      <div class="form-group">
        <label>Org ID</label>
        <input id="transfer-org-id" class="input">
      </div>
      <button class="btn btn-primary" onclick="post('transfer', { userId: document.getElementById('transfer-from-user').value, toUserId: document.getElementById('transfer-to-user').value, orgId: document.getElementById('transfer-org-id').value }).then(r => showResult('transfer-result', r))">
        Transfer
      </button>
      <div id="transfer-result" class="result"></div>
    </div>
  `;

  const html = renderHtmlPage(
    "Org Membership",
    "User Leaves Org Flow",
    bodyContent,
    createPostScript("/demo/org-membership")
  );

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// =============================================================================
// Org Deletion Demo Page
// =============================================================================

interface OrgDeletionRequest {
  action: string;
  orgId?: string;
  userId?: string;
}

async function handleOrgDeletionDemo(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method === "POST") {
    const body = (await request.json()) as OrgDeletionRequest;

    if (body.action === "preview" && body.orgId) {
      const preview = await getOrgDeletionPreview(env.DB, body.orgId);
      return Response.json(preview);
    }

    if (body.action === "delete" && body.orgId && body.userId) {
      const result = await deleteOrg(env.DB, env.R2, body.orgId, body.userId);
      return Response.json(result);
    }

    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const bodyContent = `
    <div class="card">
      <div class="status" style="background: #fef3c7; color: #92400e">
        Permanently deletes org and all data.
      </div>
    </div>

    <div class="card">
      <h2>Preview</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input id="preview-org-id" class="input">
      </div>
      <button class="btn btn-secondary" onclick="post('preview', { orgId: document.getElementById('preview-org-id').value }).then(r => showResult('preview-result', r))">
        Preview
      </button>
      <div id="preview-result" class="result"></div>
    </div>

    <div class="card">
      <h2>Delete</h2>
      <div class="form-group">
        <label>Org ID</label>
        <input id="delete-org-id" class="input">
      </div>
      <div class="form-group">
        <label>Owner ID</label>
        <input id="delete-owner-id" class="input">
      </div>
      <button class="btn btn-danger" onclick="if(confirm('Delete this organization?')) post('delete', { orgId: document.getElementById('delete-org-id').value, userId: document.getElementById('delete-owner-id').value }).then(r => showResult('delete-result', r))">
        Delete
      </button>
      <div id="delete-result" class="result"></div>
    </div>
  `;

  const html = renderHtmlPage(
    "Org Deletion",
    "D1 + R2 Cleanup",
    bodyContent,
    createPostScript("/demo/org-deletion")
  );

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// =============================================================================
// Knowledge Base Demo Page
// =============================================================================

const KB_SCRIPT = `
  async function rebuildKB() {
    const button = document.getElementById('rebuild-button');
    const resultEl = document.getElementById('rebuild-result');

    button.disabled = true;
    button.textContent = 'Building...';
    resultEl.style.display = 'none';

    try {
      const response = await fetch('/demo/kb?action=rebuild', { method: 'POST' });
      const data = await response.json();
      resultEl.textContent = JSON.stringify(data, null, 2);
      resultEl.style.display = 'block';
    } catch (error) {
      resultEl.textContent = 'Error: ' + error.message;
      resultEl.style.display = 'block';
    } finally {
      button.disabled = false;
      button.textContent = 'Rebuild';
    }
  }
`;

async function handleKBDemo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.searchParams.get("action") === "rebuild") {
    const startTime = Date.now();
    const result = await buildKB(env, loadKBFiles());
    const duration = Date.now() - startTime;

    return Response.json({
      success: true,
      ...result,
      duration: `${duration}ms`,
    });
  }

  const stats = getKBStats();

  const categoryBadges = Object.entries(stats.byCategory)
    .map(
      ([category, count]) =>
        `<span style="background: #e0f2fe; color: #0369a1; padding: 6px 12px; border-radius: 6px; font-size: 13px">${category}: ${count}</span>`
    )
    .join(" ");

  const bodyContent = `
    <div class="card">
      <h2>Files</h2>
      <div style="display: grid; gap: 12px; margin-bottom: 20px">
        <div style="background: #f5f5f5; padding: 16px; border-radius: 8px; text-align: center">
          <div style="font-size: 24px; font-weight: bold; color: #3b82f6">${stats.totalFiles}</div>
          <div style="font-size: 12px; color: #64748b; margin-top: 4px">Total</div>
        </div>
      </div>
      <h2 style="margin-top: 16px">By Category</h2>
      <div style="display: flex; flex-wrap: wrap; gap: 8px">${categoryBadges}</div>
    </div>

    <div class="card">
      <h2>Rebuild</h2>
      <p style="color: #64748b; font-size: 14px; margin-bottom: 16px">
        Clear and rebuild KB from source.
      </p>
      <button id="rebuild-button" class="btn btn-primary" onclick="rebuildKB()">
        Rebuild
      </button>
      <div id="rebuild-result" class="result"></div>
    </div>
  `;

  const html = renderHtmlPage("Knowledge Base", "KB Build & Stats", bodyContent, KB_SCRIPT);

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// =============================================================================
// Route Configuration
// =============================================================================

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

const routes: Record<string, RouteHandler> = {
  "/api/messages": (request) => handleBotMessage(request),
  "/callback": handleClioCallback,
  "/demo/org-membership": handleOrgMembershipDemo,
  "/demo/org-deletion": handleOrgDeletionDemo,
  "/demo/kb": handleKBDemo,
  "/": handleAuthDemo,
};

// =============================================================================
// Main Worker Export
// =============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle auth routes via Better Auth
    if (url.pathname.startsWith("/api/auth")) {
      try {
        return await getAuth(env).handler(request);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }

    // Handle other routes
    const handler = routes[url.pathname];

    if (handler) {
      return handler(request, env);
    }

    // Return available routes for unknown paths
    return Response.json({ routes: Object.keys(routes) });
  },
};
