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
