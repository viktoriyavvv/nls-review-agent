import { git } from '../utils/exec';
import { pathExists, remove } from '../utils/fs';
import { logger } from '../utils/logger';

export interface GitMetadata {
  repoId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  ref: string;
  head: string;
  subject: string;
  lastCommit: string;
  status: string;
  diffStat: string;
  changedFiles: string[];
  diff: string;
  diffError?: string;
}

/**
 * Compare two commit hashes that may be abbreviated. Bitbucket Cloud returns
 * 12-char short hashes in PR objects, while `git rev-parse HEAD` yields the full
 * 40-char hash, so a strict `===` reports a false mismatch. Treats the hashes as
 * equal when one is a case-insensitive prefix of the other (>= 7 chars, git's
 * minimum abbreviation, to avoid accidental short-prefix collisions).
 */
export function commitMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Fetch everything for a repo (run under a repo lock by the caller). */
export async function gitFetchAll(repoPath: string): Promise<void> {
  await git(['fetch', '--all', '--prune'], { cwd: repoPath });
}

/** Fetch only origin for a repo (faster; used before worktree prep). */
export async function gitFetchOrigin(repoPath: string): Promise<void> {
  await git(['fetch', 'origin', '--prune'], { cwd: repoPath });
}

async function isValidWorktree(worktreePath: string): Promise<boolean> {
  if (!(await pathExists(worktreePath))) return false;
  const res = await git(['rev-parse', '--is-inside-work-tree'], {
    cwd: worktreePath,
    allowFailure: true,
  });
  return res.code === 0;
}

export interface PrepareWorktreeParams {
  repoPath: string;
  worktreePath: string;
  /** Fully-qualified ref to check out, e.g. "origin/SC-3749". */
  ref: string;
}

/**
 * Ensure a detached worktree at `worktreePath` pointing at `ref`.
 * Creates it if missing, refreshes it if present, recreates it if broken.
 */
export async function prepareWorktree(params: PrepareWorktreeParams): Promise<void> {
  const { repoPath, worktreePath, ref } = params;

  const exists = await pathExists(worktreePath);
  if (!exists) {
    logger.step(`Creating worktree ${worktreePath} @ ${ref}`);
    await git(['worktree', 'add', '--detach', worktreePath, ref], { cwd: repoPath });
    return;
  }

  const valid = await isValidWorktree(worktreePath);
  if (!valid) {
    logger.warn(`Worktree ${worktreePath} looks broken; recreating.`);
    await git(['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoPath,
      allowFailure: true,
    });
    await remove(worktreePath);
    await git(['worktree', 'prune'], { cwd: repoPath, allowFailure: true });
    await git(['worktree', 'add', '--detach', worktreePath, ref], { cwd: repoPath });
    return;
  }

  logger.step(`Refreshing worktree ${worktreePath} @ ${ref}`);
  await git(['reset', '--hard'], { cwd: worktreePath, allowFailure: true });
  await git(['clean', '-fd'], { cwd: worktreePath, allowFailure: true });
  await git(['checkout', '--detach', ref], { cwd: worktreePath });
}

export interface CollectMetadataParams {
  repoId: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  ref: string;
}

/**
 * Resolve the base branch to diff against. If the configured branch does not
 * exist in this repo (e.g. configured "origin/master" but the repo uses
 * "origin/main"), fall back to the repo's actual default branch (origin/HEAD).
 */
async function resolveBaseBranch(worktreePath: string, configured: string): Promise<string> {
  const ok = await git(['rev-parse', '--verify', '--quiet', configured], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (ok.code === 0) return configured;

  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: worktreePath,
    allowFailure: true,
  });
  const detected = head.stdout.trim();
  if (detected && detected !== configured) {
    logger.warn(`Base branch "${configured}" not found; using repo default "${detected}".`);
    return detected;
  }
  return configured;
}

