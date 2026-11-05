// Revisão final #2: na dúvida, um registro é tratado como anônimo (só memória, nunca disco).
import { test, expect } from '@playwright/test';
import { resolveIncognito } from '../../src/background/incognito.ts';

const tab = (incognito: boolean) => async () => ({ incognito });
const gone = async () => { throw new Error('No tab with id'); };

test('known tab: uses the tab flag', async () => {
  expect(await resolveIncognito(5, tab(true), async () => false)).toBe(true);
  expect(await resolveIncognito(5, tab(false), async () => true)).toBe(false);
});

test('tab lookup fails: conservatively incognito', async () => {
  expect(await resolveIncognito(5, gone, async () => false)).toBe(true);
});

test('no tab (service worker): incognito iff an incognito window exists', async () => {
  expect(await resolveIncognito(-1, gone, async () => false)).toBe(false);
  expect(await resolveIncognito(-1, gone, async () => true)).toBe(true);
});

test('incognito-window check fails: conservatively incognito', async () => {
  expect(await resolveIncognito(-1, gone, async () => { throw new Error('x'); })).toBe(true);
});
