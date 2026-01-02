import { useState, useEffect } from "react";
import { useSearchParams, useRevalidator, useNavigate } from "react-router";
import type { Route } from "./+types/_app.org.clio";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { ExternalLink, RotateCw } from "lucide-react";
import { childLoader } from "~/lib/loader-auth";
import { useAppContext } from "~/lib/use-app-context";
import { PageLayout } from "~/components/PageLayout";

interface ClioStatus {
  connected: boolean;
  schemaLoaded: boolean;
  schemaVersion?: number;
  lastSyncedAt?: number;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  denied: "Authorization denied.",
  invalid_request: "Invalid request.",
  invalid_state: "Session expired.",
  exchange_failed: "Authorization failed.",
};

export const loader = childLoader(async ({ fetch }) => {
  const res = await fetch(ENDPOINTS.clio.status);

  const clioStatus: ClioStatus = res.ok
    ? ((await res.json()) as ClioStatus)
    : { connected: false, schemaLoaded: false };

  const loadError = res.ok ? null : "Failed to load Clio status.";

  return { clioStatus, loadError };
});

export default function ClioPage({ loaderData }: Route.ComponentProps) {
  const { clioStatus, loadError } = loaderData;
  const { org } = useAppContext();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const revalidator = useRevalidator();

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Redirect if no org
  useEffect(() => {
    if (!org) navigate("/admin");
  }, [org, navigate]);

  // Handle OAuth callback results from URL params
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

  // Don't render if no org
  if (!org) return null;

  function navigateToClioOAuth() {
    window.location.href = `${API_URL}${ENDPOINTS.clio.connect}`;
  }

  async function handleDisconnect() {
    setError(null);
    setSuccess(null);
    setIsDisconnecting(true);

    try {
      const res = await fetch(`${API_URL}${ENDPOINTS.clio.disconnect}`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
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
      const res = await fetch(`${API_URL}${ENDPOINTS.org.clioRefreshSchema}`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
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

  const isAdmin = org.role === "admin";

  return (
    <>
      <PageLayout title="Clio Connection">
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

        {!clioStatus.connected && (
          <section className="section">
            <h2 className="text-title-3">Clio Status</h2>

            <div className="info-card">
              <div className="info-card-content">
                <h3 className="text-subhead">Clio Setup</h3>

                <p className="text-secondary">
                  Connect your personal Clio account to Docket
                </p>
              </div>

              <button
                onClick={navigateToClioOAuth}
                className="btn btn-sm btn-primary"
              >
                <ExternalLink
                  strokeWidth={2.25}
                  size={13}
                  style={{ margin: "3px", marginLeft: "0px" }}
                />
                Connect to Clio
              </button>
            </div>
          </section>
        )}

        {isAdmin && clioStatus.connected && (
          <section className="section">
            <h2 className="text-title-3">Clio Configuration</h2>

            <div
              className="info-card"
              style={{
                marginBottom: "-17px",
                borderBottomRightRadius: "0px",
                borderBottomLeftRadius: "0px",
              }}
            >
              <div className="info-card-content">
                <h3 className="text-subhead">Connection Status</h3>
                <p className="text-secondary">
                  Your Clio account is connected to Docket.
                </p>
              </div>

              <button
                onClick={navigateToClioOAuth}
                className="btn btn-sm btn-secondary"
              >
                <RotateCw
                  strokeWidth={2.25}
                  size={13}
                  style={{ margin: "3px", marginLeft: "0px" }}
                />
                Refresh
              </button>
            </div>

            <div
              className="info-card"
              style={{
                borderTopRightRadius: "0px",
                borderTopLeftRadius: "0px",
              }}
            >
              <div className="info-card-content">
                <h3 className="text-subhead">Sync Clio</h3>
                <p className="text-secondary">
                  For custom fields or changed your Clio configuration. Re-syncs
                  hourly.{" "}
                  {clioStatus.lastSyncedAt
                    ? `Last synced ${new Date(clioStatus.lastSyncedAt).toLocaleDateString()}`
                    : ""}
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

        {clioStatus.connected && (
          <section className="section">
            <h2 className="text-title-3">Danger Zone</h2>

            <div className="info-card">
              <div className="info-card-content">
                <h3 className="text-subhead">Disconnect Clio</h3>
                <p className="text-secondary">
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

      {showDisconnectModal && (
        <DisconnectModal
          isDisconnecting={isDisconnecting}
          onConfirm={handleDisconnect}
          onCancel={() => setShowDisconnectModal(false)}
        />
      )}
    </>
  );
}

// ============================================================================
// Disconnect Modal
// ============================================================================

interface DisconnectModalProps {
  isDisconnecting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function DisconnectModal({
  isDisconnecting,
  onConfirm,
  onCancel,
}: DisconnectModalProps) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">Disconnect Clio?</h2>

        <p className="text-secondary">
          This will revoke Docket&apos;s access to your Clio account. You can
          reconnect anytime.
        </p>

        <div className="modal-actions">
          <button
            onClick={onCancel}
            className="btn btn-secondary btn-lg btn-lg-fit"
            disabled={isDisconnecting}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn btn-danger btn-lg btn-lg-fit"
            disabled={isDisconnecting}
          >
            {isDisconnecting ? "Disconnecting..." : "Disconnect"}
          </button>
        </div>
      </div>
    </div>
  );
}
