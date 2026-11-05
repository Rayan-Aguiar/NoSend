// Task 9: interfaces — popup, visualizador (mesmo componente do painel DevTools).
import { test, expect } from '../fixtures.ts';
import type { BrowserContext, Page } from '@playwright/test';
import type { Ext } from '../fixtures.ts';
import type { ExtState, InterceptedRequest } from '../../src/shared/types.ts';

async function openExtPage(context: BrowserContext, ext: Ext, file: string): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${ext.id}/${file}`);
  return p;
}

const rows = (p: Page) => p.locator('#ni-list tbody tr');

async function waitRecord(ext: Ext, pathname: string, status?: string): Promise<InterceptedRequest> {
  let rec: InterceptedRequest | undefined;
  await expect.poll(async () => {
    const recs: InterceptedRequest[] = await ext.send({ type: 'getRecords' });
    rec = recs.filter((r) => new URL(r.url).pathname === pathname && (!status || r.status === status)).pop();
    return !!rec;
  }).toBe(true);
  return rec!;
}

test('popup toggle enables', async ({ context, ext }) => {
  const popup = await openExtPage(context, ext, 'popup.html');
  await expect(popup.locator('#ni-status')).toContainText('DESLIGADO');
  await popup.locator('#ni-toggle').click();
  await expect(popup.locator('#ni-status')).toContainText('PROTEGIDO');
  await expect(popup.locator('#ni-status')).toContainText('MODO INTERCEPTAÇÃO ATIVO');
  expect((await ext.send<ExtState>({ type: 'getState' })).enabled).toBe(true);
  // Página da extensão continua funcionando com ON (DNR não atua em chrome-extension://).
  const again = await openExtPage(context, ext, 'popup.html');
  await expect(again.locator('#ni-status')).toContainText('PROTEGIDO');
});

test('popup shows PROTEÇÃO INCOMPLETA with reason', async ({ context, ext }) => {
  await ext.eval(() => chrome.storage.local.set({ __test_force_dnr_failure: true }), null);
  const popup = await openExtPage(context, ext, 'popup.html');
  await popup.locator('#ni-toggle').click();
  await expect(popup.locator('#ni-status')).toContainText('PROTEÇÃO INCOMPLETA');
  await expect(popup.locator('#ni-reasons li').first()).toContainText(/DNR/);
});

test('popup mode and limit', async ({ context, ext }) => {
  const popup = await openExtPage(context, ext, 'popup.html');
  await popup.locator('#ni-mode').selectOption('hold');
  await expect.poll(async () => (await ext.send<ExtState>({ type: 'getState' })).mode).toBe('hold');
  await popup.locator('#ni-limit').fill('500');
  await popup.locator('#ni-limit').press('Enter');
  await expect.poll(async () => (await ext.send<ExtState>({ type: 'getState' })).limit).toBe(500);
});

test('viewer lists and details', async ({ context, ext, openApp, run, sink }) => {
  const page = await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await run(page, 'postJson');
  await run(page, 'authorization');
  await waitRecord(ext, '/secure');

  const viewer = await openExtPage(context, ext, 'viewer.html');
  const row = rows(viewer).filter({ hasText: '/users' }).first();
  await expect(row).toContainText('POST');
  await expect(row).toContainText(sink.origin + '/users');
  await expect(row).toContainText('BLOCKED');
  await expect(row).toContainText(/\d\d:\d\d:\d\d\.\d\d\d/);
  await row.click();
  const payload = viewer.locator('#ni-detail .ni-payload');
  await expect(payload).toContainText('"email": "rayan@example.com"');
  await expect(payload).toContainText('\n');
  // "ver original" mostra o raw compacto
  await viewer.locator('#ni-detail .ni-raw-toggle').click();
  await expect(payload).toContainText('{"name":"Rayan","email":"rayan@example.com"}');

  await rows(viewer).filter({ hasText: '/secure' }).first().click();
  await expect(viewer.locator('#ni-detail .ni-headers')).toContainText('Authorization');
  await expect(viewer.locator('#ni-detail .ni-headers')).toContainText('Bearer example-token');

  // ao vivo: novo registro aparece sem recarregar
  await run(page, 'putJson');
  await expect(rows(viewer).filter({ hasText: 'PUT' })).toHaveCount(1);
});

test('filters', async ({ context, ext, openApp, run }) => {
  const page = await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await run(page, 'postJson');
  await waitRecord(ext, '/users');
  const viewer = await openExtPage(context, ext, 'viewer.html');
  await expect(rows(viewer).filter({ hasText: 'POST' })).toHaveCount(1);
  await viewer.locator('#ni-f-method').selectOption('GET');
  await expect(rows(viewer).filter({ hasText: 'POST' })).toHaveCount(0);
  await viewer.locator('#ni-f-method').selectOption('');
  await expect(rows(viewer).filter({ hasText: 'POST' })).toHaveCount(1);
  await viewer.locator('#ni-f-text').fill('nao-existe');
  await expect(rows(viewer)).toHaveCount(0);
});

test('copy curl', async ({ context, ext, openApp, run, sink, app }) => {
  // Chromium recusa grantPermissions para origens chrome-extension:// ("opaque origins"):
  // a escrita usa o gesto do clique na página da extensão; a leitura é feita na página da app.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.origin });
  const page = await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await run(page, 'postJson');
  await waitRecord(ext, '/users');
  const viewer = await openExtPage(context, ext, 'viewer.html');
  await viewer.bringToFront();
  await rows(viewer).filter({ hasText: '/users' }).first().click();
  await viewer.locator('#ni-detail .ni-copy').click();
  await expect(viewer.locator('#ni-detail .ni-msg')).toContainText('copiado');
  await page.bringToFront();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.startsWith('curl')).toBe(true);
  expect(clip).toContain('-X POST');

  // Fallback execCommand('copy') quando a Clipboard API falha (caso típico do painel DevTools).
  await page.evaluate(() => navigator.clipboard.writeText('limpo'));
  await viewer.bringToFront();
  await viewer.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('negado'));
  });
  await viewer.locator('#ni-detail .ni-copy').click();
  await expect(viewer.locator('#ni-detail .ni-msg')).toContainText('copiado');
  await page.bringToFront();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('-X POST');

  await viewer.waitForTimeout(300);
  expect(sink.connections).toBe(0);
});

test('release button', async ({ context, ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setMode', mode: 'hold' });
  await ext.send({ type: 'setEnabled', enabled: true });
  await page.evaluate((u) => {
    const w = window as any;
    w.__r = 'pending';
    fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"h":1}' })
      .then((r) => { w.__r = 'resolved:' + r.status; }, (e) => { w.__r = 'rejected:' + e.name; });
  }, sink.origin + '/held');
  await waitRecord(ext, '/held', 'HELD');

  const viewer = await openExtPage(context, ext, 'viewer.html');
  const row = rows(viewer).filter({ hasText: '/held' }).first();
  await expect(row).toContainText('HELD');
  await row.click();
  await expect(viewer.locator('#ni-detail .ni-release')).toBeEnabled();
  await expect(viewer.locator('#ni-detail .ni-discard')).toBeVisible();
  await viewer.locator('#ni-detail .ni-release').click();
  await expect(row).toContainText('RELEASED');
  await expect.poll(() => page.evaluate(() => (window as any).__r)).toBe('resolved:200');
  await expect(viewer.locator('#ni-detail')).toContainText('200');
  await expect(viewer.locator('#ni-detail .ni-release')).toHaveCount(0);
});

test('xss safe', async ({ context, ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  const evil = '<img src=x onerror=window.__pwned=1>';
  await page.evaluate((u) => fetch(u, { headers: { 'X-Evil': '<b>x</b>' } }).catch(() => {}),
    `${sink.origin}/xss?q=${evil}`);
  await waitRecord(ext, '/xss');
  const viewer = await openExtPage(context, ext, 'viewer.html');
  const row = rows(viewer).filter({ hasText: '/xss' }).first();
  await expect(row).toContainText('onerror');
  await row.click();
  await expect(viewer.locator('#ni-detail .ni-query')).toContainText(evil);
  await expect(viewer.locator('#ni-detail .ni-headers')).toContainText('<b>x</b>');
  await viewer.waitForTimeout(300);
  expect(await viewer.evaluate(() => (window as any).__pwned)).toBeUndefined();
  expect(await viewer.locator('#ni-list img, #ni-detail img, #ni-detail b').count()).toBe(0);
});

test('clear', async ({ context, ext, openApp, run }) => {
  const page = await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await run(page, 'postJson');
  await waitRecord(ext, '/users');
  const viewer = await openExtPage(context, ext, 'viewer.html');
  await expect(rows(viewer)).not.toHaveCount(0);
  const popup = await openExtPage(context, ext, 'popup.html');
  await expect(popup.locator('#ni-count')).not.toHaveText('0');
  await popup.locator('#ni-clear').click();
  await expect(popup.locator('#ni-count')).toHaveText('0');
  await expect(rows(viewer)).toHaveCount(0);
  expect((await ext.send<InterceptedRequest[]>({ type: 'getRecords' })).length).toBe(0);
});

test('popup flags reduced capture for a tab without hooks', async ({ context, ext, openApp, page, app }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  const tabId: number = await ext.eval(async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id!, app.origin);
  await expect.poll(async () => ((await ext.send({ type: 'getState' })) as ExtState).hookedTabs).toContain(tabId);

  const hooked = await openExtPage(context, ext, `popup.html?tabId=${tabId}`);
  await expect(hooked.locator('#ni-status')).toContainText('PROTEGIDO');
  await expect(hooked.locator('#ni-tab-note')).toBeHidden();

  await page.goto('chrome://version/');
  const reduced = await openExtPage(context, ext, `popup.html?tabId=${tabId}`);
  await expect(reduced.locator('#ni-tab-note')).toBeVisible();
  await expect(reduced.locator('#ni-tab-note')).toContainText('captura reduzida');
});
