import { describe, it, expect, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { parseFollowupResult } from '../src/review/followup.schema';
import {
  parsePreviousReviewJson,
  extractPreviousReviewFromMarkdown,
  loadPreviousReview,
  resolvePreviousHead,
  formatPreviousReviewNotFound,
  PreviousReview,
} from '../src/review/previous-review';
import {
  FOLLOWUP_FILES,
  LATEST_FOLLOWUP_FILES,
  OUTPUT_FILES,
  followupRunDir,
  followupsDir,
  formatRunTimestamp,
  outputFile,
} from '../src/utils/paths';
import { buildFollowupContextMarkdown } from '../src/collectors/followup-context.builder';
import { renderFollowupMarkdown } from '../src/review/markdown.renderer';
import type { FollowupDelta } from '../src/collectors/git.collector';
import type { NormalizedJira } from '../src/collectors/jira.client';
import type { PullRequestComment } from '../src/collectors/bitbucket.types';
import type { GitMetadata } from '../src/collectors/git.collector';
import type { PrContext } from '../src/collectors/context.builder';

/* --------------------------- fixtures --------------------------- */

const PREV_JSON = {
  verdict: 'HOLD',
  summary: 'Source of status in the ЦОД card is wrong.',
  checkedHead: {
    repoId: 'frontend-support-center.netcore.kz',
    branch: 'SC-3563',
    head: 'edc4706774d055635ab3cdb6474dc31651bf0517',
    lastCommit: 'feat: fix prop',
  },
  blockers: [],
  risks: [
    {
      title: 'ЦОД card passes connection_status instead of status_internal',
      level: 'high',
      evidence: 'ConnectionTicketInfoCardComponent.vue:36',
    },
  ],
  questionsForDeveloper: ['Is connection_status populated for ЦОД tickets?'],
  bitbucketComment: '### Review SC-3563 — HOLD\nFix the status source.',
};

function jiraFixture(): NormalizedJira {
  return {
    key: 'SC-3563',
    summary: 'Fix status display',
    status: 'In Progress',
    issuetype: 'Bug',
    priority: 'High',
    assignee: 'Dev',
    reporter: 'TL',
    labels: [],
    components: [],
    fixVersions: [],
    descriptionText: 'Show real status, not a hardcoded label.',
    comments: [],
    links: [],
    attachments: [],
    customFields: [],
    url: 'https://nls-development.atlassian.net/browse/SC-3563',
  };
}

function gitFixture(): GitMetadata {
  return {
    repoId: 'frontend-support-center.netcore.kz',
    repoPath: '/repo',
    worktreePath: '/wt',
    branch: 'SC-3563',
    baseBranch: 'origin/staging',
    ref: 'origin/SC-3563',
    head: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    subject: 'fix: address review',
    lastCommit: 'commit aaaa1111 fix: address review',
    status: '',
    diffStat: ' 1 file changed',
    changedFiles: ['src/components/cards/connectionTickets/ConnectionTicketInfoCardComponent.vue'],
    diff: 'diff --git a/full b/full\n+full base..HEAD diff',
  };
}

function deltaFixture(): FollowupDelta {
  return {
    previousHead: 'edc4706774d055635ab3cdb6474dc31651bf0517',
    currentHead: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    isAncestor: true,
    hasPreviousHead: true,
    commitsOneline: 'aaaa111 fix: pass status_internal to modal',
    commitsFuller: 'commit aaaa1111\nAuthor: Dev\n\n    fix: pass status_internal to modal',
    changedFiles: ['src/components/cards/connectionTickets/ConnectionTicketInfoCardComponent.vue'],
    diff: 'diff --git a/card b/card\n-:status="ticket?.connection_status"\n+:status="ticket?.status_internal"',
  };
}

function commentsFixture(): PullRequestComment[] {
  return [
    { id: 1, author: 'TL', text: 'Please fix the status source in the ЦОД card.', createdAt: 'x' },
    { id: 2, parentId: 1, author: 'Dev', text: 'Done — now passes status_internal.', createdAt: 'y' },
    {
      id: 3,
      author: 'Dev',
      text: 'Inline note',
      inline: { path: 'Card.vue', to: 36 },
    },
  ];
}

function prContextFixture(): PrContext {
  return {
    found: true,
    provider: 'bitbucket-cloud',
    workspace: 'nls-kz',
    repoSlug: 'frontend-support-center.netcore.kz',
    details: {
      id: 1801,
      title: 'SC-3563',
      state: 'OPEN',
      fromRef: { branch: 'SC-3563', latestCommit: 'aaaa1111bbbb' },
      toRef: { branch: 'staging' },
      author: 'Dev',
      reviewers: [],
      raw: {},
    },
    comments: commentsFixture(),
    commits: [],
    diffStat: [],
  };
}

/* --------------------------- tests --------------------------- */

describe('previous review resolution', () => {
  it('returns null when no previous review exists and no --from-head (test 1)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-fu-none-'));
    const prev = await loadPreviousReview({
      outputsDir: dir,
      issueKey: 'SC-9999',
      repoId: 'some-repo',
    });
    expect(prev).toBeNull();
    expect(resolvePreviousHead(prev, undefined)).toBeUndefined();
  });

  it('produces a clear "previous review not found" error message (test 1)', () => {
    const msg = formatPreviousReviewNotFound('SC-3563', 'frontend-support-center.netcore.kz');
    expect(msg).toContain('Previous review not found');
    expect(msg).toContain('nls-review run SC-3563');
    expect(msg).toContain('--from-head');
  });

  it('lets --from-head work without a previous review (test 2)', () => {
    expect(resolvePreviousHead(null, 'deadbeef123')).toBe('deadbeef123');
  });

  it('--from-head takes priority over the previous review head (test 7)', () => {
    const prev = parsePreviousReviewJson(PREV_JSON, 'review.json');
    expect(resolvePreviousHead(prev, 'override999')).toBe('override999');
  });

  it('parses previous review from review.json (test 5)', () => {
    const prev = parsePreviousReviewJson(PREV_JSON, 'review.json');
    expect(prev.verdict).toBe('HOLD');
    expect(prev.head).toBe('edc4706774d055635ab3cdb6474dc31651bf0517');
    expect(prev.branch).toBe('SC-3563');
    expect(prev.repoId).toBe('frontend-support-center.netcore.kz');
    expect(prev.risks).toHaveLength(1);
    expect(prev.questionsForDeveloper).toHaveLength(1);
    expect(prev.bitbucketComment).toContain('HOLD');
  });

  it('takes the previous HEAD from review.json when --from-head is absent (test 6)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-fu-json-'));
    const file = outputFile(dir, 'SC-3563', 'frontend-support-center.netcore.kz', OUTPUT_FILES.reviewJson);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(PREV_JSON), 'utf8');

    const prev = await loadPreviousReview({
      outputsDir: dir,
      issueKey: 'SC-3563',
      repoId: 'frontend-support-center.netcore.kz',
    });
    expect(prev).not.toBeNull();
    expect(resolvePreviousHead(prev, undefined)).toBe('edc4706774d055635ab3cdb6474dc31651bf0517');
  });

  it('falls back to review.md best-effort when review.json is missing', () => {
    const md = [
      '# SC-3563 Review',
      '## 1. Проверенный HEAD',
      '- Repo: frontend-support-center.netcore.kz',
      '- Branch: SC-3563',
      '- HEAD: edc4706774d055635ab3cdb6474dc31651bf0517',
      '## 2. Вердикт',
      '',
      'HOLD',
      '',
    ].join('\n');
    const prev = extractPreviousReviewFromMarkdown(md, 'review.md');
    expect(prev.head).toBe('edc4706774d055635ab3cdb6474dc31651bf0517');
    expect(prev.verdict).toBe('HOLD');
  });
});

