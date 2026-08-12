import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Job, MemoryUsedItem, OutputFileEntry } from '../api/types';
import { useAsync } from '../hooks/useAsync';
import { useJobStream } from '../hooks/useJobStream';
import { Tabs } from '../components/Tabs';
import { Markdown } from '../components/Markdown';
import { CopyButton } from '../components/CopyButton';
import { FileViewer } from '../components/FileViewer';
import { LogPanel } from '../components/LogPanel';
import { JobStatusBadge, VerdictBadge } from '../components/StatusBadge';

const TABS = [
  { id: 'review', label: 'Review' },
  { id: 'followups', label: 'Follow-ups' },
  { id: 'jira', label: 'Jira' },
  { id: 'pr', label: 'PR' },
  { id: 'git', label: 'Git' },
  { id: 'files', label: 'Files' },
  { id: 'logs', label: 'Logs' },
];

async function readJson<T = any>(issueKey: string, repoId: string, path: string): Promise<T> {
  const f = await api.file(issueKey, repoId, path);
  return JSON.parse(f.content) as T;
}

export function ResultsPage() {
  const { issueKey = '', repoId = '' } = useParams();
  const [tab, setTab] = useState('review');
  const summary = useAsync(() => api.summary(issueKey, repoId), [issueKey, repoId]);
  const session = useAsync(() => api.claudeSession(issueKey, repoId), [issueKey, repoId]);
  const s = summary.data;
  const cs = session.data;
  const fu = cs?.followup;

  return (
    <>
      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>
            {issueKey} <span className="faint mono" style={{ fontSize: 13 }}>/ {repoId}</span>
          </h2>
          <div className="row">
            <Link to="/history" className="btn sm ghost">
              ← History
            </Link>
            <Link to="/" className="btn sm">
              Dashboard
            </Link>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 18 }}>
          <span>
            Review: <VerdictBadge verdict={s?.reviewVerdict} />
          </span>
          <span>
            Follow-up: <VerdictBadge verdict={s?.followupVerdict} />
          </span>
          {s?.prFound ? (
            <span className="badge blue">PR-aware · #{String(s.prId)}</span>
          ) : (
            <span className="badge gray">branch-only</span>
          )}
          {s?.prFound && s?.prTitle && <span className="muted">{s.prTitle}</span>}
          {s?.branch && (
            <span className="mono faint">
              {s.branch} → {s.baseBranch}
            </span>
          )}
          {s?.head && <span className="mono faint">HEAD {s.head.slice(0, 12)}</span>}
        </div>

        {(cs?.session || fu) && (
          <div className="row" style={{ marginTop: 10, gap: 18, fontSize: 12 }} data-testid="claude-session">
            <span className="faint">Claude session:</span>
            <span className="mono">
              initial {cs?.session?.initialReviewSessionId
                ? `${cs.session.initialReviewSessionId.slice(0, 12)}…`
                : '—'}
            </span>
            {fu && (
              <>
                <span>
                  used resume:{' '}
                  <b className={fu.resumedClaudeSession ? 'ok-text' : 'faint'}>
                    {fu.resumedClaudeSession ? 'yes' : 'no'}
                  </b>
                </span>
                <span>
                  compact: <b className={fu.compactBeforeFollowup ? 'ok-text' : 'faint'}>
                    {fu.compactBeforeFollowup ? 'yes' : 'no'}
                  </b>
                </span>
                {fu.resumeError && <span className="warn-text">{fu.resumeError}</span>}
              </>
            )}
          </div>
        )}
      </div>

      <MemoryCard issueKey={issueKey} repoId={repoId} />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'review' && <ReviewTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'followups' && <FollowupsTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'jira' && <JiraTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'pr' && <PrTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'git' && <GitTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'files' && <FilesTab issueKey={issueKey} repoId={repoId} />}
      {tab === 'logs' && <LogsTab issueKey={issueKey} repoId={repoId} />}
    </>
  );
}

interface TabProps {
  issueKey: string;
  repoId: string;
}

/* -------------------------------- Memory -------------------------------- */

const MEMORY_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: 'global', types: ['global_rule'] },
  { label: 'project', types: ['project_rule'] },
  { label: 'repo', types: ['repo_rule'] },
  { label: 'decisions', types: ['decision'] },
  { label: 'lessons', types: ['lesson', 'bugfix_analysis'] },
  { label: 'exceptions', types: ['accepted_exception', 'false_positive'] },
];

