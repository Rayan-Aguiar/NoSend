# Network Interceptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensão Chrome MV3 que, ligada, impede requisições de páginas de saírem do navegador e registra localmente o que seria enviado, com modo Segurar/Liberar, popup, painel DevTools e testes que provam zero conexões no servidor.

**Architecture:** DNR (regra dinâmica `block` global) é a única barreira de segurança; hooks MAIN-world capturam body/headers/stack e produzem falha de rede coerente; `onRuleMatchedDebug` registra o que os hooks não veem. Background service worker concentra estado, status fail-safe e histórico. UI em TS puro compartilhada entre painel DevTools e `viewer.html`.

**Tech Stack:** TypeScript estrito, esbuild, `@types/chrome`, `@playwright/test` (Chromium já instalado em `~/.cache/ms-playwright`), Node 24 (http/net/crypto nativos). Zero dependências de runtime.

**Spec:** `docs/superpowers/specs/2026-11-05-network-interceptor-design.md` — ler inteiro antes de qualquer tarefa; seções citadas como §N.

## Global Constraints

- Manifest V3; instalação descompactada a partir de `dist/`.
- Zero dependências de runtime. Dev deps apenas: `typescript`, `esbuild`, `@types/chrome`, `@playwright/test`, `@types/node`.
- Nenhuma chamada de rede externa em nenhum código da extensão; nenhuma fonte/CDN externa nas páginas da extensão.
- Regra de bloqueio lista explicitamente TODOS os `resourceTypes` (§3.2).
- Com ON, hook nunca passa a URL original a API de rede nativa, exceto em Liberar (§3.4).
- Estado desconhecido nos hooks ⇒ ON modo Falhar (§3.3).
- `PROTEGIDO` só após as 3 verificações de §3.7.
- Limite de histórico padrão 1000, faixa 100–10000; texto truncado acima de 1 MB; `previewHex` = primeiros 64 bytes.
- Allow rule: sessão, prioridade 2, `tabIds:[tabId]`, `regexFilter` ancorado, `requestMethods:[método,"options"]`, `resourceTypes:["xmlhttprequest","ping"]`, timeout 10 s.
- Placeholders: `wss://blocked.invalid/` (WebSocket), `https://blocked.invalid/` (EventSource); registros DNR para `*.blocked.invalid` descartados.
- Registros de abas anônimas só em memória.
- Flag de teste de falha DNR existe só no build de teste (`__TEST__` via esbuild `define`).
- Commits sem `Co-Authored-By` nem menção a IA.

## Review Focus

1. `fetch(new Request(url, {method:'POST', body}))` — body deve ser capturado via `clone()`, e em Segurar/Liberar o servidor recebe o body intacto. (Task 6)
2. Requisição disparada pelo primeiro `<script>` inline da página, antes da ponte ISOLATED estar pronta — deve ser bloqueada E registrada (fila até a ponte responder). (Task 6)
3. Service worker da extensão reinicia (idle) com ON — estado, status e histórico sobrevivem; regra DNR continua. (Task 3)
4. Body grande (>1 MB texto) e binário (`Uint8Array`, `Blob`) — truncamento com nota e `binary` com tamanho real, sem travar UI. (Task 2)
5. Toggle rápido ON→OFF→ON — estado final coerente; status nunca `PROTEGIDO` sem regra presente. (Task 3)

---

## File Structure

```
package.json, tsconfig.json, playwright.config.ts, build.mjs
static/manifest.json, static/icons/*.png, static/*.html, static/ui.css
src/shared/types.ts          InterceptedRequest, CapturedBody, ExtState, Mode, Status (§3.5)
src/shared/messages.ts       BgRequest/BgResponse unions, page<->bridge event names
src/shared/body.ts           serializeBody()
src/shared/curl.ts           toCurl()
src/shared/ring.ts           RingBuffer
src/shared/regex.ts          exactUrlRegex()
src/background/index.ts      wiring, onMessage, ports, niDebug
src/background/dnr.ts        block/allow rules, verify
src/background/privacy.ts    prediction off/restore, verify
src/background/status.ts     computeStatus()
src/background/state.ts      persisted settings
src/background/history.ts    history store (memory + storage.local, incognito memory-only)
src/background/injection.ts  registerContentScripts + executeScript em abas abertas
src/background/dnrlog.ts     onRuleMatchedDebug -> records
src/background/release.ts    prepareRelease/finishRelease
src/content/state-*.ts       scripts MAIN de estado (gerados pelo build a partir de um template)
src/content/hooks/index.ts   instala hooks, recebe estado, emite eventos
src/content/hooks/fetch.ts, xhr.ts, beacon.ts, websocket.ts, eventsource.ts
src/content/bridge.ts        ISOLATED: page events <-> chrome.runtime
src/ui/list-detail.ts        componente compartilhado
src/popup/popup.ts, src/devtools/devtools.ts, src/devtools/panel.ts, src/viewer/viewer.ts
test/servers/sink.ts         sink TCP/HTTP/WS/SSE em processo
test/servers/app.ts          serve test/app/
test/app/index.html, test/app/app.js, test/app/worker.js, test/app/sw.js
test/fixtures.ts             fixture Playwright: context com extensão, sw, sink, app
test/unit/*.spec.ts, test/e2e/*.spec.ts
docs/architecture.md, docs/blocking.md, docs/coverage-matrix.md, README.md
```

