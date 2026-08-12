import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AppConfig, ResolvedRepo } from '../src/config/types';
import { parseFrontmatter, serializeFrontmatter, extractTitle } from '../src/memory/frontmatter';
import {
  filterMemoryItems,
  initMemory,
  memoryRoot,
  reindexMemory,
  scanMemory,
  searchMemoryItems,
  slugifyId,
  uniqueMemoryId,
} from '../src/memory/store';
import {
  buildMemoryContext,
  renderMemoryContext,
  selectMemoryItems,
  EMPTY_MEMORY_CONTEXT,
} from '../src/memory/retrieval';
import { parseMemoryProposalResult } from '../src/memory/proposal.schema';
import {
  approveProposal,
  deprecateMemoryItem,
  rejectProposal,
  saveProposalsToPending,
} from '../src/memory/proposals';
import { MemoryError } from '../src/memory/types';

/* ------------------------------- fixtures -------------------------------- */

const REPO = 'frontend-support-center.netcore.kz';

function repo(id: string, prefixes: string[], root: string): ResolvedRepo {
  return {
    id,
    jiraPrefixes: prefixes,
    path: `./repos/${id}`,
    absPath: path.resolve(root, `./repos/${id}`),
    defaultBaseBranch: 'origin/master',
    bitbucket: { repoSlug: id, workspace: 'nls-kz' },
  };
}

function makeConfig(root: string): AppConfig {
  return {
    projectRoot: root,
    root: {
      reposDir: path.join(root, 'repos'),
      worktreesDir: path.join(root, 'worktrees'),
      outputsDir: path.join(root, 'outputs'),
      locksDir: path.join(root, 'locks'),
      memoryDir: path.join(root, 'memory'),
    },
    jira: {
      baseUrl: 'https://nls.atlassian.net',
      email: 'tl@nls.kz',
      apiToken: 'SECRET-jira-token-value',
      apiVersion: '3',
    },
    bitbucket: {
      type: 'cloud',
      baseUrl: '',
      username: 'zahar4747',
      token: 'SECRET-bitbucket-token-value',
      workspace: 'nls-kz',
    },
    claude: {
      bin: 'claude',
      model: 'opus',
      effort: 'max',
      permissionMode: 'dangerously-skip-permissions',
      outputFormat: 'json',
      maxTurns: undefined,
    },
    repos: {
      [REPO]: repo(REPO, ['SC'], root),
      'meganet.kz-2023-front': repo('meganet.kz-2023-front', ['WEBSITE'], root),
    },
    profiles: { default: 'default', profiles: {} },
    jiraFields: { standardFields: [], customFields: [] },
  };
}

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-mem-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** Write a memory markdown file with frontmatter. */
function writeMem(
  root: string,
  rel: string,
  fm: Record<string, unknown>,
  body: string,
): string {
  const abs = path.join(root, 'memory', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeFrontmatter(fm, body), 'utf8');
  return abs;
}

function lessonFm(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'lesson',
    status: 'approved',
    confidence: 'high',
    appliesTo: { projects: ['SC'], repos: [REPO], issueKeys: ['SC-3563'], tags: ['status_internal', 'issue'] },
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:00:00.000Z',
    ...over,
  };
}

/* ------------------------------ frontmatter ------------------------------ */

describe('frontmatter (#2)', () => {
  it('parses YAML frontmatter + body and round-trips', () => {
    const md = serializeFrontmatter({ id: 'x', type: 'lesson', appliesTo: { tags: ['a'] } }, '# T\n\nbody');
    const parsed = parseFrontmatter(md);
    expect(parsed.data?.id).toBe('x');
    expect((parsed.data?.appliesTo as { tags: string[] }).tags).toEqual(['a']);
    expect(parsed.body).toContain('# T');
    expect(extractTitle(parsed.body)).toBe('T');
  });

  it('returns data null for a plain markdown file', () => {
    const parsed = parseFrontmatter('# Just a doc\n\ntext');
    expect(parsed.data).toBeNull();
    expect(parsed.body).toContain('Just a doc');
  });

  it('tolerates a UTF-8 BOM before the frontmatter (Windows editors)', () => {
    const parsed = parseFrontmatter('﻿---\nid: bom-file\ntype: lesson\n---\n\n# T');
    expect(parsed.data?.id).toBe('bom-file');
  });
});

/* ------------------------------ init (#1) -------------------------------- */

