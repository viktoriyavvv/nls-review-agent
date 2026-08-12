import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppConfig, ResolvedRepo } from '../src/config/types';
import {
  resolveResumePlan,
  shouldAutoSync,
  shouldFallbackToStateless,
  withCompactDirective,
} from '../src/review/run-plan';
import {
  buildClaudeArgs,
  extractSessionId,
  parseStreamJson,
  summarizeStreamEvent,
} from '../src/review/claude.runner';
import { loadClaudeSession, saveClaudeSession } from '../src/review/claude-session';
import { buildCloneArgs, buildCloneUrl } from '../src/utils/bitbucket-url';
import { createSanitizer, maskSecrets } from '../src/server/services/sanitize';
import { listHistory } from '../src/server/services/history';
import { getCloneCommand, getRepoStatus, RepoAdminError, removeLocalRepo } from '../src/server/services/repo-admin';
import { JobStore } from '../src/server/job-store';
import { JobConflictError, JobRunner, SpawnFn } from '../src/server/job-runner';

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
    jira: { baseUrl: 'https://nls.atlassian.net', email: 'tl@nls.kz', apiToken: 'SECRET-jira', apiVersion: '3' },
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
      ...extraRepos,
    },
    profiles: { default: 'default', profiles: {} },
    jiraFields: { standardFields: [], customFields: [] },
  };
}

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-gui2-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

/** Fake spawn that records its argv and emits lines then closes. */
function recordingSpawn(lines: string[], code = 0): { spawn: SpawnFn; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
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
  return { spawn, calls };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ run-plan (1-8) --------------------------- */

describe('auto-sync decision (#1-#4)', () => {
  it('defaults ON and is disabled only by --no-sync', () => {
    expect(shouldAutoSync({})).toBe(true); // run/followup default
    expect(shouldAutoSync({ sync: true })).toBe(true);
    expect(shouldAutoSync({ sync: false })).toBe(false); // --no-sync
  });
});

describe('resume plan (#5-#7)', () => {
  it('uses the saved session id by default (#5)', () => {
    const plan = resolveResumePlan({ savedSessionId: 'sess-saved' });
    expect(plan.enabled).toBe(true);
    expect(plan.sessionId).toBe('sess-saved');
    expect(plan.source).toBe('saved');
  });

  it('--no-resume disables resume (#6)', () => {
    const plan = resolveResumePlan({ resume: false, savedSessionId: 'sess-saved' });
    expect(plan.enabled).toBe(false);
    expect(plan.sessionId).toBeNull();
  });

  it('--resume-session overrides the saved id (#7)', () => {
    const plan = resolveResumePlan({ resumeSession: 'sess-flag', savedSessionId: 'sess-saved' });
    expect(plan.enabled).toBe(true);
    expect(plan.sessionId).toBe('sess-flag');
    expect(plan.source).toBe('flag');
  });

  it('is stateless when nothing is available', () => {
    const plan = resolveResumePlan({});
    expect(plan.enabled).toBe(false);
    expect(plan.source).toBe('none');
  });
});

describe('resume fallback (#8)', () => {
  it('falls back to stateless when the resumed run failed / was empty', () => {
    expect(shouldFallbackToStateless({ exitCode: 1, resultText: '{"verdict":"HOLD"}' })).toBe(true);
    expect(shouldFallbackToStateless({ exitCode: 0, resultText: '   ' })).toBe(true);
    expect(shouldFallbackToStateless({ exitCode: 0, resultText: '{"verdict":"HOLD"}' })).toBe(false);
  });

  it('prefixes the follow-up prompt with /compact', () => {
    expect(withCompactDirective('CTX')).toBe('/compact\n\nCTX');
  });
});

/* ------------------------- Claude session handling ---------------------- */

describe('claude session id extraction', () => {
  it('reads the common envelope fields best-effort', () => {
    expect(extractSessionId({ session_id: 'a' })).toBe('a');
    expect(extractSessionId({ sessionId: 'b' })).toBe('b');
    expect(extractSessionId({ conversation_id: 'c' })).toBe('c');
    expect(extractSessionId({ id: 'd' })).toBe('d');
    expect(extractSessionId({ id: 'd' }, { includeGenericId: false })).toBeNull();
    expect(extractSessionId('nope')).toBeNull();
  });

  it('parses stream-json for the result text + session id', () => {
    const raw = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-xyz', model: 'opus', tools: [1, 2] }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: '{"verdict":"HOLD"}', session_id: 'sess-xyz' }),
    ].join('\n');
    const parsed = parseStreamJson(raw);
    expect(parsed.sessionId).toBe('sess-xyz');
    expect(parsed.resultText).toBe('{"verdict":"HOLD"}');
    expect(summarizeStreamEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })).toEqual([
      '→ Read',
    ]);
  });

  it('adds --verbose and --resume to the CLI args when needed', () => {
    const stream = buildClaudeArgs({
      bin: 'claude',
      model: 'opus',
      effort: 'max',
      outputFormat: 'stream-json',
      resumeSessionId: 'sess-1',
      cwd: '.',
    });
    expect(stream).toContain('--verbose');
    expect(stream.join(' ')).toContain('--resume sess-1');
    const json = buildClaudeArgs({ bin: 'claude', model: 'opus', effort: 'max', outputFormat: 'json', cwd: '.' });
    expect(json).not.toContain('--verbose');
    expect(json).not.toContain('--resume');
  });

  it('saves and reloads claude-session.json (createdAt preserved)', async () => {
    const root = tmpRoot();
    const outputsDir = path.join(root, 'outputs');
    await saveClaudeSession({
      outputsDir,
      issueKey: 'SC-3563',
      repoId: 'frontend-support-center.netcore.kz',
      sessionId: 'sess-1',
      head: 'abcdef1',
      source: 'review.raw.json',
      nowIso: '2026-06-30T10:00:00.000Z',
    });
    await saveClaudeSession({
      outputsDir,
      issueKey: 'SC-3563',
      repoId: 'frontend-support-center.netcore.kz',
      sessionId: 'sess-1',
      head: 'abcdef2',
      source: 'review.raw.json',
      nowIso: '2026-07-01T10:00:00.000Z',
    });
    const loaded = await loadClaudeSession(outputsDir, 'SC-3563', 'frontend-support-center.netcore.kz');
    expect(loaded?.initialReviewSessionId).toBe('sess-1');
    expect(loaded?.createdAt).toBe('2026-06-30T10:00:00.000Z'); // preserved across updates
    expect(loaded?.updatedAt).toBe('2026-07-01T10:00:00.000Z');
  });
});

