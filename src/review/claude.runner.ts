import { run } from '../utils/exec';

export interface ClaudeRunOptions {
  bin: string;
  model: string;
  effort: string;
  permissionMode?: string;
  outputFormat: string;
  /** Optional. When unset, no --max-turns flag is added. */
  maxTurns?: number;
  cwd: string;
}

export interface ClaudeRunResult {
  /** Raw stdout from the Claude CLI (the JSON envelope, ideally). */
  raw: string;
  /** Parsed CLI envelope, if stdout was JSON. */
  envelope: any | null;
  /** The model's final result text (envelope.result, or raw if no envelope). */
  resultText: string;
  exitCode: number;
  stderr: string;
}

/**
 * Map a permission mode string to CLI args.
 * - "dangerously-skip-permissions" -> --dangerously-skip-permissions
 * - "default" or empty             -> no flag
 * - anything else                  -> --permission-mode <mode>
 */
export function buildPermissionArgs(permissionMode?: string): string[] {
  if (!permissionMode) return [];
  if (permissionMode === 'dangerously-skip-permissions') {
    return ['--dangerously-skip-permissions'];
  }
  if (permissionMode === 'default') {
    return [];
  }
  return ['--permission-mode', permissionMode];
}

/**
 * Build the Claude CLI flags. The context is delivered on stdin (not as the -p
 * value) so large diffs never hit the OS command-line length limit; functionally
 * this is `claude -p "<context>" <flags>`.
 */
export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args = [
    '-p',
    ...buildPermissionArgs(opts.permissionMode),
    '--effort',
    opts.effort,
    '--model',
    opts.model,
    '--output-format',
    opts.outputFormat,
  ];
  if (opts.maxTurns) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  return args;
}

function quoteArg(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Run the Claude CLI in non-interactive (headless) mode from the worktree cwd.
 * Effective command:
 *   claude -p "<context>" --dangerously-skip-permissions --effort max \
 *     --model opus --output-format json
 * (context is piped via stdin).
 */
export async function runClaude(
  context: string,
  opts: ClaudeRunOptions,
): Promise<ClaudeRunResult> {
  // .cmd/.bat shims on Windows require a shell to resolve. With shell:true we
  // pass the whole command as a single string + empty args (all flags are fixed,
  // the context is piped via stdin) to avoid Node's shell+args deprecation.
  const useShell = process.platform === 'win32';
  const flags = buildClaudeArgs(opts);

  const res = useShell
    ? await run([quoteArg(opts.bin), ...flags].join(' '), [], {
        cwd: opts.cwd,
        input: context,
        shell: true,
      })
    : await run(opts.bin, flags, { cwd: opts.cwd, input: context, shell: false });

  const raw = res.stdout;
  let envelope: any | null = null;
  let resultText = raw;

  try {
    const parsed = JSON.parse(raw);
    envelope = parsed;
    if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
      resultText = parsed.result;
    }
  } catch {
    // stdout was not JSON; keep raw as resultText.
  }

  return {
    raw,
    envelope,
    resultText,
    exitCode: res.code,
    stderr: res.stderr,
  };
}
