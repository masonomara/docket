// =============================================================================
// Clio OAuth Unit Tests
// =============================================================================
//
// Tests for OAuth 2.0 + PKCE implementation:
// - PKCE code verifier and challenge generation
// - State parameter creation and verification
// - Authorization URL building
// - Token refresh timing logic
// - Token exchange and refresh failure handling

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  verifyState,
  buildAuthorizationUrl,
  tokenNeedsRefresh,
  refreshAccessToken,
  exchangeCodeForTokens,
} from "../../src/services/clio-oauth";

// =============================================================================
// Test Constants
// =============================================================================

const TEST_SECRET = "test-secret-key-for-hmac-signing";

// Pattern for URL-safe base64 (no +, /, or = characters)
const URL_SAFE_BASE64_PATTERN = /^[A-Za-z0-9_-]+$/;

// =============================================================================
// PKCE Tests
// =============================================================================

describe("PKCE", () => {
  describe("Code Verifier Generation", () => {
    it("generates a verifier of at least 43 characters", () => {
      const verifier = generateCodeVerifier();

      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    it("generates URL-safe base64 characters only", () => {
      const verifier = generateCodeVerifier();

      expect(verifier).toMatch(URL_SAFE_BASE64_PATTERN);
    });

    it("generates unique verifiers on each call", () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      const verifier3 = generateCodeVerifier();

      const uniqueVerifiers = new Set([verifier1, verifier2, verifier3]);

      expect(uniqueVerifiers.size).toBe(3);
    });
  });

  describe("Code Challenge Generation", () => {
    it("generates a non-empty challenge", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      expect(challenge.length).toBeGreaterThan(0);
    });

    it("generates URL-safe base64 characters only", async () => {
      const verifier = generateCodeVerifier();
      const challenge = await generateCodeChallenge(verifier);

      expect(challenge).toMatch(URL_SAFE_BASE64_PATTERN);
    });

    it("produces different challenges for different verifiers", async () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();

      const challenge1 = await generateCodeChallenge(verifier1);
      const challenge2 = await generateCodeChallenge(verifier2);

      expect(challenge1).not.toBe(challenge2);
    });

    it("produces the same challenge for the same verifier (deterministic)", async () => {
      const verifier = "consistent-verifier-for-testing-purposes-43chars";

      const challenge1 = await generateCodeChallenge(verifier);
      const challenge2 = await generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });
  });
});

// =============================================================================
// State Parameter Tests
// =============================================================================

