// Hook de fetch (spec §3.4). Com ON a URL original nunca chega ao fetch nativo
// (exceto em Liberar, Task 8).
import type { HookCtx } from './ctx';
import { disguise, emitRecord, headersToList, isLocalUrl, readRequestBody, resolveUrl } from './common';

/** Request equivalente ao que o fetch nativo montaria, sem consumir o body original:
 *  Request de entrada é clonado; um ReadableStream em init.body não é repassado (seria travado). */
// Referências nativas capturadas na instalação (document_start): a página não consegue trocá-las depois.
const NativeRequest = globalThis.Request;
const NativeReadableStream = globalThis.ReadableStream;

function buildProbe(input: RequestInfo | URL, init: RequestInit | undefined, isReq: boolean): Request {
  const src = isReq ? (input as Request).clone() : input;
  if (init && NativeReadableStream && init.body instanceof NativeReadableStream) {
    const { body: _stream, ...rest } = init as RequestInit & { duplex?: string };
    return new NativeRequest(src, rest);
  }
  return new NativeRequest(src, init);
}

/** Headers que o navegador enviaria: os da aplicação (nome e ordem originais) que o Request
 *  manteve, mais os que ele acrescentou (ex.: Content-Type implícito, com boundary). */
export function sentHeaders(original: Array<[string, string]>, effective: Headers): Array<[string, string]> {
  const kept = original.filter(([k]) => effective.has(k));
  const names = new Set(kept.map(([k]) => k.toLowerCase()));
  const added = [...effective.entries()].filter(([k]) => !names.has(k));
  return [...kept, ...added];
}

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

    // O navegador valida a chamada e define o que seria enviado ao construir o Request:
    // URL normalizada, método, headers sem os proibidos e Content-Type implícito.
    // Chamada inválida: rejeita como o fetch nativo, sem registro (nada seria enviado).
    let probe: Request;
    try {
      probe = buildProbe(input, init, isReq);
    } catch (e) {
      return Promise.reject(e);
    }

    const hookId = ctx.newId();
    const stack = ctx.captureStack();
    const held = state.mode === 'hold';

    const recorded = (async () => {
      const headers = sentHeaders(headersToList(init?.headers ?? (isReq ? (input as Request).headers : undefined)), probe.headers);
      let body: unknown = init?.body ?? null;
      if (init?.body === undefined && isReq) body = await readRequestBody(probe);
      await emitRecord(ctx, { hookId, url: probe.url, method: probe.method, headers, body, kind: 'fetch', held, stack });
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
