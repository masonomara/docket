import { Outlet, useLocation } from "react-router";
import type { Route } from "./+types/_app";
import { appLayoutLoader, type AppLayoutData } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";

export const loader = appLayoutLoader;

// Cache auth data on client to avoid re-fetching on every navigation
let cachedLoaderData: AppLayoutData | null = null;

export async function clientLoader({
  serverLoader,
}: Route.ClientLoaderArgs): Promise<AppLayoutData> {
  // Return cached data for instant navigation, refresh in background
  if (cachedLoaderData) {
    // Refresh cache in background (don't await)
    serverLoader().then((data) => {
      cachedLoaderData = data;
    });
    return cachedLoaderData;
  }
  // First client navigation - fetch and cache
  const data = await serverLoader();
  cachedLoaderData = data;
  return data;
}
clientLoader.hydrate = true as const;

export default function AppLayoutRoute({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const location = useLocation();

  // Derive currentPath for nav highlighting
  // Match the first segment after root for proper highlighting
  const pathSegments = location.pathname.split("/").filter(Boolean);
  let currentPath = location.pathname;

  // Normalize paths like /chat/abc to /chat for nav highlighting
  if (pathSegments[0] === "chat") {
    currentPath = "/chat";
  } else if (pathSegments[0] === "org" && pathSegments[1]) {
    currentPath = `/org/${pathSegments[1]}`;
  } else if (pathSegments[0] === "account" && pathSegments[1]) {
    currentPath = `/account/${pathSegments[1]}`;
  }

  return (
    <AppLayout org={org} currentPath={currentPath}>
      <Outlet context={{ user, org }} />
    </AppLayout>
  );
}
