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
import {
  uploadOrgContext,
  listOrgContext,
  deleteOrgContext,
} from "./services/org-context";
import { retrieveRAGContext, formatRAGContext } from "./services/rag-retrieval";
import {
  buildAuthPage,
  buildOrgMembershipPage,
  buildOrgDeletionPage,
  buildKBPage,
} from "./demo";

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
    if (currentVersion >= 1) return;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, scope TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS pending_confirmations (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        user_id TEXT NOT NULL, action TEXT NOT NULL, object_type TEXT NOT NULL,
        params TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_confirmations(expires_at);

      CREATE TABLE IF NOT EXISTS org_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS clio_schema_cache (object_type TEXT PRIMARY KEY, schema TEXT NOT NULL, custom_fields TEXT, fetched_at INTEGER NOT NULL);

      PRAGMA user_version = 1;
    `);
  }

  async appendAuditLog(entry: AuditEntryInput): Promise<{ id: string }> {
    const now = new Date();
    const id = crypto.randomUUID();
    const path = `orgs/${this.ctx.id}/audit/${now.getFullYear()}/${String(
      now.getMonth() + 1
    ).padStart(2, "0")}/${String(now.getDate()).padStart(
      2,
      "0"
    )}/${now.getTime()}-${id}.json`;
    await this.env.R2.put(
      path,
      JSON.stringify({ id, created_at: now.toISOString(), ...entry }),
      { httpMetadata: { contentType: "application/json" } }
    );
    return { id };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/audit") {
      return Response.json(
        await this.appendAuditLog((await request.json()) as AuditEntryInput)
      );
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

async function handleClioCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
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

  if (!tokenResponse.ok)
    return Response.json(
      { error: "Token exchange failed", details: await tokenResponse.text() },
      { status: 502 }
    );
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
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const activity = (await request.json()) as BotActivity;
  if (!activity.serviceUrl || !activity.conversation?.id)
    return new Response(null, { status: 200 });

  let replyText: string | null = null;
  if (activity.type === "message" && activity.text)
    replyText = `Echo: ${activity.text}`;
  else if (activity.type === "conversationUpdate")
    replyText = "Welcome to Docket!";

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


async function handleAuthDemo(request: Request, env: Env): Promise<Response> {
  const session = await getAuth(env).api.getSession({
    headers: request.headers,
  });

  return new Response(buildAuthPage(session), {
    headers: { "Content-Type": "text/html" },
  });
}

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
    if (body.action === "get-membership" && body.userId && body.orgId)
      return Response.json({
        membership: await getOrgMembership(env.DB, body.userId, body.orgId),
      });
    if (body.action === "get-members" && body.orgId)
      return Response.json({
        members: await getOrgMembers(env.DB, body.orgId),
      });
    if (body.action === "remove" && body.userId && body.orgId)
      return Response.json(
        await removeUserFromOrg(env.DB, body.userId, body.orgId)
      );
    if (
      body.action === "transfer" &&
      body.orgId &&
      body.userId &&
      body.toUserId
    )
      return Response.json(
        await transferOwnership(env.DB, body.orgId, body.userId, body.toUserId)
      );
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  return new Response(buildOrgMembershipPage(), {
    headers: { "Content-Type": "text/html" },
  });
}

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
    if (body.action === "preview" && body.orgId)
      return Response.json(await getOrgDeletionPreview(env.DB, body.orgId));
    if (body.action === "delete" && body.orgId && body.userId)
      return Response.json(
        await deleteOrg(env.DB, env.R2, body.orgId, body.userId)
      );
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  return new Response(buildOrgDeletionPage(), {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleKBDemo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  if (request.method === "POST" && action === "query") {
    const { query, orgId, jurisdiction, practiceType, firmSize } =
      (await request.json()) as {
        query: string;
        orgId: string;
        jurisdiction: string | null;
        practiceType: string | null;
        firmSize: string | null;
      };
    const context = await retrieveRAGContext(env, query, orgId, {
      jurisdiction,
      practiceType,
      firmSize,
    });
    return Response.json({
      raw: context,
      formatted: formatRAGContext(context),
      stats: {
        kbChunks: context.kbChunks.length,
        orgChunks: context.orgChunks.length,
      },
    });
  }

  if (request.method === "POST" && action === "upload") {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const orgId = formData.get("orgId") as string;
    if (!file || !orgId)
      return Response.json({ error: "Missing file or orgId" }, { status: 400 });
    await env.DB.prepare("INSERT OR IGNORE INTO org (id, name) VALUES (?, ?)")
      .bind(orgId, orgId)
      .run();
    return Response.json(
      await uploadOrgContext(
        env,
        orgId,
        file.name,
        file.type,
        await file.arrayBuffer()
      )
    );
  }

  if (request.method === "POST" && action === "rebuild") {
    const start = Date.now();
    const result = await buildKB(env, loadKBFiles());
    return Response.json({
      success: true,
      ...result,
      duration: `${Date.now() - start}ms`,
    });
  }

  if (action === "status") {
    const d1Count = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM kb_chunks"
    ).first<{ count: number }>();
    const emb = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["test"],
    })) as { data: number[][] };
    const vectorResults = await env.VECTORIZE.query(emb.data[0], {
      topK: 1,
      filter: { type: "kb" },
    });
    return Response.json({
      d1Count: d1Count?.count || 0,
      vectorizeCount: vectorResults.count,
    });
  }

  const stats = getKBStats();
  return new Response(buildKBPage(stats), {
    headers: { "Content-Type": "text/html" },
  });
}

async function handleOrgContextTest(
  request: Request,
  env: Env
): Promise<Response> {
  const testOrgId = `test-org-${Date.now()}`;
  const testContent =
    "# Test Document\n\nBilling procedures.\n\n## Section Two\n\nClient intake.";
  const steps: Array<{ step: string; result: unknown; error?: string }> = [];

  try {
    await env.DB.prepare("INSERT INTO org (id, name) VALUES (?, ?)")
      .bind(testOrgId, "Test Org")
      .run();
    steps.push({ step: "create_org", result: { orgId: testOrgId } });

    const content = new TextEncoder().encode(testContent);
    const result = await uploadOrgContext(
      env,
      testOrgId,
      "test-document.md",
      "text/markdown",
      content.buffer as ArrayBuffer
    );
    steps.push({ step: "upload", result });

    if (!result.success || !result.fileId)
      return Response.json({ steps, error: "Upload failed" }, { status: 500 });
    const fileId = result.fileId;

    steps.push({ step: "list", result: await listOrgContext(env, testOrgId) });

    const d1Check = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM org_context_chunks WHERE org_id = ? AND file_id = ?"
    )
      .bind(testOrgId, fileId)
      .first<{ count: number }>();
    steps.push({ step: "d1_verify", result: d1Check });

    const vectorCheck = await env.VECTORIZE.getByIds([
      `${testOrgId}_${fileId}_0`,
    ]);
    steps.push({
      step: "vectorize_verify",
      result: { found: vectorCheck.length > 0 },
    });

    steps.push({
      step: "delete",
      result: await deleteOrgContext(env, testOrgId, fileId),
    });

    const postDelete = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM org_context_chunks WHERE org_id = ? AND file_id = ?"
    )
      .bind(testOrgId, fileId)
      .first<{ count: number }>();
    steps.push({ step: "verify_deletion", result: postDelete });

    await env.DB.prepare("DELETE FROM org WHERE id = ?").bind(testOrgId).run();
    steps.push({ step: "cleanup_org", result: { deleted: testOrgId } });

    return Response.json({ success: true, steps });
  } catch (error) {
    steps.push({
      step: "error",
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ success: false, steps }, { status: 500 });
  }
}

interface RAGTestRequest {
  query: string;
  orgId?: string;
  jurisdiction?: string;
  practiceType?: string;
  firmSize?: string;
}

async function handleRAGTest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return Response.json(
      {
        usage: "POST with JSON body",
        example: {
          query: "How do I calculate statute of limitations?",
          orgId: "my-org",
          jurisdiction: "CA",
        },
      },
      { status: 400 }
    );
  const body = (await request.json()) as RAGTestRequest;
  if (!body.query)
    return Response.json({ error: "query is required" }, { status: 400 });

  try {
    const context = await retrieveRAGContext(
      env,
      body.query,
      body.orgId || "test-org",
      {
        jurisdiction: body.jurisdiction || null,
        practiceType: body.practiceType || null,
        firmSize: body.firmSize || null,
      }
    );
    return Response.json({
      query: body.query,
      stats: {
        kbChunks: context.kbChunks.length,
        orgChunks: context.orgChunks.length,
        formattedLength: formatRAGContext(context).length,
      },
      context,
      formatted: formatRAGContext(context),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

async function handleRAGDebug(request: Request, env: Env): Promise<Response> {
  try {
    const d1Count = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM kb_chunks"
    ).first<{ count: number }>();
    const d1Sample = await env.DB.prepare(
      "SELECT id, source, category, jurisdiction, practice_type, firm_size FROM kb_chunks LIMIT 3"
    ).all();
    const emb = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: ["billing best practices"],
    })) as { data: number[][] };
    const noFilter = await env.VECTORIZE.query(emb.data[0], {
      topK: 3,
      returnMetadata: "all",
    });
    const withFilter = await env.VECTORIZE.query(emb.data[0], {
      topK: 3,
      returnMetadata: "all",
      filter: { type: "kb" },
    });

    return Response.json({
      d1: { count: d1Count?.count || 0, sample: d1Sample.results },
      vectorize: {
        noFilter: {
          count: noFilter.count,
          matches: noFilter.matches.map((m) => ({
            id: m.id,
            score: m.score,
            metadata: m.metadata,
          })),
        },
        withTypeFilter: {
          count: withFilter.count,
          matches: withFilter.matches.map((m) => ({
            id: m.id,
            score: m.score,
            metadata: m.metadata,
          })),
        },
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

type RouteHandler = (request: Request, env: Env) => Promise<Response>;

const routes: Record<string, RouteHandler> = {
  "/api/messages": (request) => handleBotMessage(request),
  "/callback": handleClioCallback,
  "/demo/org-membership": handleOrgMembershipDemo,
  "/demo/org-deletion": handleOrgDeletionDemo,
  "/demo/kb": handleKBDemo,
  "/test/org-context": handleOrgContextTest,
  "/test/rag": handleRAGTest,
  "/test/rag-debug": handleRAGDebug,
  "/": handleAuthDemo,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth")) {
      try {
        return await getAuth(env).handler(request);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 500 });
      }
    }
    const handler = routes[url.pathname];
    if (handler) return handler(request, env);
    return Response.json({ routes: Object.keys(routes) });
  },
};
