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
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  return {
    "Access-Control-Allow-Origin": isAllowed ? origin : ALLOWED_ORIGINS[0],
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

async function handleHealthCheck(): Promise<Response> {
  return Response.json({ status: "ok" });
}

async function handleReadyCheck(env: Env): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return Response.json({ status: "ready", db: "ok" });
  } catch {
    return Response.json({ status: "not ready", db: "error" }, { status: 503 });
  }
}

async function handleAuthRequest(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const auth = getAuth(env);
    return await auth.handler(request);
  } catch (error) {
    const errStr =
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : String(error);
    console.error("Auth handler exception:", errStr);
    return Response.json({ error: errStr }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    // Health and readiness endpoints (no CORS needed)
    if (path === "/health") {
      return handleHealthCheck();
    }

    if (path === "/ready") {
      return handleReadyCheck(env);
    }

    // Auth endpoints
    if (path.startsWith("/api/auth")) {
      const response = await handleAuthRequest(request, env);
      return withCors(response, request);
    }

    // Teams webhook
    if (path === "/api/messages") {
      return handleTeamsMessage(request, env);
    }

    // Clio OAuth flow
    if (path === "/clio/connect") {
      return handleClioConnect(request, env);
    }

    if (path === "/clio/callback") {
      return handleClioCallback(request, env);
    }

    // 404 for unmatched routes
    const notFoundResponse = Response.json(
      { error: "Not found" },
      { status: 404 }
    );
    return withCors(notFoundResponse, request);
  },
};
