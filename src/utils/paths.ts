import path from 'node:path';

/**
 * Path helpers. Worktree paths are keyed by (repoId, issueKey); output paths by
 * (issueKey, repoId); locks by the (issueKey, repoId) pair for tasks and by
 * repoId for repo fetch locks. This is what lets the same Jira key be reviewed
 * in parallel across several repositories.
 */

export function worktreePath(worktreesDir: string, repoId: string, issueKey: string): string {
  // worktrees/<repoId>/<issueKey>
  return path.join(worktreesDir, repoId, issueKey);
}

export function outputDir(outputsDir: string, issueKey: string, repoId: string): string {
  // outputs/<issueKey>/<repoId>
  return path.join(outputsDir, issueKey, repoId);
}

export function outputFile(
  outputsDir: string,
  issueKey: string,
  repoId: string,
  name: string,
): string {
  return path.join(outputDir(outputsDir, issueKey, repoId), name);
}

export function taskLockPath(locksDir: string, issueKey: string, repoId: string): string {
  // locks/tasks/<issueKey>__<repoId>.lock
  return path.join(locksDir, 'tasks', `${issueKey}__${repoId}.lock`);
}

export function repoLockPath(locksDir: string, repoId: string): string {
  // locks/repos/<repoId>.lock
  return path.join(locksDir, 'repos', `${repoId}.lock`);
}

/** Canonical output file names produced by a run. */
export const OUTPUT_FILES = {
  jira: 'jira.json',
  pr: 'pr.json',
  gitMeta: 'git-meta.json',
  changedFiles: 'changed-files.txt',
  diff: 'diff.patch',
  context: 'context.md',
  reviewRaw: 'review.raw.json',
  reviewJson: 'review.json',
  reviewMd: 'review.md',
  error: 'error.md',
} as const;

/* ----------------------------- follow-up ----------------------------- */

/** Directory holding all follow-up runs for an issue+repo. */
export function followupsDir(outputsDir: string, issueKey: string, repoId: string): string {
  // outputs/<issueKey>/<repoId>/followups
  return path.join(outputDir(outputsDir, issueKey, repoId), 'followups');
}

/** One follow-up run, keyed by timestamp so prior runs are never overwritten. */
export function followupRunDir(
  outputsDir: string,
  issueKey: string,
  repoId: string,
  timestamp: string,
): string {
  // outputs/<issueKey>/<repoId>/followups/<timestamp>
  return path.join(followupsDir(outputsDir, issueKey, repoId), timestamp);
}

/** Files written inside a follow-up run directory. */
export const FOLLOWUP_FILES = {
  context: 'followup-context.md',
  raw: 'followup.raw.json',
  json: 'followup.json',
  md: 'followup.md',
  error: 'followup-error.md',
} as const;

/** Convenience "latest" pointers written at the issue+repo root (overwritten). */
export const LATEST_FOLLOWUP_FILES = {
  md: 'latest-followup.md',
  json: 'latest-followup.json',
} as const;

/**
 * Filesystem-safe, sortable timestamp derived from UTC, e.g.
 * `2026-06-29_16-30-00`. Deterministic for a given Date (UTC-based) so tests are
 * timezone-independent.
 */
export function formatRunTimestamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\..*$/, '') // drop ".000Z"
    .replace('T', '_')
    .replace(/:/g, '-');
}
