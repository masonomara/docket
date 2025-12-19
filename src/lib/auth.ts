import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";

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
  return betterAuth({
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite" }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
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
    trustedOrigins: ["https://appleid.apple.com"],
  });
}
