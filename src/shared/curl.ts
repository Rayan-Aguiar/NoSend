// Gera comando cURL equivalente a um registro.
import type { InterceptedRequest } from './types.ts';

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(r: InterceptedRequest): string {
  const comments: string[] = [];
  const parts: string[] = [`curl -X ${r.method.toUpperCase()} ${q(r.url)}`];
  for (const [k, v] of r.headers) parts.push(`-H ${q(`${k}: ${v}`)}`);

  const b = r.body;
  if (b) {
    switch (b.type) {
      case 'json':
      case 'text':
        if (b.truncated) comments.push(`# body truncado (tamanho original ${b.truncated.originalSize} caracteres)`);
        parts.push(`--data-raw ${q(b.raw)}`);
        break;
      case 'urlencoded':
        parts.push(`--data-raw ${q(b.raw)}`);
        break;
      case 'formdata':
        for (const f of b.fields) {
          if ('value' in f) {
            // --form-string evita que curl interprete valores começando com @ ou <
            const flag = /^[@<]/.test(f.value) ? '--form-string' : '-F';
            parts.push(`${flag} ${q(`${f.name}=${f.value}`)}`);
          } else {
            parts.push(`-F ${q(`${f.name}=@${f.file.name}`)}`);
          }
        }
        break;
      case 'binary':
        comments.push(`# body binário (${b.size} bytes) omitido`);
        break;
      case 'stream':
        comments.push('# body ReadableStream não capturado');
        break;
      case 'unavailable':
        comments.push(`# body indisponível: ${b.reason}`);
        break;
    }
  }
  const cmd = parts.join(' \\\n  ');
  return comments.length ? `${comments.join('\n')}\n${cmd}` : cmd;
}
