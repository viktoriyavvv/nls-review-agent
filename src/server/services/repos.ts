import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../../config/types';
import { repoCloneUrl } from './repo-admin';

export interface RepoRow {
  id: string;
  jiraPrefixes: string[];
  path: string;
  absPath: string;
  defaultBaseBranch: string;
  workspace?: string;
  repoSlug?: string;
  /** Bitbucket clone URL (username at most; never a token). */
  cloneUrl: string;
  /** Directory present on disk. */
  exists: boolean;
  /** A `.git` entry exists (cloned, not just an empty dir). */
  isGitRepo: boolean;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function isGitRepo(p: string): Promise<boolean> {
  // A worktree-free clone has a .git directory; some setups use a .git file.
  try {
    await fs.access(path.join(p, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** List every configured repo with a quick on-disk status (read-only). */
export async function listRepos(config: AppConfig): Promise<RepoRow[]> {
  const rows = await Promise.all(
    Object.values(config.repos).map(async (r) => {
      const exists = await dirExists(r.absPath);
      return {
        id: r.id,
        jiraPrefixes: r.jiraPrefixes,
        path: r.path,
        absPath: r.absPath,
        defaultBaseBranch: r.defaultBaseBranch,
        workspace: r.bitbucket.workspace ?? config.bitbucket.workspace ?? undefined,
        repoSlug: r.bitbucket.repoSlug,
        cloneUrl: repoCloneUrl(config, r, true),
        exists,
        isGitRepo: exists ? await isGitRepo(r.absPath) : false,
      } satisfies RepoRow;
    }),
  );
  // Stable, predictable ordering.
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}
