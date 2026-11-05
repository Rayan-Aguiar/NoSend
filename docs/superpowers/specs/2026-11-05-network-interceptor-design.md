# Network Interceptor — Documento de Design

Data: 2026-11-05
Status: aguardando aprovação

## 1. Intenção

Extensão Chrome (Manifest V3, TypeScript) para uso em desenvolvimento/análise de aplicações web. Quando ligada, **impede** que requisições saiam do navegador e **registra localmente** o que teria sido enviado, com visualização similar à aba Network do DevTools.

Regra fundamental: **nenhuma requisição interceptada pode chegar ao servidor.** Não basta observar; é preciso impedir.

O usuário (dev da Fadel) aceitou explicitamente as limitações de uma extensão (seção 4). Não há expectativa de proteção contra tráfego interno do Chrome, outras extensões ou WebRTC — mas essas lacunas precisam estar documentadas e visíveis.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Bloqueio forte de toda comunicação HTTP/HTTPS/WS/WSS iniciada por páginas web, incluindo navegações, formulários, iframes, workers, service workers e scripts de terceiros.
- Captura fiel: URL, método, headers definidos pela aplicação, query params, body interpretado (JSON, FormData, URLSearchParams, texto, binário), timestamp, tipo, origem (stack/frame), status.
- Comportamento de falha de rede coerente para a aplicação (nunca resposta 200 falsa).
- Modo opcional "Segurar" com ação **Liberar** / **Descartar**.
- Painel DevTools + popup de controle + visualizador em aba.
- Testes que provam ausência de recebimento no servidor (nível de conexão TCP).

**Não-objetivos**
- Simular backend / respostas falsas.
- Proteger contra tráfego interno do Chrome, outras extensões, WebRTC, apps nativos.
- Publicação na Chrome Web Store (instalação apenas descompactada/modo dev).
- `chrome.debugger` na v1.

**Anti-objetivos (seria fracasso mesmo "funcionando")**
- Interface mostrar "PROTEGIDO" quando algum mecanismo de bloqueio não foi confirmado.
- Qualquer dado capturado sair da máquina.
- Escopo reduzido silenciosamente a fetch/XHR.
- Testes que só checam a UI dizendo BLOCKED, sem checar o servidor.

## 3. Arquitetura

### 3.1 Camadas

