import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { JobStore } from './job-store';
import { Job, LogLevel, StartJobSpec } from './types';
import { createSanitizer } from './services/sanitize';

/* --- Minimal child-process shape so spawn can be faked in tests --- */
export interface ChildStreamLike {
  on(event: 'data', cb: (chunk: Buffer | string) => void): void;
}
export interface ChildLike {
  stdout: ChildStreamLike | null;
  stderr: ChildStreamLike | null;
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => ChildLike;

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobConflictError';
  }
}

export interface JobRunnerOptions {
  projectRoot: string;
  /** Path to the built CLI entry (default: <projectRoot>/dist/cli.js). */
  cliPath?: string;
  /** Node binary (default: the node running the server). */
  nodeBin?: string;
  /** Injectable spawn for tests. */
  spawnFn?: SpawnFn;
  /** Injectable log sanitizer (default redacts env tokens + header patterns). */
  sanitize?: (text: string) => string;
}

const LEVEL_RE = /^\[(info|step|ok|warn|error|debug)\]\s*(.*)$/s;
const CLAUDE_RE = /^\[claude\]\s?(.*)$/s;
const STAGE_RE = /^\[stage\]\s*(.*)$/;
const VERDICT_RE = /\b(?:Review|Follow-up) complete:\s*([A-Z]+)/;

function parseLine(line: string, stream: 'stdout' | 'stderr'): { level: LogLevel; text: string } {
  const c = CLAUDE_RE.exec(line);
  if (c) return { level: 'claude', text: c[1] };
  const m = LEVEL_RE.exec(line);
  if (m) return { level: m[1] as LogLevel, text: m[2] };
  return { level: stream === 'stderr' ? 'warn' : 'raw', text: line };
}

/**
 * Runs CLI commands as child processes and records them as jobs.
 *
 * - Builds an argv ARRAY (never a shell string) so there is no shell-injection
 *   surface; the CLI is invoked exactly like a user would type it.
 * - Refuses to start a second job that holds the same lock key (mirrors the
 *   CLI's task lock for issue+repo), giving the GUI an immediate, clear error
 *   instead of a deep file-lock failure.
 */
export class JobRunner {
  private readonly projectRoot: string;
  private readonly cliPath: string;
  private readonly nodeBin: string;
  private readonly spawnFn: SpawnFn;
  private readonly activeKeys = new Set<string>();
  private readonly sanitize: (text: string) => string;

  constructor(private readonly store: JobStore, opts: JobRunnerOptions) {
    this.projectRoot = opts.projectRoot;
    this.cliPath = opts.cliPath ?? path.join(opts.projectRoot, 'dist', 'cli.js');
    this.nodeBin = opts.nodeBin ?? process.execPath;
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    // Redact known token values (and header/URL patterns) from every log line.
    this.sanitize =
      opts.sanitize ??
      createSanitizer([
        process.env.JIRA_API_TOKEN,
        process.env.BITBUCKET_TOKEN,
        process.env.CLAUDE_API_KEY,
        process.env.ANTHROPIC_API_KEY,
      ]);
  }

  private lockKeyFor(spec: StartJobSpec): string {
    switch (spec.type) {
      case 'sync':
      case 'clone':
        // Repo-wide git operations are mutually exclusive per repo.
        return `repo:${spec.repoId}`;
      case 'run-review':
      case 'run-followup':
      case 'clean':
      // Memory generation reads the same outputs a running review writes —
      // share the task lock so they never interleave for one issue+repo.
      case 'memory-propose':
      case 'learn-bugfix':
        return `task:${spec.issueKey}__${spec.repoId}`;
      default:
        return `misc:${spec.type}`;
    }
  }

  private cliArgsFor(spec: StartJobSpec): string[] {
    const extra = spec.extraArgs ?? [];
    switch (spec.type) {
      case 'sync':
        return ['sync', '--repo', spec.repoId!];
      case 'clone':
        return ['clone', spec.repoId!, ...extra];
      case 'run-review':
        return ['run', spec.issueKey!, '--repo', spec.repoId!, ...extra];
      case 'run-followup':
        return ['followup', spec.issueKey!, '--repo', spec.repoId!, ...extra];
      case 'clean':
        return ['clean', spec.issueKey!, '--repo', spec.repoId!, ...extra];
      case 'memory-propose':
        return ['memory', 'propose', spec.issueKey!, '--repo', spec.repoId!, ...extra];
      case 'learn-bugfix':
        return ['learn', 'bugfix', spec.issueKey!, '--repo', spec.repoId!, ...extra];
      default:
        return [];
    }
  }

