// Mirrors the backend response shapes (src/server/*). Kept hand-written and
// small so the web app has no build-time dependency on the server package.

export type JobType =
  | 'sync'
  | 'run-review'
  | 'run-followup'
  | 'clean'
  | 'clone'
  | 'memory-propose'
  | 'learn-bugfix';
export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type LogLevel = 'info' | 'step' | 'ok' | 'warn' | 'error' | 'debug' | 'raw' | 'claude';

export interface JobLogLine {
  ts: number;
  level: LogLevel;
  text: string;
  stage?: string;
}

export interface Job {
  id: string;
  type: JobType;
  label: string;
  issueKey?: string;
  repoId?: string;
  argv: string[];
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  verdict?: string;
  stage?: string;
  logs: JobLogLine[];
  error?: string;
}

export interface RepoRow {
  id: string;
  jiraPrefixes: string[];
  path: string;
  absPath: string;
  defaultBaseBranch: string;
  workspace?: string;
  repoSlug?: string;
  cloneUrl: string;
  exists: boolean;
  isGitRepo: boolean;
}

export interface RepoStatus {
  id: string;
  path: string;
  absPath: string;
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  head?: string;
  remoteUrl?: string;
  cloneUrl: string;
  hasUsername: boolean;
}

export interface CloneCommand {
  repoId: string;
  path: string;
  url: string;
  command: string;
  hasUsername: boolean;
}

export interface HistoryItem {
  issueKey: string;
  repoId: string;
  outputPath: string;
  latestReview?: { verdict?: string; head?: string; createdAt?: string; summary?: string };
  latestFollowup?: {
    verdict?: string;
    previousHead?: string;
    currentHead?: string;
    createdAt?: string;
    summary?: string;
  };
  pr?: {
    prFound?: boolean;
    id?: string | number | null;
    title?: string | null;
    sourceBranch?: string | null;
    targetBranch?: string | null;
  };
  filesCount: number;
  updatedAt: string;
}

export interface ClaudeSessionFile {
  issueKey: string;
  repoId: string;
  initialReviewSessionId: string | null;
  initialReviewHead: string | null;
  createdAt: string;
  updatedAt: string;
  source: string;
}

export interface FollowupClaudeSession {
  resumedClaudeSession?: boolean;
  compactBeforeFollowup?: boolean;
  initialSessionId?: string | null;
  usedSessionId?: string | null;
  resumeSource?: string;
  resumeError?: string;
}

export interface ClaudeSessionInfo {
  session: ClaudeSessionFile | null;
  followup: FollowupClaudeSession | null;
}

export interface RepoCandidate {
  id: string;
  jiraPrefixes: string[];
}

export type ResolveOutcome =
  | { ok: true; key: string; repo: RepoRow & Record<string, unknown> }
  | {
      ok: false;
      reason: 'invalid-key' | 'none' | 'multi' | 'not-found' | 'unmapped';
      message: string;
      key?: string;
      prefix?: string;
      candidates?: RepoCandidate[];
    };

/* -------------------------------- memory -------------------------------- */

export type MemoryType =
  | 'global_rule'
  | 'project_rule'
  | 'repo_rule'
  | 'decision'
  | 'lesson'
  | 'accepted_exception'
  | 'false_positive'
  | 'bugfix_analysis';

export type MemoryStatus = 'draft' | 'proposed' | 'approved' | 'rejected' | 'deprecated';
export type MemoryConfidence = 'low' | 'medium' | 'high';

export interface MemoryIndexItem {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  title: string;
  path: string;
  projects: string[];
  repos: string[];
  issueKeys: string[];
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  source?: { issueKey?: string; repoId?: string; outputPath?: string };
}

export interface MemoryItemDetail {
  item: MemoryIndexItem;
  markdown: string;
}

export interface MemoryUsedItem {
  id: string;
  type: MemoryType;
  confidence: MemoryConfidence;
  path: string;
  reason: string;
}

export interface MemoryContextInfo {
  md: string | null;
  used: { issueKey: string; repoId: string; items: MemoryUsedItem[] } | null;
}

/* ------------------------------ jql queue ------------------------------- */

export interface SavedJqlQuery {
  id: string;
  name: string;
  jql: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoResolution {
  status: 'single' | 'multiple' | 'none';
  repoId?: string;
  candidates?: Array<{ repoId: string; displayName?: string; path: string }>;
  message?: string;
}

export interface LocalReviewState {
  hasReview: boolean;
  reviewVerdict?: string;
  hasFollowup: boolean;
  followupVerdict?: string;
  latestUpdatedAt?: string;
  outputPath?: string;
}

export interface JiraQueueIssue {
  key: string;
  summary: string;
  status?: string;
  assignee?: string;
  reporter?: string;
  priority?: string;
  updated?: string;
  created?: string;
  issueType?: string;
  labels?: string[];
  components?: string[];
  jiraUrl: string;
  repoResolution: RepoResolution;
  localReviewState?: LocalReviewState;
  pr?: {
    prFound?: boolean;
    id?: string | number;
    title?: string;
    state?: string;
    sourceBranch?: string;
    targetBranch?: string;
    link?: string;
  };
}

export interface JiraSearchResponse {
  total: number;
  startAt: number;
  maxResults: number;
  issues: JiraQueueIssue[];
  truncated: boolean;
  warning?: string;
}

export interface ConfigStatus {
  jira: { baseUrl: string; email: string; apiVersion: string; hasApiToken: boolean };
  bitbucket: {
    type: string;
    workspace: string;
    baseUrl: string;
    hasUsername: boolean;
    hasToken: boolean;
  };
  claude: {
    bin: string;
    model: string;
    effort: string;
    permissionMode: string;
    outputFormat: string;
    maxTurns: number | null;
  };
  paths: { reposDir: string; worktreesDir: string; outputsDir: string; locksDir: string };
  jql: { file: string; jiraConfigured: boolean };
  env: Record<string, 'set' | 'missing'>;
  repoCount: number;
  readOnly: boolean;
}

export interface OutputSummary {
  issueKey: string;
  repoId: string;
  hasReview: boolean;
  hasFollowup: boolean;
  reviewVerdict: string | null;
  followupVerdict: string | null;
  prFound: boolean;
  prId: number | string | null;
  prTitle: string | null;
  branch: string | null;
  baseBranch: string | null;
  head: string | null;
  changedFilesCount: number | null;
}

export interface FollowupRun {
  timestamp: string;
  verdict: string | null;
  summary: string | null;
  previousHead: string | null;
  currentHead: string | null;
}

export interface FollowupListing {
  runs: FollowupRun[];
  latestMd: string | null;
  latestJson: unknown | null;
}

export interface OutputFileEntry {
  path: string;
  size: number;
}
