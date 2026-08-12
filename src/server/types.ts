/**
 * Shared types for the local GUI backend.
 *
 * The GUI is a thin, read-only-by-default layer over the existing CLI:
 *  - read-only data (repos, config status, outputs) comes from importing the
 *    same modules the CLI uses (loadConfig, path helpers, file reads);
 *  - actions (sync / run / followup / clean) are executed by spawning
 *    `node dist/cli.js ...` as a child process so the core logic and the CLI
 *    are never duplicated or modified.
 */

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
  /** Milliseconds since epoch (stamped by the runner). */
  ts: number;
  level: LogLevel;
  text: string;
  /** The pipeline stage this line belongs to (e.g. "running Claude"). */
  stage?: string;
}

export interface Job {
  id: string;
  type: JobType;
  /** Human label, e.g. "run-review SC-3563 / frontend-support-center.netcore.kz". */
  label: string;
  issueKey?: string;
  repoId?: string;
  /** The concurrency key this job holds while running (issue+repo / repo / ...). */
  lockKey: string;
  /** Exact argv handed to the CLI (for transparency / debugging). No secrets. */
  argv: string[];
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  /** Best-effort verdict parsed from the CLI output (APPROVE/HOLD/...). */
  verdict?: string;
  /** Current pipeline stage, updated live from [stage] markers. */
  stage?: string;
  logs: JobLogLine[];
  error?: string;
}

/** Public (serialisable) view of a job — identical here, but kept explicit. */
export type JobView = Job;

export interface StartJobSpec {
  type: JobType;
  issueKey?: string;
  repoId?: string;
  /** Extra CLI flags already validated/whitelisted by the caller. */
  extraArgs?: string[];
  label?: string;
}