### Interfaces compartilhadas (definidas na Task 1/2, usadas por todas)

```ts
// src/shared/types.ts — InterceptedRequest e CapturedBody exatamente como §3.5, mais:
//   kind inclui também 'ping' | 'csp_report' | 'webtransport' para tipos DNR restantes
//   incognito?: boolean
export type Mode = 'fail' | 'hold';
export type Status = 'OFF' | 'ACTIVATING' | 'PROTECTED' | 'INCOMPLETE';
export interface ExtState {
  enabled: boolean; mode: Mode; limit: number;
  status: Status; reasons: string[]; warnings: string[];
  count: number; heldCount: number;
}
// Registro produzido pelo hook (sem seq/id/status; background completa)
export interface HookRecord {
  hookId: string;            // id local do hook, usado em release/discard
  url: string; method: string;
  headers: Array<[string, string]>;
  body: CapturedBody | null;
  kind: InterceptedRequest['kind'];
  held: boolean;
  frameUrl: string; stack: string;
  timestamp: string;
}

// src/shared/messages.ts
export type BgRequest =
  | { type: 'getState' }                                   // -> ExtState
  | { type: 'setEnabled'; enabled: boolean }               // -> ExtState (após verificação)
  | { type: 'setMode'; mode: Mode }                        // -> ExtState
  | { type: 'setLimit'; limit: number }                    // -> ExtState
  | { type: 'getRecords'; tabId?: number }                 // -> InterceptedRequest[] (ordem seq)
  | { type: 'clear' }                                      // -> { ok: true }
  | { type: 'hookRecord'; record: HookRecord }             // bridge -> bg; -> { id: string }
  | { type: 'heldOutcome'; hookId: string; ok: boolean; status?: number; error?: string } // bridge -> bg
  | { type: 'release'; id: string }                        // UI -> bg; -> { ok: boolean; reason?: string }
  | { type: 'discard'; id: string }                        // UI -> bg; -> { ok: boolean }
  | { type: 'hookHeartbeat' };                             // bridge -> bg
// bg -> bridge (chrome.tabs.sendMessage): {type:'state', enabled, mode} | {type:'doRelease', hookId} | {type:'doDiscard', hookId}
// page <-> bridge: CustomEvent em window. Nomes:
export const EV_TO_BRIDGE = '__ni_to_bridge';   // detail: JSON string {type:'hookRecord'|'heldOutcome'|'heartbeat', ...}
export const EV_TO_PAGE = '__ni_to_page';       // detail: JSON string {type:'state'|'doRelease'|'doDiscard', ...}
// Estado síncrono no MAIN world:
//   (globalThis as any).__NI_STATE__ = { enabled: boolean, mode: Mode }  — ausente ⇒ ON/fail
// UI live updates: chrome.runtime.connect({name:'ni-ui'}); bg posta {type:'records', records} e {type:'state', state}
```

---

### Task 1: Scaffold, harness de teste e spike das suposições (§8)

**Files:**
- Create: `package.json`, `tsconfig.json`, `build.mjs`, `playwright.config.ts`, `static/manifest.json`, `src/shared/types.ts`, `src/shared/messages.ts`, `src/background/index.ts` (mínimo), `test/servers/sink.ts`, `test/servers/app.ts`, `test/app/index.html`, `test/app/app.js`, `test/fixtures.ts`, `test/e2e/spike.spec.ts`, `docs/blocking.md` (seção "Resultados do spike")

**Interfaces:**
- Produces:
  - `npm run build` → `dist/` (prod), `npm run build:test` → `dist-test/` (`__TEST__ = true`); `npm test` → `npm run build:test && playwright test`; `npm run typecheck` → `tsc --noEmit`.
  - `startSink(): Promise<Sink>`; `interface Sink { origin: string; wsOrigin: string; connections: number; requests: Array<{method:string; url:string; headers:Record<string,string>; body:Buffer}>; wsFrames: string[]; reset(): void; close(): Promise<void> }`. Endpoints: qualquer path HTTP → `200 {"ok":true}` com CORS liberal (`Access-Control-Allow-Origin: *`, allow headers/methods `*`, responde OPTIONS); `/sse` → `text/event-stream` envia `data: hello`; upgrade WebSocket em qualquer path (handshake manual via `crypto` SHA-1 + GUID), ecoa frames de texto e registra em `wsFrames`. `connections` incrementa em `server.on('connection')`.
  - `startApp(): Promise<{ origin: string; close(): Promise<void> }>` serve `test/app/` estático.
  - Fixture Playwright `test` com `{ context, sw, sink, app, page, ext }` onde `ext.send(req: BgRequest)` executa `sw.evaluate(r => (globalThis as any).niDebug.handle(r), req)`. Contexto: `chromium.launchPersistentContext('', { channel: 'chromium', args: ['--disable-extensions-except=dist-test', '--load-extension=dist-test'] })`. `sink` é novo por teste.
  - `test/app/app.js` expõe `window.scenarios: Record<string, (sink: string) => Promise<Outcome>>` e `type Outcome = { kind: 'resolved'; status: number } | { kind: 'rejected'; name: string; message: string } | { kind: 'events'; events: string[] } | { kind: 'returned'; value: unknown }`. Página lê `?sink=` da URL. Cenários desta task: `fetchGet`.

