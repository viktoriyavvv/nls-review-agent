/**
 * Memory retrieval for review / follow-up runs.
 *
 * Given the issue (key/project/repo) and the collected diff, select APPROVED
 * memory items only, rank them (exact repo > exact project > diff-tag matches >
 * confidence > recency), cap the volume (20 items / 12 000 chars), and render a
 * `## Memory Context` markdown block plus the `memory-used.json` payload.
 *
 * Safety: pending / rejected / deprecated / draft items are never selected;
 * memory is additional context only — the prompts instruct the model that
 * evidence must still come from the current code/diff/Jira.
 */

import { AppConfig } from '../config/types';
import { scanMemory } from './store';
import { MemoryType, MemoryUsedItem, ScannedMemoryItem } from './types';

export const MAX_MEMORY_ITEMS = 20;
export const MAX_MEMORY_CONTEXT_CHARS = 12_000;
/** Per-item body cap so one long lesson cannot eat the whole budget. */
export const MAX_ITEM_CHARS = 3_500;
/** Tags shorter than this are too noisy to match against a diff. */
const MIN_TAG_LENGTH = 3;

export interface MemoryQuery {
  issueKey: string;
  /** Jira prefix, e.g. "SC". */
  projectKey: string;
  repoId: string;
  /** Diff text (delta + full for follow-ups); used for tag matching. */
  diffText?: string;
  changedFiles?: string[];
}

export interface SelectedMemoryItem {
  item: ScannedMemoryItem;
  matchedTags: string[];
  repoMatch: boolean;
  projectMatch: boolean;
  issueMatch: boolean;
  isGlobal: boolean;
  reason: string;
}

const CONFIDENCE_RANK = { high: 2, medium: 1, low: 0 } as const;

/**
 * Pure selection + ranking over scanned items. Approved-only; an item is
 * relevant when it is a global rule or matches the repo / project / issue key /
 * any tag found in the diff or changed file paths.
 */
export function selectMemoryItems(
  items: ScannedMemoryItem[],
  query: MemoryQuery,
  opts: { maxItems?: number } = {},
): SelectedMemoryItem[] {
  const maxItems = opts.maxItems ?? MAX_MEMORY_ITEMS;
  const haystack = `${(query.changedFiles ?? []).join('\n')}\n${query.diffText ?? ''}`.toLowerCase();
  const projectKey = query.projectKey.toUpperCase();
  const issueKey = query.issueKey.toUpperCase();

  const selected: SelectedMemoryItem[] = [];
  for (const item of items) {
    if (item.status !== 'approved') continue;

    const isGlobal = item.type === 'global_rule';
    const repoMatch = item.repos.includes(query.repoId);
    const projectMatch = item.projects.includes(projectKey);
    const issueMatch = item.issueKeys.includes(issueKey);
    const matchedTags = item.tags.filter(
      (t) => t.trim().length >= MIN_TAG_LENGTH && haystack.includes(t.trim().toLowerCase()),
    );

    if (!isGlobal && !repoMatch && !projectMatch && !issueMatch && matchedTags.length === 0) {
      continue;
    }

    const reasons: string[] = [];
    if (isGlobal) reasons.push('global rule');
    if (issueMatch) reasons.push(`matched issue ${issueKey}`);
    if (repoMatch) reasons.push(`matched repo ${query.repoId}`);
    if (projectMatch) reasons.push(`matched project ${projectKey}`);
    if (matchedTags.length) reasons.push(`diff keywords: ${matchedTags.join(', ')}`);

    selected.push({
      item,
      matchedTags,
      repoMatch,
      projectMatch,
      issueMatch,
      isGlobal,
      reason: reasons.join('; '),
    });
  }

  selected.sort((a, b) => {
    const byIssue = Number(b.issueMatch) - Number(a.issueMatch);
    if (byIssue) return byIssue;
    const byRepo = Number(b.repoMatch) - Number(a.repoMatch);
    if (byRepo) return byRepo;
    const byProject = Number(b.projectMatch) - Number(a.projectMatch);
    if (byProject) return byProject;
    const byTags = b.matchedTags.length - a.matchedTags.length;
    if (byTags) return byTags;
    const byConf = CONFIDENCE_RANK[b.item.confidence] - CONFIDENCE_RANK[a.item.confidence];
    if (byConf) return byConf;
    return (b.item.updatedAt ?? '').localeCompare(a.item.updatedAt ?? '');
  });

  return selected.slice(0, maxItems);
}

