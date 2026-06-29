#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { Command } from 'commander';

import {
  ConfigError,
  LoadConfigOptions,
  RepoResolutionError,
  loadConfig,
  parseIssueKey,
  resolveRepoSelection,
} from './config/loadConfig';
import { AppConfig, BitbucketConfig, ResolvedRepo } from './config/types';
import { logger, setVerbose } from './utils/logger';
import { ensureDir, pathExists, readText, writeJson, writeText } from './utils/fs';
import {
  FOLLOWUP_FILES,
  LATEST_FOLLOWUP_FILES,
  OUTPUT_FILES,
  followupRunDir,
  formatRunTimestamp,
  outputDir,
  outputFile,
  repoLockPath,
  taskLockPath,
  worktreePath,
} from './utils/paths';
import { acquireLock, LockHeldError, withLock } from './utils/lock';
import { JiraClient, normalizeIssue } from './collectors/jira.client';
import { BitbucketDataCenterClient } from './collectors/bitbucket-dc.client';
import { BitbucketApiError, BitbucketCloudClient } from './collectors/bitbucket-cloud.client';
import {
  BitbucketClient,
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetails,
  PullRequestDiffStat,
  PullRequestSummary,
} from './collectors/bitbucket.types';
import {
  collectFollowupDelta,
  collectMetadata,
  commitMatches,
  gitFetchAll,
  gitFetchOrigin,
  prepareWorktree,
  removeWorktree,
} from './collectors/git.collector';
import { buildContextMarkdown } from './collectors/context.builder';
import { buildFollowupContextMarkdown } from './collectors/followup-context.builder';
import { runClaude } from './review/claude.runner';
import { ReviewResult, parseReviewResult } from './review/review.schema';
import { FollowupReviewResult, parseFollowupResult } from './review/followup.schema';
import {
  PreviousReview,
  PreviousReviewNotFoundError,
  formatPreviousReviewNotFound,
  loadPreviousReview,
  resolvePreviousHead,
} from './review/previous-review';
import {
  RenderContext,
  renderErrorMarkdown,
  renderFallbackMarkdown,
  renderFollowupFallbackMarkdown,
  renderFollowupMarkdown,
  renderFollowupStopMarkdown,
  renderReviewMarkdown,
  renderStopMarkdown,
} from './review/markdown.renderer';

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

function createBitbucketClient(cfg: BitbucketConfig): BitbucketClient {
  if (cfg.type === 'cloud') return new BitbucketCloudClient(cfg);
  return new BitbucketDataCenterClient(cfg);
}

function loadAppConfig(opts: LoadConfigOptions = {}): AppConfig {
  return loadConfig(opts);
}

function validateRunCredentials(config: AppConfig): void {
  // Jira is mandatory: no issue means no review.
  const problems: string[] = [];
  if (!config.jira.baseUrl) problems.push('JIRA_BASE_URL is empty');
  if (!config.jira.apiToken) problems.push('JIRA_API_TOKEN is empty');
  if (problems.length) {
    throw new Error(
      `Missing Jira credentials in .env:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}\n\nFill .env (see .env.example).`,
    );
  }

  // Bitbucket is best-effort: a missing/partial config must NOT abort the run —
  // PR lookup degrades to a branch-only review. Warn so it is visible.
  const bb = config.bitbucket;
  const missing: string[] = [];
  if (!bb.token) missing.push('BITBUCKET_TOKEN');
  if (!bb.username) missing.push('BITBUCKET_USERNAME');
  if (bb.type === 'datacenter' && !bb.baseUrl) missing.push('BITBUCKET_BASE_URL');
  if (bb.type === 'cloud' && !bb.workspace && !Object.values(config.repos).some((r) => r.bitbucket.workspace)) {
    missing.push('bitbucket.workspace');
  }
  if (missing.length) {
    logger.warn(
      `Bitbucket not fully configured (${missing.join(', ')}). ` +
        `PR lookup may fail; the review will fall back to branch-only.`,
    );
  }
}

function firstLine(text: string): string {
  return (text ?? '').split('\n')[0].trim();
}

function parseDurationToMs(input: string): number {
  const m = /^(\d+)\s*([dhm])$/.exec(input.trim());
  if (!m) {
    throw new Error(`Invalid duration "${input}". Use e.g. 14d, 24h, 90m.`);
  }
  const value = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
  return value * mult;
}

function resolveProfile(config: AppConfig, repo: ResolvedRepo): {
  prompt: string;
  outputFormat?: string;
  maxTurns?: number;
} {
  const profiles = config.profiles.profiles;
  const name =
    repo.reviewProfile && profiles[repo.reviewProfile]
      ? repo.reviewProfile
      : config.profiles.default;
  return (
    profiles[name] ?? {
      prompt: 'prompts/frontend-tl-review.md',
      outputFormat: 'prompts/output-format.md',
    }
  );
}

class MultiplePullRequestsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiplePullRequestsError';
  }
}

function stopReview(
  repoId: string,
  branch: string,
  head: string,
  subject: string,
  summary: string,
): ReviewResult {
  return {
    verdict: 'STOP',
    summary,
    checkedHead: { repoId, branch, head, lastCommit: subject, syncStatus: 'STOP' },
    blockers: [],
    risks: [],
    questionsForDeveloper: [],
    bitbucketComment: '',
  };
}

/* ======================================================================== */
/* Command: init                                                            */
/* ======================================================================== */

async function cmdInit(): Promise<void> {
  const root = process.cwd();

  const dirs = [
    'config',
    'repos',
    'worktrees',
    'outputs',
    'locks',
    'locks/tasks',
    'locks/repos',
    'prompts',
  ];
  for (const d of dirs) {
    await ensureDir(path.join(root, d));
  }

  const gitkeeps = [
    'repos/.gitkeep',
    'worktrees/.gitkeep',
    'outputs/.gitkeep',
    'locks/.gitkeep',
    'locks/tasks/.gitkeep',
    'locks/repos/.gitkeep',
  ];
  for (const g of gitkeeps) {
    await writeIfMissing(path.join(root, g), '');
  }

  let created = 0;
  let skipped = 0;
  for (const [rel, content] of Object.entries(INIT_FILES)) {
    const full = path.join(root, rel);
    if (await pathExists(full)) {
      skipped += 1;
      logger.info(`exists, skipped: ${rel}`);
    } else {
      await writeText(full, content);
      created += 1;
      logger.success(`created: ${rel}`);
    }
  }

  logger.success(`init done. Created ${created} file(s), skipped ${skipped}.`);
  logger.info('Next: fill .env (copy from .env.example) and edit config/repos.yml.');
}

