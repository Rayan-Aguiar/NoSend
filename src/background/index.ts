// Background service worker: estado, status fail-safe, histórico e roteamento de mensagens.
import type { BgRequest } from '../shared/messages';
import type { ExtState, InterceptedRequest } from '../shared/types';
import { installBlockRule, removeBlockRule, removeAllAllowRules } from './dnr';
import { disablePrediction, restorePrediction } from './privacy';
import { computeStatus, type StatusResult } from './status';
import { clampLimit, getSettings, saveSettings } from './state';
import {
  addRecord, clearRecords, flushHistory, getRecords, loadHistory, onHistoryChange, setHistoryLimit,
} from './history';

let status: StatusResult = { status: 'OFF', reasons: [], warnings: [] };
/** Erros da última ativação; somados aos motivos da verificação até o próximo toggle. */
let activationErrors: string[] = [];
const hookedTabs = new Set<number>();

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
}

async function setStatus(s: StatusResult): Promise<void> {
  status = s;
  await updateBadge();
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
    hookedTabs: [...hookedTabs],
  };
}

async function refreshStatus(): Promise<void> {
  const { enabled } = await getSettings();
  await setStatus(await computeStatus(enabled, enabled ? activationErrors : []));
}

// ---- ligar / desligar ----
async function enable(): Promise<void> {
  await saveSettings({ enabled: true }); // salvo antes: se algo cair no meio, o restart reaplica
  activationErrors = [];
  await setStatus({ status: 'ACTIVATING', reasons: [], warnings: status.warnings });
  try { await installBlockRule(); } catch (e) { activationErrors.push(`instalação da regra DNR falhou: ${(e as Error).message}`); }
  try { await disablePrediction(); } catch (e) { activationErrors.push(`desligar predição de rede falhou: ${(e as Error).message}`); }
  await refreshStatus();
}

async function disable(): Promise<void> {
  activationErrors = [];
  await removeBlockRule();
  await restorePrediction().catch(() => {});
  await saveSettings({ enabled: false });
  await setStatus(await computeStatus(false));
}

// ---- inicialização (todo wake-up do service worker) ----
const ready: Promise<void> = (async () => {
  const settings = await getSettings();
  await loadHistory(settings.limit);
  await removeAllAllowRules().catch(() => {});
  if (settings.enabled) {
    // Garante a regra e a privacy mesmo que algo as tenha removido.
    try { await installBlockRule(); } catch (e) { activationErrors.push(`instalação da regra DNR falhou: ${(e as Error).message}`); }
    try { await disablePrediction(); } catch (e) { activationErrors.push(`desligar predição de rede falhou: ${(e as Error).message}`); }
  }
  await refreshStatus();
})();

// ---- roteamento ----
export async function handle(req: BgRequest, _sender?: chrome.runtime.MessageSender): Promise<unknown> {
  await ready;
  switch (req.type) {
    case 'getState':
      return serial(async () => { await refreshStatus(); return snapshot(); });
    case 'setEnabled':
      return serial(async () => { await (req.enabled ? enable() : disable()); return snapshot(); });
    case 'setMode':
      return serial(async () => { await saveSettings({ mode: req.mode === 'hold' ? 'hold' : 'fail' }); return snapshot(); });
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
    default:
      return { error: `mensagem não suportada: ${(req as { type: string }).type}` };
  }
}

chrome.runtime.onMessage.addListener((msg: BgRequest, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: (e as Error).message }));
  return true;
});

onHistoryChange(() => { /* UI ao vivo: Task 9 */ });

const debug: Record<string, unknown> = { handle: (r: BgRequest) => handle(r) };
if (__TEST__) {
  debug.addRecord = async (r: Omit<InterceptedRequest, 'id' | 'seq'>) => { await ready; return addRecord(r); };
  debug.flush = () => flushHistory();
  debug.reloadFromStorage = async () => { await ready; await loadHistory((await getSettings()).limit); };
}
(globalThis as any).niDebug = debug;
