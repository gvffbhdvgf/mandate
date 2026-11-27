import Link from "next/link";
import type { ReactNode } from "react";

type NavigationItem = { label: string; href: string };

export function WorkspaceShell({
  children,
  section,
  context,
  items,
  activeHref,
  actions,
}: {
  children: ReactNode;
  section: string;
  context?: string;
  items: NavigationItem[];
  activeHref?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="app-frame">
      <aside className="app-sidebar">
        <Link className="brand" href="/dashboard" aria-label="Mandate workspace home">
          <span className="brand-mark">M</span><span>mandate</span>
        </Link>
        <div className="sidebar-group">
          <p className="sidebar-label">WORKSPACE</p>
          <nav className="workspace-nav" aria-label="Workspace navigation">
            {items.map((item) => (
              <Link
                href={item.href}
                key={item.href}
                className={`workspace-nav-link${activeHref === item.href ? " is-active" : ""}`}
                aria-current={activeHref === item.href ? "page" : undefined}
              >
                <span className="workspace-nav-mark" aria-hidden="true" />
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="sidebar-footer">
          <span className="sidebar-footer-mark" aria-hidden="true">✓</span>
          <span><strong>Clear process.</strong><small>Confident decisions.</small></span>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-title">
            <p className="app-context">{section}</p>
            {context && <p className="app-context-meta">{context}</p>}
          </div>
          <div className="app-topbar-actions">{actions}</div>
        </header>
        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
