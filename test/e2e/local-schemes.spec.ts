// Revisão final #4: data:, blob: e about: nunca vão à rede — os hooks não podem quebrá-los.
import { test, expect } from '../fixtures.ts';

test('ON: data: and blob: URLs keep working and are not recorded', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  const r = await page.evaluate(async () => {
    const out: Record<string, string> = {};
    out.fetchData = await (await fetch('data:text/plain,ola')).text();
    const blobUrl = URL.createObjectURL(new Blob(['do-blob'], { type: 'text/plain' }));
    out.fetchBlob = await (await fetch(blobUrl)).text();
    out.xhrBlob = await new Promise<string>((res) => {
      const x = new XMLHttpRequest();
      x.onload = () => res(x.responseText);
      x.onerror = () => res('error');
      x.open('GET', blobUrl);
      x.send();
    });
    out.xhrSyncData = (() => { const x = new XMLHttpRequest(); x.open('GET', 'data:text/plain,sync', false); x.send(); return x.responseText; })();
    return out;
  });
  expect(r).toEqual({ fetchData: 'ola', fetchBlob: 'do-blob', xhrBlob: 'do-blob', xhrSyncData: 'sync' });
  expect(await ext.send({ type: 'getRecords' })).toEqual([]);
  expect(sink.connections).toBe(0);
});

test('ON: forged hook record with invalid method is rejected', async ({ ext, openApp, page }) => {
  await openApp();
  await page.evaluate(() => {
    const rec = { hookId: 'x-1', url: 'https://example.test/', method: 'X;touch /tmp/p', headers: [], body: null,
      kind: 'fetch', held: false, frameUrl: location.href, stack: '', timestamp: new Date().toISOString() };
    window.dispatchEvent(new CustomEvent('__ni_to_bridge', { detail: JSON.stringify({ type: 'hookRecord', record: rec }) }));
  });
  await page.waitForTimeout(500);
  expect(await ext.send({ type: 'getRecords' })).toEqual([]);
});
