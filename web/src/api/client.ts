import type {
  ClaudeSessionInfo,
  CloneCommand,
  ConfigStatus,
  FollowupListing,
  HistoryItem,
  JiraSearchResponse,
  Job,
  JobLogLine,
  MemoryContextInfo,
  MemoryIndexItem,
  MemoryItemDetail,
  OutputFileEntry,
  OutputSummary,
  RepoRow,
  RepoStatus,
  ResolveOutcome,
  SavedJqlQuery,
} from './types';

/** Thrown for non-2xx responses; carries the parsed `{ error }` message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (data && typeof data === 'object' && 'error' in data) {
      msg = String((data as { error: unknown }).error);
    }
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const enc = encodeURIComponent;

export const api = {
  health: () => req<{ ok: boolean; readOnly: boolean }>('/health'),
  configStatus: () => req<ConfigStatus>('/config/status'),
  repos: () => req<{ repos: RepoRow[] }>('/repos').then((r) => r.repos),
  history: () => req<{ items: HistoryItem[] }>('/history').then((r) => r.items),

  resolve: (issueKey: string, repo?: string, allowUnmapped?: boolean) => {
    const qs = new URLSearchParams({ issueKey });
    if (repo) qs.set('repo', repo);
    if (allowUnmapped) qs.set('allowUnmapped', 'true');
    return req<ResolveOutcome>(`/resolve?${qs.toString()}`);
  },

  syncRepo: (repoId: string) => req<Job>(`/repos/${enc(repoId)}/sync`, { method: 'POST' }),

  repoStatus: (repoId: string) => req<RepoStatus>(`/repos/${enc(repoId)}/status`),
  cloneCommand: (repoId: string, useUsername = true) =>
    req<CloneCommand>(`/repos/${enc(repoId)}/clone-command?useUsername=${useUsername ? 'true' : 'false'}`),
  cloneRepo: (repoId: string, useUsername = true) =>
    req<Job>(`/repos/${enc(repoId)}/clone`, {
      method: 'POST',
      body: JSON.stringify({ useUsername }),
    }),
  removeLocalRepo: (repoId: string, force = false) =>
    req<{ removed: boolean; path: string; reason?: string }>(`/repos/${enc(repoId)}/local`, {
      method: 'DELETE',
      body: JSON.stringify({ force }),
    }),

  runReview: (body: { issueKey: string; repoId?: string; allowUnmapped?: boolean; sync?: boolean }) =>
    req<Job>('/reviews/run', { method: 'POST', body: JSON.stringify(body) }),

  runFollowup: (body: {
    issueKey: string;
    repoId?: string;
    allowUnmapped?: boolean;
    fromHead?: string;
    previous?: string;
    sync?: boolean;
    resume?: boolean;
    resumeSession?: string;
  }) => req<Job>('/reviews/followup', { method: 'POST', body: JSON.stringify(body) }),

  clean: (body: { issueKey: string; repoId?: string }) =>
    req<Job>('/reviews/clean', { method: 'POST', body: JSON.stringify(body) }),

  jobs: () => req<{ jobs: Job[] }>('/jobs').then((r) => r.jobs),
  job: (id: string) => req<Job>(`/jobs/${enc(id)}`),
  claudeSession: (issueKey: string, repoId: string) =>
    req<ClaudeSessionInfo>(`/issues/${enc(issueKey)}/${enc(repoId)}/claude-session`),

  summary: (issueKey: string, repoId: string) =>
    req<OutputSummary>(`/issues/${enc(issueKey)}/${enc(repoId)}/summary`),
  files: (issueKey: string, repoId: string) =>
    req<{ files: OutputFileEntry[] }>(`/issues/${enc(issueKey)}/${enc(repoId)}/files`).then(
      (r) => r.files,
    ),
  file: (issueKey: string, repoId: string, p: string) =>
    req<{ path: string; size: number; truncated: boolean; content: string }>(
      `/issues/${enc(issueKey)}/${enc(repoId)}/file?path=${enc(p)}`,
    ),
  review: (issueKey: string, repoId: string) =>
    req<{ md: string | null; json: unknown | null }>(
      `/issues/${enc(issueKey)}/${enc(repoId)}/review`,
    ),
  followups: (issueKey: string, repoId: string) =>
    req<FollowupListing>(`/issues/${enc(issueKey)}/${enc(repoId)}/followups`),

  /* ------------------------------- memory ------------------------------- */
  memoryList: (filters: { project?: string; repo?: string; type?: string; status?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return req<{ items: MemoryIndexItem[]; warnings: string[] }>(`/memory${suffix}`);
  },
  memorySearch: (q: string) =>
    req<{ items: MemoryIndexItem[] }>(`/memory/search?q=${enc(q)}`).then((r) => r.items),
  memoryGet: (id: string) => req<MemoryItemDetail>(`/memory/${enc(id)}`),
  memoryReindex: () => req<{ count: number }>('/memory/reindex', { method: 'POST' }),
  memoryApprove: (id: string) =>
    req<{ id: string; path: string }>(`/memory/${enc(id)}/approve`, { method: 'POST' }),
  memoryReject: (id: string) =>
    req<{ id: string; path: string }>(`/memory/${enc(id)}/reject`, { method: 'POST' }),
  memoryDeprecate: (id: string) =>
    req<{ id: string; path: string }>(`/memory/${enc(id)}/deprecate`, { method: 'POST' }),
  memoryPropose: (body: { issueKey: string; repoId?: string }) =>
    req<Job>('/memory/propose', { method: 'POST', body: JSON.stringify(body) }),
  learnBugfix: (body: { issueKey: string; repoId?: string }) =>
    req<Job>('/learn/bugfix', { method: 'POST', body: JSON.stringify(body) }),
  memoryContext: (issueKey: string, repoId: string) =>
    req<MemoryContextInfo>(`/issues/${enc(issueKey)}/${enc(repoId)}/memory-context`),

  /* ------------------------------ jql queue ----------------------------- */
  jqlQueries: () => req<{ queries: SavedJqlQuery[] }>('/jql/queries').then((r) => r.queries),
  createJqlQuery: (body: { name: string; jql: string }) =>
    req<SavedJqlQuery>('/jql/queries', { method: 'POST', body: JSON.stringify(body) }),
  updateJqlQuery: (id: string, body: { name?: string; jql?: string }) =>
    req<SavedJqlQuery>(`/jql/queries/${enc(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteJqlQuery: (id: string) =>
    req<{ deleted: boolean }>(`/jql/queries/${enc(id)}`, { method: 'DELETE' }),
  jqlSearch: (body: { jql: string; maxResults?: number }) =>
    req<JiraSearchResponse>('/jql/search', { method: 'POST', body: JSON.stringify(body) }),
};

export interface JobStreamHandlers {
  onLog?: (line: JobLogLine) => void;
  onStatus?: (job: Job) => void;
  onStage?: (stage: string) => void;
  onDone?: (info: { jobId: string; status: string; verdict: string | null }) => void;
  /** Network error (EventSource) — `serverError` carries a job failure message. */
  onError?: () => void;
  onServerError?: (info: { jobId: string; error: string }) => void;
}

/**
 * Subscribe to a job's Server-Sent Events. Returns an unsubscribe function.
 * Replays the backlog of logs, then streams live ones until the job finishes.
 */
export function streamJob(jobId: string, handlers: JobStreamHandlers): () => void {
  const es = new EventSource(`/api/jobs/${enc(jobId)}/events`);
  es.addEventListener('log', (e) => {
    try {
      const { line } = JSON.parse((e as MessageEvent).data);
      handlers.onLog?.(line);
    } catch {
      /* ignore malformed frame */
    }
  });
  es.addEventListener('status', (e) => {
    try {
      handlers.onStatus?.(JSON.parse((e as MessageEvent).data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('stage', (e) => {
    try {
      handlers.onStage?.(JSON.parse((e as MessageEvent).data).stage);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('error', (e) => {
    // Server-sent job-failure frame (has data); network errors have none.
    const data = (e as MessageEvent).data;
    if (!data) return;
    try {
      handlers.onServerError?.(JSON.parse(data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('done', (e) => {
    try {
      handlers.onDone?.(JSON.parse((e as MessageEvent).data));
    } finally {
      es.close();
    }
  });
  es.onerror = () => handlers.onError?.();
  return () => es.close();
}
