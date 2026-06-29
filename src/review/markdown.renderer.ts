import { GitMetadata } from '../collectors/git.collector';
import { PullRequestDetails } from '../collectors/bitbucket.types';
import { ReviewResult } from './review.schema';
import { FollowupReviewResult } from './followup.schema';

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

/* ============================== follow-up ============================== */

export interface FollowupRenderContext {
  prFound: boolean;
  pr?: PullRequestDetails;
}

function followupHeadSection(result: FollowupReviewResult, ctx: FollowupRenderContext): string[] {
  const h = result.checkedHead;
  const prLine =
    ctx.prFound && ctx.pr
      ? `#${ctx.pr.id} ${ctx.pr.title} (${ctx.pr.state})${ctx.pr.url ? ` — ${ctx.pr.url}` : ''}`
      : h.prId != null
        ? `#${h.prId}`
        : 'not found';
  return [
    '## 1. Проверенный HEAD',
    '',
    `- Repo: ${h.repoId || '—'}`,
    `- PR: ${prLine}`,
    `- Branch: ${h.branch || '—'}`,
    `- Base branch: ${h.baseBranch || '—'}`,
    `- Previous HEAD: ${h.previousHead || '—'}`,
    `- Current HEAD: ${h.currentHead || '—'}`,
    '',
  ];
}

const ITEM_STATUS_LABEL: Record<string, string> = {
  fixed: 'fixed',
  not_fixed: 'not fixed',
  answered_accepted: 'answered (accepted)',
  answered_rejected: 'answered (rejected)',
  needs_clarification: 'needs clarification',
  not_applicable: 'n/a',
  unknown: 'unknown',
};

export function renderFollowupMarkdown(
  issueKey: string,
  result: FollowupReviewResult,
  ctx: FollowupRenderContext,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Follow-up Review`, '');

  lines.push(...followupHeadSection(result, ctx));

  lines.push('## 2. Итог', '', result.verdict, '');

  lines.push('## 3. Краткий вывод', '', result.summary.trim() || '—', '');

  lines.push('## 4. Проверка предыдущих замечаний', '');
  lines.push('### Fixed / Accepted', '');
  const accepted = result.resolvedItems;
  if (accepted.length === 0) {
    lines.push('—', '');
  } else {
    for (const it of accepted) {
      lines.push(`#### ${it.title} — ${ITEM_STATUS_LABEL[it.status] ?? it.status}`);
      if (it.developerResponse) lines.push(`- Ответ разработчика: ${it.developerResponse}`);
      if (it.currentEvidence) lines.push(`- Evidence: ${it.currentEvidence}`);
      if (it.conclusion) lines.push(`- Вывод: ${it.conclusion}`);
      lines.push('');
    }
  }
  lines.push('### Still open', '');
  if (result.stillOpenItems.length === 0) {
    lines.push('—', '');
  } else {
    for (const it of result.stillOpenItems) {
      lines.push(`#### ${it.title} — ${ITEM_STATUS_LABEL[it.status] ?? it.status}`);
      if (it.evidence) lines.push(`- Evidence: ${it.evidence}`);
      if (it.requiredAction) lines.push(`- Требуется: ${it.requiredAction}`);
      lines.push('');
    }
  }

  lines.push('## 5. Новые риски', '');
  if (result.newFindings.length === 0) {
    lines.push('—', '');
  } else {
    for (const f of result.newFindings) {
      lines.push(`- **[${f.level}] ${f.title}**${f.evidence ? ` — ${f.evidence}` : ''}`);
      if (f.whyItMatters) lines.push(`  - Почему важно: ${f.whyItMatters}`);
    }
    lines.push('');
  }

  lines.push('## 6. Вопросы разработчику', '');
  if (result.questionsForDeveloper.length === 0) {
    lines.push('—', '');
  } else {
    for (const q of result.questionsForDeveloper) lines.push(`- ${q}`);
    lines.push('');
  }

  lines.push('## 7. Комментарий в Bitbucket', '');
  lines.push('```md', result.bitbucketComment.trim() || '(пусто)', '```', '');

  return lines.join('\n');
}

/** Follow-up output when the model result could not be parsed as JSON. */
export function renderFollowupFallbackMarkdown(
  issueKey: string,
  rawText: string,
  head: { repoId: string; branch: string; previousHead?: string; currentHead: string },
  parseError: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Follow-up Review (RAW)`, '');
  lines.push(
    '> ⚠️ Claude вернул результат, который не удалось распарсить как валидный JSON FollowupReviewResult.',
    `> Причина: ${parseError}`,
    '> Ниже — сырой вывод модели. Полный машинный вывод в followup.raw.json.',
    '',
  );
  lines.push('## 1. Проверенный HEAD', '');
  lines.push(`- Repo: ${head.repoId}`);
  lines.push(`- Branch: ${head.branch}`);
  lines.push(`- Previous HEAD: ${head.previousHead ?? '—'}`);
  lines.push(`- Current HEAD: ${head.currentHead}`, '');
  lines.push('## Сырой вывод модели', '', '```', rawText.trim() || '(пусто)', '```', '');
  return lines.join('\n');
}

/** Follow-up STOP output (technical reason; model not run or not usable). */
export function renderFollowupStopMarkdown(
  issueKey: string,
  reason: string,
  head: { repoId: string; branch: string; previousHead?: string; currentHead: string },
  details?: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${issueKey} Follow-up Review`, '');
  lines.push('## 1. Проверенный HEAD', '');
  lines.push(`- Repo: ${head.repoId}`);
  lines.push(`- Branch: ${head.branch}`);
  lines.push(`- Previous HEAD: ${head.previousHead ?? '—'}`);
  lines.push(`- Current HEAD: ${head.currentHead}`, '');
  lines.push('## 2. Итог', '', 'STOP', '');
  lines.push('## 3. Краткий вывод', '', reason, '');
  if (details) lines.push('## Детали', '', '```', details.trim(), '```', '');
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
