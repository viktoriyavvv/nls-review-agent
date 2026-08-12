import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppConfig, ResolvedRepo } from '../src/config/types';
import { getConfigStatus } from '../src/server/services/config-status';
import { listRepos } from '../src/server/services/repos';
import { resolveSelection } from '../src/server/services/resolve';
import { OutputReader, PathSafetyError } from '../src/server/services/output-reader';
import { RunBodySchema, validateBody } from '../src/server/validate';
import { JobStore } from '../src/server/job-store';
import { JobConflictError, JobRunner, SpawnFn } from '../src/server/job-runner';

/* ------------------------------- fixtures -------------------------------- */

function repo(id: string, prefixes: string[], outputsRoot: string): ResolvedRepo {
  return {
    id,
    jiraPrefixes: prefixes,
    path: `./repos/${id}`,
    absPath: path.join(outputsRoot, '..', 'repos', id),
    defaultBaseBranch: 'origin/master',
    bitbucket: { repoSlug: id, workspace: 'nls-kz' },
  };
}

function makeConfig(root: string): AppConfig {
  const outputsDir = path.join(root, 'outputs');
  return {
    projectRoot: root,
    root: {
      reposDir: path.join(root, 'repos'),
      worktreesDir: path.join(root, 'worktrees'),
      outputsDir,
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
      username: 'bb-user',
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
      'frontend-support-center.netcore.kz': repo('frontend-support-center.netcore.kz', ['SC'], outputsDir),
      'meganet.kz-2023-front': repo('meganet.kz-2023-front', ['WEBSITE'], outputsDir),
      'frontend-block.nls.kz': repo('frontend-block.nls.kz', ['WEBSITE'], outputsDir),
    },
    profiles: { default: 'default', profiles: {} },
    jiraFields: { standardFields: [], customFields: [] },
  };
}

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-gui-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Fake spawn that emits the given lines then closes with `code`. */
function fakeSpawn(lines: string[], code = 0): SpawnFn {
  return () => {
    const child = new EventEmitter() as unknown as ReturnType<SpawnFn> & EventEmitter;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    setTimeout(() => {
      for (const l of lines) stdout.emit('data', Buffer.from(l + '\n'));
      child.emit('close', code);
    }, 5);
    return child as unknown as ReturnType<SpawnFn>;
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- tests --------------------------------- */

describe('config status', () => {
  it('reports presence but never the token values (#7)', () => {
    const status = getConfigStatus(makeConfig(tmpRoot()));
    const blob = JSON.stringify(status);
    expect(blob).not.toContain('SECRET-jira-token-value');
    expect(blob).not.toContain('SECRET-bitbucket-token-value');
    expect(status.jira.hasApiToken).toBe(true);
    expect(status.bitbucket.hasToken).toBe(true);
    expect(status.bitbucket.hasUsername).toBe(true);
    expect(status.readOnly).toBe(true);
  });
});

describe('repos service', () => {
  it('lists every configured repo (#1)', async () => {
    const rows = await listRepos(makeConfig(tmpRoot()));
    expect(rows.map((r) => r.id)).toContain('frontend-support-center.netcore.kz');
    expect(rows).toHaveLength(3);
    const sc = rows.find((r) => r.id === 'frontend-support-center.netcore.kz')!;
    expect(sc.jiraPrefixes).toEqual(['SC']);
    expect(sc.exists).toBe(false); // not cloned in the temp fixture
  });
});

describe('run body validation', () => {
  it('accepts a valid body and rejects a bad key (#2)', () => {
    expect(validateBody(RunBodySchema, { issueKey: 'SC-3563' }).ok).toBe(true);
    const bad = validateBody(RunBodySchema, { issueKey: 'not a key' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Jira key/i);
    expect(validateBody(RunBodySchema, {}).ok).toBe(false);
  });
});

describe('repo resolution', () => {
  it('returns a clear multi-repo error when --repo is omitted (#3)', () => {
    const cfg = makeConfig(tmpRoot());
    const out = resolveSelection(cfg, 'WEBSITE-490');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('expected failure');
    expect(out.reason).toBe('multi');
    expect(out.candidates?.length).toBe(2);
    expect(out.message).toMatch(/WEBSITE/);
  });

  it('auto-selects the single mapped repo', () => {
    const cfg = makeConfig(tmpRoot());
    const out = resolveSelection(cfg, 'SC-3563');
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('expected success');
    expect(out.repo.id).toBe('frontend-support-center.netcore.kz');
  });
});

describe('output reader sandbox', () => {
  it('refuses to read outside the outputs directory (#4)', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const reader = new OutputReader(cfg);
    await expect(
      reader.readFile('SC-3563', 'frontend-support-center.netcore.kz', '../../../../etc/passwd'),
    ).rejects.toBeInstanceOf(PathSafetyError);
    await expect(
      reader.readFile('SC-3563', 'frontend-support-center.netcore.kz', '..\\..\\secrets.txt'),
    ).rejects.toBeInstanceOf(PathSafetyError);
    // An unknown repo id is rejected too.
    await expect(reader.readFile('SC-3563', 'evil-repo', 'review.md')).rejects.toBeInstanceOf(
      PathSafetyError,
    );
  });

  it('reads review.md and latest-followup.md (#8)', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const dir = path.join(root, 'outputs', 'SC-3563', 'frontend-support-center.netcore.kz');
    fs.mkdirSync(path.join(dir, 'followups', '2026-06-29_16-10-48'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.md'), '# SC-3563 Review\n\nHOLD');
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ verdict: 'HOLD' }));
    fs.writeFileSync(path.join(dir, 'latest-followup.md'), '# SC-3563 Follow-up\n\nHOLD');
    fs.writeFileSync(
      path.join(dir, 'latest-followup.json'),
      JSON.stringify({ verdict: 'HOLD' }),
    );
    fs.writeFileSync(
      path.join(dir, 'followups', '2026-06-29_16-10-48', 'followup.json'),
      JSON.stringify({ verdict: 'HOLD', checkedHead: { previousHead: 'edc4706', currentHead: '98f6337' } }),
    );

    const reader = new OutputReader(cfg);
    const review = await reader.getReview('SC-3563', 'frontend-support-center.netcore.kz');
    expect(review.md).toContain('SC-3563 Review');
    expect((review.json as { verdict: string }).verdict).toBe('HOLD');

    const followups = await reader.getFollowups('SC-3563', 'frontend-support-center.netcore.kz');
    expect(followups.latestMd).toContain('Follow-up');
    expect(followups.runs).toHaveLength(1);
    expect(followups.runs[0].verdict).toBe('HOLD');
    expect(followups.runs[0].previousHead).toBe('edc4706');

    const files = await reader.listFiles('SC-3563', 'frontend-support-center.netcore.kz');
    const names = files.map((f) => f.path);
    expect(names).toContain('review.md');
    expect(names).toContain('followups/2026-06-29_16-10-48/followup.json');
  });
});

