/**
 * Zod schema for what the Claude "memory curator" / "bugfix learning" prompts
 * must return. Mirrors the review-result parsing style: tolerant JSON
 * extraction (fences / trailing prose) + strict shape validation.
 */

import { z } from 'zod';
import { extractJsonObject } from '../review/review.schema';

export const MemoryProposalTypeSchema = z.enum([
  'global_rule',
  'project_rule',
  'repo_rule',
  'lesson',
  'accepted_exception',
  'false_positive',
  'bugfix_analysis',
]);

export const MemoryProposalItemSchema = z.object({
  id: z.string().min(1),
  type: MemoryProposalTypeSchema,
  title: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
  appliesTo: z
    .object({
      projects: z.array(z.string()).optional(),
      repos: z.array(z.string()).optional(),
      issueKeys: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    })
    .default({}),
  summary: z.string().default(''),
  evidence: z.array(z.string()).default([]),
  rootCause: z.string().optional(),
  futureReviewRule: z.string().optional(),
  doNotOverApply: z.string().optional(),
  /** Full markdown body of the future memory file (without frontmatter). */
  markdown: z.string().min(1),
});

export const MemoryProposalResultSchema = z.object({
  proposals: z.array(MemoryProposalItemSchema).default([]),
});

export type MemoryProposalItem = z.infer<typeof MemoryProposalItemSchema>;
export type MemoryProposalResult = z.infer<typeof MemoryProposalResultSchema>;

export interface ParseProposalOutcome {
  ok: boolean;
  result?: MemoryProposalResult;
  error?: string;
}

export function parseMemoryProposalResult(text: string): ParseProposalOutcome {
  const json = extractJsonObject(text);
  if (json == null) return { ok: false, error: 'No JSON object found in model output.' };
  const parsed = MemoryProposalResultSchema.safeParse(json);
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
