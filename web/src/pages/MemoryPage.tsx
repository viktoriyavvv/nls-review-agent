import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MemoryIndexItem, MemoryItemDetail, MemoryStatus, MemoryType } from '../api/types';
import { Markdown } from '../components/Markdown';
import { CopyButton } from '../components/CopyButton';

type TabId = 'approved' | 'pending' | 'rejected' | 'global' | 'projects' | 'repos' | 'lessons';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'approved', label: 'Approved' },
  { id: 'pending', label: 'Pending proposals' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'global', label: 'Global' },
  { id: 'projects', label: 'Projects' },
  { id: 'repos', label: 'Repos' },
  { id: 'lessons', label: 'Lessons' },
];

const LESSON_TYPES: MemoryType[] = ['lesson', 'accepted_exception', 'false_positive', 'bugfix_analysis'];

function inTab(it: MemoryIndexItem, tab: TabId): boolean {
  switch (tab) {
    case 'approved':
      return it.status === 'approved';
    case 'pending':
      return it.status === 'proposed' || it.status === 'draft';
    case 'rejected':
      return it.status === 'rejected' || it.status === 'deprecated';
    case 'global':
      return it.type === 'global_rule';
    case 'projects':
      return it.type === 'project_rule';
    case 'repos':
      return it.type === 'repo_rule';
    case 'lessons':
      return LESSON_TYPES.includes(it.type);
  }
}

function StatusBadge({ status }: { status: MemoryStatus }) {
  const color =
    status === 'approved' ? 'green' : status === 'proposed' || status === 'draft' ? 'yellow' : status === 'rejected' ? 'red' : 'gray';
  return <span className={`badge ${color}`}>{status}</span>;
}

function ConfBadge({ c }: { c: string }) {
  const color = c === 'high' ? 'green' : c === 'medium' ? 'yellow' : 'gray';
  return <span className={`badge ${color}`}>{c}</span>;
}

function appliesTo(it: MemoryIndexItem): string {
  const parts: string[] = [];
  if (it.projects.length) parts.push(`proj: ${it.projects.join(', ')}`);
  if (it.repos.length) parts.push(`repo: ${it.repos.length === 1 ? it.repos[0] : `${it.repos.length} repos`}`);
  if (it.issueKeys.length) parts.push(it.issueKeys.join(', '));
  return parts.join(' · ') || 'global';
}

