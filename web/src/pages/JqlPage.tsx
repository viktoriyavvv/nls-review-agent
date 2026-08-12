import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { JiraQueueIssue, JiraSearchResponse, Job, SavedJqlQuery } from '../api/types';
import { useJobStream } from '../hooks/useJobStream';
import { LogPanel } from '../components/LogPanel';
import { CopyButton } from '../components/CopyButton';
import { JobStatusBadge, VerdictBadge } from '../components/StatusBadge';

type SortCol = 'key' | 'status' | 'assignee' | 'updated' | 'created';
interface RowState {
  hasReview: boolean;
  reviewVerdict?: string;
  hasFollowup: boolean;
  followupVerdict?: string;
}

const EXAMPLE_JQL =
  'assignee IN (currentUser())\nand status IN ("Code review", "CR Teamlead")\nORDER BY updated ASC';

function fmtDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function JqlPage() {
  const nav = useNavigate();

  // saved queries
  const [queries, setQueries] = useState<SavedJqlQuery[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [jql, setJql] = useState('');
  const [maxResults, setMaxResults] = useState(100);

  // search
  const [result, setResult] = useState<JiraSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  // table view
  const [sort, setSort] = useState<{ col: SortCol | null; dir: 'asc' | 'desc' }>({
    col: null,
    dir: 'asc',
  });
  const [filter, setFilter] = useState('');
  const [repoChoice, setRepoChoice] = useState<Record<string, string>>({});
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  // jobs
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { logs, job, stage, finished } = useJobStream(activeJobId);
  const running = Boolean(activeJobId) && !finished;

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  }

  function reloadQueries(selectId?: string) {
    return api
      .jqlQueries()
      .then((qs) => {
        setQueries(qs);
        if (selectId) {
          const q = qs.find((x) => x.id === selectId);
          if (q) {
            setSelectedId(q.id);
            setName(q.name);
            setJql(q.jql);
          }
        }
      })
      .catch(() => setQueries([]));
  }
  useEffect(() => {
    reloadQueries();
  }, []);

  // Refresh a row's local review/follow-up state after a job or repo choice.
  async function refreshRow(issueKey: string, repoId: string) {
    try {
      const s = await api.summary(issueKey, repoId);
      setRowState((m) => ({
        ...m,
        [`${issueKey}/${repoId}`]: {
          hasReview: s.hasReview,
          reviewVerdict: s.reviewVerdict ?? undefined,
          hasFollowup: s.hasFollowup,
          followupVerdict: s.followupVerdict ?? undefined,
        },
      }));
    } catch {
      /* outputs may not exist yet — leave as-is */
    }
  }
  useEffect(() => {
    if (finished && job?.issueKey && job?.repoId) refreshRow(job.issueKey, job.repoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  /* ------------------------------ saved query ---------------------------- */

  function onSelectSaved(id: string) {
    setSelectedId(id);
    const q = queries.find((x) => x.id === id);
    if (q) {
      setName(q.name);
      setJql(q.jql);
    } else {
      setName('');
      setJql('');
    }
  }

  async function save() {
    if (!name.trim() || !jql.trim()) return flash('Name and JQL are required.');
    try {
      if (selectedId) {
        const q = await api.updateJqlQuery(selectedId, { name: name.trim(), jql: jql.trim() });
        await reloadQueries(q.id);
        flash('Saved.');
      } else {
        const q = await api.createJqlQuery({ name: name.trim(), jql: jql.trim() });
        await reloadQueries(q.id);
        flash('Saved.');
      }
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  async function saveAsNew() {
    if (!name.trim() || !jql.trim()) return flash('Name and JQL are required.');
    try {
      const q = await api.createJqlQuery({ name: name.trim(), jql: jql.trim() });
      await reloadQueries(q.id);
      flash('Saved as new.');
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  async function remove() {
    if (!selectedId) return;
    if (!window.confirm(`Delete saved query "${name || selectedId}"?`)) return;
    try {
      await api.deleteJqlQuery(selectedId);
      setSelectedId('');
      await reloadQueries();
      flash('Deleted.');
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  /* -------------------------------- search ------------------------------- */

  async function runJql() {
    if (!jql.trim()) return flash('Enter a JQL query.');
    setSearching(true);
    setSearchErr(null);
    try {
      const res = await api.jqlSearch({ jql: jql.trim(), maxResults });
      setResult(res);
      // Seed row state from the single-repo issues the backend already resolved.
      const seed: Record<string, RowState> = {};
      for (const it of res.issues) {
        if (it.repoResolution.status === 'single' && it.repoResolution.repoId && it.localReviewState) {
          seed[`${it.key}/${it.repoResolution.repoId}`] = {
            hasReview: it.localReviewState.hasReview,
            reviewVerdict: it.localReviewState.reviewVerdict,
            hasFollowup: it.localReviewState.hasFollowup,
            followupVerdict: it.localReviewState.followupVerdict,
          };
        }
      }
      setRowState(seed);
    } catch (e) {
      setResult(null);
      setSearchErr((e as ApiError).message);
    } finally {
      setSearching(false);
    }
  }

  /* -------------------------------- actions ------------------------------ */

  function effectiveRepo(issue: JiraQueueIssue): string | undefined {
    if (issue.repoResolution.status === 'single') return issue.repoResolution.repoId;
    if (issue.repoResolution.status === 'multiple') return repoChoice[issue.key];
    return undefined;
  }

  function displayState(issue: JiraQueueIssue): RowState | undefined {
    const repoId = effectiveRepo(issue);
    if (repoId && rowState[`${issue.key}/${repoId}`]) return rowState[`${issue.key}/${repoId}`];
    if (issue.repoResolution.status === 'single') return issue.localReviewState;
    return undefined;
  }

  async function act(issue: JiraQueueIssue, fn: (repoId: string) => Promise<Job>) {
    const repoId = effectiveRepo(issue);
    if (!repoId) return flash(`Select a repo for ${issue.key} first.`);
    try {
      const j = await fn(repoId);
      setActiveJobId(j.id);
    } catch (e) {
      const er = e as ApiError;
      flash(er.status === 409 ? `Already running: ${er.message}` : er.message);
    }
  }

  function chooseRepo(issue: JiraQueueIssue, repoId: string) {
    setRepoChoice((m) => ({ ...m, [issue.key]: repoId }));
    if (repoId) refreshRow(issue.key, repoId);
  }

  /* ------------------------------- table view ---------------------------- */

  function toggleSort(col: SortCol) {
    setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  }
  const sortArrow = (col: SortCol) => (sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  const visible = useMemo(() => {
    let list = result?.issues ?? [];
    const f = filter.trim().toLowerCase();
    if (f) {
      list = list.filter(
        (i) =>
          i.key.toLowerCase().includes(f) ||
          (i.summary ?? '').toLowerCase().includes(f) ||
          (i.assignee ?? '').toLowerCase().includes(f),
      );
    }
    if (sort.col) {
      const col = sort.col;
      const val = (i: JiraQueueIssue): string => {
        switch (col) {
          case 'key':
            return i.key;
          case 'status':
            return i.status ?? '';
          case 'assignee':
            return i.assignee ?? '';
          case 'updated':
            return i.updated ?? '';
          case 'created':
            return i.created ?? '';
        }
      };
      list = [...list].sort((a, b) => val(a).localeCompare(val(b)) * (sort.dir === 'asc' ? 1 : -1));
    }
    return list;
  }, [result, filter, sort]);

  const resultLink = (issue: JiraQueueIssue): string | null => {
    const repoId = effectiveRepo(issue);
    return repoId
      ? `/issue/${encodeURIComponent(issue.key)}/${encodeURIComponent(repoId)}`
      : null;
  };

  return (
    <>
      <div className="banner info">
        Read-only: JQL queries only <b>read</b> Jira. Run review / follow-up start local jobs (same
        as the Dashboard). Saved queries live in <span className="mono">config/jql-queries.json</span>.
      </div>

      {/* -------------------------- saved queries ------------------------- */}
      <div className="card">
        <h2>Jira JQL Queue</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 240px' }}>
            Saved query
            <select value={selectedId} onChange={(e) => onSelectSaved(e.target.value)}>
              <option value="">— new query —</option>
              {queries.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 240px' }}>
            Name
            <input
              type="text"
              placeholder="CR Teamlead queue"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field" style={{ flex: '0 0 130px' }}>
            Max results
            <input
              type="text"
              inputMode="numeric"
              value={String(maxResults)}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setMaxResults(Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 100);
              }}
            />
          </label>
        </div>

        <label className="field" style={{ marginTop: 10 }}>
          JQL
          <textarea
            className="mono"
            rows={5}
            spellCheck={false}
            placeholder={EXAMPLE_JQL}
            value={jql}
            onChange={(e) => setJql(e.target.value)}
          />
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={searching || !jql.trim()} onClick={runJql}>
            {searching ? 'Running…' : 'Run JQL'}
          </button>
          <button className="btn" disabled={!name.trim() || !jql.trim()} onClick={save}>
            {selectedId ? 'Save' : 'Save'}
          </button>
          <button className="btn" disabled={!name.trim() || !jql.trim()} onClick={saveAsNew}>
            Save as new
          </button>
          <button className="btn ghost" disabled={!selectedId} onClick={remove}>
            Delete
          </button>
          <CopyButton text={jql} label="Copy JQL" className="btn sm ghost" />
        </div>
        {searchErr && (
          <div className="banner error" style={{ marginTop: 12 }}>
            {searchErr}
          </div>
        )}
      </div>

      {/* ------------------------------ results --------------------------- */}
      {result && (
        <div className="card">
          <div className="section-title">
            <h2 style={{ margin: 0 }}>
              Issues <span className="faint">({result.issues.length})</span>
            </h2>
            <input
              type="text"
              placeholder="Filter key / summary / assignee…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: '0 1 320px' }}
            />
          </div>

          {result.warning && (
            <div className="banner warn" style={{ marginTop: 10 }}>
              {result.warning}
            </div>
          )}

          <div className="scroll-x tall" style={{ marginTop: 12 }}>
            <table className="tbl sticky">
              <thead>
                <tr>
                  <th className="sortable" onClick={() => toggleSort('key')}>
                    Key{sortArrow('key')}
                  </th>
                  <th>Summary</th>
                  <th className="sortable" onClick={() => toggleSort('status')}>
                    Status{sortArrow('status')}
                  </th>
                  <th className="sortable" onClick={() => toggleSort('assignee')}>
                    Assignee{sortArrow('assignee')}
                  </th>
                  <th className="sortable" onClick={() => toggleSort('updated')}>
                    Updated{sortArrow('updated')}
                  </th>
                  <th className="sortable" onClick={() => toggleSort('created')}>
                    Created{sortArrow('created')}
                  </th>
                  <th>Repo</th>
                  <th>PR</th>
                  <th>Review</th>
                  <th>Follow-up</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((it) => {
                  const st = displayState(it);
                  const repoId = effectiveRepo(it);
                  const link = resultLink(it);
                  return (
                    <tr key={it.key}>
                      <td className="mono nowrap">
                        {it.jiraUrl ? (
                          <a href={it.jiraUrl} target="_blank" rel="noreferrer">
                            {it.key}
                          </a>
                        ) : (
                          it.key
                        )}
                      </td>
                      <td className="summary-cell" title={it.summary}>
                        {it.summary || '—'}
                      </td>
                      <td className="nowrap">{it.status ?? '—'}</td>
                      <td className="nowrap faint">{it.assignee ?? '—'}</td>
                      <td className="nowrap faint">{fmtDate(it.updated)}</td>
                      <td className="nowrap faint">{fmtDate(it.created)}</td>
                      <td className="nowrap">
                        {it.repoResolution.status === 'single' && (
                          <span className="mono faint">{it.repoResolution.repoId}</span>
                        )}
                        {it.repoResolution.status === 'multiple' && (
                          <select
                            value={repoChoice[it.key] ?? ''}
                            onChange={(e) => chooseRepo(it, e.target.value)}
                          >
                            <option value="">Select repo…</option>
                            {it.repoResolution.candidates?.map((c) => (
                              <option key={c.repoId} value={c.repoId}>
                                {c.displayName ?? c.repoId}
                              </option>
                            ))}
                          </select>
                        )}
                        {it.repoResolution.status === 'none' && (
                          <span className="faint" title={it.repoResolution.message}>
                            no repo
                          </span>
                        )}
                      </td>
                      <td className="faint nowrap">{it.pr?.prFound ? `#${String(it.pr.id)}` : '—'}</td>
                      <td>
                        {st ? <VerdictBadge verdict={st.reviewVerdict} /> : <span className="faint">—</span>}
                      </td>
                      <td>
                        {st ? (
                          <VerdictBadge verdict={st.followupVerdict} />
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <a
                            className={`btn sm ${it.jiraUrl ? '' : 'ghost'}`}
                            href={it.jiraUrl || undefined}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Jira
                          </a>
                          <button
                            className="btn sm"
                            disabled={!link}
                            onClick={() => link && nav(link)}
                            title={link ? 'Open result' : 'Pick a repo first'}
                          >
                            Result
                          </button>
                          <button
                            className="btn sm"
                            disabled={running || !repoId}
                            onClick={() => act(it, (r) => api.runReview({ issueKey: it.key, repoId: r }))}
                          >
                            Review
                          </button>
                          <button
                            className="btn sm"
                            disabled={running || !repoId}
                            onClick={() =>
                              act(it, (r) => api.runFollowup({ issueKey: it.key, repoId: r }))
                            }
                          >
                            Follow-up
                          </button>
                          <button
                            className="btn sm ghost"
                            disabled={running || !repoId}
                            onClick={() => act(it, (r) => api.syncRepo(r))}
                          >
                            Sync
                          </button>
                          <CopyButton text={it.key} label="Copy" className="btn sm ghost" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={11} className="muted">
                      No issues match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ------------------------------- job ------------------------------ */}
      {activeJobId && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>
              {job?.label ?? 'Job'} {job && <JobStatusBadge status={job.status} />}
            </h2>
            {finished && job?.issueKey && job?.repoId && (
              <button
                className="btn sm"
                onClick={() =>
                  nav(`/issue/${encodeURIComponent(job.issueKey!)}/${encodeURIComponent(job.repoId!)}`)
                }
              >
                Open result →
              </button>
            )}
          </div>
          <LogPanel lines={logs} stage={!finished ? stage : null} height={260} />
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </>
  );
}
