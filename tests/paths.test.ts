import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  outputDir,
  outputFile,
  repoLockPath,
  taskLockPath,
  worktreePath,
} from '../src/utils/paths';

const norm = (p: string) => p.split(path.sep).join('/');

describe('path helpers', () => {
  it('worktree path = worktrees/<repoId>/<issueKey>', () => {
    expect(norm(worktreePath('worktrees', 'website-admin', 'WEBSITE-123'))).toBe(
      'worktrees/website-admin/WEBSITE-123',
    );
  });

  it('output path = outputs/<issueKey>/<repoId>', () => {
    expect(norm(outputDir('outputs', 'SC-3749', 'support-center-frontend'))).toBe(
      'outputs/SC-3749/support-center-frontend',
    );
    expect(norm(outputFile('outputs', 'SC-3749', 'support-center-frontend', 'review.md'))).toBe(
      'outputs/SC-3749/support-center-frontend/review.md',
    );
  });

  it('task lock = locks/tasks/<issueKey>__<repoId>.lock', () => {
    expect(norm(taskLockPath('locks', 'WEBSITE-123', 'website-admin'))).toBe(
      'locks/tasks/WEBSITE-123__website-admin.lock',
    );
  });

  it('repo lock = locks/repos/<repoId>.lock', () => {
    expect(norm(repoLockPath('locks', 'support-center-frontend'))).toBe(
      'locks/repos/support-center-frontend.lock',
    );
  });

  it('same issue key in different repos -> different worktree and lock paths', () => {
    const a = norm(worktreePath('worktrees', 'website-frontend', 'WEBSITE-123'));
    const b = norm(worktreePath('worktrees', 'website-admin', 'WEBSITE-123'));
    expect(a).not.toBe(b);

    const la = norm(taskLockPath('locks', 'WEBSITE-123', 'website-frontend'));
    const lb = norm(taskLockPath('locks', 'WEBSITE-123', 'website-admin'));
    expect(la).not.toBe(lb);
  });
});
