/**
 * Pure decision helpers for `run` / `followup`. Kept free of I/O so they can be
 * unit-tested directly (the surrounding command functions do real git/Jira/Claude
 * work that is exercised by smoke tests instead).
 */

/** Auto-sync (git fetch --all --prune) runs unless the user passed --no-sync. */
export function shouldAutoSync(options: { sync?: boolean }): boolean {
  return options.sync !== false;
}

export interface ResumePlanInput {
  /** commander `resume` flag: true/undefined = allowed, false = --no-resume. */
  resume?: boolean;
  /** Explicit --resume-session <id> (highest priority when resume is allowed). */
  resumeSession?: string;
  /** Session id saved by the initial review, if any. */
  savedSessionId?: string | null;
}

export interface ResumePlan {
  enabled: boolean;
  sessionId: string | null;
  /** Where the session id came from. */
  source: 'flag' | 'saved' | 'none';
  /** Human-readable reason, mainly for logging when not enabled. */
  reason?: string;
}

/**
 * Decide whether (and with which id) a follow-up should resume the initial
 * Claude session:
 *  - --no-resume            -> disabled
 *  - --resume-session <id>  -> use that id (overrides the saved one)
 *  - a saved session id     -> use it (default behaviour)
 *  - otherwise              -> stateless (nothing to resume)
 */
export function resolveResumePlan(input: ResumePlanInput): ResumePlan {
  if (input.resume === false) {
    return { enabled: false, sessionId: null, source: 'none', reason: 'disabled by --no-resume' };
  }
  const explicit = input.resumeSession?.trim();
  if (explicit) {
    return { enabled: true, sessionId: explicit, source: 'flag' };
  }
  const saved = input.savedSessionId?.trim();
  if (saved) {
    return { enabled: true, sessionId: saved, source: 'saved' };
  }
  return {
    enabled: false,
    sessionId: null,
    source: 'none',
    reason: 'no saved Claude session id (run an initial review first, or pass --resume-session)',
  };
}

/**
 * After a resumed Claude run, decide whether to fall back to a plain stateless
 * follow-up. We fall back when the resumed process failed or produced nothing —
 * a bad/expired session id must never sink the whole follow-up.
 */
export function shouldFallbackToStateless(result: { exitCode: number; resultText: string }): boolean {
  return result.exitCode !== 0 || result.resultText.trim().length === 0;
}

/** Prepend a `/compact` directive so a resumed session trims context first. */
export function withCompactDirective(context: string): string {
  return `/compact\n\n${context}`;
}
