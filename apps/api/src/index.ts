import { getAuth } from "./lib/auth";
import { TenantDO } from "./do/tenant";
import { handleTeamsMessage } from "./handlers/teams";
import { handleClioConnect, handleClioCallback } from "./handlers/clio-oauth";
import type { Env } from "./types/env";

export { TenantDO };
export type { Env };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check endpoints
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    if (path === "/ready") {
      return handleReadyCheck(env);
    }

    // Auth routes
    if (path.startsWith("/api/auth")) {
      return handleAuth(request, env);
    }

    // API routes
    if (path === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // Clio OAuth routes
    if (path === "/clio/connect") {
      return handleClioConnect(request, env);
    }

    if (path === "/clio/callback") {
      return handleClioCallback(request, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function handleReadyCheck(env: Env): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return Response.json({ status: "ready", db: "ok" });
  } catch {
    return Response.json({ status: "not ready", db: "error" }, { status: 503 });
  }
}

async function handleAuth(request: Request, env: Env): Promise<Response> {
  try {
    return await getAuth(env).handler(request);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
