import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  buildPermissionArgs,
  ClaudeRunOptions,
} from '../src/review/claude.runner';
import { ClaudeConfigSchema } from '../src/config/types';

const base: ClaudeRunOptions = {
  bin: 'claude',
  model: 'opus',
  effort: 'max',
  permissionMode: 'dangerously-skip-permissions',
  outputFormat: 'json',
  cwd: '/x',
};

describe('buildClaudeArgs', () => {
  it('builds the exact manual-CR command flags by default', () => {
    expect(buildClaudeArgs(base).join(' ')).toBe(
      '-p --dangerously-skip-permissions --effort max --model opus --output-format json',
    );
  });

  it('never includes --max-budget-usd', () => {
    expect(buildClaudeArgs(base)).not.toContain('--max-budget-usd');
    expect(buildClaudeArgs({ ...base, maxTurns: 7 })).not.toContain('--max-budget-usd');
  });

  it('does NOT add --max-turns by default', () => {
    expect(buildClaudeArgs(base)).not.toContain('--max-turns');
  });

  it('adds --max-turns only when maxTurns is set', () => {
    expect(buildClaudeArgs({ ...base, maxTurns: 12 }).join(' ')).toContain('--max-turns 12');
  });

  it('adds --dangerously-skip-permissions for that permission mode', () => {
    expect(buildClaudeArgs(base)).toContain('--dangerously-skip-permissions');
  });

  it('adds --model <model>', () => {
    expect(buildClaudeArgs({ ...base, model: 'opus' }).join(' ')).toContain('--model opus');
  });

  it('adds --effort <effort>', () => {
    expect(buildClaudeArgs({ ...base, effort: 'max' }).join(' ')).toContain('--effort max');
  });

  it('adds --output-format <format>', () => {
    expect(buildClaudeArgs({ ...base, outputFormat: 'json' }).join(' ')).toContain(
      '--output-format json',
    );
  });
});

describe('buildPermissionArgs', () => {
  it('dangerously-skip-permissions -> --dangerously-skip-permissions', () => {
    expect(buildPermissionArgs('dangerously-skip-permissions')).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('default / empty -> no flag', () => {
    expect(buildPermissionArgs('default')).toEqual([]);
    expect(buildPermissionArgs('')).toEqual([]);
    expect(buildPermissionArgs(undefined)).toEqual([]);
  });

  it('other modes -> --permission-mode <mode>', () => {
    expect(buildPermissionArgs('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits']);
    expect(buildPermissionArgs('plan')).toEqual(['--permission-mode', 'plan']);
  });
});

describe('ClaudeConfigSchema', () => {
  it('applies the required defaults for an empty block', () => {
    expect(ClaudeConfigSchema.parse({})).toEqual({
      bin: 'claude',
      model: 'opus',
      effort: 'max',
      permissionMode: 'dangerously-skip-permissions',
      outputFormat: 'json',
      maxTurns: undefined,
    });
  });

  it('treats empty ${ENV} substitutions as defaults', () => {
    const parsed = ClaudeConfigSchema.parse({
      bin: '',
      model: '',
      effort: '',
      permissionMode: '',
      outputFormat: '',
      maxTurns: '',
    });
    expect(parsed.model).toBe('opus');
    expect(parsed.effort).toBe('max');
    expect(parsed.permissionMode).toBe('dangerously-skip-permissions');
    expect(parsed.maxTurns).toBeUndefined();
  });

  it('honours explicit overrides and coerces maxTurns', () => {
    const parsed = ClaudeConfigSchema.parse({
      model: 'sonnet',
      permissionMode: 'default',
      maxTurns: '12',
    });
    expect(parsed.model).toBe('sonnet');
    expect(parsed.permissionMode).toBe('default');
    expect(parsed.maxTurns).toBe(12);
  });
});
