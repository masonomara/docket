import type { MemberContext, AdminContext } from "../lib/session";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthorizationUrl,
  verifyState,
  exchangeCodeForTokens,
} from "../services/clio-oauth";
import { createLogger, generateRequestId } from "../lib/logger";
import type { Env } from "../types/env";
import { errorResponse } from "../lib/errors";

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Get the Durable Object stub for an organization.
 */
function getOrgDurableObject(env: Env, orgId: string) {
  const doId = env.TENANT.idFromName(orgId);
  return env.TENANT.get(doId);
}

/**
 * Make a POST request to the organization's Durable Object.
 */
async function callDurableObject(
  env: Env,
  orgId: string,
  path: string,
  body: object
): Promise<Response> {
  const stub = getOrgDurableObject(env, orgId);
  const request = new Request(`https://do${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return stub.fetch(request);
}

/**
 * Build the web app URL from the API URL (removes "api." prefix).
 */
function getWebOrigin(apiOrigin: string): string {
  return apiOrigin.replace("api.", "");
}

// -----------------------------------------------------------------------------
// Clio OAuth Handlers
// -----------------------------------------------------------------------------

/**
 * GET /clio/connect
 * Initiates the Clio OAuth flow by redirecting to Clio's authorization page.
 */
export async function handleClioConnectAuth(
  request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const log = createLogger({
    requestId: generateRequestId(),
    handler: "clio-connect",
  });

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/clio/callback`;

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Generate signed state that includes user context
  const state = await generateState(
    ctx.user.id,
    ctx.orgId,
    codeVerifier,
    env.CLIO_CLIENT_SECRET
  );

  // Build the authorization URL
  const authUrl = buildAuthorizationUrl({
    clientId: env.CLIO_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  });

  log.info("Redirecting to Clio OAuth", { orgId: ctx.orgId });
  return Response.redirect(authUrl, 302);
}

/**
 * GET /clio/callback
 * Handles the OAuth callback from Clio after user authorization.
 */
export async function handleClioCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-callback" });

  const url = new URL(request.url);
  const webOrigin = getWebOrigin(url.origin);
  const settingsUrl = `${webOrigin}/org/clio`;

  // Check for OAuth errors (user denied access, etc.)
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    log.warn("OAuth authorization denied", { error: oauthError });
    return Response.redirect(`${settingsUrl}?error=denied`);
  }

  // Validate required parameters
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    log.warn("Missing code or state in callback");
    return Response.redirect(`${settingsUrl}?error=invalid_request`);
  }

  // Verify and decode the state parameter
  const stateData = await verifyState(state, env.CLIO_CLIENT_SECRET);
  if (!stateData) {
    log.warn("State verification failed");
    return Response.redirect(`${settingsUrl}?error=invalid_state`);
  }

  const { userId, orgId, verifier } = stateData;

  try {
    // Exchange the authorization code for tokens
    const redirectUri = `${url.origin}/clio/callback`;
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: verifier,
      clientId: env.CLIO_CLIENT_ID,
      clientSecret: env.CLIO_CLIENT_SECRET,
      redirectUri,
    });

    // Store tokens in the organization's Durable Object
    const storeResponse = await callDurableObject(env, orgId, "/store-clio-token", {
      userId,
      tokens,
      requestId,
    });

    if (!storeResponse.ok) {
      log.error("Failed to store Clio tokens");
      return Response.redirect(`${settingsUrl}?error=exchange_failed`);
    }

    // Provision the Clio schema (fetch custom fields, etc.)
    await callDurableObject(env, orgId, "/provision-schema", {
      userId,
      requestId,
    });

    log.info("Clio connected successfully", { userId, orgId });
    return Response.redirect(`${settingsUrl}?success=connected`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Clio callback failed", { error: errorMessage });
    return Response.redirect(`${settingsUrl}?error=exchange_failed`);
  }
}

// -----------------------------------------------------------------------------
// Clio Status & Management Handlers
// -----------------------------------------------------------------------------

/**
 * GET /org/clio/status
 * Returns the current Clio connection status for the organization.
 */
export async function handleClioStatus(
  _request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const requestId = generateRequestId();

  const response = await callDurableObject(env, ctx.orgId, "/get-clio-status", {
    userId: ctx.user.id,
    requestId,
  });

  // If the DO request fails, return a disconnected status
  if (!response.ok) {
    return Response.json({ connected: false, schemaLoaded: false });
  }

  const status = (await response.json()) as {
    connected: boolean;
    customFieldsCount: number;
    schemaVersion?: number;
    lastSyncedAt?: number;
  };

  return Response.json({
    connected: status.connected,
    schemaLoaded: status.customFieldsCount > 0,
    schemaVersion: status.schemaVersion,
    lastSyncedAt: status.lastSyncedAt,
  });
}

/**
 * POST /org/clio/refresh-schema
 * Refresh the Clio schema (custom fields, etc.) for the organization.
 */
export async function handleClioRefreshSchema(
  _request: Request,
  env: Env,
  ctx: AdminContext
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-refresh-schema" });

  const response = await callDurableObject(env, ctx.orgId, "/refresh-schema", {
    userId: ctx.user.id,
    requestId,
  });

  if (!response.ok) {
    log.error("Schema refresh failed", { status: response.status });
    const errorBody = await response.json();
    return Response.json(errorBody, { status: response.status });
  }

  const result = (await response.json()) as { count?: number };
  log.info("Schema refreshed successfully", { count: result.count });

  return Response.json(result);
}

/**
 * POST /org/clio/disconnect
 * Disconnect the Clio integration for the organization.
 */
export async function handleClioDisconnect(
  _request: Request,
  env: Env,
  ctx: MemberContext
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-disconnect" });

  const response = await callDurableObject(env, ctx.orgId, "/delete-clio-token", {
    userId: ctx.user.id,
    requestId,
  });

  if (!response.ok) {
    log.error("Failed to disconnect Clio");
    return errorResponse(response.status, "Failed to disconnect", "INTERNAL_ERROR");
  }

  log.info("Clio disconnected successfully", { orgId: ctx.orgId });
  return Response.json({ success: true });
}
