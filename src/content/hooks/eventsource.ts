// Hook de EventSource (spec §3.4): mesmo padrão do WebSocket, placeholder https.
import type { HookCtx } from './ctx';
import { disguise, emitRecord } from './common';
import { CLOSED_BY_INTERCEPTOR } from './websocket';

export const ES_PLACEHOLDER = 'https://blocked.invalid/';

export function installEventSourceHook(ctx: HookCtx): void {
  const NativeES = globalThis.EventSource;
  if (typeof NativeES !== 'function') return;
  const P = NativeES.prototype;
  const nClose = P.close;
  const stateGetter = Object.getOwnPropertyDescriptor(P, 'readyState')!.get!;
  const urlGetter = Object.getOwnPropertyDescriptor(P, 'url')?.get;

  /** Conexões reais abertas com OFF. EventSource não tem evento close: filtra por readyState. */
  const live = new Set<EventSource>();

  const ES = function EventSource(this: unknown, url: string | URL, init?: EventSourceInit): EventSource {
    if (!new.target) {
      throw new TypeError("Failed to construct 'EventSource': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    if (arguments.length === 0) {
      throw new TypeError("Failed to construct 'EventSource': 1 argument required, but only 0 present.");
    }
    // eslint-disable-next-line prefer-rest-params
    const args = Array.prototype.slice.call(arguments);

    if (!ctx.getState().enabled) {
      const es: EventSource = Reflect.construct(NativeES, args, new.target);
      live.add(es);
      return es;
    }

    let original: string;
    try { original = new URL(String(url), document.baseURI).href; } catch {
      throw new DOMException(`Failed to construct 'EventSource': Cannot open an EventSource to '${String(url)}'. The URL is invalid.`, 'SyntaxError');
    }
    const stack = ctx.captureStack();
    const es: EventSource = Reflect.construct(NativeES, args.length > 1 ? [ES_PLACEHOLDER, init] : [ES_PLACEHOLDER], new.target);
    Object.defineProperty(es, 'url', { value: original, configurable: true, enumerable: true });
    void emitRecord(ctx, {
      hookId: ctx.newId(), url: original, method: 'GET', headers: [], body: null,
      kind: 'eventsource', held: false, stack,
    });
    return es;
  };

  ctx.onStateChange((s) => {
    if (!s.enabled) return;
    for (const es of [...live]) {
      live.delete(es);
      if (stateGetter.call(es) === NativeES.CLOSED) continue;
      const original = urlGetter ? urlGetter.call(es) : es.url;
      try { nClose.call(es); } catch { /* ignore */ }
      void emitRecord(ctx, {
        hookId: ctx.newId(), url: original, method: 'GET', headers: [], body: null,
        kind: 'eventsource', held: false, stack: '', notes: [CLOSED_BY_INTERCEPTOR],
      });
    }
  });

  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(NativeES))) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue;
    Object.defineProperty(ES, k, d);
  }
  Object.defineProperty(ES, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
  Object.setPrototypeOf(ES, Object.getPrototypeOf(NativeES));
  Object.defineProperty(P, 'constructor', { value: ES, writable: true, enumerable: false, configurable: true });
  disguise(ES, NativeES);

  const desc = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', { ...desc, value: ES });
}
