// Gera os prints do README a partir do build de PRODUÇÃO (dist/): `npm run screenshots`.
// As requisições vão para um host fictício: com o interceptor ON nada sai do navegador.
import { chromium, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startApp } from '../test/servers/app.ts';

const EXT_DIR = resolve('dist');
const OUT = resolve('docs/images');
const CHROME_PATH = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1247/chrome-linux64/chrome');
const API = 'https://api.exemplo.com.br';

mkdirSync(OUT, { recursive: true });
const app = await startApp();
const userDataDir = mkdtempSync(join(tmpdir(), 'ni-shots-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: CHROME_PATH,
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(sw.url()).host;
  const send = (req: unknown) => sw.evaluate((r) => (globalThis as any).niDebug.handle(r), req);
  await send({ type: 'getState' });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${app.origin}/index.html?sink=${encodeURIComponent(API)}`);
  await send({ type: 'setEnabled', enabled: true });

  // Tráfego típico de uma aplicação.
  await page.evaluate(async (api) => {
    const quiet = (p: Promise<unknown>) => p.catch(() => {});
    await quiet(fetch(`${api}/v1/produtos?categoria=notebooks&pagina=2&ordem=preco`, { headers: { Accept: 'application/json' } }));
    await quiet(fetch(`${api}/v1/pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo', 'X-Request-Id': '7f3c9a' },
      body: JSON.stringify({ clienteId: 4821, itens: [{ sku: 'NB-15-I7', qtd: 1, preco: 5299.9 }], cupom: 'BEMVINDO10', entrega: { cep: '01310-100', tipo: 'expressa' } }),
    }));
    const fd = new FormData();
    fd.append('descricao', 'Comprovante de pagamento');
    fd.append('arquivo', new File(['%PDF-1.7 demo'], 'comprovante.pdf', { type: 'application/pdf' }));
    await quiet(fetch(`${api}/v1/anexos`, { method: 'POST', body: fd }));
    await quiet(fetch(`${api}/v1/pedidos/1093`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"status":"cancelado"}' }));
    await new Promise<void>((res) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `${api}/v1/usuarios/4821/preferencias`);
      x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      x.onloadend = () => res();
      x.send('tema=escuro&idioma=pt-BR&newsletter=false');
    });
    navigator.sendBeacon(`${api}/analytics/eventos`, JSON.stringify({ evento: 'checkout_iniciado', valor: 5299.9 }));
    await quiet(fetch(`${api}/v1/pedidos/1093`, { method: 'DELETE' }));
  }, API);
  await page.waitForTimeout(800);

  const tabId: number = await sw.evaluate(async (origin) => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id!, app.origin);

  // 1. Visualizador com um POST JSON selecionado.
  const viewer = await context.newPage();
  await viewer.goto(`chrome-extension://${id}/viewer.html`);
  await selectRow(viewer, '/v1/pedidos', 'POST');
  await viewer.screenshot({ path: join(OUT, 'viewer.png') });

  // 2. Mesmo visualizador em tema escuro, com o multipart selecionado.
  await viewer.emulateMedia({ colorScheme: 'dark' });
  await selectRow(viewer, '/v1/anexos', 'POST');
  await viewer.screenshot({ path: join(OUT, 'viewer-dark.png') });
  await viewer.emulateMedia({ colorScheme: 'light' });

  // 3. Popup ligado (PROTEGIDO) para a aba da aplicação.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 900 });
  await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
  await popup.locator('#ni-status').getByText('PROTEGIDO').waitFor();
  await popup.locator('.ni-popup').screenshot({ path: join(OUT, 'popup.png') });

  // 4. Modo Segurar: requisição HELD com Liberar / Descartar.
  await send({ type: 'setMode', mode: 'hold' });
  await page.evaluate((api) => {
    void fetch(`${api}/v1/pagamentos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'a1b2c3' },
      body: JSON.stringify({ pedidoId: 1094, metodo: 'pix', valor: 4769.91 }),
    }).catch(() => {});
  }, API);
  await viewer.locator('#ni-list tbody tr', { hasText: '/v1/pagamentos' }).waitFor();
  await selectRow(viewer, '/v1/pagamentos', 'POST');
  await viewer.locator('#ni-detail .ni-release').waitFor();
  await viewer.screenshot({ path: join(OUT, 'hold.png') });

  // Deixa o perfil temporário limpo: descarta o HELD.
  await send({ type: 'setEnabled', enabled: false });
  console.log(`prints gerados em ${OUT}`);
} finally {
  await context.close();
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

async function selectRow(p: Page, path: string, method: string): Promise<void> {
  const row = p.locator('#ni-list tbody tr').filter({ hasText: path }).filter({ hasText: method }).first();
  await row.click();
  await p.locator('#ni-detail').getByText(path).first().waitFor();
}
