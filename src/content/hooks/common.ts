// Utilitários compartilhados pelos hooks (MAIN world).
import { serializeBody } from '../../shared/body';
import type { HookRecord, RequestKind } from '../../shared/types';
import type { HookCtx } from './ctx';

// ---- disfarce: funções substitutas se parecem com as nativas ----
const nativeToString = Function.prototype.toString;
const disguised = new WeakMap<Function, Function>();
let guardInstalled = false;

function installToStringGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const toString = function toString(this: Function): string {
    return nativeToString.call(disguised.get(this) ?? this);
  };
  disguised.set(toString, nativeToString);
  Object.defineProperty(Function.prototype, 'toString', { value: toString, writable: true, configurable: true });
}

/** Faz `fake` reportar name/length/toString de `real`. */
export function disguise<T extends Function>(fake: T, real: Function): T {
  installToStringGuard();
  disguised.set(fake, real);
  Object.defineProperty(fake, 'name', { value: real.name, configurable: true });
  Object.defineProperty(fake, 'length', { value: real.length, configurable: true });
  return fake;
}

// ---- normalização ----
/** Esquemas que nunca geram tráfego de rede: passam direto para a API nativa. */
export function isLocalUrl(url: string): boolean {
  return /^(data|blob|about|chrome-extension|javascript):/i.test(url);
}

export function resolveUrl(u: unknown): string {
  try { return new URL(String(u), document.baseURI).href; } catch { return String(u); }
}

/** Preserva nomes/ordem originais quando possível (Headers normaliza para minúsculas). */
export function headersToList(h: HeadersInit | undefined | null): Array<[string, string]> {
  if (!h) return [];
  if (typeof Headers !== 'undefined' && h instanceof Headers) return [...h.entries()];
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)] as [string, string]);
  return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)] as [string, string]);
}

export function findHeader(list: Array<[string, string]>, name: string): string | null {
  const hit = list.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : null;
}

/** Content-Type que o navegador derivaria do body quando a aplicação não define um. */
export function implicitContentType(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return 'text/plain;charset=UTF-8';
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return 'application/x-www-form-urlencoded;charset=UTF-8';
  if (typeof FormData !== 'undefined' && body instanceof FormData) return 'multipart/form-data';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.type || null;
  return null;
}

/** Lê o body de um Request sem consumir o original. Texto UTF-8 válido vira string. */
export async function readRequestBody(req: Request): Promise<string | ArrayBuffer | null> {
  if (req.method === 'GET' || req.method === 'HEAD' || req.body === null) return null;
  const buf = await req.clone().arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return buf; }
}

export interface RecordInput {
  hookId: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  /** Body ou promessa dele (ex.: leitura assíncrona de um Request). */
  body: unknown;
  kind: RequestKind;
  held: boolean;
  stack: string;
  notes?: string[];
}

/** Envios saem na ordem das chamadas da aplicação, mesmo que um body demore a ser lido. */
let ordered: Promise<unknown> = Promise.resolve();

/** Serializa e envia o registro para a ponte. Chamar de forma síncrona no hook: o horário
 *  e a ordem são os da chamada da aplicação. Nunca rejeita. */
export function emitRecord(ctx: HookCtx, input: RecordInput): Promise<void> {
  const timestamp = new Date().toISOString();
  const frameUrl = location.href;
  const built = (async (): Promise<HookRecord> => {
    let body: HookRecord['body'] = null;
    try {
      const raw = await input.body;
      const ct = findHeader(input.headers, 'content-type') ?? implicitContentType(raw);
      body = await serializeBody(raw as any, ct);
    } catch (e) {
      body = { type: 'unavailable', reason: `falha ao ler o body: ${(e as Error).message}` };
    }
    return {
      hookId: input.hookId,
      url: input.url,
      method: input.method.toUpperCase(),
      headers: input.headers,
      body,
      kind: input.kind,
      held: input.held,
      frameUrl,
      stack: input.stack,
      timestamp,
      notes: input.notes,
    };
  })();
  const sent = ordered.then(() => built).then((record) => { ctx.emit({ type: 'hookRecord', record }); }, () => {});
  ordered = sent;
  return sent;
}
