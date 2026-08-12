import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { HistoryItem, Job } from '../api/types';
import { useJobStream } from '../hooks/useJobStream';
import { LogPanel } from '../components/LogPanel';
import { JobStatusBadge, VerdictBadge } from '../components/StatusBadge';

export function HistoryPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { logs, job, stage, finished } = useJobStream(activeJobId);
  const running = Boolean(activeJobId) && !finished;

  function load() {
    setErr(null);
    api.history().then(setItems).catch((e) => setErr(String(e.message ?? e)));
  }
  useEffect(load, []);
  useEffect(() => {
    if (finished) load();
  }, [finished]);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  }
  async function act(fn: () => Promise<Job>) {
    try {
      const j = await fn();
      setActiveJobId(j.id);
    } catch (e) {
      const er = e as ApiError;
      flash(er.status === 409 ? `Already running: ${er.message}` : er.message);
    }
  }

  const link = (it: HistoryItem) =>
    `/issue/${encodeURIComponent(it.issueKey)}/${encodeURIComponent(it.repoId)}`;

  return (
    <>
      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Review history</h2>
          <button className="btn sm" onClick={load}>
            Refresh
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          Every issue+repo found in <span className="mono">outputs/</span>. Actions run against the
          same repo (auto-sync first).
        </p>
        {err && <div className="banner error" style={{ marginTop: 12 }}>{err}</div>}
        <div className="scroll-x" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Repo</th>
                <th>Review</th>
                <th>Follow-up</th>
                <th>Last run</th>
                <th>PR</th>
                <th>Branch</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items?.map((it) => (
                <tr key={`${it.issueKey}/${it.repoId}`}>
                  <td className="mono">
                    <Link to={link(it)}>{it.issueKey}</Link>
                  </td>
                  <td className="mono faint">{it.repoId}</td>
                  <td>
                    <VerdictBadge verdict={it.latestReview?.verdict} />
                  </td>
                  <td>
                    <VerdictBadge verdict={it.latestFollowup?.verdict} />
                  </td>
                  <td className="faint nowrap">{new Date(it.updatedAt).toLocaleString()}</td>
                  <td className="faint nowrap">{it.pr?.prFound ? `#${String(it.pr.id)}` : '—'}</td>
                  <td className="mono faint">{it.pr?.sourceBranch ?? '—'}</td>
                  <td>
                    <div className="row">
                      <button className="btn sm" onClick={() => nav(link(it))}>
                        Open
                      </button>
                      <button
                        className="btn sm"
                        disabled={running}
                        onClick={() => act(() => api.runReview({ issueKey: it.issueKey, repoId: it.repoId }))}
                      >
                        Review
                      </button>
                      <button
                        className="btn sm"
                        disabled={running}
                        onClick={() => act(() => api.runFollowup({ issueKey: it.issueKey, repoId: it.repoId }))}
                      >
                        Follow-up
                      </button>
                      <button
                        className="btn sm ghost"
                        disabled={running}
                        onClick={() => act(() => api.clean({ issueKey: it.issueKey, repoId: it.repoId }))}
                      >
                        Clean
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {items && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No runs yet. Run a review from the Dashboard.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </>
  );
}
