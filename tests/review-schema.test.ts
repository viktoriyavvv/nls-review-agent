import { describe, it, expect } from 'vitest';
import { extractJsonObject, parseReviewResult } from '../src/review/review.schema';
import { extractAdfText } from '../src/collectors/jira.client';

describe('extractJsonObject', () => {
  it('parses raw JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced ```json blocks', () => {
    const text = 'here you go:\n```json\n{"verdict":"HOLD"}\n```\nthanks';
    expect(extractJsonObject(text)).toEqual({ verdict: 'HOLD' });
  });

  it('parses an object embedded in prose', () => {
    const text = 'Result: {"verdict":"APPROVE","summary":"ok"} done';
    expect(extractJsonObject(text)).toMatchObject({ verdict: 'APPROVE' });
  });

  it('prefers the ReviewResult when prose has other {} (TM-230 regression)', () => {
    const text =
      'I now have everything I need.\n' +
      '- code: `GET(url, params={})` and `PUT(url, data={})`\n' +
      '## Review assessment\nLooks good.\n' +
      '{"verdict":"APPROVE","summary":"ok","risks":[{"title":"x","level":"low"}]}';
    expect(extractJsonObject(text)).toMatchObject({ verdict: 'APPROVE' });
  });

  it('ignores braces inside JSON string values', () => {
    expect(extractJsonObject('pre {"verdict":"HOLD","summary":"a } b { c"} post')).toMatchObject({
      verdict: 'HOLD',
      summary: 'a } b { c',
    });
  });

  it('returns null when no JSON present', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('parseReviewResult', () => {
  it('validates a minimal result and applies defaults', () => {
    const out = parseReviewResult('{"verdict":"APPROVE","summary":"looks good"}');
    expect(out.ok).toBe(true);
    expect(out.result?.verdict).toBe('APPROVE');
    expect(out.result?.blockers).toEqual([]);
    expect(out.result?.questionsForDeveloper).toEqual([]);
  });

  it('fails on an invalid verdict', () => {
    const out = parseReviewResult('{"verdict":"MAYBE"}');
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it('fails when no JSON', () => {
    const out = parseReviewResult('the model rambled without json');
    expect(out.ok).toBe(false);
  });
});

describe('extractAdfText', () => {
  it('extracts text from an ADF document', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
      ],
    };
    const text = extractAdfText(adf);
    expect(text).toContain('Hello');
    expect(text).toContain('one');
  });

  it('passes through plain strings', () => {
    expect(extractAdfText('just text')).toBe('just text');
  });
});
