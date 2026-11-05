// Task 6: fetch / XHR / sendBeacon — captura fiel e semântica de falha de rede.
// Prova de segurança: com ON, o sink não recebe NENHUMA conexão TCP.
import { test, expect } from '../fixtures.ts';
import type { InterceptedRequest } from '../../src/shared/types.ts';

const HTTP_SCENARIOS = [
  'getQuery', 'postJson', 'putJson', 'deleteReq', 'postFormData', 'customHeaders', 'authorization',
  'fetchRequestObject', 'xhrPost', 'xhrSync', 'beacon',
] as const;

const hdr = (r: InterceptedRequest, name: string) =>
  r.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test.describe('interceptor ON', () => {
  test('all scenarios blocked, recorded, zero connections', async ({ ext, openApp, run, sink, page }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const out: Record<string, any> = {};
    for (const s of HTTP_SCENARIOS) out[s] = await run(page, s);

    // Semântica de falha de rede
    for (const s of ['getQuery', 'postJson', 'putJson', 'deleteReq', 'postFormData', 'customHeaders', 'authorization', 'fetchRequestObject']) {
      expect(out[s], s).toEqual({ kind: 'rejected', name: 'TypeError', message: 'Failed to fetch' });
    }
    expect(out.xhrPost).toEqual({ kind: 'events', events: ['readystatechange:4', 'error', 'loadend'], status: 0 });
    expect(out.xhrSync).toMatchObject({ kind: 'rejected', name: 'NetworkError' });
    expect(out.beacon).toEqual({ kind: 'returned', value: false });
    for (const v of Object.values(out)) expect(v.status === 200).toBe(false);

    // Segurança: nada chegou ao servidor
    expect(sink.connections).toBe(0);
    expect(sink.requests.length).toBe(0);

    // Registros
    await expect.poll(async () => ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).length).toBeGreaterThanOrEqual(HTTP_SCENARIOS.length);
    const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
    const by = (path: string, method?: string) =>
      recs.find((r) => new URL(r.url).pathname === path && (!method || r.method === method))!;
    const fromDnr = recs.filter((r) => r.source !== 'hook');
    expect(fromDnr.map((r) => `${r.kind} ${r.method} ${r.url} tab=${r.origin.tabId} init=${r.origin.initiator}`)).toEqual([]);
    for (const r of recs) {
      expect(r.source).toBe('hook');
      expect(r.status).toBe('BLOCKED');
      expect(r.url.startsWith(sink.origin)).toBe(true);
    }

    const q = by('/users', 'GET');
    expect(q.kind).toBe('fetch');
    expect(q.query).toEqual([['page', '2'], ['q', 'a b']]);

    const pj = by('/users', 'POST');
    expect(pj.body).toMatchObject({ type: 'json', parsed: { name: 'Rayan', email: 'rayan@example.com' } });
    expect(pj.headers).toContainEqual(['Content-Type', 'application/json']);
    expect(pj.contentType).toBe('application/json');
    expect(pj.origin.stack).toContain('app.js');
    expect(pj.origin.tabId).toBeGreaterThan(0);
    expect(pj.notes.join(' ')).toMatch(/navegador/);

    expect(by('/users/1', 'PUT').body).toMatchObject({ type: 'json', parsed: { name: 'Rayan Updated' } });
    expect(by('/users/1', 'DELETE').body).toBeNull();

    const fd = by('/upload', 'POST');
    expect(fd.body?.type).toBe('formdata');
    expect((fd.body as any).fields).toEqual([
      { name: 'name', value: 'Rayan' },
      { name: 'file', file: { name: 'x.txt', type: 'text/plain', size: 3 } },
    ]);

    expect(hdr(by('/custom'), 'X-Custom')).toBe('1');
    expect(hdr(by('/secure'), 'Authorization')).toBe('Bearer example-token');
    expect(by('/request-object').body).toMatchObject({ type: 'json', parsed: { r: 1 } });

    const x = by('/xhr', 'POST');
    expect(x.kind).toBe('xhr');
    expect(x.body).toMatchObject({ type: 'json', parsed: { via: 'xhr' } });
    expect(hdr(x, 'X-Requested-With')).toBe('XMLHttpRequest');
    expect(by('/xhr-sync').kind).toBe('xhr');

    const b = by('/beacon');
    expect(b.kind).toBe('beacon');
    expect(b.method).toBe('POST');
    expect(b.body).toMatchObject({ type: 'text', raw: 'beacon-data' });
  });

  test('request fired by first inline script is blocked and recorded', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    // Com ON a navegação é bloqueada: o documento vem de um iframe srcdoc (sem rede).
    const r = await page.evaluate((s) => {
      const f = document.createElement('iframe');
      f.srcdoc = `<script>window.__early = fetch(${JSON.stringify(s + '/early')}, {method:'POST', body:'{"early":true}', headers:{'Content-Type':'application/json'}})
        .then(() => 'resolved', (e) => e.name);</script>`;
      document.body.appendChild(f);
      return new Promise((res) => f.addEventListener('load', async () => res(await (f.contentWindow as any).__early)));
    }, sink.origin);
    expect(r).toBe('TypeError');
    await expect.poll(async () => ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).some((x) => x.url.endsWith('/early'))).toBe(true);
    const rec = ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).find((x) => x.url.endsWith('/early'))!;
    expect(rec.body).toMatchObject({ type: 'json', parsed: { early: true } });
    expect(sink.connections).toBe(0);
  });

  test('hooks keep native function identity', async ({ openApp, page }) => {
    await openApp();
    const r = await page.evaluate(() => ({
      fetchName: fetch.name, fetchLen: fetch.length, fetchStr: Function.prototype.toString.call(fetch),
      sendStr: Function.prototype.toString.call(XMLHttpRequest.prototype.send),
      beaconStr: Function.prototype.toString.call(navigator.sendBeacon),
    }));
    expect(r.fetchName).toBe('fetch');
    expect(r.fetchLen).toBe(1);
    expect(r.fetchStr).toContain('[native code]');
    expect(r.sendStr).toContain('[native code]');
    expect(r.beaconStr).toContain('[native code]');
  });
});

