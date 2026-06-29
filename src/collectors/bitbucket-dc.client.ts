import axios, { AxiosInstance } from 'axios';
import { BitbucketConfig } from '../config/types';
import { logger } from '../utils/logger';
import {
  BitbucketClient,
  BitbucketRepoTarget,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetails,
  PullRequestDiffStat,
  PullRequestSearchResult,
  PullRequestSummary,
} from './bitbucket.types';

const PAGE_LIMIT = 100;
const MAX_PAGES = 10; // safety cap when scanning open PRs

/** Bitbucket Data Center / Server client (REST API 1.0). Read-only. */
export class BitbucketDataCenterClient implements BitbucketClient {
  private http: AxiosInstance;

  constructor(private cfg: BitbucketConfig) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (cfg.username && cfg.token) {
      const basic = Buffer.from(`${cfg.username}:${cfg.token}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else if (cfg.token) {
      headers.Authorization = `Bearer ${cfg.token}`;
    }

    this.http = axios.create({
      baseURL: cfg.baseUrl.replace(/\/+$/, ''),
      headers,
      timeout: 30000,
    });
  }

  private base(target: BitbucketRepoTarget): string {
    if (!target.projectKey) {
      throw new Error(
        'Bitbucket Data Center requires a projectKey for ' +
          `${target.repoSlug}. Set repos.<id>.bitbucket.projectKey, or use bitbucket.type: "cloud".`,
      );
    }
    return `/rest/api/1.0/projects/${encodeURIComponent(
      target.projectKey,
    )}/repos/${encodeURIComponent(target.repoSlug)}`;
  }

  private async getPage(url: string, params: Record<string, unknown>): Promise<any> {
    const res = await this.http.get(url, { params });
    return res.data;
  }

  /** Collect all pages of a paginated DC endpoint (bounded by MAX_PAGES). */
  private async getAll(url: string, params: Record<string, unknown> = {}): Promise<any[]> {
    const values: any[] = [];
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.getPage(url, { ...params, start, limit: PAGE_LIMIT });
      values.push(...(data.values ?? []));
      if (data.isLastPage || data.nextPageStart == null) break;
      start = data.nextPageStart;
    }
    return values;
  }

  async findPullRequestByIssueKey(
    params: BitbucketRepoTarget & { issueKey: string },
  ): Promise<PullRequestSearchResult> {
    const url = `${this.base(params)}/pull-requests`;
    const key = params.issueKey.toUpperCase();

    // 1) Exact source-branch match.
    let raw: any[] = [];
    try {
      raw = await this.getAll(url, {
        state: 'ALL',
        direction: 'OUTGOING',
        at: `refs/heads/${params.issueKey}`,
      });
    } catch (err) {
      logger.debug(`Branch-scoped PR lookup failed: ${(err as Error).message}`);
    }
    let candidates = raw.map(mapPullRequest).filter((pr) => prMatchesIssue(pr, key));

    // 2) Fallback: scan open PRs and match by key in branch/title/description.
    if (candidates.length === 0) {
      const open = await this.getAll(url, { state: 'OPEN', order: 'NEWEST' });
      candidates = open.map(mapPullRequest).filter((pr) => prMatchesIssue(pr, key));
    }

    return { candidates };
  }

  async getPullRequest(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestDetails> {
    const data = await this.getPage(`${this.base(params)}/pull-requests/${params.prId}`, {});
    const summary = mapPullRequest(data);
    const reviewers = (data.reviewers ?? []).map((r: any) => ({
      name: r.user?.displayName ?? r.user?.name ?? 'unknown',
      approved: !!r.approved,
      status: r.status,
    }));
    return {
      ...summary,
      reviewers,
      openTasks: data.properties?.openTaskCount,
      resolvedTasks: data.properties?.resolvedTaskCount,
    };
  }

  async getPullRequestComments(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestComment[]> {
    const activities = await this.getAll(
      `${this.base(params)}/pull-requests/${params.prId}/activities`,
    );
    const comments: PullRequestComment[] = [];
    for (const a of activities) {
      if (a.action === 'COMMENTED' && a.comment) {
        collectComments(a.comment, comments);
      }
    }
    return comments;
  }

  async getPullRequestCommits(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestCommit[]> {
    const commits = await this.getAll(
      `${this.base(params)}/pull-requests/${params.prId}/commits`,
    );
    return commits.map((c: any) => ({
      id: c.id,
      message: c.message ?? '',
      author: c.author?.name ?? c.author?.displayName,
      authorTimestamp: c.authorTimestamp,
    }));
  }

  async getPullRequestDiffStat(
    params: BitbucketRepoTarget & { prId: number },
  ): Promise<PullRequestDiffStat[]> {
    const changes = await this.getAll(
      `${this.base(params)}/pull-requests/${params.prId}/changes`,
    );
    return changes.map((c: any) => ({
      path: pathToString(c.path),
      type: c.type ?? 'MODIFY',
    }));
  }
}

function pathToString(p: any): string {
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (typeof p.toString === 'string') return p.toString;
  if (p.components && Array.isArray(p.components)) return p.components.join('/');
  return p.name ?? '';
}

function mapPullRequest(data: any): PullRequestSummary {
  const selfLink = data.links?.self?.[0]?.href;
  return {
    id: data.id,
    title: data.title ?? '',
    state: data.state ?? 'UNKNOWN',
    description: data.description,
    fromRef: {
      branch: data.fromRef?.displayId ?? '',
      latestCommit: data.fromRef?.latestCommit,
    },
    toRef: {
      branch: data.toRef?.displayId ?? '',
    },
    author: data.author?.user?.displayName ?? data.author?.user?.name,
    url: selfLink,
    createdDate: data.createdDate,
    updatedDate: data.updatedDate,
    raw: data,
  };
}

function prMatchesIssue(pr: PullRequestSummary, key: string): boolean {
  const branch = (pr.fromRef.branch ?? '').toUpperCase();
  const title = (pr.title ?? '').toUpperCase();
  const desc = (pr.description ?? '').toUpperCase();
  return branch === key || branch.includes(key) || title.includes(key) || desc.includes(key);
}

function collectComments(comment: any, out: PullRequestComment[]): void {
  if (!comment) return;
  out.push({
    id: comment.id,
    author: comment.author?.displayName ?? comment.author?.name ?? 'unknown',
    text: comment.text ?? '',
    createdAt: comment.createdDate,
    raw: comment,
  });
  for (const reply of comment.comments ?? []) {
    collectComments(reply, out);
  }
}
