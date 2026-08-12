/**
 * Saved JQL queries, persisted to `config/jql-queries.json` (no database).
 *
 * The file holds `{ "queries": SavedJqlQuery[] }`. A missing file is created
 * empty on first read. Tokens are never stored here — only the JQL text the
 * user typed. Pure collection helpers (add/patch/drop, slug/id) are exported so
 * they can be unit-tested without touching the filesystem.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { AppConfig } from '../../config/types';

/** Location of the saved-queries file, relative to the project root. */
export const JQL_QUERIES_FILE = 'config/jql-queries.json';

export interface SavedJqlQuery {
  id: string;
  name: string;
  jql: string;
  createdAt: string;
  updatedAt: string;
}

export interface JqlQueriesDoc {
  queries: SavedJqlQuery[];
}

/** Domain error carrying an HTTP status the API layer can reuse. */
export class JqlQueryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'JqlQueryError';
  }
}

/** kebab-case slug from a human name: ascii, lowercase, collapsed dashes. */
export function slugify(name: string): string {
  const slug = (name ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'query';
}

/**
 * A readable id derived from the name. Uses the bare slug when it is free and
 * only appends a numeric suffix (`-2`, `-3`, …) to avoid colliding with an
 * existing id. Deterministic given the same `taken` set.
 */
export function makeQueryId(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const base = slugify(name);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/* ------------------------- pure collection helpers ----------------------- */

export function addQuery(
  doc: JqlQueriesDoc,
  input: { name: string; jql: string },
  opts: { id: string; now: string },
): { doc: JqlQueriesDoc; query: SavedJqlQuery } {
  const query: SavedJqlQuery = {
    id: opts.id,
    name: input.name.trim(),
    jql: input.jql.trim(),
    createdAt: opts.now,
    updatedAt: opts.now,
  };
  return { doc: { queries: [...doc.queries, query] }, query };
}

export function patchQuery(
  doc: JqlQueriesDoc,
  id: string,
  patch: { name?: string; jql?: string },
  opts: { now: string },
): { doc: JqlQueriesDoc; query: SavedJqlQuery } {
  const idx = doc.queries.findIndex((q) => q.id === id);
  if (idx < 0) throw new JqlQueryError(`Saved query "${id}" not found.`, 404);
  const prev = doc.queries[idx];
  const query: SavedJqlQuery = {
    ...prev,
    name: patch.name?.trim() || prev.name,
    jql: patch.jql?.trim() || prev.jql,
    updatedAt: opts.now,
  };
  const queries = [...doc.queries];
  queries[idx] = query;
  return { doc: { queries }, query };
}

export function dropQuery(
  doc: JqlQueriesDoc,
  id: string,
): { doc: JqlQueriesDoc; removed: boolean } {
  const queries = doc.queries.filter((q) => q.id !== id);
  return { doc: { queries }, removed: queries.length !== doc.queries.length };
}

/* ----------------------------- file-backed ------------------------------ */

export function queriesFilePath(config: AppConfig): string {
  return path.join(config.projectRoot, 'config', 'jql-queries.json');
}

/** Tolerantly coerce arbitrary JSON into a well-formed doc (skip junk rows). */
function coerceDoc(parsed: unknown): JqlQueriesDoc {
  const arr = (parsed as { queries?: unknown } | null)?.queries;
  if (!Array.isArray(arr)) return { queries: [] };
  const queries = arr
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object')
    .map((q) => ({
      id: String(q.id ?? ''),
      name: String(q.name ?? ''),
      jql: String(q.jql ?? ''),
      createdAt: String(q.createdAt ?? ''),
      updatedAt: String(q.updatedAt ?? ''),
    }))
    .filter((q) => q.id && q.name && q.jql);
  return { queries };
}

/** Read the saved-queries doc, creating an empty file if none exists yet. */
export async function loadQueriesDoc(config: AppConfig): Promise<JqlQueriesDoc> {
  const file = queriesFilePath(config);
  try {
    return coerceDoc(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const empty: JqlQueriesDoc = { queries: [] };
      await writeQueriesDoc(config, empty);
      return empty;
    }
    // Corrupt JSON: never crash the server; start empty without clobbering the
    // file, so the user can inspect/fix it manually.
    return { queries: [] };
  }
}

export async function writeQueriesDoc(config: AppConfig, doc: JqlQueriesDoc): Promise<void> {
  const file = queriesFilePath(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

export async function listQueries(config: AppConfig): Promise<SavedJqlQuery[]> {
  return (await loadQueriesDoc(config)).queries;
}

export async function createQuery(
  config: AppConfig,
  input: { name: string; jql: string },
  opts: { now?: string } = {},
): Promise<SavedJqlQuery> {
  const name = (input.name ?? '').trim();
  const jql = (input.jql ?? '').trim();
  if (!name) throw new JqlQueryError('Query name is required.');
  if (!jql) throw new JqlQueryError('JQL is required.');
  const doc = await loadQueriesDoc(config);
  const id = makeQueryId(
    name,
    doc.queries.map((q) => q.id),
  );
  const now = opts.now ?? new Date().toISOString();
  const { doc: next, query } = addQuery(doc, { name, jql }, { id, now });
  await writeQueriesDoc(config, next);
  return query;
}

export async function updateQuery(
  config: AppConfig,
  id: string,
  patch: { name?: string; jql?: string },
  opts: { now?: string } = {},
): Promise<SavedJqlQuery> {
  const doc = await loadQueriesDoc(config);
  const now = opts.now ?? new Date().toISOString();
  const { doc: next, query } = patchQuery(doc, id, patch, { now });
  await writeQueriesDoc(config, next);
  return query;
}

export async function deleteQuery(config: AppConfig, id: string): Promise<boolean> {
  const doc = await loadQueriesDoc(config);
  const { doc: next, removed } = dropQuery(doc, id);
  if (removed) await writeQueriesDoc(config, next);
  return removed;
}
