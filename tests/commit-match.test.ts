import { describe, it, expect } from 'vitest';
import { commitMatches } from '../src/collectors/git.collector';

describe('commitMatches', () => {
  const full = '2e965b4619c98a409e9c1ee1ab6a87f2af4e94e2';
  const short = '2e965b4619c9'; // Bitbucket Cloud returns 12-char hashes in PR objects

  it('matches identical full hashes', () => {
    expect(commitMatches(full, full)).toBe(true);
  });

  it('matches an abbreviated Cloud hash against the full git HEAD (both directions)', () => {
    expect(commitMatches(short, full)).toBe(true);
    expect(commitMatches(full, short)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(commitMatches(short.toUpperCase(), full)).toBe(true);
  });

  it('does not match different commits', () => {
    expect(commitMatches('deadbeefcafe', full)).toBe(false);
  });

  it('refuses to prefix-match on fewer than 7 chars (avoids false positives)', () => {
    expect(commitMatches('2e9', full)).toBe(false);
  });

  it('returns false for empty / missing values', () => {
    expect(commitMatches('', full)).toBe(false);
    expect(commitMatches(full, undefined)).toBe(false);
    expect(commitMatches(undefined, undefined)).toBe(false);
  });
});
