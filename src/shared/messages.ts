import type { HookRecord, Mode } from './types';

/** Mensagens para o background (chrome.runtime.sendMessage / niDebug.handle). */
export type BgRequest =
  | { type: 'getState' }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'setMode'; mode: Mode }
  | { type: 'setLimit'; limit: number }
  | { type: 'getRecords'; tabId?: number }
  | { type: 'clear' }
  | { type: 'hookRecord'; record: HookRecord }
  | { type: 'heldOutcome'; hookId: string; ok: boolean; status?: number; error?: string }
  | { type: 'release'; id: string }
  | { type: 'discard'; id: string }
  | { type: 'hookHeartbeat' };

/** Background -> bridge (chrome.tabs.sendMessage). */
export type TabMessage =
  | { type: 'state'; enabled: boolean; mode: Mode }
  | { type: 'doRelease'; hookId: string }
  | { type: 'doDiscard'; hookId: string };

/** MAIN world -> bridge (detail = JSON string). */
export const EV_TO_BRIDGE = '__ni_to_bridge';
/** bridge -> MAIN world (detail = JSON string). */
export const EV_TO_PAGE = '__ni_to_page';

export type PageToBridge =
  | { type: 'hookRecord'; record: HookRecord }
  | { type: 'heldOutcome'; hookId: string; ok: boolean; status?: number; error?: string }
  | { type: 'heartbeat' }
  | { type: 'ping' };

export type BridgeToPage =
  | { type: 'bridgeReady' }
  | { type: 'state'; enabled: boolean; mode: Mode }
  | { type: 'doRelease'; hookId: string }
  | { type: 'doDiscard'; hookId: string };

/** Nome do port de UI ao vivo. */
export const UI_PORT = 'ni-ui';