describe('followup output paths', () => {
  it('writes followup outputs under followups/<timestamp>/ (test 3)', () => {
    const ts = formatRunTimestamp(new Date('2026-06-29T16:30:00.000Z'));
    expect(ts).toBe('2026-06-29_16-30-00');
    const dir = followupRunDir('/out', 'SC-3563', 'repo', ts);
    expect(dir.replace(/\\/g, '/')).toContain('/out/SC-3563/repo/followups/2026-06-29_16-30-00');
    const ctx = path.join(dir, FOLLOWUP_FILES.context);
    expect(ctx.replace(/\\/g, '/')).toContain('followups/2026-06-29_16-30-00/followup-context.md');
  });

  it('does not collide with the primary review.md path (test 4)', () => {
    const review = outputFile('/out', 'SC-3563', 'repo', OUTPUT_FILES.reviewMd);
    const fuDir = followupsDir('/out', 'SC-3563', 'repo');
    const fuMd = path.join(followupRunDir('/out', 'SC-3563', 'repo', 'ts'), FOLLOWUP_FILES.md);
    expect(review).not.toBe(fuMd);
    expect(review.replace(/\\/g, '/')).toMatch(/\/SC-3563\/repo\/review\.md$/);
    expect(fuDir.replace(/\\/g, '/')).toMatch(/\/SC-3563\/repo\/followups$/);
    expect(LATEST_FOLLOWUP_FILES.md).toBe('latest-followup.md');
  });
});