- [ ] **Step 1:** `git init`, `.gitignore` (`node_modules`, `dist`, `dist-test`, `test-results`), `npm init -y`, instalar dev deps de Global Constraints. Manifest mínimo: permissões `declarativeNetRequest`, `declarativeNetRequestFeedback`, `storage`, `privacy`, `scripting`, `tabs`; `host_permissions: ["<all_urls>"]`; background `background.js` type module. Background mínimo expõe `niDebug.handle` com `{type:'setEnabled'}` que só instala/remove a regra de bloqueio (ainda sem verificação).
- [ ] **Step 2: Escrever `test/e2e/spike.spec.ts`** com estes testes, cada um registrando o resultado em `console.log` para o relatório:
  - `extension loads headless` — `sw.url()` começa com `chrome-extension://`.
  - `OFF: fetch reaches sink` — `scenarios.fetchGet` → `resolved 200`; `sink.requests.length === 1`.
  - `ON: fetch blocked before TCP` — após `setEnabled true`, `fetchGet` → `rejected TypeError`; `sink.connections === 0`.
  - `onRuleMatchedDebug fires for xhr, main_frame, worker` — listener temporário no sw coleta `info.request.type`; dispara fetch, `page.goto(sink.origin)` e fetch de Dedicated Worker; espera os três tipos.
  - `testMatchOutcome available` — `typeof chrome.declarativeNetRequest.testMatchOutcome === 'function'` e retorna a regra para `{url: sink.origin, type:'xmlhttprequest'}`.
  - `registered MAIN scripts run in order` — registra via `chrome.scripting.registerContentScripts` dois scripts MAIN (`a.js` define `__NI_ORDER__=['a']`, `b.js` faz push `'b'`), navega, lê `['a','b']`.
- [ ] **Step 3: Rodar** `npm test -- test/e2e/spike.spec.ts`. Esperado: todos passam. Qualquer falha: parar, documentar em `docs/blocking.md` e ajustar o design antes das próximas tarefas (falha de headless ⇒ usar `headless:false` sob `xvfb-run`; falha de ordem ⇒ embutir estado no início do bundle de hooks gerando dois bundles de hooks, um por estado).
- [ ] **Step 4:** Escrever resultados em `docs/blocking.md` § "Resultados do spike" (versão do Chromium, cada suposição: confirmada/refutada + evidência).
- [ ] **Step 5: Commit** `chore: scaffold extension, test harness and API spike`

---

### Task 2: Utilitários compartilhados (body, cURL, ring buffer, regex)

**Files:**
- Create: `src/shared/body.ts`, `src/shared/curl.ts`, `src/shared/ring.ts`, `src/shared/regex.ts`
- Test: `test/unit/body.spec.ts`, `test/unit/curl.spec.ts`, `test/unit/ring.spec.ts`, `test/unit/regex.spec.ts`

**Interfaces:**
- Produces:
  - `serializeBody(body: BodyInit | Document | null | undefined, contentType: string | null): Promise<CapturedBody | null>` — roda no MAIN world e em Node (teste). Usa `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`/views, `ReadableStream`, string.
  - `toCurl(r: InterceptedRequest): string`
  - `class RingBuffer<T> { constructor(limit: number); push(x: T): void; setLimit(n: number): void; toArray(): T[]; clear(): void; get size(): number }`
  - `exactUrlRegex(url: string): string` — remove `#fragmento`, escapa metacaracteres, ancora `^…$`. `MAX_REGEX_LEN = 2000`; `canRelease(url) = exactUrlRegex(url).length <= MAX_REGEX_LEN`.

- [ ] **Step 1: Testes falhando** (`test/unit/*.spec.ts`, projeto Playwright `unit` sem browser):
  - body: `'{"a":1}'` + `application/json` → `{type:'json', parsed:{a:1}}`; `'{"a":1}'` + `text/plain` → `json` (parse válido); `'hello'` → `text`; `new URLSearchParams('a=1&a=2')` → `urlencoded`, `params [['a','1'],['a','2']]`; FormData com `name=Rayan` e File `x.txt` (3 bytes, `text/plain`) → fields `[{name:'name',value:'Rayan'},{name:'file',file:{name:'x.txt',type:'text/plain',size:3}}]`; `new Uint8Array([0,1,255])` → `binary`, `size 3`, `previewHex '0001ff'`; Blob 100 bytes → `previewHex` com 128 caracteres hex; `ReadableStream` → `stream`; string de 1 MB + 10 bytes → `text`, `raw.length === 1048576`, e `serializeBody` marca truncamento (adicionar `truncated?: { originalSize: number }` em `text`/`json` no tipo); `null` → `null`.
  - curl: POST JSON com headers `Authorization: Bearer x` e body `{"q":"it's"}` → contém `-X POST`, `-H 'Authorization: Bearer x'`, `--data-raw '{"q":"it'\''s"}'`, URL entre aspas simples; GET sem body não contém `--data`; formdata → `-F 'name=Rayan'` e `-F 'file=@x.txt'`; binary → comentário `# body binário (3 bytes) omitido`.
  - ring: limit 3, push 1..5 → `[3,4,5]`; `setLimit(2)` → `[4,5]`; ordem preservada.
  - regex: `https://a.com/p?x=1.2#frag` → `^https://a\.com/p\?x=1\.2$`; `new RegExp(r).test(url sem fragmento)` true; URL com 3000 chars → `canRelease` false.
