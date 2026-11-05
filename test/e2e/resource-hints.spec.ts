// Dicas explícitas de recurso (<link rel=preconnect|dns-prefetch|prefetch|preload>) apontando para o sink.
import { test, expect } from '../fixtures.ts';

const addHints = (page: import('@playwright/test').Page, sink: string, tag: string) =>
  page.evaluate(([s, t]) => {
    const add = (rel: string, href: string, extra: Record<string, string> = {}) => {
      const l = document.createElement('link');
      l.rel = rel; l.href = href;
      for (const [k, v] of Object.entries(extra)) l.setAttribute(k, v);
      document.head.appendChild(l);
    };
    add('preconnect', s);
    add('dns-prefetch', s);
    add('prefetch', `${s}/hint-prefetch-${t}`);
    add('preload', `${s}/hint-preload-${t}`, { as: 'fetch', crossorigin: '' });
  }, [sink, tag] as const);

test('OFF control: resource hints do reach the server', async ({ openApp, page, sink }) => {
  await openApp();
  await addHints(page, sink.origin, 'off');
  await expect.poll(() => sink.connections, { timeout: 5000 }).toBeGreaterThan(0);
});

test('ON: resource hints open no connection', async ({ ext, openApp, page, sink }) => {
  await openApp();
  await ext.send({ type: 'setEnabled', enabled: true });
  await addHints(page, sink.origin, 'on');
  await page.waitForTimeout(2000);
  expect(sink.connections).toBe(0);
  expect(sink.requests.length).toBe(0);
});

test('preconnect alone: OFF opens a TCP connection, ON opens none', async ({ ext, openApp, page, sink }) => {
  await openApp();
  const preconnect = () => page.evaluate((s) => {
    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = s; document.head.appendChild(l);
  }, sink.origin);
  await ext.send({ type: 'setEnabled', enabled: true });
  await preconnect();
  await page.waitForTimeout(2000);
  expect(sink.connections).toBe(0);

  await ext.send({ type: 'setEnabled', enabled: false });
  await page.evaluate(() => document.querySelectorAll('link[rel=preconnect]').forEach((l) => l.remove()));
  await preconnect();
  await expect.poll(() => sink.connections, { timeout: 5000 }).toBeGreaterThan(0); // controle positivo
  expect(sink.requests.length).toBe(0);
});
