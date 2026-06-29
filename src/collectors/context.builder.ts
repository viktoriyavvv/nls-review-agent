import { GitMetadata } from './git.collector';
import { NormalizedJira } from './jira.client';
import {
  PullRequestComment,
  PullRequestCommit,
  PullRequestDetails,
  PullRequestDiffStat,
} from './bitbucket.types';

/** Cap the inline diff so we don't overflow the model context; full diff is on disk. */
const MAX_DIFF_CHARS = 180_000;

export interface PrContext {
  found: boolean;
  provider?: string;
  workspace?: string;
  repoSlug?: string;
  details?: PullRequestDetails;
  comments?: PullRequestComment[];
  commits?: PullRequestCommit[];
  diffStat?: PullRequestDiffStat[];
}

export interface BuildContextParams {
  issueKey: string;
  jira: NormalizedJira;
  pr: PrContext;
  git: GitMetadata;
  /** Combined review instructions (review prompt + output format). */
  instructions: string;
}

export function buildContextMarkdown(params: BuildContextParams): string {
  const { issueKey, jira, pr, git, instructions } = params;
  const lines: string[] = [];

  lines.push('# Review context', '');

  /* ----------------------------- Jira ----------------------------- */
  lines.push('## Jira', '');
  lines.push(`- key: ${jira.key || issueKey}`);
  lines.push(`- summary: ${jira.summary || '(none)'}`);
  lines.push(`- status: ${jira.status || '(unknown)'}`);
  if (jira.issuetype) lines.push(`- type: ${jira.issuetype}`);
  if (jira.priority) lines.push(`- priority: ${jira.priority}`);
  if (jira.assignee) lines.push(`- assignee: ${jira.assignee}`);
  if (jira.reporter) lines.push(`- reporter: ${jira.reporter}`);
  if (jira.labels.length) lines.push(`- labels: ${jira.labels.join(', ')}`);
  if (jira.components.length) lines.push(`- components: ${jira.components.join(', ')}`);
  if (jira.fixVersions.length) lines.push(`- fixVersions: ${jira.fixVersions.join(', ')}`);
  if (jira.url) lines.push(`- url: ${jira.url}`);
  lines.push('');

  lines.push('### Description', '');
  lines.push(jira.descriptionText.trim() || '(empty)', '');

  for (const cf of jira.customFields) {
    if (cf.value && cf.value.trim()) {
      lines.push(`### ${cf.label}`, '', cf.value.trim(), '');
    }
  }

  if (jira.comments.length) {
    lines.push('### Comments', '');
    for (const c of jira.comments) {
      lines.push(`- **${c.author}**${c.created ? ` (${c.created})` : ''}: ${oneLine(c.body)}`);
    }
    lines.push('');
  }

  if (jira.links.length) {
    lines.push('### Links', '');
    for (const l of jira.links) {
      lines.push(
        `- ${l.type} (${l.direction}): ${l.key}${l.summary ? ` — ${l.summary}` : ''}${
          l.status ? ` [${l.status}]` : ''
        }`,
      );
    }
    lines.push('');
  }

  if (jira.attachments.length) {
    lines.push('### Attachments', '');
    for (const a of jira.attachments) {
      lines.push(`- ${a.filename}${a.mimeType ? ` (${a.mimeType})` : ''}`);
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
      const rv = d.reviewers
        .map((r) => `${r.name} [${r.status ?? (r.approved ? 'APPROVED' : 'UNAPPROVED')}]`)
        .join(', ');
      lines.push(`- Reviewers: ${rv}`);
    }
    if (d.openTasks != null || d.resolvedTasks != null) {
      lines.push(`- tasks: open=${d.openTasks ?? 0}, resolved=${d.resolvedTasks ?? 0}`);
    }
    if (d.url) lines.push(`- Link: ${d.url}`);
    lines.push(`- Comments: ${pr.comments?.length ?? 0}`);
    lines.push(`- Commits: ${pr.commits?.length ?? 0}`);
    if (pr.diffStat && pr.diffStat.length) lines.push(`- Diffstat: ${pr.diffStat.length} file(s)`);
    if (d.description && d.description.trim()) {
      lines.push('', '### PR description', '', d.description.trim());
    }
    if (pr.commits && pr.commits.length) {
      lines.push('', '### PR commits', '');
      for (const c of pr.commits) {
        lines.push(`- ${c.id.slice(0, 10)} ${oneLine(c.message)}`);
      }
    }
    if (pr.comments && pr.comments.length) {
      lines.push('', '### PR comments', '');
      for (const c of pr.comments) {
        lines.push(`- **${c.author}**: ${oneLine(c.text)}`);
      }
    }
  } else {
    lines.push('- prFound: false');
    lines.push('', 'PR not found or unavailable. Running branch-only review.');
  }
  lines.push('');

  /* ----------------------------- Git ----------------------------- */
  lines.push('## Git', '');
  lines.push(`- repo id: ${git.repoId}`);
  lines.push(`- repo path: ${git.repoPath}`);
  lines.push(`- branch: ${git.branch}`);
  lines.push(`- base branch: ${git.baseBranch}`);
  lines.push(`- ref: ${git.ref}`);
  lines.push(`- HEAD: ${git.head}`);
  lines.push('', '### Last commit', '', '```', git.lastCommit.trim(), '```', '');
  if (git.changedFiles.length) {
    lines.push('### Changed files', '', '```', git.changedFiles.join('\n'), '```', '');
  }
  if (git.diffStat.trim()) {
    lines.push('### Diff stat', '', '```', git.diffStat.trim(), '```', '');
  }
  if (git.status.trim()) {
    lines.push('### Worktree status', '', '```', git.status.trim(), '```', '');
  }

  /* ----------------------------- Diff ----------------------------- */
  lines.push('## Diff', '');
  if (git.diffError) {
    lines.push(`> ${git.diffError}`, '');
  }
  let diff = git.diff;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  lines.push('```patch', diff.trimEnd() || '(no diff)', '```');
  if (truncated) {
    lines.push('', `> NOTE: diff truncated to ${MAX_DIFF_CHARS} chars. Full diff in diff.patch.`);
  }
  lines.push('');

  /* -------------------------- Instructions -------------------------- */
  lines.push('## Instructions', '');
  lines.push(instructions.trim(), '');

  return lines.join('\n');
}

function oneLine(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
