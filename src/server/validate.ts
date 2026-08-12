import { z } from 'zod';

/**
 * Request-body validation for action endpoints. Kept separate from Express so
 * it can be unit-tested directly. Issue keys are constrained to the Jira shape;
 * free-text fields used as CLI flags (fromHead, previous) are length-limited
 * and shell-metachar-free as defence in depth (they are still passed to the
 * CLI as an argv array, never via a shell).
 */

const issueKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_]+-\d+$/, 'Expected a Jira key like SC-3563 or WEBSITE-490.');

const repoId = z.string().trim().min(1).max(200);

const safeFlag = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !/[\r\n\0]/.test(v), 'Control characters are not allowed.');

export const RunBodySchema = z.object({
  issueKey,
  repoId: repoId.optional(),
  allowUnmapped: z.boolean().optional().default(false),
  /** false -> pass --no-sync (skip the automatic fetch). */
  sync: z.boolean().optional(),
});

export const FollowupBodySchema = z.object({
  issueKey,
  repoId: repoId.optional(),
  allowUnmapped: z.boolean().optional().default(false),
  fromHead: safeFlag.optional(),
  previous: safeFlag.optional(),
  /** false -> pass --no-sync. */
  sync: z.boolean().optional(),
  /** false -> pass --no-resume (stateless follow-up). */
  resume: z.boolean().optional(),
  /** overrides the saved session id -> --resume-session <id>. */
  resumeSession: safeFlag.optional(),
});

export const CleanBodySchema = z.object({
  issueKey,
  repoId: repoId.optional(),
});

export const SyncParamsSchema = z.object({
  repoId,
});

export const CloneBodySchema = z.object({
  /** false -> pass --no-username (omit the username from the clone URL). */
  useUsername: z.boolean().optional(),
});

export const RemoveLocalBodySchema = z.object({
  /** Required to delete a folder that is not a git repo. */
  force: z.boolean().optional().default(false),
});

/* -------------------------------- jql queue ------------------------------ */

const queryName = z.string().trim().min(1, 'Name is required.').max(200);
const jqlText = z.string().trim().min(1, 'JQL is required.').max(5000);

export const JqlQueryCreateSchema = z.object({
  name: queryName,
  jql: jqlText,
});

export const JqlQueryUpdateSchema = z
  .object({
    name: queryName.optional(),
    jql: jqlText.optional(),
  })
  .refine((d) => d.name !== undefined || d.jql !== undefined, {
    message: 'Provide name or jql to update.',
  });

export const JqlSearchSchema = z.object({
  jql: jqlText,
  maxResults: z.coerce.number().int().positive().max(200).optional(),
});

/* --------------------------------- memory -------------------------------- */

/** Body for POST /api/memory/propose and POST /api/learn/bugfix. */
export const MemoryActionBodySchema = z.object({
  issueKey,
  repoId: repoId.optional(),
});

/** Path param for /api/memory/:id — file-name-safe id, no traversal. */
export const MemoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Invalid memory id.');

export type RunBody = z.infer<typeof RunBodySchema>;
export type FollowupBody = z.infer<typeof FollowupBodySchema>;
export type CleanBody = z.infer<typeof CleanBodySchema>;
export type CloneBody = z.infer<typeof CloneBodySchema>;
export type RemoveLocalBody = z.infer<typeof RemoveLocalBodySchema>;
export type JqlQueryCreateBody = z.infer<typeof JqlQueryCreateSchema>;
export type JqlQueryUpdateBody = z.infer<typeof JqlQueryUpdateSchema>;
export type JqlSearchBody = z.infer<typeof JqlSearchSchema>;

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function validateBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): ValidationResult<z.infer<S>> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
        .join('; '),
    };
  }
  return { ok: true, data: parsed.data };
}
