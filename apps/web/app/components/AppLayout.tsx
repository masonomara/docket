import { useState } from "react";
import { Link } from "react-router";
import {
  LayoutDashboard,
  Users,
  Plug,
  FileText,
  CircleUser,
  X,
} from "lucide-react";
import type { OrgMembership } from "~/lib/types";
import { PageLayoutContext } from "~/components/PageLayout";
import styles from "~/styles/app-layout.module.css";

interface AppLayoutProps {
  children: React.ReactNode;
  user: { id: string; email: string; name: string };
  org: OrgMembership | null;
  currentPath: string;
}

/** Helper to build nav item class names */
function navItemClass(path: string, currentPath: string): string {
  const isActive = currentPath === path;
  return isActive
    ? `${styles.navItem} ${styles.navItemActive}`
    : styles.navItem;
}

export function AppLayout({ children, org, currentPath }: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isAdmin = org?.role === "admin";

  function handleCloseMenu() {
    setMenuOpen(false);
  }

  return (
    <div className={styles.layout}>
      {/* Mobile overlay */}
      {menuOpen && (
        <div
          className={styles.overlay}
          onClick={handleCloseMenu}
          aria-hidden="true"
        />
      )}

      <aside
        className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}
      >
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <img src="/docket-logo.svg" alt="Docket" />
          </div>
          <button
            type="button"
            className={`${styles.closeButton} btn-sm btn`}
            onClick={handleCloseMenu}
            aria-label="Close menu"
          >
            <span>Close</span> <X size={16} />
          </button>
        </div>

        {/* Work section - always visible */}
        <nav className={styles.section}>
          <div className={styles.sectionLabel} style={{ borderTop: "none" }}>
            Work
          </div>
          <ul className={styles.navList}>
            <li>
              <Link
                to="/dashboard"
                className={navItemClass("/dashboard", currentPath)}
              >
                <LayoutDashboard
                  className={styles.navIcon}
                  strokeWidth={1.75}
                />
                Dashboard
              </Link>
            </li>
          </ul>
        </nav>

        {/* Manage section - admin only */}
        {isAdmin && (
          <nav className={styles.section}>
            <div className={styles.sectionLabel}>Manage</div>
            <ul className={styles.navList}>
              <li>
                <Link
                  to="/org/context"
                  className={navItemClass("/org/context", currentPath)}
                >
                  <FileText className={styles.navIcon} strokeWidth={1.75} />
                  Knowledge Base
                </Link>
              </li>
              <li>
                <Link
                  to="/org/clio"
                  className={navItemClass("/org/clio", currentPath)}
                >
                  <Plug className={styles.navIcon} strokeWidth={1.75} />
                  Clio Connection
                </Link>
              </li>
              <li>
                <Link
                  to="/org/members"
                  className={navItemClass("/org/members", currentPath)}
                >
                  <Users className={styles.navIcon} />
                  Members
                </Link>
              </li>
            </ul>
          </nav>
        )}

        {/* Account section - always visible */}
        <nav className={styles.section}>
          <div className={styles.sectionLabel}>Account</div>
          <ul className={styles.navList}>
            <li>
              <Link
                to="/account/settings"
                className={navItemClass("/account/settings", currentPath)}
              >
                <CircleUser className={styles.navIcon} strokeWidth={1.75} />
                User Settings
              </Link>
            </li>
          </ul>
        </nav>
        <div className={styles.orgInfoDivider} />
        {/* Org info at bottom */}
        {org?.org?.name && (
          <Link
            to="/org/settings"
            className={`${styles.orgInfo} ${currentPath === "/org/settings" ? styles.orgInfoActive : ""}`}
          >
            <span className={styles.orgAvatar}>
              {org.org.name
                .split(" ")
                .slice(0, 2)
                .map((word: string) => word[0])
                .join("")
                .toUpperCase()}
            </span>
            <span className={styles.orgDetails}>
              <span className={styles.orgName}>{org.org.name}</span>
              <span className={styles.orgRole}>
                {org.isOwner
                  ? "Owner"
                  : org.role === "admin"
                    ? "Admin"
                    : "Member"}
              </span>
            </span>
          </Link>
        )}
      </aside>

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <PageLayoutContext.Provider
            value={{ onMenuOpen: () => setMenuOpen(true) }}
          >
            {children}
          </PageLayoutContext.Provider>
        </div>
      </main>
    </div>
  );
}
