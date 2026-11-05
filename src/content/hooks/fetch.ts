// Hook de fetch (spec §3.4). Com ON a URL original nunca chega ao fetch nativo
// (exceto em Liberar, Task 8).
import type { HookCtx } from './ctx';
import { disguise, emitRecord, headersToList, isLocalUrl, readRequestBody, resolveUrl } from './common';

export function networkError(): TypeError {
  return new TypeError('Failed to fetch');
}

export function installFetchHook(ctx: HookCtx): void {
  const nativeFetch = window.fetch;

  const hooked = function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const state = ctx.getState();
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    if (!state.enabled || isLocalUrl(resolveUrl(isReq ? (input as Request).url : input))) {
      // eslint-disable-next-line prefer-rest-params
      return nativeFetch.apply(this as any, arguments as any);
    }

    const hookId = ctx.newId();
    const stack = ctx.captureStack();
    const held = state.mode === 'hold';

    const recorded = (async () => {
      const url = resolveUrl(isReq ? (input as Request).url : input);
      const method = (init?.method ?? (isReq ? (input as Request).method : 'GET')).toUpperCase();
      const headers = headersToList(init?.headers ?? (isReq ? (input as Request).headers : undefined));
      let body: unknown = init?.body ?? null;
      if (init?.body === undefined && isReq) body = await readRequestBody(input as Request);
      await emitRecord(ctx, { hookId, url, method, headers, body, kind: 'fetch', held, stack });
    })().catch(() => {});

    if (held) {
      return new Promise<Response>((resolve, reject) => {
        ctx.registerHeld(
          hookId,
          () => {
            nativeFetch.call(window, input, init).then(
              (r) => { ctx.emit({ type: 'heldOutcome', hookId, ok: true, status: r.status }); resolve(r); },
              (e) => { ctx.emit({ type: 'heldOutcome', hookId, ok: false, error: String((e as Error)?.message ?? e) }); reject(e); },
            );
          },
          () => reject(networkError()),
        );
      });
    }
    return recorded.then(() => Promise.reject(networkError()));
  };

  window.fetch = disguise(hooked, nativeFetch) as typeof fetch;
}
