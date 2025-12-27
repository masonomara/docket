import { useState } from "react";
import { Link } from "react-router";
import {
  LayoutDashboard,
  Users,
  Plug,
  FileText,
  Settings,
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
  return isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem;
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

      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ""}`}>
        <div className={styles.sidebarHeader}>
          <div className={styles.logo}>
            <img src="/docket-logo.svg" alt="Docket" />
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleCloseMenu}
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Work section - always visible */}
        <nav className={styles.section}>
          <div className={styles.sectionLabel}>Work</div>
          <ul className={styles.navList}>
            <li>
              <Link to="/dashboard" className={navItemClass("/dashboard", currentPath)}>
                <LayoutDashboard className={styles.navIcon} />
                Dashboard
              </Link>
            </li>
          </ul>
        </nav>

        {/* Manage section - only if user belongs to an org */}
        {org && (
          <nav className={styles.section}>
            <div className={styles.sectionLabel}>Manage</div>
            <ul className={styles.navList}>
              {/* Admin-only links */}
              {isAdmin && (
                <>
                  <li>
                    <Link to="/org/members" className={navItemClass("/org/members", currentPath)}>
                      <Users className={styles.navIcon} />
                      Members
                    </Link>
                  </li>
                  <li>
                    <Link to="/org/clio" className={navItemClass("/org/clio", currentPath)}>
                      <Plug className={styles.navIcon} />
                      Clio Connection
                    </Link>
                  </li>
                  <li>
                    <Link to="/org/documents" className={navItemClass("/org/documents", currentPath)}>
                      <FileText className={styles.navIcon} />
                      Documents
                    </Link>
                  </li>
                </>
              )}
              {/* Org settings - visible to all org members */}
              <li>
                <Link to="/org/settings" className={navItemClass("/org/settings", currentPath)}>
                  <Settings className={styles.navIcon} />
                  Org Settings
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
              <Link to="/account/settings" className={navItemClass("/account/settings", currentPath)}>
                <CircleUser className={styles.navIcon} />
                User Settings
              </Link>
            </li>
          </ul>
        </nav>
      </aside>

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <PageLayoutContext.Provider value={{ onMenuOpen: () => setMenuOpen(true) }}>
            {children}
          </PageLayoutContext.Provider>
        </div>
      </main>
    </div>
  );
}
