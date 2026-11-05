// Revisão final #7: relatórios da Reporting API (CSP report-to) são enviados pelo
// ReportingService do Chrome. Verifica se escapam do bloqueio com o interceptor ON.
// STATUS: experimento inconclusivo. Nem com o interceptor OFF o Chrome for Testing headless
// entregou relatórios ao endpoint (violações disparam, ReportingService não envia), então o
// cenário ON não prova nada. Marcado como fixme; a lacuna está documentada como NÃO VERIFICADA
// em docs/coverage-matrix.md. Para reproduzir manualmente: remover os .fixme e rodar headed.
import { test, expect, launchWithExtension } from '../fixtures.ts';

async function scenario(userDataDir: string, app: { origin: string }, sink: any, enable: boolean) {
  const { context, sw } = await launchWithExtension(userDataDir, ['--short-reporting-delay']);
  try {
    await sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'getState' }));
    const page = await context.newPage();
    await page.goto(`${app.origin}/reporting.html?sink=${encodeURIComponent(sink.origin)}`);
    if (enable) await sw.evaluate(() => (globalThis as any).niDebug.handle({ type: 'setEnabled', enabled: true }));
    sink.reset();
    await page.evaluate(() => { (window as any).__v = 0; document.addEventListener('securitypolicyviolation', () => (window as any).__v++); for (let i = 0; i < 3; i++) { const img = new Image(); img.src = `https://example.test/v${i}.png?secret=abc`; document.body.appendChild(img); } });
    await page.waitForTimeout(Number(process.env.REPORT_WAIT ?? 4000));
    console.log("REPORTING sink urls:", JSON.stringify(sink.requests.map((r: any) => r.method + " " + r.url)), "violations:", await page.evaluate(() => (window as any).__v));
    return sink.requests.filter((r: any) => r.url.startsWith('/reports'));
  } finally {
    await context.close();
  }
}

test.fixme('control (OFF): CSP reports reach the endpoint', async ({ userDataDir, app, sink }) => {
  const reports = await scenario(userDataDir, app, sink, false);
  expect(reports.length).toBeGreaterThan(0);
});

test.fixme('ON: CSP reports do not reach the server', async ({ userDataDir, app, sink }) => {
  const reports = await scenario(userDataDir, app, sink, true);
  console.log('REPORTING ON: reports=', reports.length, 'connections=', sink.connections);
  expect(reports.length).toBe(0);
  expect(sink.connections).toBe(0);
});
