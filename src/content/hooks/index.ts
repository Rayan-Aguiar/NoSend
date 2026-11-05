// Hooks do MAIN world: instalação idempotente, estado síncrono e canal com a ponte.
import { EV_TO_BRIDGE, EV_TO_PAGE, type BridgeToPage, type PageToBridge } from '../../shared/messages';
import type { HookCtx, PageState } from './ctx';
import { installFetchHook } from './fetch';
import { installXhrHook } from './xhr';
import { installBeaconHook } from './beacon';
import { installWebSocketHook } from './websocket';
import { installEventSourceHook } from './eventsource';

const G = globalThis as any;
const FAILSAFE: PageState = { enabled: true, mode: 'fail' };

function valid(s: any): s is PageState {
  return !!s && typeof s.enabled === 'boolean' && (s.mode === 'fail' || s.mode === 'hold');
}

function install(): void {
  // Capturados antes de qualquer hook, para não chamarmos versões já interceptadas.
  const dispatch = EventTarget.prototype.dispatchEvent;
  const addListener = EventTarget.prototype.addEventListener;
  const NativeCustomEvent = CustomEvent;
  const stringify = JSON.stringify;
  const parse = JSON.parse;

  let state: PageState = valid(G.__NI_STATE__) ? { ...G.__NI_STATE__ } : { ...FAILSAFE };
  const stateListeners: Array<(s: PageState) => void> = [];
  const held = new Map<string, { release: () => void; discard: () => void }>();
  let bridgeReady = false;
  const queue: PageToBridge[] = [];

  function applyState(s: unknown): void {
    if (!valid(s)) return;
    const changed = s.enabled !== state.enabled || s.mode !== state.mode;
    state = { enabled: s.enabled, mode: s.mode };
    if (changed) for (const l of stateListeners) { try { l(state); } catch { /* hook */ } }
  }

  function post(m: PageToBridge): void {
    dispatch.call(window, new NativeCustomEvent(EV_TO_BRIDGE, { detail: stringify(m) }));
  }

  let seq = 0;
  const prefix = Math.random().toString(36).slice(2, 10);
  const ctx: HookCtx = {
    getState: () => state,
    emit(m) {
      if (bridgeReady) post(m);
      else queue.push(m);
    },
    newId: () => `${prefix}-${++seq}`,
    captureStack() {
      const raw = new Error().stack ?? '';
      return raw
        .split('\n')
        .slice(1)
        .filter((l) => !/chrome-extension:\/\/|hooks\.js/.test(l))
        .join('\n')
        .trim();
    },
    registerHeld(hookId, release, discard) { held.set(hookId, { release, discard }); },
    onStateChange(cb) { stateListeners.push(cb); },
  };

  addListener.call(window, EV_TO_PAGE, (e: Event) => {
    let m: BridgeToPage;
    try { m = parse((e as CustomEvent).detail); } catch { return; }
    switch (m.type) {
      case 'bridgeReady':
        if (!bridgeReady) {
          bridgeReady = true;
          for (const q of queue.splice(0)) post(q);
        }
        break;
      case 'state': applyState(m); break;
      case 'doRelease': { const h = held.get(m.hookId); if (h) { held.delete(m.hookId); h.release(); } break; }
      case 'doDiscard': { const h = held.get(m.hookId); if (h) { held.delete(m.hookId); h.discard(); } break; }
    }
  });

  // Reexecução do script de estado (injeção em aba aberta) atualiza o estado.
  G.__NI_APPLY_STATE__ = applyState;
  if (__TEST__) G.__NI_DEBUG_GETSTATE__ = () => ({ ...state });

  installHooks(ctx);

  G.__NI_INSTALLED__ = true;
  ctx.emit({ type: 'heartbeat' });
  post({ type: 'ping' }); // se a ponte já existe, ela responde bridgeReady
}

function installHooks(ctx: HookCtx): void {
  for (const install of [installFetchHook, installXhrHook, installBeaconHook, installWebSocketHook, installEventSourceHook]) {
    try { install(ctx); } catch { /* um hook com falha não impede os outros; o DNR continua bloqueando */ }
  }
}

if (!G.__NI_INSTALLED__) install();