| Camada | Mecanismo | Responsabilidade |
|---|---|---|
| **Bloqueio (garantia)** | `chrome.declarativeNetRequest` — regra dinâmica `block` | Única barreira de segurança. Atua na pilha de rede antes de qualquer conexão. |
| **Endurecimento** | `chrome.privacy.network.networkPredictionEnabled = false` enquanto ON | Corta DNS prefetch / preconnect (vazamento de hostname). Restaurado (`clear()`) ao desligar. |
| **Captura rica + semântica** | Content script `world: "MAIN"`, `run_at: document_start`, `all_frames: true`, `match_origin_as_fallback: true`, `match_about_blank: true` | Hooks em `fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, `WebSocket`, `EventSource`. Captura body original + stack; produz erro de rede coerente; implementa Segurar/Liberar. |
| **Ponte** | Content script `world: "ISOLATED"` | Recebe eventos do MAIN world e repassa ao background via `chrome.runtime`. |
| **Captura de fallback** | `declarativeNetRequest.onRuleMatchedDebug` (requer `declarativeNetRequestFeedback`; só funciona em extensão descompactada — que é o caso) | Registra tudo que o DNR bloqueou e os hooks não viram: navegações, `<form>`, `<img>`, CSS, workers, service workers. Só URL, método, tipo, tabId, initiator. |
| **Estado/armazenamento** | Background service worker + `chrome.storage.local` | Estado ON/OFF, modo, configurações, histórico (ring buffer). |
| **Visualização** | Popup, painel DevTools (`chrome.devtools.panels`), página visualizadora (`viewer.html`) | Controle e inspeção. |

### 3.2 Regras DNR

- Regra de bloqueio: id fixo, prioridade 1, `action: block`, condição sem `urlFilter`, **com `resourceTypes` listando explicitamente TODOS os tipos** (`main_frame`, `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`, `xmlhttprequest`, `ping`, `csp_report`, `media`, `websocket`, `webtransport`, `webbundle`, `other`). Se omitido, o DNR exclui `main_frame` por padrão — isso é um bug a evitar.
- Regra dinâmica (não de sessão) para persistir entre reinícios do navegador: se o Chrome reabrir com ON, o bloqueio já existe antes de qualquer página carregar.
- Escopo: **global** (todas as abas). Escopo por aba foi descartado porque requisições de service workers chegam com `tabId = -1` e escapariam.
- Navegações que chegam à rede são bloqueadas. Consequência aceita pelo usuário: com ON, recarregar a aba, abrir nova URL ou enviar `<form>` falha. Fluxo esperado: carregar a aplicação com OFF, ligar, interagir. Navegações atendidas por service worker ou bfcache não tocam a rede, então "funcionam" — inofensivo (nenhum servidor contatado), mas UI e matriz não devem afirmar que toda navegação falha.
- Liberação (modo Segurar): regra **de sessão** `allow`, prioridade 2, condição `tabIds: [tabId]`, `regexFilter` = URL exata escapada e ancorada (`^...$`), `requestMethods: [método, "options"]` (inclui preflight CORS), `resourceTypes: ["xmlhttprequest", "ping"]`. Regex construída a partir da URL normalizada sem `#fragmento`. Removida assim que a requisição liberada termina (hook reporta) ou após timeout de 10 s, o que vier primeiro. Risco documentado: durante essa janela, outra requisição idêntica (mesma aba, URL e método) também passaria. URLs que excedam o limite de regex do DNR não podem ser liberadas — o botão fica desabilitado com explicação.
- **Liberação é deliberadamente estreita** (decisão do designer: segurança acima de conveniência). Casos fora da regra — página controlada por service worker (requisição chega à rede com `tabId -1`), redirects para outra URL — **não** alargam a regra: a liberação falha de forma limpa, o registro vira `RELEASED` com `releaseResult.ok = false` e motivo ("bloqueada pelo bloqueio global: redirect / service worker"), a aplicação recebe erro de rede. Esses casos entram na matriz de cobertura. Teste de Segurar usa requisição simples, sem service worker.

### 3.3 Estado síncrono nos hooks

Os hooks precisam saber **sincronamente**, no momento da chamada, se o interceptor está ON e em qual modo — um `fetch` disparado no primeiro script da página não pode esperar uma ida ao background.

Mecanismo: o background registra dinamicamente (`chrome.scripting.registerContentScripts`) um pequeno script MAIN-world de estado (`state-on-fail.js`, `state-on-hold.js` ou `state-off.js`, ou equivalente com o estado embutido) que roda em `document_start` **antes** do script de hooks. Ao mudar o estado, o background re-registra e também envia mensagem para abas já abertas (ISOLATED → MAIN via evento) atualizando o estado em memória.

Fail-safe: se os hooks rodarem sem estado conhecido, assumem **ON (modo Falhar)**. Isso vale também quando a ponte com o background estiver quebrada.

Se a ordem de execução dos scripts registrados não puder ser garantida no spike, o construtor pode trocar por outro mecanismo síncrono equivalente, mantendo a regra fail-safe acima.

### 3.4 Comportamento dos hooks com ON

Princípio: **com ON, o hook nunca entrega a URL original a uma API de rede nativa** (exceto na liberação explícita). O DNR é a segunda camada caso o hook falhe ou seja contornado.