- [ ] **Step 2:** `npx playwright test --project=unit` → FAIL (módulos inexistentes).
- [ ] **Step 3:** Implementar os quatro módulos. Body: JSON detectado se content-type contém `json` ou string faz `JSON.parse` válido e começa com `{`/`[`.
- [ ] **Step 4:** `npx playwright test --project=unit` → PASS. `npm run typecheck` → sem erros.
- [ ] **Step 5: Commit** `feat: body serializer, curl generator, ring buffer, url regex`

---

### Task 3: Background — estado, DNR, privacy, status fail-safe, histórico

**Files:**
- Create: `src/background/state.ts`, `dnr.ts`, `privacy.ts`, `status.ts`, `history.ts`
- Modify: `src/background/index.ts`
- Test: `test/e2e/background.spec.ts`

**Interfaces:**
- Consumes: `RingBuffer` (Task 2), tipos (Task 1).
- Produces:
  - `dnr.ts`: `BLOCK_RULE_ID = 1`, `ALL_RESOURCE_TYPES` (lista de §3.2), `installBlockRule(): Promise<void>`, `removeBlockRule(): Promise<void>`, `verifyBlockRule(): Promise<string[]>` (lista de motivos; vazio = ok; usa `getDynamicRules` + `testMatchOutcome` para cada tipo com `http://example.test/`, `https://example.test/`, `ws://example.test/`, `wss://example.test/` conforme o tipo), `addAllowRule(tabId, url, method): Promise<number>`, `removeAllowRule(id): Promise<void>`. Build `__TEST__`: se `storage.local.__test_force_dnr_failure === true`, `installBlockRule` lança erro.
  - `privacy.ts`: `disablePrediction(): Promise<void>`, `restorePrediction(): Promise<void>`, `verifyPrediction(): Promise<string[]>`.
  - `status.ts`: `computeStatus(enabled): Promise<{status: Status; reasons: string[]; warnings: string[]}>` (warnings: modo anônimo não permitido).
  - `history.ts`: `addRecord(partial: Omit<InterceptedRequest,'id'|'seq'>): InterceptedRequest`, `updateRecord(id, patch): void`, `getRecords(tabId?): InterceptedRequest[]`, `clearRecords(): Promise<void>`, `setHistoryLimit(n)`, `loadHistory(): Promise<void>`, `onHistoryChange(cb)`. Persistência `storage.local` key `ni_history` com debounce 300 ms, excluindo `incognito: true`; `seq` contínuo persistido em `ni_seq`.
  - `state.ts`: `getSettings(): Promise<{enabled; mode; limit}>`, `saveSettings(patch)`; key `ni_settings`; defaults `{enabled:false, mode:'fail', limit:1000}`.
  - `index.ts` `niDebug.handle(req: BgRequest)` e `chrome.runtime.onMessage` usam o mesmo `handle`. `setEnabled(true)`: status `ACTIVATING` → `installBlockRule` → `disablePrediction` → `computeStatus`. `setEnabled(false)`: `removeBlockRule` → `restorePrediction` → `OFF`. Toggles serializados por uma fila (promise chain). Badge: PROTECTED `ON` `#d00`, INCOMPLETE `!` `#e80`, OFF vazio. No wake-up (`onStartup`, `onInstalled`, top-level), `loadHistory` e recomputar status; se `enabled` e regra ausente, reinstalar.

- [ ] **Step 1: Testes falhando** em `test/e2e/background.spec.ts`:
  - `enable → PROTECTED` — `setEnabled true` retorna `status 'PROTECTED'`, `reasons []`; `getDynamicRules` contém id 1 com 15 resourceTypes.
  - `disable → OFF, rule removed, prediction restored` — `networkPredictionEnabled.get` → `levelOfControl !== 'controlled_by_this_extension'`.
  - `forced DNR failure → INCOMPLETE` — set `__test_force_dnr_failure`, `setEnabled true` → `status 'INCOMPLETE'`, `reasons.length > 0`; nunca `PROTECTED`.
  - `rule removed externally → INCOMPLETE on getState` — remover a regra via `updateDynamicRules` no sw → `getState` → `INCOMPLETE`.
  - `rapid toggle ON/OFF/ON ends PROTECTED with rule present` (Review Focus 5) — três `setEnabled` sem await entre eles, `Promise.all`; estado final `PROTECTED` e regra presente; durante a sequência, nenhuma resposta `PROTECTED` com `enabled:false`.
  - `history persists across SW restart` (Review Focus 3) — inserir via `niDebug.addRecord(partial)` (exposto só em `__TEST__`; o mapeamento de `hookRecord` só chega na Task 6); usar `sw.evaluate(() => (self as any).niDebug.reloadFromStorage())` que zera memória e chama `loadHistory`; registro continua; `seq` continua crescendo. Também: `setEnabled true`, reiniciar extensão via `chrome.management`/fechar e reabrir contexto com mesmo `userDataDir` → regra presente e status `PROTECTED`.
  - `limit enforced` — `setLimit 100`, inserir 105 → 100, primeiro `seq` = 6.
  - `incognito records not persisted` — `niDebug.addRecord` com `incognito:true` não aparece em `storage.local.ni_history`.
