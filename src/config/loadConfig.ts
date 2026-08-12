import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import YAML from 'yaml';
import { z } from 'zod';
import {
  AppConfig,
  JiraFieldsFile,
  JiraFieldsFileSchema,
  ReposFileSchema,
  ResolvedRepo,
  ReviewProfilesFile,
  ReviewProfilesFileSchema,
} from './types';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class RepoResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoResolutionError';
  }
}

export interface ParsedIssueKey {
  key: string;
  prefix: string;
  number: string;
}

/** Parse "WEBSITE-123" -> { key, prefix: "WEBSITE", number: "123" }. */
export function parseIssueKey(issueKey: string): ParsedIssueKey {
  const trimmed = (issueKey ?? '').trim();
  const match = /^([A-Za-z][A-Za-z0-9_]+)-(\d+)$/.exec(trimmed);
  if (!match) {
    throw new RepoResolutionError(
      `Invalid Jira issue key: "${issueKey}". Expected format like SC-3749 or WEBSITE-123.`,
    );
  }
  return {
    key: `${match[1].toUpperCase()}-${match[2]}`,
    prefix: match[1].toUpperCase(),
    number: match[2],
  };
}

/** Replace ${VAR} placeholders with values from process.env (missing -> ""). */
export function expandEnv(text: string): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? '');
}

function readYamlFile<S extends z.ZodTypeAny>(file: string, schema: S): z.infer<S> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read config file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(expandEnv(raw));
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${file}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config in ${file}:\n${issues}`);
  }
  return result.data;
}

export interface LoadConfigOptions {
  projectRoot?: string;
}

/**
 * Load .env, repos.yml (required), review-profiles.yml and jira-fields.yml
 * (optional), validate everything and resolve directory/repo paths to absolute.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const projectRoot = options.projectRoot ?? process.cwd();

  dotenv.config({ path: path.join(projectRoot, '.env') });

  const reposFilePath = path.join(projectRoot, 'config', 'repos.yml');
  if (!fs.existsSync(reposFilePath)) {
    throw new ConfigError(
      `Missing config/repos.yml. Run "nls-review init" first, then edit config/repos.yml.`,
    );
  }

  const reposFile = readYamlFile(reposFilePath, ReposFileSchema);

  const profilesFilePath = path.join(projectRoot, 'config', 'review-profiles.yml');
  const profiles: ReviewProfilesFile = fs.existsSync(profilesFilePath)
    ? readYamlFile(profilesFilePath, ReviewProfilesFileSchema)
    : ReviewProfilesFileSchema.parse({});

  const jiraFieldsFilePath = path.join(projectRoot, 'config', 'jira-fields.yml');
  const jiraFields: JiraFieldsFile = fs.existsSync(jiraFieldsFilePath)
    ? readYamlFile(jiraFieldsFilePath, JiraFieldsFileSchema)
    : JiraFieldsFileSchema.parse({});

  const resolveDir = (p: string): string => path.resolve(projectRoot, p);

  const repos: Record<string, ResolvedRepo> = {};
  for (const [id, repo] of Object.entries(reposFile.repos)) {
    repos[id] = {
      ...repo,
      id,
      absPath: resolveDir(repo.path),
    };
  }

  // maxTurns stays optional. Allow CLAUDE_MAX_TURNS env as a fallback even when
  // it is not declared in repos.yml. Empty / non-positive -> undefined (no flag).
  const claude = { ...reposFile.claude };
  if (claude.maxTurns == null) {
    const envTurns = Number(process.env.CLAUDE_MAX_TURNS);
    if (Number.isFinite(envTurns) && envTurns > 0) {
      claude.maxTurns = Math.floor(envTurns);
    }
  }

  return {
    projectRoot,
    root: {
      reposDir: resolveDir(reposFile.root.reposDir),
      worktreesDir: resolveDir(reposFile.root.worktreesDir),
      outputsDir: resolveDir(reposFile.root.outputsDir),
      locksDir: resolveDir(reposFile.root.locksDir),
      memoryDir: resolveDir(reposFile.root.memoryDir),
    },
    jira: reposFile.jira,
    bitbucket: reposFile.bitbucket,
    claude,
    repos,
    profiles,
    jiraFields,
  };
}

export interface RepoSelectionOptions {
  repo?: string;
  allowUnmapped?: boolean;
}

/**
 * Decide which repo to use for an issue key.
 *
 * - No --repo: match by jiraPrefixes. Exactly one match -> use it; many -> error
 *   asking for --repo; none -> error.
 * - --repo given: repo must exist; prefix must be mapped unless --allow-unmapped.
 */
export function resolveRepoSelection(
  config: AppConfig,
  issueKey: string,
  options: RepoSelectionOptions = {},
): ResolvedRepo {
  const { prefix } = parseIssueKey(issueKey);
  const allRepos = Object.values(config.repos);

  if (options.repo) {
    const repo = config.repos[options.repo];
    if (!repo) {
      const available = allRepos.map((r) => `  - ${r.id}`).join('\n');
      throw new RepoResolutionError(
        `Repo "${options.repo}" not found in config/repos.yml.\n\nAvailable repos:\n${available}`,
      );
    }
    const mapped = repo.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix);
    if (!mapped && !options.allowUnmapped) {
      throw new RepoResolutionError(
        `Repo ${repo.id} is not mapped to Jira prefix ${prefix}.\n` +
          `Check config/repos.yml or pass --allow-unmapped.`,
      );
    }
    return repo;
  }

  const matches = allRepos.filter((r) =>
    r.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix),
  );

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    const available = allRepos
      .map((r) => `  - ${r.id} (${r.jiraPrefixes.join(', ')})`)
      .join('\n');
    throw new RepoResolutionError(
      `No repository found for Jira prefix ${prefix}.\n\n` +
        `Configured repos:\n${available}\n\n` +
        `Add a mapping in config/repos.yml or pass --repo <repoId> --allow-unmapped.`,
    );
  }

  const suggestions = matches
    .map((r) => `nls-review run ${parseIssueKey(issueKey).key} --repo ${r.id}`)
    .join('\n');
  throw new RepoResolutionError(
    `Multiple repositories found for Jira prefix ${prefix}.\n\n` +
      `Use --repo explicitly:\n\n${suggestions}`,
  );
}
