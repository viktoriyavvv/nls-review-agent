/**
 * Turn a JQL query into a table of issues for the "Jira JQL Queue" screen.
 *
 * Read-only: it runs one Jira search (no write actions) and then enriches each
 * issue locally — mapping it to a compact row, resolving which configured repo
 * the issue key belongs to, and reading any existing review/follow-up from
 * `outputs/`. PR lookup is intentionally NOT done per-issue on the MVP (it would
 * mean N Bitbucket requests per search); the `pr` field is left optional so it
 * can be added later.
 *
 * Pure helpers (`mapIssue`, `resolveRepoForKey`, `clampMaxResults`) and the
 * filesystem reader (`readLocalReviewState`) are exported for direct unit tests.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../../config/types';
import { parseIssueKey } from '../../config/loadConfig';
import { JiraClient, JiraSearchRaw } from '../../collectors/jira.client';
import { LATEST_FOLLOWUP_FILES, OUTPUT_FILES, outputDir } from '../../utils/paths';
import { JqlQueryError } from './jql-queries';

/** Jira fields requested for the queue table (kept lean). */
export const QUEUE_FIELDS = [
  'summary',
  'status',
  'assignee',
  'reporter',
  'priority',
  'updated',
  'created',
  'issuetype',
  'labels',
  'components',
];

export const DEFAULT_MAX_RESULTS = 100;
export const MAX_MAX_RESULTS = 200;

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
  /** Optional; not populated on the MVP (would require per-issue Bitbucket calls). */
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
  /** True when the result set was capped (total > returned). */
  truncated: boolean;
  warning?: string;
}

export type JqlSearcher = (
  jql: string,
  opts: { maxResults: number; fields: string[] },
) => Promise<JiraSearchRaw>;

/** Clamp a requested page size to [1, MAX], defaulting to DEFAULT. */
export function clampMaxResults(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(v), MAX_MAX_RESULTS);
}

/** Map a raw Jira issue to the compact row shape (no repo/local enrichment). */
export function mapIssue(
  raw: any,
  baseUrl: string,
): Omit<JiraQueueIssue, 'repoResolution' | 'localReviewState' | 'pr'> {
  const f = raw?.fields ?? {};
  const key = String(raw?.key ?? '');
  const base = (baseUrl || '').replace(/\/+$/, '');
  return {
    key,
    summary: f.summary ?? '',
    status: f.status?.name ?? undefined,
    assignee: f.assignee?.displayName ?? f.assignee?.name ?? undefined,
    reporter: f.reporter?.displayName ?? f.reporter?.name ?? undefined,
    priority: f.priority?.name ?? undefined,
    updated: f.updated ?? undefined,
    created: f.created ?? undefined,
    issueType: f.issuetype?.name ?? undefined,
    labels: Array.isArray(f.labels) ? f.labels : [],
    components: Array.isArray(f.components)
      ? f.components.map((c: any) => c?.name).filter(Boolean)
      : [],
    jiraUrl: key && base ? `${base}/browse/${key}` : '',
  };
}

