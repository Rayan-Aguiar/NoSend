// Aviso por aba (spec §3.4/§3.7): ligado, mas os hooks não reportaram nesta aba.
import type { ExtState } from '../shared/types';

export const REDUCED_CAPTURE_NOTE =
  'Esta aba: captura reduzida. Os hooks não estão ativos nesta página: registros saem só com URL, método e tipo, sem headers/body. ' +
  'Páginas internas do Chrome e da Chrome Web Store não são interceptadas.';

export function tabCaptureNote(s: ExtState, tabId: number | undefined): string | null {
  if (!s.enabled || tabId === undefined || tabId < 0) return null;
  return s.hookedTabs.includes(tabId) ? null : REDUCED_CAPTURE_NOTE;
}

/** Mostra/esconde o aviso no elemento. */
export function renderTabNote(node: HTMLElement, s: ExtState, tabId: number | undefined): void {
  const note = tabCaptureNote(s, tabId);
  node.textContent = note ?? '';
  node.hidden = note === null;
}
