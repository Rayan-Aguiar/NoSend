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

test.describe('fetch record fidelity (what the browser would send)', () => {
  const recFor = async (ext: any, path: string) => {
    let rec: InterceptedRequest | undefined;
    await expect.poll(async () => {
      rec = ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).find((x) => new URL(x.url).pathname === path);
      return !!rec;
    }).toBe(true);
    return rec!;
  };

  test('implicit Content-Type is recorded for string / URLSearchParams / FormData bodies', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    await page.evaluate((s) => {
      const fd = new FormData(); fd.append('a', '1');
      return Promise.allSettled([
        fetch(s + '/str', { method: 'POST', body: '{"a":1}' }),
        fetch(s + '/usp', { method: 'POST', body: new URLSearchParams({ a: '1' }) }),
        fetch(s + '/fd', { method: 'POST', body: fd }),
      ]);
    }, sink.origin);
    expect((await recFor(ext, '/str')).contentType).toBe('text/plain;charset=UTF-8');
    expect((await recFor(ext, '/usp')).contentType).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    expect((await recFor(ext, '/fd')).contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sink.connections).toBe(0);
  });

  test('forbidden headers are not recorded; app headers keep their original name', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    await page.evaluate((s) => fetch(s + '/hdr', { headers: { Cookie: 'sid=1', Host: 'evil', 'X-Custom': 'v' } }).catch(() => {}), sink.origin);
    const rec = await recFor(ext, '/hdr');
    expect(hdr(rec, 'cookie')).toBeUndefined();
    expect(hdr(rec, 'host')).toBeUndefined();
    expect(rec.headers).toContainEqual(['X-Custom', 'v']);
    expect(sink.connections).toBe(0);
  });

  test('invalid fetch rejects like native and records nothing', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const r = await page.evaluate((s) => Promise.all([
      fetch('http://[bad/invalid').then(() => 'resolved', (e) => `${e.name}:${/parse URL/.test(e.message)}`),
      fetch(s + '/getbody', { method: 'GET', body: 'x' }).then(() => 'resolved', (e) => e.name),
      fetch(s + '/after').then(() => 'resolved', (e) => e.name),
    ]), sink.origin);
    expect(r).toEqual(['TypeError:true', 'TypeError', 'TypeError']);
    await recFor(ext, '/after'); // controle positivo: o hook está registrando
    const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
    expect(recs.some((x) => x.url.includes('[bad') || x.url.endsWith('/getbody'))).toBe(false);
    expect(sink.connections).toBe(0);
  });
});

test.describe('record metadata', () => {
  test('stack keeps app frames from a file named hooks.js', async ({ ext, openApp, page, sink, app }) => {
    await openApp();
    await page.addScriptTag({ url: app.origin + '/hooks.js' });
    await ext.send({ type: 'setEnabled', enabled: true });
    await page.evaluate((s) => (window as any).appHooksFetch(s + '/stack'), sink.origin);
    let rec: InterceptedRequest | undefined;
    await expect.poll(async () => {
      rec = ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).find((x) => x.url.endsWith('/stack'));
      return !!rec;
    }).toBe(true);
    expect(rec!.origin.stack).toContain('/hooks.js');
    expect(rec!.origin.stack).not.toContain('chrome-extension://');
  });

  test('records keep call order and call time even when a body is slow to read', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const calledAt = await page.evaluate((s) => {
      const big = new Request(s + '/first', { method: 'POST', body: new Blob([new Uint8Array(8 * 1024 * 1024)]) });
      const t = Date.now();
      fetch(big).catch(() => {});
      fetch(s + '/second').catch(() => {});
      return t;
    }, sink.origin);
    let recs: InterceptedRequest[] = [];
    await expect.poll(async () => {
      recs = ((await ext.send({ type: 'getRecords' })) as InterceptedRequest[]).filter((x) => /\/(first|second)$/.test(x.url));
      return recs.length;
    }).toBe(2);
    expect(recs.map((r) => new URL(r.url).pathname)).toEqual(['/first', '/second']);
    expect(recs[0].seq).toBeLessThan(recs[1].seq);
    expect(Date.parse(recs[0].timestamp) - calledAt).toBeLessThan(50);
    expect(sink.connections).toBe(0);
  });
});

test('blocked async XHR follows native event sequence', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  const r = await page.evaluate((s) => new Promise((res) => {
    const x = new XMLHttpRequest();
    const log: string[] = [];
    for (const ev of ['loadstart', 'readystatechange', 'error', 'loadend']) {
      x.addEventListener(ev, () => log.push(`${ev}:${x.readyState}`));
    }
    x.open('POST', s + '/xhrseq');
    log.length = 0; // ignora o readystatechange do open()
    x.send('a');
    const afterSend = x.readyState;
    x.addEventListener('loadend', () => res({ afterSend, log, status: x.status }));
  }), sink.origin);
  expect(r).toEqual({
    afterSend: 1,
    log: ['loadstart:1', 'readystatechange:4', 'error:4', 'loadend:4'],
    status: 0,
  });
  expect(sink.connections).toBe(0);
});
