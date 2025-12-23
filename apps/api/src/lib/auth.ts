import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./encryption";

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const HASH_LENGTH = 256;

/**
 * Hashes a password using PBKDF2 with a random salt.
 * Returns format: "base64salt:base64hash"
 */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_LENGTH
  );

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
  if (parts.length !== 2) {
    return false;
  }

  const [saltBase64, storedHashBase64] = parts;
  if (!saltBase64 || !storedHashBase64) {
    return false;
  }

  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const encoder = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const newHashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    HASH_LENGTH
  );

  const newHash = new Uint8Array(newHashBuffer);
  const storedHash = new Uint8Array(base64ToArrayBuffer(storedHashBase64));

  // Constant-time comparison
  if (storedHash.length !== newHash.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < storedHash.length; i++) {
    result |= storedHash[i] ^ newHash[i];
  }

  return result === 0;
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

/**
 * Creates and configures the Better Auth instance for this environment.
 */
export function getAuth(env: AuthEnv) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
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
  });
}