export function MemoryPage() {
  const [items, setItems] = useState<MemoryIndexItem[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [tab, setTab] = useState<TabId>('approved');
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<MemoryIndexItem[] | null>(null);
  const [fProject, setFProject] = useState('');
  const [fRepo, setFRepo] = useState('');
  const [fType, setFType] = useState('');
  const [fConf, setFConf] = useState('');
  const [selected, setSelected] = useState<MemoryItemDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function flash(m: string) {
    setToast(m);
    setTimeout(() => setToast(null), 4000);
  }

  function load() {
    setErr(null);
    api
      .memoryList()
      .then((r) => {
        setItems(r.items);
        setWarnings(r.warnings ?? []);
      })
      .catch((e) => setErr(String((e as Error).message ?? e)));
  }
  useEffect(load, []);

  // Server-side search (covers markdown bodies), debounced.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchHits(null);
      return;
    }
    const t = setTimeout(() => {
      api
        .memorySearch(q)
        .then(setSearchHits)
        .catch(() => setSearchHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const projects = useMemo(
    () => [...new Set((items ?? []).flatMap((i) => i.projects))].sort(),
    [items],
  );
  const repos = useMemo(() => [...new Set((items ?? []).flatMap((i) => i.repos))].sort(), [items]);

  const visible = useMemo(() => {
    let list = searchHits ?? items ?? [];
    list = list.filter((it) => inTab(it, tab));
    if (fProject) list = list.filter((it) => it.projects.includes(fProject));
    if (fRepo) list = list.filter((it) => it.repos.includes(fRepo));
    if (fType) list = list.filter((it) => it.type === fType);
    if (fConf) list = list.filter((it) => it.confidence === fConf);
    return list;
  }, [items, searchHits, tab, fProject, fRepo, fType, fConf]);

  const pendingCount = (items ?? []).filter((i) => inTab(i, 'pending')).length;

  async function open(id: string) {
    try {
      setSelected(await api.memoryGet(id));
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  async function act(label: string, fn: () => Promise<unknown>, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await fn();
      flash(`${label}: done`);
      load();
      if (selected) {
        api.memoryGet(selected.item.id).then(setSelected).catch(() => setSelected(null));
      }
    } catch (e) {
      flash((e as ApiError).message);
    }
  }

  const approve = (id: string) => act('Approve', () => api.memoryApprove(id));
  const reject = (id: string) =>
    act('Reject', () => api.memoryReject(id), `Reject proposal "${id}"?`);
  const deprecate = (id: string) =>
    act('Deprecate', () => api.memoryDeprecate(id), `Deprecate "${id}"? It will stop participating in reviews.`);

  return (
    <>
      <div className="banner info">
        Review Memory Engine: local markdown memory used as extra review context. Generated
        proposals are <b>pending</b> until you approve them — only <b>approved</b> items reach the
        review prompt.
      </div>

      <div className="card">
        <div className="section-title">
          <h2 style={{ margin: 0 }}>
            Memory{' '}
            {pendingCount > 0 && (
              <span className="badge yellow" style={{ marginLeft: 8 }}>
                {pendingCount} pending
              </span>
            )}
          </h2>
          <div className="row">
            <button
              className="btn sm"
              onClick={() => act('Reindex', () => api.memoryReindex())}
              title="Rebuild memory/index.json"
            >
              Reindex
            </button>
            <button className="btn sm" onClick={load}>
              Refresh
            </button>
          </div>
        </div>

        {err && <div className="banner error" style={{ marginTop: 10 }}>{err}</div>}
        {warnings.map((w) => (
          <div key={w} className="banner warn" style={{ marginTop: 10 }}>
            {w}
          </div>
        ))}

        <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label className="field" style={{ flex: '1 1 260px' }}>
            Search memory…
            <input
              type="text"
              placeholder="id, title, tag or text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="field">
            Project
            <select value={fProject} onChange={(e) => setFProject(e.target.value)}>
              <option value="">— all —</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Repo
            <select value={fRepo} onChange={(e) => setFRepo(e.target.value)}>
              <option value="">— all —</option>
              {repos.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Type
            <select value={fType} onChange={(e) => setFType(e.target.value)}>
              <option value="">— all —</option>
              {['global_rule', 'project_rule', 'repo_rule', 'decision', 'lesson', 'accepted_exception', 'false_positive', 'bugfix_analysis'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            Confidence
            <select value={fConf} onChange={(e) => setFConf(e.target.value)}>
              <option value="">— all —</option>
              <option>high</option>
              <option>medium</option>
              <option>low</option>
            </select>
          </label>
        </div>

        <div className="tabs" style={{ marginTop: 14 }}>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          ))}
        </div>

        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Applies to</th>
                <th>Tags</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((it) => (
                <tr key={it.id}>
                  <td className="mono nowrap" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.title}>
                    <a
                      href="#view"
                      onClick={(e) => {
                        e.preventDefault();
                        open(it.id);
                      }}
                    >
                      {it.id}
                    </a>
                  </td>
                  <td className="nowrap faint">{it.type}</td>
                  <td>
                    <StatusBadge status={it.status} />
                  </td>
                  <td>
                    <ConfBadge c={it.confidence} />
                  </td>
                  <td className="faint" style={{ maxWidth: 220 }}>
                    {appliesTo(it)}
                  </td>
                  <td className="faint" style={{ maxWidth: 220 }}>
                    {it.tags.slice(0, 5).join(', ')}
                    {it.tags.length > 5 ? '…' : ''}
                  </td>
                  <td className="faint nowrap">
                    {it.updatedAt ? new Date(it.updatedAt).toLocaleDateString() : '—'}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <button className="btn sm" onClick={() => open(it.id)}>
                        Open
                      </button>
                      {(it.status === 'proposed' || it.status === 'draft') && (
                        <>
                          <button className="btn sm primary" onClick={() => approve(it.id)}>
                            Approve
                          </button>
                          <button className="btn sm ghost" onClick={() => reject(it.id)}>
                            Reject
                          </button>
                        </>
                      )}
                      {it.status === 'approved' && (
                        <>
                          <button
                            className="btn sm ghost"
                            title="Search related memory by this item's first tag"
                            onClick={() => setQuery(it.tags[0] ?? it.id)}
                          >
                            Related
                          </button>
                          {it.id !== 'global-review-principles' && (
                            <button className="btn sm ghost" onClick={() => deprecate(it.id)}>
                              Deprecate
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {items && visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    No memory items here{query ? ' (for this search)' : ''}. Run{' '}
                    <span className="mono">nls-review memory init</span> once, then generate
                    proposals from a Results page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="section-title" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }} className="mono">
              {selected.item.id}{' '}
              <StatusBadge status={selected.item.status} />
            </h2>
            <div className="row">
              <CopyButton text={selected.markdown} label="Copy" />
              {(selected.item.status === 'proposed' || selected.item.status === 'draft') && (
                <>
                  <button className="btn sm primary" onClick={() => approve(selected.item.id)}>
                    Approve
                  </button>
                  <button className="btn sm ghost" onClick={() => reject(selected.item.id)}>
                    Reject
                  </button>
                </>
              )}
              {selected.item.status === 'approved' && selected.item.id !== 'global-review-principles' && (
                <button className="btn sm ghost" onClick={() => deprecate(selected.item.id)}>
                  Deprecate
                </button>
              )}
              <button className="btn sm ghost" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>
          <div className="faint mono" style={{ fontSize: 12, marginBottom: 10 }}>
            {selected.item.path}
          </div>
          <Markdown>{selected.markdown}</Markdown>
        </div>
      )}

      {toast && <div className="toast error">{toast}</div>}
    </>
  );
}
