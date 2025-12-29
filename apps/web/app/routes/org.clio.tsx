import { useState, useEffect } from "react";
import { useSearchParams, useRevalidator } from "react-router";
import type { Route } from "./+types/org.clio";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { Plus, RotateCw } from "lucide-react";
import { orgLoader } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
import { PageLayout } from "~/components/PageLayout";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ClioStatus {
  connected: boolean;
  schemaLoaded: boolean;
  schemaVersion?: number;
  lastSyncedAt?: number;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Authorization denied.",
  invalid_request: "Invalid request.",
  invalid_state: "Session expired.",
  exchange_failed: "Authorization failed.",
};

// -----------------------------------------------------------------------------
// Loader
// -----------------------------------------------------------------------------

export const loader = orgLoader(async ({ user, org, fetch }) => {
  const clioResponse = await fetch(ENDPOINTS.clio.status);

  let clioStatus: ClioStatus = { connected: false, schemaLoaded: false };
  let loadError: string | null = null;

  if (clioResponse.ok) {
    clioStatus = (await clioResponse.json()) as ClioStatus;
  } else {
    loadError = "Failed to load Clio status.";
  }

  return { user, org, clioStatus, loadError };
});

// -----------------------------------------------------------------------------
// Page Component
// -----------------------------------------------------------------------------

export default function ClioPage({ loaderData }: Route.ComponentProps) {
  const { user, org, clioStatus, loadError } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  // Loading states
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  // Modal state
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);

  // Feedback state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Permissions
  const isAdmin = org.role === "admin";

  // ---------------------------------------------------------------------------
  // Handle URL Parameters (OAuth callback results)
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  function handleConnect() {
    window.location.href = `${API_URL}${ENDPOINTS.clio.connect}`;
  }

  async function handleDisconnect() {
    setError(null);
    setSuccess(null);
    setIsDisconnecting(true);

    try {
      const response = await fetch(`${API_URL}${ENDPOINTS.clio.disconnect}`, {
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
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setIsDisconnecting(false);
    }
  }

  async function handleSync() {
    setError(null);
    setSuccess(null);
    setIsRefreshing(true);

    try {
      const response = await fetch(
        `${API_URL}${ENDPOINTS.org.clioRefreshSchema}`,
        {
          method: "POST",
          credentials: "include",
        }
      );

      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "Failed to sync");
      }

      setSuccess("Clio configuration synced.");
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync");
    } finally {
      setIsRefreshing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Derived Values
  // ---------------------------------------------------------------------------

  const lastSyncedText = clioStatus.lastSyncedAt
    ? `Last synced ${new Date(clioStatus.lastSyncedAt).toLocaleDateString()}`
    : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <AppLayout org={org} currentPath="/org/clio">
      <PageLayout
        title="Clio Connection"
        subtitle="Connect your Clio account to query matters, contacts, and calendar data."
        actions={
          <>
            {/* Connection Status Indicator */}
            <div className="status-indicator btn btn-sm btn-secondary">
              <span
                className={`status-dot ${
                  clioStatus.connected
                    ? "status-dot-success"
                    : "status-dot-error"
                }`}
              />
              {clioStatus.connected ? "Connected" : "Not Connected"}
            </div>

            {/* Reconnect Button (only when connected) */}
            {clioStatus.connected && (
              <button
                onClick={handleConnect}
                className="btn btn-secondary btn-sm"
              >
                <RotateCw strokeWidth={1.75} size={16} />
                Reconnect
              </button>
            )}
          </>
        }
      >
        {loadError && (
          <div className="alert alert-error">
            {loadError}{" "}
            <button
              onClick={() => revalidator.revalidate()}
              className="link-button"
            >
              Retry
            </button>
          </div>
        )}
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Connect Section (only when not connected) */}
        {!clioStatus.connected && (
          <section className="section">
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

        {/* Sync Section (only for admins when connected) */}
        {isAdmin && clioStatus.connected && (
          <section className="section">
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

        {/* Danger Zone (only when connected) */}
        {clioStatus.connected && (
          <section className="section">
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
        <DisconnectModal
          isDisconnecting={isDisconnecting}
          onDisconnect={handleDisconnect}
          onClose={() => setShowDisconnectModal(false)}
        />
      )}
    </AppLayout>
  );
}

// -----------------------------------------------------------------------------
// Disconnect Modal
// -----------------------------------------------------------------------------

interface DisconnectModalProps {
  isDisconnecting: boolean;
  onDisconnect: () => void;
  onClose: () => void;
}

function DisconnectModal({
  isDisconnecting,
  onDisconnect,
  onClose,
}: DisconnectModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-title-3">Disconnect Clio?</h2>

        <p className="text-secondary">
          This will revoke Docket&apos;s access to your Clio account. You can
          reconnect anytime.
        </p>

        <div className="modal-actions">
          <button
            onClick={onClose}
            className="btn btn-secondary btn-sm"
            disabled={isDisconnecting}
          >
            Cancel
          </button>
          <button
            onClick={onDisconnect}
            className="btn btn-danger btn-sm"
            disabled={isDisconnecting}
          >
            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </div>
    </div>
  );
}
