// Task 8: modo Segurar — Liberar / Descartar.
import { test, expect } from '../fixtures.ts';
import type { Page } from '@playwright/test';
import type { InterceptedRequest } from '../../src/shared/types.ts';
import type { Ext } from '../fixtures.ts';

async function holdOn(ext: Ext) {
  await ext.send({ type: 'setMode', mode: 'hold' });
  await ext.send({ type: 'setEnabled', enabled: true });
}

/** Dispara um fetch e guarda o desfecho em window.__r[key]. */
function startFetch(page: Page, key: string, url: string, init?: RequestInit, asRequest = false) {
  return page.evaluate(([k, u, i, asReq]) => {
    const w = window as any;
    w.__r ??= {};
    w.__r[k] = 'pending';
    const p = asReq ? fetch(new Request(u as string, i as RequestInit)) : fetch(u as string, i as RequestInit);
    p.then(async (r) => { w.__r[k] = `resolved:${r.status}:${await r.text()}`; }, (e) => { w.__r[k] = `rejected:${e.name}`; });
  }, [key, url, init ?? null, asRequest] as const);
}
const result = (page: Page, key: string) => page.evaluate((k) => (window as any).__r[k], key);

async function recordFor(ext: Ext, pathname: string, status?: string): Promise<InterceptedRequest> {
  let rec: InterceptedRequest | undefined;
  await expect.poll(async () => {
    const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
    rec = recs.filter((r) => new URL(r.url).pathname === pathname && (!status || r.status === status)).pop();
    return !!rec;
  }).toBe(true);
  return rec!;
}

const nonPreflight = (sink: { requests: { method: string; url: string; body: Buffer }[] }, path: string) =>
  sink.requests.filter((r) => r.method !== 'OPTIONS' && r.url.split('?')[0] === path);

const JSON_INIT = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' };

test('hold keeps fetch pending', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  await page.waitForTimeout(1000);
  expect(await result(page, 'a')).toBe('pending');
  const rec = await recordFor(ext, '/users');
  expect(rec.status).toBe('HELD');
  expect(sink.connections).toBe(0);
  expect((await ext.send({ type: 'getState' })).heldCount).toBe(1);
});

test('release sends exactly once and removes the allow rule', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  const rec = await recordFor(ext, '/users', 'HELD');

  expect(await ext.send({ type: 'release', id: rec.id })).toEqual({ ok: true });
  await expect.poll(() => result(page, 'a')).toBe('resolved:200:{"ok":true}');
  expect(nonPreflight(sink, '/users').length).toBe(1);
  expect(nonPreflight(sink, '/users')[0].body.toString()).toBe('{"a":1}');

  await expect.poll(async () => (await recordFor(ext, '/users')).releaseResult).toEqual({ ok: true, status: 200 });
  expect((await recordFor(ext, '/users')).status).toBe('RELEASED');
  await expect.poll(() => ext.eval(() => chrome.declarativeNetRequest.getSessionRules(), null)).toEqual([]);

  // Liberar de novo não é permitido
  expect((await ext.send({ type: 'release', id: rec.id })).ok).toBe(false);

  // A exceção foi removida: requisição idêntica volta a ser segurada
  await startFetch(page, 'b', sink.origin + '/users', JSON_INIT);
  await page.waitForTimeout(800);
  expect(await result(page, 'b')).toBe('pending');
  expect(nonPreflight(sink, '/users').length).toBe(1);
});

test('release Request object keeps body', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/request-object', { method: 'POST', body: '{"r":1}', headers: { 'Content-Type': 'application/json' } }, true);
  const rec = await recordFor(ext, '/request-object', 'HELD');
  expect(rec.body).toMatchObject({ type: 'json', parsed: { r: 1 } });
  await ext.send({ type: 'release', id: rec.id });
  await expect.poll(() => result(page, 'a')).toMatch(/^resolved:200/);
  expect(nonPreflight(sink, '/request-object')[0].body.toString()).toBe('{"r":1}');
});

test('release xhr', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await page.evaluate((s) => {
    const w = window as any;
    w.__xhr = [];
    const x = new XMLHttpRequest();
    x.onload = () => w.__xhr.push('load:' + x.status);
    x.onerror = () => w.__xhr.push('error');
    x.open('POST', s + '/xhr');
    x.setRequestHeader('Content-Type', 'application/json');
    x.send('{"via":"xhr"}');
  }, sink.origin);
  const rec = await recordFor(ext, '/xhr', 'HELD');
  expect(await page.evaluate(() => (window as any).__xhr)).toEqual([]);
  await ext.send({ type: 'release', id: rec.id });
  await expect.poll(() => page.evaluate(() => (window as any).__xhr)).toEqual(['load:200']);
  expect(nonPreflight(sink, '/xhr').length).toBe(1);
  expect(nonPreflight(sink, '/xhr')[0].body.toString()).toBe('{"via":"xhr"}');
});

test('release beacon', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  const ret = await page.evaluate((s) => navigator.sendBeacon(s + '/beacon', 'beacon-data'), sink.origin);
  expect(ret).toBe(true);
  const rec = await recordFor(ext, '/beacon', 'HELD');
  await page.waitForTimeout(300);
  expect(sink.connections).toBe(0);
  await ext.send({ type: 'release', id: rec.id });
  await expect.poll(() => nonPreflight(sink, '/beacon').length).toBe(1);
  expect(nonPreflight(sink, '/beacon')[0].body.toString()).toBe('beacon-data');
});

