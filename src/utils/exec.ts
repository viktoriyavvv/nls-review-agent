import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin then closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Run through the OS shell (needed on Windows for .cmd/.bat binaries). */
  shell?: boolean;
  /** Called with each stdout chunk as it arrives (in addition to buffering). */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives (in addition to buffering). */
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn a process and capture stdout/stderr. Uses streaming buffers (no maxBuffer
 * limit) so large git diffs are captured in full. Never rejects on a non-zero
 * exit code — the caller inspects `code`. Rejects only when the process fails to
 * spawn at all (e.g. binary not found).
 */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on('data', (d: Buffer) => {
      const b = Buffer.from(d);
      stdout.push(b);
      if (options.onStdout) options.onStdout(b.toString('utf8'));
    });
    child.stderr?.on('data', (d: Buffer) => {
      const b = Buffer.from(d);
      stderr.push(b);
      if (options.onStderr) options.onStderr(b.toString('utf8'));
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 0,
      });
    });

    if (options.input !== undefined) {
      // Swallow EPIPE if the child exits before consuming stdin.
      child.stdin?.on('error', () => {});
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

export class GitError extends Error {
  constructor(message: string, readonly result: RunResult) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  cwd?: string;
  /** When true, do not throw on a non-zero exit; return the result instead. */
  allowFailure?: boolean;
}

/** Run a git command. Throws GitError on non-zero exit unless allowFailure is set. */
export async function git(args: string[], opts: GitOptions = {}): Promise<RunResult> {
  const res = await run('git', args, { cwd: opts.cwd });
  if (res.code !== 0 && !opts.allowFailure) {
    throw new GitError(
      `git ${args.join(' ')} failed (exit ${res.code})${res.stderr ? `: ${res.stderr.trim()}` : ''}`,
      res,
    );
  }
  return res;
}
