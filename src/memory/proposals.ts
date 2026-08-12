/**
 * Proposal lifecycle: generated memory ALWAYS lands in proposals/pending/ as
 * `status: proposed` and only a human approve() turns it into approved memory
 * (moving lessons/exceptions/false-positives into memory/lessons/). Reject
 * moves it to proposals/rejected/; deprecate flips an approved item's status
 * in place. Every mutation ends with a reindex.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../config/types';
import { serializeFrontmatter } from './frontmatter';
import {
  findMemoryItemById,
  memoryRoot,
  patchMemoryFile,
  reindexMemory,
  scanMemory,
  slugifyId,
  uniqueMemoryId,
} from './store';
import { MemoryProposalItem } from './proposal.schema';
import { MemoryError, MemorySource, ScannedMemoryItem } from './types';

export interface SavedProposal {
  id: string;
  /** Path relative to the project root (forward slashes). */
  path: string;
  type: string;
  title: string;
}

/** Types that move into memory/lessons/ on approve (per spec §8). */
const LESSON_LIKE = new Set(['lesson', 'accepted_exception', 'false_positive']);

/**
 * Persist generated proposals into memory/proposals/pending/ as `proposed`.
 * Ids are slugged and de-duplicated against ALL existing memory ids.
 */
export async function saveProposalsToPending(
  config: AppConfig,
  proposals: MemoryProposalItem[],
  opts: { source?: MemorySource; nowIso?: string } = {},
): Promise<SavedProposal[]> {
  if (!proposals.length) return [];
  const root = memoryRoot(config);
  const pendingDir = path.join(root, 'proposals', 'pending');
  await fs.mkdir(pendingDir, { recursive: true });

  const { items } = await scanMemory(config);
  const taken = new Set(items.map((it) => it.id));
  const now = opts.nowIso ?? new Date().toISOString();
  const saved: SavedProposal[] = [];

  for (const p of proposals) {
    const id = uniqueMemoryId(slugifyId(p.id || p.title), taken);
    taken.add(id);

    const frontmatter: Record<string, unknown> = {
      id,
      type: p.type,
      status: 'proposed',
      confidence: p.confidence,
      appliesTo: {
        projects: (p.appliesTo.projects ?? []).map((x) => x.toUpperCase()),
        repos: p.appliesTo.repos ?? [],
        issueKeys: (p.appliesTo.issueKeys ?? []).map((x) => x.toUpperCase()),
        tags: p.appliesTo.tags ?? [],
      },
      createdAt: now,
      updatedAt: now,
      ...(opts.source ? { source: opts.source } : {}),
      ...(p.summary ? { summary: p.summary } : {}),
    };

    // Ensure the body opens with a title so viewers/search have something to show.
    const body = /^#\s/m.test(p.markdown.trim())
      ? p.markdown.trim()
      : `# ${p.title.trim()}\n\n${p.markdown.trim()}`;

    const file = path.join(pendingDir, `${id}.md`);
    await fs.writeFile(file, serializeFrontmatter(frontmatter, body), 'utf8');
    saved.push({
      id,
      path: path.relative(config.projectRoot, file).split(path.sep).join('/'),
      type: p.type,
      title: p.title,
    });
  }

  await reindexMemory(config);
  return saved;
}

function assertInsideMemory(config: AppConfig, absPath: string): void {
  const root = memoryRoot(config);
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new MemoryError('Memory item path escapes the memory directory.', 400);
  }
}

async function findPendingProposal(config: AppConfig, id: string): Promise<ScannedMemoryItem> {
  const item = await findMemoryItemById(config, id);
  if (item.status !== 'proposed' && item.status !== 'draft') {
    throw new MemoryError(
      `Memory item "${id}" is "${item.status}", not a pending proposal.`,
      409,
    );
  }
  return item;
}

async function moveMemoryFile(
  config: AppConfig,
  item: ScannedMemoryItem,
  destAbs: string,
  patch: Record<string, unknown>,
): Promise<string> {
  assertInsideMemory(config, item.absPath);
  assertInsideMemory(config, destAbs);
  await patchMemoryFile(item.absPath, patch);
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  if (path.resolve(destAbs) !== path.resolve(item.absPath)) {
    await fs.rename(item.absPath, destAbs);
  }
  await reindexMemory(config);
  return path.relative(config.projectRoot, destAbs).split(path.sep).join('/');
}

/**
 * Approve a pending proposal: status → approved; lessons / exceptions /
 * false-positives move to memory/lessons/, everything else to
 * memory/proposals/approved/. From here on retrieval picks it up.
 */
export async function approveProposal(
  config: AppConfig,
  id: string,
  opts: { nowIso?: string } = {},
): Promise<{ id: string; path: string }> {
  const item = await findPendingProposal(config, id);
  const root = memoryRoot(config);
  const destDir = LESSON_LIKE.has(item.type)
    ? path.join(root, 'lessons')
    : path.join(root, 'proposals', 'approved');
  const dest = path.join(destDir, `${item.id}.md`);
  const rel = await moveMemoryFile(config, item, dest, {
    status: 'approved',
    updatedAt: opts.nowIso ?? new Date().toISOString(),
  });
  return { id: item.id, path: rel };
}

/** Reject a pending proposal: status → rejected; file → proposals/rejected/. */
export async function rejectProposal(
  config: AppConfig,
  id: string,
  opts: { nowIso?: string } = {},
): Promise<{ id: string; path: string }> {
  const item = await findPendingProposal(config, id);
  const dest = path.join(memoryRoot(config), 'proposals', 'rejected', `${item.id}.md`);
  const rel = await moveMemoryFile(config, item, dest, {
    status: 'rejected',
    updatedAt: opts.nowIso ?? new Date().toISOString(),
  });
  return { id: item.id, path: rel };
}

/** Deprecate an approved item in place (drops out of retrieval). */
export async function deprecateMemoryItem(
  config: AppConfig,
  id: string,
  opts: { nowIso?: string } = {},
): Promise<{ id: string; path: string }> {
  const item = await findMemoryItemById(config, id);
  if (item.status !== 'approved') {
    throw new MemoryError(`Only approved items can be deprecated ("${id}" is ${item.status}).`, 409);
  }
  assertInsideMemory(config, item.absPath);
  await patchMemoryFile(item.absPath, {
    status: 'deprecated',
    updatedAt: opts.nowIso ?? new Date().toISOString(),
  });
  await reindexMemory(config);
  return { id: item.id, path: item.path };
}
