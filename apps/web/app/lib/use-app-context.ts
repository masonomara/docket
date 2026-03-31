import { useOutletContext } from "react-router";
import type { OrgMembership } from "./types";

interface AppContext {
  user: {
    id: string;
    email: string;
    name: string;
  };
  org: OrgMembership | null;
}

/**
 * Hook to access auth context from the _app layout.
 * Must be used within routes nested under _app.tsx.
 *
 * Usage:
 *   const { user, org } = useAppContext();
 */
export function useAppContext(): AppContext {
  return useOutletContext<AppContext>();
}
