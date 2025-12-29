import { useContext } from "react";
import { Menu } from "lucide-react";
import { PageLayoutContext } from "~/components/AppLayout";
import styles from "~/styles/page-layout.module.css";

interface PageLayoutProps {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function PageLayout({
  title,
  subtitle,
  actions,
  children,
}: PageLayoutProps) {
  const layoutContext = useContext(PageLayoutContext);

  function handleMenuClick() {
    if (layoutContext) {
      layoutContext.onMenuOpen();
    }
  }

  const showMenuButton = layoutContext !== null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        {/* Title and subtitle */}
        <div className={styles.headerContent}>
          <h1 className="text-title-1">{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}

          {/* Actions shown below title on mobile */}
          {actions && (
            <div className={styles.actionsMobileWrapper}>{actions}</div>
          )}
        </div>

        {/* Actions and menu button */}
        <div className={styles.headerActions}>
          {/* Actions shown inline on desktop */}
          {actions && (
            <div className={styles.actionsDesktopWrapper}>{actions}</div>
          )}

          {/* Mobile menu button */}
          {showMenuButton && (
            <button
              type="button"
              className={`${styles.menuButton} btn-sm btn btn-secondary`}
              onClick={handleMenuClick}
              aria-label="Open menu"
            >
              <span>Menu</span>
              <Menu size={16} />
            </button>
          )}
        </div>
      </header>

      {children}
    </div>
  );
}
