import { z } from 'zod';

/**
 * `${ENV}` placeholders expand to "" when the variable is unset. Treat empty
 * strings as "absent" so schema defaults apply.
 */
const emptyToUndefined = (v: unknown): unknown => (v === '' || v == null ? undefined : v);

/* ----------------------------- repos.yml ----------------------------- */

export const RootConfigSchema = z.object({
  reposDir: z.string().default('./repos'),
  worktreesDir: z.string().default('./worktrees'),
  outputsDir: z.string().default('./outputs'),
  locksDir: z.string().default('./locks'),
});

export const JiraConfigSchema = z.object({
  // Empty when .env is not filled; validated by commands that need it (run).
  baseUrl: z.string().default(''),
  email: z.string().default(''),
  apiToken: z.string().default(''),
  // "3" = Jira Cloud (ADF), "2" = Jira Server / Data Center.
  apiVersion: z.enum(['2', '3']).default('3'),
});

export const BitbucketConfigSchema = z.object({
  type: z.enum(['datacenter', 'cloud']).default('datacenter'),
  baseUrl: z.string().default(''),
  username: z.string().default(''),
  token: z.string().default(''),
  /** Bitbucket Cloud workspace (e.g. "nls-kz"); unused by the Data Center client. */
  workspace: z.string().default(''),
});

export const RepoBitbucketSchema = z.object({
  /** Data Center project key. Optional: Cloud addresses repos by workspace, not project. */
  projectKey: z.string().min(1).optional(),
  repoSlug: z.string().min(1),
  /** Bitbucket Cloud workspace override (falls back to global bitbucket.workspace). */
  workspace: z.string().optional(),
});

export const RepoConfigSchema = z.object({
  jiraPrefixes: z.array(z.string().min(1)).min(1),
  path: z.string().min(1),
  defaultBaseBranch: z.string().default('origin/master'),
  reviewProfile: z.string().optional(),
  bitbucket: RepoBitbucketSchema,
});

export const ClaudeConfigSchema = z.object({
  bin: z.preprocess(emptyToUndefined, z.string().default('claude')),
  model: z.preprocess(emptyToUndefined, z.string().default('opus')),
  effort: z.preprocess(emptyToUndefined, z.string().default('max')),
  permissionMode: z.preprocess(
    emptyToUndefined,
    z.string().default('dangerously-skip-permissions'),
  ),
  outputFormat: z.preprocess(emptyToUndefined, z.string().default('json')),
  // Optional. Not set by default — kept for the future. Empty -> no --max-turns.
  maxTurns: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});

export const ReposFileSchema = z.object({
  root: RootConfigSchema.default({}),
  jira: JiraConfigSchema,
  bitbucket: BitbucketConfigSchema,
  claude: ClaudeConfigSchema.default({}),
  repos: z.record(z.string(), RepoConfigSchema),
});

/* ------------------------ review-profiles.yml ------------------------ */

export const ReviewProfileSchema = z.object({
  prompt: z.string().default('prompts/frontend-tl-review.md'),
  outputFormat: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

export const ReviewProfilesFileSchema = z.object({
  default: z.string().default('default'),
  profiles: z.record(z.string(), ReviewProfileSchema).default({}),
});

/* -------------------------- jira-fields.yml -------------------------- */

export const JiraCustomFieldSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const JiraFieldsFileSchema = z.object({
  standardFields: z
    .array(z.string())
    .default([
      'summary',
      'description',
      'status',
      'assignee',
      'reporter',
      'labels',
      'components',
      'fixVersions',
      'issuelinks',
      'attachment',
      'comment',
      'issuetype',
      'priority',
      'created',
      'updated',
    ]),
  customFields: z.array(JiraCustomFieldSchema).default([]),
});

/* ----------------------------- inferred ----------------------------- */

export type RootConfig = z.infer<typeof RootConfigSchema>;
export type JiraConfig = z.infer<typeof JiraConfigSchema>;
export type BitbucketConfig = z.infer<typeof BitbucketConfigSchema>;
export type RepoBitbucket = z.infer<typeof RepoBitbucketSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;
export type ReposFile = z.infer<typeof ReposFileSchema>;
export type ReviewProfile = z.infer<typeof ReviewProfileSchema>;
export type ReviewProfilesFile = z.infer<typeof ReviewProfilesFileSchema>;
export type JiraCustomField = z.infer<typeof JiraCustomFieldSchema>;
export type JiraFieldsFile = z.infer<typeof JiraFieldsFileSchema>;

/** A repo entry enriched with its id and resolved absolute path. */
export interface ResolvedRepo extends RepoConfig {
  id: string;
  absPath: string;
}

/** Fully loaded + resolved application configuration. */
export interface AppConfig {
  projectRoot: string;
  root: {
    reposDir: string;
    worktreesDir: string;
    outputsDir: string;
    locksDir: string;
  };
  jira: JiraConfig;
  bitbucket: BitbucketConfig;
  claude: ClaudeConfig;
  repos: Record<string, ResolvedRepo>;
  profiles: ReviewProfilesFile;
  jiraFields: JiraFieldsFile;
}
