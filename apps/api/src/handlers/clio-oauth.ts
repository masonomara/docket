import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  verifyState,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
} from "../services/clio-oauth";
import type { Env } from "../types/env";

/**
 * Initiates the Clio OAuth flow.
 * Generates PKCE credentials and redirects user to Clio's authorization page.
 */
export async function handleClioConnect(
  request: Request,
  env: Env
): Promise<Response> {
  // Extract user info from headers (set by auth middleware)
  const userId = request.headers.get("X-User-Id");
  const orgId = request.headers.get("X-Org-Id");

  if (!userId || !orgId) {
    return Response.redirect("/login?redirect=/settings/clio");
  }

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

  return Response.redirect(authUrl, 302);
}

/**
 * Handles the OAuth callback from Clio.
 * Exchanges the authorization code for tokens and stores them.
 */
export async function handleClioCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const settingsUrl = `${url.origin}/settings/clio`;

  // Check for OAuth errors
  const error = url.searchParams.get("error");
  if (error) {
    return Response.redirect(`${settingsUrl}?error=denied`);
  }

  // Validate required parameters
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return Response.redirect(`${settingsUrl}?error=invalid_request`);
  }

  // Verify and decode the state parameter
  const stateData = await verifyState(state, env.CLIO_CLIENT_SECRET);
  if (!stateData) {
    return Response.redirect(`${settingsUrl}?error=invalid_state`);
  }

  const { userId, orgId, verifier } = stateData;

  try {
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens({
      code,
      codeVerifier: verifier,
      clientId: env.CLIO_CLIENT_ID,
      clientSecret: env.CLIO_CLIENT_SECRET,
      redirectUri: url.origin + "/clio/callback",
    });

    // Store tokens in the organization's Durable Object
    const doStub = env.TENANT.get(env.TENANT.idFromName(orgId));

    await doStub.fetch(
      new Request("https://do/store-clio-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, tokens }),
      })
    );

    // Provision the Clio schema for this organization
    await doStub.fetch(
      new Request("https://do/provision-schema", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      })
    );

    return Response.redirect(`${settingsUrl}?success=connected`);
  } catch (error) {
    console.error("Clio callback error:", error);
    return Response.redirect(`${settingsUrl}?error=exchange_failed`);
  }
}