- [ ] **Step 2:** `npm test -- test/e2e/background.spec.ts` → FAIL.
- [ ] **Step 3:** Implementar módulos com as interfaces acima.
- [ ] **Step 4:** Rodar → PASS; `npm test -- test/e2e/spike.spec.ts` continua PASS.
- [ ] **Step 5: Commit** `feat(background): DNR block rule, fail-safe status, persisted history`

---

### Task 4: Captura de fallback via DNR (navegação, form, img, workers, iframes)

**Files:**
- Create: `src/background/dnrlog.ts`, `test/app/worker.js`, `test/app/sw.js`
- Modify: `src/background/index.ts`, `test/app/app.js`, `test/app/index.html`
- Test: `test/e2e/dnr-capture.spec.ts`

**Interfaces:**
- Consumes: `addRecord` (Task 3).
- Produces: `startDnrLog(): void` — `onRuleMatchedDebug` para `rule.ruleId === BLOCK_RULE_ID` → `addRecord({ source:'dnr', status:'BLOCKED', body:{type:'unavailable', reason:'capturado pela camada de rede'}, headers:[], query: parseada da URL, kind: mapeado do resourceType (`main_frame`, `sub_frame`, `xmlhttprequest`→`other` se não veio de hook…), origin:{tabId, initiator, documentUrl?}, notes:['headers/body indisponíveis: requisição bloqueada na camada de rede'] })`. Ignora hostnames terminando em `blocked.invalid`. `incognito` via `chrome.tabs.get(tabId)` quando `tabId >= 0`.
- Cenários novos em `app.js`: `formSubmit` (form POST com campos para `sink/form`, target iframe oculto), `imgTag`, `workerFetch`, `serviceWorkerFetch` (registra `sw.js` que faz `fetch(sink+'/sw')` ao receber mensagem), `iframeSrc` (iframe `src=sink/frame`), `topNavigation` (retorna após `location` é chamado em nova janela via `window.open`).

- [ ] **Step 1: Testes falhando** — com ON, para cada cenário acima: `sink.connections === 0` e `getRecords` contém registro `source:'dnr'` com URL do sink e `kind` esperado (`form`→ `sub_frame`/`main_frame` conforme target, `image`, `worker`/`other` para workers, `sub_frame`, `main_frame`). Teste `placeholder ignored`: fetch para `https://blocked.invalid/` → nenhum registro.
- [ ] **Step 2:** Rodar → FAIL.
- [ ] **Step 3:** Implementar `dnrlog.ts`; registrar no `index.ts`.
- [ ] **Step 4:** Rodar → PASS.
- [ ] **Step 5: Commit** `feat(background): log DNR-blocked requests as fallback capture`

---

### Task 5: Injeção de content scripts e estado síncrono

**Files:**
- Create: `src/background/injection.ts`, `src/content/bridge.ts`, `src/content/hooks/index.ts` (esqueleto: lê estado, heartbeat), template de estado gerado em `build.mjs`
- Modify: `build.mjs`, `static/manifest.json`, `src/background/index.ts`
- Test: `test/e2e/injection.spec.ts`

**Interfaces:**
- Produces:
  - `syncContentScripts(state: {enabled; mode}): Promise<void>` — (re)registra `ni-state` (MAIN, arquivo `state-on-fail.js`/`state-on-hold.js`/`state-off.js`), `ni-hooks` (MAIN, `hooks.js`), `ni-bridge` (ISOLATED, `bridge.js`), todos `matches:['<all_urls>']`, `allFrames:true`, `matchOriginAsFallback:true`, `runAt:'document_start'`, `persistAcrossSessions:true`. Ordem de registro: estado, hooks, bridge (ou o mecanismo decidido no spike).
  - `injectIntoOpenTabs(state): Promise<{tabId:number; ok:boolean}[]>` — `executeScript` nas abas existentes (MAIN estado + hooks, depois ISOLATED bridge); hooks são idempotentes (`__NI_INSTALLED__`).
  - `broadcastState(state)` — `tabs.sendMessage` `{type:'state', enabled, mode}` → bridge → `EV_TO_PAGE`.
  - Hooks: `getState(): {enabled; mode}` lê `__NI_STATE__`, default `{enabled:true, mode:'fail'}`; `emit(msg)` dispara `EV_TO_BRIDGE`; fila de mensagens até bridge responder `{type:'bridgeReady'}` (bridge emite em `EV_TO_PAGE` ao carregar e repete em resposta a `{type:'ping'}`).
  - Bridge envia `hookHeartbeat` ao bg; `ExtState.warnings` não muda, mas `getState` inclui por aba `tabsWithHooks` (adicionar `hookedTabs: number[]` em `ExtState`).
  - Chamado em: `onInstalled`, `onStartup`, toda mudança de `enabled`/`mode`.

