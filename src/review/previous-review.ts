import path from 'node:path';
import { pathExists, readJson, readText } from '../utils/fs';
import { OUTPUT_FILES, outputFile } from '../utils/paths';

/**
 * A previous review, normalized from either review.json (primary) or review.md
 * (best-effort fallback). The follow-up flow needs the prior verdict, the HEAD
 * that was checked, and the list of items (blockers/risks/questions) the new
 * review should verify were closed.
 */
export interface PreviousReview {
  /** Where it came from: a file path, so the model can be told the provenance. */
  source: string;
  format: 'json' | 'markdown';
  verdict?: string;
  head?: string;
  branch?: string;
  repoId?: string;
  summary?: string;
  blockers: Array<{ title: string; file?: string; evidence?: string }>;
  risks: Array<{ title: string; level?: string; evidence?: string }>;
  questionsForDeveloper: string[];
  bitbucketComment?: string;
  raw: unknown;
}

/** Raised when no previous review can be located and no --from-head was given. */
export class PreviousReviewNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviousReviewNotFoundError';
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Normalize a parsed review.json object into a PreviousReview. */
export function parsePreviousReviewJson(obj: unknown, source: string): PreviousReview {
  const o = (obj ?? {}) as Record<string, any>;
  const head = o.checkedHead ?? {};
  const blockers = Array.isArray(o.blockers)
    ? o.blockers.map((b: any) => ({
        title: String(b?.title ?? ''),
        file: asString(b?.file),
        evidence: asString(b?.evidence),
      }))
    : [];
  const risks = Array.isArray(o.risks)
    ? o.risks.map((r: any) => ({
        title: String(r?.title ?? ''),
        level: asString(r?.level),
        evidence: asString(r?.evidence),
      }))
    : [];
  const questionsForDeveloper = Array.isArray(o.questionsForDeveloper)
    ? o.questionsForDeveloper.map((q: any) => String(q)).filter(Boolean)
    : [];

  return {
    source,
    format: 'json',
    verdict: asString(o.verdict),
    head: asString(head.head),
    branch: asString(head.branch),
    repoId: asString(head.repoId),
    summary: asString(o.summary),
    blockers,
    risks,
    questionsForDeveloper,
    bitbucketComment: asString(o.bitbucketComment),
    raw: obj,
  };
}

/**
 * Best-effort extraction from a rendered review.md. Only the HEAD and verdict are
 * reliably recoverable; the structured items are not, so callers should prefer
 * review.json. Used only when review.json is absent.
 */
export function extractPreviousReviewFromMarkdown(text: string, source: string): PreviousReview {
  const headMatch = /^[-*]\s*HEAD:\s*([0-9a-fA-F]{7,40})/m.exec(text);
  const branchMatch = /^[-*]\s*Branch:\s*(\S+)/m.exec(text);
  const repoMatch = /^[-*]\s*Repo:\s*(\S+)/m.exec(text);
  // Verdict: the non-empty line under a "Вердикт"/"Итог"/"Verdict" heading.
  const verdictMatch =
    /##\s*\d*\.?\s*(?:Вердикт|Итог|Verdict)\s*\n+\s*(APPROVE|HOLD|DECLINE|STOP)/i.exec(text) ||
    /\b(APPROVE|HOLD|DECLINE|STOP)\b/.exec(text);

  return {
    source,
    format: 'markdown',
    verdict: verdictMatch ? verdictMatch[1].toUpperCase() : undefined,
    head: headMatch ? headMatch[1] : undefined,
    branch: branchMatch ? branchMatch[1] : undefined,
    repoId: repoMatch ? repoMatch[1] : undefined,
    summary: undefined,
    blockers: [],
    risks: [],
    questionsForDeveloper: [],
    bitbucketComment: undefined,
    raw: text,
  };
}

export interface LoadPreviousReviewParams {
  outputsDir: string;
  issueKey: string;
  repoId: string;
  /** Explicit path to a review.json or review.md (overrides the default lookup). */
  previousPath?: string;
}

/**
 * Locate and parse the previous review.
 * 1. `previousPath` if given (json or md, decided by extension/content).
 * 2. outputs/<issueKey>/<repoId>/review.json
 * 3. outputs/<issueKey>/<repoId>/review.md (best-effort)
 * 4. null if none.
 */
export async function loadPreviousReview(
  params: LoadPreviousReviewParams,
): Promise<PreviousReview | null> {
  const { outputsDir, issueKey, repoId, previousPath } = params;

  if (previousPath) {
    if (!(await pathExists(previousPath))) {
      throw new PreviousReviewNotFoundError(
        `--previous path does not exist: ${previousPath}`,
      );
    }
    return parseFromFile(previousPath);
  }

  const jsonPath = outputFile(outputsDir, issueKey, repoId, OUTPUT_FILES.reviewJson);
  if (await pathExists(jsonPath)) {
    const parsed = await parseFromFile(jsonPath);
    if (parsed) return parsed;
  }

  const mdPath = outputFile(outputsDir, issueKey, repoId, OUTPUT_FILES.reviewMd);
  if (await pathExists(mdPath)) {
    return parseFromFile(mdPath);
  }

  return null;
}

async function parseFromFile(file: string): Promise<PreviousReview | null> {
  const isMd = file.toLowerCase().endsWith('.md');
  if (isMd) {
    const text = await readText(file);
    return extractPreviousReviewFromMarkdown(text, file);
  }
  // Treat everything else as JSON; if it fails, fall back to markdown parsing.
  try {
    const obj = await readJson(file);
    return parsePreviousReviewJson(obj, file);
  } catch {
    const text = await readText(file).catch(() => '');
    if (!text.trim()) return null;
    return extractPreviousReviewFromMarkdown(text, file);
  }
}

/** --from-head wins; otherwise use the previous review's checked HEAD. */
export function resolvePreviousHead(
  previous: PreviousReview | null,
  fromHead?: string,
): string | undefined {
  const manual = fromHead?.trim();
  if (manual) return manual;
  return previous?.head;
}

/** The exact, secret-free guidance shown when no previous review is available. */
export function formatPreviousReviewNotFound(issueKey: string, repoId: string): string {
  return (
    `Previous review not found.\n\n` +
    `Run initial review first:\n` +
    `nls-review run ${issueKey} --repo ${repoId}\n\n` +
    `Or pass:\n` +
    `nls-review followup ${issueKey} --repo ${repoId} --from-head <hash>`
  );
}
