// Componente lista + detalhe, compartilhado pelo painel DevTools e pelo visualizador.
// Dados capturados são da página (não confiáveis): renderização só com textContent / Text nodes.
import type { BgRequest } from '../shared/messages';
import type { CapturedBody, InterceptedRequest, RecordStatus, RequestKind } from '../shared/types';
import { toCurl } from '../shared/curl';
import { canRelease } from '../shared/regex';
import { connectUi, copyText, el, fmtTime } from './client';

export interface ListDetailOptions {
  tabId?: number;
  send: (r: BgRequest) => Promise<any>;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const KINDS: RequestKind[] = [
  'fetch', 'xhr', 'beacon', 'websocket', 'websocket-message', 'eventsource', 'main_frame', 'sub_frame',
  'form', 'image', 'script', 'stylesheet', 'font', 'media', 'worker', 'ping', 'csp_report', 'webtransport', 'other',
];
const STATUSES: RecordStatus[] = ['BLOCKED', 'HELD', 'RELEASED', 'DISCARDED', 'DISCARDED_PAGE_GONE'];

function select(id: string, label: string, values: string[]): HTMLSelectElement {
  const s = el('select', { id, title: label, attrs: { 'aria-label': label } }, el('option', { attrs: { value: '' } }, `${label}: todos`));
  for (const v of values) s.append(el('option', { attrs: { value: v } }, v));
  return s;
}

function kv(rows: Array<[string, string]>, cls: string): HTMLElement {
  if (!rows.length) return el('p', { class: `ni-empty ${cls}` }, '(nenhum)');
  const t = el('table', { class: `ni-kv ${cls}` });
  for (const [k, v] of rows) t.append(el('tr', null, el('th', null, k), el('td', null, v)));
  return t;
}

/** Texto interpretado e texto original (quando existe) de um body. */
function bodyViews(b: CapturedBody | null): { pretty: string; raw: string | null; note?: string } {
  if (!b) return { pretty: '(sem body)', raw: null };
  const trunc = (t?: { originalSize: number }) => (t ? `truncado — tamanho original ${t.originalSize} caracteres` : undefined);
  switch (b.type) {
    case 'json': {
      let pretty = b.raw;
      try { pretty = JSON.stringify(b.parsed, null, 2); } catch { /* mantém raw */ }
      return { pretty, raw: b.raw, note: trunc(b.truncated) };
    }
    case 'text':
      return { pretty: b.raw, raw: null, note: trunc(b.truncated) };
    case 'urlencoded':
      return { pretty: b.params.map(([k, v]) => `${k} = ${v}`).join('\n') || '(vazio)', raw: b.raw };
    case 'formdata':
      return {
        pretty: b.fields.map((f) => ('value' in f
          ? `${f.name} = ${f.value}`
          : `${f.name} = [arquivo] ${f.file.name} (${f.file.type || 'sem tipo'}, ${f.file.size} bytes)`)).join('\n') || '(vazio)',
        raw: null,
      };
    case 'binary':
      return { pretty: `binário — ${b.mime ?? 'tipo desconhecido'}, ${b.size} bytes\nprimeiros bytes (hex): ${b.previewHex}`, raw: null };
    case 'stream':
      return { pretty: `stream não capturado: ${b.note}`, raw: null };
    case 'unavailable':
      return { pretty: `indisponível: ${b.reason}`, raw: null };
  }
}

export function mountListDetail(root: HTMLElement, opts: ListDetailOptions): void {
  let records: InterceptedRequest[] = [];
  let selectedId: string | null = null;
  let selectedSig = '';
  let showRaw = false;

  // ---- toolbar ----
  const fText = el('input', { id: 'ni-f-text', attrs: { type: 'search', placeholder: 'Filtrar URL', 'aria-label': 'Filtrar URL' } });
  const fMethod = select('ni-f-method', 'Método', METHODS);
  const fKind = select('ni-f-kind', 'Tipo', KINDS);
  const fStatus = select('ni-f-status', 'Status', STATUSES);
  const fTab = el('input', { id: 'ni-f-tab', attrs: { type: 'checkbox' } });
  fTab.checked = true;
  const count = el('span', { class: 'ni-count', id: 'ni-list-count' }, '0');
  const toolbar = el('div', { class: 'ni-toolbar' }, fText, fMethod, fKind, fStatus,
    opts.tabId !== undefined && el('label', { class: 'ni-check' }, fTab, ' só esta aba'),
    el('span', { class: 'ni-spacer' }), count);

  // ---- lista ----
  const tbody = el('tbody');
  const table = el('table', { id: 'ni-list', class: 'ni-list' },
    el('thead', null, el('tr', null, ...['Método', 'URL', 'Horário', 'Tipo', 'Content-Type', 'Status'].map((h) => el('th', null, h)))),
    tbody);
  const listWrap = el('div', { class: 'ni-list-wrap' }, table);
  const detail = el('div', { id: 'ni-detail', class: 'ni-detail' });

  root.replaceChildren(toolbar, el('div', { class: 'ni-split' }, listWrap, detail));

  const visible = (): InterceptedRequest[] => {
    const q = fText.value.trim().toLowerCase();
    return records.filter((r) =>
      (!q || r.url.toLowerCase().includes(q))
      && (!fMethod.value || r.method === fMethod.value)
      && (!fKind.value || r.kind === fKind.value)
      && (!fStatus.value || r.status === fStatus.value)
      && (opts.tabId === undefined || !fTab.checked || r.origin.tabId === opts.tabId));
  };

  const renderList = () => {
    const rows = visible();
    const frag = document.createDocumentFragment();
    // Mais recentes primeiro.
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const tr = el('tr', { class: `ni-row ni-st-${r.status}${r.id === selectedId ? ' ni-selected' : ''}`, attrs: { 'data-id': r.id } },
        el('td', { class: 'ni-method' }, r.method),
        el('td', { class: 'ni-url', title: r.url }, r.url),
        el('td', { class: 'ni-time' }, fmtTime(r.timestamp)),
        el('td', null, r.kind),
        el('td', null, r.contentType ?? ''),
        el('td', { class: 'ni-rstatus' }, r.status));
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
    count.textContent = rows.length === records.length ? `${rows.length}` : `${rows.length} de ${records.length}`;
  };

  const sigOf = (r: InterceptedRequest | undefined) => (r ? `${r.id}|${r.status}|${JSON.stringify(r.releaseResult ?? null)}` : '');

  const renderDetail = () => {
    const r = records.find((x) => x.id === selectedId);
    selectedSig = sigOf(r);
    if (!r) {
      detail.replaceChildren(el('p', { class: 'ni-empty' }, 'Selecione uma requisição.'));
      return;
    }
    const msg = el('span', { class: 'ni-msg', attrs: { role: 'status' } });
    const say = (t: string) => { msg.textContent = t; };

    const copyBtn = el('button', { class: 'ni-copy' }, 'Copiar cURL');
    copyBtn.addEventListener('click', async () => {
      try { await copyText(toCurl(r)); say('cURL copiado'); } catch (e) { say(`falha ao copiar: ${(e as Error).message}`); }
    });
    const actions = el('div', { class: 'ni-actions' }, copyBtn);
    if (r.status === 'HELD' && r.source === 'hook') {
      const releasable = canRelease(r.url);
      const rel = el('button', { class: 'ni-release ni-danger', title: releasable ? 'Envia esta requisição uma vez' : 'URL longa demais para uma exceção DNR exata' }, 'Liberar');
      rel.disabled = !releasable;
      const dis = el('button', { class: 'ni-discard' }, 'Descartar');
      const act = async (req: BgRequest, label: string) => {
        rel.disabled = dis.disabled = true;
        try {
          const res = await opts.send(req);
          if (!res?.ok) say(`${label} falhou${res?.reason ? `: ${res.reason}` : ''}`);
        } catch (e) { say(`${label} falhou: ${(e as Error).message}`); }
        rel.disabled = !releasable; dis.disabled = false;
      };
      rel.addEventListener('click', () => act({ type: 'release', id: r.id }, 'Liberar'));
      dis.addEventListener('click', () => act({ type: 'discard', id: r.id }, 'Descartar'));
      actions.append(rel, dis);
    }
    actions.append(msg);

    const general: Array<[string, string]> = [
      ['URL', r.url], ['Método', r.method], ['Horário', `${fmtTime(r.timestamp)} (${r.timestamp})`],
      ['Status', r.status], ['Tipo', r.kind], ['Captura', r.source === 'hook' ? 'hook (página)' : 'DNR (fallback)'],
      ['Content-Type', r.contentType ?? '—'],
    ];
    if (r.releaseResult) {
      const rr = r.releaseResult;
      general.push(['Resultado da liberação', rr.ok ? `ok${rr.status !== undefined ? ` — HTTP ${rr.status}` : ''}` : `erro${rr.status !== undefined ? ` — HTTP ${rr.status}` : ''}${rr.error ? `: ${rr.error}` : ''}`]);
    }
    if (r.incognito) general.push(['Anônima', 'sim (só em memória)']);

    const views = bodyViews(r.body);
    const payload = el('pre', { class: 'ni-payload' });
    const toggle = el('button', { class: 'ni-raw-toggle ni-link' });
    const paintPayload = () => {
      const raw = showRaw && views.raw !== null;
      payload.textContent = raw ? views.raw! : views.pretty;
      toggle.textContent = raw ? 'ver interpretado' : 'ver original';
    };
    toggle.addEventListener('click', () => { showRaw = !showRaw; paintPayload(); });
    paintPayload();

    const o = r.origin;
    const origin: Array<[string, string]> = [['Aba', o.tabId < 0 ? 'sem aba (worker)' : String(o.tabId)]];
    if (o.frameId !== undefined) origin.push(['Frame', String(o.frameId)]);
    if (o.frameUrl) origin.push(['URL do frame', o.frameUrl]);
    if (o.documentUrl) origin.push(['Documento', o.documentUrl]);
    if (o.initiator) origin.push(['Initiator', o.initiator]);

    const section = (title: string, ...body: Child[]) => el('section', null, el('h3', null, title), ...body);
    detail.replaceChildren(
      actions,
      section('General', kv(general, 'ni-general')),
      section('Request Headers', kv(r.headers, 'ni-headers')),
      section('Query Parameters', kv(r.query, 'ni-query')),
      section('Request Payload', views.raw !== null && toggle, views.note && el('p', { class: 'ni-note' }, views.note), payload),
      section('Origem', kv(origin, 'ni-origin'), o.stack && el('pre', { class: 'ni-stack' }, o.stack)),
      section('Notas', r.notes.length ? el('ul', { class: 'ni-notes' }, ...r.notes.map((n) => el('li', null, n))) : el('p', { class: 'ni-empty' }, '(nenhuma)')),
    );
  };

  tbody.addEventListener('click', (ev) => {
    const tr = (ev.target as HTMLElement).closest('tr');
    const id = tr?.getAttribute('data-id');
    if (!id || id === selectedId) return;
    selectedId = id;
    showRaw = false;
    for (const s of tbody.querySelectorAll('.ni-selected')) s.classList.remove('ni-selected');
    tr!.classList.add('ni-selected');
    renderDetail();
  });

  for (const f of [fText, fMethod, fKind, fStatus, fTab]) f.addEventListener('input', renderList);

  renderList();
  renderDetail();
  connectUi({
    onRecords: (recs) => {
      records = recs;
      renderList();
      const r = records.find((x) => x.id === selectedId);
      if (!r) selectedId = null;
      if (sigOf(r) !== selectedSig) renderDetail();
    },
  });
}

type Child = Node | string | null | undefined | false;