- [ ] **Step 1: Testes falhando**:
  - `state known at document_start` — ON fail, nova página com `<script>` inline que lê `window.__NI_STATE__` → `{enabled:true, mode:'fail'}`; OFF → `enabled:false`.
  - `missing state defaults to ON` — página `about:blank` sem registro (chamar `hooks.js` via `addInitScript` sem estado) → `getState()` exposto em `__NI_DEBUG_GETSTATE__` (só `__TEST__`) retorna enabled true.
  - `open tabs get hooks on enable` — abrir página com OFF **antes** de recarregar a extensão (usar `syncContentScripts` desregistrado + `injectIntoOpenTabs`), depois ON → `__NI_INSTALLED__ === true` e `__NI_STATE__.enabled === true`.
  - `heartbeat` — após abrir página, `getState().hookedTabs` contém a aba.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar. **Step 4:** Rodar → PASS (tarefas anteriores também).
- [ ] **Step 5: Commit** `feat: content script injection with synchronous interceptor state`

---

### Task 6: Hooks fetch, XHR, sendBeacon (modo Falhar) + os 12 cenários HTTP

**Files:**
- Create: `src/content/hooks/fetch.ts`, `xhr.ts`, `beacon.ts`
- Modify: `src/content/hooks/index.ts`, `src/content/bridge.ts`, `src/background/index.ts` (`hookRecord` → `addRecord` com `source:'hook'`, `status:'BLOCKED'` ou `'HELD'`, query parseada, `contentType` do header, `origin.tabId` de `sender.tab.id`, `frameUrl`, `stack`, `incognito` de `sender.tab.incognito`, nota de headers do navegador), `test/app/app.js`
- Test: `test/e2e/http-scenarios.spec.ts`

**Interfaces:**
- Consumes: `serializeBody` (Task 2), `emit`/`getState` (Task 5).
- Produces: `installFetchHook(ctx)`, `installXhrHook(ctx)`, `installBeaconHook(ctx)` com `ctx = { getState; emit; registerHeld(hookId, release: () => void, discard: () => void) }` (`registerHeld` usado na Task 8; nesta task `held` é sempre false quando mode `fail`). Stack: `new Error().stack` sem linhas contendo o próprio script (filtrar por URL do `hooks.js` / `chrome-extension://`). Funções substitutas preservam `name`/`length` e `toString()` retornando o nativo.
- Cenários em `app.js` (todos contra `sink`): `getQuery` (fetch GET `/users?page=2&q=a%20b`), `postJson`, `putJson`, `delete`, `postFormData` (campo + File), `customHeaders` (`X-Custom: 1`), `authorization` (`Authorization: Bearer example-token`), `fetchRequestObject` (`fetch(new Request(url,{method:'POST', body:'{"r":1}', headers:{'Content-Type':'application/json'}}))`), `xhrPost` (retorna eventos), `xhrSync` (XHR síncrono), `beacon` (retorna valor de `sendBeacon`), `earlyInline` (página `early.html` com fetch no primeiro script inline; resultado em `window.__early`).

- [ ] **Step 1: Testes falhando** — tabela de cenários; para cada um, em ON e OFF:
  - ON: outcome — fetch `rejected` `TypeError` `Failed to fetch`; `xhrPost` events `['readystatechange:4','error','loadend']` e `status 0`; `xhrSync` `rejected` `NetworkError`; `beacon` `returned false`. Registro: `postJson` body `{type:'json', parsed:{name:'Rayan', email:'rayan@example.com'}}`, método `POST`, headers contém `['Content-Type','application/json']`; `getQuery` `query [['page','2'],['q','a b']]`; `authorization` headers contém `['Authorization','Bearer example-token']`; `postFormData` `formdata` com arquivo; `fetchRequestObject` body `json` `{r:1}` (Review Focus 1); `earlyInline` registrado e `__early` rejeitado (Review Focus 2); `stack` contém `app.js`. Após todos os cenários ON: **`sink.connections === 0`** e `sink.requests.length === 0`.
  - OFF: cada cenário `resolved 200` (beacon `true`, xhr `load`); `sink.requests` contém método/URL/body exatos (`postJson` body JSON igual); `getRecords()` vazio.
  - Nenhum outcome ON tem `status 200`.
- [ ] **Step 2:** Rodar → FAIL. **Step 3:** Implementar hooks e mapeamento no bg. **Step 4:** Rodar → PASS.
- [ ] **Step 5: Commit** `feat(hooks): intercept fetch, XHR and sendBeacon with network-failure semantics`

---

### Task 7: Hooks WebSocket e EventSource + fechamento de conexões abertas

**Files:**
- Create: `src/content/hooks/websocket.ts`, `eventsource.ts`
- Modify: `src/content/hooks/index.ts`, `test/app/app.js`
- Test: `test/e2e/realtime.spec.ts`

**Interfaces:**
- Produces: `installWebSocketHook(ctx)`, `installEventSourceHook(ctx)`. ON: registra (`kind:'websocket'` / `'eventsource'`), constrói nativo com placeholder de Global Constraints, `Object.defineProperty(instance,'url',{value: original})`. `send()` em socket placeholder registra `kind:'websocket-message'` com `body text`. OFF: nativo normal, instância adicionada a `liveConnections: Set`. Ao receber estado ON: fecha todas em `liveConnections` (`close()`), emite registro com `notes:['conexão aberta antes do ON encerrada pelo interceptor']`, `status:'BLOCKED'`.
- Cenários: `websocket` (abre, envia `"hi"`, retorna eventos), `eventSource` (retorna eventos), `openWsThenEnable` (abre com OFF, aguarda `open`; teste liga; app tenta `send('after')` e retorna eventos/`readyState`).

