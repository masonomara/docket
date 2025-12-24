import { createAuthClient } from "better-auth/react";

export const API_URL = "https://api.docketadmin.com";

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: {
    credentials: "include",
  },
});

export const { useSession, signIn, signUp, signOut } = authClient;