  private labelFor(spec: StartJobSpec): string {
    if (spec.label) return spec.label;
    const who = [spec.issueKey, spec.repoId].filter(Boolean).join(' / ');
    return who ? `${spec.type} ${who}` : spec.type;
  }

  /** Whether a job holding this lock key is currently running. */
  isActive(spec: StartJobSpec): boolean {
    return this.activeKeys.has(this.lockKeyFor(spec));
  }

  /**
   * Start a job. Throws JobConflictError if an equivalent job is already
   * running. Returns immediately; progress arrives via the store's events.
   */
  start(spec: StartJobSpec): Job {
    const lockKey = this.lockKeyFor(spec);
    if (this.activeKeys.has(lockKey)) {
      throw new JobConflictError(
        `A "${spec.type}" job for ${spec.issueKey ?? ''} ${spec.repoId ?? ''}`.trim() +
          ' is already running. Wait for it to finish.',
      );
    }

    const cliArgs = this.cliArgsFor(spec);
    const argv = [this.cliPath, ...cliArgs];
    const job: Job = {
      id: this.store.nextId(),
      type: spec.type,
      label: this.labelFor(spec),
      issueKey: spec.issueKey,
      repoId: spec.repoId,
      lockKey,
      argv: cliArgs, // store the CLI-facing args (without node + script path)
      status: 'running',
      createdAt: this.now(),
      startedAt: this.now(),
      logs: [],
    };
    this.activeKeys.add(lockKey);
    this.store.add(job);
    this.store.appendLog(job.id, {
      ts: this.now(),
      level: 'info',
      text: this.sanitize(`$ nls-review ${cliArgs.join(' ')}`),
    });

    let child: ChildLike;
    try {
      child = this.spawnFn(this.nodeBin, argv, {
        cwd: this.projectRoot,
        env: process.env,
      });
    } catch (err) {
      this.finish(job.id, lockKey, null, this.sanitize((err as Error).message));
      return job;
    }

    this.wireStream(job.id, child.stdout, 'stdout');
    this.wireStream(job.id, child.stderr, 'stderr');

    child.on('error', (err) => {
      const msg = this.sanitize(err.message);
      this.store.appendLog(job.id, { ts: this.now(), level: 'error', text: msg });
      this.finish(job.id, lockKey, null, msg);
    });
    child.on('close', (code) => {
      this.finish(job.id, lockKey, code, undefined);
    });

    return job;
  }

  private wireStream(jobId: string, stream: ChildStreamLike | null, which: 'stdout' | 'stderr'): void {
    if (!stream) return;
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (raw.length > 0) this.handleLine(jobId, raw, which);
        nl = buf.indexOf('\n');
      }
    });
    // Flush any trailing partial line when the job ends.
    (stream as unknown as { on(e: 'end', cb: () => void): void }).on?.('end', () => {
      if (buf.trim().length > 0) this.handleLine(jobId, buf.replace(/\r$/, ''), which);
      buf = '';
    });
  }

  private handleLine(jobId: string, rawIn: string, which: 'stdout' | 'stderr'): void {
    const raw = this.sanitize(rawIn);

    // Stage transition markers update the job's current stage.
    const stageM = STAGE_RE.exec(raw);
    if (stageM) {
      const name = stageM[1].trim();
      this.store.patch(jobId, (j) => (j.stage = name));
      this.store.appendLog(jobId, { ts: this.now(), level: 'step', text: `▶ ${name}`, stage: name });
      return;
    }

    const { level, text } = parseLine(raw, which);
    const stage = this.store.get(jobId)?.stage;
    this.store.appendLog(jobId, { ts: this.now(), level, text, stage });
    const vm = VERDICT_RE.exec(raw);
    if (vm) this.store.patch(jobId, (j) => (j.verdict = vm[1]));
  }

  private finish(jobId: string, lockKey: string, code: number | null, error?: string): void {
    this.activeKeys.delete(lockKey);
    this.store.patch(jobId, (job) => {
      if (job.status !== 'running') return;
      job.exitCode = code;
      job.finishedAt = this.now();
      if (error) {
        job.status = 'failed';
        job.error = error;
      } else {
        job.status = code === 0 ? 'success' : 'failed';
        if (code !== 0 && !job.error) job.error = `CLI exited with code ${code}.`;
      }
    });
  }

  // Centralised so a future test could stub time; uses Date via Number to keep
  // the call out of hot deterministic paths elsewhere.
  private now(): number {
    return Number(new Date());
  }
}