- [ ] **Step 1: Testes falhando**:
  - ON `websocket`: eventos incluem `error` e `close`; registro `websocket` com URL do sink; registro `websocket-message` com `"hi"`; `sink.connections === 0`.
  - ON `eventSource`: eventos incluem `error`; registro; `sink.connections === 0`.
  - OFF: `websocket` recebe eco `hi` e `sink.wsFrames` contém `hi`; `eventSource` recebe `hello`.
  - `openWsThenEnable`: após ON, `readyState` 3 (CLOSED); `sink.wsFrames` não contém `after`; registro com a nota de encerramento.
  - Página HTTPS não é necessária; teste unitário de hook: placeholder URL começa com `wss://`.
- [ ] **Step 2–4:** Rodar FAIL → implementar → PASS.
- [ ] **Step 5: Commit** `feat(hooks): block WebSocket and EventSource, close live connections on enable`

---

### Task 8: Modo Segurar — Liberar / Descartar

**Files:**
- Create: `src/background/release.ts`
- Modify: hooks `fetch.ts`, `xhr.ts`, `beacon.ts`, `index.ts`; `bridge.ts`; `src/background/index.ts`
- Test: `test/e2e/hold.spec.ts`

**Interfaces:**
- Consumes: `addAllowRule`/`removeAllowRule` (Task 3), `exactUrlRegex`/`canRelease` (Task 2), `registerHeld` (Task 6).
- Produces:
  - Hooks em mode `hold`: fetch retorna promise pendente; XHR fica `readyState 1`; beacon retorna `true`. `registerHeld(hookId, release, discard)`. `release` chama a API nativa com argumentos originais (fetch: `Request`/init originais; XHR: `send` nativo no mesmo objeto; beacon: `sendBeacon` nativo) e emite `heldOutcome` com resultado; `discard` = comportamento do modo Falhar.
  - `release.ts`: `releaseRecord(id): Promise<{ok:boolean; reason?:string}>` — valida `status==='HELD'` e `source==='hook'`, `canRelease(url)` senão `{ok:false, reason:'URL longa demais para regra de liberação'}`; `addAllowRule(tabId,url,method)`; `tabs.sendMessage(tabId,{type:'doRelease', hookId}, {frameId})`; remove a regra ao receber `heldOutcome` ou após 10 s; atualiza registro `RELEASED` + `releaseResult`. Se `heldOutcome.ok === false`, `releaseResult.error` recebe motivo (`'bloqueada pelo bloqueio global: redirect ou service worker'` quando o erro for falha de rede). `discardRecord(id)` → `doDiscard`, status `DISCARDED`.
  - `chrome.tabs.onRemoved` e `webNavigation`/`tabs.onUpdated` (status `loading` com mudança de URL) → registros `HELD` da aba viram `DISCARDED_PAGE_GONE`. (Adicionar permissão `webNavigation` se usada.)
  - Registro guarda `origin.frameId` (adicionar ao tipo) para `sendMessage` ao frame correto.

- [ ] **Step 1: Testes falhando**:
  - `hold keeps fetch pending` — mode hold, `postJson` não resolve em 1 s; registro `HELD`; `sink.connections === 0`.
  - `release sends exactly once` — `release` → outcome `resolved 200`; `sink.requests.length === 1` com body JSON idêntico; registro `RELEASED`, `releaseResult.ok true`; regra allow removida (`getSessionRules` vazio); novo `postJson` volta a ficar `HELD` e sink continua com 1.
  - `release Request object keeps body` (Review Focus 1) — `fetchRequestObject` em hold → release → sink body `{"r":1}`.
  - `release xhr` e `release beacon` — sink recebe 1 cada; XHR emite `load`.
  - `discard` — outcome `rejected TypeError`; sink 0; registro `DISCARDED`.
  - `held dies with page` — hold, navegar a aba (com OFF temporário para permitir) → registro `DISCARDED_PAGE_GONE`.
  - `redirect release fails cleanly` — sink `/redirect` → 302 para `/target` (adicionar ao sink); release → outcome `rejected`; `releaseResult.ok false`; sink recebeu só a requisição inicial e nenhuma em `/target`.
  - `websocket ignores hold` — mode hold, `websocket` → `error`/`close` imediato.
- [ ] **Step 2–4:** FAIL → implementar → PASS (suíte toda).
- [ ] **Step 5: Commit** `feat: hold mode with release and discard`

---

### Task 9: Interfaces — popup, painel DevTools, visualizador

**Files:**
- Create: `static/popup.html`, `static/devtools.html`, `static/panel.html`, `static/viewer.html`, `static/ui.css`, `static/icons/{on,off}-{16,32,48,128}.png`, `src/ui/list-detail.ts`, `src/popup/popup.ts`, `src/devtools/devtools.ts`, `src/devtools/panel.ts`, `src/viewer/viewer.ts`
- Modify: `static/manifest.json` (`action.default_popup`, `devtools_page`, ícones), `src/background/index.ts` (port `ni-ui`, ícone ON/OFF via `action.setIcon`)
- Test: `test/e2e/ui.spec.ts`

