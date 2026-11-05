import { test, expect } from '@playwright/test';
import { exactUrlRegex, canRelease, MAX_REGEX_LEN } from '../../src/shared/regex.ts';

test('strips fragment, escapes and anchors', () => {
  const r = exactUrlRegex('https://a.com/p?x=1.2#frag');
  expect(r).toBe('^https://a\\.com/p\\?x=1\\.2$');
  expect(new RegExp(r).test('https://a.com/p?x=1.2')).toBe(true);
  expect(new RegExp(r).test('https://aXcom/p?x=1.2')).toBe(false);
});

test('long URL cannot be released', () => {
  const url = 'https://a.com/' + 'a'.repeat(3000);
  expect(MAX_REGEX_LEN).toBe(2000);
  expect(canRelease(url)).toBe(false);
  expect(canRelease('https://a.com/')).toBe(true);
});