async function writeIfMissing(file: string, content: string): Promise<void> {
  if (!(await pathExists(file))) {
    await writeText(file, content);
  }
}

/* ======================================================================== */
/* Command: repos                                                           */
/* ======================================================================== */

async function cmdRepos(): Promise<void> {
  const config = loadAppConfig();
  const rows = Object.values(config.repos).map((r) => ({
    id: r.id,
    prefixes: r.jiraPrefixes.join(', '),
    path: r.path,
  }));

  const idW = Math.max(7, ...rows.map((r) => r.id.length));
  const pxW = Math.max(13, ...rows.map((r) => r.prefixes.length));

  console.log(`${pad('Repo ID', idW)}  ${pad('Jira Prefixes', pxW)}  Path`);
  for (const r of rows) {
    console.log(`${pad(r.id, idW)}  ${pad(r.prefixes, pxW)}  ${r.path}`);
  }
  if (rows.length === 0) {
    logger.warn('No repos configured. Edit config/repos.yml.');
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/* ======================================================================== */
/* Command: sync                                                            */
/* ======================================================================== */

async function cmdSync(options: { repo?: string }): Promise<void> {
  const config = loadAppConfig();

  let targets: ResolvedRepo[];
  if (options.repo) {
    const repo = config.repos[options.repo];
    if (!repo) {
      throw new RepoResolutionError(
        `Repo "${options.repo}" not found in config/repos.yml. Run "nls-review repos" to list.`,
      );
    }
    targets = [repo];
  } else {
    targets = Object.values(config.repos);
  }

  let ok = 0;
  let failed = 0;
  for (const repo of targets) {
    const exists = await pathExists(repo.absPath);
    if (!exists) {
      logger.error(
        `${repo.id}: directory not found at ${repo.absPath}. Clone it manually, e.g.:\n` +
          `  git clone <remote-url> ${repo.path}`,
      );
      failed += 1;
      continue;
    }
    try {
      logger.step(`${repo.id}: git fetch --all --prune`);
      await withLock(
        repoLockPath(config.root.locksDir, repo.id),
        () => gitFetchAll(repo.absPath),
        { label: `repo:${repo.id}` },
      );
      logger.success(`${repo.id}: synced`);
      ok += 1;
    } catch (err) {
      logger.error(`${repo.id}: fetch failed — ${(err as Error).message}`);
      failed += 1;
    }
  }
  logger.info(`sync done. ${ok} ok, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

/* ======================================================================== */
/* Command: run                                                             */
/* ======================================================================== */

interface RunOptions {
  repo?: string;
  allowUnmapped?: boolean;
}

async function cmdRun(issueKeyRaw: string, options: RunOptions): Promise<void> {
  const config = loadAppConfig();

  // Resolve the repo first (config-only) so multi-repo / mapping errors surface
  // before we require credentials.
  const { key: issueKey } = parseIssueKey(issueKeyRaw);
  const repo = resolveRepoSelection(config, issueKey, {
    repo: options.repo,
    allowUnmapped: options.allowUnmapped,
  });
  logger.info(`Issue ${issueKey} -> repo ${repo.id}`);

  validateRunCredentials(config);

  // Output paths.
  const outDir = outputDir(config.root.outputsDir, issueKey, repo.id);
  await ensureDir(outDir);
  const out = (name: string) => outputFile(config.root.outputsDir, issueKey, repo.id, name);

  // Task lock keyed by issueKey + repoId.
  const lockPath = taskLockPath(config.root.locksDir, issueKey, repo.id);
  const lock = await acquireTaskLock(lockPath, `${issueKey}__${repo.id}`);

  try {
    /* ---- C. Jira ---- */
    logger.step('Fetching Jira issue...');
    const jiraClient = new JiraClient(config.jira);
    const rawIssue = await jiraClient.getIssue(issueKey, config.jiraFields);
    const changelog = await jiraClient.getIssueChangelog(issueKey);
    const normalizedJira = normalizeIssue(rawIssue, config.jira.baseUrl, config.jiraFields.customFields);
    await writeJson(out(OUTPUT_FILES.jira), {
      key: issueKey,
      normalized: normalizedJira,
      changelog,
      raw: rawIssue,
    });
    logger.success(`Jira: ${normalizedJira.summary || '(no summary)'} [${normalizedJira.status}]`);

    /* ---- D. Bitbucket PR ---- */
    const provider = config.bitbucket.type === 'cloud' ? 'bitbucket-cloud' : 'bitbucket-datacenter';
    const workspace = repo.bitbucket.workspace || config.bitbucket.workspace || undefined;
    const target = {
      projectKey: repo.bitbucket.projectKey,
      repoSlug: repo.bitbucket.repoSlug,
      workspace,
    };
    const locator =
      config.bitbucket.type === 'cloud'
        ? `${workspace ?? '(no workspace)'}/${target.repoSlug}`
        : `${repo.bitbucket.projectKey ?? '?'}/${target.repoSlug}`;
    logger.step(`Searching Bitbucket PR (${provider}) in ${locator}...`);
    const bb = createBitbucketClient(config.bitbucket);

    // PR lookup is best-effort: a Bitbucket error (auth, unreachable, missing
    // workspace) must NOT abort the run — degrade to a branch-only review
    // (prFound: false), matching the documented "PR not found" path.
    let candidates: PullRequestSummary[] = [];
    let searchError: { status: number | null; message: string } | undefined;
    try {
      const search = await bb.findPullRequestByIssueKey({ ...target, issueKey });
      candidates = search.candidates;
    } catch (err) {
      const status = err instanceof BitbucketApiError ? err.status ?? null : null;
      searchError = { status, message: (err as Error).message };
      logger.warn(
        `Bitbucket PR lookup failed (${searchError.message}). ` +
          `Continuing as branch-only review (prFound: false).`,
      );
    }
    const chosen = selectPullRequest(candidates);

    let prFound = false;
    let details: PullRequestDetails | undefined;
    let comments: PullRequestComment[] = [];
    let commits: PullRequestCommit[] = [];
    let diffStat: PullRequestDiffStat[] = [];

    if (chosen) {
      prFound = true;
      try {
        details = await bb.getPullRequest({ ...target, prId: chosen.id });
      } catch (err) {
        logger.warn(`Could not fetch PR details: ${(err as Error).message}`);
        details = { ...chosen, reviewers: [] };
      }
      comments = await safe(() => bb.getPullRequestComments({ ...target, prId: chosen.id }), []);
      commits = await safe(() => bb.getPullRequestCommits({ ...target, prId: chosen.id }), []);
      diffStat = await safe(() => bb.getPullRequestDiffStat({ ...target, prId: chosen.id }), []);
      logger.success(`PR #${chosen.id} "${chosen.title}" [${chosen.state}]`);
    } else {
      logger.warn(`No PR found; will review branch origin/${issueKey} (prFound: false).`);
    }

    const summarySrc = details ?? chosen;
    await writeJson(out(OUTPUT_FILES.pr), {
      prFound,
      found: prFound, // back-compat alias
      provider,
      workspace: workspace ?? null,
      repoSlug: target.repoSlug,
      searchError: searchError ?? null,
      id: summarySrc?.id ?? null,
      title: summarySrc?.title ?? null,
      state: summarySrc?.state ?? null,
      sourceBranch: summarySrc?.fromRef.branch ?? null,
      targetBranch: summarySrc?.toRef.branch ?? null,
      sourceCommit: summarySrc?.fromRef.latestCommit ?? null,
      author: summarySrc?.author ?? null,
      reviewers: details?.reviewers.map((r) => r.name) ?? [],
      commentsCount: comments.length,
      commitsCount: commits.length,
      // Full detail retained for debugging / re-parsing.
      chosen,
      candidates,
      details,
      comments,
      commits,
      diffStat,
    });

    /* ---- E. git worktree ---- */
    const branch = prFound
      ? details?.fromRef.branch || chosen?.fromRef.branch || issueKey
      : issueKey;
    const ref = `origin/${branch}`;
    const baseBranch =
      prFound && details?.toRef.branch ? `origin/${details.toRef.branch}` : repo.defaultBaseBranch;
    const sourceCommit = details?.fromRef.latestCommit || chosen?.fromRef.latestCommit;

    if (!(await pathExists(repo.absPath))) {
      throw new Error(
        `Repo "${repo.id}" not found at ${repo.absPath}. Clone it first, then run "nls-review sync --repo ${repo.id}".`,
      );
    }

    logger.step(`git fetch origin (${repo.id})...`);
    await withLock(
      repoLockPath(config.root.locksDir, repo.id),
      () => gitFetchOrigin(repo.absPath),
      { label: `repo:${repo.id}` },
    );

    const wtPath = worktreePath(config.root.worktreesDir, repo.id, issueKey);
    await prepareWorktree({ repoPath: repo.absPath, worktreePath: wtPath, ref });

    /* ---- F. git metadata ---- */
    logger.step('Collecting git metadata + diff...');
    const git = await collectMetadata({
      repoId: repo.id,
      repoPath: repo.absPath,
      worktreePath: wtPath,
      branch,
      baseBranch,
      ref,
    });
    await writeJson(out(OUTPUT_FILES.gitMeta), { ...git, diff: undefined });
    await writeText(out(OUTPUT_FILES.changedFiles), git.changedFiles.join('\n'));
    await writeText(out(OUTPUT_FILES.diff), git.diff);
    logger.success(`HEAD ${git.head} (${git.changedFiles.length} files changed)`);

    const renderCtx: RenderContext = { git, prFound, pr: details };

    /* ---- F2. diff sanity: don't run Claude on a failed/empty diff ---- */
    if (git.diffError) {
      const reason =
        `Could not compute the diff for ${branch} vs ${git.baseBranch}.\n` +
        `${git.diffError}\n` +
        `Check that the base branch exists (try: nls-review sync --repo ${repo.id}).`;
      await writeText(out(OUTPUT_FILES.error), renderErrorMarkdown(issueKey, 'Diff failed', reason));
      const stop = stopReview(repo.id, branch, git.head, git.subject, reason);
      await writeJson(out(OUTPUT_FILES.reviewJson), stop);
      await writeText(out(OUTPUT_FILES.reviewMd), renderStopMarkdown(issueKey, reason, renderCtx));
      logger.error('STOP: diff could not be computed; skipping Claude.');
      process.exitCode = 1;
      return;
    }

    /* ---- G. HEAD control ---- */
    // Cloud reports a 12-char short hash; compare prefix-wise, not strict ===.
    if (prFound && sourceCommit && !commitMatches(sourceCommit, git.head)) {
      const reason =
        `STOP: local HEAD does not match Bitbucket PR source commit.\n` +
        `  PR source commit: ${sourceCommit}\n` +
        `  Local HEAD:       ${git.head}\n` +
        `Try: nls-review sync --repo ${repo.id}, then re-run.`;
      await writeText(out(OUTPUT_FILES.error), renderErrorMarkdown(issueKey, 'HEAD mismatch', reason));
      const stop = stopReview(repo.id, branch, git.head, git.subject, reason);
      await writeJson(out(OUTPUT_FILES.reviewJson), stop);
      await writeText(out(OUTPUT_FILES.reviewMd), renderStopMarkdown(issueKey, reason, renderCtx));
      logger.error('STOP: local HEAD does not match Bitbucket PR source commit.');
      console.log('STOP: local HEAD does not match Bitbucket PR source commit.');
      process.exitCode = 1;
      return;
    }

    /* ---- H. context.md ---- */
    const profile = resolveProfile(config, repo);
    const instructions = await loadInstructions(config.projectRoot, profile);
    const context = buildContextMarkdown({
      issueKey,
      jira: normalizedJira,
      pr: { found: prFound, provider, workspace, repoSlug: target.repoSlug, details, comments, commits, diffStat },
      git,
      instructions,
    });
    await writeText(out(OUTPUT_FILES.context), context);

    /* ---- I. Claude ---- */
    const claudeCfg = config.claude;
    // profile.maxTurns (if a profile sets it) overrides the global optional turns.
    const maxTurns = profile.maxTurns ?? claudeCfg.maxTurns;

    logger.step(
      `Running Claude (${claudeCfg.bin}, model=${claudeCfg.model}, effort=${claudeCfg.effort}, ` +
        `permissions=${claudeCfg.permissionMode}${maxTurns ? `, max-turns=${maxTurns}` : ''}) from worktree...`,
    );
    const claude = await runClaude(context, {
      bin: claudeCfg.bin,
      model: claudeCfg.model,
      effort: claudeCfg.effort,
      permissionMode: claudeCfg.permissionMode,
      outputFormat: claudeCfg.outputFormat,
      maxTurns,
      cwd: wtPath,
    });
    await writeText(
      out(OUTPUT_FILES.reviewRaw),
      claude.raw || JSON.stringify({ exitCode: claude.exitCode, stderr: claude.stderr }, null, 2),
    );

    if (claude.exitCode !== 0) {
      logger.warn(`Claude CLI exited with code ${claude.exitCode}.`);
    }

    /* ---- J/K. normalize + markdown ---- */
    if (!claude.resultText.trim()) {
      const reason = `Claude CLI produced no usable output (exit ${claude.exitCode}).`;
      await writeText(out(OUTPUT_FILES.error), renderErrorMarkdown(issueKey, reason, claude.stderr));
      const stop = stopReview(repo.id, branch, git.head, git.subject, reason);
      await writeJson(out(OUTPUT_FILES.reviewJson), stop);
      await writeText(
        out(OUTPUT_FILES.reviewMd),
        renderStopMarkdown(issueKey, reason, renderCtx, claude.stderr),
      );
      logger.error(reason);
      process.exitCode = 1;
      return;
    }

    const parsed = parseReviewResult(claude.resultText);
    if (parsed.ok && parsed.result) {
      const result: ReviewResult = {
        ...parsed.result,
        checkedHead: {
          repoId: repo.id,
          branch,
          head: git.head,
          lastCommit: git.subject || firstLine(git.lastCommit),
          syncStatus: prFound
            ? 'PR source commit matches local HEAD'
            : 'No PR found (branch-only review)',
        },
      };
      await writeJson(out(OUTPUT_FILES.reviewJson), result);
      await writeText(out(OUTPUT_FILES.reviewMd), renderReviewMarkdown(issueKey, result, renderCtx));
      logger.success(`Review complete: ${result.verdict}. See ${path.relative(process.cwd(), out(OUTPUT_FILES.reviewMd))}`);
    } else {
      await writeJson(out(OUTPUT_FILES.reviewJson), {
        parsed: false,
        error: parsed.error,
        resultText: claude.resultText,
        exitCode: claude.exitCode,
      });
      await writeText(
        out(OUTPUT_FILES.reviewMd),
        renderFallbackMarkdown(issueKey, claude.resultText, renderCtx, parsed.error ?? 'unknown'),
      );
      logger.warn(
        `Claude output was not valid ReviewResult JSON (${parsed.error}). Wrote raw fallback to review.md.`,
      );
    }
  } finally {
    await lock.release();
  }
}

async function acquireTaskLock(lockPath: string, label: string) {
  try {
    return await acquireLock(lockPath, { label: `task:${label}` });
  } catch (err) {
    if (err instanceof LockHeldError) {
      throw new Error(
        `${err.message}\nA review for this issue+repo is already running. ` +
          `The same issue can run in a DIFFERENT repo concurrently.`,
      );
    }
    throw err;
  }
}

function selectPullRequest(candidates: PullRequestSummary[]): PullRequestSummary | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const open = candidates.filter((c) => c.state === 'OPEN');
  if (open.length === 1) return open[0];
  if (open.length > 1) {
    const list = open
      .map((p) => `  - #${p.id} ${p.title} (from ${p.fromRef.branch})${p.url ? ` ${p.url}` : ''}`)
      .join('\n');
    throw new MultiplePullRequestsError(
      `Multiple OPEN pull requests match this issue:\n${list}\n\n` +
        `Resolve the duplicates in Bitbucket, or narrow the source branch.`,
    );
  }
  // No open PRs but several closed/merged: pick most recently updated.
  const sorted = [...candidates].sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0));
  logger.warn('Multiple non-open PRs matched; using the most recently updated one.');
  return sorted[0];
}

