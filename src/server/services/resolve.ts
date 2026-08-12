import { AppConfig, ResolvedRepo } from '../../config/types';
import { parseIssueKey } from '../../config/loadConfig';

export interface RepoCandidate {
  id: string;
  jiraPrefixes: string[];
}

export type ResolveOutcome =
  | { ok: true; key: string; repo: ResolvedRepo }
  | {
      ok: false;
      reason: 'invalid-key' | 'none' | 'multi' | 'not-found' | 'unmapped';
      message: string;
      key?: string;
      prefix?: string;
      candidates?: RepoCandidate[];
    };

export interface ResolveOptions {
  repo?: string;
  allowUnmapped?: boolean;
}

/**
 * Structured, throw-free mirror of the CLI's `resolveRepoSelection`.
 *
 * Returns a discriminated result so the API can answer 400 with a clear
 * payload (and the GUI can pre-populate the repo dropdown) instead of relying
 * on thrown error messages. The decision rules are intentionally identical to
 * the CLI so GUI and CLI never disagree about which repo an issue maps to.
 */
export function resolveSelection(
  config: AppConfig,
  issueKeyRaw: string,
  options: ResolveOptions = {},
): ResolveOutcome {
  let parsed: ReturnType<typeof parseIssueKey>;
  try {
    parsed = parseIssueKey(issueKeyRaw);
  } catch (err) {
    return { ok: false, reason: 'invalid-key', message: (err as Error).message };
  }
  const { key, prefix } = parsed;
  const all = Object.values(config.repos);
  const matches = all.filter((r) =>
    r.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix),
  );

  if (options.repo) {
    const repo = config.repos[options.repo];
    if (!repo) {
      return {
        ok: false,
        reason: 'not-found',
        key,
        prefix,
        message: `Repo "${options.repo}" not found in config/repos.yml.`,
        candidates: all.map((r) => ({ id: r.id, jiraPrefixes: r.jiraPrefixes })),
      };
    }
    const mapped = repo.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix);
    if (!mapped && !options.allowUnmapped) {
      return {
        ok: false,
        reason: 'unmapped',
        key,
        prefix,
        message:
          `Repo ${repo.id} is not mapped to Jira prefix ${prefix}. ` +
          `Pick a mapped repo or enable "allow unmapped".`,
      };
    }
    return { ok: true, key, repo };
  }

  if (matches.length === 1) return { ok: true, key, repo: matches[0] };

  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'none',
      key,
      prefix,
      message: `No repository is mapped to Jira prefix ${prefix}.`,
      candidates: all.map((r) => ({ id: r.id, jiraPrefixes: r.jiraPrefixes })),
    };
  }

  return {
    ok: false,
    reason: 'multi',
    key,
    prefix,
    message: `Prefix ${prefix} maps to ${matches.length} repositories. Choose one explicitly.`,
    candidates: matches.map((r) => ({ id: r.id, jiraPrefixes: r.jiraPrefixes })),
  };
}
