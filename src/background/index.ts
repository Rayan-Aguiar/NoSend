// Background service worker: estado, status fail-safe, histórico e roteamento de mensagens.
import { UI_PORT, type BgRequest } from '../shared/messages';
import type { ExtState, HookRecord, InterceptedRequest, RequestKind } from '../shared/types';
import { installBlockRule, removeBlockRule, removeAllAllowRules } from './dnr';
import { disablePrediction, restorePrediction } from './privacy';
import { computeStatus, type StatusResult } from './status';
import { clampLimit, getSettings, saveSettings } from './state';
import {
  addRecord, clearRecords, flushHistory, getRecords, loadHistory, onHistoryChange, setHistoryLimit,
} from './history';
import { startDnrLog } from './dnrlog';
import { broadcastState, injectIntoOpenTabs, syncContentScripts } from './injection';
import { discardRecord, recordHeldOutcome, releaseRecord, startReleaseTracking } from './release';

let status: StatusResult = { status: 'OFF', reasons: [], warnings: [] };
/** Erros da última ativação; somados aos motivos da verificação até o próximo toggle. */
let activationErrors: string[] = [];
/** Aba → documentId do frame principal cujos hooks reportaram heartbeat. Outro documento na
 *  aba (navegação para página sem hooks, ex.: chrome://) tira a aba da lista: "captura reduzida". */
const hookedDocs = new Map<number, string>();
/** Sobrevive a reinícios do service worker (storage.session vive enquanto o navegador estiver aberto). */
async function persistHookedTabs(): Promise<void> {
  await chrome.storage.session.set({ ni_hooked_docs: [...hookedDocs] }).catch(() => {});
}
/** Ports de UI conectados (popup, painel, visualizador). */
const uiPorts = new Set<chrome.runtime.Port>();
let uiTimer: ReturnType<typeof setTimeout> | null = null;

// ---- serialização: toggles e leituras de estado nunca se intercalam ----
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

// ---- badge ----
async function updateBadge(): Promise<void> {
  const map = {
    OFF: { text: '', color: '#888' },
    ACTIVATING: { text: '…', color: '#e80' },
    PROTECTED: { text: 'ON', color: '#d00' },
    INCOMPLETE: { text: '!', color: '#e80' },
  } as const;
  const b = map[status.status];
  await chrome.action?.setBadgeText({ text: b.text }).catch(() => {});
  await chrome.action?.setBadgeBackgroundColor({ color: b.color }).catch(() => {});
  // Ícone com variante ON sempre que a extensão está ligada (inclusive INCOMPLETE/ACTIVATING).
  const v = status.status === 'OFF' ? 'off' : 'on';
  const path = Object.fromEntries([16, 32, 48, 128].map((s) => [String(s), `icons/${v}-${s}.png`]));
  await chrome.action?.setIcon({ path }).catch(() => {});
}

async function setStatus(s: StatusResult): Promise<void> {
  status = s;
  await updateBadge();
  scheduleUiPush();
}

async function snapshot(): Promise<ExtState> {
  const settings = await getSettings();
  const recs = getRecords();
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    limit: settings.limit,
    status: status.status,
    reasons: status.reasons,
    warnings: status.warnings,
    count: recs.length,
    heldCount: recs.filter((r) => r.status === 'HELD').length,
    hookedTabs: [...hookedDocs.keys()],
  };
}

async function refreshStatus(): Promise<void> {
  const { enabled } = await getSettings();
  await setStatus(await computeStatus(enabled, enabled ? activationErrors : []));
}

/** Propaga o estado para as páginas: scripts registrados, frames com ponte e abas abertas. */
async function applyPageState(): Promise<void> {
  const s = await getSettings();
  const page = { enabled: s.enabled, mode: s.mode };
  try { await syncContentScripts(page); } catch (e) { console.warn('syncContentScripts', e); }
  await broadcastState(page).catch(() => {});
  await injectIntoOpenTabs(page).catch(() => {});
}

