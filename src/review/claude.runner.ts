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
  /** When set, resume this Claude session (`claude --resume <id>`). */
  resumeSessionId?: string;
  /**
   * Called with each streamed output line (a digest for stream-json, progress
   * for stderr). Purely for live UX — the final result still comes from the
   * buffered stdout. Never receives the giant final JSON blob in `json` mode.
   */
  onEvent?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface ClaudeRunResult {
  /** Raw stdout from the Claude CLI (the JSON envelope / NDJSON, ideally). */
  raw: string;
  /** Parsed CLI envelope (object for json, event array for stream-json). */
  envelope: any | null;
  /** The model's final result text (envelope.result, or raw if no envelope). */
  resultText: string;
  /** Best-effort Claude session id, for later `--resume`. */
  sessionId: string | null;
  exitCode: number;
  stderr: string;
}

/** Fields that may carry a Claude session/conversation id, in priority order. */
const SESSION_ID_FIELDS = ['session_id', 'sessionId', 'conversation_id', 'conversationId'];

/**
 * Best-effort session-id extraction from a Claude CLI envelope or stream event.
 * `id` is only consulted for the top-level json envelope (opt-in) because
 * per-message stream events also carry unrelated `id`s.
 */
export function extractSessionId(
  source: unknown,
  opts: { includeGenericId?: boolean } = {},
): string | null {
  if (!source || typeof source !== 'object') return null;
  const obj = source as Record<string, unknown>;
  const fields = [...SESSION_ID_FIELDS];
  if (opts.includeGenericId !== false) fields.push('id');
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
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
 * this is `claude -p "<context>" <flags>`. `stream-json` output requires
 * `--verbose` in print mode.
 */
export function buildClaudeArgs(opts: ClaudeRunOptions): string[] {
  const args = ['-p'];
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  args.push(
    ...buildPermissionArgs(opts.permissionMode),
    '--effort',
    opts.effort,
    '--model',
    opts.model,
    '--output-format',
    opts.outputFormat,
  );
  if (opts.outputFormat === 'stream-json') {
    args.push('--verbose');
  }
  if (opts.maxTurns) {
    args.push('--max-turns', String(opts.maxTurns));
  }
  return args;
}

function quoteArg(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}

/** A short, human-readable one-liner (or few) describing a stream-json event. */
export function summarizeStreamEvent(evt: any): string[] {
  if (!evt || typeof evt !== 'object') return [];
  switch (evt.type) {
    case 'system': {
      const sid = typeof evt.session_id === 'string' ? evt.session_id.slice(0, 8) : '';
      const model = typeof evt.model === 'string' ? ` · model ${evt.model}` : '';
      const tools = Array.isArray(evt.tools) ? ` · ${evt.tools.length} tools` : '';
      return [`session ${sid} started${model}${tools}`.trim()];
    }
    case 'assistant': {
      const out: string[] = [];
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            const s = block.text.trim().replace(/\s+/g, ' ');
            if (s) out.push(s.length > 240 ? `${s.slice(0, 240)}…` : s);
          } else if (block?.type === 'tool_use') {
            out.push(`→ ${block.name ?? 'tool'}`);
          }
        }
      }
      return out;
    }
    case 'user':
      return ['← tool result'];
    case 'result': {
      const dur = typeof evt.duration_ms === 'number' ? ` · ${Math.round(evt.duration_ms / 1000)}s` : '';
      const turns = typeof evt.num_turns === 'number' ? ` · ${evt.num_turns} turns` : '';
      const cost = typeof evt.total_cost_usd === 'number' ? ` · $${evt.total_cost_usd.toFixed(2)}` : '';
      return [`result: ${evt.subtype ?? 'done'}${dur}${turns}${cost}`];
    }
    default:
      return [];
  }
}

/** Parse newline-delimited stream-json into the final result + session id. */
export function parseStreamJson(raw: string): { resultText: string; sessionId: string | null; events: any[] } {
  const events: any[] = [];
  let sessionId: string | null = null;
  let resultText = '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let evt: any;
    try {
      evt = JSON.parse(s);
    } catch {
      continue;
    }
    events.push(evt);
    const sid = extractSessionId(evt, { includeGenericId: false });
    if (sid) sessionId = sid;
    if (evt.type === 'result' && typeof evt.result === 'string') resultText = evt.result;
  }
  if (!resultText) {
    const texts: string[] = [];
    for (const evt of events) {
      const content = evt?.type === 'assistant' ? evt.message?.content : null;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      }
    }
    resultText = texts.join('\n').trim();
  }
  return { resultText, sessionId, events };
}

/** Split streamed chunks into complete lines and hand each to `onLine`. */
function makeLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.length) onLine(line);
      nl = buf.indexOf('\n');
    }
  };
}

function makeStdoutHandler(opts: ClaudeRunOptions, isStream: boolean): ((chunk: string) => void) | undefined {
  if (!opts.onEvent) return undefined;
  if (isStream) {
    return makeLineSplitter((line) => {
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      for (const d of summarizeStreamEvent(evt)) opts.onEvent!(d, 'stdout');
    });
  }
  // `json` mode emits only a final giant blob — don't stream it line by line.
  if (opts.outputFormat === 'json') return undefined;
  // text / other: forward raw lines as they arrive.
  return makeLineSplitter((line) => opts.onEvent!(line, 'stdout'));
}

/**
 * Run the Claude CLI in non-interactive (headless) mode from the worktree cwd.
 * Effective command:
 *   claude -p "<context>" [--resume <id>] --dangerously-skip-permissions \
 *     --effort max --model opus --output-format json
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
  const isStream = opts.outputFormat === 'stream-json';

  const onStdout = makeStdoutHandler(opts, isStream);
  const onStderr = opts.onEvent
    ? makeLineSplitter((line) => opts.onEvent!(line, 'stderr'))
    : undefined;

  const res = useShell
    ? await run([quoteArg(opts.bin), ...flags].join(' '), [], {
        cwd: opts.cwd,
        input: context,
        shell: true,
        onStdout,
        onStderr,
      })
    : await run(opts.bin, flags, { cwd: opts.cwd, input: context, shell: false, onStdout, onStderr });

  const raw = res.stdout;
  let envelope: any | null = null;
  let resultText = raw;
  let sessionId: string | null = null;

  if (isStream) {
    const parsed = parseStreamJson(raw);
    resultText = parsed.resultText || raw;
    sessionId = parsed.sessionId;
    envelope = parsed.events.length ? parsed.events : null;
  } else {
    try {
      const parsed = JSON.parse(raw);
      envelope = parsed;
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
        resultText = parsed.result;
      }
      sessionId = extractSessionId(parsed);
    } catch {
      // stdout was not JSON; keep raw as resultText.
    }
  }

  return {
    raw,
    envelope,
    resultText,
    sessionId,
    exitCode: res.code,
    stderr: res.stderr,
  };
}