/* ------------------------------- history (#9) --------------------------- */

describe('history scanner (#9)', () => {
  it('lists issue+repo runs found in outputs/', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const dir = path.join(root, 'outputs', 'SC-3563', 'frontend-support-center.netcore.kz');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review.json'),
      JSON.stringify({ verdict: 'HOLD', summary: 'x', checkedHead: { head: 'abcdef1' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'latest-followup.json'),
      JSON.stringify({ verdict: 'APPROVE', checkedHead: { previousHead: 'aaa', currentHead: 'bbb' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'pr.json'),
      JSON.stringify({ prFound: true, id: 1797, title: 'PR', sourceBranch: 'SC-3563', targetBranch: 'staging' }),
    );

    const items = await listHistory(cfg);
    expect(items).toHaveLength(1);
    expect(items[0].issueKey).toBe('SC-3563');
    expect(items[0].repoId).toBe('frontend-support-center.netcore.kz');
    expect(items[0].latestReview?.verdict).toBe('HOLD');
    expect(items[0].latestFollowup?.verdict).toBe('APPROVE');
    expect(items[0].pr?.prFound).toBe(true);
    expect(items[0].filesCount).toBeGreaterThanOrEqual(3);
  });

  it('returns [] when there is no outputs dir', async () => {
    expect(await listHistory(makeConfig(tmpRoot()))).toEqual([]);
  });
});

/* --------------------------- clone URL (#10, #13) ----------------------- */

describe('clone url / command (#10, #13)', () => {
  it('embeds the username but NEVER a token', () => {
    const cfg = makeConfig(tmpRoot());
    const cmd = getCloneCommand(cfg, 'frontend-support-center.netcore.kz', true);
    expect(cmd.url).toBe(
      'https://zahar4747@bitbucket.org/nls-kz/frontend-support-center.netcore.kz.git',
    );
    expect(cmd.command).toContain('git clone https://zahar4747@bitbucket.org/nls-kz/');
    expect(cmd.url).not.toContain('SECRET-bitbucket-token-value');
    expect(cmd.command).not.toContain('SECRET-bitbucket-token-value');
  });

  it('omits the username when useUsername is false', () => {
    const url = buildCloneUrl({ workspace: 'nls-kz', repoSlug: 'r', username: 'zahar4747', useUsername: false });
    expect(url).toBe('https://bitbucket.org/nls-kz/r.git');
    expect(url).not.toContain('@');
  });

  it('buildCloneArgs is always an array (no shell string) (#11)', () => {
    expect(buildCloneArgs('https://bitbucket.org/nls-kz/r.git', './repos/r')).toEqual([
      'clone',
      'https://bitbucket.org/nls-kz/r.git',
      './repos/r',
    ]);
  });
});

/* ------------------------- remove-local guard (#12) --------------------- */

describe('removeLocalRepo safety (#12)', () => {
  it('refuses to delete a path outside reposDir', async () => {
    const root = tmpRoot();
    // A repo whose path resolves OUTSIDE reposDir must be rejected.
    const evil = repo('evil', ['X'], root, '../../outside-target');
    const cfg = makeConfig(root, { evil });
    fs.mkdirSync(evil.absPath, { recursive: true });
    await expect(removeLocalRepo(cfg, 'evil', { force: true })).rejects.toBeInstanceOf(RepoAdminError);
    // The folder must still exist (nothing deleted).
    expect(fs.existsSync(evil.absPath)).toBe(true);
  });

  it('requires force for a non-git folder, then deletes inside reposDir', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    const target = cfg.repos['frontend-support-center.netcore.kz'].absPath;
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'file.txt'), 'x');

    await expect(
      removeLocalRepo(cfg, 'frontend-support-center.netcore.kz', { force: false }),
    ).rejects.toBeInstanceOf(RepoAdminError);
    expect(fs.existsSync(target)).toBe(true);

    const res = await removeLocalRepo(cfg, 'frontend-support-center.netcore.kz', { force: true });
    expect(res.removed).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('reports repo status for a missing clone', async () => {
    const cfg = makeConfig(tmpRoot());
    const st = await getRepoStatus(cfg, 'frontend-support-center.netcore.kz');
    expect(st.exists).toBe(false);
    expect(st.isGitRepo).toBe(false);
    expect(st.cloneUrl).not.toContain('SECRET-bitbucket-token-value');
  });
});

/* ------------------------------ sanitize (#14) -------------------------- */

describe('log sanitizer (#14)', () => {
  it('redacts known secret values and auth headers', () => {
    const s = createSanitizer(['SECRET-bitbucket-token-value']);
    expect(s('using SECRET-bitbucket-token-value here')).toBe('using *** here');
    expect(s('Authorization: Bearer abcdef123456')).toBe('Authorization: Bearer ***');
    expect(maskSecrets('token=deadbeefcafe', [])).toBe('token=***');
    expect(maskSecrets('https://user:hunter2@bitbucket.org/x.git', [])).toBe(
      'https://user@bitbucket.org/x.git',
    );
  });

  it('leaves ordinary text untouched', () => {
    const s = createSanitizer(['SECRET-x-value']);
    expect(s('[step] Fetching Jira issue...')).toBe('[step] Fetching Jira issue...');
  });
});

/* ---------------------------- job runner (#11,#15) ---------------------- */

describe('job runner clone + guards (#11, #15)', () => {
  it('builds the clone argv array and spawns via argv (no shell) (#11)', async () => {
    const store = new JobStore();
    const { spawn, calls } = recordingSpawn(['[ok]    cloned'], 0);
    const runner = new JobRunner(store, { projectRoot: tmpRoot(), spawnFn: spawn });
    const job = runner.start({ type: 'clone', repoId: 'frontend-support-center.netcore.kz', extraArgs: ['--no-username'] });
    expect(job.argv).toEqual(['clone', 'frontend-support-center.netcore.kz', '--no-username']);
    await tick();
    // spawn was called with (node, [cliPath, ...cliArgs]) — an array, never a string.
    expect(Array.isArray(calls[0].args)).toBe(true);
    expect(calls[0].args.slice(-3)).toEqual(['clone', 'frontend-support-center.netcore.kz', '--no-username']);
    expect(store.get(job.id)!.status).toBe('success');
  });

  it('refuses a second follow-up for the same issue+repo (#15)', () => {
    const store = new JobStore();
    const { spawn } = recordingSpawn(['[step]  working...'], 0);
    const runner = new JobRunner(store, { projectRoot: tmpRoot(), spawnFn: spawn });
    const spec = { type: 'run-followup' as const, issueKey: 'SC-3563', repoId: 'frontend-support-center.netcore.kz' };
    runner.start(spec);
    expect(() => runner.start(spec)).toThrow(JobConflictError);
    // clone holds the repo lock, blocking a concurrent sync of the same repo.
    const spec2 = { type: 'clone' as const, repoId: 'r1' };
    runner.start(spec2);
    expect(() => runner.start({ type: 'sync' as const, repoId: 'r1' })).toThrow(JobConflictError);
  });

  it('parses [stage]/[claude] lines and sanitizes secrets in logs', async () => {
    const store = new JobStore();
    const { spawn } = recordingSpawn(
      ['[stage] running Claude', '[claude] hello from claude', '[info]  token is SUPERSECRET-1234'],
      0,
    );
    const runner = new JobRunner(store, {
      projectRoot: tmpRoot(),
      spawnFn: spawn,
      sanitize: createSanitizer(['SUPERSECRET-1234']),
    });
    const job = runner.start({ type: 'run-review', issueKey: 'SC-3563', repoId: 'r1' });
    await tick();
    const done = store.get(job.id)!;
    expect(done.stage).toBe('running Claude');
    expect(done.logs.some((l) => l.level === 'claude' && l.text === 'hello from claude')).toBe(true);
    expect(done.logs.some((l) => l.text.includes('SUPERSECRET-1234'))).toBe(false);
    expect(done.logs.some((l) => l.text.includes('***'))).toBe(true);
  });
});