async function loadInstructions(
  projectRoot: string,
  profile: { prompt: string; outputFormat?: string },
): Promise<string> {
  const reviewPrompt = await readText(path.resolve(projectRoot, profile.prompt)).catch(
    () => DEFAULT_REVIEW_PROMPT,
  );
  const outputFormat = profile.outputFormat
    ? await readText(path.resolve(projectRoot, profile.outputFormat)).catch(() => '')
    : '';
  return [reviewPrompt.trim(), outputFormat.trim()].filter(Boolean).join('\n\n---\n\n');
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(`(non-fatal) ${(err as Error).message}`);
    return fallback;
  }
}

/* ======================================================================== */
/* Command: followup                                                        */
/* ======================================================================== */

interface FollowupOptions {
  repo?: string;
  allowUnmapped?: boolean;
  previous?: string;
  fromHead?: string;
}

const DEFAULT_FOLLOWUP_PROMPT = `Ты frontend TL follow-up review agent.
Проверь закрытие предыдущих замечаний (не делай ревью с нуля).
Не считай пункт исправленным только по ответу разработчика — нужен evidence из кода/diff.
Read-only: не комментируй Bitbucket, не меняй Jira, не пушь код.
Верни строго JSON по схеме FollowupReviewResult.
`;

async function loadFollowupInstructions(projectRoot: string): Promise<string> {
  const prompt = await readText(
    path.resolve(projectRoot, 'prompts/frontend-tl-followup.md'),
  ).catch(() => DEFAULT_FOLLOWUP_PROMPT);
  const outputFormat = await readText(
    path.resolve(projectRoot, 'prompts/followup-output-format.md'),
  ).catch(() => '');
  return [prompt.trim(), outputFormat.trim()].filter(Boolean).join('\n\n---\n\n');
}

