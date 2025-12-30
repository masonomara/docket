import { createContext, useState } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import type { OrgMembership } from "~/lib/types";
import styles from "~/styles/app-layout.module.css";

export const PageLayoutContext = createContext<{
  onMenuOpen: () => void;
} | null>(null);

interface AppLayoutProps {
  children: React.ReactNode;
  org: OrgMembership | null;
  currentPath: string;
}

export function AppLayout({ children, org, currentPath }: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  const isAdmin = org?.role === "admin";

  function getNavItemClass(path: string) {
    if (currentPath === path) {
      return `${styles.navItem} ${styles.navItemActive}`;
    }
    return styles.navItem;
  }

  function getOrgInitials(orgName: string) {
    const words = orgName.split(" ");
    const firstTwoWords = words.slice(0, 2);
    const initials = firstTwoWords.map((word) => word[0]).join("");
    return initials.toUpperCase();
  }

  function getOrgRoleLabel() {
    if (org?.isOwner) {
      return "Owner";
    }
    if (org?.role === "admin") {
      return "Admin";
    }
    return "Member";
  }

  function openMenu() {
    setMenuOpen(true);
  }

  function closeMenu() {
    setMenuOpen(false);
  }

  return (
    <div className={styles.layout}>
      {/* Mobile overlay - click to close menu */}
      {menuOpen && (
        <div
          className={styles.overlay}
          onClick={closeMenu}
          aria-hidden="true"
        />
      )}

      {/* Sidebar navigation */}
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
            onClick={closeMenu}
            aria-label="Close menu"
          >
            <span>Close</span>
            <X size={16} />
          </button>
        </div>

        {/* Work section */}
        <nav className={styles.section}>
          <div className={styles.sectionLabel}>Work</div>
          <ul className={styles.navList}>
            <li>
              <Link to="/dashboard" className={getNavItemClass("/dashboard")}>
                Dashboard
              </Link>
            </li>
            <li>
              <Link to="/chat" className={getNavItemClass("/chat")}>
                Chat
              </Link>
            </li>
          </ul>
        </nav>

        {/* Admin-only management section */}
        {isAdmin && (
          <nav className={styles.section}>
            <div className={styles.sectionLabel}>Manage</div>
            <ul className={styles.navList}>
              <li>
                <Link
                  to="/org/context"
                  className={getNavItemClass("/org/context")}
                >
                  Knowledge Base
                </Link>
              </li>
              <li>
                <Link to="/org/clio" className={getNavItemClass("/org/clio")}>
                  Clio Connection
                </Link>
              </li>
              <li>
                <Link
                  to="/org/members"
                  className={getNavItemClass("/org/members")}
                >
                  Members
                </Link>
              </li>
            </ul>
          </nav>
        )}

        {/* Account section */}
        <nav className={styles.section}>
          <div className={styles.sectionLabel}>Account</div>
          <ul className={styles.navList}>
            <li>
              <Link
                to="/account/settings"
                className={getNavItemClass("/account/settings")}
              >
                User Settings
              </Link>
            </li>
          </ul>
        </nav>

        <div className={styles.orgInfoDivider} />

        {/* Organization info at bottom of sidebar */}
        {org?.org?.name && (
          <Link
            to="/org/settings"
            className={`${styles.orgInfo} ${
              currentPath === "/org/settings" ? styles.orgInfoActive : ""
            }`}
          >
            <span className={styles.orgAvatar}>
              {getOrgInitials(org.org.name)}
            </span>
            <span className={styles.orgDetails}>
              <span className={styles.orgName}>{org.org.name}</span>
              <span className={styles.orgRole}>{getOrgRoleLabel()}</span>
            </span>
          </Link>
        )}
      </aside>

      {/* Main content area */}
      <main className={styles.content}>
        <div className={styles.contentInner}>
          <PageLayoutContext.Provider value={{ onMenuOpen: openMenu }}>
            {children}
          </PageLayoutContext.Provider>
        </div>
      </main>
    </div>
  );
}
