// Dev launcher: runs the Express API (tsx watch, API-only) and the Vite dev
// server together. Production uses `npm run gui` (single Express process serving
// the built SPA). Ctrl-C stops both.
import { spawn } from 'node:child_process';

const PORT = process.env.GUI_PORT ?? '5174';
const WEB_PORT = process.env.GUI_WEB_PORT ?? '5173';

const procs = [];

function run(name, command, env) {
  const child = spawn(command, {
    shell: true, // static literal commands; needed for .cmd shims on Windows
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  child.on('exit', (code) => {
    console.log(`[dev-gui] ${name} exited (${code}). Stopping.`);
    shutdown();
  });
  procs.push(child);
}

function shutdown() {
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[dev-gui] API  -> http://localhost:${PORT}`);
console.log(`[dev-gui] Web  -> http://localhost:${WEB_PORT} (open this one)`);

run('api', 'npx tsx watch src/server/server.ts', { GUI_API_ONLY: '1', GUI_PORT: PORT });
run('web', 'npm --prefix web run dev', { GUI_WEB_PORT: WEB_PORT });
