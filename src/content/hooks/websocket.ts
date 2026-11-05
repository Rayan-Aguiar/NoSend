// Hook de WebSocket (spec §3.4). Sem Segurar: com ON, o socket é genuíno mas aponta
// para um placeholder não roteável; a URL original nunca chega à API nativa.
import type { HookCtx } from './ctx';
import { disguise, emitRecord } from './common';

/** Sempre wss: ws:// em página HTTPS lança SecurityError (mixed content). */
export const WS_PLACEHOLDER = 'wss://blocked.invalid/';
export const CLOSED_BY_INTERCEPTOR = 'conexão aberta antes do ON encerrada pelo interceptor';

/** Resolve como o navegador: relativa ao baseURI, http(s) -> ws(s), sem fragmento. */
export function resolveWsUrl(u: unknown, base: string): string {
  let url: URL;
  try { url = new URL(String(u), base); } catch {
    throw new DOMException(`Failed to construct 'WebSocket': The URL '${String(u)}' is invalid.`, 'SyntaxError');
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new DOMException(
      `Failed to construct 'WebSocket': The URL's scheme must be either 'http', 'https', 'ws', or 'wss'. '${url.protocol.slice(0, -1)}' is not allowed.`,
      'SyntaxError');
  }
  if (url.hash) {
    throw new DOMException(
      `Failed to construct 'WebSocket': The URL contains a fragment identifier ('${url.hash.slice(1)}'). Fragment identifiers are not allowed in WebSocket URLs.`,
      'SyntaxError');
  }
  return url.href;
}

export function installWebSocketHook(ctx: HookCtx): void {
  const NativeWS = globalThis.WebSocket;
  if (typeof NativeWS !== 'function') return;
  const P = NativeWS.prototype;
  const nSend = P.send;
  const nClose = P.close;
  const nAddListener = EventTarget.prototype.addEventListener;
  const urlGetter = Object.getOwnPropertyDescriptor(P, 'url')?.get;
  const stateGetter = Object.getOwnPropertyDescriptor(P, 'readyState')!.get!;

  /** Sockets cuja rede está cortada (placeholder ou fechado pelo interceptor) -> URL original. */
  const blocked = new WeakMap<WebSocket, string>();
  /** Conexões reais abertas com OFF. */
  const live = new Set<WebSocket>();

  const WS = function WebSocket(this: unknown, url: string | URL, protocols?: string | string[]): WebSocket {
    if (!new.target) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    if (arguments.length === 0) {
      throw new TypeError("Failed to construct 'WebSocket': 1 argument required, but only 0 present.");
    }
    // eslint-disable-next-line prefer-rest-params
    const args = Array.prototype.slice.call(arguments);

    if (!ctx.getState().enabled) {
      const ws: WebSocket = Reflect.construct(NativeWS, args, new.target);
      live.add(ws);
      nAddListener.call(ws, 'close', () => live.delete(ws));
      return ws;
    }

    const original = resolveWsUrl(url, document.baseURI);
    const stack = ctx.captureStack();
    // protocols inválidos lançam aqui, como no nativo, antes de qualquer registro.
    const ws: WebSocket = Reflect.construct(NativeWS, args.length > 1 ? [WS_PLACEHOLDER, protocols] : [WS_PLACEHOLDER], new.target);
    Object.defineProperty(ws, 'url', { value: original, configurable: true, enumerable: true });
    blocked.set(ws, original);
    void emitRecord(ctx, {
      hookId: ctx.newId(), url: original, method: 'GET', headers: [], body: null,
      kind: 'websocket', held: false, stack,
    });
    return ws;
  };

  const send = function send(this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    const original = blocked.get(this);
    if (original !== undefined && arguments.length > 0) {
      void emitRecord(ctx, {
        hookId: ctx.newId(), url: original, method: 'SEND', headers: [], body: data,
        kind: 'websocket-message', held: false, stack: ctx.captureStack(),
      });
    }
    // Socket bloqueado nunca está OPEN (placeholder não conecta; fechado pelo interceptor está
    // CLOSING/CLOSED): o nativo lança InvalidStateError ou descarta, sem tocar a rede.
    // eslint-disable-next-line prefer-rest-params
    return nSend.apply(this, arguments as any);
  };

  // Ao ligar: encerra conexões reais já abertas.
  ctx.onStateChange((s) => {
    if (!s.enabled) return;
    for (const ws of [...live]) {
      live.delete(ws);
      const state = stateGetter.call(ws);
      if (state === NativeWS.CLOSING || state === NativeWS.CLOSED) continue;
      const original = urlGetter ? urlGetter.call(ws) : ws.url;
      blocked.set(ws, original);
      try { nClose.call(ws); } catch { /* já fechando */ }
      void emitRecord(ctx, {
        hookId: ctx.newId(), url: original, method: 'GET', headers: [], body: null,
        kind: 'websocket', held: false, stack: '', notes: [CLOSED_BY_INTERCEPTOR],
      });
    }
  });

  // Fidelidade: mesmo protótipo, constantes estáticas, herança de EventTarget, name/length/toString.
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(NativeWS))) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue;
    Object.defineProperty(WS, k, d);
  }
  Object.defineProperty(WS, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
  Object.setPrototypeOf(WS, Object.getPrototypeOf(NativeWS));
  Object.defineProperty(P, 'constructor', { value: WS, writable: true, enumerable: false, configurable: true });
  disguise(WS, NativeWS);
  P.send = disguise(send, nSend);

  const desc = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { ...desc, value: WS });
}
