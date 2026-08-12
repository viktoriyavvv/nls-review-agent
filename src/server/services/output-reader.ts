import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../../config/types';
import {
  LATEST_FOLLOWUP_FILES,
  OUTPUT_FILES,
  isInside,
  outputDir,
} from '../../utils/paths';

/** Max bytes returned inline by the file endpoint (large diffs are truncated). */
export const MAX_INLINE_FILE_BYTES = 2_000_000; // 2 MB

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

/**
 * Reader for files under the outputs directory ONLY. Every public method
 * validates the issue key, requires the repo id to be a configured repo, and
 * confirms the resolved absolute path stays inside `outputs/<issue>/<repo>` —
 * blocking `../` traversal and absolute paths.
 */
export class OutputReader {
  private readonly outputsRoot: string;

  constructor(private readonly config: AppConfig) {
    this.outputsRoot = path.resolve(config.root.outputsDir);
  }

  private baseDir(issueKey: string, repoId: string): string {
    if (!ISSUE_KEY_RE.test(issueKey)) {
      throw new PathSafetyError(`Invalid issue key: "${issueKey}".`);
    }
    if (!Object.prototype.hasOwnProperty.call(this.config.repos, repoId)) {
      throw new PathSafetyError(`Unknown repo id: "${repoId}".`);
    }
    const base = path.resolve(outputDir(this.outputsRoot, issueKey, repoId));
    // Defence in depth: the composed base must itself live under outputs/.
    if (!isInside(this.outputsRoot, base)) {
      throw new PathSafetyError('Resolved path escapes the outputs directory.');
    }
    return base;
  }

  /** Resolve a user-supplied relative path safely inside the issue+repo dir. */
  resolveSafe(issueKey: string, repoId: string, relPath: string): string {
    const base = this.baseDir(issueKey, repoId);
    const abs = path.resolve(base, relPath ?? '');
    if (!isInside(base, abs)) {
      throw new PathSafetyError(`Path "${relPath}" escapes the output directory.`);
    }
    return abs;
  }

  async hasOutputs(issueKey: string, repoId: string): Promise<boolean> {
    try {
      const st = await fs.stat(this.baseDir(issueKey, repoId));
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  /** Recursively list output files (relative paths + sizes), followups included. */
  async listFiles(issueKey: string, repoId: string): Promise<{ path: string; size: number }[]> {
    const base = this.baseDir(issueKey, repoId);
    const out: { path: string; size: number }[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          await walk(abs);
        } else if (ent.isFile()) {
          const st = await fs.stat(abs).catch(() => null);
          out.push({ path: path.relative(base, abs).split(path.sep).join('/'), size: st?.size ?? 0 });
        }
      }
    };

    await walk(base);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Read a file (size-capped) safely inside the issue+repo output dir. */
  async readFile(
    issueKey: string,
    repoId: string,
    relPath: string,
  ): Promise<{ path: string; size: number; truncated: boolean; content: string }> {
    const abs = this.resolveSafe(issueKey, repoId, relPath);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new PathSafetyError(`Not a file: "${relPath}".`);
    const truncated = st.size > MAX_INLINE_FILE_BYTES;
    const handle = await fs.open(abs, 'r');
    try {
      const len = Math.min(st.size, MAX_INLINE_FILE_BYTES);
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, 0);
      return {
        path: relPath,
        size: st.size,
        truncated,
        content: buf.toString('utf8'),
      };
    } finally {
      await handle.close();
    }
  }

  private async readJson<T = unknown>(issueKey: string, repoId: string, name: string): Promise<T | null> {
    try {
      const abs = this.resolveSafe(issueKey, repoId, name);
      const txt = await fs.readFile(abs, 'utf8');
      return JSON.parse(txt) as T;
    } catch {
      return null;
    }
  }