async function cmdFollowup(issueKeyRaw: string, options: FollowupOptions): Promise<void> {
  const config = loadAppConfig();

  const { key: issueKey } = parseIssueKey(issueKeyRaw);
  const repo = resolveRepoSelection(config, issueKey, {
    repo: options.repo,
    allowUnmapped: options.allowUnmapped,
  });
  logger.info(`Follow-up ${issueKey} -> repo ${repo.id}`);

  validateRunCredentials(config);

  // Previous review: --previous path, else outputs/<issue>/<repo>/review.json|md.
  const previous = await loadPreviousReview({
    outputsDir: config.root.outputsDir,
    issueKey,
    repoId: repo.id,
    previousPath: options.previous ? path.resolve(process.cwd(), options.previous) : undefined,
  });
  const fromHead = options.fromHead?.trim() || undefined;

  // STOP early only when there is genuinely nothing to follow up from.
  if (!previous && !fromHead) {
    throw new PreviousReviewNotFoundError(formatPreviousReviewNotFound(issueKey, repo.id));
  }

  const previousHead = resolvePreviousHead(previous, fromHead);
  const prev: PreviousReview =
    previous ?? {
      source: `manual (--from-head ${fromHead})`,
      format: 'json',
      head: fromHead,
      blockers: [],
      risks: [],
      questionsForDeveloper: [],
      raw: null,
    };
  if (previous) {
    logger.success(
      `Previous review: ${previous.verdict ?? '(unknown verdict)'} ` +
        `from ${path.relative(process.cwd(), previous.source)} (HEAD ${previous.head ?? '—'})`,
    );
  }
  if (fromHead) logger.info(`Using --from-head ${fromHead} as previous HEAD.`);
  if (!previousHead) {
    logger.warn('No previous HEAD available; the delta will be empty (full-diff follow-up).');
  }

  // Shared worktree => same task lock as `run` (mutually exclusive per issue+repo).
  const lockPath = taskLockPath(config.root.locksDir, issueKey, repo.id);
  const lock = await acquireTaskLock(lockPath, `${issueKey}__${repo.id}`);

  // Timestamped follow-up output dir; never overwrites the primary review.
  const ts = formatRunTimestamp(new Date());
  const runDir = followupRunDir(config.root.outputsDir, issueKey, repo.id, ts);
  await ensureDir(runDir);
  const fout = (name: string): string => path.join(runDir, name);
  const latest = (name: string): string =>
    outputFile(config.root.outputsDir, issueKey, repo.id, name);

  try {
    /* ---- Jira ---- */
    logger.step('Fetching Jira issue...');
    const jiraClient = new JiraClient(config.jira);
    const rawIssue = await jiraClient.getIssue(issueKey, config.jiraFields);
    const normalizedJira = normalizeIssue(
      rawIssue,
      config.jira.baseUrl,
      config.jiraFields.customFields,
    );
    logger.success(`Jira: ${normalizedJira.summary || '(no summary)'} [${normalizedJira.status}]`);

    /* ---- Bitbucket PR (best-effort) ---- */
    const provider = config.bitbucket.type === 'cloud' ? 'bitbucket-cloud' : 'bitbucket-datacenter';
    const workspace = repo.bitbucket.workspace || config.bitbucket.workspace || undefined;
    const target = {
      projectKey: repo.bitbucket.projectKey,
      repoSlug: repo.bitbucket.repoSlug,
      workspace,
    };
    const locator =
      config.bitbucket.type === 'cloud'
        ? `${workspace ?? '(no workspace)'}/${target.repoSlug}`
        : `${repo.bitbucket.projectKey ?? '?'}/${target.repoSlug}`;
    logger.step(`Searching Bitbucket PR (${provider}) in ${locator}...`);
    const bb = createBitbucketClient(config.bitbucket);

    let candidates: PullRequestSummary[] = [];
    let searchError: string | undefined;
    try {
      const search = await bb.findPullRequestByIssueKey({ ...target, issueKey });
      candidates = search.candidates;
    } catch (err) {
      searchError = (err as Error).message;
      logger.warn(
        `Bitbucket PR lookup failed (${searchError}). Continuing as branch-only follow-up.`,
      );
    }
    const chosen = selectPullRequest(candidates);

    let prFound = false;
    let details: PullRequestDetails | undefined;
    let comments: PullRequestComment[] = [];
    let commentsError: string | undefined = searchError;
    if (chosen) {
      prFound = true;
      try {
        details = await bb.getPullRequest({ ...target, prId: chosen.id });
      } catch (err) {
        logger.warn(`Could not fetch PR details: ${(err as Error).message}`);
        details = { ...chosen, reviewers: [] };
      }
      try {
        comments = await bb.getPullRequestComments({ ...target, prId: chosen.id });
        commentsError = undefined;
      } catch (err) {
        commentsError = (err as Error).message;
        logger.warn(`Could not fetch PR comments: ${commentsError}`);
      }
      logger.success(
        `PR #${chosen.id} "${chosen.title}" [${chosen.state}] — ${comments.length} comment(s)`,
      );
    } else {
      logger.warn(
        `${searchError ? `PR lookup failed (${searchError})` : 'No PR found'}; ` +
          `following up branch origin/${issueKey} (prFound: false).`,
      );
    }

    /* ---- git worktree (shared with run; refresh to PR source / issueKey) ---- */
    const branch = prFound ? details?.fromRef.branch || chosen?.fromRef.branch || issueKey : issueKey;
    const ref = `origin/${branch}`;
    const baseBranch =
      prFound && details?.toRef.branch ? `origin/${details.toRef.branch}` : repo.defaultBaseBranch;
    const sourceCommit = details?.fromRef.latestCommit || chosen?.fromRef.latestCommit;
    const prId = details?.id ?? chosen?.id;

    if (!(await pathExists(repo.absPath))) {
      throw new Error(
        `Repo "${repo.id}" not found at ${repo.absPath}. Clone it first, then run "nls-review sync --repo ${repo.id}".`,
      );
    }

    logger.step(`git fetch origin (${repo.id})...`);
    await withLock(repoLockPath(config.root.locksDir, repo.id), () => gitFetchOrigin(repo.absPath), {
      label: `repo:${repo.id}`,
    });

    const wtPath = worktreePath(config.root.worktreesDir, repo.id, issueKey);
    await prepareWorktree({ repoPath: repo.absPath, worktreePath: wtPath, ref });

    /* ---- git metadata + full diff ---- */
    logger.step('Collecting git metadata + diff...');
    const git = await collectMetadata({
      repoId: repo.id,
      repoPath: repo.absPath,
      worktreePath: wtPath,
      branch,
      baseBranch,
      ref,
    });
    logger.success(
      `HEAD ${git.head} (${git.changedFiles.length} files changed vs ${git.baseBranch})`,
    );

    const headInfo = { repoId: repo.id, branch, previousHead, currentHead: git.head };
    const writeFollowupStop = async (reason: string, details2?: string): Promise<void> => {
      const stop: FollowupReviewResult = {
        verdict: 'STOP',
        summary: reason,
        previousReview: { verdict: prev.verdict, head: previousHead, source: prev.source },
        checkedHead: {
          repoId: repo.id,
          branch,
          baseBranch: git.baseBranch,
          previousHead,
          currentHead: git.head,
          prId,
        },
        resolvedItems: [],
        stillOpenItems: [],
        newFindings: [],
        questionsForDeveloper: [],
        bitbucketComment: '',
      };
      const md = renderFollowupStopMarkdown(issueKey, reason, headInfo, details2);
      await writeText(fout(FOLLOWUP_FILES.error), renderErrorMarkdown(issueKey, 'Follow-up STOP', reason));
      await writeJson(fout(FOLLOWUP_FILES.json), stop);
      await writeText(fout(FOLLOWUP_FILES.md), md);
      await writeJson(latest(LATEST_FOLLOWUP_FILES.json), stop);
      await writeText(latest(LATEST_FOLLOWUP_FILES.md), md);
    };

    /* ---- diff sanity ---- */
    if (git.diffError) {
      const reason =
        `Could not compute the diff for ${branch} vs ${git.baseBranch}.\n` +
        `${git.diffError}\n` +
        `Check that the base branch exists (try: nls-review sync --repo ${repo.id}).`;
      await writeFollowupStop(reason);
      logger.error('STOP: diff could not be computed; skipping Claude.');
      process.exitCode = 1;
      return;
    }

    /* ---- HEAD control ---- */
    if (prFound && sourceCommit && !commitMatches(sourceCommit, git.head)) {
      const reason =
        `STOP: local HEAD does not match Bitbucket PR source commit.\n` +
        `  PR source commit: ${sourceCommit}\n` +
        `  Local HEAD:       ${git.head}\n` +
        `Try: nls-review sync --repo ${repo.id}, then re-run.`;
      await writeFollowupStop(reason);
      logger.error('STOP: local HEAD does not match Bitbucket PR source commit.');
      console.log('STOP: local HEAD does not match Bitbucket PR source commit.');
      process.exitCode = 1;
      return;
    }

    /* ---- delta since previous review ---- */
    const delta = await collectFollowupDelta({
      worktreePath: wtPath,
      previousHead,
      currentHead: git.head,
    });
    if (delta.error) logger.warn(`Delta: ${delta.error}`);
    else
      logger.success(
        `Delta since ${previousHead?.slice(0, 12) ?? '—'}: ${delta.changedFiles.length} file(s) changed.`,
      );

    /* ---- followup context ---- */
    const instructions = await loadFollowupInstructions(config.projectRoot);
    const context = buildFollowupContextMarkdown({
      issueKey,
      jira: normalizedJira,
      pr: { found: prFound, provider, workspace, repoSlug: target.repoSlug, details, comments, commits: [], diffStat: [] },
      previous: prev,
      comments,
      commentsError,
      delta,
      git,
      instructions,
    });
    await writeText(fout(FOLLOWUP_FILES.context), context);

    /* ---- Claude ---- */
    const claudeCfg = config.claude;
    const maxTurns = claudeCfg.maxTurns;
    logger.step(
      `Running Claude (${claudeCfg.bin}, model=${claudeCfg.model}, effort=${claudeCfg.effort}, ` +
        `permissions=${claudeCfg.permissionMode}${maxTurns ? `, max-turns=${maxTurns}` : ''}) from worktree...`,
    );
    const claude = await runClaude(context, {
      bin: claudeCfg.bin,
      model: claudeCfg.model,
      effort: claudeCfg.effort,
      permissionMode: claudeCfg.permissionMode,
      outputFormat: claudeCfg.outputFormat,
      maxTurns,
      cwd: wtPath,
    });
    await writeText(
      fout(FOLLOWUP_FILES.raw),
      claude.raw || JSON.stringify({ exitCode: claude.exitCode, stderr: claude.stderr }, null, 2),
    );
    if (claude.exitCode !== 0) logger.warn(`Claude CLI exited with code ${claude.exitCode}.`);

    if (!claude.resultText.trim()) {
      const reason = `Claude CLI produced no usable output (exit ${claude.exitCode}).`;
      await writeFollowupStop(reason, claude.stderr);
      logger.error(reason);
      process.exitCode = 1;
      return;
    }

    /* ---- parse + render ---- */
    const parsed = parseFollowupResult(claude.resultText);
    const renderCtx = { prFound, pr: details };
    if (parsed.ok && parsed.result) {
      const result: FollowupReviewResult = {
        ...parsed.result,
        previousReview: {
          verdict: prev.verdict,
          head: previousHead,
          source: prev.source,
        },
        checkedHead: {
          repoId: repo.id,
          branch,
          baseBranch: git.baseBranch,
          previousHead,
          currentHead: git.head,
          prId,
        },
      };
      const md = renderFollowupMarkdown(issueKey, result, renderCtx);
      await writeJson(fout(FOLLOWUP_FILES.json), result);
      await writeText(fout(FOLLOWUP_FILES.md), md);
      await writeJson(latest(LATEST_FOLLOWUP_FILES.json), result);
      await writeText(latest(LATEST_FOLLOWUP_FILES.md), md);
      logger.success(
        `Follow-up complete: ${result.verdict}. See ${path.relative(process.cwd(), fout(FOLLOWUP_FILES.md))}`,
      );
    } else {
      const md = renderFollowupFallbackMarkdown(
        issueKey,
        claude.resultText,
        headInfo,
        parsed.error ?? 'unknown',
      );
      await writeJson(fout(FOLLOWUP_FILES.json), {
        parsed: false,
        error: parsed.error,
        resultText: claude.resultText,
        exitCode: claude.exitCode,
      });
      await writeText(fout(FOLLOWUP_FILES.md), md);
      await writeText(latest(LATEST_FOLLOWUP_FILES.md), md);
      logger.warn(
        `Claude output was not valid FollowupReviewResult JSON (${parsed.error}). ` +
          `Wrote raw fallback to followup.md.`,
      );
    }
  } finally {
    await lock.release();
  }
}

