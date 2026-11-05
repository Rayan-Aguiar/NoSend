// Task 3: estado, regra DNR, privacy, status fail-safe e histórico.
import { test, expect, launchWithExtension } from '../fixtures.ts';
import type { ExtState, InterceptedRequest } from '../../src/shared/types.ts';

function fakeRecord(i: number, extra: Partial<InterceptedRequest> = {}): Omit<InterceptedRequest, 'id' | 'seq'> {
  return {
    timestamp: new Date().toISOString(), url: `https://example.test/${i}`, method: 'GET', query: [], headers: [],
    contentType: null, body: null, kind: 'fetch', source: 'hook', status: 'BLOCKED', origin: { tabId: 1 }, notes: [],
    ...extra,
  };
}

test('enable → PROTECTED', async ({ ext }) => {
  const st: ExtState = await ext.send({ type: 'setEnabled', enabled: true });
  expect(st.status).toBe('PROTECTED');
  expect(st.reasons).toEqual([]);
  const rules = await ext.eval(() => chrome.declarativeNetRequest.getDynamicRules(), null);
  const rule = rules.find((r) => r.id === 1)!;
  expect(rule.action.type).toBe('block');
  expect(rule.condition.resourceTypes?.length).toBe(15);
  expect(rule.condition.resourceTypes).toContain('main_frame');
});

test('disable → OFF, rule removed, prediction restored', async ({ ext }) => {
  await ext.send({ type: 'setEnabled', enabled: true });
  const pred = await ext.eval(() => chrome.privacy.network.networkPredictionEnabled.get({}), null);
  expect(pred.value).toBe(false);
  expect(pred.levelOfControl).toBe('controlled_by_this_extension');

  const st: ExtState = await ext.send({ type: 'setEnabled', enabled: false });
  expect(st.status).toBe('OFF');
  const rules = await ext.eval(() => chrome.declarativeNetRequest.getDynamicRules(), null);
  expect(rules.find((r) => r.id === 1)).toBeUndefined();
  const pred2 = await ext.eval(() => chrome.privacy.network.networkPredictionEnabled.get({}), null);
  expect(pred2.levelOfControl).not.toBe('controlled_by_this_extension');
});

test('forced DNR failure → INCOMPLETE', async ({ ext }) => {
  await ext.eval(() => chrome.storage.local.set({ __test_force_dnr_failure: true }), null);
  const st: ExtState = await ext.send({ type: 'setEnabled', enabled: true });
  expect(st.status).toBe('INCOMPLETE');
  expect(st.reasons.length).toBeGreaterThan(0);
  const again: ExtState = await ext.send({ type: 'getState' });
  expect(again.status).toBe('INCOMPLETE');
});

test('rule removed externally → INCOMPLETE on getState', async ({ ext }) => {
  await ext.send({ type: 'setEnabled', enabled: true });
  await ext.eval(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }), null);
  const st: ExtState = await ext.send({ type: 'getState' });
  expect(st.status).toBe('INCOMPLETE');
  expect(st.reasons.join(' ')).toMatch(/regra/i);
});

test('rapid toggle ON/OFF/ON ends PROTECTED with rule present', async ({ ext }) => {
  const results: ExtState[] = await ext.eval(async () => {
    const h = (globalThis as any).niDebug.handle;
    return Promise.all([
      h({ type: 'setEnabled', enabled: true }),
      h({ type: 'setEnabled', enabled: false }),
      h({ type: 'setEnabled', enabled: true }),
    ]);
  }, null);
  for (const r of results) {
    if (!r.enabled) expect(r.status).not.toBe('PROTECTED');
  }
  expect(results[2].status).toBe('PROTECTED');
  const st: ExtState = await ext.send({ type: 'getState' });
  expect(st.enabled).toBe(true);
  expect(st.status).toBe('PROTECTED');
  const rules = await ext.eval(() => chrome.declarativeNetRequest.getDynamicRules(), null);
  expect(rules.some((r) => r.id === 1)).toBe(true);
});

test('history persists across SW memory reset', async ({ ext }) => {
  await ext.eval((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(1));
  await ext.eval(() => (globalThis as any).niDebug.flush(), null);
  await ext.eval(() => (globalThis as any).niDebug.reloadFromStorage(), null);
  const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
  expect(recs.map((r) => r.url)).toEqual(['https://example.test/1']);
  const next: InterceptedRequest = await ext.eval((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(2));
  expect(next.seq).toBeGreaterThan(recs[0].seq);
});

test('ON survives browser restart', async ({ userDataDir }) => {
  const first = await launchWithExtension(userDataDir);
  await first.sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'setEnabled', enabled: true }));
  await first.sw.evaluate((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(7));
  await first.sw.evaluate(() => (globalThis as any).niDebug.flush());
  await first.context.close();

  const second = await launchWithExtension(userDataDir);
  try {
    await expect.poll(async () => (await second.sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'getState' }))).status).toBe('PROTECTED');
    const rules = await second.sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    expect(rules.some((r) => r.id === 1)).toBe(true);
    const recs = await second.sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'getRecords' }));
    expect(recs.map((r: InterceptedRequest) => r.url)).toContain('https://example.test/7');
  } finally {
    await second.context.close();
  }
});

test('limit enforced', async ({ ext }) => {
  await ext.send({ type: 'setLimit', limit: 100 });
  await ext.eval(async (recs) => { for (const r of recs) (globalThis as any).niDebug.addRecord(r); }, Array.from({ length: 105 }, (_, i) => fakeRecord(i)));
  const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
  expect(recs.length).toBe(100);
  expect(recs[0].url).toBe('https://example.test/5');
  expect(recs.map((r) => r.seq)).toEqual([...recs.map((r) => r.seq)].sort((a, b) => a - b));
});

test('limit clamped to 100..10000', async ({ ext }) => {
  expect((await ext.send({ type: 'setLimit', limit: 5 })).limit).toBe(100);
  expect((await ext.send({ type: 'setLimit', limit: 99999 })).limit).toBe(10000);
});

test('incognito records not persisted', async ({ ext }) => {
  await ext.eval((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(1, { incognito: true }));
  await ext.eval((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(2));
  await ext.eval(() => (globalThis as any).niDebug.flush(), null);
  const stored = await ext.eval(() => chrome.storage.local.get('ni_history'), null);
  const urls = (stored.ni_history as InterceptedRequest[]).map((r) => r.url);
  expect(urls).toEqual(['https://example.test/2']);
  const mem: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
  expect(mem.length).toBe(2);
});

test('clear empties memory and storage', async ({ ext }) => {
  await ext.eval((r) => (globalThis as any).niDebug.addRecord(r), fakeRecord(1));
  await ext.send({ type: 'clear' });
  expect(await ext.send({ type: 'getRecords' })).toEqual([]);
  const stored = await ext.eval(() => chrome.storage.local.get('ni_history'), null);
  expect(stored.ni_history ?? []).toEqual([]);
  expect((await ext.send({ type: 'getState' })).count).toBe(0);
});
