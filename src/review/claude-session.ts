import { OUTPUT_FILES, outputFile } from '../utils/paths';
import { pathExists, readJson, writeJson } from '../utils/fs';

/**
 * Persisted pointer to the Claude session created by the *initial* review, so a
 * later follow-up can `claude --resume <id>` and continue the same discussion.
 */
export interface ClaudeSessionFile {
  issueKey: string;
  repoId: string;
  initialReviewSessionId: string | null;
  initialReviewHead: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where the id was found (e.g. "review.raw.json"). */
  source: string;
}

export interface SaveClaudeSessionInput {
  outputsDir: string;
  issueKey: string;
  repoId: string;
  sessionId: string | null;
  head?: string | null;
  source: string;
  /** ISO timestamp (passed in so this module stays deterministic). */
  nowIso: string;
}

/** Write / refresh outputs/<issue>/<repo>/claude-session.json (createdAt kept). */
export async function saveClaudeSession(input: SaveClaudeSessionInput): Promise<void> {
  const file = outputFile(input.outputsDir, input.issueKey, input.repoId, OUTPUT_FILES.claudeSession);
  const existing = await loadClaudeSession(input.outputsDir, input.issueKey, input.repoId);
  const record: ClaudeSessionFile = {
    issueKey: input.issueKey,
    repoId: input.repoId,
    initialReviewSessionId: input.sessionId ?? null,
    initialReviewHead: input.head ?? null,
    createdAt: existing?.createdAt || input.nowIso,
    updatedAt: input.nowIso,
    source: input.source,
  };
  await writeJson(file, record);
}

/** Read the saved session pointer, or null when absent / unreadable. */
export async function loadClaudeSession(
  outputsDir: string,
  issueKey: string,
  repoId: string,
): Promise<ClaudeSessionFile | null> {
  const file = outputFile(outputsDir, issueKey, repoId, OUTPUT_FILES.claudeSession);
  if (!(await pathExists(file))) return null;
  try {
    return await readJson<ClaudeSessionFile>(file);
  } catch {
    return null;
  }
}
