import { redirect } from "react-router";
import type { Route } from "./+types/_index";
import { apiFetch, generateRequestId, ENDPOINTS } from "~/lib/api";
import type { SessionResponse } from "~/lib/types";

export async function loader({ request, context }: Route.LoaderArgs) {
  const requestId = generateRequestId();
  const cookie = request.headers.get("cookie") || "";

  const sessionResponse = await apiFetch(
    context,
    ENDPOINTS.auth.session,
    cookie,
    requestId
  );

  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const session = (await sessionResponse.json()) as SessionResponse | null;
  if (!session?.user) {
    throw redirect("/auth");
  }

  // User is authenticated, send to dashboard
  throw redirect("/admin");
}

export default function Index() {
  // This won't render - loader always redirects
  return null;
}
