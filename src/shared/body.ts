// Serializa o body de uma requisição para CapturedBody (spec §3.5).
// Roda no MAIN world (bundle esbuild) e em Node (testes): só APIs padrão de fetch-body.
import type { CapturedBody } from './types.ts';

export const MAX_TEXT_CHARS = 1048576; // 1 MB
export const PREVIEW_BYTES = 64;

const tag = (x: unknown): string => Object.prototype.toString.call(x);

function toHex(bytes: Uint8Array): string {
  let s = '';
  const n = Math.min(bytes.length, PREVIEW_BYTES);
  for (let i = 0; i < n; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function isJsonType(ct: string | null): boolean {
  return !!ct && ct.toLowerCase().includes('json');
}

function serializeString(s: string, contentType: string | null): CapturedBody {
  const ct = contentType ? contentType.toLowerCase() : '';
  if (s.length > MAX_TEXT_CHARS) {
    const raw = s.slice(0, MAX_TEXT_CHARS);
    const truncated = { originalSize: s.length };
    // Não faz parse de JSON truncado: parsed fica null.
    return isJsonType(contentType)
      ? { type: 'json', raw, parsed: null, truncated }
      : { type: 'text', raw, truncated };
  }
  const t = s.trimStart();
  if (isJsonType(contentType) || t.startsWith('{') || t.startsWith('[')) {
    try {
      return { type: 'json', raw: s, parsed: JSON.parse(s) };
    } catch {
      /* não é JSON válido */
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return { type: 'urlencoded', raw: s, params: [...new URLSearchParams(s)] };
  }
  return { type: 'text', raw: s };
}

function isBlob(x: unknown): x is Blob {
  return typeof Blob !== 'undefined' && x instanceof Blob;
}

async function serializeBlob(b: Blob, contentType: string | null): Promise<CapturedBody> {
  let previewHex = '';
  try {
    previewHex = toHex(new Uint8Array(await b.slice(0, PREVIEW_BYTES).arrayBuffer()));
  } catch {
    /* blob ilegível: preview vazio */
  }
  return { type: 'binary', mime: b.type || contentType || null, size: b.size, previewHex };
}

export async function serializeBody(
  body: BodyInit | Document | null | undefined,
  contentType: string | null,
): Promise<CapturedBody | null> {
  if (body === null || body === undefined) return null;
  try {
    if (typeof body === 'string') return serializeString(body, contentType);

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return { type: 'urlencoded', raw: body.toString(), params: [...body] };
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const fields: Extract<CapturedBody, { type: 'formdata' }>['fields'] = [];
      for (const [name, v] of body) {
        if (typeof v === 'string') fields.push({ name, value: v });
        else {
          const f = v as Blob & { name?: string };
          fields.push({ name, file: { name: f.name ?? 'blob', type: f.type, size: f.size } });
        }
      }
      return { type: 'formdata', fields };
    }

    if (isBlob(body)) return await serializeBlob(body, contentType);

    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
      return { type: 'stream', note: 'ReadableStream não consumido (lê-lo consumiria o stream)' };
    }

    if (ArrayBuffer.isView(body)) {
      const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      return { type: 'binary', mime: contentType, size: body.byteLength, previewHex: toHex(bytes) };
    }

    const t = tag(body);
    if (t === '[object ArrayBuffer]' || t === '[object SharedArrayBuffer]') {
      const buf = body as ArrayBuffer;
      return { type: 'binary', mime: contentType, size: buf.byteLength, previewHex: toHex(new Uint8Array(buf)) };
    }

    if (t === '[object Document]' || t === '[object XMLDocument]' || t === '[object HTMLDocument]') {
      if (typeof XMLSerializer !== 'undefined') {
        return serializeString(new XMLSerializer().serializeToString(body as Node), contentType);
      }
      return { type: 'text', raw: '[Document]' };
    }

    return { type: 'unavailable', reason: `tipo de body não suportado: ${t}` };
  } catch (e) {
    return { type: 'unavailable', reason: `falha ao serializar body: ${String(e)}` };
  }
}
