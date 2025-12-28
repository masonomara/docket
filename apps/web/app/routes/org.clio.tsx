import { useState, useEffect } from "react";
import { redirect, useSearchParams, useRevalidator } from "react-router";
import type { Route } from "./+types/org.clio";
import { apiFetch } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { Cable, LockKeyhole, Plus, RotateCw } from "lucide-react";
import type { SessionResponse, OrgMembership } from "~/lib/types";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

interface ClioStatus {
  connected: boolean;
  schemaLoaded: boolean;
  schemaVersion?: number;
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

  async function handleRefreshSchema() {
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
        throw new Error(data.error || "Failed to refresh schema");
      }

      const result = (await response.json()) as { count: number };
      setSuccess(`Schema refreshed. ${result.count} object types loaded.`);
      revalidator.revalidate();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to refresh schema";
      setError(message);
    } finally {
      setIsRefreshing(false);
    }
  }

  // Build schema version display text
  const schemaVersionText = clioStatus.schemaLoaded
    ? `Loaded (v${clioStatus.schemaVersion || "?"})`
    : "Not Loaded";

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
      {!clioStatus.connected && (
        <button onClick={handleConnect} className="btn btn-primary btn-sm">
          <Plus strokeWidth={1.75} size={16} />
          Connect to Clio
        </button>
      )}
      {clioStatus.connected && (
        <button onClick={handleConnect} className="btn btn-secondary btn-sm">
          <RotateCw strokeWidth={1.75} size={16} />
          Refresh
        </button>
      )}
    </>
  );

  return (
    <AppLayout user={user} org={org} currentPath="/org/clio">
      <PageLayout
        title="Clio Connection"
        subtitle="Connect your Clio account to let Docket query and manage your case data."
        actions={actionButtons}
      >
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Connection Status Section */}
        <section>
          <h2 className="text-title-3">Connection Status</h2>
          <div className="tableWrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Clio Account</th>
                  <th>Schema Cache</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    {clioStatus.connected ? "Connected" : "Not Connected"}
                  </td>
                  <td>{schemaVersionText}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Schema Management Section (Admin only, when connected) */}
        {isAdmin && clioStatus.connected && (
          <section>
            <h2 className="text-title-3">Schema Management</h2>

            <div className="info-card">
              <div>
                <h3 className="text-headline">Refresh Clio Schema</h3>

                <p className="section-description">
                  Refresh the schema cache to pick up Clio configuration
                  changes.
                </p>
              </div>
              <button
                onClick={handleRefreshSchema}
                disabled={isRefreshing}
                className="btn btn-sm btn-secondary"
              >
                {isRefreshing ? "Refreshing..." : "Refresh Schema"}
              </button>
            </div>
          </section>
        )}

        {/* Information Section */}
        <section className="infoSection">
          <Cable
            strokeWidth={2}
            size={16}
            style={{ marginTop: "1.5px", minHeight: "16px", minWidth: "16px" }}
          />
          <div>
            <h3 className="text-headline">What Docket can do with Clio</h3>
            <ul className="text-secondary">
              <li>Query matters, contacts, tasks, and calendar entries</li>
              <li>Create and update records (Admin only, with confirmation)</li>
              <li>Search across your firm&apos;s case data</li>
            </ul>
          </div>
        </section>
        <section className="infoSection">
          <LockKeyhole
            strokeWidth={2}
            size={16}
            style={{ marginTop: "1.5px", minHeight: "16px", minWidth: "16px" }}
          />
          <div>
            <h3 className="text-headline">Security</h3>
            <ul className="text-secondary">
              <li>Tokens are encrypted and stored securely</li>
              <li>Access is limited to your Clio permissions</li>
              <li>Write operations require explicit confirmation</li>
            </ul>
          </div>
        </section>

        {/* Disconnect Section (only when connected) */}
        {clioStatus.connected && (
          <section>
            <h2 className="text-title-3">Danger Zone</h2>

            <div className="info-card">
              <div>
                <h3 className="text-headline">Disconnect Clio</h3>
                <p className="section-description">
                  Disconnecting will revoke Docket&apos;s access to your Clio
                  account. You can reconnect at any time.
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
              can reconnect at any time.
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