test('discard gives network error and sends nothing', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  const rec = await recordFor(ext, '/users', 'HELD');
  expect(await ext.send({ type: 'discard', id: rec.id })).toEqual({ ok: true });
  await expect.poll(() => result(page, 'a')).toBe('rejected:TypeError');
  expect((await recordFor(ext, '/users')).status).toBe('DISCARDED');
  expect(sink.connections).toBe(0);
});

test('held request dies with its page', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  await recordFor(ext, '/users', 'HELD');
  await ext.send({ type: 'setEnabled', enabled: false }); // permite navegar
  await openApp();
  await expect.poll(async () => (await recordFor(ext, '/users')).status).toBe('DISCARDED_PAGE_GONE');
  expect(sink.connections).toBe(0);
});

test('held request discarded when tab closes', async ({ ext, openApp, page, sink, context }) => {
  await openApp();
  await holdOn(ext);
  const extra = await context.newPage();
  await page.evaluate(() => 0);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  await recordFor(ext, '/users', 'HELD');
  await page.close();
  await expect.poll(async () => (await recordFor(ext, '/users')).status).toBe('DISCARDED_PAGE_GONE');
  await extra.close();
});

test('redirect release fails cleanly', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/redirect');
  const rec = await recordFor(ext, '/redirect', 'HELD');
  expect((await ext.send({ type: 'release', id: rec.id })).ok).toBe(true);
  await expect.poll(() => result(page, 'a')).toBe('rejected:TypeError');
  await expect.poll(async () => (await recordFor(ext, '/redirect')).releaseResult?.ok).toBe(false);
  expect((await recordFor(ext, '/redirect')).releaseResult?.error).toMatch(/bloqueio global/);
  expect(sink.requests.map((r) => r.url)).toEqual(['/redirect']);
});

test('fail mode records are not releasable', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  const rec = await recordFor(ext, '/users', 'BLOCKED');
  const r = await ext.send({ type: 'release', id: rec.id });
  expect(r.ok).toBe(false);
  expect(sink.connections).toBe(0);
});

test('websocket ignores hold (fails immediately)', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  const events = await page.evaluate((u) => new Promise<string[]>((resolve) => {
    const ev: string[] = [];
    const ws = new WebSocket(u);
    ws.onopen = () => ev.push('open');
    ws.onerror = () => ev.push('error');
    ws.onclose = () => { ev.push('close'); resolve(ev); };
    setTimeout(() => resolve(ev), 3000);
  }), sink.wsOrigin + '/ws');
  expect(events).toEqual(['error', 'close']);
  const recs = await ext.send({ type: 'getRecords' });
  expect(recs.find((r: any) => r.kind === 'websocket')?.status).toBe('BLOCKED');
  expect(sink.connections).toBe(0);
});

test('clear history discards HELD requests (page gets network error)', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  await recordFor(ext, '/users', 'HELD');
  await ext.send({ type: 'clear' });
  await expect.poll(() => result(page, 'a')).toBe('rejected:TypeError');
  expect(sink.connections).toBe(0);
});

test('HELD evicted by history limit is discarded (page gets network error)', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setLimit', limit: 100 });
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  await recordFor(ext, '/users', 'HELD');
  // Empurra 100 registros novos: o HELD sai do buffer.
  await ext.eval(async (n) => {
    for (let i = 0; i < n; i++) {
      (globalThis as any).niDebug.addRecord({
        timestamp: new Date().toISOString(), url: `https://example.test/${i}`, method: 'GET', query: [], headers: [],
        contentType: null, body: null, kind: 'fetch', source: 'dnr', status: 'BLOCKED', origin: { tabId: -1 }, notes: [],
      });
    }
  }, 100);
  await expect.poll(() => result(page, 'a')).toBe('rejected:TypeError');
  expect((await ext.send({ type: 'getState' })).heldCount).toBe(0);
  expect(sink.connections).toBe(0);
});

test('release works for a non-standard method (PROPFIND)', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/dav', { method: 'PROPFIND' });
  const rec = await recordFor(ext, '/dav', 'HELD');
  expect(rec.method).toBe('PROPFIND');
  expect(await ext.send({ type: 'release', id: rec.id })).toEqual({ ok: true });
  await expect.poll(() => result(page, 'a')).toMatch(/^resolved:200/);
  expect(nonPreflight(sink, '/dav').map((r) => r.method)).toEqual(['PROPFIND']);
  // Exceção removida no primeiro uso (bem antes do timeout de 10 s).
  await expect.poll(async () => (await ext.eval(() => chrome.declarativeNetRequest.getSessionRules(), null)).length, { timeout: 3000 }).toBe(0);
});

test('HELD becomes DISCARDED_PAGE_GONE when a blocked navigation replaces the page', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await holdOn(ext);
  await startFetch(page, 'a', sink.origin + '/users', JSON_INIT);
  const rec = await recordFor(ext, '/users', 'HELD');
  await page.evaluate((u) => { location.href = u; }, sink.origin + '/elsewhere');
  await expect.poll(async () => {
    const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
    return recs.find((r) => r.id === rec.id)?.status;
  }).toBe('DISCARDED_PAGE_GONE');
  expect((await ext.send({ type: 'getState' })).heldCount).toBe(0);
  expect(sink.connections).toBe(0);
});
