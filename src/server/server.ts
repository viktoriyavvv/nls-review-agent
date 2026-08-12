import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';

import { loadConfig } from '../config/loadConfig';
import { logger } from '../utils/logger';
import { JobStore } from './job-store';
import { JobRunner } from './job-runner';
import { OutputReader } from './services/output-reader';
import { createApiRouter } from './api';

export interface StartServerOptions {
  projectRoot?: string;
  port?: number;
  /** When true, do not serve the built web/ SPA (dev uses the Vite server). */
  apiOnly?: boolean;
}

export function createServer(opts: StartServerOptions = {}) {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const config = loadConfig({ projectRoot });

  const store = new JobStore();
  const runner = new JobRunner(store, { projectRoot });
  const reader = new OutputReader(config);

  const app = express();
  app.use(cors()); // local single-user tool; allows the Vite dev origin
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createApiRouter({ config, store, runner, reader }));

  const webDist = path.join(projectRoot, 'web', 'dist');
  const hasWeb = !opts.apiOnly && fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    app.use(express.static(webDist));
    // SPA fallback (client-side routing) — never shadow /api.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      return res.sendFile(path.join(webDist, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res
        .type('text/plain')
        .send(
          'NLS Review Agent API is running.\n' +
            (opts.apiOnly
              ? 'Dev mode: open the Vite dev server (npm run dev:gui).\n'
              : 'Build the web UI first: npm run build:web (or npm run gui).\n'),
        );
    });
  }

  return { app, config, store, runner, reader, hasWeb };
}

export function startServer(opts: StartServerOptions = {}): void {
  const port = opts.port ?? Number(process.env.GUI_PORT ?? 5174);
  const { app, config, hasWeb } = createServer(opts);
  app.listen(port, () => {
    logger.success(`NLS Review GUI on http://localhost:${port}`);
    logger.info(`Read-only mode: no writes to Jira or Bitbucket.`);
    logger.info(`Repos configured: ${Object.keys(config.repos).length}`);
    if (!hasWeb && !opts.apiOnly) {
      logger.warn('web/dist not found — serving API only. Run "npm run build:web".');
    }
  });
}

// Run directly: `node dist/server/server.js`
if (require.main === module) {
  const apiOnly = process.env.GUI_API_ONLY === '1' || process.argv.includes('--api-only');
  try {
    startServer({ apiOnly });
  } catch (err) {
    logger.error((err as Error).message);
    process.exit(1);
  }
}