  private async readMaybe(issueKey: string, repoId: string, name: string): Promise<string | null> {
    try {
      const abs = this.resolveSafe(issueKey, repoId, name);
      return await fs.readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** Compact summary used by the results header. */
  async getSummary(issueKey: string, repoId: string): Promise<OutputSummary> {
    const review = await this.readJson<Record<string, unknown>>(issueKey, repoId, OUTPUT_FILES.reviewJson);
    const followup = await this.readJson<Record<string, unknown>>(
      issueKey,
      repoId,
      LATEST_FOLLOWUP_FILES.json,
    );
    const pr = await this.readJson<Record<string, unknown>>(issueKey, repoId, OUTPUT_FILES.pr);
    const git = await this.readJson<Record<string, unknown>>(issueKey, repoId, OUTPUT_FILES.gitMeta);

    return {
      issueKey,
      repoId,
      hasReview: review != null,
      hasFollowup: followup != null,
      reviewVerdict: (review?.verdict as string) ?? null,
      followupVerdict: (followup?.verdict as string) ?? null,
      prFound: (pr?.prFound as boolean) ?? false,
      prId: (pr?.id as number | string | null) ?? null,
      prTitle: (pr?.title as string) ?? null,
      branch: (git?.branch as string) ?? null,
      baseBranch: (git?.baseBranch as string) ?? null,
      head: (git?.head as string) ?? null,
      changedFilesCount: Array.isArray(git?.changedFiles)
        ? (git!.changedFiles as unknown[]).length
        : null,
    };
  }

  async getReview(
    issueKey: string,
    repoId: string,
  ): Promise<{ md: string | null; json: unknown | null }> {
    return {
      md: await this.readMaybe(issueKey, repoId, OUTPUT_FILES.reviewMd),
      json: await this.readJson(issueKey, repoId, OUTPUT_FILES.reviewJson),
    };
  }

  /** All follow-up runs (newest first) plus the latest pointer markdown. */
  async getFollowups(issueKey: string, repoId: string): Promise<FollowupListing> {
    const base = this.baseDir(issueKey, repoId);
    const dir = path.join(base, 'followups');
    let runs: FollowupRun[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      runs = (
        await Promise.all(
          entries
            .filter((e) => e.isDirectory())
            .map(async (e) => {
              const j = await this.readJson<Record<string, unknown>>(
                issueKey,
                repoId,
                `followups/${e.name}/followup.json`,
              );
              return {
                timestamp: e.name,
                verdict: (j?.verdict as string) ?? null,
                summary: (j?.summary as string) ?? null,
                previousHead:
                  ((j?.checkedHead as Record<string, unknown>)?.previousHead as string) ?? null,
                currentHead:
                  ((j?.checkedHead as Record<string, unknown>)?.currentHead as string) ?? null,
              } satisfies FollowupRun;
            }),
        )
      ).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch {
      runs = [];
    }
    return {
      runs,
      latestMd: await this.readMaybe(issueKey, repoId, LATEST_FOLLOWUP_FILES.md),
      latestJson: await this.readJson(issueKey, repoId, LATEST_FOLLOWUP_FILES.json),
    };
  }

  /** Memory context attached to the last run + which items were used. */
  async getMemoryContext(
    issueKey: string,
    repoId: string,
  ): Promise<{ md: string | null; used: unknown | null }> {
    return {
      md: await this.readMaybe(issueKey, repoId, OUTPUT_FILES.memoryContext),
      used: await this.readJson(issueKey, repoId, OUTPUT_FILES.memoryUsed),
    };
  }

  /** Claude session pointer + how the latest follow-up used it (for the UI). */
  async getClaudeSession(
    issueKey: string,
    repoId: string,
  ): Promise<{ session: unknown | null; followup: unknown | null }> {
    const session = await this.readJson(issueKey, repoId, OUTPUT_FILES.claudeSession);
    const latestFollowup = await this.readJson<Record<string, unknown>>(
      issueKey,
      repoId,
      LATEST_FOLLOWUP_FILES.json,
    );
    return { session, followup: (latestFollowup?.claudeSession as unknown) ?? null };
  }
}

export interface OutputSummary {
  issueKey: string;
  repoId: string;
  hasReview: boolean;
  hasFollowup: boolean;
  reviewVerdict: string | null;
  followupVerdict: string | null;
  prFound: boolean;
  prId: number | string | null;
  prTitle: string | null;
  branch: string | null;
  baseBranch: string | null;
  head: string | null;
  changedFilesCount: number | null;
}

export interface FollowupRun {
  timestamp: string;
  verdict: string | null;
  summary: string | null;
  previousHead: string | null;
  currentHead: string | null;
}

export interface FollowupListing {
  runs: FollowupRun[];
  latestMd: string | null;
  latestJson: unknown | null;
}