describe('memory init (#1)', () => {
  it('creates the structure, the seed principles and index.json', async () => {
    const cfg = makeConfig(tmpRoot());
    const res = await initMemory(cfg);
    const root = memoryRoot(cfg);
    for (const d of ['global', 'projects', 'repos', 'decisions', 'lessons', 'proposals/pending', 'proposals/approved', 'proposals/rejected']) {
      expect(fs.existsSync(path.join(root, d))).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'global', 'review-principles.md'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'index.json'))).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
    expect(index.items.some((i: { id: string }) => i.id === 'global-review-principles')).toBe(true);
    expect(res.createdFiles).toContain('global/review-principles.md');

    // Idempotent: a second init skips everything.
    const again = await initMemory(cfg);
    expect(again.createdDirs).toHaveLength(0);
    expect(again.createdFiles).toHaveLength(0);
  });
});

/* ----------------------------- reindex (#3) ------------------------------ */

describe('memory reindex + list filters (#3, #4)', () => {
  it('builds index.json from files and filters by project/repo/type/status', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    writeMem(root, 'lessons/l1.md', lessonFm('l1'), '# Lesson one');
    writeMem(root, 'projects/SC.md', {
      id: 'sc-rules', type: 'project_rule', status: 'approved', confidence: 'medium',
      appliesTo: { projects: ['SC'], repos: [], tags: [] },
    }, '# SC rules');
    writeMem(root, 'proposals/pending/p1.md', lessonFm('p1', { status: 'proposed' }), '# Pending');

    const index = await reindexMemory(cfg);
    expect(index.items).toHaveLength(3);
    const file = JSON.parse(fs.readFileSync(path.join(memoryRoot(cfg), 'index.json'), 'utf8'));
    expect(file.items.map((i: { id: string }) => i.id).sort()).toEqual(['l1', 'p1', 'sc-rules']);

    const { items } = await scanMemory(cfg);
    expect(filterMemoryItems(items, { type: 'lesson' }).map((i) => i.id).sort()).toEqual(['l1', 'p1']);
    expect(filterMemoryItems(items, { status: 'approved' })).toHaveLength(2);
    expect(filterMemoryItems(items, { project: 'sc' })).toHaveLength(3);
    expect(filterMemoryItems(items, { repo: REPO }).map((i) => i.id).sort()).toEqual(['l1', 'p1']);
  });

  it('search matches id/title/tags/body', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    writeMem(root, 'lessons/l1.md', lessonFm('status-internal-lesson'), '# Regression lesson\n\nbutton visibility broke');
    const { items } = await scanMemory(cfg);
    expect(searchMemoryItems(items, 'status_internal')).toHaveLength(1); // tag
    expect(searchMemoryItems(items, 'button visibility')).toHaveLength(1); // body
    expect(searchMemoryItems(items, 'regression lesson')).toHaveLength(1); // title
    expect(searchMemoryItems(items, 'nope-nothing')).toHaveLength(0);
  });

  it('slug/id helpers', () => {
    expect(slugifyId('SC-3563 Status internal!')).toBe('sc-3563-status-internal');
    expect(uniqueMemoryId('x', ['x', 'x-2'])).toBe('x-3');
  });
});

/* ----------------------------- retrieval (#5-#7) ------------------------- */