describe('job runner', () => {
  it('creates a job, captures logs and parses the verdict (#5)', async () => {
    const store = new JobStore();
    const runner = new JobRunner(store, {
      projectRoot: tmpRoot(),
      spawnFn: fakeSpawn([
        '[info]  Issue SC-3563 -> repo frontend-support-center.netcore.kz',
        '[step]  Fetching Jira issue...',
        '[ok]    Review complete: HOLD. See outputs/SC-3563/.../review.md',
      ]),
    });
    const job = runner.start({
      type: 'run-review',
      issueKey: 'SC-3563',
      repoId: 'frontend-support-center.netcore.kz',
    });
    expect(job.status).toBe('running');
    expect(job.argv).toEqual(['run', 'SC-3563', '--repo', 'frontend-support-center.netcore.kz']);

    await tick();
    const done = store.get(job.id)!;
    expect(done.status).toBe('success');
    expect(done.verdict).toBe('HOLD');
    expect(done.logs.some((l) => l.text.includes('Fetching Jira issue'))).toBe(true);
    expect(done.logs.some((l) => l.level === 'ok')).toBe(true);
  });

  it('refuses a second job for the same issue+repo (#6)', () => {
    const store = new JobStore();
    const runner = new JobRunner(store, {
      projectRoot: tmpRoot(),
      spawnFn: fakeSpawn(['[step]  working...'], 0),
    });
    const spec = {
      type: 'run-review' as const,
      issueKey: 'SC-3563',
      repoId: 'frontend-support-center.netcore.kz',
    };
    runner.start(spec);
    expect(() => runner.start(spec)).toThrow(JobConflictError);
    // A different repo for the same key is allowed.
    expect(() =>
      runner.start({ ...spec, repoId: 'meganet.kz-2023-front' }),
    ).not.toThrow();
  });

  it('marks a job failed on non-zero exit', async () => {
    const store = new JobStore();
    const runner = new JobRunner(store, {
      projectRoot: tmpRoot(),
      spawnFn: fakeSpawn(['[error] boom'], 1),
    });
    const job = runner.start({ type: 'sync', repoId: 'frontend-support-center.netcore.kz' });
    await tick();
    expect(store.get(job.id)!.status).toBe('failed');
  });
});
