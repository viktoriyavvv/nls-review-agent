import { GitMetadata } from '../collectors/git.collector';
import { PullRequestDetails } from '../collectors/bitbucket.types';
import { ReviewResult } from './review.schema';

export interface RenderContext {
  git: GitMetadata;
  prFound: boolean;
  pr?: PullRequestDetails;
}

function headSection(issueKey: string, ctx: RenderContext): string[] {
  const { git, pr, prFound } = ctx;
  const prLine = prFound && pr ? `#${pr.id} ${pr.title} (${pr.state})${pr.url ? ` — ${pr.url}` : ''}` : 'not found';
  return [
    '## 1. Проверенный HEAD',
    '',
    `- Repo: ${git.repoId}`,
    `- Branch: ${git.branch}`,
    `- HEAD: ${git.head}`,
    `- Last commit: ${oneLine(git.lastCommit)}`,
    `- Base branch: ${git.baseBranch}`,
    `- PR: ${prLine}`,
    '',
  ];
}

export function renderReviewMarkdown(
  issueKey: string,
  result: ReviewResult,
  ctx: RenderContext,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Review`, '');

  lines.push(...headSection(issueKey, ctx));

  lines.push('## 2. Вердикт', '', result.verdict, '');

  lines.push('## 3. Краткий вывод', '', result.summary.trim() || '—', '');

  lines.push('## 4. Блокеры', '');
  if (result.blockers.length === 0) {
    lines.push('—', '');
  } else {
    for (const b of result.blockers) {
      lines.push(`### ${b.title}`);
      if (b.file) lines.push(`- Файл: \`${b.file}\``);
      if (b.evidence) lines.push(`- Evidence: ${b.evidence}`);
      if (b.whyItMatters) lines.push(`- Почему важно: ${b.whyItMatters}`);
      lines.push('');
    }
  }

  lines.push('## 5. Риски', '');
  if (result.risks.length === 0) {
    lines.push('—', '');
  } else {
    for (const r of result.risks) {
      lines.push(`- **[${r.level}] ${r.title}**${r.evidence ? ` — ${r.evidence}` : ''}`);
    }
    lines.push('');
  }

  lines.push('## 6. Что уточнить у разработчика', '');
  if (result.questionsForDeveloper.length === 0) {
    lines.push('—', '');
  } else {
    for (const q of result.questionsForDeveloper) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  lines.push('## 7. Комментарий в Bitbucket', '');
  lines.push('```md', result.bitbucketComment.trim() || '(пусто)', '```', '');

  return lines.join('\n');
}

/** Used when the model output could not be parsed as valid ReviewResult JSON. */
export function renderFallbackMarkdown(
  issueKey: string,
  rawText: string,
  ctx: RenderContext,
  parseError: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Review (RAW)`, '');
  lines.push(
    '> ⚠️ Claude вернул результат, который не удалось распарсить как валидный JSON ReviewResult.',
    `> Причина: ${parseError}`,
    '> Ниже — сырой вывод модели. Полный машинный вывод в review.raw.json.',
    '',
  );
  lines.push(...headSection(issueKey, ctx));
  lines.push('## Сырой вывод модели', '', '```', rawText.trim() || '(пусто)', '```', '');
  return lines.join('\n');
}

/** Used for STOP situations detected before/without running the model. */
export function renderStopMarkdown(
  issueKey: string,
  reason: string,
  ctx: RenderContext,
  details?: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Review`, '');
  lines.push(...headSection(issueKey, ctx));
  lines.push('## 2. Вердикт', '', 'STOP', '');
  lines.push('## 3. Краткий вывод', '', reason, '');
  if (details) {
    lines.push('## Детали', '', '```', details.trim(), '```', '');
  }
  return lines.join('\n');
}

export function renderErrorMarkdown(issueKey: string, reason: string, details?: string): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} — ERROR`, '');
  lines.push('## Что произошло', '', reason, '');
  if (details) {
    lines.push('## Детали', '', '```', details.trim(), '```', '');
  }
  return lines.join('\n');
}

function oneLine(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}