test.describe('interceptor OFF', () => {
  test('all scenarios reach the server unchanged, nothing recorded', async ({ ext, openApp, run, sink, page }) => {
    await openApp();
    const out: Record<string, any> = {};
    for (const s of HTTP_SCENARIOS) out[s] = await run(page, s);

    for (const s of ['getQuery', 'postJson', 'putJson', 'deleteReq', 'postFormData', 'customHeaders', 'authorization', 'fetchRequestObject']) {
      expect(out[s], s).toEqual({ kind: 'resolved', status: 200 });
    }
    expect(out.xhrPost).toMatchObject({ kind: 'events', status: 200 });
    expect(out.xhrPost.events).toContain('load');
    expect(out.xhrSync).toEqual({ kind: 'resolved', status: 200 });
    expect(out.beacon).toEqual({ kind: 'returned', value: true });

    await expect.poll(() => sink.requests.filter((r) => r.url === '/beacon').length).toBe(1);
    const req = (method: string, path: string) => sink.requests.find((r) => r.method === method && r.url.split('?')[0] === path)!;
    expect(JSON.parse(req('POST', '/users').body.toString())).toEqual({ name: 'Rayan', email: 'rayan@example.com' });
    expect(req('GET', '/users').url).toBe('/users?page=2&q=a%20b');
    expect(req('POST', '/secure').headers.authorization).toBe('Bearer example-token');
    expect(req('POST', '/request-object').body.toString()).toBe('{"r":1}');
    expect(req('DELETE', '/users/1')).toBeTruthy();
    expect(req('POST', '/upload').body.toString()).toContain('filename="x.txt"');

    expect(await ext.send({ type: 'getRecords' })).toEqual([]);
  });
});