| API | Modo Falhar | Modo Segurar | Liberar | Descartar |
|---|---|---|---|---|
| `fetch(input, init)` (inclui `Request` como input — ler body via `clone()`) | Registra; rejeita com `TypeError("Failed to fetch")` em microtask | Registra como `HELD`; promise fica pendente | Background instala regra allow → hook chama `fetch` nativo com argumentos originais; promise resolve/rejeita com o resultado real | Rejeita com `TypeError` |
| `XMLHttpRequest` (patch em `open`, `setRequestHeader`, `send` do protótipo) | Registra; assíncrono: `readyState` 4, `status` 0, dispara `readystatechange`, `error`, `loadend`. Síncrono (`async=false`): lança `DOMException` `NetworkError` | Registra `HELD`; XHR fica em `readyState` 1 | Chama `send` nativo no mesmo objeto com o body original | Como Falhar |
| `navigator.sendBeacon` | Registra; retorna `false` | Registra `HELD`; retorna `true` | Chama `sendBeacon` nativo | Nada a enviar; marca descartado |
| `WebSocket` | Registra; não há Segurar. Construtor nativo chamado com URL reservada não roteável (**sempre** `wss://blocked.invalid/` — `ws://` em página HTTPS lança `SecurityError` de mixed content) para obter objeto genuíno que dispara `error` + `close` reais; sobrescreve `url` na instância para mostrar a URL original. `send()` registra cada mensagem tentada. | igual Falhar | — | — |
| `EventSource` | Mesmo padrão de WebSocket (`https://blocked.invalid/`) | igual Falhar | — | — |

Outros comportamentos:
- **Placeholders não geram registro duplicado:** requisições a `*.blocked.invalid` (e relatórios CSP decorrentes delas) capturadas pelo `onRuleMatchedDebug` são descartadas pelo background. Se o CSP da página (`connect-src`) bloquear o placeholder, o resultado continua sendo `error`/`close` — aceitável. Regra geral: um registro por tentativa; com ON, requisições tratadas pelo hook nunca chegam à rede, então não há outra fonte de duplicata.
- **Abas já abertas** ao instalar/recarregar/habilitar a extensão ou ao ligar: o background injeta script de estado + hooks + ponte via `chrome.scripting.executeScript` (`allFrames`, MAIN e ISOLATED). Captura nessas abas vale só para chamadas feitas depois da injeção; o bloqueio DNR vale desde o início. Abas onde a injeção falhar (ex.: `chrome://`) ficam como "bloqueando, captura reduzida".
- **Conexões já abertas ao ligar:** os hooks mantêm registro de WebSockets/EventSources criados na página; ao receber ON, fecham todos e registram "encerrada pelo interceptor". Conexões abertas por workers não são alcançáveis (limitação documentada; dica na UI: ligar o interceptor antes de abrir a funcionalidade que conecta).
- **Requisições HELD morrem com a página:** se a aba navega/fecha, os registros `HELD` viram `DESCARTADA (página encerrada)`.
- **Fidelidade dos hooks:** o patch deve preservar `name`, `length`, `toString()` das funções e `instanceof` quando razoável. Não é requisito resistir a scripts hostis — o DNR cobre isso.
- **Iframes:** `all_frames` + `match_about_blank` + `match_origin_as_fallback` cobrem iframes, incluindo `about:blank`/`srcdoc`. Acesso síncrono a `iframe.contentWindow.fetch` antes da injeção é bypass conhecido do hook, coberto pelo DNR.
- **Workers:** não recebem hooks. Requisições são bloqueadas pelo DNR e registradas via `onRuleMatchedDebug` sem body/headers.

### 3.5 Registro (modelo de dados)