/* ======================================================================== */
/* Command: clean                                                           */
/* ======================================================================== */

interface CleanOptions {
  repo?: string;
  olderThan?: string;
}

async function cmdClean(issueKeyRaw: string | undefined, options: CleanOptions): Promise<void> {
  const config = loadAppConfig();

  if (options.olderThan) {
    await cleanOlderThan(config, options.olderThan);
    return;
  }

  if (!issueKeyRaw) {
    throw new Error('Provide an issue key (e.g. "nls-review clean SC-3749") or --older-than <Nd>.');
  }

  const { key: issueKey } = parseIssueKey(issueKeyRaw);
  const repo = resolveRepoSelection(config, issueKey, {
    repo: options.repo,
    allowUnmapped: true, // cleaning should not be blocked by prefix mapping
  });

  const wtPath = worktreePath(config.root.worktreesDir, repo.id, issueKey);
  if (!(await pathExists(wtPath))) {
    logger.info(`Nothing to clean: ${wtPath} does not exist.`);
    return;
  }
  logger.step(`Removing worktree ${wtPath}`);
  await removeWorktree({ repoPath: repo.absPath, worktreePath: wtPath });
  logger.success(`Removed worktree for ${issueKey} in ${repo.id} (outputs kept).`);
}

async function cleanOlderThan(config: AppConfig, duration: string): Promise<void> {
  const maxAgeMs = parseDurationToMs(duration);
  const cutoff = Date.now() - maxAgeMs;
  const worktreesDir = config.root.worktreesDir;

  if (!(await pathExists(worktreesDir))) {
    logger.info('No worktrees directory; nothing to clean.');
    return;
  }

  let removed = 0;
  const repoDirs = await fs.readdir(worktreesDir, { withFileTypes: true });
  for (const repoEnt of repoDirs) {
    if (!repoEnt.isDirectory()) continue;
    const repoId = repoEnt.name;
    const repoWtDir = path.join(worktreesDir, repoId);
    const issueDirs = await fs.readdir(repoWtDir, { withFileTypes: true });
    for (const issueEnt of issueDirs) {
      if (!issueEnt.isDirectory()) continue;
      const wtPath = path.join(repoWtDir, issueEnt.name);
      const stat = await fs.stat(wtPath).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs < cutoff) {
        const repoPath = config.repos[repoId]?.absPath ?? repoWtDir;
        logger.step(
          `Removing stale worktree ${wtPath} (age ${Math.round(
            (Date.now() - stat.mtimeMs) / 86400000,
          )}d)`,
        );
        await removeWorktree({ repoPath, worktreePath: wtPath });
        removed += 1;
      }
    }
  }
  logger.success(`clean --older-than ${duration}: removed ${removed} worktree(s). Outputs kept.`);
}

