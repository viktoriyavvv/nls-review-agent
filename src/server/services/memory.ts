/**
 * API-facing wrapper over the Review Memory Engine core. All reads are live
 * scans of the memory folder (never a stale index); all responses carry only
 * markdown/frontmatter data — no tokens or env values ever enter these
 * payloads. Mutations (approve/reject/deprecate/reindex) delegate to the core
 * and end with a rebuilt index.
 */

import fs from 'node:fs/promises';
import { AppConfig } from '../../config/types';
import {
  filterMemoryItems,
  findMemoryItemById,
  reindexMemory,
  scanMemory,
  searchMemoryItems,
  MemoryListFilters,
} from '../../memory/store';
import {
  approveProposal,
  deprecateMemoryItem,
  rejectProposal,
} from '../../memory/proposals';
import { MemoryIndexItem } from '../../memory/types';

export interface MemoryItemDetail {
  item: MemoryIndexItem;
  /** Full file content (frontmatter + body) for the read-only viewer. */
  markdown: string;
}

function publicItem(item: MemoryIndexItem & { absPath?: string; body?: string }): MemoryIndexItem {
  const { absPath: _abs, body: _body, ...rest } = item as MemoryIndexItem & {
    absPath?: string;
    body?: string;
  };
  return rest;
}

/** All memory items (every status — the GUI groups by status/type). */
export async function listMemory(
  config: AppConfig,
  filters: MemoryListFilters = {},
): Promise<{ items: MemoryIndexItem[]; warnings: string[] }> {
  const { items, warnings } = await scanMemory(config);
  return { items: filterMemoryItems(items, filters).map(publicItem), warnings };
}

export async function searchMemory(
  config: AppConfig,
  query: string,
): Promise<{ items: MemoryIndexItem[] }> {
  const { items } = await scanMemory(config);
  return { items: searchMemoryItems(items, query).map(publicItem) };
}

export async function getMemoryItem(config: AppConfig, id: string): Promise<MemoryItemDetail> {
  const item = await findMemoryItemById(config, id);
  const markdown = await fs.readFile(item.absPath, 'utf8');
  return { item: publicItem(item), markdown };
}

export async function reindex(config: AppConfig): Promise<{ count: number; generatedAt: string }> {
  const index = await reindexMemory(config);
  return { count: index.items.length, generatedAt: index.generatedAt };
}

export const memoryActions = {
  approve: approveProposal,
  reject: rejectProposal,
  deprecate: deprecateMemoryItem,
};
