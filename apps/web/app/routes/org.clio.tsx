import { useState, useEffect } from "react";
import { redirect, useSearchParams, useRevalidator } from "react-router";
import type { Route } from "./+types/org.clio";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { Plus, RotateCw } from "lucide-react";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface ClioStatus {
  connected: boolean;
  schemaLoaded: boolean;
  schemaVersion?: number;
  lastSyncedAt?: number;
}

// Error messages for OAuth error codes
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Authorization denied.",
  invalid_request: "Invalid request.",
  invalid_state: "Session expired.",
  exchange_failed: "Authorization failed.",
};

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

  if (!orgResponse.ok) {
    throw redirect("/dashboard");
  }

  const orgMembership = (await orgResponse.json()) as OrgMembership | null;

  if (!orgMembership?.org) {
    throw redirect("/dashboard");
  }

  // Fetch Clio connection status
  const clioResponse = await apiFetch(context, "/api/clio/status", cookie);

  let clioStatus: ClioStatus = { connected: false, schemaLoaded: false };
  if (clioResponse.ok) {
    clioStatus = (await clioResponse.json()) as ClioStatus;
  }

  return {
    user: sessionData.user,
    org: orgMembership,
    clioStatus,
  };
}

export default function ClioPage({ loaderData }: Route.ComponentProps) {
  const { user, org, clioStatus } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  // Action state
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Permission flags
  const isAdmin = org.role === "admin";

  // Handle URL parameters from OAuth callback
  useEffect(() => {
    const successParam = searchParams.get("success");
    const errorParam = searchParams.get("error");

    if (successParam === "connected") {
      setSuccess("Successfully connected to Clio!");
      setSearchParams({}, { replace: true });
      return;
    }

    if (errorParam) {
      const errorMessage =
        OAUTH_ERROR_MESSAGES[errorParam] || "Authorization failed.";
      setError(errorMessage);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function handleConnect() {
    window.location.href = `${API_URL}/api/clio/connect`;
  }

  async function handleDisconnect() {
    setError(null);
    setSuccess(null);
    setIsDisconnecting(true);

    try {
      const response = await fetch(`${API_URL}/api/clio/disconnect`, {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to disconnect");
      }

      setSuccess("Clio account disconnected.");
      setShowDisconnectModal(false);
      revalidator.revalidate();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disconnect";
      setError(message);
    } finally {
      setIsDisconnecting(false);
    }
  }

  async function handleSync() {
    setError(null);
    setSuccess(null);
    setIsRefreshing(true);

    try {
      const response = await fetch(`${API_URL}/api/org/clio/refresh-schema`, {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to sync");
      }

      setSuccess("Clio configuration synced.");
      revalidator.revalidate();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to sync";
      setError(message);
    } finally {
      setIsRefreshing(false);
    }
  }

  // Format last synced date
  const lastSyncedText = clioStatus.lastSyncedAt
    ? `Last synced ${new Date(clioStatus.lastSyncedAt).toLocaleDateString()}`
    : null;

  const statusIndicator = (
    <div className="status-indicator btn btn-sm btn-secondary">
      <span
        className={`status-dot ${clioStatus.connected ? "status-dot-success" : "status-dot-error"}`}
      />

      {clioStatus.connected ? "Connected" : "Not Connected"}
    </div>
  );

  const actionButtons = (
    <>
      {statusIndicator}
      {clioStatus.connected && (
        <button onClick={handleConnect} className="btn btn-secondary btn-sm">
          <RotateCw strokeWidth={1.75} size={16} />
          Reconnect
        </button>
      )}
    </>
  );

  return (
    <AppLayout user={user} org={org} currentPath="/org/clio">
      <PageLayout
        title="Clio Connection"
        subtitle="Connect your Clio account to query matters, contacts, and calendar data."
        actions={actionButtons}
      >
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Connect to Clio - show only when not connected */}
        {!clioStatus.connected && (
          <section>
            <h2 className="text-title-3">Connect to Clio</h2>
            <div className="info-card">
              <div>
                <h3 className="text-headline">What Docket does with Clio</h3>
                <ul
                  className="text-secondary"
                  style={{ marginTop: ".2em", marginLeft: "1em" }}
                >
                  <li>Query matters, contacts, tasks, and calendar entries</li>
                  <li>Create and update records</li>
                  <li>Search across your firm&apos;s case data</li>
                  <li>
                    Access is encrypted and limited to your Clio permissions
                  </li>
                </ul>
              </div>
              <button
                onClick={handleConnect}
                className="btn btn-sm btn-primary"
              >
                <Plus strokeWidth={1.75} size={16} />
                Connect to Clio
              </button>
            </div>
          </section>
        )}

        {/* Sync Section (Admin only, when connected) */}
        {isAdmin && clioStatus.connected && (
          <section>
            <h2 className="text-title-3">Sync Clio Configuration</h2>

            <div className="info-card">
              <div>
                <h3 className="text-headline">
                  {lastSyncedText || "Not synced yet"}
                </h3>
                <p className="section-description">
                  If you&apos;ve added custom fields or changed your Clio setup,
                  sync to update Docket. Auto-syncs hourly.
                </p>
              </div>
              <button
                onClick={handleSync}
                disabled={isRefreshing}
                className="btn btn-sm btn-secondary"
              >
                {isRefreshing ? "Syncing..." : "Sync Now"}
              </button>
            </div>
          </section>
        )}

        {/* Disconnect Section (only when connected) */}
        {clioStatus.connected && (
          <section>
            <h2 className="text-title-3">Danger Zone</h2>

            <div className="info-card">
              <div>
                <h3 className="text-headline">Disconnect Clio</h3>
                <p className="section-description">
                  Revokes Docket&apos;s access. You can reconnect anytime.
                </p>
              </div>
              <button
                onClick={() => setShowDisconnectModal(true)}
                className="btn btn-sm btn-danger"
              >
                Disconnect
              </button>
            </div>
          </section>
        )}
      </PageLayout>

      {/* Disconnect Confirmation Modal */}
      {showDisconnectModal && (
        <div
          className="modal-overlay"
          onClick={() => setShowDisconnectModal(false)}
        >
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-title-3">Disconnect Clio?</h2>
            <p className="text-secondary">
              This will revoke Docket&apos;s access to your Clio account. You
              can reconnect anytime.
            </p>
            <div className="modal-actions">
              <button
                onClick={() => setShowDisconnectModal(false)}
                className="btn btn-secondary btn-sm"
                disabled={isDisconnecting}
              >
                Cancel
              </button>
              <button
                onClick={handleDisconnect}
                className="btn btn-danger btn-sm"
                disabled={isDisconnecting}
              >
                {isDisconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
