// Task 7: WebSocket / EventSource — placeholders com ON e fechamento de conexões já abertas.
import { test, expect } from '../fixtures.ts';
import type { InterceptedRequest } from '../../src/shared/types.ts';
import { WS_PLACEHOLDER } from '../../src/content/hooks/websocket.ts';
import { ES_PLACEHOLDER } from '../../src/content/hooks/eventsource.ts';

const CLOSED_NOTE = 'conexão aberta antes do ON encerrada pelo interceptor';

async function records(ext: { send: (r: any) => Promise<any> }): Promise<InterceptedRequest[]> {
  return ext.send({ type: 'getRecords' });
}

test('placeholders are non-routable and mixed-content safe', () => {
  expect(WS_PLACEHOLDER).toBe('wss://blocked.invalid/');
  expect(ES_PLACEHOLDER).toBe('https://blocked.invalid/');
});

test.describe('interceptor ON', () => {
  test('websocket fails like the network and is recorded', async ({ ext, openApp, run, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const out = await run(page, 'websocket');
    expect(out.kind).toBe('events');
    expect(out.events).toContain('error');
    expect(out.events).toContain('close');
    expect(out.events).not.toContain('open');
    // send() antes de abrir: mesma exceção que o nativo lança
    expect(out.events).toContain('send-error:InvalidStateError');
    expect(out.url).toBe(sink.wsOrigin + '/ws');

    await expect.poll(async () => (await records(ext)).some((r) => r.kind === 'websocket-message')).toBe(true);
    const recs = await records(ext);
    const ws = recs.find((r) => r.kind === 'websocket')!;
    expect(ws.url).toBe(sink.wsOrigin + '/ws');
    expect(ws.method).toBe('GET');
    expect(ws.status).toBe('BLOCKED');
    expect(ws.body).toBeNull();
    const msg = recs.find((r) => r.kind === 'websocket-message')!;
    expect(msg.url).toBe(sink.wsOrigin + '/ws');
    expect(msg.method).toBe('SEND');
    expect(msg.body).toMatchObject({ type: 'text', raw: 'hi' });
    // Nenhum registro do placeholder vindo do DNR
    expect(recs.some((r) => r.url.includes('blocked.invalid'))).toBe(false);
    expect(sink.connections).toBe(0);
  });

  test('eventSource fails and is recorded', async ({ ext, openApp, run, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const out = await run(page, 'eventSource');
    expect(out.events).toContain('error');
    expect(out.events).not.toContain('open');
    expect(out.url).toBe(sink.origin + '/sse');

    await expect.poll(async () => (await records(ext)).some((r) => r.kind === 'eventsource')).toBe(true);
    const es = (await records(ext)).find((r) => r.kind === 'eventsource')!;
    expect(es.url).toBe(sink.origin + '/sse');
    expect(es.method).toBe('GET');
    expect(es.status).toBe('BLOCKED');
    expect((await records(ext)).some((r) => r.url.includes('blocked.invalid'))).toBe(false);
    expect(sink.connections).toBe(0);
  });

  test('constructors keep native identity', async ({ ext, openApp, page, sink }) => {
    await openApp();
    await ext.send({ type: 'setEnabled', enabled: true });
    const r = await page.evaluate((s) => {
      const ws = new WebSocket(s.replace(/^http/, 'ws') + '/ws');
      const es = new EventSource(s + '/sse');
      const res = {
        wsInstance: ws instanceof WebSocket, wsCtor: ws.constructor === WebSocket,
        open: WebSocket.OPEN, closed: WebSocket.CLOSED, protoOpen: (WebSocket.prototype as any).OPEN,
        name: WebSocket.name, length: WebSocket.length,
        str: Function.prototype.toString.call(WebSocket), str2: String(WebSocket),
        sendStr: Function.prototype.toString.call(WebSocket.prototype.send),
        esInstance: es instanceof EventSource, esName: EventSource.name, esClosed: EventSource.CLOSED,
        esStr: Function.prototype.toString.call(EventSource),
        callThrows: (() => { try { (WebSocket as any)('ws://x'); return false; } catch (e) { return (e as Error).name; } })(),
        badUrl: (() => { try { new WebSocket('ftp://x/'); return false; } catch (e) { return (e as Error).name; } })(),
      };
      ws.close(); es.close();
      return res;
    }, sink.origin);
    expect(r).toEqual({
      wsInstance: true, wsCtor: true, open: 1, closed: 3, protoOpen: 1, name: 'WebSocket', length: 1,
      str: expect.stringContaining('[native code]'), str2: expect.stringContaining('[native code]'),
      sendStr: expect.stringContaining('[native code]'),
      esInstance: true, esName: 'EventSource', esClosed: 2, esStr: expect.stringContaining('[native code]'),
      callThrows: 'TypeError', badUrl: 'SyntaxError',
    });
    expect(sink.connections).toBe(0);
  });
});

test.describe('interceptor OFF', () => {
  test('websocket and eventSource work normally', async ({ ext, openApp, run, page, sink }) => {
    await openApp();
    const ws = await run(page, 'websocket');
    expect(ws.events).toContain('open');
    expect(ws.events).toContain('message:hi');
    expect(sink.wsFrames).toContain('hi');
    const es = await run(page, 'eventSource');
    expect(es.events).toContain('open');
    expect(es.events).toContain('message:hello');
    expect(await records(ext)).toEqual([]);
  });
});

test('connection opened while OFF is closed when the interceptor turns ON', async ({ ext, openApp, run, page, sink }) => {
  await openApp();
  const first = await run(page, 'openWsThenEnable');
  expect(first.events).toEqual(['open']);
  await ext.send({ type: 'setEnabled', enabled: true });
  await expect.poll(async () => (await records(ext)).some((r) => r.notes.includes(CLOSED_NOTE))).toBe(true);
  const out = await run(page, 'sendAfterEnable');
  expect(out).toEqual({ kind: 'returned', value: 3 });
  expect(sink.wsFrames).not.toContain('after');

  const recs = await records(ext);
  const closed = recs.find((r) => r.notes.includes(CLOSED_NOTE))!;
  expect(closed.kind).toBe('websocket');
  expect(closed.url).toBe(sink.wsOrigin + '/ws');
  expect(closed.status).toBe('BLOCKED');
  // a tentativa de envio após o fechamento também é registrada
  await expect.poll(async () => (await records(ext)).some((r) => r.kind === 'websocket-message' && (r.body as any)?.raw === 'after')).toBe(true);
});
