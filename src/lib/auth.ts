import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./encryption";

const PBKDF2_ITERATIONS = 100000;

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${arrayBufferToBase64(salt.buffer)}:${arrayBufferToBase64(hash)}`;
}

async function verifyPassword(data: {
  password: string;
  hash: string;
}): Promise<boolean> {
  const [saltB64, hashB64] = data.hash.split(":");
  if (!saltB64 || !hashB64) return false;
  const salt = new Uint8Array(base64ToArrayBuffer(saltB64));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(data.password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const newHash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const storedHash = new Uint8Array(base64ToArrayBuffer(hashB64));
  const newHashArray = new Uint8Array(newHash);
  if (storedHash.length !== newHashArray.length) return false;
  for (let i = 0; i < storedHash.length; i++)
    if (storedHash[i] !== newHashArray[i]) return false;
  return true;
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

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      password: { hash: hashPassword, verify: verifyPassword },
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
      "https://docketadmin.com",
    ],
  });
}
