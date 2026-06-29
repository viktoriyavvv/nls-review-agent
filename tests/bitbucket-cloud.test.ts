import { describe, it, expect } from 'vitest';
import {
  BitbucketCloudClient,
  BitbucketApiError,
  BitbucketHttp,
} from '../src/collectors/bitbucket-cloud.client';
import { BitbucketConfigSchema, RepoBitbucketSchema } from '../src/config/types';
import type { BitbucketConfig } from '../src/config/types';

const SECRET = 'super-secret-token-value';
const USER = 'bot@nls';

function cfg(over: Partial<BitbucketConfig> = {}): BitbucketConfig {
  return {
    type: 'cloud',
    baseUrl: '',
    username: USER,
    token: SECRET,
    workspace: 'nls-kz',
    ...over,
  };
}

const TARGET = { repoSlug: 'frontend-support-center.netcore.kz' };

/** Fake HTTP that records calls and routes responses by (url, params). */
function fakeHttp(
  route: (url: string, params?: Record<string, unknown>) => { status: number; data: unknown },
): BitbucketHttp & { calls: Array<{ url: string; params?: Record<string, unknown> }> } {
  const calls: Array<{ url: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    async get(url: string, config?: { params?: Record<string, unknown> }) {
      calls.push({ url, params: config?.params });
      return route(url, config?.params) as { status: number; data: unknown };
    },
  };
}

function prListItem(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: 'SC-3574 fix attachments',
    state: 'OPEN',
    description: 'Implements SC-3574',
    source: { branch: { name: 'SC-3574' }, commit: { hash: 'abc123def456' } },
    destination: { branch: { name: 'staging' } },
    author: { display_name: 'Jane Dev', nickname: 'jane' },
    links: { html: { href: 'https://bitbucket.org/nls-kz/repo/pull-requests/42' } },
    created_on: '2026-06-01T10:00:00.000Z',
    updated_on: '2026-06-02T10:00:00.000Z',
    ...over,
  };
}

const qOf = (p?: Record<string, unknown>): string => String(p?.q ?? '');

describe('BitbucketCloudClient.findPullRequestByIssueKey', () => {
  it('builds a Cloud REST 2.0 URL (not the Data Center /rest/api/1.0 path)', async () => {
    const http = fakeHttp(() => ({ status: 200, data: { values: [prListItem()] } }));
    const client = new BitbucketCloudClient(cfg(), http);

    await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });

    const url = http.calls[0].url;
    expect(url).toContain('https://api.bitbucket.org/2.0');
    expect(url).toContain('/repositories/nls-kz/frontend-support-center.netcore.kz/pullrequests');
    expect(url).not.toContain('/rest/api/1.0');
  });

  it('finds an open PR by exact source branch', async () => {
    const http = fakeHttp((_url, p) =>
      qOf(p).includes('source.branch.name')
        ? { status: 200, data: { values: [prListItem()] } }
        : { status: 200, data: { values: [] } },
    );
    const client = new BitbucketCloudClient(cfg(), http);

    const res = await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });

    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].fromRef.branch).toBe('SC-3574');
    expect(res.candidates[0].toRef.branch).toBe('staging');
    expect(res.candidates[0].fromRef.latestCommit).toBe('abc123def456');
  });

  it('falls back to title, then description, when the branch search is empty', async () => {
    const http = fakeHttp((_url, p) => {
      const q = qOf(p);
      if (q.includes('source.branch.name')) return { status: 200, data: { values: [] } };
      if (q.includes('title')) return { status: 200, data: { values: [] } };
      if (q.includes('description'))
        return { status: 200, data: { values: [prListItem({ source: { branch: { name: 'feature/x' } } })] } };
      return { status: 200, data: { values: [] } };
    });
    const client = new BitbucketCloudClient(cfg(), http);

    const res = await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });

    expect(res.candidates).toHaveLength(1);
    expect(http.calls.map((c) => qOf(c.params)).some((q) => q.includes('description'))).toBe(true);
  });

  it('returns multiple candidates when several open PRs match (ambiguous)', async () => {
    const http = fakeHttp((_url, p) =>
      qOf(p).includes('source.branch.name')
        ? {
            status: 200,
            data: { values: [prListItem({ id: 1 }), prListItem({ id: 2, title: 'SC-3574 alt' })] },
          }
        : { status: 200, data: { values: [] } },
    );
    const client = new BitbucketCloudClient(cfg(), http);

    const res = await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });
    expect(res.candidates).toHaveLength(2);
  });

  it('returns no candidates (not an error) when nothing matches', async () => {
    const http = fakeHttp(() => ({ status: 200, data: { values: [] } }));
    const client = new BitbucketCloudClient(cfg(), http);

    const res = await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });
    expect(res.candidates).toHaveLength(0);
  });

  it('throws a controlled BitbucketApiError on 401 with no secret in the message', async () => {
    const http = fakeHttp(() => {
      throw { response: { status: 401, data: { error: { message: 'unauth' } } } };
    });
    const client = new BitbucketCloudClient(cfg(), http);

    await expect(
      client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' }),
    ).rejects.toMatchObject({ name: 'BitbucketApiError', status: 401 });

    try {
      await client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-3574' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain(USER);
      expect(msg.toLowerCase()).toContain('auth');
    }
  });

  it('resolves the workspace from the target, falling back to the global config', async () => {
    const httpGlobal = fakeHttp(() => ({ status: 200, data: { values: [] } }));
    await new BitbucketCloudClient(cfg({ workspace: 'global-ws' }), httpGlobal).findPullRequestByIssueKey({
      ...TARGET,
      issueKey: 'SC-1',
    });
    expect(httpGlobal.calls[0].url).toContain('/repositories/global-ws/');

    const httpOverride = fakeHttp(() => ({ status: 200, data: { values: [] } }));
    await new BitbucketCloudClient(cfg({ workspace: 'global-ws' }), httpOverride).findPullRequestByIssueKey({
      ...TARGET,
      workspace: 'repo-ws',
      issueKey: 'SC-1',
    });
    expect(httpOverride.calls[0].url).toContain('/repositories/repo-ws/');
  });

  it('throws when no workspace is configured anywhere', async () => {
    const http = fakeHttp(() => ({ status: 200, data: { values: [] } }));
    const client = new BitbucketCloudClient(cfg({ workspace: '' }), http);
    await expect(
      client.findPullRequestByIssueKey({ ...TARGET, issueKey: 'SC-1' }),
    ).rejects.toThrow(/workspace/i);
  });
});