/** Collect git metadata and the diff against the base branch from a worktree. */
export async function collectMetadata(params: CollectMetadataParams): Promise<GitMetadata> {
  const { worktreePath } = params;
  const baseBranch = await resolveBaseBranch(worktreePath, params.baseBranch);
  const range = `${baseBranch}...HEAD`;

  const head = (await git(['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim();
  const subject = (
    await git(['log', '-1', '--pretty=%s'], { cwd: worktreePath, allowFailure: true })
  ).stdout.trim();
  const lastCommit = (
    await git(['log', '-1', '--pretty=fuller'], { cwd: worktreePath })
  ).stdout.trim();
  const status = (await git(['status', '--short'], { cwd: worktreePath })).stdout;

  let diffStat = '';
  let changedFiles: string[] = [];
  let diff = '';
  let diffError: string | undefined;

  const statRes = await git(['diff', '--stat', range], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (statRes.code === 0) {
    diffStat = statRes.stdout;
    const namesRes = await git(['diff', '--name-only', range], { cwd: worktreePath });
    changedFiles = namesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    const diffRes = await git(['diff', range], { cwd: worktreePath });
    diff = diffRes.stdout;
  } else {
    diffError = `Could not diff against base "${baseBranch}". Is it fetched? (${statRes.stderr.trim()})`;
    logger.warn(diffError);
  }

  return {
    repoId: params.repoId,
    repoPath: params.repoPath,
    worktreePath,
    branch: params.branch,
    baseBranch,
    ref: params.ref,
    head,
    subject,
    lastCommit,
    status,
    diffStat,
    changedFiles,
    diff,
    diffError,
  };
}

/* --------------------------- follow-up delta --------------------------- */

export interface FollowupDelta {
  /** The HEAD checked by the previous review (or --from-head). */
  previousHead?: string;
  /** The HEAD being checked now. */
  currentHead: string;
  /** True when previousHead is an ancestor of HEAD (normal fast-forward case). */
  isAncestor: boolean;
  /** True when previousHead exists as a commit in this repo. */
  hasPreviousHead: boolean;
  /** `git log --oneline previousHead..HEAD`. */
  commitsOneline: string;
  /** `git log --pretty=fuller previousHead..HEAD`. */
  commitsFuller: string;
  /** Files changed between previousHead and HEAD. */
  changedFiles: string[];
  /** `git diff previousHead..HEAD`. */
  diff: string;
  /** Set when the delta could not be computed (e.g. previousHead missing). */
  error?: string;
}

export interface CollectFollowupDeltaParams {
  worktreePath: string;
  previousHead?: string;
  currentHead: string;
}

/**
 * Collect the change delta since the previous review's HEAD. Never throws on a
 * missing/rebased previousHead — instead records a warning in `error` and an
 * empty delta so the follow-up can still run on the full diff. When previousHead
 * is not an ancestor of HEAD (force-push / rebase), the `prev..HEAD` range still
 * yields the commits unique to HEAD; callers should surface `isAncestor: false`.
 */
export async function collectFollowupDelta(
  params: CollectFollowupDeltaParams,
): Promise<FollowupDelta> {
  const { worktreePath, previousHead, currentHead } = params;

  const empty: FollowupDelta = {
    previousHead,
    currentHead,
    isAncestor: false,
    hasPreviousHead: false,
    commitsOneline: '',
    commitsFuller: '',
    changedFiles: [],
    diff: '',
  };

  if (!previousHead) {
    return { ...empty, error: 'No previous HEAD provided.' };
  }

  const verify = await git(['rev-parse', '--verify', '--quiet', `${previousHead}^{commit}`], {
    cwd: worktreePath,
    allowFailure: true,
  });
  if (verify.code !== 0) {
    return {
      ...empty,
      error:
        `Previous HEAD ${previousHead} is not present in this repo ` +
        `(it may have been rebased away, or a fetch is needed).`,
    };
  }

  const ancestor = await git(['merge-base', '--is-ancestor', previousHead, 'HEAD'], {
    cwd: worktreePath,
    allowFailure: true,
  });
  const isAncestor = ancestor.code === 0;

  const range = `${previousHead}..HEAD`;
  const commitsOneline = (
    await git(['log', '--oneline', range], { cwd: worktreePath, allowFailure: true })
  ).stdout.trim();
  const commitsFuller = (
    await git(['log', '--pretty=fuller', range], { cwd: worktreePath, allowFailure: true })
  ).stdout.trim();
  const namesRes = await git(['diff', '--name-only', range], {
    cwd: worktreePath,
    allowFailure: true,
  });
  const changedFiles = namesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const diff = (await git(['diff', range], { cwd: worktreePath, allowFailure: true })).stdout;

  return {
    previousHead,
    currentHead,
    isAncestor,
    hasPreviousHead: true,
    commitsOneline,
    commitsFuller,
    changedFiles,
    diff,
    error: isAncestor
      ? undefined
      : 'Previous HEAD is not an ancestor of current HEAD (history may have been rebased/force-pushed).',
  };
}

export interface RemoveWorktreeParams {
  repoPath: string;
  worktreePath: string;
}

export async function removeWorktree(params: RemoveWorktreeParams): Promise<void> {
  await git(['worktree', 'remove', params.worktreePath, '--force'], {
    cwd: params.repoPath,
    allowFailure: true,
  });
  // Ensure the directory is gone even if it was not a registered worktree.
  await remove(params.worktreePath);
  await git(['worktree', 'prune'], { cwd: params.repoPath, allowFailure: true });
}
