import { useState, useEffect } from "react";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/org.clio";
import { ENDPOINTS } from "~/lib/api";
import { API_URL } from "~/lib/auth-client";
import { Plus, RotateCw } from "lucide-react";
import { orgLoader } from "~/lib/loader-auth";
import { AppLayout } from "~/components/AppLayout";
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

export const loader = orgLoader(({ user, org }) => ({ user, org }), {});

export default function ClioPage({ loaderData }: Route.ComponentProps) {
  const { user, org } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();

  const [clioStatus, setClioStatus] = useState<ClioStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Fetch Clio status client-side for faster page load
  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch(`${API_URL}${ENDPOINTS.clio.status}`, {
          credentials: "include",
        });
        if (res.ok) {
          setClioStatus(await res.json());
        } else {
          setClioStatus({ connected: false, schemaLoaded: false });
          setError("Failed to load Clio status.");
        }
      } catch {
        setClioStatus({ connected: false, schemaLoaded: false });
        setError("Failed to load Clio status.");
      } finally {
        setIsLoadingStatus(false);
      }
    }
    fetchStatus();
  }, []);

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
      setClioStatus({ connected: false, schemaLoaded: false });
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

      // Refetch status to get updated lastSyncedAt
      const statusRes = await fetch(`${API_URL}${ENDPOINTS.clio.status}`, {
        credentials: "include",
      });
      if (statusRes.ok) {
        setClioStatus(await statusRes.json());
      }

      setSuccess("Clio configuration synced.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync");
    } finally {
      setIsRefreshing(false);
    }
  }

  const isAdmin = org.role === "admin";

  return (
    <AppLayout org={org} currentPath="/org/clio">
      <PageLayout
        title="Clio Connection"
        subtitle="Connect your Clio account to query matters, contacts, and calendar data."
        actions={
          <>
            <ConnectionStatus
              isConnected={clioStatus?.connected ?? false}
              isLoading={isLoadingStatus}
            />
            {clioStatus?.connected && (
              <button
                onClick={navigateToClioOAuth}
                className="btn btn-secondary btn-sm"
              >
                <RotateCw strokeWidth={1.75} size={16} />
                Reconnect
              </button>
            )}
          </>
        }
      >
        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {!isLoadingStatus && !clioStatus?.connected && (
          <ConnectToClioSection onConnect={navigateToClioOAuth} />
        )}

        {isAdmin && clioStatus?.connected && (
          <SyncConfigSection
            lastSyncedAt={clioStatus.lastSyncedAt}
            isRefreshing={isRefreshing}
            onSync={handleSync}
          />
        )}

        {clioStatus?.connected && (
          <DangerZoneSection
            onDisconnect={() => setShowDisconnectModal(true)}
          />
        )}
      </PageLayout>

      {showDisconnectModal && (
        <DisconnectModal
          isDisconnecting={isDisconnecting}
          onConfirm={handleDisconnect}
          onCancel={() => setShowDisconnectModal(false)}
        />
      )}
    </AppLayout>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

interface ConnectionStatusProps {
  isConnected: boolean;
  isLoading?: boolean;
}

function ConnectionStatus({ isConnected, isLoading }: ConnectionStatusProps) {
  if (isLoading) {
    return (
      <div className="status-indicator btn btn-sm btn-secondary">
        <span className="status-dot" />
        Loading...
      </div>
    );
  }

  const statusDotClass = isConnected
    ? "status-dot status-dot-success"
    : "status-dot status-dot-error";
  const statusText = isConnected ? "Connected" : "Not Connected";

  return (
    <div className="status-indicator btn btn-sm btn-secondary">
      <span className={statusDotClass} />
      {statusText}
    </div>
  );
}

interface ConnectToClioSectionProps {
  onConnect: () => void;
}

function ConnectToClioSection({ onConnect }: ConnectToClioSectionProps) {
  return (
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
            <li>Access is encrypted and limited to your Clio permissions</li>
          </ul>
        </div>

        <button onClick={onConnect} className="btn btn-sm btn-primary">
          <Plus strokeWidth={1.75} size={16} />
          Connect to Clio
        </button>
      </div>
    </section>
  );
}

interface SyncConfigSectionProps {
  lastSyncedAt?: number;
  isRefreshing: boolean;
  onSync: () => void;
}

function SyncConfigSection({
  lastSyncedAt,
  isRefreshing,
  onSync,
}: SyncConfigSectionProps) {
  const lastSyncText = lastSyncedAt
    ? `Last synced ${new Date(lastSyncedAt).toLocaleDateString()}`
    : "";

  return (
    <section className="section">
      <h2 className="text-title-3">Clio Configuration</h2>

      <div className="info-card">
        <div>
          <h3 className="text-headline">Sync Clio</h3>
          <p className="section-description">
            For custom fields or changed your Clio configuration. Re-syncs
            hourly. {lastSyncText}
          </p>
        </div>

        <button
          onClick={onSync}
          disabled={isRefreshing}
          className="btn btn-sm btn-secondary"
        >
          {isRefreshing ? "Syncing..." : "Sync Now"}
        </button>
      </div>
    </section>
  );
}

interface DangerZoneSectionProps {
  onDisconnect: () => void;
}

function DangerZoneSection({ onDisconnect }: DangerZoneSectionProps) {
  return (
    <section className="section">
      <h2 className="text-title-3">Danger Zone</h2>

      <div className="info-card">
        <div>
          <h3 className="text-headline">Disconnect Clio</h3>
          <p className="section-description">
            Revokes Docket&apos;s access. You can reconnect anytime.
          </p>
        </div>

        <button onClick={onDisconnect} className="btn btn-sm btn-danger">
          Disconnect
        </button>
      </div>
    </section>
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
        <h2 className="text-title-3">Disconnect Clio?</h2>

        <p className="text-secondary">
          This will revoke Docket&apos;s access to your Clio account. You can
          reconnect anytime.
        </p>

        <div className="modal-actions">
          <button
            onClick={onCancel}
            className="btn btn-secondary btn-sm"
            disabled={isDisconnecting}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
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
