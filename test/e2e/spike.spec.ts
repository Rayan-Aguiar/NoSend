// Spike: valida as suposições da spec §8 antes do restante da implementação.
import { test, expect } from '../fixtures.ts';

test('extension loads headless', async ({ sw }) => {
  expect(sw.url()).toMatch(/^chrome-extension:\/\//);
});

test('OFF: fetch reaches sink', async ({ openApp, run, sink }) => {
  const page = await openApp();
  const r = await run(page, 'fetchGet');
  expect(r).toEqual({ kind: 'resolved', status: 200 });
  expect(sink.requests.length).toBe(1);
});

test('ON: fetch blocked before TCP', async ({ openApp, run, sink, ext }) => {
  const page = await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  const r = await run(page, 'fetchGet');
  expect(r.kind).toBe('rejected');
  expect(r.name).toBe('TypeError');
  expect(sink.connections).toBe(0);
  expect(sink.requests.length).toBe(0);
});

test('onRuleMatchedDebug fires for xhr, main_frame, worker', async ({ openApp, sink, ext, page }) => {
  await openApp();
  await ext.eval(() => {
    (globalThis as any).__matched = [];
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      (globalThis as any).__matched.push({ type: info.request.type, url: info.request.url, tabId: info.request.tabId, initiator: info.request.initiator });
    });
    // Sem isso, o preditor do Chrome faz preconnect TCP na navegação (ver spike-preconnect).
    return chrome.privacy.network.networkPredictionEnabled.set({ value: false });
  }, null);
  await ext.send({ type: 'setEnabled', enabled: true });

  await page.evaluate((s) => fetch(s + '/xhr').catch(() => {}), sink.origin);
  await page.evaluate((s) => {
    const code = `fetch(${JSON.stringify(s + '/w')}).catch(()=>{}).finally(()=>postMessage('done'))`;
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    return new Promise((r) => { w.onmessage = r; });
  }, sink.origin);
  const nav = await page.context().newPage();
  await nav.goto(sink.origin + '/nav').catch(() => {});

  await expect.poll(async () => (await ext.eval(() => (globalThis as any).__matched, null)).length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  const matched = await ext.eval(() => (globalThis as any).__matched, null);
  console.log('SPIKE onRuleMatchedDebug:', JSON.stringify(matched));
  const byPath = (p: string) => matched.find((m: any) => m.url.endsWith(p));
  expect(byPath('/xhr')?.type).toBe('xmlhttprequest');
  expect(byPath('/w')).toBeTruthy();
  expect(byPath('/nav')?.type).toBe('main_frame');
  expect(sink.connections).toBe(0);
});

test('testMatchOutcome available', async ({ ext, sink }) => {
  await ext.send({ type: 'setEnabled', enabled: true });
  const out = await ext.eval(async (url) => {
    const dnr = chrome.declarativeNetRequest as any;
    if (typeof dnr.testMatchOutcome !== 'function') return null;
    return dnr.testMatchOutcome({ url, type: 'xmlhttprequest' });
  }, sink.origin + '/x');
  console.log('SPIKE testMatchOutcome:', JSON.stringify(out));
  expect(out?.matchedRules?.[0]?.ruleId).toBe(1);
});

test('registered MAIN scripts run in order', async ({ ext, openApp, page }) => {
  await ext.eval(() => chrome.scripting.registerContentScripts([
    { id: 'a', js: ['test-fixtures/a.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', allFrames: true },
    { id: 'b', js: ['test-fixtures/b.js'], matches: ['<all_urls>'], runAt: 'document_start', world: 'MAIN', allFrames: true },
  ]), null);
  await openApp();
  const order = await page.evaluate(() => (window as any).__NI_ORDER__);
  console.log('SPIKE order:', JSON.stringify(order));
  expect(order).toEqual(['a', 'b']);
});
