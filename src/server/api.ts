import { Router, Request, Response } from 'express';
import { AppConfig } from '../config/types';
import { parseIssueKey } from '../config/loadConfig';
import { JobStore } from './job-store';
import { JobConflictError, JobRunner } from './job-runner';
import { OutputReader, PathSafetyError } from './services/output-reader';
import { getConfigStatus } from './services/config-status';
import { listRepos } from './services/repos';
import { listHistory } from './services/history';
import { getCloneCommand, getRepoStatus, removeLocalRepo, RepoAdminError } from './services/repo-admin';
import { resolveSelection } from './services/resolve';
import {
  createQuery,
  deleteQuery,
  JqlQueryError,
  listQueries,
  updateQuery,
} from './services/jql-queries';
import { jiraErrorMessage, runJqlSearch } from './services/jira-queue';
import { getMemoryItem, listMemory, memoryActions, reindex, searchMemory } from './services/memory';
import { MemoryError } from '../memory/types';
import {
  CleanBodySchema,
  CloneBodySchema,
  FollowupBodySchema,
  JqlQueryCreateSchema,
  JqlQueryUpdateSchema,
  JqlSearchSchema,
  MemoryActionBodySchema,
  MemoryIdSchema,
  RemoveLocalBodySchema,
  RunBodySchema,
  SyncParamsSchema,
  validateBody,
} from './validate';

export interface ApiDeps {
  config: AppConfig;
  store: JobStore;
  runner: JobRunner;
  reader: OutputReader;
}

/** Does this repo cover the issue's Jira prefix? (decides --allow-unmapped). */
function isUnmapped(repo: { jiraPrefixes: string[] }, key: string): boolean {
  const prefix = parseIssueKey(key).prefix;
  return !repo.jiraPrefixes.map((p) => p.toUpperCase()).includes(prefix);
}

