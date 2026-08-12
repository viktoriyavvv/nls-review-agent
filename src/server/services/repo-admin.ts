import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig, ResolvedRepo } from '../../config/types';
import { isInside } from '../../utils/paths';
import { buildCloneArgs, buildCloneUrl } from '../../utils/bitbucket-url';
import { run } from '../../utils/exec';

/** Thrown for repo admin problems; carries an HTTP-ish status for the API. */
export class RepoAdminError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'RepoAdminError';
  }
}

function requireRepo(config: AppConfig, repoId: string): ResolvedRepo {
  const repo = config.repos[repoId];
  if (!repo) throw new RepoAdminError(`Repo "${repoId}" not found in config/repos.yml.`, 404);
  return repo;
}

/** Clone URL for a repo — never contains a token (username at most). */
export function repoCloneUrl(config: AppConfig, repo: ResolvedRepo, useUsername = true): string {
  return buildCloneUrl({
    type: config.bitbucket.type,
    repoSlug: repo.bitbucket.repoSlug,
    workspace: repo.bitbucket.workspace || config.bitbucket.workspace || undefined,
    projectKey: repo.bitbucket.projectKey,
    baseUrl: config.bitbucket.baseUrl,
    username: config.bitbucket.username,
    useUsername,
  });
}

export interface CloneCommand {
  repoId: string;
  path: string;
  url: string;
  command: string;
  hasUsername: boolean;
}

/** The display clone command (git clone <url> <path>) — no token. */
export function getCloneCommand(config: AppConfig, repoId: string, useUsername = true): CloneCommand {
  const repo = requireRepo(config, repoId);
  const url = repoCloneUrl(config, repo, useUsername);
  return {
    repoId,
    path: repo.path,
    url,
    command: `git ${buildCloneArgs(url, repo.path).join(' ')}`,
    hasUsername: Boolean(config.bitbucket.username),
  };
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function gitCapture(args: string[], cwd: string): Promise<string> {
  try {
    const r = await run('git', args, { cwd });
    return r.code === 0 ? r.stdout.trim() : '';
  } catch {
    return '';
  }
}

/** Strip an embedded password (and any token-as-user) from a remote URL. */
function sanitizeRemote(url: string): string {
  if (!url) return url;
  // https://user:secret@host -> https://user@host
  return url.replace(/(https?:\/\/[^/@:]+):[^@]*@/i, '$1@');
}

export interface RepoStatus {
  id: string;
  path: string;
  absPath: string;
  exists: boolean;
  isGitRepo: boolean;
  branch?: string;
  head?: string;
  remoteUrl?: string;
  cloneUrl: string;
  hasUsername: boolean;
}

/** Detailed on-disk status for one repo (branch/head via read-only git). */
export async function getRepoStatus(config: AppConfig, repoId: string): Promise<RepoStatus> {
  const repo = requireRepo(config, repoId);
  const exists = await dirExists(repo.absPath);
  const isGitRepo = exists ? await pathExists(path.join(repo.absPath, '.git')) : false;

  let branch: string | undefined;
  let head: string | undefined;
  let remoteUrl: string | undefined;
  if (isGitRepo) {
    branch = (await gitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], repo.absPath)) || undefined;
    head = (await gitCapture(['rev-parse', '--short', 'HEAD'], repo.absPath)) || undefined;
    remoteUrl = sanitizeRemote(await gitCapture(['remote', 'get-url', 'origin'], repo.absPath)) || undefined;
  }

  return {
    id: repo.id,
    path: repo.path,
    absPath: repo.absPath,
    exists,
    isGitRepo,
    branch,
    head,
    remoteUrl,
    cloneUrl: repoCloneUrl(config, repo, true),
    hasUsername: Boolean(config.bitbucket.username),
  };
}

export interface RemoveLocalResult {
  removed: boolean;
  path: string;
  reason?: string;
}

/**
 * Delete a repo's local folder — with hard safety rails:
 *  - the path must be the repo's configured absPath;
 *  - it must live INSIDE the configured reposDir (never equal to it);
 *  - a non-git folder is only removed with force:true;
 *  - outputs/worktrees are untouched (different roots).
 */
export async function removeLocalRepo(
  config: AppConfig,
  repoId: string,
  opts: { force?: boolean } = {},
): Promise<RemoveLocalResult> {
  const repo = requireRepo(config, repoId);
  const target = path.resolve(repo.absPath);
  const reposRoot = path.resolve(config.root.reposDir);

  if (target === reposRoot || !isInside(reposRoot, target)) {
    throw new RepoAdminError(
      `Refusing to delete "${repo.path}": it is not inside the configured reposDir (${config.root.reposDir}).`,
      400,
    );
  }

  if (!(await dirExists(target))) {
    return { removed: false, path: repo.path, reason: 'not found' };
  }

  const isGit = await pathExists(path.join(target, '.git'));
  if (!isGit && !opts.force) {
    throw new RepoAdminError(
      `"${repo.path}" is not a git repo. Re-run with force to delete it anyway.`,
      409,
    );
  }

  await fs.rm(target, { recursive: true, force: true });
  return { removed: true, path: repo.path };
}
