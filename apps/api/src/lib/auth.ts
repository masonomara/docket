import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./encryption";

const PBKDF2_ITERATIONS = 100000;

/**
 * Derives a cryptographic key from a password using PBKDF2.
 * Returns a 256-bit key suitable for password verification.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array
): Promise<ArrayBuffer> {
  const passwordBytes = new TextEncoder().encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedKey = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  return derivedKey;
}

/**
 * Hashes a password for storage.
 * Returns a string in the format "salt:hash" where both are base64-encoded.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKey(password, salt);

  const saltBase64 = arrayBufferToBase64(salt.buffer);
  const hashBase64 = arrayBufferToBase64(hash);

  return `${saltBase64}:${hashBase64}`;
}

/**
 * Verifies a password against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}): Promise<boolean> {
  const parts = hash.split(":");
  const saltBase64 = parts[0];
  const storedHashBase64 = parts[1];

  if (!saltBase64 || !storedHashBase64) {
    return false;
  }

  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const storedHash = new Uint8Array(base64ToArrayBuffer(storedHashBase64));
  const newHash = new Uint8Array(await deriveKey(password, salt));

  // Hashes must be the same length
  if (storedHash.length !== newHash.length) {
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  let difference = 0;
  for (let i = 0; i < storedHash.length; i++) {
    difference |= storedHash[i] ^ newHash[i];
  }

  return difference === 0;
}

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APPLE_CLIENT_ID: string;
  APPLE_CLIENT_SECRET: string;
  APPLE_APP_BUNDLE_IDENTIFIER: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

export function getAuth(env: AuthEnv) {
  const db = drizzle(env.DB, { schema });

  const adapter = drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  });

  return betterAuth({
    database: adapter,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
    },
    socialProviders: {
      apple: {
        clientId: env.APPLE_CLIENT_ID,
        clientSecret: env.APPLE_CLIENT_SECRET,
        appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    trustedOrigins: [
      "https://appleid.apple.com",
      "http://localhost:8787",
      "http://localhost:5173",
      "https://docketadmin.com",
      "https://www.docketadmin.com",
      "https://api.docketadmin.com",
    ],
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: "docketadmin.com",
      },
      useSecureCookies: true,
    },
  });
}