describe('memory retrieval (#5, #6, #7)', () => {
  function scanned(root: string) {
    return scanMemory(makeConfig(root)).then((r) => r.items);
  }

  it('returns global + project + repo + tag-matched lessons (#5)', async () => {
    const root = tmpRoot();
    writeMem(root, 'global/g.md', {
      id: 'g', type: 'global_rule', status: 'approved', confidence: 'high', appliesTo: { tags: [] },
    }, '# Global principles');
    writeMem(root, 'projects/SC.md', {
      id: 'sc', type: 'project_rule', status: 'approved', confidence: 'medium',
      appliesTo: { projects: ['SC'] },
    }, '# SC memory');
    writeMem(root, 'repos/r.md', {
      id: 'r', type: 'repo_rule', status: 'approved', confidence: 'medium',
      appliesTo: { repos: [REPO] },
    }, '# Repo memory');
    writeMem(root, 'lessons/tagged.md', {
      id: 'tagged', type: 'lesson', status: 'approved', confidence: 'high',
      appliesTo: { projects: ['OTHER'], tags: ['status_internal'] },
    }, '# Tag lesson');
    writeMem(root, 'lessons/unrelated.md', {
      id: 'unrelated', type: 'lesson', status: 'approved', confidence: 'high',
      appliesTo: { projects: ['OTHER'], tags: ['some_other_module'] },
    }, '# Unrelated');

    const sel = selectMemoryItems(await scanned(root), {
      issueKey: 'SC-3700',
      projectKey: 'SC',
      repoId: REPO,
      diffText: 'if (card.status_internal.key === "issue") {',
      changedFiles: ['src/components/Card.vue'],
    });
    const ids = sel.map((s) => s.item.id);
    expect(ids).toContain('g');
    expect(ids).toContain('sc');
    expect(ids).toContain('r');
    expect(ids).toContain('tagged');
    expect(ids).not.toContain('unrelated');
    const tagged = sel.find((s) => s.item.id === 'tagged')!;
    expect(tagged.matchedTags).toEqual(['status_internal']);
    expect(tagged.reason).toMatch(/diff keywords: status_internal/);
  });

  it('never returns pending / rejected / deprecated / draft (#6)', async () => {
    const root = tmpRoot();
    for (const [id, status] of [
      ['a-proposed', 'proposed'],
      ['a-rejected', 'rejected'],
      ['a-deprecated', 'deprecated'],
      ['a-draft', 'draft'],
      ['a-approved', 'approved'],
    ] as const) {
      writeMem(root, `lessons/${id}.md`, lessonFm(id, { status }), `# ${id}`);
    }
    const sel = selectMemoryItems(await scanned(root), {
      issueKey: 'SC-1', projectKey: 'SC', repoId: REPO,
    });
    expect(sel.map((s) => s.item.id)).toEqual(['a-approved']);
  });

  it('ranks repo > project > tags and caps the item count (#7)', async () => {
    const root = tmpRoot();
    writeMem(root, 'lessons/only-tag.md', {
      id: 'only-tag', type: 'lesson', status: 'approved', confidence: 'high',
      appliesTo: { tags: ['watchers'] },
    }, '# t');
    writeMem(root, 'lessons/proj.md', {
      id: 'proj', type: 'lesson', status: 'approved', confidence: 'low',
      appliesTo: { projects: ['SC'] },
    }, '# p');
    writeMem(root, 'lessons/repo.md', {
      id: 'repo', type: 'lesson', status: 'approved', confidence: 'low',
      appliesTo: { repos: [REPO] },
    }, '# r');

    const all = selectMemoryItems(await scanned(root), {
      issueKey: 'SC-1', projectKey: 'SC', repoId: REPO, diffText: 'watchers: { deep: true }',
    });
    expect(all.map((s) => s.item.id)).toEqual(['repo', 'proj', 'only-tag']);

    const capped = selectMemoryItems(await scanned(root), {
      issueKey: 'SC-1', projectKey: 'SC', repoId: REPO, diffText: 'watchers',
    }, { maxItems: 2 });
    expect(capped).toHaveLength(2);
  });

  it('caps the rendered context size (#7)', async () => {
    const root = tmpRoot();
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 6; i += 1) {
      writeMem(root, `lessons/big-${i}.md`, lessonFm(`big-${i}`), `# Big ${i}\n\n${big}`);
    }
    const cfg = makeConfig(root);
    const res = await buildMemoryContext(cfg, {
      issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO,
    }, { maxChars: 8000 });
    expect(res.markdown.length).toBeLessThanOrEqual(9000); // header + capped bodies
    expect(res.used.length).toBeGreaterThanOrEqual(1);
    expect(res.used.length + res.dropped.length).toBe(6);
  });

  it('renders section headers and the empty fallback (#8 shape)', async () => {
    const root = tmpRoot();
    writeMem(root, 'global/g.md', {
      id: 'g', type: 'global_rule', status: 'approved', confidence: 'high', appliesTo: {},
    }, '# Global principles\n\n- rule');
    writeMem(root, 'lessons/l.md', lessonFm('l'), '# Lesson body');
    const cfg = makeConfig(root);
    const res = await buildMemoryContext(cfg, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    expect(res.markdown).toContain('## Memory Context');
    expect(res.markdown).toContain('### Global review principles');
    expect(res.markdown).toContain('### Related lessons');
    expect(res.markdown).toContain('_(id: l, type: lesson, confidence: high)_');

    const empty = await buildMemoryContext(makeConfig(tmpRoot()), {
      issueKey: 'SC-1', projectKey: 'SC', repoId: REPO,
    });
    expect(empty.markdown).toBe(EMPTY_MEMORY_CONTEXT);
    expect(empty.used).toEqual([]);
  });

  it('renderMemoryContext used[] carries id/path/reason (memory-used shape #10)', async () => {
    const root = tmpRoot();
    writeMem(root, 'lessons/l.md', lessonFm('l'), '# L');
    const items = (await scanMemory(makeConfig(root))).items;
    const sel = selectMemoryItems(items, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    const rendered = renderMemoryContext(sel, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    expect(rendered.used[0]).toMatchObject({
      id: 'l',
      type: 'lesson',
      confidence: 'high',
      path: 'memory/lessons/l.md',
    });
    expect(rendered.used[0].reason).toMatch(/matched repo/);
  });
});

/* ------------------------- proposals (#11-#13) --------------------------- */

const PROPOSAL = {
  id: 'SC-3563 Status internal regression',
  type: 'lesson' as const,
  title: 'Lesson: status_internal regression',
  confidence: 'high' as const,
  appliesTo: { projects: ['sc'], repos: [REPO], issueKeys: ['sc-3563'], tags: ['status_internal'] },
  summary: 'Enum replaced without checking downstream conditions.',
  evidence: ['followup verdict HOLD', 'regression in delta'],
  markdown: '# Lesson: status_internal regression\n\n## What happened\n\n...',
};

describe('memory proposals (#11, #12, #13)', () => {
  it('parses a MemoryProposalResult (schema #9) incl. fenced JSON', () => {
    const ok = parseMemoryProposalResult(JSON.stringify({ proposals: [PROPOSAL] }));
    expect(ok.ok).toBe(true);
    expect(ok.result?.proposals[0].type).toBe('lesson');

    const fenced = parseMemoryProposalResult('```json\n{"proposals": []}\n```');
    expect(fenced.ok).toBe(true);
    expect(fenced.result?.proposals).toEqual([]);

    const bad = parseMemoryProposalResult('{"proposals": [{"id": ""}]}');
    expect(bad.ok).toBe(false);
  });

  it('saves proposals into pending as status=proposed (#11)', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const saved = await saveProposalsToPending(cfg, [PROPOSAL], {
      source: { issueKey: 'SC-3563', repoId: REPO },
      nowIso: '2026-07-01T12:00:00.000Z',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('sc-3563-status-internal-regression');
    expect(saved[0].path).toBe('memory/proposals/pending/sc-3563-status-internal-regression.md');

    const { items } = await scanMemory(cfg);
    const p = items.find((i) => i.id === saved[0].id)!;
    expect(p.status).toBe('proposed');
    expect(p.projects).toEqual(['SC']); // uppercased
    expect(p.issueKeys).toEqual(['SC-3563']);
    expect(p.source?.issueKey).toBe('SC-3563');

    // Proposed items are NOT retrievable.
    const sel = selectMemoryItems(items, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    expect(sel.map((s) => s.item.id)).not.toContain(saved[0].id);
  });

  it('approve moves a lesson-like proposal into lessons/ and reindexes (#12)', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const [saved] = await saveProposalsToPending(cfg, [PROPOSAL], {});
    const res = await approveProposal(cfg, saved.id, { nowIso: '2026-07-02T09:00:00.000Z' });
    expect(res.path).toBe(`memory/lessons/${saved.id}.md`);
    expect(fs.existsSync(path.join(memoryRoot(cfg), 'proposals', 'pending', `${saved.id}.md`))).toBe(false);

    const { items } = await scanMemory(cfg);
    const item = items.find((i) => i.id === saved.id)!;
    expect(item.status).toBe('approved');
    expect(item.updatedAt).toBe('2026-07-02T09:00:00.000Z');

    // Now retrieval picks it up.
    const sel = selectMemoryItems(items, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    expect(sel.map((s) => s.item.id)).toContain(saved.id);

    // Index was rebuilt.
    const index = JSON.parse(fs.readFileSync(path.join(memoryRoot(cfg), 'index.json'), 'utf8'));
    expect(index.items.find((i: { id: string }) => i.id === saved.id).status).toBe('approved');
  });

  it('approve keeps a non-lesson proposal in proposals/approved/', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const [saved] = await saveProposalsToPending(
      cfg,
      [{ ...PROPOSAL, id: 'proj rule', type: 'project_rule', title: 'Project rule' }],
      {},
    );
    const res = await approveProposal(cfg, saved.id);
    expect(res.path).toBe(`memory/proposals/approved/${saved.id}.md`);
  });

  it('reject moves the proposal to rejected/ (#13)', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const [saved] = await saveProposalsToPending(cfg, [PROPOSAL], {});
    const res = await rejectProposal(cfg, saved.id);
    expect(res.path).toBe(`memory/proposals/rejected/${saved.id}.md`);
    const { items } = await scanMemory(cfg);
    expect(items.find((i) => i.id === saved.id)!.status).toBe('rejected');
    // Rejected proposals cannot be approved afterwards.
    await expect(approveProposal(cfg, saved.id)).rejects.toBeInstanceOf(MemoryError);
  });

  it('deprecate flips an approved item in place', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    await initMemory(cfg);
    writeMem(root, 'lessons/old.md', lessonFm('old'), '# Old lesson');
    await deprecateMemoryItem(cfg, 'old');
    const { items } = await scanMemory(cfg);
    expect(items.find((i) => i.id === 'old')!.status).toBe('deprecated');
    // And it no longer participates in retrieval.
    const sel = selectMemoryItems(items, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    expect(sel.map((s) => s.item.id)).not.toContain('old');
  });

  it('approve/reject of an unknown id → MemoryError 404', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    await expect(approveProposal(cfg, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(rejectProposal(cfg, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('duplicate proposal ids are disambiguated', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const a = await saveProposalsToPending(cfg, [PROPOSAL], {});
    const b = await saveProposalsToPending(cfg, [PROPOSAL], {});
    expect(a[0].id).toBe('sc-3563-status-internal-regression');
    expect(b[0].id).toBe('sc-3563-status-internal-regression-2');
  });
});

/* --------------------- context builders include memory (#8, #9) ---------- */

describe('review/followup context contains Memory Context (#8, #9)', () => {
  const GIT = {
    repoId: REPO,
    repoPath: '/r',
    worktreePath: '/w',
    branch: 'SC-1',
    baseBranch: 'origin/master',
    ref: 'origin/SC-1',
    head: 'abc',
    lastCommit: 'abc subject',
    subject: 'subject',
    changedFiles: ['a.ts'],
    diffStat: '1 file changed',
    status: '',
    diff: 'diff --git a/a.ts b/a.ts',
  };

  it('buildContextMarkdown embeds the block before Instructions (#8)', async () => {
    const { buildContextMarkdown } = await import('../src/collectors/context.builder');
    const md = buildContextMarkdown({
      issueKey: 'SC-1',
      jira: {
        key: 'SC-1', summary: 's', status: 'CR', labels: [], components: [], fixVersions: [],
        descriptionText: '', comments: [], links: [], attachments: [], customFields: [],
      },
      pr: { found: false },
      git: GIT as never,
      instructions: 'INSTR',
      memoryContext: '## Memory Context\n\n### Related lessons\n\nLESSON-BODY',
    });
    expect(md).toContain('## Memory Context');
    expect(md.indexOf('## Memory Context')).toBeLessThan(md.indexOf('## Instructions'));
    expect(md).toContain('LESSON-BODY');
    // Without memory the block is absent.
    const bare = buildContextMarkdown({
      issueKey: 'SC-1',
      jira: {
        key: 'SC-1', summary: 's', status: 'CR', labels: [], components: [], fixVersions: [],
        descriptionText: '', comments: [], links: [], attachments: [], customFields: [],
      },
      pr: { found: false },
      git: GIT as never,
      instructions: 'INSTR',
    });
    expect(bare).not.toContain('## Memory Context');
  });

  it('buildFollowupContextMarkdown embeds the block too (#9)', async () => {
    const { buildFollowupContextMarkdown } = await import('../src/collectors/followup-context.builder');
    const md = buildFollowupContextMarkdown({
      issueKey: 'SC-1',
      jira: {
        key: 'SC-1', summary: 's', status: 'CR', labels: [], components: [], fixVersions: [],
        descriptionText: '', comments: [], links: [], attachments: [], customFields: [],
      },
      pr: { found: false },
      previous: {
        source: 'outputs/x', format: 'json', blockers: [], risks: [], questionsForDeveloper: [], raw: null,
      },
      comments: [],
      delta: {
        hasPreviousHead: true, isAncestor: true, previousHead: 'a', currentHead: 'b',
        commitsOneline: '', commitsFuller: '', changedFiles: [], diff: '',
      } as never,
      git: GIT as never,
      instructions: 'INSTR',
      memoryContext: '## Memory Context\n\nMEM-FU',
    });
    expect(md).toContain('## Memory Context');
    expect(md).toContain('MEM-FU');
    expect(md.indexOf('## Memory Context')).toBeLessThan(md.indexOf('## Instructions'));
  });
});

/* ------------------------ API service layer (#15-#17) -------------------- */

describe('memory API service (#15, #16, #17)', () => {
  it('listMemory returns approved + pending + rejected and no tokens', async () => {
    const cfg = makeConfig(tmpRoot());
    await initMemory(cfg);
    const [pending] = await saveProposalsToPending(cfg, [PROPOSAL], {});
    const [toReject] = await saveProposalsToPending(cfg, [{ ...PROPOSAL, id: 'second one' }], {});
    await rejectProposal(cfg, toReject.id);

    const { listMemory, getMemoryItem, memoryActions } = await import('../src/server/services/memory');
    const all = await listMemory(cfg);
    const statuses = new Set(all.items.map((i) => i.status));
    expect(statuses.has('approved')).toBe(true); // seed principles
    expect(statuses.has('proposed')).toBe(true);
    expect(statuses.has('rejected')).toBe(true);
    const blob = JSON.stringify(all);
    expect(blob).not.toContain('SECRET-jira-token-value');
    expect(blob).not.toContain('SECRET-bitbucket-token-value');

    // Detail viewer returns the markdown.
    const detail = await getMemoryItem(cfg, pending.id);
    expect(detail.markdown).toContain('status: proposed');

    // approve via the API surface changes the status (#16).
    await memoryActions.approve(cfg, pending.id);
    const after = await listMemory(cfg, { status: 'approved' });
    expect(after.items.map((i) => i.id)).toContain(pending.id);
  });
});

/* ----------------------- job runner args (propose/learn) ----------------- */

describe('job runner: memory job argv', () => {
  it('builds CLI args for memory-propose and learn-bugfix and shares the task lock', async () => {
    const { JobStore } = await import('../src/server/job-store');
    const { JobRunner, JobConflictError } = await import('../src/server/job-runner');
    const { EventEmitter } = await import('node:events');

    const spawn = (() => {
      const child = new EventEmitter() as never as import('../src/server/job-runner').ChildLike &
        InstanceType<typeof EventEmitter>;
      (child as { stdout: unknown }).stdout = new EventEmitter();
      (child as { stderr: unknown }).stderr = new EventEmitter();
      (child as { kill: () => boolean }).kill = () => true;
      return () => child;
    })();

    const store = new JobStore();
    const runner = new JobRunner(store, { projectRoot: tmpRoot(), spawnFn: spawn as never });
    const job = runner.start({ type: 'memory-propose', issueKey: 'SC-3563', repoId: REPO });
    expect(job.argv).toEqual(['memory', 'propose', 'SC-3563', '--repo', REPO]);
    // Shares the task lock with reviews: a follow-up for the same pair conflicts.
    expect(() => runner.start({ type: 'run-followup', issueKey: 'SC-3563', repoId: REPO })).toThrow(
      JobConflictError,
    );
    const learn = runner.start({ type: 'learn-bugfix', issueKey: 'SC-3706', repoId: REPO });
    expect(learn.argv).toEqual(['learn', 'bugfix', 'SC-3706', '--repo', REPO]);
  });
});

/* --------------------------- secret safety (#17) ------------------------- */

describe('memory payloads carry no tokens (#17)', () => {
  it('scan/index/context JSON never contains configured secrets', async () => {
    const root = tmpRoot();
    const cfg = makeConfig(root);
    await initMemory(cfg);
    writeMem(root, 'lessons/l.md', lessonFm('l'), '# L');
    const { items } = await scanMemory(cfg);
    const ctx = await buildMemoryContext(cfg, { issueKey: 'SC-3563', projectKey: 'SC', repoId: REPO });
    const blob = JSON.stringify({ items, ctx });
    expect(blob).not.toContain('SECRET-jira-token-value');
    expect(blob).not.toContain('SECRET-bitbucket-token-value');
  });
});
