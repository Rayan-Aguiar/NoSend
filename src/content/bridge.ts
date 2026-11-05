// Ponte ISOLATED world: eventos da página (MAIN) <-> background.
// Os eventos carregam JSON string em `detail` (objetos não atravessam mundos de forma confiável).
import { EV_TO_BRIDGE, EV_TO_PAGE, type BridgeToPage, type PageToBridge, type TabMessage } from '../shared/messages';

declare global { interface Window { __NI_BRIDGE_ALIVE__?: () => boolean } }

function alive(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function toPage(m: BridgeToPage): void {
  window.dispatchEvent(new CustomEvent(EV_TO_PAGE, { detail: JSON.stringify(m) }));
}

function send(msg: unknown): void {
  if (!alive()) return;
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* contexto invalidado */ }
}

// Uma ponte viva por frame. Uma ponte de uma instância anterior da extensão (recarregada) fica inerte.
if (!(window.__NI_BRIDGE_ALIVE__ && window.__NI_BRIDGE_ALIVE__())) {
  window.__NI_BRIDGE_ALIVE__ = alive;

  window.addEventListener(EV_TO_BRIDGE, (e) => {
    if (!alive()) return;
    let m: PageToBridge;
    try { m = JSON.parse((e as CustomEvent).detail); } catch { return; }
    switch (m.type) {
      case 'hookRecord': send({ type: 'hookRecord', record: m.record }); break;
      case 'heldOutcome': send({ type: 'heldOutcome', hookId: m.hookId, ok: m.ok, status: m.status, error: m.error }); break;
      case 'heartbeat': send({ type: 'hookHeartbeat' }); break;
      case 'ping': toPage({ type: 'bridgeReady' }); break;
    }
  });

  chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
    if (msg?.type === 'alive') { sendResponse(true); return; }
    if (msg && (msg.type === 'state' || msg.type === 'doRelease' || msg.type === 'doDiscard')) toPage(msg);
  });

  toPage({ type: 'bridgeReady' });
}
