import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppConfig, ResolvedRepo } from '../src/config/types';
import { getConfigStatus } from '../src/server/services/config-status';
import { JqlSearchSchema, JqlQueryCreateSchema, JqlQueryUpdateSchema, validateBody } from '../src/server/validate';
import {
  createQuery,
  deleteQuery,
  listQueries,
  loadQueriesDoc,
  makeQueryId,
  queriesFilePath,
  slugify,
  updateQuery,
} from '../src/server/services/jql-queries';
import {
  clampMaxResults,
  enrichIssue,
  jiraErrorMessage,
  mapIssue,
  readLocalReviewState,
  resolveRepoForKey,
  runJqlSearch,
  type JqlSearcher,
} from '../src/server/services/jira-queue';

/* ------------------------------- fixtures -------------------------------- */

function repo(id: string, prefixes: string[], root: string, relPath?: string): ResolvedRepo {
  const p = relPath ?? `./repos/${id}`;
  return {
    id,
    jiraPrefixes: prefixes,
    path: p,
    absPath: path.resolve(root, p),
    defaultBaseBranch: 'origin/master',
    bitbucket: { repoSlug: id, workspace: 'nls-kz' },
  };
}

function makeConfig(root: string, extraRepos: Record<string, ResolvedRepo> = {}): AppConfig {
  return {
    projectRoot: root,
    root: {
      reposDir: path.join(root, 'repos'),
      worktreesDir: path.join(root, 'worktrees'),
      outputsDir: path.join(root, 'outputs'),
      locksDir: path.join(root, 'locks'),
    },
    jira: {
      baseUrl: 'https://nls.atlassian.net',
      email: 'tl@nls.kz',
      apiToken: 'SECRET-jira-token-value',
      apiVersion: '3',
    },
    bitbucket: {
      type: 'cloud',
      baseUrl: '',
      username: 'zahar4747',
      token: 'SECRET-bitbucket-token-value',
      workspace: 'nls-kz',
    },
    claude: {
      bin: 'claude',
      model: 'opus',
      effort: 'max',
      permissionMode: 'dangerously-skip-permissions',
      outputFormat: 'json',
      maxTurns: undefined,
    },
    repos: {
      'frontend-support-center.netcore.kz': repo('frontend-support-center.netcore.kz', ['SC'], root),
      'meganet.kz-2023-front': repo('meganet.kz-2023-front', ['WEBSITE'], root),
      'frontend-block.nls.kz': repo('frontend-block.nls.kz', ['WEBSITE'], root),
      ...extraRepos,
    },
    profiles: { default: 'default', profiles: {} },
    jiraFields: { standardFields: [], customFields: [] },
  };
}

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-jql-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** A raw Jira issue payload as returned by /search with fields. */
function rawIssue(key: string, over: Record<string, any> = {}): any {
  return {
    key,
    fields: {
      summary: `Summary of ${key}`,
      status: { name: 'Code review' },
      assignee: { displayName: 'Zahar V.' },
      reporter: { displayName: 'PM One' },
      priority: { name: 'High' },
      updated: '2026-06-30T09:00:00.000+0000',
      created: '2026-06-20T09:00:00.000+0000',
      issuetype: { name: 'Task' },
      labels: ['frontend'],
      components: [{ name: 'UI' }],
      ...over,
    },
  };
}

/* ------------------------- saved queries (#1-#4) ------------------------- */

