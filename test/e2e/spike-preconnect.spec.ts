// Spike: navegação bloqueada pelo DNR ainda gera preconnect TCP se a predição de rede estiver ligada.
import { test, expect } from '../fixtures.ts';
for (const prediction of [true, false]) {
  test(`main_frame nav connections, prediction=${prediction}`, async ({ openApp, sink, ext, page }) => {
    await openApp();
    await ext.eval((p) => chrome.privacy.network.networkPredictionEnabled.set({ value: p }), prediction);
    await ext.send({ type: 'setEnabled', enabled: true });
    await page.evaluate((s) => fetch(s + '/xhr').catch(() => {}), sink.origin);
    console.log(`SPIKE pred=${prediction} after fetch: conns=${sink.connections} reqs=${sink.requests.length}`);
    const nav = await page.context().newPage();
    await nav.goto(sink.origin + '/nav').catch(() => {});
    await nav.waitForTimeout(500);
    console.log(`SPIKE pred=${prediction} after nav: conns=${sink.connections} reqs=${sink.requests.length}`);
    await page.goto(sink.origin + '/nav2').catch(() => {});
    await page.waitForTimeout(500);
    console.log(`SPIKE pred=${prediction} after same-tab nav: conns=${sink.connections} reqs=${sink.requests.length}`);
    expect(sink.requests.length).toBe(0);
    if (!prediction) expect(sink.connections).toBe(0);
  });
}
