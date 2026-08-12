/**
 * File-backed store for the Review Memory Engine.
 *
 * Layout (under `<projectRoot>/memory`, configurable via root.memoryDir):
 *
 *   global/                 — global rules (e.g. review-principles.md)
 *   projects/               — per-project rules (SC.md, WEBSITE.md, ...)
 *   repos/                  — per-repo rules
 *   decisions/              — recorded decisions
 *   lessons/                — approved lessons / exceptions / false positives
 *   proposals/pending/      — generated proposals awaiting human review
 *   proposals/approved/     — approved proposals that stayed in place
 *   proposals/rejected/     — rejected proposals (kept for the record)
 *   index.json              — generated index (memory reindex)
 *
 * The folder is a storage convention only: retrieval and listing work off each
 * file's frontmatter (id/type/status/appliesTo), never off its location.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../config/types';
import { extractTitle, parseFrontmatter, serializeFrontmatter } from './frontmatter';
import {
  MEMORY_CONFIDENCES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  MemoryConfidence,
  MemoryError,
  MemoryIndexFile,
  MemoryIndexItem,
  MemoryStatus,
  MemoryType,
  ScannedMemoryItem,
} from './types';

export const MEMORY_DIRS = [
  'global',
  'projects',
  'repos',
  'decisions',
  'lessons',
  'proposals/pending',
  'proposals/approved',
  'proposals/rejected',
] as const;

export const MEMORY_INDEX_FILE = 'index.json';

/** Absolute memory root for a config (defaults to <projectRoot>/memory). */
export function memoryRoot(config: AppConfig): string {
  const dir = config.root.memoryDir ?? path.join(config.projectRoot, 'memory');
  return path.resolve(dir);
}

/** kebab-case id from a free-form name. */
export function slugifyId(name: string): string {
  const slug = (name ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'memory-item';
}

/** `base`, or `base-2`, `base-3`… when taken. Deterministic for a given set. */
export function uniqueMemoryId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Parse one markdown file into a scanned item; null when it is not memory. */
export function parseMemoryFile(
  markdown: string,
  absPath: string,
  projectRoot: string,
): ScannedMemoryItem | null {
  const { data, body } = parseFrontmatter(markdown);
  if (!data) return null;
  const id = String(data.id ?? '').trim();
  const type = data.type;
  if (!id || !MEMORY_TYPES.includes(type as MemoryType)) return null;

  const applies = (data.appliesTo ?? {}) as Record<string, unknown>;
  const source = (data.source ?? undefined) as ScannedMemoryItem['source'];
  return {
    id,
    type: type as MemoryType,
    status: oneOf<MemoryStatus>(data.status, MEMORY_STATUSES, 'draft'),
    confidence: oneOf<MemoryConfidence>(data.confidence, MEMORY_CONFIDENCES, 'medium'),
    title: String(data.title ?? '').trim() || extractTitle(body) || id,
    path: path.relative(projectRoot, absPath).split(path.sep).join('/'),
    projects: asStringArray(applies.projects).map((p) => p.toUpperCase()),
    repos: asStringArray(applies.repos),
    issueKeys: asStringArray(applies.issueKeys).map((k) => k.toUpperCase()),
    tags: asStringArray(applies.tags),
    createdAt: data.createdAt ? String(data.createdAt) : undefined,
    updatedAt: data.updatedAt ? String(data.updatedAt) : undefined,
    source,
    absPath,
    body,
  };
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkMarkdownFiles(abs)));
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * Scan the memory folder for valid memory files. Always live (never trusts a
 * stale index). Duplicate ids keep the first occurrence (path order) and are
 * reported in `warnings`.
 */
export async function scanMemory(
  config: AppConfig,
): Promise<{ items: ScannedMemoryItem[]; warnings: string[] }> {
  const root = memoryRoot(config);
  const files = (await walkMarkdownFiles(root)).sort();
  const items: ScannedMemoryItem[] = [];
  const warnings: string[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const item = parseMemoryFile(text, file, config.projectRoot);
    if (!item) continue;
    const prev = seen.get(item.id);
    if (prev) {
      warnings.push(`Duplicate memory id "${item.id}" in ${item.path} (kept ${prev}).`);
      continue;
    }
    seen.set(item.id, item.path);
    items.push(item);
  }
  return { items, warnings };
}

function toIndexItem(item: ScannedMemoryItem): MemoryIndexItem {
  const { absPath: _abs, body: _body, ...index } = item;
  return index;
}

