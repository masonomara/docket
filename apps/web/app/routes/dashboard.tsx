import { Link, redirect } from "react-router";
import type { Route } from "./+types/dashboard";
import { API_URL } from "~/lib/auth-client";
import styles from "~/styles/dashboard.module.css";

interface SessionResponse {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
  };
}

interface OrgMembership {
  org: {
    id: string;
    name: string;
  };
  role: "admin" | "member";
  isOwner: boolean;
}

async function apiFetch(
  context: Route.LoaderArgs["context"],
  path: string,
  cookie: string
): Promise<Response> {
  const env = (context as { cloudflare?: { env?: { API?: { fetch: typeof fetch } } } }).cloudflare?.env;

  // Use service binding if available (production), otherwise fall back to fetch
  if (env?.API) {
    return env.API.fetch(new Request(`https://api.docketadmin.com${path}`, {
      headers: { Cookie: cookie },
    }));
  }

  return fetch(`${API_URL}${path}`, {
    headers: { Cookie: cookie },
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Forward the cookie to the API to validate session
  const sessionRes = await apiFetch(context, "/api/auth/get-session", cookie);

  if (!sessionRes.ok) {
    throw redirect("/login");
  }

  const sessionData = (await sessionRes.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect("/login");
  }

  // Also fetch user's org membership
  const orgRes = await apiFetch(context, "/api/user/org", cookie);

  let org: OrgMembership | null = null;
  if (orgRes.ok) {
    const orgData = (await orgRes.json()) as OrgMembership | null;
    if (orgData && orgData.org) {
      org = orgData;
    }
  }

  return { user: sessionData.user, org };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Dashboard</h1>
        <p className={styles.greeting}>Welcome back, {user.name}</p>
      </header>

      {org === null ? (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Get Started</h2>
          <p className={styles.cardText}>
            You're not part of an organization yet. Create one to start using
            Docket, or wait for an invitation from your firm.
          </p>
          <Link to="/org/create" className={styles.link}>
            Create an organization
          </Link>
        </div>
      ) : (
        <>
          <div className={styles.card}>
            <div className={styles.orgInfo}>
              <h2 className={styles.cardTitle}>{org.org.name}</h2>
              <span className={styles.badge}>
                {org.isOwner ? "Owner" : org.role}
              </span>
            </div>
            <p className={styles.cardText}>
              Your organization is set up and ready to use.
            </p>
          </div>

          <nav className={styles.nav}>
            {org.role === "admin" && (
              <>
                <Link to="/org/members" className={styles.navLink}>
                  Members
                </Link>
                <Link to="/org/clio" className={styles.navLink}>
                  Clio Connection
                </Link>
                <Link to="/org/documents" className={styles.navLink}>
                  Documents
                </Link>
              </>
            )}
            <Link to="/org/settings" className={styles.navLink}>
              Settings
            </Link>
          </nav>
        </>
      )}
    </main>
  );
}
