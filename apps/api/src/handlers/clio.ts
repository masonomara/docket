import { getAuth } from "../lib/auth";
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

/**
 * Validates the session and returns the authenticated user.
 */
async function getAuthenticatedSession(request: Request, env: Env) {
  try {
    const auth = getAuth(env);
    const session = await auth.api.getSession({ headers: request.headers });
    return session;
  } catch {
    return null;
  }
}

/**
 * Gets the user's org membership with admin check.
 */
async function getAdminMembership(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      `SELECT org_id, role FROM org_members WHERE user_id = ? AND role = 'admin'`
    )
    .bind(userId)
    .first<{ org_id: string; role: string }>();

  return row;
}

/**
 * Gets the user's org membership.
 */
async function getMembership(db: D1Database, userId: string) {
  const row = await db
    .prepare(`SELECT org_id, role FROM org_members WHERE user_id = ?`)
    .bind(userId)
    .first<{ org_id: string; role: string }>();

  return row;
}

/**
 * Initiates the Clio OAuth flow.
 * Requires authenticated user with org membership.
 *
 * GET /api/clio/connect
 */
export async function handleClioConnectAuth(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-connect" });

  const session = await getAuthenticatedSession(request, env);
  if (!session?.user) {
    log.info("No session found, redirecting to login");
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}/login?redirect=/org/clio`);
  }

  const userId = session.user.id;
  log.info("Initiating Clio OAuth flow", { userId });

  const membership = await getMembership(env.DB, userId);

  if (!membership) {
    log.warn("User has no org membership", { userId });
    const url = new URL(request.url);
    return Response.redirect(`${url.origin}/dashboard`);
  }

  const orgId = membership.org_id;
  log.info("User org found", { userId, orgId });

  // Generate PKCE credentials
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  // Create signed state containing user context
  const state = await generateState(
    userId,
    orgId,
    codeVerifier,
    env.CLIO_CLIENT_SECRET
  );

  // Build callback URL
  const requestUrl = new URL(request.url);
  const redirectUri = requestUrl.origin + "/clio/callback";

  // Redirect to Clio's authorization page
  const authUrl = buildAuthorizationUrl({
    clientId: env.CLIO_CLIENT_ID,
    redirectUri,
    state,
    codeChallenge,
  });

  log.info("Redirecting to Clio authorization", { redirectUri, orgId });
  return Response.redirect(authUrl, 302);
}

/**
 * Gets the current user's Clio connection status.
 *
 * GET /api/clio/status
 */
export async function handleClioStatus(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-status" });

  const session = await getAuthenticatedSession(request, env);
  if (!session?.user) {
    log.debug("Unauthorized status check");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const membership = await getMembership(env.DB, userId);

  if (!membership) {
    log.debug("User has no org", { userId });
    return Response.json({ error: "No organization" }, { status: 400 });
  }

  const orgId = membership.org_id;
  log.debug("Checking Clio status", { userId, orgId });

  // Check if user has Clio tokens in DO
  const doStub = env.TENANT.get(env.TENANT.idFromName(orgId));
  const response = await doStub.fetch(
    new Request("https://do/get-clio-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, requestId }),
    })
  );

  if (!response.ok) {
    log.debug("DO returned error for status check", { status: response.status });
    return Response.json({ connected: false, schemaLoaded: false });
  }

  const doStatus = (await response.json()) as {
    connected: boolean;
    customFieldsCount: number;
    schemaVersion?: number;
    lastSyncedAt?: number;
  };

  const status = {
    connected: doStatus.connected,
    schemaLoaded: doStatus.customFieldsCount > 0,
    schemaVersion: doStatus.schemaVersion,
    lastSyncedAt: doStatus.lastSyncedAt,
  };

  log.debug("Clio status retrieved", { ...status, userId, orgId });
  return Response.json(status);
}

/**
 * Refreshes the Clio schema cache.
 * Requires admin role.
 *
 * POST /api/org/clio/refresh-schema
 */
export async function handleClioRefreshSchema(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-refresh-schema" });

  const session = await getAuthenticatedSession(request, env);
  if (!session?.user) {
    log.debug("Unauthorized schema refresh attempt");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const membership = await getAdminMembership(env.DB, userId);

  if (!membership) {
    log.warn("Non-admin tried to refresh schema", { userId });
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }

  const orgId = membership.org_id;
  log.info("Refreshing Clio schema", { userId, orgId });

  // Call DO to refresh schema
  const doStub = env.TENANT.get(env.TENANT.idFromName(orgId));
  const response = await doStub.fetch(
    new Request("https://do/refresh-schema", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, requestId }),
    })
  );

  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    log.error("Schema refresh failed", { status: response.status, error });
    return Response.json(error, { status: response.status });
  }

  const result = (await response.json()) as { count?: number };
  log.info("Schema refresh completed", { count: result.count, orgId });
  return Response.json(result);
}

/**
 * Disconnects the user's Clio account.
 *
 * POST /api/clio/disconnect
 */
export async function handleClioDisconnect(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-disconnect" });

  const session = await getAuthenticatedSession(request, env);
  if (!session?.user) {
    log.debug("Unauthorized disconnect attempt");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const membership = await getMembership(env.DB, userId);

  if (!membership) {
    log.debug("User has no org", { userId });
    return Response.json({ error: "No organization" }, { status: 400 });
  }

  const orgId = membership.org_id;
  log.info("Disconnecting Clio account", { userId, orgId });

  // Call DO to delete Clio tokens
  const doStub = env.TENANT.get(env.TENANT.idFromName(orgId));
  const response = await doStub.fetch(
    new Request("https://do/delete-clio-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, requestId }),
    })
  );

  if (!response.ok) {
    log.error("Failed to disconnect Clio", { status: response.status });
    return Response.json(
      { error: "Failed to disconnect" },
      { status: response.status }
    );
  }

  log.info("Clio account disconnected", { userId, orgId });
  return Response.json({ success: true });
}

/**
 * Handles the OAuth callback from Clio.
 * Exchanges the authorization code for tokens and stores them.
 */
export async function handleClioCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, handler: "clio-callback" });

  const url = new URL(request.url);

  // Determine web app origin - derive from API origin by removing "api." prefix
  const webOrigin = url.origin.replace("api.", "");
  const settingsUrl = `${webOrigin}/org/clio`;

  log.info("Clio OAuth callback received", {
    hasCode: url.searchParams.has("code"),
    hasState: url.searchParams.has("state"),
    hasError: url.searchParams.has("error"),
    origin: url.origin,
    webOrigin,
  });

  // Check for OAuth errors from Clio
  const oauthError = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (oauthError) {
    log.warn("Clio OAuth denied by user or error from Clio", {
      error: oauthError,
      errorDescription,
    });
    return Response.redirect(`${settingsUrl}?error=denied`);
  }

  // Validate required parameters
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    log.warn("Missing code or state in callback", {
      hasCode: !!code,
      hasState: !!state,
    });
    return Response.redirect(`${settingsUrl}?error=invalid_request`);
  }

  // Verify and decode the state parameter
  const stateData = await verifyState(state, env.CLIO_CLIENT_SECRET);
  if (!stateData) {
    log.warn("State verification failed - expired or tampered");
    return Response.redirect(`${settingsUrl}?error=invalid_state`);
  }

  const { userId, orgId, verifier } = stateData;
  log.info("State verified successfully", { userId, orgId });

  try {
    // Exchange code for tokens
    const redirectUri = url.origin + "/clio/callback";
    log.info("Exchanging authorization code for tokens", { redirectUri });

    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: verifier,
      clientId: env.CLIO_CLIENT_ID,
      clientSecret: env.CLIO_CLIENT_SECRET,
      redirectUri,
    });

    log.info("Token exchange successful", {
      tokenType: tokens.token_type,
      expiresAt: new Date(tokens.expires_at).toISOString(),
    });

    // Store tokens in the organization's Durable Object
    const doStub = env.TENANT.get(env.TENANT.idFromName(orgId));

    log.info("Storing tokens in Durable Object", { orgId });
    const storeResponse = await doStub.fetch(
      new Request("https://do/store-clio-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, tokens, requestId }),
      })
    );

    if (!storeResponse.ok) {
      const errorBody = await storeResponse.text();
      log.error("Failed to store tokens in DO", {
        status: storeResponse.status,
        error: errorBody,
      });
      return Response.redirect(`${settingsUrl}?error=exchange_failed`);
    }

    // Provision the Clio schema for this organization
    log.info("Provisioning Clio schema", { orgId });
    const schemaResponse = await doStub.fetch(
      new Request("https://do/provision-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, requestId }),
      })
    );

    if (!schemaResponse.ok) {
      log.warn("Schema provisioning failed (tokens still stored)", {
        status: schemaResponse.status,
      });
      // Don't fail the connection - schema can be provisioned later
    } else {
      const schemaResult = (await schemaResponse.json()) as { count?: number };
      log.info("Schema provisioned successfully", {
        count: schemaResult.count,
      });
    }

    log.info("Clio connection completed successfully", { userId, orgId });
    return Response.redirect(`${settingsUrl}?success=connected`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    log.error("Clio callback failed", {
      error: errorMessage,
      stack: errorStack,
      userId,
      orgId,
    });

    return Response.redirect(`${settingsUrl}?error=exchange_failed`);
  }
}
