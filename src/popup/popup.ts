// Popup: liga/desliga, modo, limite, status fail-safe, contadores e atalhos.
import type { ExtState, Mode } from '../shared/types';
import { connectUi, el, send } from '../ui/client';
import { renderTabNote } from '../ui/tab-note';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toggle = $<HTMLInputElement>('ni-toggle');
const statusBox = $<HTMLElement>('ni-status');
const reasons = $<HTMLUListElement>('ni-reasons');
const warnings = $<HTMLUListElement>('ni-warnings');
const mode = $<HTMLSelectElement>('ni-mode');
const limit = $<HTMLInputElement>('ni-limit');
const count = $<HTMLElement>('ni-count');
const held = $<HTMLElement>('ni-held');
const msg = $<HTMLElement>('ni-msg');
const tabNote = $<HTMLElement>('ni-tab-note');

/** Aba alvo: ?tabId=N (popup aberto como página) ou a aba ativa da janela. */
let targetTab: number | undefined;
const tabReady: Promise<void> = (async () => {
  const fromQuery = Number(new URLSearchParams(location.search).get('tabId'));
  if (Number.isInteger(fromQuery) && fromQuery > 0) { targetTab = fromQuery; return; }
  try { [{ id: targetTab }] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { /* sem aba */ }
})();

const LABELS = {
  OFF: ['DESLIGADO', 'Requisições passam normalmente.'],
  ACTIVATING: ['ATIVANDO', 'Instalando e verificando o bloqueio…'],
  PROTECTED: ['PROTEGIDO', 'MODO INTERCEPTAÇÃO ATIVO'],
  INCOMPLETE: ['PROTEÇÃO INCOMPLETA', 'Alguma verificação falhou — não confie no bloqueio.'],
} as const;

let busy = false;
let lastLimit = '';

function render(s: ExtState): void {
  if (!busy) toggle.checked = s.enabled;
  const [title, sub] = LABELS[s.status];
  statusBox.className = `ni-status ni-status-${s.status}`;
  statusBox.replaceChildren(el('strong', null, title), el('span', null, sub));
  reasons.replaceChildren(...s.reasons.map((r) => el('li', null, r)));
  reasons.hidden = !s.reasons.length;
  warnings.replaceChildren(...s.warnings.map((w) => el('li', null, w)));
  warnings.hidden = !s.warnings.length;
  if (document.activeElement !== mode) mode.value = s.mode;
  if (document.activeElement !== limit) { limit.value = String(s.limit); lastLimit = limit.value; }
  count.textContent = String(s.count);
  held.textContent = String(s.heldCount);
  void tabReady.then(() => renderTabNote(tabNote, s, targetTab));
}

function fail(e: unknown): void { msg.textContent = `erro: ${(e as Error)?.message ?? e}`; }

toggle.addEventListener('change', async () => {
  busy = true;
  toggle.disabled = true;
  try { render(await send<ExtState>({ type: 'setEnabled', enabled: toggle.checked })); } catch (e) { fail(e); }
  busy = false;
  toggle.disabled = false;
  try { render(await send<ExtState>({ type: 'getState' })); } catch { /* port atualiza */ }
});

mode.addEventListener('change', async () => {
  try { render(await send<ExtState>({ type: 'setMode', mode: mode.value as Mode })); } catch (e) { fail(e); }
});

async function applyLimit(): Promise<void> {
  if (limit.value === lastLimit) return;
  lastLimit = limit.value;
  try { render(await send<ExtState>({ type: 'setLimit', limit: Number(limit.value) })); } catch (e) { fail(e); }
}
limit.addEventListener('change', applyLimit);
limit.addEventListener('keydown', (e) => { if (e.key === 'Enter') void applyLimit(); });

$('ni-clear').addEventListener('click', async () => {
  try { await send({ type: 'clear' }); render(await send<ExtState>({ type: 'getState' })); } catch (e) { fail(e); }
});
$('ni-open-viewer').addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

// Abrir o popup roda as verificações de status (§3.7); depois o port mantém ao vivo.
send<ExtState>({ type: 'getState' }).then(render, fail);
connectUi({ onState: render });
