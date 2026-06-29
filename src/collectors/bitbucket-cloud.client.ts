import axios from 'axios';
import { BitbucketConfig } from '../config/types';
import {
  BitbucketClient,
  BitbucketRepoTarget,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetails,
  PullRequestDiffStat,
  PullRequestReviewer,
  PullRequestSearchResult,
  PullRequestSummary,
} from './bitbucket.types';

const CLOUD_API_BASE = 'https://api.bitbucket.org/2.0';
const PAGE_LEN = 50;
const MAX_PAGES = 10; // safety cap when following `next` links

/**
 * Error raised for a controlled Bitbucket Cloud API failure. Carries the HTTP
 * status (when known) and a message that NEVER contains credentials or URLs, so
 * the caller can record it in pr.json and degrade to a branch-only review.
 */
export class BitbucketApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BitbucketApiError';
    this.status = status;
  }
}

/**
 * Minimal HTTP surface the client depends on. Production uses an axios instance;
 * tests inject a fake so no network (and no real credentials) are involved.
 * Implementations MUST throw on non-2xx (axios does this by default), exposing
 * the status as `err.response.status`.
 */
export interface BitbucketHttp {
  get(
    url: string,
    config?: { params?: Record<string, unknown> },
  ): Promise<{ status: number; data: unknown }>;
}

/** Bitbucket Cloud client (REST API 2.0). Read-only. */
export class BitbucketCloudClient implements BitbucketClient {
  private http: BitbucketHttp;
  private workspaceDefault: string;

  constructor(cfg: BitbucketConfig, http?: BitbucketHttp) {
    this.workspaceDefault = (cfg.workspace ?? '').trim();
    this.http = http ?? createAxiosHttp(cfg);
  }

  async findPullRequestByIssueKey(
    params: BitbucketRepoTarget & { issueKey: string },
  ): Promise<PullRequestSearchResult> {
    const url = this.prsUrl(params);
    const key = params.issueKey.toUpperCase();

    // 1) open PR whose source branch is exactly the issue key
    let raw = await this.collect(url, {
      q: `state="OPEN" AND source.branch.name="${params.issueKey}"`,
    });
    // 2) open PR whose title contains the key
    if (raw.length === 0) {
      raw = await this.collect(url, { q: `state="OPEN" AND title~"${key}"` });
    }
    // 3) open PR whose description contains the key
    if (raw.length === 0) {
      raw = await this.collect(url, { q: `state="OPEN" AND description~"${key}"` });
    }
    // 4) final fallback: scan recent open PRs and match locally (catches
    //    branches like "feature/SC-3574" that the exact match in (1) misses).
    if (raw.length === 0) {
      raw = await this.collect(url, { q: `state="OPEN"`, sort: '-updated_on' });
    }

    const candidates = raw.map(mapCloudPr).filter((pr) => prMatchesIssue(pr, key));
    return { candidates };
  }

