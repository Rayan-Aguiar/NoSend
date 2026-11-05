// Task 5: injeção dos content scripts e estado síncrono no MAIN world.
import { test, expect } from '../fixtures.ts';
import type { ExtState } from '../../src/shared/types.ts';

test('state known at document_start (ON)', async ({ ext, openApp, page }) => {
  await openApp(); // carrega com OFF
  await ext.send({ type: 'setEnabled', enabled: true });
  // Navegação de página é bloqueada com ON; usa uma página about:blank com script inline
  // (match_origin_as_fallback herda a origem do opener).
  const early = await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.srcdoc = '<script>parent.__early = JSON.stringify(window.__NI_STATE__)</script>';
    document.body.appendChild(f);
    return new Promise((r) => f.addEventListener('load', () => r((window as any).__early)));
  });
  expect(JSON.parse(early as string)).toEqual({ enabled: true, mode: 'fail' });
});

test('state known at document_start (OFF)', async ({ openApp, page }) => {
  await openApp();
  const s = await page.evaluate(() => (window as any).__NI_STATE__);
  expect(s).toEqual({ enabled: false, mode: 'fail' });
  expect(await page.evaluate(() => (window as any).__NI_INSTALLED__)).toBe(true);
});

test('hold mode reaches page state', async ({ ext, openApp, page }) => {
  await openApp();
  await ext.send({ type: 'setMode', mode: 'hold' });
  await ext.send({ type: 'setEnabled', enabled: true });
  await expect.poll(() => page.evaluate(() => (window as any).__NI_DEBUG_GETSTATE__())).toEqual({ enabled: true, mode: 'hold' });
});

test('missing state defaults to ON', async ({ ext, openApp, page }) => {
  await ext.eval(() => chrome.scripting.unregisterContentScripts({ ids: ['ni-state'] }), null);
  await openApp();
  expect(await page.evaluate(() => (window as any).__NI_STATE__)).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__NI_DEBUG_GETSTATE__())).toEqual({ enabled: true, mode: 'fail' });
});

test('open tabs get hooks on enable', async ({ ext, openApp, page }) => {
  await ext.eval(() => chrome.scripting.unregisterContentScripts(), null);
  await openApp();
  expect(await page.evaluate(() => (window as any).__NI_INSTALLED__)).toBeUndefined();
  await ext.send({ type: 'setEnabled', enabled: true });
  await expect.poll(() => page.evaluate(() => (window as any).__NI_INSTALLED__)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__NI_DEBUG_GETSTATE__())).toEqual({ enabled: true, mode: 'fail' });
});

test('state broadcast to already-hooked tab on toggle', async ({ ext, openApp, page }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await expect.poll(() => page.evaluate(() => (window as any).__NI_DEBUG_GETSTATE__().enabled)).toBe(true);
  await ext.send({ type: 'setEnabled', enabled: false });
  await expect.poll(() => page.evaluate(() => (window as any).__NI_DEBUG_GETSTATE__().enabled)).toBe(false);
});

test('heartbeat registers hooked tab', async ({ ext, openApp }) => {
  await openApp();
  await expect.poll(async () => ((await ext.send({ type: 'getState' })) as ExtState).hookedTabs.length).toBeGreaterThan(0);
});
