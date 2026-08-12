import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Job } from '../api/types';
import { useJobStream } from '../hooks/useJobStream';
import { LogPanel } from '../components/LogPanel';
import { JobStatusBadge, VerdictBadge } from '../components/StatusBadge';

function duration(j: Job): string {
  const end = j.finishedAt ?? Date.now();
  const start = j.startedAt ?? j.createdAt;
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function JobsPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stream = useJobStream(selectedId);

  function load() {
    api.jobs().then(setJobs).catch(() => setJobs([]));
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);

  const active = (jobs ?? []).filter((j) => j.status === 'running' || j.status === 'queued').length;

  return (
    <>
      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Jobs</h2>
          <button className="btn sm" onClick={load}>
            Refresh
          </button>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          In-memory for this GUI session. {active} active.
        </p>
        <div className="scroll-x" style={{ marginTop: 8 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Job</th>
                <th>Label</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Verdict</th>
                <th>Duration</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs?.map((j) => (
                <tr key={j.id}>
                  <td className="mono">{j.id}</td>
                  <td className="faint">{j.label}</td>
                  <td>
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="faint">{j.stage ?? '—'}</td>
                  <td>{j.verdict ? <VerdictBadge verdict={j.verdict} /> : '—'}</td>
                  <td className="faint nowrap">{duration(j)}</td>
                  <td>
                    <button
                      className={`btn sm ${selectedId === j.id ? 'primary' : ''}`}
                      onClick={() => setSelectedId(j.id)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
              {jobs && jobs.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No jobs yet. Start one from the Dashboard, History or Repos.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedId && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              {stream.job?.label ?? selectedId} {stream.job && <JobStatusBadge status={stream.job.status} />}{' '}
              {stream.job?.verdict && <VerdictBadge verdict={stream.job.verdict} />}
            </h2>
          </div>
          <LogPanel lines={stream.logs} stage={!stream.finished ? stream.stage : null} />
          {stream.job?.error && (
            <div className="banner error" style={{ marginTop: 8 }}>
              {stream.job.error}
            </div>
          )}
        </div>
      )}
    </>
  );
}
