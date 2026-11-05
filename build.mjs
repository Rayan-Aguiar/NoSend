// Build da extensão. Uso: node build.mjs [--test]
//  - prod  -> dist/       (__TEST__ = false)
//  - teste -> dist-test/  (__TEST__ = true, inclui test/ext-fixtures)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const isTest = process.argv.includes('--test');
const out = isTest ? 'dist-test' : 'dist';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('static', out, { recursive: true });
if (isTest && existsSync('test/ext-fixtures')) {
  cpSync('test/ext-fixtures', `${out}/test-fixtures`, { recursive: true });
}

/** [entrada, saída, formato] — entradas inexistentes são ignoradas (tarefas futuras). */
const entries = [
  ['src/background/index.ts', 'background.js', 'esm'],
  ['src/content/hooks/index.ts', 'hooks.js', 'iife'],
  ['src/content/bridge.ts', 'bridge.js', 'iife'],
  ['src/popup/popup.ts', 'popup.js', 'iife'],
  ['src/devtools/devtools.ts', 'devtools.js', 'iife'],
  ['src/devtools/panel.ts', 'panel.js', 'iife'],
  ['src/viewer/viewer.ts', 'viewer.js', 'iife'],
];

for (const [entry, file, format] of entries) {
  if (!existsSync(entry)) continue;
  await build({
    entryPoints: [entry],
    outfile: `${out}/${file}`,
    bundle: true,
    format,
    target: 'chrome120',
    define: { __TEST__: String(isTest) },
    legalComments: 'none',
    logLevel: 'warning',
  });
}

// Scripts de estado síncrono (MAIN world, document_start), um por estado (§3.3).
const states = {
  'state-off.js': { enabled: false, mode: 'fail' },
  'state-on-fail.js': { enabled: true, mode: 'fail' },
  'state-on-hold.js': { enabled: true, mode: 'hold' },
};
for (const [file, state] of Object.entries(states)) {
  writeFileSync(
    `${out}/${file}`,
    `(()=>{const s=${JSON.stringify(state)};globalThis.__NI_STATE__=s;` +
      `if(typeof globalThis.__NI_APPLY_STATE__==='function')globalThis.__NI_APPLY_STATE__(s);})();\n`,
  );
}

console.log(`build ok -> ${out}${isTest ? ' (test)' : ''}`);