/* ------------------------------ rendering ------------------------------ */

const SECTION_ORDER: Array<{ title: (q: MemoryQuery) => string; types: MemoryType[] }> = [
  { title: () => 'Global review principles', types: ['global_rule'] },
  { title: (q) => `Project memory: ${q.projectKey}`, types: ['project_rule'] },
  { title: (q) => `Repo memory: ${q.repoId}`, types: ['repo_rule'] },
  { title: () => 'Decisions', types: ['decision'] },
  { title: () => 'Related lessons', types: ['lesson', 'bugfix_analysis'] },
  { title: () => 'Accepted exceptions', types: ['accepted_exception', 'false_positive'] },
];

export const EMPTY_MEMORY_CONTEXT =
  '## Memory Context\n\nNo approved memory items found for this issue/repo.\n';

function capBody(body: string, max: number): string {
  const b = (body ?? '').trim();
  if (b.length <= max) return b;
  return `${b.slice(0, max)}\n\n> [memory item truncated to ${max} chars]`;
}

export interface RenderedMemoryContext {
  markdown: string;
  used: MemoryUsedItem[];
  /** Items that matched but were dropped by the character budget. */
  dropped: string[];
}

/**
 * Render the `## Memory Context` block, honouring the total character budget.
 * Items keep their selection order inside their sections; whole items are
 * dropped (never mid-truncated below the per-item cap) once the budget is hit.
 */
export function renderMemoryContext(
  selected: SelectedMemoryItem[],
  query: MemoryQuery,
  opts: { maxChars?: number } = {},
): RenderedMemoryContext {
  const maxChars = opts.maxChars ?? MAX_MEMORY_CONTEXT_CHARS;
  if (!selected.length) return { markdown: EMPTY_MEMORY_CONTEXT, used: [], dropped: [] };

  const header =
    '## Memory Context\n\n' +
    'Approved local memory relevant to this change (rules, decisions, lessons from past reviews). ' +
    'Treat it as context, not absolute truth: verify anything relevant against the CURRENT code/diff/Jira.\n';

  let budget = maxChars;
  const used: MemoryUsedItem[] = [];
  const dropped: string[] = [];
  const sections: string[] = [];

  for (const section of SECTION_ORDER) {
    const inSection = selected.filter((s) => section.types.includes(s.item.type));
    if (!inSection.length) continue;
    const parts: string[] = [];
    for (const sel of inSection) {
      if (budget <= 0) {
        dropped.push(sel.item.id);
        continue;
      }
      const body = capBody(sel.item.body, Math.min(MAX_ITEM_CHARS, Math.max(budget, 400)));
      const block = `#### ${sel.item.title}\n_(id: ${sel.item.id}, type: ${sel.item.type}, confidence: ${sel.item.confidence})_\n\n${body}\n`;
      budget -= block.length;
      if (budget < 0 && used.length > 0) {
        // Over budget and we already have content: drop this item entirely.
        budget += block.length;
        dropped.push(sel.item.id);
        continue;
      }
      parts.push(block);
      used.push({
        id: sel.item.id,
        type: sel.item.type,
        confidence: sel.item.confidence,
        path: sel.item.path,
        reason: sel.reason,
      });
    }
    if (parts.length) sections.push(`### ${section.title(query)}\n\n${parts.join('\n')}`);
  }

  if (!used.length) return { markdown: EMPTY_MEMORY_CONTEXT, used: [], dropped };
  return { markdown: `${header}\n${sections.join('\n')}`, used, dropped };
}

/* ------------------------------ top level ------------------------------ */

export interface MemoryContextResult extends RenderedMemoryContext {
  /** Total approved items considered relevant before caps. */
  matchedCount: number;
}

/**
 * Scan + select + render in one call. NEVER throws: any storage error yields
 * the empty context so a broken memory folder can not break a review run.
 */
export async function buildMemoryContext(
  config: AppConfig,
  query: MemoryQuery,
  opts: { maxItems?: number; maxChars?: number } = {},
): Promise<MemoryContextResult> {
  try {
    const { items } = await scanMemory(config);
    const selected = selectMemoryItems(items, query, { maxItems: opts.maxItems });
    const rendered = renderMemoryContext(selected, query, { maxChars: opts.maxChars });
    return { ...rendered, matchedCount: selected.length };
  } catch {
    return { markdown: EMPTY_MEMORY_CONTEXT, used: [], dropped: [], matchedCount: 0 };
  }
}
