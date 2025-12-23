import {
  encrypt,
  decrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  constantTimeEqual,
  type EncryptionEnv,
} from "../lib/encryption";

// =============================================================================
// Constants
// =============================================================================

const CLIO_OAUTH_AUTHORIZE = "https://app.clio.com/oauth/authorize";
const CLIO_OAUTH_TOKEN = "https://app.clio.com/oauth/token";

/** State tokens expire after 10 minutes */
const STATE_EXPIRY_MS = 10 * 60 * 1000;

/** Refresh tokens 5 minutes before they expire */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export interface ClioTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

interface ClioTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface StatePayload {
  userId: string;
  orgId: string;
  verifier: string;
  timestamp: number;
}

interface DOStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface AuthorizationUrlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface TokenExchangeParams {
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenRefreshParams {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

// =============================================================================
// Base64 URL Encoding (used for PKCE and state)
// =============================================================================

/**
 * Encode bytes to URL-safe base64 (no padding, - instead of +, _ instead of /)
 */
function base64UrlEncode(data: Uint8Array): string {
  // Convert bytes to binary string
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }

  // Convert to base64 and make URL-safe
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode URL-safe base64 back to bytes
 */
function base64UrlDecode(str: string): Uint8Array {
  // Add padding back
  const paddingNeeded = (4 - (str.length % 4)) % 4;
  const padded = str + "=".repeat(paddingNeeded);

  // Convert from URL-safe to standard base64
  const standardBase64 = padded.replace(/-/g, "+").replace(/_/g, "/");

  // Decode to binary string, then to bytes
  const binary = atob(standardBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// =============================================================================
// PKCE (Proof Key for Code Exchange)
// =============================================================================

/**
 * Generate a random code verifier for PKCE.
 * Returns a 43-character URL-safe string.
 */
export function generateCodeVerifier(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return base64UrlEncode(randomBytes);
}

/**
 * Generate the code challenge from a verifier using SHA-256.
 * This is sent to Clio during authorization.
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const verifierBytes = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", verifierBytes);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

// =============================================================================
// State Parameter (CSRF protection)
// =============================================================================

/**
 * Sign data using HMAC-SHA256
 */
async function signWithHmac(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Generate a signed state parameter containing user info and PKCE verifier.
 * Format: base64(payload).signature
 */
export async function generateState(
  userId: string,
  orgId: string,
  verifier: string,
  secret: string
): Promise<string> {
  const payload: StatePayload = {
    userId,
    orgId,
    verifier,
    timestamp: Date.now(),
  };

  const payloadJson = JSON.stringify(payload);
  const payloadEncoded = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const signature = await signWithHmac(payloadEncoded, secret);

  return `${payloadEncoded}.${signature}`;
}

/**
 * Verify and decode a state parameter.
 * Returns null if invalid, tampered, or expired.
 */
export async function verifyState(
  state: string,
  secret: string
): Promise<{ userId: string; orgId: string; verifier: string } | null> {
  // State should be: payload.signature
  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadEncoded, signature] = parts;

  // Verify signature matches (constant-time to prevent timing attacks)
  const expectedSignature = await signWithHmac(payloadEncoded, secret);
  if (!constantTimeEqual(signature, expectedSignature)) {
    return null;
  }

  // Decode and validate payload
  try {
    const payloadJson = new TextDecoder().decode(
      base64UrlDecode(payloadEncoded)
    );
    const payload = JSON.parse(payloadJson) as StatePayload;

    // Check if state has expired
    const age = Date.now() - payload.timestamp;
    if (age > STATE_EXPIRY_MS) {
      return null;
    }

    return {
      userId: payload.userId,
      orgId: payload.orgId,
      verifier: payload.verifier,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// OAuth URL Building
// =============================================================================

/**
 * Build the Clio authorization URL for the OAuth flow
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const url = new URL(CLIO_OAUTH_AUTHORIZE);

  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

// =============================================================================
// Token Exchange
// =============================================================================

/**
 * Exchange an authorization code for tokens
 */
export async function exchangeCodeForTokens(
  params: TokenExchangeParams
): Promise<ClioTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });

  const response = await fetch(CLIO_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ClioTokenResponse;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    token_type: data.token_type,
  };
}

/**
 * Refresh an expired access token
 */
export async function refreshAccessToken(
  params: TokenRefreshParams
): Promise<ClioTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });

  const response = await fetch(CLIO_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as ClioTokenResponse;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    token_type: data.token_type,
  };
}

// =============================================================================
// Token Storage (encrypted in Durable Object)
// =============================================================================

/**
 * Store tokens encrypted in DO storage
 */
export async function storeClioTokens(
  storage: DOStorage,
  userId: string,
  tokens: ClioTokens,
  encryptionKey: string
): Promise<void> {
  const tokenJson = JSON.stringify(tokens);
  const encrypted = await encrypt(tokenJson, userId, encryptionKey);
  const encryptedBase64 = arrayBufferToBase64(encrypted);

  await storage.put(`clio_token:${userId}`, encryptedBase64);
}

/**
 * Retrieve and decrypt tokens from DO storage
 */
export async function getClioTokens(
  storage: DOStorage,
  userId: string,
  env: EncryptionEnv
): Promise<ClioTokens | null> {
  const encryptedBase64 = (await storage.get(`clio_token:${userId}`)) as
    | string
    | undefined;

  if (!encryptedBase64) {
    return null;
  }

  try {
    const encrypted = base64ToArrayBuffer(encryptedBase64);
    const decrypted = await decrypt(encrypted, userId, env);
    return JSON.parse(decrypted) as ClioTokens;
  } catch {
    // Decryption failed - token may be corrupted or key changed
    return null;
  }
}

/**
 * Delete tokens from DO storage
 */
export async function deleteClioTokens(
  storage: DOStorage,
  userId: string
): Promise<void> {
  await storage.delete(`clio_token:${userId}`);
}

// =============================================================================
// Token Utilities
// =============================================================================

/**
 * Check if a token needs to be refreshed (expires within 5 minutes)
 */
export function tokenNeedsRefresh(tokens: ClioTokens): boolean {
  const timeUntilExpiry = tokens.expires_at - Date.now();
  return timeUntilExpiry <= TOKEN_REFRESH_BUFFER_MS;
}