function MemoryCard({ issueKey, repoId }: TabProps) {
  const [reload, setReload] = useState(0);
  const ctx = useAsync(() => api.memoryContext(issueKey, repoId), [issueKey, repoId, reload]);
  const [showCtx, setShowCtx] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const stream = useJobStream(jobId);
  const [toast, setToast] = useState<string | null>(null);
  const running = Boolean(jobId) && !stream.finished;

  useEffect(() => {
    if (stream.finished) setReload((n) => n + 1);
  }, [stream.finished]);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  }

  async function start(fn: () => Promise<Job>) {
    try {
      const j = await fn();
      setJobId(j.id);
    } catch (e) {
      const er = e as ApiError;
      flash(er.status === 409 ? `Already running: ${er.message}` : er.message);
    }
  }

  const used: MemoryUsedItem[] = ctx.data?.used?.items ?? [];
  const counts = MEMORY_GROUPS.map((g) => ({
    label: g.label,
    n: used.filter((u) => g.types.includes(u.type)).length,
  })).filter((c) => c.n > 0);

  return (
    <div className="card">
      <div className="section-title">
        <h2 style={{ margin: 0 }}>Memory</h2>
        <div className="row">
          <button
            className="btn sm"
            disabled={running}
            title="Ask Claude to draft memory proposals from this review/follow-up (saved as pending)"
            onClick={() => start(() => api.memoryPropose({ issueKey, repoId }))}
          >
            Generate memory proposal
          </button>
          <button
            className="btn sm"
            disabled={running}
            title="Analyze this issue as a post-review bugfix and draft lessons"
            onClick={() => start(() => api.learnBugfix({ issueKey, repoId }))}
          >
            Analyze as bugfix
          </button>
          <button
            className="btn sm ghost"
            disabled={!ctx.data?.md}
            onClick={() => setShowCtx((v) => !v)}
          >
            {showCtx ? 'Hide memory context' : 'Open memory context'}
          </button>
          <Link className="btn sm ghost" to="/memory">
            Memory page →
          </Link>
        </div>
      </div>

      <div className="row" style={{ marginTop: 8, fontSize: 13 }}>
        {ctx.loading && <span className="faint">Loading…</span>}
        {!ctx.loading && used.length > 0 && (
          <span className="muted">
            Memory used in this review:{' '}
            {counts.map((c, i) => (
              <span key={c.label}>
                {i > 0 && ' · '}
                {c.label}: <b>{c.n}</b>
              </span>
            ))}
          </span>
        )}
        {!ctx.loading && used.length === 0 && (
          <span className="faint">
            No memory was used in the last run
            {ctx.data?.md ? '' : ' (run a review to attach memory context)'}.
          </span>
        )}
      </div>

      {showCtx && ctx.data?.md && (
        <div style={{ marginTop: 12 }}>
          <Markdown>{ctx.data.md}</Markdown>
        </div>
      )}

      {jobId && (
        <div style={{ marginTop: 12 }}>
          <LogPanel lines={stream.logs} stage={!stream.finished ? stream.stage : null} height={220} />
          {stream.finished && (
            <div className="muted" style={{ marginTop: 8 }}>
              Job finished with status <b>{stream.job?.status}</b>
              {stream.job?.status === 'success' && (
                <>
                  {' '}
                  — review pending proposals on the{' '}
                  <Link to="/memory">Memory page</Link>.
                </>
              )}
            </div>
          )}
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </div>
  );
}

/* -------------------------------- Review -------------------------------- */

function ReviewTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(() => api.review(issueKey, repoId), [issueKey, repoId]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (!data?.md) return <Empty msg="No review yet. Run an initial review from the Dashboard." />;
  const json = data.json as { bitbucketComment?: string } | null;
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>review.md</h2>
        <div className="row">
          <CopyButton text={json?.bitbucketComment} label="Copy Bitbucket comment" />
          <CopyButton text={data.md} label="Copy full review" />
        </div>
      </div>
      <Markdown>{data.md}</Markdown>
    </div>
  );
}

/* ------------------------------- Follow-ups ------------------------------ */

function FollowupsTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(() => api.followups(issueKey, repoId), [issueKey, repoId]);
  const [selected, setSelected] = useState<string | null>(null);

  const sel = useAsync(async () => {
    if (!selected) return null;
    const md = await api.file(issueKey, repoId, `followups/${selected}/followup.md`);
    const json = await readJson(issueKey, repoId, `followups/${selected}/followup.json`).catch(() => null);
    return { md: md.content, json };
  }, [issueKey, repoId, selected]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (!data || (data.runs.length === 0 && !data.latestMd))
    return <Empty msg="No follow-ups yet. Run a follow-up from the Dashboard." />;

  const latestJson = data.latestJson as { bitbucketComment?: string } | null;
  const showMd = sel.data?.md ?? data.latestMd ?? '';
  const showComment =
    (sel.data?.json as { bitbucketComment?: string } | null)?.bitbucketComment ??
    latestJson?.bitbucketComment;

  return (
    <>
      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>Follow-up runs</h2>
          <span className="faint">{data.runs.length} run(s)</span>
        </div>
        <div className="scroll-x" style={{ marginTop: 10 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Verdict</th>
                <th>Prev HEAD</th>
                <th>Curr HEAD</th>
                <th>Summary</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.timestamp}>
                  <td className="mono nowrap">{r.timestamp}</td>
                  <td>
                    <VerdictBadge verdict={r.verdict} />
                  </td>
                  <td className="mono faint">{r.previousHead?.slice(0, 10) ?? '—'}</td>
                  <td className="mono faint">{r.currentHead?.slice(0, 10) ?? '—'}</td>
                  <td style={{ maxWidth: 360 }} className="faint">
                    {r.summary?.slice(0, 120) ?? ''}
                  </td>
                  <td>
                    <button
                      className={`btn sm ${selected === r.timestamp ? 'primary' : ''}`}
                      onClick={() => setSelected(r.timestamp)}
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            {selected ? `followups/${selected}/followup.md` : 'latest-followup.md'}
          </h2>
          <div className="row">
            <CopyButton text={showComment} label="Copy Bitbucket comment" />
            <CopyButton text={showMd} label="Copy full follow-up" />
          </div>
        </div>
        {showMd ? <Markdown>{showMd}</Markdown> : <Empty msg="No follow-up content." />}
      </div>
    </>
  );
}

/* --------------------------------- Jira --------------------------------- */

function JiraTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(
    () => readJson(issueKey, repoId, 'jira.json'),
    [issueKey, repoId],
  );
  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  const n = (data as { normalized?: any })?.normalized;
  if (!n) return <Empty msg="No jira.json found." />;
  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{n.key}</h2>
        {n.url && (
          <a className="btn sm" href={n.url} target="_blank" rel="noreferrer">
            Open in Jira ↗
          </a>
        )}
      </div>
      <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>Summary</dt>
        <dd>{n.summary}</dd>
        <dt>Status</dt>
        <dd>{n.status}</dd>
        <dt>Type</dt>
        <dd>{n.issuetype ?? '—'}</dd>
        <dt>Priority</dt>
        <dd>{n.priority ?? '—'}</dd>
        <dt>Assignee</dt>
        <dd>{n.assignee ?? '—'}</dd>
        <dt>Reporter</dt>
        <dd>{n.reporter ?? '—'}</dd>
        {n.labels?.length > 0 && (
          <>
            <dt>Labels</dt>
            <dd>{n.labels.join(', ')}</dd>
          </>
        )}
        {n.components?.length > 0 && (
          <>
            <dt>Components</dt>
            <dd>{n.components.join(', ')}</dd>
          </>
        )}
      </dl>

      <h3>Description</h3>
      {n.descriptionText ? (
        <pre className="codeblock" style={{ whiteSpace: 'pre-wrap' }}>
          {n.descriptionText}
        </pre>
      ) : (
        <p className="faint">No description.</p>
      )}

      <h3>Comments ({n.comments?.length ?? 0})</h3>
      {(n.comments ?? []).map((c: any, i: number) => (
        <div key={i} className="card" style={{ background: 'var(--bg)', marginBottom: 8 }}>
          <div className="faint" style={{ fontSize: 12, marginBottom: 4 }}>
            {c.author} · {c.created ? new Date(c.created).toLocaleString() : ''}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
        </div>
      ))}
      {(!n.comments || n.comments.length === 0) && <p className="faint">No comments.</p>}
    </div>
  );
}

/* ---------------------------------- PR ---------------------------------- */

function PrTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(
    () => readJson(issueKey, repoId, 'pr.json'),
    [issueKey, repoId],
  );
  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  const pr = data as any;
  if (!pr) return <Empty msg="No pr.json found." />;
  return (
    <div className="card">
      <h2>Pull request</h2>
      {pr.searchError && (
        <div className="banner warn">
          PR lookup error: {pr.searchError.status ? `[${pr.searchError.status}] ` : ''}
          {pr.searchError.message}
        </div>
      )}
      <dl className="kv">
        <dt>Provider</dt>
        <dd>{pr.provider}</dd>
        <dt>PR found</dt>
        <dd>{pr.prFound ? 'yes' : 'no'}</dd>
        <dt>Workspace</dt>
        <dd>{pr.workspace ?? '—'}</dd>
        <dt>Repo slug</dt>
        <dd>{pr.repoSlug ?? '—'}</dd>
        {pr.prFound && (
          <>
            <dt>PR id</dt>
            <dd>#{String(pr.id)}</dd>
            <dt>Title</dt>
            <dd>{pr.title}</dd>
            <dt>State</dt>
            <dd>{pr.state}</dd>
            <dt>Source</dt>
            <dd>{pr.sourceBranch}</dd>
            <dt>Target</dt>
            <dd>{pr.targetBranch}</dd>
            <dt>Source commit</dt>
            <dd>{pr.sourceCommit}</dd>
            <dt>Author</dt>
            <dd>{pr.author ?? '—'}</dd>
            <dt>Reviewers</dt>
            <dd>{(pr.reviewers ?? []).join(', ') || '—'}</dd>
            <dt>Comments</dt>
            <dd>{pr.commentsCount ?? 0}</dd>
            <dt>Commits</dt>
            <dd>{pr.commitsCount ?? 0}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/* ---------------------------------- Git --------------------------------- */

function GitTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(
    () => readJson(issueKey, repoId, 'git-meta.json'),
    [issueKey, repoId],
  );
  const [showDiff, setShowDiff] = useState(false);
  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  const g = data as any;
  if (!g) return <Empty msg="No git-meta.json found." />;
  return (
    <div className="card">
      <h2>Git metadata</h2>
      <dl className="kv">
        <dt>Branch</dt>
        <dd>{g.branch}</dd>
        <dt>Base branch</dt>
        <dd>{g.baseBranch}</dd>
        <dt>HEAD</dt>
        <dd>{g.head}</dd>
        <dt>Last commit</dt>
        <dd>{g.subject || g.lastCommit}</dd>
        <dt>Changed files</dt>
        <dd>{g.changedFiles?.length ?? 0}</dd>
      </dl>
      {g.diffError && <div className="banner error" style={{ marginTop: 10 }}>{g.diffError}</div>}

      {g.diffStat && (
        <>
          <h3>Diff stat</h3>
          <pre className="codeblock">{g.diffStat}</pre>
        </>
      )}

      <h3>Changed files</h3>
      <pre className="codeblock">{(g.changedFiles ?? []).join('\n') || '(none)'}</pre>

      <div style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => setShowDiff((v) => !v)}>
          {showDiff ? 'Hide diff.patch' : 'View diff.patch'}
        </button>
      </div>
      {showDiff && (
        <div style={{ marginTop: 12 }}>
          <FileViewer issueKey={issueKey} repoId={repoId} path="diff.patch" size={0} />
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Files -------------------------------- */

function FilesTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(() => api.files(issueKey, repoId), [issueKey, repoId]);
  const [selected, setSelected] = useState<OutputFileEntry | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  const files = data ?? [];
  if (files.length === 0) return <Empty msg="No output files yet." />;
  return (
    <div className="card">
      <div className="grid2" style={{ gridTemplateColumns: '280px 1fr' }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Files</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {files.map((f) => (
              <button
                key={f.path}
                className={`btn sm ghost ${selected?.path === f.path ? 'primary' : ''}`}
                style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                onClick={() => setSelected(f)}
                title={f.path}
              >
                <span className="mono" style={{ fontSize: 12 }}>
                  {f.path}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div>
          {selected ? (
            <FileViewer issueKey={issueKey} repoId={repoId} path={selected.path} size={selected.size} />
          ) : (
            <p className="faint">Select a file to view.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Logs --------------------------------- */

function LogsTab({ issueKey, repoId }: TabProps) {
  const { data, error, loading } = useAsync(() => api.jobs(), [issueKey, repoId]);
  const jobsForIssue = useMemo(
    () => (data ?? []).filter((j) => j.issueKey === issueKey && j.repoId === repoId),
    [data, issueKey, repoId],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId ?? jobsForIssue[0]?.id ?? null;
  const stream = useJobStream(activeId);

  if (loading) return <Loading />;
  if (error) return <ErrorBox msg={error} />;
  if (jobsForIssue.length === 0)
    return <Empty msg="No jobs for this issue+repo in this session. Run something from the Dashboard." />;

  return (
    <div className="card">
      <div className="section-title" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Jobs (this session)</h2>
      </div>
      <div className="scroll-x" style={{ marginBottom: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Job</th>
              <th>Type</th>
              <th>Status</th>
              <th>Verdict</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobsForIssue.map((j: Job) => (
              <tr key={j.id}>
                <td className="mono">{j.id}</td>
                <td>{j.type}</td>
                <td>
                  <JobStatusBadge status={j.status} />
                </td>
                <td>{j.verdict ? <VerdictBadge verdict={j.verdict} /> : '—'}</td>
                <td>
                  <button
                    className={`btn sm ${activeId === j.id ? 'primary' : ''}`}
                    onClick={() => setSelectedId(j.id)}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LogPanel lines={stream.logs} />
    </div>
  );
}

/* ------------------------------- shared UI ------------------------------ */

function Loading() {
  return (
    <div className="card muted">
      <span className="spin" /> Loading…
    </div>
  );
}
function ErrorBox({ msg }: { msg: string }) {
  return <div className="banner error">{msg}</div>;
}
function Empty({ msg }: { msg: string }) {
  return <div className="card faint">{msg}</div>;
}