**Interfaces:**
- Consumes: mensagens `BgRequest`, port `ni-ui`, `toCurl`.
- Produces: `mountListDetail(root: HTMLElement, opts: { tabId?: number; send: (r: BgRequest) => Promise<unknown> }): void` — lista (colunas método, URL, horário `HH:MM:SS.mmm`, tipo, content-type, status), filtros (texto URL, método, tipo, status; checkbox "só esta aba" quando `tabId`), detalhe com seções General / Request Headers / Query Parameters / Request Payload (interpretado + toggle "ver original") / Origem / Notas, botões "Copiar cURL", "Liberar", "Descartar" (só `HELD` + `hook`; Liberar desabilitado com tooltip quando `!canRelease`). Renderização com `textContent` apenas (nunca `innerHTML` com dados capturados). Lista virtualizada não é necessária; renderiza no máximo os 10000 do limite.
  - Popup: toggle, seletor Falhar/Segurar, campo limite, status com cores (PROTEGIDO vermelho "MODO INTERCEPTAÇÃO ATIVO", INCOMPLETA laranja com `reasons` listadas, DESLIGADO cinza), `warnings`, contadores total/HELD, "Limpar histórico", "Abrir visualizador" (`chrome.tabs.create({url: 'viewer.html'})`), dica "F12 → aba Network Interceptor".
  - DevTools: `chrome.devtools.panels.create('Network Interceptor', 'icons/on-32.png', 'panel.html')`; painel usa `chrome.devtools.inspectedWindow.tabId`.
  - Cópia: `navigator.clipboard.writeText`, fallback `document.execCommand('copy')` com textarea.

- [ ] **Step 1: Testes falhando** (abrem `chrome-extension://<id>/popup.html` e `viewer.html` como páginas):
  - `popup toggle enables` — clicar toggle → texto de status `PROTEGIDO`; `getState().enabled` true.
  - `popup shows INCOMPLETA with reason` — forçar falha DNR → status `PROTEÇÃO INCOMPLETA` + motivo visível.
  - `viewer lists and details` — após `postJson` ON, viewer lista `POST`, URL e `BLOCKED`; clicar → payload mostra `"email": "rayan@example.com"` formatado; headers mostram `Authorization`.
  - `filters` — filtro método `GET` esconde o POST.
  - `copy curl` — botão copiar; ler clipboard (conceder `clipboard-read`) → começa com `curl` e contém `-X POST`; `sink.connections === 0` após copiar.
  - `release button` — mode hold, viewer clica Liberar → status `RELEASED` na lista.
  - `xss safe` — fetch para URL com `<img src=x onerror=window.__pwned=1>` em query → viewer renderiza texto; `window.__pwned` indefinido.
  - `clear` — botão limpar → lista vazia, contador 0.
- [ ] **Step 2–4:** FAIL → implementar → PASS. Verificar manualmente o painel DevTools (Playwright não abre DevTools): carregar `dist/` no Chrome, F12, aba "Network Interceptor" aparece e lista registros da aba.
- [ ] **Step 5: Commit** `feat(ui): popup, DevTools panel and viewer`

---

### Task 10: Documentação, app de teste manual e verificação final

**Files:**
- Create/Modify: `README.md`, `docs/architecture.md`, `docs/blocking.md`, `docs/coverage-matrix.md`, `test/manual.ts` + script `npm run test-app`

**Interfaces:**
- Consumes: tudo.
- Produces:
  - `npm run test-app` sobe sink + app e imprime as URLs (`app?sink=...`) e conta conexões no sink em tempo real no terminal.
  - `README.md`: requisitos (Node 24, Chrome), `npm ci && npm run build`, instalação (`chrome://extensions` → Modo do desenvolvedor → Carregar sem compactação → `dist/`; habilitar modo anônimo), uso (fluxo carregar com OFF → ligar), `npm test`, aviso de dados sensíveis em disco.
  - `docs/architecture.md`: camadas §3.1, diagrama de mensagens (texto/mermaid), estado síncrono, fluxo de toggle, status.
  - `docs/blocking.md`: mecanismos (DNR, privacy, hooks, fallback), por que DNR é a garantia, resultados do spike (Task 1), regra allow e seus riscos.
  - `docs/coverage-matrix.md`: tabela com linhas — fetch, XHR, sendBeacon, WebSocket, EventSource, form, navegação top-level, iframe, img/script/css/font/media, Dedicated Worker, Shared Worker, Service Worker, WebTransport, CSP report, prefetch/preconnect DNS, WebRTC, tráfego interno Chrome, outras extensões, conexões abertas antes do ON, requisições em voo, `chrome://`, modo anônimo — colunas: Bloqueado? / Como / Captura disponível / Liberar? / Limitações / Coberto por teste (nome do spec).
- [ ] **Step 1:** Escrever docs e `test/manual.ts`.
- [ ] **Step 2: Verificação final** — `npm run typecheck` sem erros; `npm run build` gera `dist/` sem `__TEST__` (`grep -r __test_force dist/` vazio); `npm test` → todos PASS; colar resumo da saída em `docs/blocking.md` § "Última execução".
- [ ] **Step 3: Commit** `docs: architecture, blocking mechanisms, coverage matrix, setup`
