// Gera comando cURL equivalente a um registro.
import type { InterceptedRequest } from './types.ts';

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
/** Comentários nunca podem quebrar linha (um \n viraria um comando no shell). */
/** Método HTTP válido (token RFC 9110) sai sem aspas; qualquer outra coisa é citada. */
const method = (m: string): string => (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(m) && !m.includes("'") ? m : q(m));
const c = (s: string | number): string => String(s).replace(/[\r\n]+/g, ' ');

export function toCurl(r: InterceptedRequest): string {
  const comments: string[] = [];
  const parts: string[] = [`curl -X ${method(r.method)} ${q(r.url)}`];
  for (const [k, v] of r.headers) parts.push(`-H ${q(`${k}: ${v}`)}`);

  const b = r.body;
  if (b) {
    switch (b.type) {
      case 'json':
      case 'text':
        if (b.truncated) comments.push(`# body truncado (tamanho original ${c(b.truncated.originalSize)} caracteres)`);
        parts.push(`--data-raw ${q(b.raw)}`);
        break;
      case 'urlencoded':
        parts.push(`--data-raw ${q(b.raw)}`);
        break;
      case 'formdata':
        for (const f of b.fields) {
          if ('value' in f) {
            // --form-string: curl não interpreta @arquivo, <arquivo nem ;type=
            const flag = /[@<;]/.test(`${f.name}=${f.value}`) ? '--form-string' : '-F';
            parts.push(`${flag} ${q(`${f.name}=${f.value}`)}`);
          } else {
            // Nunca @<nome vindo da página>: o curl leria e enviaria um arquivo local.
            comments.push(`# arquivo ${c(JSON.stringify(f.file.name))} (${c(f.file.type || 'tipo desconhecido')}, ${c(f.file.size)} bytes): substitua ARQUIVO_AQUI pelo caminho`);
            parts.push(`-F ${q(`${f.name}=@ARQUIVO_AQUI`)}`);
          }
        }
        break;
      case 'binary':
        comments.push(`# body binário (${c(b.size)} bytes) omitido`);
        break;
      case 'stream':
        comments.push('# body ReadableStream não capturado');
        break;
      case 'unavailable':
        comments.push(`# body indisponível: ${c(b.reason)}`);
        break;
    }
  }
  const cmd = parts.join(' \\\n  ');
  return comments.length ? `${comments.join('\n')}\n${cmd}` : cmd;
}
