import { getAuth } from "./lib/auth";
import { TenantDO } from "./do/tenant";
import { handleTeamsMessage } from "./handlers/teams";
import { handleClioConnect, handleClioCallback } from "./handlers/clio-oauth";
import type { Env } from "./types/env";

export { TenantDO };
export type { Env };

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://docketadmin.com",
  "https://www.docketadmin.com",
];

function getCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

function withCors(response: Response, request: Request): Response {
  const corsHeaders = getCorsHeaders(request);
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // Health check endpoints
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }

    if (path === "/ready") {
      return handleReadyCheck(env);
    }

    // Auth routes (need CORS)
    if (path.startsWith("/api/auth")) {
      const response = await handleAuth(request, env);
      return withCors(response, request);
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

    return withCors(Response.json({ error: "Not found" }, { status: 404 }), request);
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