describe('saved JQL queries CRUD (#1-#4)', () => {
  it('loadQueriesDoc creates an empty file when missing (#1)', async () => {
    const cfg = makeConfig(tmpRoot());
    const file = queriesFilePath(cfg);
    expect(fs.existsSync(file)).toBe(false);
    const doc = await loadQueriesDoc(cfg);
    expect(doc).toEqual({ queries: [] });
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ queries: [] });
  });

  it('createQuery saves a query with a slug id (#2)', async () => {
    const cfg = makeConfig(tmpRoot());
    const q = await createQuery(
      cfg,
      { name: 'CR Teamlead queue', jql: 'status IN ("Code review")' },
      { now: '2026-07-01T10:00:00.000Z' },
    );
    expect(q.id).toBe('cr-teamlead-queue');
    expect(q.name).toBe('CR Teamlead queue');
    expect(q.createdAt).toBe('2026-07-01T10:00:00.000Z');
    expect(q.updatedAt).toBe('2026-07-01T10:00:00.000Z');
    const list = await listQueries(cfg);
    expect(list).toHaveLength(1);
    expect(list[0].jql).toBe('status IN ("Code review")');
  });

  it('createQuery disambiguates ids only on collision', async () => {
    const cfg = makeConfig(tmpRoot());
    const a = await createQuery(cfg, { name: 'Queue', jql: 'a' });
    const b = await createQuery(cfg, { name: 'Queue', jql: 'b' });
    expect(a.id).toBe('queue');
    expect(b.id).toBe('queue-2');
  });

  it('updateQuery patches name/jql and bumps updatedAt (#3)', async () => {
    const cfg = makeConfig(tmpRoot());
    const q = await createQuery(cfg, { name: 'Old', jql: 'old jql' }, { now: '2026-07-01T10:00:00.000Z' });
    const upd = await updateQuery(
      cfg,
      q.id,
      { name: 'New name', jql: 'new jql' },
      { now: '2026-07-02T10:00:00.000Z' },
    );
    expect(upd.id).toBe(q.id);
    expect(upd.name).toBe('New name');
    expect(upd.jql).toBe('new jql');
    expect(upd.createdAt).toBe('2026-07-01T10:00:00.000Z'); // preserved
    expect(upd.updatedAt).toBe('2026-07-02T10:00:00.000Z');
  });

  it('updateQuery on a missing id rejects with status 404', async () => {
    const cfg = makeConfig(tmpRoot());
    await expect(updateQuery(cfg, 'nope', { name: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('deleteQuery removes the query (#4)', async () => {
    const cfg = makeConfig(tmpRoot());
    const q = await createQuery(cfg, { name: 'Temp', jql: 'temp' });
    expect(await deleteQuery(cfg, q.id)).toBe(true);
    expect(await listQueries(cfg)).toHaveLength(0);
    expect(await deleteQuery(cfg, q.id)).toBe(false); // already gone
  });

  it('slug/id helpers are deterministic', () => {
    expect(slugify('CR Teamlead queue')).toBe('cr-teamlead-queue');
    expect(slugify('   !!!   ')).toBe('query');
    expect(makeQueryId('Queue', [])).toBe('queue');
    expect(makeQueryId('Queue', ['queue'])).toBe('queue-2');
    expect(makeQueryId('Queue', ['queue', 'queue-2'])).toBe('queue-3');
  });
});

/* ---------------------------- search validation (#5) --------------------- */

describe('JQL body validation (#5)', () => {
  it('accepts a valid search body and rejects an empty jql', () => {
    expect(validateBody(JqlSearchSchema, { jql: 'status = "Code review"' }).ok).toBe(true);
    expect(validateBody(JqlSearchSchema, { jql: 'x', maxResults: 50 }).ok).toBe(true);
    expect(validateBody(JqlSearchSchema, {}).ok).toBe(false);
    expect(validateBody(JqlSearchSchema, { jql: '   ' }).ok).toBe(false);
    // maxResults capped at 200.
    expect(validateBody(JqlSearchSchema, { jql: 'x', maxResults: 9999 }).ok).toBe(false);
  });

  it('validates create/update bodies', () => {
    expect(validateBody(JqlQueryCreateSchema, { name: 'n', jql: 'j' }).ok).toBe(true);
    expect(validateBody(JqlQueryCreateSchema, { name: '', jql: 'j' }).ok).toBe(false);
    expect(validateBody(JqlQueryUpdateSchema, { name: 'n' }).ok).toBe(true);
    expect(validateBody(JqlQueryUpdateSchema, {}).ok).toBe(false); // must patch something
  });
});

/* ------------------------------- mapping (#6) --------------------------- */

describe('Jira issue → queue row (#6)', () => {
  it('maps the fields we care about + builds the browse url', () => {
    const row = mapIssue(rawIssue('SC-3563'), 'https://nls.atlassian.net/');
    expect(row.key).toBe('SC-3563');
    expect(row.summary).toBe('Summary of SC-3563');
    expect(row.status).toBe('Code review');
    expect(row.assignee).toBe('Zahar V.');
    expect(row.reporter).toBe('PM One');
    expect(row.priority).toBe('High');
    expect(row.issueType).toBe('Task');
    expect(row.labels).toEqual(['frontend']);
    expect(row.components).toEqual(['UI']);
    expect(row.jiraUrl).toBe('https://nls.atlassian.net/browse/SC-3563');
  });

  it('tolerates missing fields', () => {
    const row = mapIssue({ key: 'SC-1', fields: {} }, 'https://x');
    expect(row.summary).toBe('');
    expect(row.assignee).toBeUndefined();
    expect(row.labels).toEqual([]);
  });
});

/* -------------------------- repo resolution (#7) ------------------------ */

describe('repo resolution per issue (#7)', () => {
  it('single → the one mapped repo', () => {
    const r = resolveRepoForKey(makeConfig(tmpRoot()), 'SC-3563');
    expect(r.status).toBe('single');
    expect(r.repoId).toBe('frontend-support-center.netcore.kz');
  });

  it('multiple → candidates with path + displayName', () => {
    const r = resolveRepoForKey(makeConfig(tmpRoot()), 'WEBSITE-490');
    expect(r.status).toBe('multiple');
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates?.map((c) => c.repoId)).toContain('meganet.kz-2023-front');
    expect(r.candidates?.[0].path).toMatch(/repos/);
  });

  it('none → no repo mapped', () => {
    const r = resolveRepoForKey(makeConfig(tmpRoot()), 'ZZZ-1');
    expect(r.status).toBe('none');
    expect(r.repoId).toBeUndefined();
  });
});

/* ------------------------- local review state (#8) --------------------- */

describe('local review state from outputs/ (#8)', () => {
  const REPO = 'frontend-support-center.netcore.kz';

  it('reports no review when nothing exists', async () => {
    const st = await readLocalReviewState(makeConfig(tmpRoot()), 'SC-1', REPO);
    expect(st.hasReview).toBe(false);
    expect(st.hasFollowup).toBe(false);
    expect(st.outputPath).toBeUndefined();
  });

  it('reads a review HOLD + follow-up APPROVE', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const dir = path.join(root, 'outputs', 'SC-3563', REPO);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ verdict: 'HOLD' }));
    fs.writeFileSync(path.join(dir, 'latest-followup.json'), JSON.stringify({ verdict: 'APPROVE' }));

    const st = await readLocalReviewState(cfg, 'SC-3563', REPO);
    expect(st.hasReview).toBe(true);
    expect(st.reviewVerdict).toBe('HOLD');
    expect(st.hasFollowup).toBe(true);
    expect(st.followupVerdict).toBe('APPROVE');
    expect(st.latestUpdatedAt).toBeTruthy();
    expect(st.outputPath).toBe('outputs/SC-3563/frontend-support-center.netcore.kz');
  });

  it('enrichIssue attaches local state only for single-repo issues', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const dir = path.join(root, 'outputs', 'SC-3563', REPO);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ verdict: 'HOLD' }));

    const single = await enrichIssue(cfg, rawIssue('SC-3563'));
    expect(single.repoResolution.status).toBe('single');
    expect(single.localReviewState?.reviewVerdict).toBe('HOLD');

    const multi = await enrichIssue(cfg, rawIssue('WEBSITE-490'));
    expect(multi.repoResolution.status).toBe('multiple');
    expect(multi.localReviewState).toBeUndefined(); // needs a repo choice first
  });
});

