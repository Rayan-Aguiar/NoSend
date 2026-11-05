// Task 4: captura de fallback via onRuleMatchedDebug (o que os hooks não veem).
import { test, expect, type Ext } from '../fixtures.ts';
import type { InterceptedRequest, RequestKind } from '../../src/shared/types.ts';

const records = (ext: Ext): Promise<InterceptedRequest[]> => ext.send({ type: 'getRecords' });

/** Espera um registro DNR cuja URL comece com `prefix`. */
async function dnrRecord(ext: Ext, prefix: string): Promise<InterceptedRequest> {
  let found: InterceptedRequest | undefined;
  await expect
    .poll(async () => {
      found = (await records(ext)).find((r) => r.source === 'dnr' && r.url.startsWith(prefix));
      return !!found;
    }, { timeout: 10_000 })
    .toBe(true);
  return found!;
}

function expectDnrShape(rec: InterceptedRequest, kind: RequestKind, method = 'GET'): void {
  expect(rec.kind).toBe(kind);
  expect(rec.method).toBe(method);
  expect(rec.status).toBe('BLOCKED');
  expect(rec.headers).toEqual([]);
  expect(rec.contentType).toBeNull();
  expect(rec.body).toEqual({ type: 'unavailable', reason: 'capturado pela camada de rede' });
  expect(rec.notes).toEqual(['headers/body indisponíveis: requisição bloqueada na camada de rede']);
  expect(rec.incognito).toBe(false);
  expect(Number.isNaN(Date.parse(rec.timestamp))).toBe(false);
}

test('formSubmit (POST, iframe target) → sub_frame record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  expect(await run(page, 'formSubmit')).toEqual({ kind: 'returned', value: 'submitted' });
  const rec = await dnrRecord(ext, sink.origin + '/form');
  expectDnrShape(rec, 'sub_frame', 'POST');
  expect(rec.origin.tabId).toBeGreaterThanOrEqual(0);
  expect(sink.connections).toBe(0);
});

test('imgTag → image record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  expect(await run(page, 'imgTag')).toEqual({ kind: 'events', events: ['error'] });
  const rec = await dnrRecord(ext, sink.origin + '/img.png');
  expectDnrShape(rec, 'image');
  expect(rec.origin.initiator).toBe(new URL(page.url()).origin);
  expect(rec.origin.documentUrl).toBe(page.url());
  expect(sink.connections).toBe(0);
});

// O Chrome reporta o fetch de um Dedicated Worker com tabId, frameId e documentId da página:
// indistinguível de um fetch da própria página ⇒ kind 'other' (ver kindFor em dnrlog.ts).
test('workerFetch (dedicated worker) → other record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  await run(page, 'prepareWorker');
  await ext.send({ type: 'setEnabled', enabled: true });
  const out = await run(page, 'workerFetch');
  expect(out.kind).toBe('rejected');
  const rec = await dnrRecord(ext, sink.origin + '/worker');
  expectDnrShape(rec, 'other');
  expect(rec.origin.tabId).toBeGreaterThanOrEqual(0);
  expect(sink.connections).toBe(0);
});

test('serviceWorkerFetch → worker record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  expect((await run(page, 'registerSw')).kind).toBe('returned');
  await ext.send({ type: 'setEnabled', enabled: true });
  const out = await run(page, 'serviceWorkerFetch');
  expect(out.kind).toBe('rejected');
  const rec = await dnrRecord(ext, sink.origin + '/sw');
  expectDnrShape(rec, 'worker');
  expect(rec.origin.tabId).toBe(-1);
  expect(sink.connections).toBe(0);
});

test('iframeSrc → sub_frame record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await run(page, 'iframeSrc');
  const rec = await dnrRecord(ext, sink.origin + '/frame');
  expectDnrShape(rec, 'sub_frame');
  expect(sink.connections).toBe(0);
});

test('topNavigation (window.open) → main_frame record', async ({ openApp, run, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  expect(await run(page, 'topNavigation')).toEqual({ kind: 'returned', value: 'opened' });
  const rec = await dnrRecord(ext, sink.origin + '/top');
  expectDnrShape(rec, 'main_frame');
  expect(rec.origin.tabId).toBeGreaterThanOrEqual(0);
  expect(sink.connections).toBe(0);
});

test('query parsed from URL preserving order and duplicates', async ({ openApp, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await page.evaluate((s) => {
    const img = new Image();
    img.src = s + '/q.png?b=2&a=1&b=3&c=a%20b';
    document.body.appendChild(img);
  }, sink.origin);
  const rec = await dnrRecord(ext, sink.origin + '/q.png');
  expect(rec.query).toEqual([['b', '2'], ['a', '1'], ['b', '3'], ['c', 'a b']]);
  expect(sink.connections).toBe(0);
});

test('placeholder ignored', async ({ openApp, sink, ext, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  // Requisições feitas de um worker (sem hooks) chegam ao DNR, como as dos placeholders.
  await page.evaluate((s) => {
    const code = `Promise.all([
      fetch('https://blocked.invalid/').catch(() => {}),
      fetch('https://x.blocked.invalid/').catch(() => {}),
    ]).then(() => fetch(${JSON.stringify(s + '/after')}).catch(() => {})).then(() => postMessage('done'));`;
    const w = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    return new Promise((r) => { w.onmessage = r; });
  }, sink.origin);
  // Marcador: quando ele aparece, os eventos anteriores já foram processados.
  await dnrRecord(ext, sink.origin + '/after');
  const recs = await records(ext);
  expect(recs.filter((r) => r.url.includes('blocked.invalid'))).toEqual([]);
  expect(sink.connections).toBe(0);
});