```ts
interface InterceptedRequest {
  id: string;                 // uuid
  seq: number;                // monotônico global, define ordem cronológica
  timestamp: string;          // ISO 8601
  url: string;
  method: string;
  query: Array<[string, string]>;   // preserva repetidos e ordem
  headers: Array<[string, string]>; // definidos pela aplicação, ordem original
  contentType: string | null;
  body: CapturedBody | null;
  kind: 'fetch' | 'xhr' | 'beacon' | 'websocket' | 'websocket-message' | 'eventsource'
      | 'main_frame' | 'sub_frame' | 'form' | 'image' | 'script' | 'stylesheet' | 'font'
      | 'media' | 'worker' | 'other';
  source: 'hook' | 'dnr';     // quem capturou
  status: 'BLOCKED' | 'HELD' | 'RELEASED' | 'DISCARDED' | 'DISCARDED_PAGE_GONE';
  releaseResult?: { ok: boolean; status?: number; error?: string };
  origin: {
    tabId: number;            // -1 para workers sem aba
    frameUrl?: string;
    documentUrl?: string;
    initiator?: string;       // do DNR
    stack?: string;           // stack JS sem frames do hook
  };
  notes: string[];            // ex.: "headers adicionados pelo navegador (Cookie, User-Agent, Sec-*) não incluídos"
}

type CapturedBody =
  | { type: 'json'; raw: string; parsed: unknown }
  | { type: 'text'; raw: string }
  | { type: 'urlencoded'; raw: string; params: Array<[string, string]> }
  | { type: 'formdata'; fields: Array<{ name: string; value: string } | { name: string; file: { name: string; type: string; size: number } }> }
  | { type: 'binary'; mime: string | null; size: number; previewHex: string } // primeiros 64 bytes
  | { type: 'stream'; note: string }   // ReadableStream: não consumido
  | { type: 'unavailable'; reason: string }; // ex.: capturado pelo DNR
```

- JSON detectado por content-type `*json*` **ou** string que faz parse válido. Exibição formatada; `raw` preservado para inspeção do original.
- Texto acima de 1 MB é truncado no registro com nota (`raw` truncado, tamanho real informado).
- `ReadableStream` como body: não lido (lê-lo consumiria o stream). No modo Segurar, o original é mantido para a liberação.
- O objeto original (body real, `Request`, XHR) fica **apenas em memória da página** para liberação; nunca é enviado ao background.

### 3.6 Armazenamento

- Background mantém histórico em memória + persiste em `chrome.storage.local` (escrita com debounce; recarrega ao acordar o service worker).
- Ring buffer, limite configurável (padrão 1000, faixa 100–10000), descarta os mais antigos.
- Ordem por `seq`.
- Botão limpar apaga memória + storage.
- Nenhuma chamada de rede externa em nenhum ponto da extensão. Sem analytics, sem fontes/CDN externas nas páginas da extensão. CSP padrão MV3.
- Aviso na documentação: dados ficam em disco sem criptografia no perfil do Chrome.
- **Modo anônimo:** manifest `incognito: "spanning"`. Registros vindos de abas anônimas ficam marcados (`incognito: true`) e **só em memória** — nunca são gravados em `chrome.storage.local`. Somem quando o service worker reinicia ou o histórico é limpo.

### 3.7 Status de proteção (fail-safe)

Estados exibidos: `DESLIGADO`, `ATIVANDO`, `PROTEGIDO`, `PROTEÇÃO INCOMPLETA` (com lista de motivos).

`PROTEGIDO` só é exibido se **todas** as verificações passarem:
1. `getDynamicRules()` contém a regra de bloqueio idêntica à esperada.
2. `testMatchOutcome` confirma bloqueio para cada `resourceType` com URLs de amostra `http`, `https`, `ws`, `wss`.
3. `networkPredictionEnabled` está em `false` com `levelOfControl` = `controlled_by_this_extension`.

Rodam ao ligar, ao acordar o service worker (`onStartup`, `onInstalled`, primeira mensagem) e a cada abertura do popup/painel. Falhas de aba (hooks não reportaram heartbeat) não mudam o estado global, mas a aba aparece como "bloqueando, captura reduzida".

Avisos permanentes (informativos, não rebaixam o status): acesso a modo anônimo desativado (`isAllowedIncognitoAccess`), lacunas da seção 4.

Ordem ao ligar: instalar regra DNR → verificar → privacy → verificar → atualizar estado nos content scripts → status final. Ao desligar: remover regra DNR → restaurar privacy → atualizar estado nos content scripts. Requisições `HELD` existentes ao desligar permanecem HELD (usuário decide).

### 3.8 Interfaces

