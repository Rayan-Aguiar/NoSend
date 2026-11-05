// Hook de XMLHttpRequest (spec §3.4).
import type { HookCtx } from './ctx';
import { disguise, emitRecord, isLocalUrl, resolveUrl } from './common';

interface XhrMeta { method: string; url: string; async: boolean; headers: Array<[string, string]> }

const FAKE_PROPS = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL'] as const;

export function installXhrHook(ctx: HookCtx): void {
  const P = XMLHttpRequest.prototype;
  const nOpen = P.open;
  const nSetHeader = P.setRequestHeader;
  const nSend = P.send;
  const meta = new WeakMap<XMLHttpRequest, XhrMeta>();

  const open = function open(this: XMLHttpRequest, method: string, url: string | URL, async?: boolean) {
    for (const p of FAKE_PROPS) delete (this as any)[p]; // limpa falha simulada anterior
    meta.set(this, {
      method: String(method).toUpperCase(),
      url: resolveUrl(url),
      async: arguments.length < 3 ? true : !!async,
      headers: [],
    });
    // eslint-disable-next-line prefer-rest-params
    return nOpen.apply(this, arguments as any);
  };

  const setRequestHeader = function setRequestHeader(this: XMLHttpRequest, name: string, value: string) {
    meta.get(this)?.headers.push([String(name), String(value)]);
    return nSetHeader.call(this, name, value);
  };

  /** loadstart como o send() nativo dispara: síncrono, com readyState 1. */
  function fireLoadstart(xhr: XMLHttpRequest): void {
    xhr.dispatchEvent(new ProgressEvent('loadstart'));
  }

  /** Falha de rede como o navegador reporta, em outra tarefa: readyState 4, status 0,
   *  readystatechange, error, loadend. O loadstart já foi disparado no send(). */
  function failAsync(xhr: XMLHttpRequest): void {
    setTimeout(() => {
      const values = { readyState: 4, status: 0, statusText: '', response: '', responseText: '', responseURL: '' };
      for (const [k, v] of Object.entries(values)) Object.defineProperty(xhr, k, { value: v, configurable: true });
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('error'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
    }, 0);
  }

  // ---- portão de loadstart ----
  // Segurar dispara o loadstart no send() (como o nativo). Ao Liberar, o send() nativo dispara
  // outro, que a aplicação não pode ver. O Chrome chama os listeners do alvo na ordem de registro
  // (captura não passa à frente), então o portão é registrado na construção, antes de qualquer
  // listener da aplicação, e só barra eventos durante a chamada nativa da liberação.
  const nAddListener = EventTarget.prototype.addEventListener;
  const releasing = new WeakSet<XMLHttpRequest>();
  const gate = (e: Event) => { if (releasing.has(e.currentTarget as XMLHttpRequest)) e.stopImmediatePropagation(); };

  /** send() nativo da liberação sem repetir o loadstart que a aplicação já recebeu. */
  function releaseSend(xhr: XMLHttpRequest, body: unknown): void {
    releasing.add(xhr);
    try { nSend.call(xhr, body as any); } finally { releasing.delete(xhr); }
  }

  const NativeXHR = XMLHttpRequest;
  const XHR = function XMLHttpRequest(this: unknown): XMLHttpRequest {
    if (!new.target) {
      throw new TypeError("Failed to construct 'XMLHttpRequest': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
    }
    const xhr: XMLHttpRequest = Reflect.construct(NativeXHR, [], new.target);
    nAddListener.call(xhr, 'loadstart', gate);
    return xhr;
  };
  // Fidelidade: mesmo protótipo, constantes estáticas, herança, name/length/toString.
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(NativeXHR))) {
    if (k === 'prototype' || k === 'name' || k === 'length') continue;
    Object.defineProperty(XHR, k, d);
  }
  Object.defineProperty(XHR, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
  Object.setPrototypeOf(XHR, Object.getPrototypeOf(NativeXHR));
  Object.defineProperty(P, 'constructor', { value: XHR, writable: true, enumerable: false, configurable: true });
  disguise(XHR, NativeXHR);
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { ...desc, value: XHR });

  const send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = ctx.getState();
    const m = meta.get(this);
    // eslint-disable-next-line prefer-rest-params
    if (!state.enabled || !m || isLocalUrl(m.url)) return nSend.apply(this, arguments as any);

    const hookId = ctx.newId();
    const held = state.mode === 'hold' && m.async;
    void emitRecord(ctx, {
      hookId, url: m.url, method: m.method, headers: m.headers,
      body: m.method === 'GET' || m.method === 'HEAD' ? null : body ?? null,
      kind: 'xhr', held, stack: ctx.captureStack(),
      notes: m.async ? undefined : ['XHR síncrono: não pode ser segurado'],
    });

    if (!m.async) {
      throw new DOMException(`Failed to execute 'send' on 'XMLHttpRequest': Failed to load '${m.url}'.`, 'NetworkError');
    }
    fireLoadstart(this);
    if (held) {
      // Segurado: loadstart já disparado (como no nativo); nada mais até a decisão.
      const xhr = this;
      ctx.registerHeld(hookId, () => {
        xhr.addEventListener('loadend', () => {
          ctx.emit({ type: 'heldOutcome', hookId, ok: xhr.status > 0, status: xhr.status, error: xhr.status > 0 ? undefined : 'falha de rede' });
        }, { once: true });
        releaseSend(xhr, body);
      }, () => failAsync(xhr));
      return;
    }
    failAsync(this);
  };

  P.open = disguise(open, nOpen) as typeof P.open;
  P.setRequestHeader = disguise(setRequestHeader, nSetHeader);
  P.send = disguise(send, nSend);
}
