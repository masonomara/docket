import { Link, redirect } from "react-router";
import type { Route } from "./+types/dashboard";
import { apiFetch } from "~/lib/api";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import styles from "~/styles/dashboard.module.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";

  // Check if user is logged in
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );

  if (!sessionResponse.ok) {
    throw redirect("/auth");
  }

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect("/auth");
  }

  // Fetch user's organization membership
  const orgResponse = await apiFetch(context, "/api/user/org", cookie);

  let orgMembership: OrgMembership | null = null;
  if (orgResponse.ok) {
    const orgData = (await orgResponse.json()) as OrgMembership | null;
    if (orgData?.org) {
      orgMembership = orgData;
    }
  }

  return {
    user: sessionData.user,
    org: orgMembership,
  };
}

export default function Dashboard({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;

  // Determine role display text
  const roleDisplay = org?.isOwner ? "Owner" : org?.role;

  return (
    <AppLayout user={user} org={org} currentPath="/dashboard">
      <header className={styles.header}>
        <h1>Dashboard</h1>
        <p className={styles.greeting}>Welcome back, {user.name}</p>
      </header>

      {org === null ? (
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Get Started</h2>
          <p className={styles.cardText}>
            You're not part of an organization yet. Create one to start using
            Docket, or wait for an invitation.
          </p>
          <Link to="/org/create" className={styles.link}>
            Create an organization
          </Link>
        </div>
      ) : (
        <div className={styles.card}>
          <div className={styles.orgInfo}>
            <h2 className={styles.cardTitle}>{org.org.name}</h2>
            <span className={styles.badge}>{roleDisplay}</span>
          </div>
          <p className={styles.cardText}>
            Your organization is set up and ready to use.
          </p>
        </div>
      )}
    </AppLayout>
  );
}
