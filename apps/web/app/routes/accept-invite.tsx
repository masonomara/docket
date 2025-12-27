import { useState } from "react";
import { useNavigate, Link, redirect } from "react-router";
import type { Route } from "./+types/accept-invite";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import type { SessionResponse, InvitationDetails } from "~/lib/types";
import styles from "~/styles/auth.module.css";

export async function loader({ request, context }: Route.LoaderArgs) {
  const cookie = request.headers.get("cookie") || "";
  const url = new URL(request.url);
  const invitationId = url.searchParams.get("invitation");

  // Redirect to dashboard if no invitation ID provided
  if (!invitationId) {
    throw redirect("/dashboard");
  }

  // Check if user is logged in
  const sessionResponse = await apiFetch(
    context,
    "/api/auth/get-session",
    cookie
  );

  if (!sessionResponse.ok) {
    throw redirect(`/auth?invitation=${invitationId}`);
  }

  const sessionData = (await sessionResponse.json()) as SessionResponse | null;

  if (!sessionData?.user) {
    throw redirect(`/auth?invitation=${invitationId}`);
  }

  // Fetch invitation details
  const invitationResponse = await apiFetch(
    context,
    `/api/invitations/${invitationId}`,
    cookie
  );

  let invitation: InvitationDetails | null = null;
  if (invitationResponse.ok) {
    invitation = (await invitationResponse.json()) as InvitationDetails;
  }

  return {
    user: sessionData.user,
    invitation,
    invitationId,
  };
}

interface ErrorPageProps {
  title: string;
  message: string;
}

function ErrorPage({ title, message }: ErrorPageProps) {
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.subtitle}>{message}</p>
        <Link to="/dashboard" className={styles.submitButton}>
          Go to Dashboard
        </Link>
      </div>
    </main>
  );
}

export default function AcceptInvitePage({ loaderData }: Route.ComponentProps) {
  const { user, invitation, invitationId } = loaderData;
  const navigate = useNavigate();

  const [error, setError] = useState<string | null>(null);
  const [isAccepting, setIsAccepting] = useState(false);

  // Handle case where invitation doesn't exist
  if (!invitation) {
    return (
      <ErrorPage
        title="Invitation Not Found"
        message="This invitation doesn't exist or has been revoked."
      />
    );
  }

  // Handle expired invitation
  if (invitation.isExpired) {
    return (
      <ErrorPage
        title="Invitation Expired"
        message={`This invitation to join ${invitation.orgName} has expired. Please contact your organization admin.`}
      />
    );
  }

  // Handle already accepted invitation
  if (invitation.isAccepted) {
    return (
      <ErrorPage
        title="Already Accepted"
        message="This invitation has already been accepted."
      />
    );
  }

  // Handle email mismatch
  const userEmailLower = user.email.toLowerCase();
  const invitationEmailLower = invitation.email.toLowerCase();

  if (userEmailLower !== invitationEmailLower) {
    return (
      <ErrorPage
        title="Wrong Account"
        message={`This invitation was sent to ${invitation.email}, but you're logged in as ${user.email}. Please log out and sign in with the correct account.`}
      />
    );
  }

  async function handleAccept() {
    setIsAccepting(true);
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}/api/invitations/${invitationId}/accept`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to accept invitation");
      }

      navigate("/dashboard");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to accept invitation";
      setError(message);
      setIsAccepting(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Join {invitation.orgName}</h1>

        <p className={styles.subtitle}>
          <strong>{invitation.inviterName}</strong> invited you to join as a{" "}
          <strong>{invitation.role}</strong>.
        </p>

        {error && <div className={styles.errorBox}>{error}</div>}

        <button
          onClick={handleAccept}
          disabled={isAccepting}
          className={styles.submitButton}
        >
          {isAccepting ? "Joining..." : "Join Organization"}
        </button>

        <p className={styles.footer}>
          Not what you expected?{" "}
          <Link to="/dashboard" className={styles.footerLink}>
            Go to Dashboard
          </Link>
        </p>
      </div>
    </main>
  );
}
