import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./encryption";
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../services/email";
import { createLogger, generateRequestId } from "./logger";

// ============================================================================
// Password Hashing (PBKDF2)
// ============================================================================

const PBKDF2_ITERATIONS = 100_000;

/**
 * Derives a 256-bit key from a password using PBKDF2-SHA256.
 * Used for both hashing and verification.
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    passwordBuffer,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  return crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
}

/**
 * Hashes a password with a random salt.
 * Returns: "base64(salt):base64(hash)"
 */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKeyFromPassword(password, salt);

  const saltBase64 = arrayBufferToBase64(salt.buffer);
  const hashBase64 = arrayBufferToBase64(hash);

  return `${saltBase64}:${hashBase64}`;
}

/**
 * Verifies a password against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyPassword({
  password,
  hash,
}: {
  password: string;
  hash: string;
}): Promise<boolean> {
  const [saltBase64, storedHashBase64] = hash.split(":");
  if (!saltBase64 || !storedHashBase64) {
    return false;
  }

  const salt = new Uint8Array(base64ToArrayBuffer(saltBase64));
  const storedHash = new Uint8Array(base64ToArrayBuffer(storedHashBase64));
  const computedHash = new Uint8Array(
    await deriveKeyFromPassword(password, salt)
  );

  // Constant-time comparison to prevent timing attacks
  if (storedHash.length !== computedHash.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < storedHash.length; i++) {
    difference |= storedHash[i] ^ computedHash[i];
  }

  return difference === 0;
}

// ============================================================================
// Environment Types
// ============================================================================

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  APPLE_CLIENT_ID: string;
  APPLE_CLIENT_SECRET: string;
  APPLE_APP_BUNDLE_IDENTIFIER: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  ENVIRONMENT?: string;
}

// ============================================================================
// Auth Instance Factory
// ============================================================================

const TRUSTED_ORIGINS = [
  "https://appleid.apple.com",
  "http://localhost:8787",
  "http://localhost:5173",
  "https://docketadmin.com",
  "https://www.docketadmin.com",
  "https://api.docketadmin.com",
];

/**
 * Creates a configured better-auth instance.
 * This is called per-request since it needs access to the env bindings.
 */
export function getAuth(env: AuthEnv) {
  const db = drizzle(env.DB, { schema });
  const isDevelopment = env.ENVIRONMENT === "development";

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,

    // Email/password auth
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      password: {
        hash: hashPassword,
        verify: verifyPassword,
      },
      sendResetPassword: async ({ user, url }) => {
        const result = await sendPasswordResetEmail(env, {
          to: user.email,
          resetUrl: url,
        });

        if (!result.success) {
          createLogger({ handler: "auth-password-reset" }).error(
            "Failed to send password reset email",
            { error: result.error, email: user.email }
          );
        }
      },
    },

    // Email verification
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const result = await sendVerificationEmail(env, {
          to: user.email,
          verificationUrl: url,
        });

        if (!result.success) {
          createLogger({ handler: "auth-verification" }).error(
            "Failed to send verification email",
            { error: result.error, email: user.email }
          );
        }
      },
    },

    // Social login providers
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

    trustedOrigins: TRUSTED_ORIGINS,

    // Cookie configuration differs between dev and prod
    advanced: isDevelopment
      ? { useSecureCookies: false }
      : {
          crossSubDomainCookies: {
            enabled: true,
            domain: "docketadmin.com",
          },
          useSecureCookies: true,
        },

    // Request hooks for normalization and logging
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Normalize email to lowercase for sign-up and sign-in
        const isEmailAuthPath =
          ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email";

        if (
          isEmailAuthPath &&
          ctx.body?.email &&
          typeof ctx.body.email === "string"
        ) {
          ctx.body.email = ctx.body.email.toLowerCase();
        }
      }),

      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (!returned) return;

        // Only log failures for auth-related paths
        const isAuthPath =
          ctx.path === "/sign-in/email" ||
          ctx.path === "/sign-in/social" ||
          ctx.path.startsWith("/callback/");

        if (!isAuthPath) return;

        const isError =
          returned instanceof Error ||
          (returned instanceof Response && !returned.ok);

        if (isError) {
          const logger = createLogger({
            requestId: generateRequestId(),
            handler: "auth",
          });

          logger.warn("Authentication failed", {
            path: ctx.path,
            email:
              typeof ctx.body?.email === "string" ? ctx.body.email : undefined,
            statusCode:
              returned instanceof Response ? returned.status : undefined,
            error: returned instanceof Error ? returned.message : undefined,
          });
        }
      }),
    },
  });
}
