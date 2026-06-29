import { z } from 'zod';

export const ReviewVerdictSchema = z.enum(['APPROVE', 'HOLD', 'DECLINE', 'STOP']);

export const CheckedHeadSchema = z.object({
  repoId: z.string().default(''),
  branch: z.string().default(''),
  head: z.string().default(''),
  lastCommit: z.string().default(''),
  syncStatus: z.string().optional(),
});

export const BlockerSchema = z.object({
  title: z.string(),
  file: z.string().optional(),
  evidence: z.string().default(''),
  whyItMatters: z.string().default(''),
});

export const RiskSchema = z.object({
  title: z.string(),
  level: z.enum(['low', 'medium', 'high']).default('medium'),
  evidence: z.string().default(''),
});

export const ReviewResultSchema = z.object({
  verdict: ReviewVerdictSchema,
  summary: z.string().default(''),
  checkedHead: CheckedHeadSchema.default({}),
  blockers: z.array(BlockerSchema).default([]),
  risks: z.array(RiskSchema).default([]),
  questionsForDeveloper: z.array(z.string()).default([]),
  bitbucketComment: z.string().default(''),
});

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type CheckedHead = z.infer<typeof CheckedHeadSchema>;
export type Blocker = z.infer<typeof BlockerSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/**
 * Try to pull a single JSON object out of arbitrary model output: handles raw
 * JSON, ```json fenced blocks, and prose with one or more embedded objects
 * (e.g. a long analysis followed by the ReviewResult). Among embedded objects,
 * the one containing a "verdict" key is preferred so a prose preamble that also
 * contains `{}` in code snippets does not derail extraction.
 */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;

  const trimmed = text.trim();

  // 1) Direct parse.
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }

  // 2) Fenced ```json ... ``` blocks (try each, last first).
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(fences[i][1].trim());
    } catch {
      /* fall through */
    }
  }

  // 3) Scan every balanced { ... } region (string/escape aware). Prefer a
  //    ReviewResult (has "verdict"); otherwise fall back to the last object.
  const objects = scanBalancedObjects(trimmed);
  let fallback: unknown | null = null;
  for (const obj of objects) {
    if (obj && typeof obj === 'object') {
      if ('verdict' in (obj as Record<string, unknown>)) return obj;
      fallback = obj;
    }
  }
  return fallback;
}

/** Every balanced { ... } region that parses as JSON, in start order. */
function scanBalancedObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === '{') {
        depth += 1;
      } else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            out.push(JSON.parse(text.slice(i, j + 1)));
          } catch {
            /* not valid JSON; skip */
          }
          break;
        }
      }
    }
  }
  return out;
}

export interface ParseReviewOutcome {
  ok: boolean;
  result?: ReviewResult;
  error?: string;
}

/** Extract + validate a ReviewResult from raw model text. */
export function parseReviewResult(text: string): ParseReviewOutcome {
  const json = extractJsonObject(text);
  if (json == null) {
    return { ok: false, error: 'No JSON object found in model output.' };
  }
  const parsed = ReviewResultSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, result: parsed.data };
}