/* ======================================================================== */
/* Program                                                                  */
/* ======================================================================== */

function runAction(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      const e = err as Error;
      const known =
        e instanceof RepoResolutionError ||
        e instanceof ConfigError ||
        e instanceof LockHeldError ||
        e instanceof MultiplePullRequestsError ||
        e instanceof PreviousReviewNotFoundError;
      logger.error(e.message);
      if (!known && process.env.NLS_DEBUG) {
        console.error(e.stack);
      }
      process.exitCode = 1;
    }
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('nls-review')
    .description('Local CLI to automate frontend code review (Jira + Bitbucket + git worktree + Claude).')
    .version('0.1.0')
    .option('-v, --verbose', 'verbose logging')
    .hook('preAction', (thisCommand) => {
      if (thisCommand.opts().verbose) setVerbose(true);
    });

  program
    .command('init')
    .description('Create folder structure and example config/env/prompt files.')
    .action(runAction(cmdInit));

  program
    .command('repos')
    .description('List configured repositories.')
    .action(runAction(cmdRepos));

  program
    .command('sync')
    .description('git fetch --all --prune for all repos (or one with --repo).')
    .option('--repo <repoId>', 'sync only this repo')
    .action(runAction((opts: { repo?: string }) => cmdSync(opts)));

  program
    .command('run <issueKey>')
    .description('Collect context and run the review agent for a Jira issue.')
    .option('--repo <repoId>', 'target repository id (required when a prefix maps to several repos)')
    .option('--allow-unmapped', 'allow a repo whose jiraPrefixes does not include this prefix')
    .action(runAction((issueKey: string, opts: RunOptions) => cmdRun(issueKey, opts)));

  program
    .command('followup <issueKey>')
    .description("Re-check whether a previous review's findings were closed (delta review).")
    .option('--repo <repoId>', 'target repository id (required when a prefix maps to several repos)')
    .option('--allow-unmapped', 'allow a repo whose jiraPrefixes does not include this prefix')
    .option(
      '--previous <path>',
      'path to a previous review.json/review.md (default: outputs/<issue>/<repo>/review.json)',
    )
    .option('--from-head <hash>', 'previous HEAD to diff from (overrides the previous review head)')
    .action(runAction((issueKey: string, opts: FollowupOptions) => cmdFollowup(issueKey, opts)));

  program
    .command('clean [issueKey]')
    .description('Remove a worktree (by issue/repo) or all worktrees older than --older-than. Outputs are kept.')
    .option('--repo <repoId>', 'target repository id')
    .option('--older-than <duration>', 'remove worktrees older than e.g. 14d, 24h')
    .action(runAction((issueKey: string | undefined, opts: CleanOptions) => cmdClean(issueKey, opts)));

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});