export function createApiRouter(deps: ApiDeps): Router {
  const { config, store, runner, reader } = deps;
  const router = Router();

  /* ---------------------------- health / config --------------------------- */

  router.get('/health', (_req, res) => {
    res.json({ ok: true, readOnly: true });
  });

  router.get('/config/status', (_req, res) => {
    res.json(getConfigStatus(config));
  });

  router.get('/repos', async (_req, res) => {
    res.json({ repos: await listRepos(config) });
  });

  /** All issue+repo runs found in outputs/ (newest first). */
  router.get('/history', async (_req, res) => {
    res.json({ items: await listHistory(config) });
  });

  /** Resolve an issue key → repo (multi-repo aware) for the dashboard. */
  router.get('/resolve', (req, res) => {
    const issueKey = String(req.query.issueKey ?? '');
    const repo = req.query.repo ? String(req.query.repo) : undefined;
    const allowUnmapped = req.query.allowUnmapped === 'true';
    res.json(resolveSelection(config, issueKey, { repo, allowUnmapped }));
  });

  /* ------------------------------ repo admin ------------------------------ */

  router.get('/repos/:repoId/status', async (req, res) => {
    try {
      res.json(await getRepoStatus(config, req.params.repoId));
    } catch (err) {
      handleAdminError(res, err);
    }
  });

  router.get('/repos/:repoId/clone-command', (req, res) => {
    const useUsername = req.query.useUsername !== 'false';
    try {
      res.json(getCloneCommand(config, req.params.repoId, useUsername));
    } catch (err) {
      handleAdminError(res, err);
    }
  });

  router.post('/repos/:repoId/clone', (req, res) => {
    const parsed = SyncParamsSchema.safeParse({ repoId: req.params.repoId });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid repo id.' });
    const { repoId } = parsed.data;
    if (!config.repos[repoId]) return res.status(404).json({ error: `Repo "${repoId}" not found.` });
    const v = validateBody(CloneBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const extra = v.data!.useUsername === false ? ['--no-username'] : [];
    return startJob(res, () => runner.start({ type: 'clone', repoId, extraArgs: extra }));
  });

  router.delete('/repos/:repoId/local', async (req, res) => {
    const parsed = SyncParamsSchema.safeParse({ repoId: req.params.repoId });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid repo id.' });
    const { repoId } = parsed.data;
    const v = validateBody(RemoveLocalBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    // Do not delete while a repo-wide git job (clone/sync) holds this repo.
    if (runner.isActive({ type: 'sync', repoId })) {
      return res.status(409).json({ error: 'A sync/clone is running for this repo. Wait for it to finish.' });
    }
    try {
      return res.json(await removeLocalRepo(config, repoId, { force: v.data!.force }));
    } catch (err) {
      return handleAdminError(res, err);
    }
  });

  /* -------------------------------- actions ------------------------------- */

  router.post('/repos/:repoId/sync', (req, res) => {
    const parsed = SyncParamsSchema.safeParse({ repoId: req.params.repoId });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid repo id.' });
    const { repoId } = parsed.data;
    if (!config.repos[repoId]) return res.status(404).json({ error: `Repo "${repoId}" not found.` });
    return startJob(res, () => runner.start({ type: 'sync', repoId }));
  });

  router.post('/reviews/run', (req, res) => {
    const v = validateBody(RunBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { issueKey, repoId, allowUnmapped, sync } = v.data!;
    const outcome = resolveSelection(config, issueKey, { repo: repoId, allowUnmapped });
    if (!outcome.ok) return res.status(400).json(outcome);
    const extra: string[] = [];
    if (isUnmapped(outcome.repo, outcome.key)) extra.push('--allow-unmapped');
    if (sync === false) extra.push('--no-sync');
    return startJob(res, () =>
      runner.start({ type: 'run-review', issueKey: outcome.key, repoId: outcome.repo.id, extraArgs: extra }),
    );
  });

  router.post('/reviews/followup', (req, res) => {
    const v = validateBody(FollowupBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { issueKey, repoId, allowUnmapped, fromHead, previous, sync, resume, resumeSession } = v.data!;
    const outcome = resolveSelection(config, issueKey, { repo: repoId, allowUnmapped });
    if (!outcome.ok) return res.status(400).json(outcome);
    const extra: string[] = [];
    if (fromHead) extra.push('--from-head', fromHead);
    if (previous) extra.push('--previous', previous);
    if (sync === false) extra.push('--no-sync');
    if (resume === false) extra.push('--no-resume');
    if (resumeSession) extra.push('--resume-session', resumeSession);
    if (isUnmapped(outcome.repo, outcome.key)) extra.push('--allow-unmapped');
    return startJob(res, () =>
      runner.start({ type: 'run-followup', issueKey: outcome.key, repoId: outcome.repo.id, extraArgs: extra }),
    );
  });

  router.post('/reviews/clean', (req, res) => {
    const v = validateBody(CleanBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { issueKey, repoId } = v.data!;
    // Cleaning should not be blocked by prefix mapping (mirror the CLI).
    const outcome = resolveSelection(config, issueKey, { repo: repoId, allowUnmapped: true });
    if (!outcome.ok) return res.status(400).json(outcome);
    return startJob(res, () =>
      runner.start({ type: 'clean', issueKey: outcome.key, repoId: outcome.repo.id }),
    );
  });

  /* -------------------------------- jql queue ----------------------------- */

  router.get('/jql/queries', async (_req, res) => {
    try {
      res.json({ queries: await listQueries(config) });
    } catch (err) {
      handleJqlError(res, err);
    }
  });

  router.post('/jql/queries', async (req, res) => {
    const v = validateBody(JqlQueryCreateSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      return res.status(201).json(await createQuery(config, v.data!));
    } catch (err) {
      return handleJqlError(res, err);
    }
  });

  router.put('/jql/queries/:id', async (req, res) => {
    const v = validateBody(JqlQueryUpdateSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      return res.json(await updateQuery(config, req.params.id, v.data!));
    } catch (err) {
      return handleJqlError(res, err);
    }
  });

  router.delete('/jql/queries/:id', async (req, res) => {
    try {
      const removed = await deleteQuery(config, req.params.id);
      if (!removed) {
        return res.status(404).json({ error: `Saved query "${req.params.id}" not found.` });
      }
      return res.json({ deleted: true });
    } catch (err) {
      return handleJqlError(res, err);
    }
  });

  router.post('/jql/search', async (req, res) => {
    const v = validateBody(JqlSearchSchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      return res.json(await runJqlSearch(config, v.data!));
    } catch (err) {
      return handleJqlError(res, err);
    }
  });

  /* -------------------------------- memory -------------------------------- */

  router.get('/memory', async (req, res) => {
    try {
      const { items, warnings } = await listMemory(config, {
        project: req.query.project ? String(req.query.project) : undefined,
        repo: req.query.repo ? String(req.query.repo) : undefined,
        type: req.query.type ? String(req.query.type) : undefined,
        status: req.query.status ? String(req.query.status) : undefined,
      });
      res.json({ items, warnings });
    } catch (err) {
      handleMemoryError(res, err);
    }
  });

  router.get('/memory/search', async (req, res) => {
    try {
      res.json(await searchMemory(config, String(req.query.q ?? '')));
    } catch (err) {
      handleMemoryError(res, err);
    }
  });

  router.post('/memory/reindex', async (_req, res) => {
    try {
      res.json(await reindex(config));
    } catch (err) {
      handleMemoryError(res, err);
    }
  });

  // Long-running: shells out to `nls-review memory propose` as a job.
  router.post('/memory/propose', (req, res) => {
    const v = validateBody(MemoryActionBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { issueKey, repoId } = v.data!;
    const outcome = resolveSelection(config, issueKey, { repo: repoId, allowUnmapped: true });
    if (!outcome.ok) return res.status(400).json(outcome);
    return startJob(res, () =>
      runner.start({ type: 'memory-propose', issueKey: outcome.key, repoId: outcome.repo.id }),
    );
  });

  router.get('/memory/:id', async (req, res) => {
    const id = MemoryIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'Invalid memory id.' });
    try {
      return res.json(await getMemoryItem(config, id.data));
    } catch (err) {
      return handleMemoryError(res, err);
    }
  });

  for (const action of ['approve', 'reject', 'deprecate'] as const) {
    router.post(`/memory/:id/${action}`, async (req, res) => {
      const id = MemoryIdSchema.safeParse(req.params.id);
      if (!id.success) return res.status(400).json({ error: 'Invalid memory id.' });
      try {
        return res.json(await memoryActions[action](config, id.data));
      } catch (err) {
        return handleMemoryError(res, err);
      }
    });
  }

  router.post('/learn/bugfix', (req, res) => {
    const v = validateBody(MemoryActionBodySchema, req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const { issueKey, repoId } = v.data!;
    const outcome = resolveSelection(config, issueKey, { repo: repoId, allowUnmapped: true });
    if (!outcome.ok) return res.status(400).json(outcome);
    return startJob(res, () =>
      runner.start({ type: 'learn-bugfix', issueKey: outcome.key, repoId: outcome.repo.id }),
    );
  });

  /* -------------------------------- outputs ------------------------------- */

  router.get(
    '/issues/:issueKey/:repoId/memory-context',
    wrapReader((r, p) => r.getMemoryContext(p.issueKey, p.repoId)),
  );

  router.get('/issues/:issueKey/:repoId/summary', wrapReader((r, p) => r.getSummary(p.issueKey, p.repoId)));
  router.get('/issues/:issueKey/:repoId/files', wrapReader(async (r, p) => ({
    files: await r.listFiles(p.issueKey, p.repoId),
  })));
  router.get('/issues/:issueKey/:repoId/review', wrapReader((r, p) => r.getReview(p.issueKey, p.repoId)));
  router.get('/issues/:issueKey/:repoId/followups', wrapReader((r, p) => r.getFollowups(p.issueKey, p.repoId)));
  router.get(
    '/issues/:issueKey/:repoId/claude-session',
    wrapReader((r, p) => r.getClaudeSession(p.issueKey, p.repoId)),
  );
  router.get(
    '/issues/:issueKey/:repoId/file',
    wrapReader((r, p, req) => r.readFile(p.issueKey, p.repoId, String(req.query.path ?? ''))),
  );

  /* --------------------------------- jobs --------------------------------- */

  router.get('/jobs', (_req, res) => {
    res.json({ jobs: store.list() });
  });

  router.get('/jobs/:jobId', (req, res) => {
    const job = store.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    return res.json(job);
  });

  // Server-Sent Events: replays existing logs, then streams live ones.
  router.get('/jobs/:jobId/events', (req, res) => {
    const job = store.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let lastStage: string | undefined;
    const maybeStage = (stage?: string): void => {
      if (stage && stage !== lastStage) {
        lastStage = stage;
        send('stage', { jobId: job.id, stage });
      }
    };
    const isTerminal = (status: string): boolean => status !== 'running' && status !== 'queued';

    // Backlog first so a late subscriber still sees the whole run.
    for (const line of job.logs) send('log', { jobId: job.id, line });
    maybeStage(job.stage);
    send('status', publicJob(store, job.id));

    const offLog = store.onLog((jid, line) => {
      if (jid === job.id) {
        maybeStage(line.stage);
        send('log', { jobId: jid, line });
      }
    });
    const offUpd = store.onUpdate((j) => {
      if (j.id !== job.id) return;
      maybeStage(j.stage);
      send('status', j);
      if (isTerminal(j.status)) {
        if (j.status === 'failed') send('error', { jobId: j.id, error: j.error ?? 'failed' });
        send('done', { jobId: j.id, status: j.status, verdict: j.verdict ?? null });
      }
    });

    // If the job already finished before this subscription, close promptly.
    if (isTerminal(job.status)) {
      if (job.status === 'failed') send('error', { jobId: job.id, error: job.error ?? 'failed' });
      send('done', { jobId: job.id, status: job.status, verdict: job.verdict ?? null });
    }

    req.on('close', () => {
      offLog();
      offUpd();
    });
    return undefined;
  });

  return router;

  /* ------------------------------- helpers -------------------------------- */

  function startJob(res: Response, fn: () => { id: string }): Response {
    try {
      const job = fn();
      return res.status(202).json(job);
    } catch (err) {
      if (err instanceof JobConflictError) return res.status(409).json({ error: err.message });
      return res.status(500).json({ error: (err as Error).message });
    }
  }

  function handleAdminError(res: Response, err: unknown): Response {
    if (err instanceof RepoAdminError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: (err as Error).message });
  }

  function handleMemoryError(res: Response, err: unknown): Response {
    if (err instanceof MemoryError) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: (err as Error).message });
  }

  /**
   * Turn a saved-query or Jira-search failure into a clean, secret-safe HTTP
   * response. JqlQueryError carries its own status; upstream Jira errors are
   * reduced to a readable message (never the token) — a 4xx from Jira (bad JQL /
   * auth) maps to 400, anything else to 502. The server never crashes.
   */
  function handleJqlError(res: Response, err: unknown): Response {
    if (err instanceof JqlQueryError) return res.status(err.status).json({ error: err.message });
    const upstream = (err as { response?: { status?: number } })?.response?.status;
    const status = upstream && upstream >= 400 && upstream < 500 ? 400 : 502;
    return res.status(status).json({ error: jiraErrorMessage(err) });
  }

  function wrapReader(
    fn: (
      reader: OutputReader,
      params: { issueKey: string; repoId: string },
      req: Request,
    ) => Promise<unknown>,
  ) {
    return async (req: Request, res: Response): Promise<void> => {
      try {
        const data = await fn(reader, { issueKey: req.params.issueKey, repoId: req.params.repoId }, req);
        res.json(data);
      } catch (err) {
        if (err instanceof PathSafetyError) {
          res.status(400).json({ error: err.message });
        } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: 'Not found.' });
        } else {
          res.status(500).json({ error: (err as Error).message });
        }
      }
    };
  }
}

function publicJob(store: JobStore, id: string) {
  return store.get(id);
}