describe("State Management", () => {
  describe("State Generation", () => {
    it("creates state that can be verified with same secret", async () => {
      const verifier = generateCodeVerifier();

      const state = await generateState(
        "user-1",
        "org-1",
        verifier,
        TEST_SECRET
      );
      const result = await verifyState(state, TEST_SECRET);

      expect(result).toEqual({
        userId: "user-1",
        orgId: "org-1",
        verifier,
      });
    });

    it("creates state with payload.signature format", async () => {
      const state = await generateState(
        "user-1",
        "org-1",
        "verifier",
        TEST_SECRET
      );

      const parts = state.split(".");

      expect(parts.length).toBe(2);
      expect(parts[0]).toMatch(URL_SAFE_BASE64_PATTERN); // payload
      expect(parts[1]).toMatch(URL_SAFE_BASE64_PATTERN); // signature
    });

    it("produces different states for different user IDs", async () => {
      const state1 = await generateState("user-1", "org-1", "v1", TEST_SECRET);
      const state2 = await generateState("user-2", "org-1", "v1", TEST_SECRET);
      const state3 = await generateState("user-3", "org-1", "v1", TEST_SECRET);

      const uniqueStates = new Set([state1, state2, state3]);

      expect(uniqueStates.size).toBe(3);
    });

    it("produces different states for different org IDs", async () => {
      const state1 = await generateState("user-1", "org-1", "v1", TEST_SECRET);
      const state2 = await generateState("user-1", "org-2", "v1", TEST_SECRET);

      expect(state1).not.toBe(state2);
    });
  });

  describe("State Verification", () => {
    it("rejects state with tampered payload", async () => {
      const state = await generateState(
        "user-1",
        "org-1",
        "verifier",
        TEST_SECRET
      );

      // Modify the first character of the payload
      const tamperedState = "X" + state.slice(1);
      const result = await verifyState(tamperedState, TEST_SECRET);

      expect(result).toBeNull();
    });

    it("rejects state with tampered signature", async () => {
      const state = await generateState(
        "user-1",
        "org-1",
        "verifier",
        TEST_SECRET
      );

      // Modify the last character of the signature
      const tamperedState = state.slice(0, -1) + "X";
      const result = await verifyState(tamperedState, TEST_SECRET);

      expect(result).toBeNull();
    });

    it("rejects state verified with wrong secret", async () => {
      const state = await generateState(
        "user-1",
        "org-1",
        "verifier",
        TEST_SECRET
      );

      const result = await verifyState(state, "wrong-secret");

      expect(result).toBeNull();
    });

    it("rejects state without dot separator", async () => {
      const result = await verifyState("no-dot-separator", TEST_SECRET);

      expect(result).toBeNull();
    });

    it("rejects state with invalid base64 characters", async () => {
      const result = await verifyState("invalid!!!.base64", TEST_SECRET);

      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// Authorization URL Tests
// =============================================================================

describe("Authorization URL", () => {
  // Shared test parameters
  const defaultParams = {
    clientId: "test-client-id",
    redirectUri: "https://example.com/callback",
    state: "test-state-value",
    codeChallenge: "test-code-challenge",
  };

  it("builds URL with Clio OAuth authorize endpoint", () => {
    const url = buildAuthorizationUrl(defaultParams);

    expect(url).toContain("https://app.clio.com/oauth/authorize");
  });

  it("includes all required OAuth 2.0 parameters", () => {
    const url = buildAuthorizationUrl(defaultParams);
    const parsedUrl = new URL(url);
    const params = parsedUrl.searchParams;

    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("test-client-id");
    expect(params.get("redirect_uri")).toBe("https://example.com/callback");
    expect(params.get("state")).toBe("test-state-value");
    expect(params.get("code_challenge")).toBe("test-code-challenge");
    expect(params.get("code_challenge_method")).toBe("S256");
  });

  it("URL-encodes the redirect URI", () => {
    const paramsWithSpecialChars = {
      ...defaultParams,
      redirectUri: "https://example.com/callback?foo=bar&baz=qux",
    };

    const url = buildAuthorizationUrl(paramsWithSpecialChars);

    // The redirect_uri should be URL-encoded (no raw :// or & characters)
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com");
    expect(url).not.toContain("redirect_uri=https://");
  });
});

// =============================================================================
// Token Refresh Logic Tests
// =============================================================================

describe("Token Refresh Logic", () => {
  /**
   * Helper to create a token with a specific expiration time
   */
  function createToken(expiresAt: number) {
    return {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_at: expiresAt,
      token_type: "Bearer",
    };
  }

  // Time constants for clarity
  const ONE_MINUTE_MS = 60 * 1000;
  const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
  const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

  it("returns true for tokens expiring within 5 minutes", () => {
    const twoMinutesFromNow = Date.now() + 2 * ONE_MINUTE_MS;
    const token = createToken(twoMinutesFromNow);

    const needsRefresh = tokenNeedsRefresh(token);

    expect(needsRefresh).toBe(true);
  });

  it("returns true for already expired tokens", () => {
    const oneSecondAgo = Date.now() - 1000;
    const token = createToken(oneSecondAgo);

    const needsRefresh = tokenNeedsRefresh(token);

    expect(needsRefresh).toBe(true);
  });

  it("returns false for tokens with more than 5 minutes remaining", () => {
    const oneHourFromNow = Date.now() + ONE_HOUR_MS;
    const token = createToken(oneHourFromNow);

    const needsRefresh = tokenNeedsRefresh(token);

    expect(needsRefresh).toBe(false);
  });

  it("returns true for tokens at exactly the 5 minute boundary", () => {
    const exactlyFiveMinutesFromNow = Date.now() + FIVE_MINUTES_MS;
    const token = createToken(exactlyFiveMinutesFromNow);

    const needsRefresh = tokenNeedsRefresh(token);

    expect(needsRefresh).toBe(true);
  });

  it("returns false for tokens just past the 5 minute boundary", () => {
    const justPastFiveMinutes = Date.now() + FIVE_MINUTES_MS + 1000;
    const token = createToken(justPastFiveMinutes);

    const needsRefresh = tokenNeedsRefresh(token);

    expect(needsRefresh).toBe(false);
  });
});

// =============================================================================
// Token Refresh Failure Tests
// =============================================================================

describe("Token Refresh Failures", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  const refreshParams = {
    refreshToken: "expired-refresh-token",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  };

  it("throws error with status and message on invalid_grant", async () => {
    // Simulate Clio returning invalid_grant (refresh token revoked/expired)
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        statusText: "Bad Request",
      })
    );

    await expect(refreshAccessToken(refreshParams)).rejects.toThrow(
      /Token refresh failed: 400/
    );
  });

  it("includes error details in exception message", async () => {
    const errorBody = JSON.stringify({
      error: "invalid_grant",
      error_description: "The refresh token has expired",
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(errorBody, { status: 400 })
    );

    await expect(refreshAccessToken(refreshParams)).rejects.toThrow(
      /invalid_grant/
    );
  });

  it("throws on server errors (5xx)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(refreshAccessToken(refreshParams)).rejects.toThrow(
      /Token refresh failed: 500/
    );
  });

  it("throws on unauthorized (401)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );

    await expect(refreshAccessToken(refreshParams)).rejects.toThrow(
      /Token refresh failed: 401/
    );
  });

  it("returns valid tokens on success", async () => {
    const mockTokens = {
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    );

    const tokens = await refreshAccessToken(refreshParams);

    expect(tokens.access_token).toBe("new-access-token");
    expect(tokens.refresh_token).toBe("new-refresh-token");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });
});

// =============================================================================
// Token Exchange Failure Tests
// =============================================================================

describe("Token Exchange Failures", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  const exchangeParams = {
    code: "auth-code",
    codeVerifier: "test-verifier-43-chars-minimum-length-ok",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "https://example.com/callback",
  };

  it("throws error on invalid authorization code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );

    await expect(exchangeCodeForTokens(exchangeParams)).rejects.toThrow(
      /Token exchange failed: 400/
    );
  });

  it("throws error when PKCE verification fails", async () => {
    const errorBody = JSON.stringify({
      error: "invalid_grant",
      error_description: "code_verifier does not match code_challenge",
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(errorBody, { status: 400 })
    );

    await expect(exchangeCodeForTokens(exchangeParams)).rejects.toThrow(
      /code_verifier/
    );
  });

  it("returns valid tokens on success", async () => {
    const mockTokens = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    };

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(mockTokens), { status: 200 })
    );

    const tokens = await exchangeCodeForTokens(exchangeParams);

    expect(tokens.access_token).toBe("access-token");
    expect(tokens.refresh_token).toBe("refresh-token");
    expect(tokens.token_type).toBe("Bearer");
  });
});
