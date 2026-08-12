/**
 * Minimal YAML-frontmatter reader/writer for memory markdown files.
 * A memory file looks like:
 *
 *   ---
 *   id: some-id
 *   type: lesson
 *   ...
 *   ---
 *
 *   # Title
 *   body...
 *
 * Uses the `yaml` package (already a project dependency for config files).
 */

import YAML from 'yaml';

export interface ParsedMarkdown {
  /** Parsed frontmatter object, or null when the file has none / it is invalid. */
  data: Record<string, unknown> | null;
  /** Markdown body without the frontmatter block. */
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(markdown: string): ParsedMarkdown {
  // Tolerate a UTF-8 BOM: Windows editors (Notepad, PowerShell Set-Content)
  // routinely prepend one, and it must not hide the frontmatter.
  const text = (markdown ?? '').replace(/^﻿/, '');
  const m = FM_RE.exec(text);
  if (!m) return { data: null, body: text };
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = null; // invalid YAML -> treat as a plain markdown file
  }
  return { data, body: text.slice(m[0].length) };
}

/** Serialize frontmatter + body back into a markdown file. */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yamlText = YAML.stringify(data).trimEnd();
  const cleanBody = (body ?? '').replace(/^\s*\n/, '');
  return `---\n${yamlText}\n---\n\n${cleanBody.trimEnd()}\n`;
}

/** First `# Heading` line of a markdown body (used as the item title). */
export function extractTitle(body: string): string | null {
  for (const line of (body ?? '').split('\n')) {
    const m = /^#\s+(.+?)\s*$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}
