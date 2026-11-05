// Injeção dos content scripts (spec §3.3): estado síncrono + hooks (MAIN) + ponte (ISOLATED).
import type { Mode } from '../shared/types';
import type { TabMessage } from '../shared/messages';

export interface PageState { enabled: boolean; mode: Mode }

const IDS = ['ni-state', 'ni-hooks', 'ni-bridge'];

export function stateFile(s: PageState): string {
  if (!s.enabled) return 'state-off.js';
  return s.mode === 'hold' ? 'state-on-hold.js' : 'state-on-fail.js';
}

function script(id: string, file: string, world: 'MAIN' | 'ISOLATED'): chrome.scripting.RegisteredContentScript {
  return {
    id,
    js: [file],
    matches: ['<all_urls>'],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: 'document_start',
    world: world as chrome.scripting.ExecutionWorld,
    persistAcrossSessions: true,
  };
}

/** (Re)registra os scripts. Ordem: estado, hooks, ponte (confirmada no spike). */
export async function syncContentScripts(s: PageState): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: IDS });
  if (existing.length === IDS.length) {
    await chrome.scripting.updateContentScripts([{ id: 'ni-state', js: [stateFile(s)] }]);
    return;
  }
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((e) => e.id) });
  await chrome.scripting.registerContentScripts([
    script('ni-state', stateFile(s), 'MAIN'),
    script('ni-hooks', 'hooks.js', 'MAIN'),
    script('ni-bridge', 'bridge.js', 'ISOLATED'),
  ]);
}

function injectable(url?: string): boolean {
  return !!url && /^(https?|file):/.test(url);
}

/** Injeta estado + hooks + ponte em abas já abertas. Idempotente (guardas nos scripts). */
export async function injectIntoOpenTabs(s: PageState): Promise<{ tabId: number; ok: boolean }[]> {
  const tabs = await chrome.tabs.query({});
  return Promise.all(
    tabs.filter((t) => t.id !== undefined && injectable(t.url)).map(async (t) => {
      const target = { tabId: t.id!, allFrames: true };
      try {
        await chrome.scripting.executeScript({ target, files: [stateFile(s)], world: 'MAIN' as chrome.scripting.ExecutionWorld, injectImmediately: true });
        await chrome.scripting.executeScript({ target, files: ['hooks.js'], world: 'MAIN' as chrome.scripting.ExecutionWorld, injectImmediately: true });
        await chrome.scripting.executeScript({ target, files: ['bridge.js'], injectImmediately: true });
        return { tabId: t.id!, ok: true };
      } catch {
        return { tabId: t.id!, ok: false };
      }
    }),
  );
}

/** Envia o estado para todos os frames de todas as abas com ponte ativa. */
export async function broadcastState(s: PageState): Promise<void> {
  const msg: TabMessage = { type: 'state', enabled: s.enabled, mode: s.mode };
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => (t.id === undefined ? null : chrome.tabs.sendMessage(t.id, msg).catch(() => {}))));
}
