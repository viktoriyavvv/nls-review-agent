import { NavLink, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">NLS Review Agent</span>
        <nav>
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/jql">JQL Queue</NavLink>
          <NavLink to="/history">History</NavLink>
          <NavLink to="/memory">Memory</NavLink>
          <NavLink to="/repos">Repos</NavLink>
          <NavLink to="/jobs">Jobs</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <span className="spacer" />
        <span className="readonly-pill" title="The GUI never writes to Jira or Bitbucket">
          ● Read-only
        </span>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
