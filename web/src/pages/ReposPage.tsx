import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Job, RepoRow } from '../api/types';
import { useJobStream } from '../hooks/useJobStream';
import { LogPanel } from '../components/LogPanel';
import { BoolBadge, JobStatusBadge } from '../components/StatusBadge';
import { CopyButton } from '../components/CopyButton';

export function ReposPage() {
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { logs, job, stage, finished } = useJobStream(activeJobId);
  const running = Boolean(activeJobId) && !finished;

  function load() {
    api.repos().then(setRepos).catch(() => setRepos([]));
  }
  useEffect(load, []);
  useEffect(() => {
    if (finished) load();
  }, [finished]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  }

  async function startJob(fn: () => Promise<Job>) {
    try {
      const j = await fn();
      setActiveJobId(j.id);
    } catch (e) {
      const err = e as ApiError;
      flash(err.status === 409 ? `Already running: ${err.message}` : err.message);
    }
  }

  const sync = (repoId: string) => startJob(() => api.syncRepo(repoId));
  const clone = (repoId: string) => startJob(() => api.cloneRepo(repoId, true));

  async function remove(repoId: string, path: string) {
    if (!window.confirm(`Remove local repo folder?\nThis deletes ${path}.\nOutputs and review history remain.`))
      return;
    try {
      const res = await api.removeLocalRepo(repoId, false);
      flash(res.removed ? `Removed ${res.path}.` : `Nothing removed (${res.reason ?? 'not found'}).`);
      load();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        if (window.confirm(`${err.message}\nDelete anyway (force)?`)) {
          try {
            await api.removeLocalRepo(repoId, true);
            flash(`Removed ${path} (forced).`);
            load();
          } catch (e2) {
            flash((e2 as ApiError).message);
          }
        }
      } else {
        flash(err.message);
      }
    }
  }

  async function reclone(repoId: string, path: string) {
    if (!window.confirm(`Re-clone ${repoId}?\nThis deletes ${path} then clones again.\nOutputs are kept.`))
      return;
    try {
      await api.removeLocalRepo(repoId, true);
      await startJob(() => api.cloneRepo(repoId, true));
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  const missing = repos?.filter((r) => !r.exists).length ?? 0;

  return (
    <>
      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Repositories</h2>
          <button className="btn sm" onClick={load}>
            Refresh
          </button>
        </div>
        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Repo ID</th>
                <th>Prefixes</th>
                <th>Path</th>
                <th>Exists</th>
                <th>Git</th>
                <th>Clone URL (no token)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {repos?.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>{r.jiraPrefixes.join(', ')}</td>
                  <td className="mono faint">{r.path}</td>
                  <td>
                    <BoolBadge value={r.exists} yes="yes" no="missing" />
                  </td>
                  <td>
                    <BoolBadge value={r.isGitRepo} yes="git" no="—" />
                  </td>
                  <td className="mono faint" style={{ maxWidth: 280, wordBreak: 'break-all' }}>
                    {r.cloneUrl}
                  </td>
                  <td>
                    <div className="row">
                      {r.exists ? (
                        <>
                          <button className="btn sm" disabled={running} onClick={() => sync(r.id)} title="git fetch --all --prune">
                            Sync
                          </button>
                          <button className="btn sm ghost" disabled={running} onClick={() => reclone(r.id, r.path)}>
                            Re-clone
                          </button>
                          <button className="btn sm ghost" disabled={running} onClick={() => remove(r.id, r.path)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button className="btn sm primary" disabled={running} onClick={() => clone(r.id)} title="git clone (username only, no token)">
                          Clone
                        </button>
                      )}
                      <CopyButton text={`git clone ${r.cloneUrl} ${r.path}`} label="Copy clone cmd" />
                    </div>
                  </td>
                </tr>
              ))}
              {repos && repos.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No repos configured. Edit config/repos.yml.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {missing > 0 && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            {missing} repo(s) missing on disk. Use <b>Clone</b> (Git Credential Manager will prompt
            for the password/token), or clone manually into the configured path.
          </div>
        )}
        <div className="muted" style={{ marginTop: 10 }}>
          Clone URLs never contain a token — the username (if configured) is embedded so Git
          Credential Manager can pick up the password. See <Link to="/history">History</Link> for
          past runs.
        </div>
      </div>

      {activeJobId && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              {job?.label ?? 'Job'} {job && <JobStatusBadge status={job.status} />}
            </h2>
          </div>
          <LogPanel lines={logs} stage={!finished ? stage : null} height={260} />
          {finished && job?.error && (
            <div className="banner error" style={{ marginTop: 8 }}>
              {job.error}
            </div>
          )}
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </>
  );
}
