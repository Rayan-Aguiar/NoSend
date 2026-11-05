// Hook de XMLHttpRequest (spec §3.4).
import type { HookCtx } from './ctx';
import { disguise, emitRecord, resolveUrl } from './common';

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

  /** Falha de rede como o navegador reporta: readyState 4, status 0, error + loadend. */
  function failAsync(xhr: XMLHttpRequest): void {
    const values = { readyState: 4, status: 0, statusText: '', response: '', responseText: '', responseURL: '' };
    for (const [k, v] of Object.entries(values)) Object.defineProperty(xhr, k, { value: v, configurable: true });
    setTimeout(() => {
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new ProgressEvent('error'));
      xhr.dispatchEvent(new ProgressEvent('loadend'));
    }, 0);
  }

  const send = function send(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const state = ctx.getState();
    const m = meta.get(this);
    // eslint-disable-next-line prefer-rest-params
    if (!state.enabled || !m) return nSend.apply(this, arguments as any);

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
    if (held) {
      const xhr = this;
      ctx.registerHeld(hookId, () => {
        xhr.addEventListener('loadend', () => {
          ctx.emit({ type: 'heldOutcome', hookId, ok: xhr.status > 0, status: xhr.status, error: xhr.status > 0 ? undefined : 'falha de rede' });
        }, { once: true });
        nSend.call(xhr, body);
      }, () => failAsync(xhr));
      return;
    }
    failAsync(this);
  };

  P.open = disguise(open, nOpen) as typeof P.open;
  P.setRequestHeader = disguise(setRequestHeader, nSetHeader);
  P.send = disguise(send, nSend);
}
