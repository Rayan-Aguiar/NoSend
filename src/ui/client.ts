// Utilitários das páginas de UI: mensagens ao background, port ao vivo, DOM seguro, clipboard.
import { UI_PORT, type BgRequest } from '../shared/messages';
import type { ExtState, InterceptedRequest } from '../shared/types';

export function send<T = any>(req: BgRequest): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>;
}

export interface UiHandlers {
  onState?: (s: ExtState) => void;
  onRecords?: (r: InterceptedRequest[]) => void;
}

/**
 * Conecta ao port 'ni-ui'. O background posta estado e registros ao conectar e a cada mudança.
 * O service worker pode ser encerrado (idle) e derrubar o port: reconecta sozinho.
 */
export function connectUi(h: UiHandlers): void {
  const connect = () => {
    let port: chrome.runtime.Port;
    try { port = chrome.runtime.connect({ name: UI_PORT }); } catch { setTimeout(connect, 1000); return; }
    port.onMessage.addListener((m: any) => {
      if (m?.type === 'state') h.onState?.(m.state);
      else if (m?.type === 'records') h.onRecords?.(m.records);
    });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; setTimeout(connect, 300); });
  };
  connect();
}

type Child = Node | string | null | undefined | false;

/** Cria elemento; texto entra sempre via textContent/Text nodes (nunca innerHTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; id?: string; title?: string; attrs?: Record<string, string> } | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props?.class) e.className = props.class;
  if (props?.id) e.id = props.id;
  if (props?.title) e.title = props.title;
  if (props?.attrs) for (const [k, v] of Object.entries(props.attrs)) e.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

/** Copia texto: Clipboard API, com fallback para execCommand (ex.: painel DevTools). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* fallback abaixo */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('cópia não permitida');
}

/** HH:MM:SS.mmm no horário local. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