/** Decide which configured repo an issue key belongs to (single/multiple/none). */
export function resolveRepoForKey(config: AppConfig, key: string): RepoResolution {
  let prefix: string;
  try {
    prefix = parseIssueKey(key).prefix;
  } catch {
    return { status: 'none', message: `Invalid issue key "${key}".` };
  }
  const matches = Object.values(config.repos).filter((r) =>
    r.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix),
  );
  if (matches.length === 1) return { status: 'single', repoId: matches[0].id };
  if (matches.length === 0) {
    return { status: 'none', message: `No repo mapped to prefix ${prefix}.` };
  }
  return {
    status: 'multiple',
    message: `Prefix ${prefix} maps to ${matches.length} repos. Choose one.`,
    candidates: matches.map((r) => ({
      repoId: r.id,
      displayName: r.bitbucket?.repoSlug ?? r.id,
      path: r.path,
    })),
  };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function mtimeIso(file: string): Promise<string | undefined> {
  try {
    return new Date((await fs.stat(file)).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/** Read any existing review/follow-up for an issue+repo from outputs/. */
export async function readLocalReviewState(
  config: AppConfig,
  issueKey: string,
  repoId: string,
): Promise<LocalReviewState> {
  const dir = outputDir(path.resolve(config.root.outputsDir), issueKey, repoId);
  const reviewFile = path.join(dir, OUTPUT_FILES.reviewJson);
  const followupFile = path.join(dir, LATEST_FOLLOWUP_FILES.json);
  const [review, followup] = await Promise.all([readJson(reviewFile), readJson(followupFile)]);
  const hasReview = review != null;
  const hasFollowup = followup != null;

  const state: LocalReviewState = {
    hasReview,
    hasFollowup,
    reviewVerdict: (review?.verdict as string) ?? undefined,
    followupVerdict: (followup?.verdict as string) ?? undefined,
  };
  const times = ((await Promise.all([mtimeIso(reviewFile), mtimeIso(followupFile)])).filter(
    Boolean,
  ) as string[]).sort();
  if (times.length) state.latestUpdatedAt = times[times.length - 1];
  if (hasReview || hasFollowup) {
    state.outputPath = path.relative(config.projectRoot, dir).split(path.sep).join('/');
  }
  return state;
}

/** Enrich one raw Jira issue with repo resolution + local review state. */
export async function enrichIssue(config: AppConfig, raw: any): Promise<JiraQueueIssue> {
  const base = mapIssue(raw, config.jira.baseUrl);
  const repoResolution = resolveRepoForKey(config, base.key);
  const issue: JiraQueueIssue = { ...base, repoResolution };
  // Local review state is only unambiguous when exactly one repo matches; for a
  // multi-repo prefix the user must pick a repo first (the GUI shows that).
  if (repoResolution.status === 'single' && repoResolution.repoId) {
    issue.localReviewState = await readLocalReviewState(config, base.key, repoResolution.repoId);
  }
  return issue;
}

function defaultSearcher(config: AppConfig): JqlSearcher {
  if (!config.jira.baseUrl || !config.jira.apiToken) {
    return () => {
      throw new JqlQueryError(
        'Jira API is not configured. Set JIRA_BASE_URL and JIRA_API_TOKEN in .env.',
        400,
      );
    };
  }
  const client = new JiraClient(config.jira);
  return (jql, opts) => client.searchIssuesByJql(jql, opts);
}

/**
 * Run a JQL search and return an enriched, table-ready response. `searcher` is
 * injectable so tests never hit the network.
 */
export async function runJqlSearch(
  config: AppConfig,
  input: { jql: string; maxResults?: number },
  searcher?: JqlSearcher,
): Promise<JiraSearchResponse> {
  const jql = (input.jql ?? '').trim();
  if (!jql) throw new JqlQueryError('JQL is required.');
  const maxResults = clampMaxResults(input.maxResults);
  const search = searcher ?? defaultSearcher(config);

  const raw = await search(jql, { maxResults, fields: QUEUE_FIELDS });
  const issues = await Promise.all((raw.issues ?? []).map((r) => enrichIssue(config, r)));
  const total = raw.total ?? issues.length;
  // Truncated when the exact total exceeds the page, or (Cloud token pagination)
  // when the API says this is not the last page.
  const hasExactTotal = total > issues.length;
  const truncated = hasExactTotal || raw.isLast === false;

  let warning: string | undefined;
  if (hasExactTotal) {
    warning = `Showing ${issues.length} of ${total} issues. Narrow the JQL or increase maxResults later.`;
  } else if (truncated) {
    warning = `Showing ${issues.length} issues; more are available. Narrow the JQL or increase maxResults later.`;
  }

  return { total, startAt: raw.startAt ?? 0, maxResults, issues, truncated, warning };
}

/**
 * Best-effort, secret-safe message for a failed Jira request. Pulls Jira's own
 * `errorMessages`/`errors` when present. Never touches request headers, so the
 * Authorization token can't leak into the response.
 */
export function jiraErrorMessage(err: unknown): string {
  const e = err as { response?: { status?: number; data?: any }; message?: string };
  const data = e.response?.data;
  if (data) {
    const msgs: string[] = [];
    if (Array.isArray(data.errorMessages)) msgs.push(...data.errorMessages.map(String));
    if (data.errors && typeof data.errors === 'object') {
      for (const [k, v] of Object.entries(data.errors)) msgs.push(`${k}: ${String(v)}`);
    }
    if (msgs.length) return msgs.join('; ');
    if (typeof data === 'string' && data.trim()) return data.slice(0, 300);
  }
  if (e.response?.status) return `Jira request failed (HTTP ${e.response.status}).`;
  return e.message || 'Jira request failed.';
}