describe('buildFollowupContextMarkdown', () => {
  const ctx = buildFollowupContextMarkdown({
    issueKey: 'SC-3563',
    jira: jiraFixture(),
    pr: prContextFixture(),
    previous: parsePreviousReviewJson(PREV_JSON, 'review.json'),
    comments: commentsFixture(),
    delta: deltaFixture(),
    git: gitFixture(),
    instructions: 'FOLLOWUP INSTRUCTIONS HERE',
  });

  it('includes the previous review (test 8)', () => {
    expect(ctx).toContain('Previous review');
    expect(ctx).toContain('HOLD');
    expect(ctx).toContain('connection_status instead of status_internal');
  });

  it('includes PR comments / replies (test 9)', () => {
    expect(ctx.toLowerCase()).toContain('comment');
    expect(ctx).toContain('Please fix the status source');
    expect(ctx).toContain('Done — now passes status_internal');
  });

  it('includes the diff previousHead..HEAD (test 10)', () => {
    expect(ctx).toContain('edc4706774d055635ab3cdb6474dc31651bf0517');
    expect(ctx).toContain('+:status="ticket?.status_internal"');
    expect(ctx).toContain('FOLLOWUP INSTRUCTIONS HERE');
  });
});

describe('FollowupReviewResult schema', () => {
  it('validates a correct followup response (test 11)', () => {
    const json = JSON.stringify({
      verdict: 'APPROVE',
      summary: 'Blocker fixed.',
      previousReview: { verdict: 'HOLD', head: 'edc470677' },
      checkedHead: {
        repoId: 'repo',
        branch: 'SC-3563',
        baseBranch: 'origin/staging',
        previousHead: 'edc470677',
        currentHead: 'aaaa1111',
        prId: 1801,
      },
      resolvedItems: [
        {
          title: 'ЦОД status source',
          status: 'fixed',
          developerResponse: 'passes status_internal now',
          currentEvidence: 'Card.vue:36 now :status="ticket?.status_internal"',
          conclusion: 'Confirmed fixed in code.',
        },
      ],
      stillOpenItems: [],
      newFindings: [],
      questionsForDeveloper: [],
      bitbucketComment: 'APPROVE — blocker fixed.',
    });
    const out = parseFollowupResult(json);
    expect(out.ok).toBe(true);
    expect(out.result?.verdict).toBe('APPROVE');
    expect(out.result?.resolvedItems[0].status).toBe('fixed');
    expect(out.result?.checkedHead.currentHead).toBe('aaaa1111');
  });

  it('applies defaults for missing arrays', () => {
    const out = parseFollowupResult('{"verdict":"HOLD","summary":"still open"}');
    expect(out.ok).toBe(true);
    expect(out.result?.resolvedItems).toEqual([]);
    expect(out.result?.stillOpenItems).toEqual([]);
    expect(out.result?.newFindings).toEqual([]);
  });

  it('fails on an invalid verdict', () => {
    const out = parseFollowupResult('{"verdict":"MAYBE"}');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });
});

describe('renderFollowupMarkdown', () => {
  const result = parseFollowupResult(
    JSON.stringify({
      verdict: 'HOLD',
      summary: 'One item still open.',
      checkedHead: {
        repoId: 'repo',
        branch: 'SC-3563',
        baseBranch: 'origin/staging',
        previousHead: 'edc470677',
        currentHead: 'aaaa1111',
        prId: 1801,
      },
      resolvedItems: [
        { title: 'Status source', status: 'fixed', currentEvidence: 'Card.vue fixed', conclusion: 'ok' },
      ],
      stillOpenItems: [
        { title: 'Edge case', status: 'not_fixed', evidence: 'still hardcoded', requiredAction: 'replace literal' },
      ],
      newFindings: [
        { title: 'New regression', level: 'medium', evidence: 'diff line 10', whyItMatters: 'breaks list' },
      ],
      questionsForDeveloper: ['Confirm target branch'],
      bitbucketComment: '### Follow-up — HOLD',
    }).valueOf(),
  ).result!;

  const md = renderFollowupMarkdown('SC-3563', result, { prFound: true });

  it('creates the required sections (test 12)', () => {
    expect(md).toContain('# SC-3563 Follow-up Review');
    expect(md).toContain('Проверенный HEAD');
    expect(md).toContain('Итог');
    expect(md).toContain('Проверка предыдущих замечаний');
    expect(md).toContain('Новые риски');
    expect(md).toContain('Комментарий в Bitbucket');
  });

  it('renders verdict, resolved and still-open items', () => {
    expect(md).toContain('HOLD');
    expect(md).toContain('Status source');
    expect(md).toContain('Edge case');
    expect(md).toContain('New regression');
    expect(md).toContain('edc470677');
    expect(md).toContain('aaaa1111');
  });
});

afterAll(() => {
  // temp dirs created via mkdtempSync live under the OS temp root; leave cleanup
  // to the OS. (Explicitly removing them here is optional and avoided to keep the
  // test resilient on Windows where rmSync on just-written files can race.)
});
