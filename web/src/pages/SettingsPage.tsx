import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ConfigStatus } from '../api/types';

function EnvBadge({ state }: { state: 'set' | 'missing' }) {
  return <span className={`badge ${state === 'set' ? 'green' : 'red'}`}>{state}</span>;
}

export function SettingsPage() {
  const [cfg, setCfg] = useState<ConfigStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0);

  function load() {
    setError(null);
    api
      .configStatus()
      .then((c) => {
        setCfg(c);
        setLoadedAt((n) => n + 1);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }
  useEffect(load, []);

  return (
    <>
      <div className="banner info">
        Tokens are never shown — only whether each credential is present. The GUI is read-only
        towards Jira and Bitbucket.
      </div>

      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Settings</h2>
          <button className="btn sm" onClick={load}>
            Validate config{loadedAt > 0 ? ` ✓` : ''}
          </button>
        </div>
        {error && <div className="banner error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      {cfg && (
        <>
          <div className="grid2">
            <div className="card">
              <h2>Jira</h2>
              <dl className="kv">
                <dt>Base URL</dt>
                <dd>{cfg.jira.baseUrl || '—'}</dd>
                <dt>Email</dt>
                <dd>{cfg.jira.email || '—'}</dd>
                <dt>API version</dt>
                <dd>{cfg.jira.apiVersion}</dd>
                <dt>API token</dt>
                <dd>
                  <span className={`badge ${cfg.jira.hasApiToken ? 'green' : 'red'}`}>
                    {cfg.jira.hasApiToken ? 'set' : 'missing'}
                  </span>
                </dd>
              </dl>
            </div>

            <div className="card">
              <h2>Bitbucket</h2>
              <dl className="kv">
                <dt>Type</dt>
                <dd>{cfg.bitbucket.type}</dd>
                <dt>Workspace</dt>
                <dd>{cfg.bitbucket.workspace || '—'}</dd>
                <dt>Base URL</dt>
                <dd>{cfg.bitbucket.baseUrl || '—'}</dd>
                <dt>Username</dt>
                <dd>
                  <span className={`badge ${cfg.bitbucket.hasUsername ? 'green' : 'red'}`}>
                    {cfg.bitbucket.hasUsername ? 'set' : 'missing'}
                  </span>
                </dd>
                <dt>Token</dt>
                <dd>
                  <span className={`badge ${cfg.bitbucket.hasToken ? 'green' : 'red'}`}>
                    {cfg.bitbucket.hasToken ? 'set' : 'missing'}
                  </span>
                </dd>
              </dl>
            </div>

            <div className="card">
              <h2>Claude CLI</h2>
              <dl className="kv">
                <dt>bin</dt>
                <dd>{cfg.claude.bin}</dd>
                <dt>model</dt>
                <dd>{cfg.claude.model}</dd>
                <dt>effort</dt>
                <dd>{cfg.claude.effort}</dd>
                <dt>permission</dt>
                <dd>{cfg.claude.permissionMode}</dd>
                <dt>output</dt>
                <dd>{cfg.claude.outputFormat}</dd>
                <dt>maxTurns</dt>
                <dd>{cfg.claude.maxTurns ?? '— (unset)'}</dd>
              </dl>
            </div>

            <div className="card">
              <h2>Paths</h2>
              <dl className="kv">
                <dt>repos</dt>
                <dd>{cfg.paths.reposDir}</dd>
                <dt>worktrees</dt>
                <dd>{cfg.paths.worktreesDir}</dd>
                <dt>outputs</dt>
                <dd>{cfg.paths.outputsDir}</dd>
                <dt>locks</dt>
                <dd>{cfg.paths.locksDir}</dd>
              </dl>
            </div>

            <div className="card">
              <h2>Jira JQL Queue</h2>
              <dl className="kv">
                <dt>Saved JQL file</dt>
                <dd>{cfg.jql.file}</dd>
                <dt>Jira API</dt>
                <dd>
                  <span className={`badge ${cfg.jql.jiraConfigured ? 'green' : 'red'}`}>
                    {cfg.jql.jiraConfigured ? 'configured' : 'missing token'}
                  </span>
                </dd>
              </dl>
            </div>
          </div>

          <div className="card">
            <h2>Environment</h2>
            <div className="row">
              {Object.entries(cfg.env).map(([k, v]) => (
                <span key={k} className="row" style={{ gap: 6, marginRight: 14 }}>
                  <span className="mono faint">{k}</span> <EnvBadge state={v} />
                </span>
              ))}
            </div>
            <div className="muted" style={{ marginTop: 10 }}>
              {cfg.repoCount} repos configured.
            </div>
          </div>
        </>
      )}
    </>
  );
}