// ---- ligar / desligar ----
// Ordem ao ligar: DNR -> privacy -> páginas. Ao desligar: DNR -> privacy -> páginas.
// Em ambos os sentidos, a janela intermediária erra para o lado do bloqueio.
async function enable(): Promise<void> {
  await saveSettings({ enabled: true }); // salvo antes: se algo cair no meio, o restart reaplica
  activationErrors = [];
  await setStatus({ status: 'ACTIVATING', reasons: [], warnings: status.warnings });
  try { await installBlockRule(); } catch (e) { activationErrors.push(`instalação da regra DNR falhou: ${(e as Error).message}`); }
  try { await disablePrediction(); } catch (e) { activationErrors.push(`desligar predição de rede falhou: ${(e as Error).message}`); }
  await applyPageState(); // spec §3.7: status final só depois de atualizar as páginas
  await refreshStatus();
}

async function disable(): Promise<void> {
  activationErrors = [];
  await removeBlockRule();
  await restorePrediction().catch(() => {});
  await saveSettings({ enabled: false });
  await setStatus(await computeStatus(false));
  await applyPageState();
}

// ---- inicialização (todo wake-up do service worker) ----
const ready: Promise<void> = (async () => {
  const settings = await getSettings();
  const { ni_hooked_docs } = await chrome.storage.session.get('ni_hooked_docs').catch(() => ({ ni_hooked_docs: [] }));
  for (const [tab, doc] of (ni_hooked_docs as Array<[number, string]> | undefined) ?? []) hookedDocs.set(tab, doc);
  await loadHistory(settings.limit);
  await removeAllAllowRules().catch(() => {});
  if (settings.enabled) {
    // Garante a regra e a privacy mesmo que algo as tenha removido.
    try { await installBlockRule(); } catch (e) { activationErrors.push(`instalação da regra DNR falhou: ${(e as Error).message}`); }
    try { await disablePrediction(); } catch (e) { activationErrors.push(`desligar predição de rede falhou: ${(e as Error).message}`); }
  }
  await refreshStatus();
  try {
    await syncContentScripts({ enabled: settings.enabled, mode: settings.mode });
  } catch (e) { console.warn('syncContentScripts', e); }
})();

// ---- registros vindos dos hooks ----
const BROWSER_HEADERS_NOTE =
  'Headers adicionados pelo navegador (Cookie, User-Agent, Origin, Sec-*) não incluídos: a requisição nunca foi enviada.';
const HOOK_KINDS: RequestKind[] = ['fetch', 'xhr', 'beacon', 'websocket', 'websocket-message', 'eventsource'];

/** A página pode forjar eventos: valida o formato antes de gravar. */
function validHookRecord(r: any): r is HookRecord {
  return !!r && typeof r.url === 'string' && typeof r.method === 'string' && typeof r.hookId === 'string'
    && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(r.method)
    && Array.isArray(r.headers) && HOOK_KINDS.includes(r.kind);
}

function recordFromHook(r: HookRecord, sender?: chrome.runtime.MessageSender): InterceptedRequest {
  let query: Array<[string, string]> = [];
  try { query = [...new URL(r.url).searchParams]; } catch { /* URL inválida */ }
  const headers = r.headers.filter((h) => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)] as [string, string]);
  const contentType = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? null;
  return addRecord({
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : new Date().toISOString(),
    url: r.url,
    method: r.method.toUpperCase(),
    query,
    headers,
    contentType,
    body: r.body ?? null,
    kind: r.kind,
    source: 'hook',
    status: r.held ? 'HELD' : 'BLOCKED',
    origin: {
      tabId: sender?.tab?.id ?? -1,
      frameId: sender?.frameId,
      frameUrl: typeof r.frameUrl === 'string' ? r.frameUrl : undefined,
      documentUrl: sender?.url,
      stack: typeof r.stack === 'string' ? r.stack : undefined,
    },
    notes: [BROWSER_HEADERS_NOTE, ...(Array.isArray(r.notes) ? r.notes.map(String) : [])],
    incognito: sender?.tab?.incognito ?? true, // sem aba conhecida: só memória
    hookId: r.hookId,
  });
}

