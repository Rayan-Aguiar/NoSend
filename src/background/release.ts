// Liberar / Descartar requisições HELD (spec §3.2 e §3.4).
// A exceção (regra allow de sessão) é estreita e removida no primeiro match do método
// original, ou após 10 s. Redirect/service worker NÃO alargam a regra: a liberação falha.
import type { InterceptedRequest } from '../shared/types';
import type { TabMessage } from '../shared/messages';
import { canRelease } from '../shared/regex';
import { addAllowRule, removeAllowRule } from './dnr';
import { findRecord, getRecords, onEvicted, updateRecord } from './history';

const RELEASE_TIMEOUT_MS = 10_000;
const pending = new Map<number, { method: string; timer: ReturnType<typeof setTimeout> }>();

async function dropRule(ruleId: number): Promise<void> {
  const p = pending.get(ruleId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(ruleId);
  await removeAllowRule(ruleId).catch(() => {});
}

export type ActionResult = { ok: boolean; reason?: string };

export async function releaseRecord(id: string): Promise<ActionResult> {
  const rec = findRecord((r) => r.id === id);
  if (!rec) return { ok: false, reason: 'registro não encontrado' };
  if (rec.status !== 'HELD' || rec.source !== 'hook' || !rec.hookId) {
    return { ok: false, reason: 'apenas requisições HELD capturadas na página podem ser liberadas' };
  }
  if (!canRelease(rec.url)) return { ok: false, reason: 'URL longa demais para a regra de liberação' };
  if (rec.origin.tabId < 0) return { ok: false, reason: 'requisição sem aba associada' };

  const ruleId = await addAllowRule(rec.origin.tabId, rec.url, rec.method);
  pending.set(ruleId, {
    method: rec.method.toUpperCase(),
    timer: setTimeout(() => { void dropRule(ruleId); }, RELEASE_TIMEOUT_MS),
  });

  const msg: TabMessage = { type: 'doRelease', hookId: rec.hookId };
  try {
    await chrome.tabs.sendMessage(rec.origin.tabId, msg, { frameId: rec.origin.frameId ?? 0 });
  } catch {
    await dropRule(ruleId);
    updateRecord(rec.id, { status: 'DISCARDED_PAGE_GONE' });
    return { ok: false, reason: 'a página que fez a requisição não está mais disponível' };
  }
  updateRecord(rec.id, { status: 'RELEASED' });
  return { ok: true };
}

export async function discardRecord(id: string): Promise<ActionResult> {
  const rec = findRecord((r) => r.id === id);
  if (!rec) return { ok: false, reason: 'registro não encontrado' };
  if (rec.status !== 'HELD' || !rec.hookId) return { ok: false, reason: 'apenas requisições HELD podem ser descartadas' };
  const msg: TabMessage = { type: 'doDiscard', hookId: rec.hookId };
  await chrome.tabs.sendMessage(rec.origin.tabId, msg, { frameId: rec.origin.frameId ?? 0 }).catch(() => {});
  updateRecord(rec.id, { status: 'DISCARDED' });
  return { ok: true };
}

/** Resultado real da requisição liberada, reportado pela página. */
export function recordHeldOutcome(
  hookId: string, tabId: number | undefined,
  outcome: { ok: boolean; status?: number; error?: string },
): void {
  const rec = findRecord((r) => r.hookId === hookId && (tabId === undefined || r.origin.tabId === tabId));
  if (!rec) return;
  const releaseResult: InterceptedRequest['releaseResult'] = outcome.ok
    ? { ok: true, status: outcome.status }
    : {
        ok: false,
        status: outcome.status,
        error: `${outcome.error || 'falha de rede'} — provável bloqueio pelo bloqueio global (redirect ou service worker)`,
      };
  updateRecord(rec.id, { releaseResult });
}

/** HELD de uma página que deixou de existir não pode mais ser liberado. */
function markGone(pred: (r: InterceptedRequest) => boolean): void {
  for (const r of getRecords()) {
    if (r.status === 'HELD' && pred(r)) updateRecord(r.id, { status: 'DISCARDED_PAGE_GONE' });
  }
}

export function startReleaseTracking(): void {
  // HELD que sai do histórico (limite ou Limpar) não pode mais ser decidido pelo usuário:
  // descarta na página para ela receber erro de rede em vez de ficar pendente para sempre.
  onEvicted((removed) => {
    for (const r of removed) {
      if (r.status !== 'HELD' || !r.hookId) continue;
      const msg: TabMessage = { type: 'doDiscard', hookId: r.hookId };
      void chrome.tabs.sendMessage(r.origin.tabId, msg, { frameId: r.origin.frameId ?? 0 }).catch(() => {});
    }
  });
  // Remove a exceção assim que a requisição original passa por ela.
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    const p = pending.get(info.rule.ruleId);
    if (p && info.rule.rulesetId === '_session' && info.request.method.toUpperCase() === p.method) {
      void dropRule(info.rule.ruleId);
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => markGone((r) => r.origin.tabId === tabId));
  chrome.webNavigation.onCommitted.addListener((d) => {
    markGone((r) => r.origin.tabId === d.tabId && (d.frameId === 0 || (r.origin.frameId ?? 0) === d.frameId));
  });
}
