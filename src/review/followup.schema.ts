import { z } from 'zod';
import { extractJsonObject } from './review.schema';

/**
 * Schema for the follow-up review result. A follow-up is NOT a fresh review: it
 * checks whether the previous review's findings were closed, so its shape tracks
 * per-item resolution (fixed / answered / still-open) rather than a flat blocker
 * list. Fields are lenient (defaults applied) so the model's JSON validates
 * robustly; the CLI overrides `checkedHead`/`previousReview` with real git data.
 */

export const FollowupVerdictSchema = z.enum(['APPROVE', 'HOLD', 'DECLINE', 'STOP']);

export const FollowupItemStatusSchema = z.enum([
  'fixed',
  'not_fixed',
  'answered_accepted',
  'answered_rejected',
  'needs_clarification',
  'not_applicable',
  'unknown',
]);

export const FollowupPreviousSchema = z.object({
  verdict: z.string().optional(),
  head: z.string().optional(),
  source: z.string().optional(),
});

export const FollowupCheckedHeadSchema = z.object({
  repoId: z.string().default(''),
  branch: z.string().default(''),
  baseBranch: z.string().default(''),
  previousHead: z.string().optional(),
  currentHead: z.string().default(''),
  prId: z.union([z.string(), z.number()]).optional(),
});

export const FollowupResolvedItemSchema = z.object({
  title: z.string(),
  previousEvidence: z.string().optional(),
  status: FollowupItemStatusSchema.default('unknown'),
  developerResponse: z.string().optional(),
  currentEvidence: z.string().default(''),
  conclusion: z.string().default(''),
});

export const FollowupStillOpenItemSchema = z.object({
  title: z.string(),
  status: FollowupItemStatusSchema.default('not_fixed'),
  evidence: z.string().default(''),
  requiredAction: z.string().default(''),
});

export const FollowupNewFindingSchema = z.object({
  title: z.string(),
  level: z.enum(['low', 'medium', 'high']).default('medium'),
  evidence: z.string().default(''),
  whyItMatters: z.string().default(''),
});

export const FollowupReviewResultSchema = z.object({
  verdict: FollowupVerdictSchema,
  summary: z.string().default(''),
  previousReview: FollowupPreviousSchema.default({}),
  checkedHead: FollowupCheckedHeadSchema.default({}),
  resolvedItems: z.array(FollowupResolvedItemSchema).default([]),
  stillOpenItems: z.array(FollowupStillOpenItemSchema).default([]),
  newFindings: z.array(FollowupNewFindingSchema).default([]),
  questionsForDeveloper: z.array(z.string()).default([]),
  bitbucketComment: z.string().default(''),
});

export type FollowupVerdict = z.infer<typeof FollowupVerdictSchema>;
export type FollowupItemStatus = z.infer<typeof FollowupItemStatusSchema>;
export type FollowupCheckedHead = z.infer<typeof FollowupCheckedHeadSchema>;
export type FollowupResolvedItem = z.infer<typeof FollowupResolvedItemSchema>;
export type FollowupStillOpenItem = z.infer<typeof FollowupStillOpenItemSchema>;
export type FollowupNewFinding = z.infer<typeof FollowupNewFindingSchema>;
export type FollowupReviewResult = z.infer<typeof FollowupReviewResultSchema>;

export interface ParseFollowupOutcome {
  ok: boolean;
  result?: FollowupReviewResult;
  error?: string;
}

/** Extract + validate a FollowupReviewResult from raw model text. */
export function parseFollowupResult(text: string): ParseFollowupOutcome {
  const json = extractJsonObject(text);
  if (json == null) {
    return { ok: false, error: 'No JSON object found in model output.' };
  }
  const parsed = FollowupReviewResultSchema.safeParse(json);
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