  async getPullRequest(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestDetails> {
    const data = (await this.getJson(`${this.prsUrl(params)}/${params.prId}`)) as Record<
      string,
      any
    >;
    const summary = mapCloudPr(data);
    return { ...summary, reviewers: mapReviewers(data) };
  }

  async getPullRequestComments(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestComment[]> {
    const raw = await this.collect(`${this.prsUrl(params)}/${params.prId}/comments`);
    return raw
      .filter((c: any) => !c.deleted)
      .map((c: any): PullRequestComment => ({
        id: c.id,
        parentId: c.parent?.id,
        author: c.user?.display_name ?? c.user?.nickname ?? 'unknown',
        text: c.content?.raw ?? '',
        createdAt: c.created_on,
        createdOn: c.created_on,
        updatedOn: c.updated_on,
        deleted: !!c.deleted,
        inline: c.inline
          ? { path: c.inline.path, from: c.inline.from, to: c.inline.to }
          : undefined,
        links: c.links?.html?.href ? { html: c.links.html.href } : undefined,
        raw: c,
      }));
  }

  async getPullRequestCommits(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestCommit[]> {
    const raw = await this.collect(`${this.prsUrl(params)}/${params.prId}/commits`);
    return raw.map((c: any) => ({
      id: c.hash,
      message: c.message ?? '',
      author: c.author?.user?.display_name ?? authorFromRaw(c.author?.raw),
      authorTimestamp: toMs(c.date),
    }));
  }

  async getPullRequestDiffStat(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestDiffStat[]> {
    const raw = await this.collect(`${this.prsUrl(params)}/${params.prId}/diffstat`);
    return raw.map((d: any) => ({
      path: d.new?.path ?? d.old?.path ?? '',
      type: String(d.status ?? 'modified').toUpperCase(),
    }));
  }

  /* ----------------------------- internals ----------------------------- */

  private resolveWorkspace(target: BitbucketRepoTarget): string {
    const ws = (target.workspace || this.workspaceDefault || '').trim();
    if (!ws) {
      throw new BitbucketApiError(
        'Bitbucket Cloud workspace is not configured. Set bitbucket.workspace ' +
          '(or repos.<id>.bitbucket.workspace) in config/repos.yml.',
      );
    }
    return ws;
  }

  private prsUrl(target: BitbucketRepoTarget): string {
    const ws = this.resolveWorkspace(target);
    return `${CLOUD_API_BASE}/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(
      target.repoSlug,
    )}/pullrequests`;
  }

  private async getJson(url: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      const res = await this.http.get(url, params ? { params } : undefined);
      return res.data;
    } catch (err) {
      throw toApiError(err);
    }
  }

  /** Follow `next` links and collect `values` across pages (bounded). */
  private async collect(url: string, params?: Record<string, unknown>): Promise<any[]> {
    const values: any[] = [];
    let nextUrl: string | undefined = url;
    let nextParams: Record<string, unknown> | undefined = { pagelen: PAGE_LEN, ...params };
    for (let page = 0; page < MAX_PAGES && nextUrl; page += 1) {
      const data = (await this.getJson(nextUrl, nextParams)) as { values?: any[]; next?: string };
      values.push(...(data.values ?? []));
      nextUrl = data.next; // `next` is a fully-formed URL that re-encodes the query
      nextParams = undefined;
    }
    return values;
  }
}

/* ------------------------------- helpers ------------------------------- */

function createAxiosHttp(cfg: BitbucketConfig): BitbucketHttp {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.username && cfg.token) {
    const basic = Buffer.from(`${cfg.username}:${cfg.token}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  const instance = axios.create({ headers, timeout: 30000 });
  return { get: (url, config) => instance.get(url, config) };
}

/** Map any thrown HTTP error to a credential-free BitbucketApiError. */
function toApiError(err: unknown): BitbucketApiError {
  if (err instanceof BitbucketApiError) return err;
  const status = (err as any)?.response?.status as number | undefined;
  return new BitbucketApiError(describeStatus(status), status);
}

function describeStatus(status?: number): string {
  if (status === 401 || status === 403) return 'Bitbucket Cloud authentication failed';
  if (status === 404) return 'Bitbucket Cloud resource not found (404)';
  if (status != null) return `Bitbucket Cloud API error (${status})`;
  return 'Bitbucket Cloud request failed (network/unreachable)';
}

function mapCloudPr(d: any): PullRequestSummary {
  return {
    id: d.id,
    title: d.title ?? '',
    state: d.state ?? 'UNKNOWN', // OPEN | MERGED | DECLINED | SUPERSEDED
    description: typeof d.description === 'string' ? d.description : d.summary?.raw,
    fromRef: { branch: d.source?.branch?.name ?? '', latestCommit: d.source?.commit?.hash },
    toRef: { branch: d.destination?.branch?.name ?? '' },
    author: d.author?.display_name ?? d.author?.nickname,
    url: d.links?.html?.href,
    createdDate: toMs(d.created_on),
    updatedDate: toMs(d.updated_on),
    raw: d,
  };
}

function mapReviewers(d: any): PullRequestReviewer[] {
  const participants = Array.isArray(d.participants) ? d.participants : [];
  const reviewers: PullRequestReviewer[] = participants
    .filter((p: any) => p.role === 'REVIEWER')
    .map((p: any) => ({
      name: p.user?.display_name ?? p.user?.nickname ?? 'unknown',
      approved: !!p.approved,
      status: p.state ?? (p.approved ? 'APPROVED' : 'UNAPPROVED'),
    }));
  if (reviewers.length > 0) return reviewers;
  // Fall back to the plain reviewers[] list (no approval state on Cloud here).
  const plain = Array.isArray(d.reviewers) ? d.reviewers : [];
  return plain.map((r: any) => ({
    name: r.display_name ?? r.nickname ?? 'unknown',
    approved: false,
    status: 'UNAPPROVED',
  }));
}

function prMatchesIssue(pr: PullRequestSummary, key: string): boolean {
  const branch = (pr.fromRef.branch ?? '').toUpperCase();
  const title = (pr.title ?? '').toUpperCase();
  const desc = (pr.description ?? '').toUpperCase();
  return branch === key || branch.includes(key) || title.includes(key) || desc.includes(key);
}

function authorFromRaw(raw?: string): string | undefined {
  if (!raw) return undefined;
  const name = raw.replace(/<[^>]*>/g, '').trim();
  return name || undefined;
}

function toMs(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