/** Rebuild memory/index.json from a live scan. Returns the written index. */
export async function reindexMemory(config: AppConfig): Promise<MemoryIndexFile> {
  const root = memoryRoot(config);
  const { items } = await scanMemory(config);
  const index: MemoryIndexFile = {
    generatedAt: new Date().toISOString(),
    items: items.map(toIndexItem),
  };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, MEMORY_INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

export interface MemoryListFilters {
  project?: string;
  repo?: string;
  type?: string;
  status?: string;
}

/** Filtered view over the scanned items (used by CLI list and the API). */
export function filterMemoryItems<T extends MemoryIndexItem>(
  items: T[],
  filters: MemoryListFilters = {},
): T[] {
  return items.filter((it) => {
    if (filters.type && it.type !== filters.type) return false;
    if (filters.status && it.status !== filters.status) return false;
    if (filters.project && !it.projects.includes(filters.project.toUpperCase())) return false;
    if (filters.repo && !it.repos.includes(filters.repo)) return false;
    return true;
  });
}

/** Case-insensitive search across id / title / tags / body. */
export function searchMemoryItems(items: ScannedMemoryItem[], query: string): ScannedMemoryItem[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [];
  return items.filter(
    (it) =>
      it.id.toLowerCase().includes(q) ||
      it.title.toLowerCase().includes(q) ||
      it.tags.some((t) => t.toLowerCase().includes(q)) ||
      it.body.toLowerCase().includes(q),
  );
}

/** Find one item by id (live scan). Throws MemoryError(404) when missing. */
export async function findMemoryItemById(config: AppConfig, id: string): Promise<ScannedMemoryItem> {
  const { items } = await scanMemory(config);
  const item = items.find((it) => it.id === id);
  if (!item) throw new MemoryError(`Memory item "${id}" not found.`, 404);
  return item;
}

/** Rewrite an item's frontmatter fields in place (status changes etc.). */
export async function patchMemoryFile(
  absPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const text = await fs.readFile(absPath, 'utf8');
  const { data, body } = parseFrontmatter(text);
  if (!data) throw new MemoryError(`File has no frontmatter: ${absPath}`, 500);
  await fs.writeFile(absPath, serializeFrontmatter({ ...data, ...patch }, body), 'utf8');
}

/* ------------------------------ memory init ------------------------------ */

export const GLOBAL_PRINCIPLES_ID = 'global-review-principles';

const GLOBAL_PRINCIPLES_MD = `---
id: ${GLOBAL_PRINCIPLES_ID}
type: global_rule
status: approved
confidence: high
appliesTo:
  projects: []
  repos: []
  tags: ["review", "process"]
---

# Global review principles

## Rules

- Do not treat a developer response as a fix without code evidence.
- Separate blocker, risk, minor, and question.
- If API contract is unclear, ask for clarification instead of guessing.
- Do not block on style-only issues unless they create a real maintenance or regression risk.
- In followup review, verify delta from previous HEAD to current HEAD.
- If a task returns as bugfix after review, analyze the missed pattern.
`;

export interface MemoryInitResult {
  root: string;
  createdDirs: string[];
  createdFiles: string[];
  skipped: string[];
}

/** Create the memory folder structure + seed principles + index (idempotent). */
export async function initMemory(config: AppConfig): Promise<MemoryInitResult> {
  const root = memoryRoot(config);
  const createdDirs: string[] = [];
  const createdFiles: string[] = [];
  const skipped: string[] = [];

  for (const rel of MEMORY_DIRS) {
    const dir = path.join(root, rel);
    try {
      await fs.access(dir);
      skipped.push(rel);
    } catch {
      await fs.mkdir(dir, { recursive: true });
      createdDirs.push(rel);
    }
  }

  const seed = path.join(root, 'global', 'review-principles.md');
  try {
    await fs.access(seed);
    skipped.push('global/review-principles.md');
  } catch {
    const now = new Date().toISOString();
    const { data, body } = parseFrontmatter(GLOBAL_PRINCIPLES_MD);
    await fs.writeFile(
      seed,
      serializeFrontmatter({ ...(data ?? {}), createdAt: now, updatedAt: now }, body),
      'utf8',
    );
    createdFiles.push('global/review-principles.md');
  }

  await reindexMemory(config);
  return { root, createdDirs, createdFiles, skipped };
}
