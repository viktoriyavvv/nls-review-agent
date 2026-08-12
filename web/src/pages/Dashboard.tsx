import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ClaudeSessionInfo, HistoryItem, Job, RepoRow, ResolveOutcome } from '../api/types';
import { useJobStream } from '../hooks/useJobStream';
import { LogPanel } from '../components/LogPanel';
import { JobStatusBadge, VerdictBadge } from '../components/StatusBadge';

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

export function Dashboard() {
  const nav = useNavigate();
  const [repos, setRepos] = useState<RepoRow[]>([]);
  const [issueKey, setIssueKey] = useState('');
  const [repoId, setRepoId] = useState('');
  const [fromHead, setFromHead] = useState('');
  const [previous, setPrevious] = useState('');
  const [showFollowupOpts, setShowFollowupOpts] = useState(false);

  const [autoSync, setAutoSync] = useState(true);
  const [resume, setResume] = useState(true);
  const [sessionInfo, setSessionInfo] = useState<ClaudeSessionInfo | null>(null);
  const [recent, setRecent] = useState<HistoryItem[]>([]);

  const [resolved, setResolved] = useState<ResolveOutcome | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { logs, job, stage, finished } = useJobStream(activeJobId);
  const running = Boolean(activeJobId) && !finished;

  useEffect(() => {
    api.repos().then(setRepos).catch(() => setRepos([]));
  }, []);

  function loadRecent() {
    api.history().then((r) => setRecent(r.slice(0, 8))).catch(() => setRecent([]));
  }
  useEffect(loadRecent, []);

  const keyValid = KEY_RE.test(issueKey.trim());

  // Auto-resolve the issue → repo as the user types (debounced).
  useEffect(() => {
    if (!keyValid) {
      setResolved(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .resolve(issueKey.trim(), repoId || undefined)
        .then(setResolved)
        .catch(() => setResolved(null));
    }, 250);
    return () => clearTimeout(t);
  }, [issueKey, repoId, keyValid]);

  useEffect(() => {
    if (finished && job) setLastJob(job);
    if (finished) loadRecent();
  }, [finished, job]);

  const effectiveRepoId = useMemo(() => {
    if (repoId) return repoId;
    if (resolved?.ok) return resolved.repo.id;
    return '';
  }, [repoId, resolved]);

  // Fetch the saved Claude session for the current issue+repo (for resume UI).
  useEffect(() => {
    if (!keyValid || !effectiveRepoId) {
      setSessionInfo(null);
      return;
    }
    let cancelled = false;
    api
      .claudeSession(issueKey.trim(), effectiveRepoId)
      .then((s) => !cancelled && setSessionInfo(s))
      .catch(() => !cancelled && setSessionInfo(null));
    return () => {
      cancelled = true;
    };
  }, [issueKey, effectiveRepoId, keyValid]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }

  async function act(fn: () => Promise<Job>) {
    try {
      const j = await fn();
      setActiveJobId(j.id);
      setLastJob(null);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) flash(`Already running: ${err.message}`);
      else if (err.status === 400) flash(err.message);
      else flash(err.message || 'Request failed');
    }
  }

  const needRepoChoice = resolved && !resolved.ok && resolved.reason === 'multi' && !repoId;

  const runReview = () =>
    act(() =>
      api.runReview({
        issueKey: issueKey.trim(),
        repoId: repoId || undefined,
        sync: autoSync ? undefined : false,
      }),
    );
  const runFollowup = () =>
    act(() =>
      api.runFollowup({
        issueKey: issueKey.trim(),
        repoId: repoId || undefined,
        fromHead: fromHead.trim() || undefined,
        previous: previous.trim() || undefined,
        sync: autoSync ? undefined : false,
        resume: resume ? undefined : false,
      }),
    );
  const sync = () => {
    if (!effectiveRepoId) return flash('Pick a repo to sync.');
    return act(() => api.syncRepo(effectiveRepoId));
  };
  const clean = () =>
    act(() => api.clean({ issueKey: issueKey.trim(), repoId: repoId || undefined }));

  const canRun = keyValid && !running && !needRepoChoice;
  const savedSessionId = sessionInfo?.session?.initialReviewSessionId ?? null;
  const resultsLink =
    lastJob?.issueKey && lastJob?.repoId
      ? `/issue/${encodeURIComponent(lastJob.issueKey)}/${encodeURIComponent(lastJob.repoId)}`
      : effectiveRepoId && keyValid
        ? `/issue/${encodeURIComponent(issueKey.trim())}/${encodeURIComponent(effectiveRepoId)}`
        : null;

  return (
    <>
      <div className="banner info">
        Read-only mode: GUI does not write to Jira or Bitbucket. It only reads them and runs local
        reviews/worktrees.
      </div>

      <div className="card">
        <h2>Run a review</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 200px' }}>
            Issue key
            <input
              type="text"
              placeholder="SC-3563"
              value={issueKey}
              spellCheck={false}
              onChange={(e) => setIssueKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && canRun && runReview()}
            />
          </label>
          <label className="field" style={{ flex: '1 1 260px' }}>
            Repo {repoId ? '' : '(auto)'}
            <select value={repoId} onChange={(e) => setRepoId(e.target.value)}>
              <option value="">— auto-detect from prefix —</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} [{r.jiraPrefixes.join(', ')}]
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* resolution hint */}
        <div style={{ marginTop: 8, minHeight: 20 }}>
          {!keyValid && issueKey && <span className="faint">Enter a key like SC-3563.</span>}
          {resolved?.ok && (
            <span className="muted">
              → resolves to <span className="mono">{resolved.repo.id}</span>
            </span>
          )}
          {resolved && !resolved.ok && resolved.reason === 'multi' && (
            <span className="banner warn" style={{ display: 'block' }}>
              Prefix <b>{resolved.prefix}</b> maps to {resolved.candidates?.length} repos — choose
              one explicitly:{' '}
              {resolved.candidates?.map((c) => (
                <button
                  key={c.id}
                  className="btn sm"
                  style={{ margin: '2px 4px' }}
                  onClick={() => setRepoId(c.id)}
                >
                  {c.id}
                </button>
              ))}
            </span>
          )}
          {resolved && !resolved.ok && resolved.reason === 'none' && (
            <span className="banner warn" style={{ display: 'block' }}>
              No repo mapped to prefix <b>{resolved.prefix}</b>. Pick one manually above.
            </span>
          )}
        </div>

        {/* run options */}
        <div className="row" style={{ marginTop: 6, gap: 20 }}>
          <label className="check">
            <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
            Sync repo before running{' '}
            <span className="faint">(git fetch --all --prune)</span>
          </label>
          <label className="check" title="Follow-up only: resume the initial review's Claude session">
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            Resume Claude session (follow-up)
          </label>
        </div>
        <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>
          Session:{' '}
          {savedSessionId ? (
            <span className="mono">{savedSessionId.slice(0, 12)}…</span>
          ) : (
            <span>not found — follow-up will run stateless (or set --resume-session)</span>
          )}
          {!autoSync && <span> · auto-sync OFF</span>}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={!canRun} onClick={runReview}>
            Run review
          </button>
          <button className="btn" disabled={!canRun} onClick={runFollowup}>
            Run follow-up
          </button>
          <button className="btn" disabled={!effectiveRepoId || running} onClick={sync}>
            Sync repo
          </button>
          <button className="btn ghost" disabled={!keyValid || running} onClick={clean}>
            Clean worktree
          </button>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => setShowFollowupOpts((s) => !s)}>
            {showFollowupOpts ? '▾' : '▸'} Follow-up options
          </button>
        </div>

        {showFollowupOpts && (
          <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <label className="field" style={{ flex: '1 1 240px' }}>
              Previous HEAD (--from-head)
              <input
                type="text"
                placeholder="optional commit hash"
                value={fromHead}
                spellCheck={false}
                onChange={(e) => setFromHead(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: '1 1 320px' }}>
              Previous review path (--previous)
              <input
                type="text"
                placeholder="optional path to review.json/review.md"
                value={previous}
                spellCheck={false}
                onChange={(e) => setPrevious(e.target.value)}
              />
            </label>
          </div>
        )}
      </div>

      {/* live job */}
      {activeJobId && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              {job?.label ?? 'Job'} {job && <JobStatusBadge status={job.status} />}{' '}
              {job?.verdict && <VerdictBadge verdict={job.verdict} />}
            </h2>
            <div className="row">
              {resultsLink && (
                <button className="btn sm" onClick={() => nav(resultsLink)}>
                  Open results →
                </button>
              )}
            </div>
          </div>
          <LogPanel lines={logs} stage={!finished ? stage : null} />
          {finished && job && (
            <div className="muted" style={{ marginTop: 8 }}>
              Finished with status <b>{job.status}</b>
              {job.exitCode != null && <> (exit {job.exitCode})</>}
              {job.error && <> — {job.error}</>}
            </div>
          )}
        </div>
      )}

      {/* recent history */}
      {recent.length > 0 && (
        <div className="card">
          <div className="section-title">
            <h2 style={{ margin: 0 }}>Recent reviews</h2>
            <Link to="/history" className="btn sm ghost">
              All history →
            </Link>
          </div>
          <div className="scroll-x" style={{ marginTop: 10 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Repo</th>
                  <th>Review</th>
                  <th>Follow-up</th>
                  <th>Last run</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {recent.map((it) => (
                  <tr key={`${it.issueKey}/${it.repoId}`}>
                    <td className="mono">{it.issueKey}</td>
                    <td className="mono faint">{it.repoId}</td>
                    <td>
                      <VerdictBadge verdict={it.latestReview?.verdict} />
                    </td>
                    <td>
                      <VerdictBadge verdict={it.latestFollowup?.verdict} />
                    </td>
                    <td className="faint nowrap">{new Date(it.updatedAt).toLocaleString()}</td>
                    <td>
                      <Link
                        className="btn sm"
                        to={`/issue/${encodeURIComponent(it.issueKey)}/${encodeURIComponent(it.repoId)}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </>
  );
}
