/**
 * Prompt assembly for `memory propose` and `learn bugfix`.
 *
 * Pure builders: they take already-collected data (outputs, Jira, diff) and
 * return the full prompt text for Claude. All IO (reading outputs, fetching
 * Jira, git) stays in the CLI command handlers. Every section is size-capped so
 * a huge review/diff cannot blow up the request.
 */

import { NormalizedJira } from '../collectors/jira.client';

export interface ExistingMemoryRef {
  id: string;
  title: string;
}

const CAP_DESCRIPTION = 4_000;
const CAP_RESULT_JSON = 6_000;
const CAP_MD = 6_000;
const CAP_DIFF = 50_000;
const MAX_COMMENTS = 12;
const CAP_COMMENT = 400;

function cap(text: string | null | undefined, max: number): string {
  const t = (text ?? '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n... [truncated to ${max} chars]`;
}

function jsonBlock(value: unknown, max: number): string {
  if (value == null) return '(none)';
  try {
    return `\`\`\`json\n${cap(JSON.stringify(value, null, 2), max)}\n\`\`\``;
  } catch {
    return '(unserializable)';
  }
}

function jiraSection(issueKey: string, jira: Partial<NormalizedJira> | null | undefined): string[] {
  const lines: string[] = [`## Jira issue ${issueKey}`, ''];
  if (!jira) {
    lines.push('(no jira.json in outputs)', '');
    return lines;
  }
  lines.push(`- summary: ${jira.summary ?? '(none)'}`);
  lines.push(`- status: ${jira.status ?? '(unknown)'}`);
  if (jira.issuetype) lines.push(`- type: ${jira.issuetype}`);
  if (jira.assignee) lines.push(`- assignee: ${jira.assignee}`);
  lines.push('', '### Description', '', cap(jira.descriptionText, CAP_DESCRIPTION) || '(empty)', '');
  const comments = (jira.comments ?? []).slice(-MAX_COMMENTS);
  if (comments.length) {
    lines.push('### Comments (latest)', '');
    for (const c of comments) {
      lines.push(`- **${c.author}**${c.created ? ` (${c.created})` : ''}: ${cap(c.body, CAP_COMMENT)}`);
    }
    lines.push('');
  }
  return lines;
}

function existingMemorySection(existing: ExistingMemoryRef[]): string[] {
  const lines = ['## Existing approved memory (do NOT duplicate)', ''];
  if (!existing.length) {
    lines.push('(none yet)', '');
  } else {
    for (const m of existing.slice(0, 100)) lines.push(`- ${m.id} — ${m.title}`);
    lines.push('');
  }
  return lines;
}

/* ------------------------------- propose -------------------------------- */

export interface ProposeDigestInputs {
  issueKey: string;
  repoId: string;
  jira?: Partial<NormalizedJira> | null;
  review?: unknown | null;
  reviewMd?: string | null;
  followup?: unknown | null;
  followupMd?: string | null;
  existingMemory: ExistingMemoryRef[];
}

export function buildMemoryProposalPrompt(promptText: string, inputs: ProposeDigestInputs): string {
  const lines: string[] = [promptText.trim(), '', '---', '', '# Input', ''];
  lines.push(`- issueKey: ${inputs.issueKey}`);
  lines.push(`- repoId: ${inputs.repoId}`, '');

  lines.push(...jiraSection(inputs.issueKey, inputs.jira));

  lines.push('## Initial review result', '');
  if (inputs.review) lines.push(jsonBlock(inputs.review, CAP_RESULT_JSON), '');
  else if (inputs.reviewMd) lines.push(cap(inputs.reviewMd, CAP_MD), '');
  else lines.push('(no initial review found)', '');

  lines.push('## Latest follow-up result', '');
  if (inputs.followup) lines.push(jsonBlock(inputs.followup, CAP_RESULT_JSON), '');
  else if (inputs.followupMd) lines.push(cap(inputs.followupMd, CAP_MD), '');
  else lines.push('(no follow-up found)', '');

  lines.push(...existingMemorySection(inputs.existingMemory));
  lines.push('Ответ: строго JSON по схеме MemoryProposalResult, без пояснений.');
  return lines.join('\n');
}

/* ----------------------------- bugfix learn ----------------------------- */

export interface RelatedReviewRef {
  issueKey: string;
  review?: unknown | null;
  followup?: unknown | null;
}

export interface BugfixDiffInfo {
  branch: string;
  baseBranch: string;
  changedFiles: string[];
  diff: string;
}

export interface BugfixDigestInputs {
  issueKey: string;
  repoId: string;
  jira: Partial<NormalizedJira> | null;
  related: RelatedReviewRef[];
  diff?: BugfixDiffInfo | null;
  diffNote?: string;
  existingMemory: ExistingMemoryRef[];
}

export function buildBugfixLearningPrompt(promptText: string, inputs: BugfixDigestInputs): string {
  const lines: string[] = [promptText.trim(), '', '---', '', '# Input', ''];
  lines.push(`- bugfix issueKey: ${inputs.issueKey}`);
  lines.push(`- repoId: ${inputs.repoId}`, '');

  lines.push(...jiraSection(inputs.issueKey, inputs.jira));

  lines.push('## Related previous reviews / follow-ups', '');
  if (!inputs.related.length) {
    lines.push('(none found in outputs — analyze the bugfix on its own)', '');
  } else {
    for (const rel of inputs.related) {
      lines.push(`### ${rel.issueKey}`, '');
      if (rel.review) lines.push('Initial review:', jsonBlock(rel.review, CAP_RESULT_JSON), '');
      if (rel.followup) lines.push('Latest follow-up:', jsonBlock(rel.followup, CAP_RESULT_JSON), '');
      if (!rel.review && !rel.followup) lines.push('(outputs empty)', '');
    }
  }

  lines.push('## Bugfix branch diff (best-effort)', '');
  if (inputs.diff) {
    lines.push(`- branch: ${inputs.diff.branch}`);
    lines.push(`- base: ${inputs.diff.baseBranch}`, '');
    if (inputs.diff.changedFiles.length) {
      lines.push('### Changed files', '', '```', inputs.diff.changedFiles.slice(0, 100).join('\n'), '```', '');
    }
    lines.push('### Diff', '', '```patch', cap(inputs.diff.diff, CAP_DIFF) || '(empty diff)', '```', '');
  } else {
    lines.push(`(diff unavailable${inputs.diffNote ? `: ${inputs.diffNote}` : ''})`, '');
  }

  lines.push(...existingMemorySection(inputs.existingMemory));
  lines.push('Ответ: строго JSON по схеме MemoryProposalResult, без пояснений.');
  return lines.join('\n');
}
