/**
 * Auth Client
 *
 * This module sets up the better-auth client and exports the auth functions
 * used throughout the app. All auth requests go to the API server.
 */

import { createAuthClient } from "better-auth/react";

// API URL - defaults to production, can be overridden for local dev
export const API_URL =
  import.meta.env.VITE_API_URL || "https://api.docketadmin.com";

// Create the auth client with credentials included for cookie-based sessions
const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: "include",
  },
});

// Session hook for checking auth state in components
export const { useSession } = authClient;

// Sign in methods
export const { signIn } = authClient;

// Sign up methods
export const { signUp } = authClient;

// Sign out
export const { signOut } = authClient;

// Email verification
export const { sendVerificationEmail, verifyEmail } = authClient;

// Password reset
export const { requestPasswordReset, resetPassword } = authClient;