/* ======================================================================== */
/* Embedded defaults for `init` (mirror the shipped config/ and prompts/).  */
/* ======================================================================== */

const DEFAULT_REVIEW_PROMPT = `Ты frontend TL review agent.

Твоя задача — проверить соответствие Jira-задачи и реализации в ветке/PR.

Ты работаешь внутри изолированного git worktree конкретной задачи.
Разрешено: читать локальные файлы, анализировать diff, read-only git-команды, формировать review output.
Запрещено: пушить код; менять Jira; комментировать Bitbucket; approve/request changes/merge; удалять файлы вне worktree; менять файлы проекта без явной команды пользователя.

Верни строго JSON по схеме ReviewResult.
`;

const INIT_FILES: Record<string, string> = {
  '.env.example': `JIRA_BASE_URL=https://your-jira-domain
JIRA_EMAIL=
JIRA_API_TOKEN=

BITBUCKET_BASE_URL=https://your-bitbucket-domain
BITBUCKET_USERNAME=
BITBUCKET_TOKEN=

CLAUDE_BIN=claude
CLAUDE_MODEL=opus
CLAUDE_EFFORT=max
CLAUDE_PERMISSION_MODE=dangerously-skip-permissions
CLAUDE_OUTPUT_FORMAT=json
`,

  'config/repos.yml': `root:
  reposDir: "./repos"
  worktreesDir: "./worktrees"
  outputsDir: "./outputs"
  locksDir: "./locks"

jira:
  baseUrl: "\${JIRA_BASE_URL}"
  email: "\${JIRA_EMAIL}"
  apiToken: "\${JIRA_API_TOKEN}"
  apiVersion: "3"

bitbucket:
  type: "datacenter"
  baseUrl: "\${BITBUCKET_BASE_URL}"
  username: "\${BITBUCKET_USERNAME}"
  token: "\${BITBUCKET_TOKEN}"

claude:
  bin: "\${CLAUDE_BIN}"
  model: "\${CLAUDE_MODEL}"
  effort: "\${CLAUDE_EFFORT}"
  permissionMode: "\${CLAUDE_PERMISSION_MODE}"
  outputFormat: "\${CLAUDE_OUTPUT_FORMAT}"

# The top-level key under \`repos\` is the repo id, NOT the Jira prefix.
repos:
  support-center-frontend:
    jiraPrefixes: ["SC"]
    path: "./repos/support-center-frontend"
    defaultBaseBranch: "origin/master"
    reviewProfile: "frontend-sc"
    bitbucket:
      projectKey: "SC"
      repoSlug: "support-center-frontend"
`,

  'config/review-profiles.yml': `default: default

profiles:
  default:
    prompt: "prompts/frontend-tl-review.md"
    outputFormat: "prompts/output-format.md"
`,

  'config/jira-fields.yml': `standardFields:
  - summary
  - description
  - status
  - assignee
  - reporter
  - labels
  - components
  - fixVersions
  - issuelinks
  - attachment
  - comment
  - issuetype
  - priority
  - created
  - updated

customFields: []
`,

  'prompts/frontend-tl-review.md': `Ты frontend TL review agent.

Твоя задача — проверить соответствие Jira-задачи и реализации в ветке/PR.

Ты работаешь внутри изолированного git worktree конкретной задачи.

Разрешено:
- читать локальные файлы;
- анализировать diff;
- выполнять read-only git-команды;
- формировать review output.

Запрещено:
- пушить код;
- менять Jira;
- комментировать Bitbucket;
- approve/request changes/merge;
- удалять файлы вне worktree;
- менять файлы проекта без явной команды пользователя.

Проверяй:
- реализованы ли требования Jira;
- нет ли расхождений с acceptance criteria;
- не добавлен ли лишний scope;
- нет ли регрессий в query params, reset filters, watchers, lifecycle, computed, permissions, API params, empty states;
- нет ли риска сломать другие табы/списки/модули;
- нет ли изменения контракта API без явного требования;
- нет ли мёртвого кода, дублей, хрупких условий;
- нет ли ситуации, когда UI обновляется только после reload/refetch, если по задаче нужен live state.

Правила:
- Не придумывай требования, которых нет в Jira.
- Не анализируй backend, если это frontend review.
- Каждый blocker/risk должен иметь evidence: файл, метод, условие, diff-факт.
- Если доказательств нет — пиши как question, не как blocker.
- Итоговый вердикт только один: APPROVE | HOLD | DECLINE | STOP.

Верни строго JSON по схеме ReviewResult.
`,

  'prompts/output-format.md': `# Output format

Верни СТРОГО валидный JSON одним объектом, без markdown-обёртки.

{
  "verdict": "APPROVE | HOLD | DECLINE | STOP",
  "summary": "Краткий вывод",
  "checkedHead": { "repoId": "", "branch": "", "head": "", "lastCommit": "" },
  "blockers": [ { "title": "", "file": "", "evidence": "", "whyItMatters": "" } ],
  "risks": [ { "title": "", "level": "low | medium | high", "evidence": "" } ],
  "questionsForDeveloper": [ "" ],
  "bitbucketComment": ""
}
`,
};