**Popup**
- Toggle ON/OFF; seletor de modo (Falhar / Segurar).
- Indicador de status (3.7) com motivos quando incompleto.
- Contador de requisições interceptadas (+ contador de HELD pendentes).
- Limpar histórico.
- "Abrir visualizador": abre `viewer.html` em aba (extensões não conseguem abrir o DevTools programaticamente; o popup mostra também a dica "F12 → aba Network Interceptor").
- Badge do ícone: vermelho "ON" quando protegido, laranja "!" quando incompleto, vazio quando OFF. Ícone com variante visual para ON.

**Painel DevTools "Network Interceptor"** e **viewer.html** (mesmo componente de UI):
- Lista: método, URL, horário, tipo, content-type, status.
- Filtros: texto na URL, método, tipo, status; no painel, alternar "esta aba" / "todas".
- Detalhe: General (URL, método, timestamp, status), Request Headers, Query Parameters, Request Payload (visualização interpretada + "ver original"), Origem (aba, frame, initiator, stack), Notas.
- Ações: Copiar como cURL; Liberar / Descartar (somente `HELD` vindos de hook).
- Atualização ao vivo via `chrome.runtime.connect` (port) com o background.

**cURL**: gerado como string pura a partir do registro (método, URL, headers, body com escaping shell seguro; FormData → `-F`, arquivos com placeholder `@<nome>` e comentário). Copiar usa clipboard; não executa nada.

## 4. Limitações aceitas (vão para a matriz de cobertura)

1. Tráfego interno do Chrome (Safe Browsing, updates, sync, telemetria, DoH) — inalcançável por extensões.
2. Requisições de outras extensões — DNR não atua.
3. WebRTC (STUN/TURN/data channels) — não bloqueável pelo DNR. Sem hook na v1 (decisão do construtor se quiser registrar tentativas, mas não conta como bloqueio).
4. Conexões abertas antes do ON por workers — continuam.
5. Requisições já em voo no instante do toggle.
6. Páginas `chrome://`, Chrome Web Store, páginas de outras extensões.
7. Abas anônimas sem permissão de modo anônimo.
8. Headers adicionados pelo navegador (Cookie, User-Agent, Origin, `Sec-*`) não existem no registro, pois o envio nunca ocorre.
9. Requisições de workers, tags HTML, formulários e navegações: bloqueadas, registradas sem headers/body.
10. Liberação: janela curta em que requisição idêntica da mesma aba também passa.
11. Hooks são contornáveis por scripts hostis; o bloqueio não depende deles.

## 5. Estrutura do projeto e ferramentas

- TypeScript estrito; build com **esbuild** (um bundle por entrypoint, formato IIFE para content scripts); `tsc --noEmit` para typecheck.
- Dependências de runtime: **nenhuma**. Dev: `typescript`, `esbuild`, `@types/chrome`, `@playwright/test`.
- UI em DOM/TS puro + CSS próprio (sem framework).
- Saída em `dist/` (pasta carregada no Chrome).

Sugestão de layout (o construtor pode ajustar):
```
src/
  background/   (estado, dnr, privacy, storage, status, mensagens)
  content/      (main-world hooks, state script, isolated bridge)
  shared/       (tipos, body serializer, curl, mensagens)
  ui/           (componente lista/detalhe compartilhado)
  popup/  devtools/  viewer/
test/
  servers/      (sink, app)
  app/          (página de teste)
  unit/  e2e/
docs/           (arquitetura, bloqueio, matriz de cobertura)
```

## 6. Testes

Executor: Playwright (`@playwright/test`) com Chromium já instalado, `launchPersistentContext` + `--load-extension` / `--disable-extensions-except`.

**Servidores (Node puro, sem dependências):**
- **Sink**: porta própria em 127.0.0.1. Registra **cada conexão TCP** (`server.on('connection')`), cada requisição HTTP (método, URL, headers, body), cada upgrade WebSocket (handshake implementado manualmente) e cada frame WS recebido. Endpoints cobrindo os 12 cenários + SSE (`text/event-stream`). Expõe contadores para os testes via API própria em **outra porta** (para consultar o sink não contar como conexão).
- **App**: outra porta, serve a página de teste com botões/funções que disparam cada cenário contra o sink.

