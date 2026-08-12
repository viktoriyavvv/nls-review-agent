/**
 * Review Memory Engine v1 — shared types.
 *
 * Memory is a set of local markdown files (YAML frontmatter + body) under
 * `memory/`, plus a generated `memory/index.json`. Nothing here talks to
 * Jira/Bitbucket; the engine is read/write LOCAL ONLY, and generated memory
 * always starts as a `proposed` item that a human must approve before it is
 * ever used in a review.
 */

export const MEMORY_TYPES = [
  'global_rule',
  'project_rule',
  'repo_rule',
  'decision',
  'lesson',
  'accepted_exception',
  'false_positive',
  'bugfix_analysis',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = ['draft', 'proposed', 'approved', 'rejected', 'deprecated'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export interface MemoryAppliesTo {
  projects: string[];
  repos: string[];
  issueKeys: string[];
  tags: string[];
}

export interface MemorySource {
  issueKey?: string;
  repoId?: string;
  outputPath?: string;
}

/** One memory item as indexed (frontmatter + derived title/path, no body). */
export interface MemoryIndexItem {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  title: string;
  /** Path relative to the project root, forward slashes. */
  path: string;
  projects: string[];
  repos: string[];
  issueKeys: string[];
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
  source?: MemorySource;
}

export interface MemoryIndexFile {
  generatedAt: string;
  items: MemoryIndexItem[];
}

/** A scanned item = index entry + where it lives + its markdown body. */
export interface ScannedMemoryItem extends MemoryIndexItem {
  absPath: string;
  body: string;
}

/** One entry of outputs/<issue>/<repo>/memory-used.json. */
export interface MemoryUsedItem {
  id: string;
  type: MemoryType;
  confidence: MemoryConfidence;
  path: string;
  reason: string;
}

export interface MemoryUsedFile {
  issueKey: string;
  repoId: string;
  items: MemoryUsedItem[];
}

/** Domain error carrying an HTTP-ish status for the API layer. */
export class MemoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'MemoryError';
  }
}
