// Fixture Playwright: contexto Chromium com a extensão de teste (dist-test) carregada.
import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startSink, type Sink } from './servers/sink.ts';
import { startApp, type AppServer } from './servers/app.ts';
import type { BgRequest } from '../src/shared/messages.ts';

export const EXT_DIR = resolve(process.env.NI_OUT || 'dist-test');
export const CHROME_PATH =
  process.env.CHROME_PATH ??
  join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1247/chrome-linux64/chrome');

export async function launchWithExtension(userDataDir: string, extraArgs: string[] = []): Promise<{ context: BrowserContext; sw: Worker }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME_PATH,
    headless: process.env.HEADED ? false : true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, ...extraArgs],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, sw };
}

export interface Ext {
  id: string;
  send<T = any>(req: BgRequest): Promise<T>;
  /** Executa código arbitrário no service worker da extensão. */
  eval<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export interface Fixtures {
  userDataDir: string;
  context: BrowserContext;
  sw: Worker;
  ext: Ext;
  sink: Sink;
  page: Page;
  /** Abre a app de teste apontando para o sink. */
  openApp(path?: string): Promise<Page>;
  /** Executa um cenário de window.scenarios na página. */
  run(page: Page, name: string, arg?: unknown): Promise<any>;
}

export const test = base.extend<Fixtures, { app: AppServer }>({
  app: [async ({}, use) => {
    const app = await startApp();
    await use(app);
    await app.close();
  }, { scope: 'worker' }],

  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ni-profile-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  context: async ({ userDataDir }, use) => {
    const { context } = await launchWithExtension(userDataDir);
    await use(context);
    await context.close();
  },

  sw: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },

  ext: async ({ sw }, use) => {
    const id = new URL(sw.url()).host;
    // Espera a inicialização do background (histórico, regras, content scripts registrados).
    await sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'getState' }));
    await use({
      id,
      send: (req) => sw.evaluate((r) => (globalThis as any).niDebug.handle(r), req),
      eval: (fn, arg) => sw.evaluate(fn as any, arg),
    });
  },

  sink: async ({}, use) => {
    const sink = await startSink();
    await use(sink);
    await sink.close();
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },

  openApp: async ({ page, app, sink, ext: _ready }, use) => {
    await use(async (path = 'index.html') => {
      await page.goto(`${app.origin}/${path}?sink=${encodeURIComponent(sink.origin)}`);
      return page;
    });
  },

  run: async ({}, use) => {
    await use((page, name, arg) =>
      page.evaluate(([n, a]) => (window as any).scenarios[n as string](a), [name, arg] as const),
    );
  },
});

export { expect } from '@playwright/test';