describe('BitbucketCloudClient.getPullRequest', () => {
  it('maps source/target/commit/author and reviewers from participants', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      data: prListItem({
        participants: [
          { role: 'REVIEWER', approved: true, state: 'approved', user: { display_name: 'Rev One' } },
          { role: 'PARTICIPANT', approved: false, user: { display_name: 'Not A Reviewer' } },
        ],
      }),
    }));
    const client = new BitbucketCloudClient(cfg(), http);

    const d = await client.getPullRequest({ ...TARGET, prId: 42 });

    expect(d.fromRef.branch).toBe('SC-3574');
    expect(d.toRef.branch).toBe('staging');
    expect(d.fromRef.latestCommit).toBe('abc123def456');
    expect(d.author).toBe('Jane Dev');
    expect(d.url).toContain('pull-requests/42');
    expect(d.reviewers).toHaveLength(1);
    expect(d.reviewers[0]).toMatchObject({ name: 'Rev One', approved: true });
  });
});

describe('BitbucketCloudClient list endpoints', () => {
  it('maps comments, dropping deleted ones', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      data: {
        values: [
          { id: 1, content: { raw: 'looks good' }, user: { display_name: 'A' }, created_on: 'x' },
          { id: 2, deleted: true, content: { raw: 'gone' }, user: { display_name: 'B' } },
        ],
      },
    }));
    const client = new BitbucketCloudClient(cfg(), http);
    const comments = await client.getPullRequestComments({ ...TARGET, prId: 42 });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: 'A', text: 'looks good' });
  });

  it('maps commits (hash -> id, author display name)', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      data: {
        values: [
          { hash: 'deadbeef', message: 'feat: x', author: { user: { display_name: 'Jane Dev' }, raw: 'Jane <j@x>' }, date: '2026-06-01T00:00:00Z' },
        ],
      },
    }));
    const client = new BitbucketCloudClient(cfg(), http);
    const commits = await client.getPullRequestCommits({ ...TARGET, prId: 42 });
    expect(commits[0]).toMatchObject({ id: 'deadbeef', message: 'feat: x', author: 'Jane Dev' });
  });

  it('maps diffstat status to ADD/MODIFY/REMOVE with a path', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      data: {
        values: [
          { status: 'added', new: { path: 'a.ts' }, old: null },
          { status: 'removed', new: null, old: { path: 'b.ts' } },
        ],
      },
    }));
    const client = new BitbucketCloudClient(cfg(), http);
    const stat = await client.getPullRequestDiffStat({ ...TARGET, prId: 42 });
    expect(stat).toEqual([
      { path: 'a.ts', type: 'ADDED' },
      { path: 'b.ts', type: 'REMOVED' },
    ]);
  });
});

describe('config schema (Cloud)', () => {
  it('adds workspace to the global bitbucket config (default empty)', () => {
    expect(BitbucketConfigSchema.parse({ type: 'cloud', workspace: 'nls-kz' }).workspace).toBe('nls-kz');
    expect(BitbucketConfigSchema.parse({}).workspace).toBe('');
    expect(BitbucketConfigSchema.parse({}).type).toBe('datacenter');
  });

  it('makes repo-level projectKey optional (Cloud needs only repoSlug/workspace)', () => {
    expect(() => RepoBitbucketSchema.parse({ repoSlug: 'r' })).not.toThrow();
    expect(RepoBitbucketSchema.parse({ repoSlug: 'r', workspace: 'nls-kz' }).workspace).toBe('nls-kz');
    expect(RepoBitbucketSchema.parse({ projectKey: 'P', repoSlug: 'r' }).projectKey).toBe('P');
  });
});