/* -------------------------- search orchestration (#9) ------------------- */

describe('runJqlSearch orchestration + secret safety (#9)', () => {
  it('enriches issues and flags truncation', async () => {
    const cfg = makeConfig(tmpRoot());
    const searcher: JqlSearcher = async (jql, opts) => {
      expect(jql).toBe('status = "Code review"');
      expect(opts.fields).toContain('summary');
      return { total: 237, startAt: 0, maxResults: opts.maxResults, issues: [rawIssue('SC-3563')] };
    };
    const res = await runJqlSearch(cfg, { jql: 'status = "Code review"', maxResults: 100 }, searcher);
    expect(res.total).toBe(237);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].key).toBe('SC-3563');
    expect(res.truncated).toBe(true);
    expect(res.warning).toMatch(/Showing 1 of 237/);
  });

  it('never leaks tokens in the response payload', async () => {
    const cfg = makeConfig(tmpRoot());
    const searcher: JqlSearcher = async () => ({
      total: 1,
      startAt: 0,
      maxResults: 100,
      issues: [rawIssue('SC-3563')],
    });
    const res = await runJqlSearch(cfg, { jql: 'x' }, searcher);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('SECRET-jira-token-value');
    expect(blob).not.toContain('SECRET-bitbucket-token-value');
  });

  it('clampMaxResults bounds the page size', () => {
    expect(clampMaxResults(undefined)).toBe(100);
    expect(clampMaxResults(0)).toBe(100);
    expect(clampMaxResults(50)).toBe(50);
    expect(clampMaxResults(9999)).toBe(200);
  });

  it('jiraErrorMessage surfaces Jira errors without headers/tokens', () => {
    const msg = jiraErrorMessage({
      response: { status: 400, data: { errorMessages: ["Error in the JQL Query: 'foo'."] } },
    });
    expect(msg).toMatch(/Error in the JQL Query/);
    expect(msg).not.toMatch(/Authorization|Bearer|SECRET/);
  });
});

/* --------------------------- config status (#9) ------------------------- */

describe('config status advertises the JQL file (no tokens)', () => {
  it('reports the saved-query file + jira configured flag', () => {
    const status = getConfigStatus(makeConfig(tmpRoot()));
    expect(status.jql.file).toBe('config/jql-queries.json');
    expect(status.jql.jiraConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('SECRET-jira-token-value');
  });
});
