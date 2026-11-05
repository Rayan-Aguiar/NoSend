// Hook de navigator.sendBeacon (spec §3.4).
import type { HookCtx } from './ctx';
import { disguise, emitRecord, implicitContentType, resolveUrl } from './common';

export function installBeaconHook(ctx: HookCtx): void {
  const N = Navigator.prototype;
  const nBeacon = N.sendBeacon;
  if (typeof nBeacon !== 'function') return;

  const sendBeacon = function sendBeacon(this: Navigator, url: string | URL, data?: BodyInit | null): boolean {
    const state = ctx.getState();
    // eslint-disable-next-line prefer-rest-params
    if (!state.enabled) return nBeacon.apply(this, arguments as any);

    const hookId = ctx.newId();
    const held = state.mode === 'hold';
    const ct = implicitContentType(data);
    void emitRecord(ctx, {
      hookId, url: resolveUrl(url), method: 'POST',
      headers: ct ? [['Content-Type', ct]] : [],
      body: data ?? null, kind: 'beacon', held, stack: ctx.captureStack(),
    });
    if (held) {
      const nav = this;
      ctx.registerHeld(hookId, () => { nBeacon.call(nav, url, data); }, () => {});
      return true; // o navegador também retorna true ao enfileirar
    }
    return false;
  };

  N.sendBeacon = disguise(sendBeacon, nBeacon);
}
