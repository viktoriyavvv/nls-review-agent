import { describe, it, expect } from 'vitest';
import {
  parseIssueKey,
  resolveRepoSelection,
  RepoResolutionError,
} from '../src/config/loadConfig';
import { AppConfig, ResolvedRepo } from '../src/config/types';

function mkRepo(id: string, prefixes: string[]): ResolvedRepo {
  return {
    id,
    jiraPrefixes: prefixes,
    path: `./repos/${id}`,
    absPath: `/abs/repos/${id}`,
    defaultBaseBranch: 'origin/master',
    bitbucket: { projectKey: id.toUpperCase(), repoSlug: id },
  };
}

function makeConfig(): AppConfig {
  const repos: Record<string, ResolvedRepo> = {
    'support-center-frontend': mkRepo('support-center-frontend', ['SC']),
    'website-frontend': mkRepo('website-frontend', ['WEBSITE']),
    'website-admin': mkRepo('website-admin', ['WEBSITE']),
  };
  return {
    projectRoot: '/x',
    root: {
      reposDir: '/x/repos',
      worktreesDir: '/x/worktrees',
      outputsDir: '/x/outputs',
      locksDir: '/x/locks',
    },
    jira: { baseUrl: '', email: '', apiToken: '', apiVersion: '3' },
    bitbucket: { type: 'datacenter', baseUrl: '', username: '', token: '' },
    claude: {
      bin: 'claude',
      model: 'opus',
      effort: 'max',
      permissionMode: 'dangerously-skip-permissions',
      outputFormat: 'json',
    },
    repos,
    profiles: { default: 'default', profiles: {} },
    jiraFields: { standardFields: [], customFields: [] },
  };
}

describe('parseIssueKey', () => {
  it('parses prefix and number', () => {
    expect(parseIssueKey('SC-3749')).toEqual({ key: 'SC-3749', prefix: 'SC', number: '3749' });
    expect(parseIssueKey('WEBSITE-123').prefix).toBe('WEBSITE');
    expect(parseIssueKey('CRMMEG-45').prefix).toBe('CRMMEG');
  });

  it('uppercases the prefix', () => {
    expect(parseIssueKey('sc-1').prefix).toBe('SC');
    expect(parseIssueKey('sc-1').key).toBe('SC-1');
  });

  it('rejects invalid keys', () => {
    expect(() => parseIssueKey('nope')).toThrow(RepoResolutionError);
    expect(() => parseIssueKey('SC-')).toThrow();
    expect(() => parseIssueKey('123')).toThrow();
  });
});

describe('resolveRepoSelection', () => {
  const config = makeConfig();

  it('Case 1: single mapped repo, no --repo -> auto', () => {
    const repo = resolveRepoSelection(config, 'SC-3749');
    expect(repo.id).toBe('support-center-frontend');
  });

  it('Case 1: multiple mapped repos, no --repo -> error with suggestions', () => {
    expect(() => resolveRepoSelection(config, 'WEBSITE-123')).toThrow(/Multiple repositories/);
    try {
      resolveRepoSelection(config, 'WEBSITE-123');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('--repo website-frontend');
      expect(msg).toContain('--repo website-admin');
    }
  });

  it('no mapped repo -> error', () => {
    expect(() => resolveRepoSelection(config, 'ZZZ-1')).toThrow(/No repository found/);
  });

  it('Case 2: explicit --repo that is mapped', () => {
    const repo = resolveRepoSelection(config, 'WEBSITE-123', { repo: 'website-admin' });
    expect(repo.id).toBe('website-admin');
  });

  it('Case 2: explicit --repo not in config -> error', () => {
    expect(() =>
      resolveRepoSelection(config, 'WEBSITE-123', { repo: 'does-not-exist' }),
    ).toThrow(/not found/);
  });

  it('Case 3: explicit --repo with unmapped prefix -> error without flag', () => {
    expect(() =>
      resolveRepoSelection(config, 'SC-1', { repo: 'website-admin' }),
    ).toThrow(/not mapped to Jira prefix SC/);
  });

  it('Case 3: --allow-unmapped overrides the prefix check', () => {
    const repo = resolveRepoSelection(config, 'SC-1', {
      repo: 'website-admin',
      allowUnmapped: true,
    });
    expect(repo.id).toBe('website-admin');
  });
});
