import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../../config/types';
import { LATEST_FOLLOWUP_FILES, OUTPUT_FILES, outputDir } from '../../utils/paths';

const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

export interface HistoryItem {
  issueKey: string;
  repoId: string;
  /** Output dir relative to the project root (forward slashes). */
  outputPath: string;
  latestReview?: {
    verdict?: string;
    head?: string;
    createdAt?: string;
    summary?: string;
  };
  latestFollowup?: {
    verdict?: string;
    previousHead?: string;
    currentHead?: string;
    createdAt?: string;
    summary?: string;
  };
  pr?: {
    prFound?: boolean;
    id?: string | number | null;
    title?: string | null;
    sourceBranch?: string | null;
    targetBranch?: string | null;
  };
  filesCount: number;
  /** ISO timestamp of the newest output file (for sorting "last run"). */
  updatedAt: string;
}

async function readJson<T = Record<string, unknown>>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function mtimeMs(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else if (ent.isFile()) n += 1;
    }
  };
  await walk(dir);
  return n;
}

async function buildItem(
  config: AppConfig,
  outputsRoot: string,
  issueKey: string,
  repoId: string,
): Promise<HistoryItem | null> {
  const dir = outputDir(outputsRoot, issueKey, repoId);
  const reviewFile = path.join(dir, OUTPUT_FILES.reviewJson);
  const followupFile = path.join(dir, LATEST_FOLLOWUP_FILES.json);
  const prFile = path.join(dir, OUTPUT_FILES.pr);

  const review = await readJson(reviewFile);
  const followup = await readJson(followupFile);
  const pr = await readJson(prFile);

  // Only surface issue/repo dirs that actually hold a run.
  if (!review && !followup && !pr) return null;

  const reviewMtime = await mtimeMs(reviewFile);
  const followupMtime = await mtimeMs(followupFile);
  const prMtime = await mtimeMs(prFile);
  const updatedMs = Math.max(reviewMtime, followupMtime, prMtime, await mtimeMs(dir));

  const followupHead = (followup?.checkedHead as Record<string, unknown>) ?? {};

  return {
    issueKey,
    repoId,
    outputPath: path.relative(config.projectRoot, dir).split(path.sep).join('/'),
    latestReview: review
      ? {
          verdict: (review.verdict as string) ?? undefined,
          head: ((review.checkedHead as Record<string, unknown>)?.head as string) ?? undefined,
          createdAt: reviewMtime ? new Date(reviewMtime).toISOString() : undefined,
          summary: (review.summary as string) ?? undefined,
        }
      : undefined,
    latestFollowup: followup
      ? {
          verdict: (followup.verdict as string) ?? undefined,
          previousHead: (followupHead.previousHead as string) ?? undefined,
          currentHead: (followupHead.currentHead as string) ?? undefined,
          createdAt: followupMtime ? new Date(followupMtime).toISOString() : undefined,
          summary: (followup.summary as string) ?? undefined,
        }
      : undefined,
    pr: pr
      ? {
          prFound: (pr.prFound as boolean) ?? false,
          id: (pr.id as string | number | null) ?? null,
          title: (pr.title as string) ?? null,
          sourceBranch: (pr.sourceBranch as string) ?? null,
          targetBranch: (pr.targetBranch as string) ?? null,
        }
      : undefined,
    filesCount: await countFiles(dir),
    updatedAt: new Date(updatedMs || Date.now()).toISOString(),
  };
}

/**
 * Scan the outputs directory and return one entry per issue+repo that has a run,
 * newest first. Read-only; never throws (a missing outputs dir yields []).
 */
export async function listHistory(config: AppConfig): Promise<HistoryItem[]> {
  const outputsRoot = path.resolve(config.root.outputsDir);
  let issueDirs: import('node:fs').Dirent[];
  try {
    issueDirs = await fs.readdir(outputsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: HistoryItem[] = [];
  for (const issueEnt of issueDirs) {
    if (!issueEnt.isDirectory() || !ISSUE_KEY_RE.test(issueEnt.name)) continue;
    const issueKey = issueEnt.name;
    let repoDirs: import('node:fs').Dirent[];
    try {
      repoDirs = await fs.readdir(path.join(outputsRoot, issueKey), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const repoEnt of repoDirs) {
      if (!repoEnt.isDirectory()) continue;
      const item = await buildItem(config, outputsRoot, issueKey, repoEnt.name);
      if (item) items.push(item);
    }
  }

  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return items;
}