// ---- roteamento ----
export async function handle(req: BgRequest, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  await ready;
  switch (req.type) {
    case 'getState':
      return serial(async () => { await refreshStatus(); return snapshot(); });
    case 'setEnabled':
      return serial(async () => { await (req.enabled ? enable() : disable()); return snapshot(); });
    case 'setMode':
      return serial(async () => {
        await saveSettings({ mode: req.mode === 'hold' ? 'hold' : 'fail' });
        await applyPageState();
        return snapshot();
      });
    case 'setLimit':
      return serial(async () => {
        const limit = clampLimit(req.limit);
        await saveSettings({ limit });
        setHistoryLimit(limit);
        return snapshot();
      });
    case 'getRecords':
      return getRecords(req.tabId);
    case 'clear':
      await clearRecords();
      return { ok: true };
    case 'hookRecord':
      if (!validHookRecord(req.record)) return { error: 'registro inválido' };
      return { id: recordFromHook(req.record, sender).id };
    case 'heldOutcome':
      recordHeldOutcome(req.hookId, sender?.tab?.id, { ok: !!req.ok, status: req.status, error: req.error });
      return { ok: true };
    case 'release':
      return releaseRecord(req.id);
    case 'discard':
      return discardRecord(req.id);
    case 'hookHeartbeat':
      // Só o frame principal define a aba; documentId distingue a página atual das anteriores.
      if (sender?.tab?.id !== undefined && sender.frameId === 0 && sender.documentId
          && hookedDocs.get(sender.tab.id) !== sender.documentId) {
        hookedDocs.set(sender.tab.id, sender.documentId);
        await persistHookedTabs();
        scheduleUiPush();
      }
      return { ok: true };
    default:
      return { error: `mensagem não suportada: ${(req as { type: string }).type}` };
  }
}

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: (e as Error).message }));
  return true;
});
startDnrLog(ready);
startReleaseTracking();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (hookedDocs.delete(tabId)) { void persistHookedTabs(); scheduleUiPush(); }
});
// Novo documento no frame principal: a aba só volta à lista quando os hooks dele reportarem.
// Comparar documentId evita apagar um heartbeat do novo documento que chegou antes deste evento.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  void ready.then(() => {
    const doc = hookedDocs.get(d.tabId);
    if (doc !== undefined && doc !== d.documentId) {
      hookedDocs.delete(d.tabId);
      void persistHookedTabs();
      scheduleUiPush();
    }
  });
});
// Acorda o service worker na abertura do navegador: `ready` reinstala/verifica a regra e
// atualiza ícone/badge (sem isso ficam no padrão OFF do manifest até outro evento).
chrome.runtime.onStartup.addListener(() => { void ready; });
chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  const s = await getSettings();
  await injectIntoOpenTabs({ enabled: s.enabled, mode: s.mode }).catch(() => {});
});

// ---- UI ao vivo (popup, painel DevTools, visualizador) via port ----
// Ao conectar: estado + registros. Mudanças no histórico/estado: push com throttle (~150 ms).
async function pushUi(ports: Iterable<chrome.runtime.Port>): Promise<void> {
  const list = [...ports];
  if (!list.length) return;
  const state = await snapshot();
  const records = getRecords();
  for (const port of list) {
    try {
      port.postMessage({ type: 'state', state });
      port.postMessage({ type: 'records', records });
    } catch { uiPorts.delete(port); }
  }
}

function scheduleUiPush(): void {
  if (uiTimer || !uiPorts.size) return;
  uiTimer = setTimeout(() => { uiTimer = null; void pushUi(uiPorts); }, 150);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== UI_PORT) return;
  // Só páginas da própria extensão (popup, painel, visualizador).
  if (port.sender?.id !== chrome.runtime.id || (port.sender.tab && !port.sender.url?.startsWith(chrome.runtime.getURL('')))) {
    port.disconnect();
    return;
  }
  uiPorts.add(port);
  port.onDisconnect.addListener(() => uiPorts.delete(port));
  void ready.then(() => pushUi([port]));
});

onHistoryChange(scheduleUiPush);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ni_settings) scheduleUiPush();
});

const debug: Record<string, unknown> = { handle: (r: BgRequest) => handle(r) };
if (__TEST__) {
  debug.addRecord = async (r: Omit<InterceptedRequest, 'id' | 'seq'>) => { await ready; return addRecord(r); };
  debug.flush = () => flushHistory();
  debug.reloadFromStorage = async () => { await ready; await loadHistory((await getSettings()).limit); };
}
(globalThis as any).niDebug = debug;
