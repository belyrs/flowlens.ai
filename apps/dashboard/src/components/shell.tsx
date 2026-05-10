import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";

interface ShellProps {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Shell({ title, subtitle, actions, children }: ShellProps) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">FL</span>
          <div>
            <strong>FlowLens</strong>
            <span>Backend flow mapper</span>
          </div>
        </Link>

        <nav className="nav">
          <NavLink to="/" end>
            Services
          </NavLink>
        </nav>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Developer Understanding Tool</p>
            <h1>{title}</h1>
            <p className="subtitle">{subtitle}</p>
          </div>
          <div className="header-actions">{actions}</div>
        </header>
        {children}
      </main>
    </div>
  );
}

