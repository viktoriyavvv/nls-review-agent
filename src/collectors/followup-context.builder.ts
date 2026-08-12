import { GitMetadata, FollowupDelta } from './git.collector';
import { NormalizedJira } from './jira.client';
import { PullRequestComment } from './bitbucket.types';
import { PrContext } from './context.builder';
import { PreviousReview } from '../review/previous-review';

/** Cap each inline diff so the combined context does not overflow the model. */
const MAX_DELTA_DIFF_CHARS = 90_000;
const MAX_FULL_DIFF_CHARS = 120_000;

export interface BuildFollowupContextParams {
  issueKey: string;
  jira: NormalizedJira;
  pr: PrContext;
  previous: PreviousReview;
  /** PR comments/replies (already deleted-filtered). May be empty/unavailable. */
  comments: PullRequestComment[];
  /** Whatever could be collected about comments failure (safe, no secrets). */
  commentsError?: string;
  delta: FollowupDelta;
  git: GitMetadata;
  /** Follow-up review instructions (prompt + output format). */
  instructions: string;
  /** Rendered `## Memory Context` block (approved local memory), if any. */
  memoryContext?: string;
}

export function buildFollowupContextMarkdown(params: BuildFollowupContextParams): string {
  const { issueKey, jira, pr, previous, comments, commentsError, delta, git, instructions, memoryContext } = params;
  const lines: string[] = [];

  lines.push('# Follow-up review context', '');
  lines.push(
    'This is a FOLLOW-UP review: verify whether the previous review findings were',
    'closed by the developer. It is NOT a fresh review from scratch.',
    '',
  );

  /* ----------------------------- Jira ----------------------------- */
  lines.push('## Jira', '');
  lines.push(`- key: ${jira.key || issueKey}`);
  lines.push(`- summary: ${jira.summary || '(none)'}`);
  lines.push(`- status: ${jira.status || '(unknown)'}`);
  if (jira.assignee) lines.push(`- assignee: ${jira.assignee}`);
  if (jira.url) lines.push(`- url: ${jira.url}`);
  lines.push('', '### Description', '', jira.descriptionText.trim() || '(empty)', '');
  if (jira.comments.length) {
    lines.push('### Jira comments', '');
    for (const c of jira.comments) {
      lines.push(`- **${c.author}**${c.created ? ` (${c.created})` : ''}: ${oneLine(c.body)}`);
    }
    lines.push('');
  }

  /* -------------------------- Bitbucket PR -------------------------- */
  lines.push('## Bitbucket PR', '');
  if (pr.provider) lines.push(`- Provider: ${pr.provider}`);
  if (pr.workspace) lines.push(`- Workspace: ${pr.workspace}`);
  if (pr.repoSlug) lines.push(`- Repo slug: ${pr.repoSlug}`);
  if (pr.found && pr.details) {
    const d = pr.details;
    lines.push(`- PR id: ${d.id}`);
    lines.push(`- PR title: ${d.title}`);
    lines.push(`- PR state: ${d.state}`);
    lines.push(`- Source branch: ${d.fromRef.branch}`);
    lines.push(`- Target branch: ${d.toRef.branch}`);
    if (d.fromRef.latestCommit) lines.push(`- Source commit: ${d.fromRef.latestCommit}`);
    if (d.author) lines.push(`- Author: ${d.author}`);
    if (d.reviewers.length) {
      lines.push(
        `- Reviewers: ${d.reviewers
          .map((r) => `${r.name} [${r.status ?? (r.approved ? 'APPROVED' : 'UNAPPROVED')}]`)
          .join(', ')}`,
      );
    }
    if (d.url) lines.push(`- Link: ${d.url}`);
  } else {
    lines.push('- prFound: false', '', 'PR not found or unavailable. Running branch-only follow-up.');
  }
  lines.push('');

  /* -------------------------- Previous review -------------------------- */
  lines.push('## Previous review', '');
  lines.push(`- source: ${previous.source}`);
  lines.push(`- verdict: ${previous.verdict ?? '(unknown)'}`);
  if (previous.head) lines.push(`- checked HEAD: ${previous.head}`);
  if (previous.branch) lines.push(`- branch: ${previous.branch}`);
  if (previous.summary) {
    lines.push('', '### Previous summary', '', previous.summary.trim());
  }
  if (previous.blockers.length) {
    lines.push('', '### Previous blockers (must be verified)', '');
    for (const b of previous.blockers) {
      lines.push(`- **${b.title}**${b.file ? ` (\`${b.file}\`)` : ''}`);
      if (b.evidence) lines.push(`  - evidence: ${oneLine(b.evidence)}`);
    }
  }
  if (previous.risks.length) {
    lines.push('', '### Previous risks (must be verified)', '');
    for (const r of previous.risks) {
      lines.push(`- **[${r.level ?? 'medium'}] ${r.title}**`);
      if (r.evidence) lines.push(`  - evidence: ${oneLine(r.evidence)}`);
    }
  }
  if (previous.questionsForDeveloper.length) {
    lines.push('', '### Previous questions for developer', '');
    for (const q of previous.questionsForDeveloper) lines.push(`- ${q}`);
  }
  if (previous.bitbucketComment) {
    lines.push('', '### Previous Bitbucket comment', '', '```md', previous.bitbucketComment.trim(), '```');
  }
  lines.push('');

  /* ---------------------- Developer comments / replies ---------------------- */
  lines.push('## Developer comments / replies', '');
  if (commentsError) {
    lines.push(`Bitbucket comments unavailable: ${commentsError}`, '');
  } else if (!comments.length) {
    lines.push('(no PR comments)', '');
  } else {
    lines.push(...renderThreadedComments(comments));
    lines.push('');
  }

  /* ---------------------- Git delta since previous review ---------------------- */
  lines.push('## Git delta since previous review', '');
  lines.push(`- previous HEAD: ${delta.previousHead ?? '(none)'}`);
  lines.push(`- current HEAD: ${delta.currentHead}`);
  if (delta.error) {
    lines.push(`- ⚠️ ${delta.error}`);
  }
  if (!delta.isAncestor && delta.hasPreviousHead) {
    lines.push(
      '- ⚠️ Previous HEAD is not an ancestor of current HEAD. Follow-up may be less precise.',
    );
  }
  lines.push('', '### Commits since previous review', '');
  lines.push('```', delta.commitsOneline.trim() || '(none)', '```');
  if (delta.commitsFuller.trim()) {
    lines.push('', '<details><summary>commits (fuller)</summary>', '', '```', delta.commitsFuller.trim(), '```', '', '</details>');
  }
  if (delta.changedFiles.length) {
    lines.push('', '### Changed files since previous review', '', '```', delta.changedFiles.join('\n'), '```');
  }
  lines.push('', '### Diff previousHead..HEAD', '');
  lines.push('```patch', capDiff(delta.diff, MAX_DELTA_DIFF_CHARS) || '(no delta diff)', '```');
  lines.push('');

  /* ---------------------- Current full diff ---------------------- */
  lines.push('## Current full diff', '');
  lines.push(`Range: ${git.baseBranch}...HEAD`, '');
  if (git.diffError) lines.push(`> ${git.diffError}`, '');
  lines.push('```patch', capDiff(git.diff, MAX_FULL_DIFF_CHARS) || '(no diff)', '```');
  lines.push('');

  /* -------------------------- Memory Context -------------------------- */
  if (memoryContext && memoryContext.trim()) {
    lines.push(memoryContext.trim(), '');
  }

  /* -------------------------- Instructions -------------------------- */
  lines.push('## Instructions', '');
  lines.push(instructions.trim(), '');

  return lines.join('\n');
}

/** Render comments as threads: top-level first, replies indented under parents. */
function renderThreadedComments(comments: PullRequestComment[]): string[] {
  const lines: string[] = [];
  const byParent = new Map<string, PullRequestComment[]>();
  const tops: PullRequestComment[] = [];
  for (const c of comments) {
    if (c.parentId != null) {
      const key = String(c.parentId);
      const arr = byParent.get(key) ?? [];
      arr.push(c);
      byParent.set(key, arr);
    } else {
      tops.push(c);
    }
  }

  const renderOne = (c: PullRequestComment, depth: number): void => {
    const indent = '  '.repeat(depth);
    const where = c.inline?.path ? ` _(inline: ${c.inline.path}${c.inline.to ? `:${c.inline.to}` : ''})_` : '';
    lines.push(`${indent}- **${c.author}**${where}: ${oneLine(c.text)}`);
    const replies = byParent.get(String(c.id)) ?? [];
    for (const r of replies) renderOne(r, depth + 1);
  };

  for (const top of tops) renderOne(top, 0);

  // Any replies whose parent was filtered out (e.g. deleted parent): render flat.
  const renderedIds = new Set(comments.filter((c) => c.parentId == null).map((c) => String(c.id)));
  for (const c of comments) {
    if (c.parentId != null && !renderedIds.has(String(c.parentId))) {
      lines.push(`- **${c.author}** (reply): ${oneLine(c.text)}`);
    }
  }
  return lines;
}

function capDiff(diff: string, max: number): string {
  const d = (diff ?? '').trimEnd();
  if (d.length <= max) return d;
  return `${d.slice(0, max)}\n... [truncated to ${max} chars; full diff on disk]`;
}

function oneLine(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