**Cenários (cada um ON e OFF):** GET com query; POST JSON; PUT JSON; DELETE; POST FormData (com arquivo); headers personalizados; Authorization; fetch; XHR; sendBeacon; WebSocket; EventSource.
Adicionais: `<form>` submit; `<img>`; fetch em Dedicated Worker; fetch em Service Worker; iframe (mesma origem e `srcdoc`); navegação top-level.

**Asserções com ON:**
- Sink: **zero conexões TCP** durante toda a suíte ON (asserção mais forte que zero requisições).
- Extensão: registro esperado para cada cenário, com body/headers corretos para os capturados por hook; registro `source: 'dnr'` para form/img/worker/navegação.
- Aplicação: fetch rejeita com `TypeError`, XHR dispara `error` com status 0, `sendBeacon` retorna `false`, WS/ES disparam `error`.
- Nenhuma resposta 200 observada pela aplicação.

**Asserções com OFF:** sink recebe todos os cenários; extensão não registra nada; aplicação recebe respostas reais.

**Modo Segurar:** requisição fica pendente; sink 0; Liberar → sink recebe **exatamente uma** requisição idêntica e a aplicação recebe a resposta real; Descartar → sink 0 e aplicação recebe erro de rede; após liberação, a regra allow foi removida (nova requisição igual volta a ser bloqueada).

**Toggle com conexão aberta:** WebSocket aberto com OFF → ligar → conexão fechada; mensagens enviadas depois não chegam ao sink.

**Fail-safe:** build de teste com flag que força falha na instalação da regra DNR → status `PROTEÇÃO INCOMPLETA`, nunca `PROTEGIDO`. A flag não existe no build normal.

**Unitários:** serialização de body (todos os tipos), geração de cURL (escaping), ring buffer (limite, ordem), escape de regex da regra allow.

## 7. Entregáveis

1. Código-fonte.
2. `README.md` com build e instalação via `chrome://extensions` → modo desenvolvedor → "Carregar sem compactação" → `dist/`, incluindo como habilitar no modo anônimo.
3. `docs/architecture.md`.
4. `docs/blocking.md` (mecanismos de bloqueio).
5. `docs/coverage-matrix.md` (o que é bloqueado, como, captura disponível, limitações).
6. Aplicação de teste local (`test/`), com script `npm run test-app` para uso manual.
7. Testes automatizados (`npm test`).

## 8. Suposições a validar no início (spike)

O construtor deve verificar estas antes de construir o resto; se alguma falhar, ajustar o design e registrar no `docs/blocking.md`:
- `onRuleMatchedDebug` dispara para todos os tipos bloqueados, incluindo workers e `main_frame`.
- Content scripts registrados dinamicamente em `world: MAIN` respeitam ordem de registro (script de estado antes dos hooks).
- `testMatchOutcome` disponível na versão de Chromium do Playwright instalada.
- Chromium do Playwright em modo headless carrega extensões (senão, testes rodam headed/`xvfb`).
- Regra DNR bloqueia antes de abrir conexão TCP (comprovado pelo contador de conexões do sink).

## 9. Decisões tomadas pelo designer (podem ser revistas)

- Bloqueio global, não por aba.
- `chrome.debugger` fora da v1.
- Histórico em `chrome.storage.local`, padrão 1000.
- Sem banner/overlay dentro das páginas; evidência visual via badge, ícone e popup.
- Botão "abrir painel" abre `viewer.html` em aba.
- WebSocket/EventSource sem modo Segurar.
- Hooks assumem ON quando o estado é desconhecido.
- Liberação estreita: falha limpa em redirect / service worker em vez de alargar a regra allow.
- Injeção automática nas abas já abertas.
- Registros de abas anônimas só em memória.
- Placeholder de WebSocket sempre `wss://`; registros de placeholders filtrados.

## 10. Deixado ao construtor

- Organização interna de módulos, nomes de mensagens, estilo visual da UI.
- Mecanismo exato de estado síncrono, desde que respeite 3.3.
- Detalhes de escaping do cURL, formato visual do stack.
