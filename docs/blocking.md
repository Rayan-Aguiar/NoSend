# Mecanismos de bloqueio

Como a extensão impede que requisições saiam do navegador, o que cada camada garante e onde estão os riscos. Visão geral dos componentes em [architecture.md](architecture.md); tabela por tipo de tráfego em [coverage-matrix.md](coverage-matrix.md).

## Camadas

| Camada | O que faz | É garantia? |
|---|---|---|
| Regra DNR `block` (`src/background/dnr.ts`) | Bloqueia na pilha de rede do Chrome, antes de abrir conexão | **Sim — a única** |
| Predição de rede desligada (`src/background/privacy.ts`) | Corta DNS prefetch / preconnect | Sim, para o nível de conexão (ver "Predição de rede") |
| Hooks MAIN world (`src/content/hooks/`) | Capturam body/headers/stack, produzem falha de rede coerente, implementam Segurar/Liberar | Não |
| `onRuleMatchedDebug` (`src/background/dnrlog.ts`) | Registra o que o DNR bloqueou e os hooks não viram | Não (só observação) |

## Por que o DNR é a garantia e os hooks não

- O DNR atua dentro do processo de rede do Chrome, para **todo** tráfego de páginas: documentos, iframes, tags HTML, formulários, workers, service workers, scripts de terceiros. Não depende de nada que a página possa alterar.
- Os hooks são JavaScript na própria página. São contornáveis por scripts hostis (ex.: pegar `fetch` de um `iframe.contentWindow` antes da injeção, usar referências guardadas antes do `document_start`, rodar em workers, que não recebem hooks). Também podem simplesmente falhar a injeção (`chrome://`, páginas de outras extensões, abas abertas antes da instalação até a injeção).
- Por isso, com ON, o hook **nunca entrega a URL original a uma API de rede nativa** (exceto em Liberar) — mas, se ele falhar, a requisição cai no DNR e é bloqueada mesmo assim (registrada pelo fallback, sem body).
- Os hooks existem para **captura fiel** (body, headers definidos pela aplicação, stack) e **semântica coerente** (a aplicação vê uma falha de rede normal, nunca resposta falsa), e para o modo Segurar.

## A regra de bloqueio

```ts
{
  id: 1, priority: 1,
  action: { type: 'block' },
  condition: { resourceTypes: [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
    'webbundle', 'other',
  ] },
}
```

- **Todos os 15 `resourceTypes` listados explicitamente.** Se `resourceTypes` for omitido, o DNR exclui `main_frame` por padrão — navegações passariam.
- Sem `urlFilter`: vale para qualquer URL de qualquer esquema que o DNR alcança (http, https, ws, wss).
- Escopo **global** (todas as abas). Por aba foi descartado: requisições de service workers chegam com `tabId = -1` e escapariam.
- Regra **dinâmica** (não de sessão): persiste entre reinícios do navegador. Se o Chrome reabrir com ON, o bloqueio já existe antes de qualquer página carregar; o service worker ainda reinstala a regra e a privacy na inicialização. Teste: `background.spec.ts › ON survives browser restart`.
- Verificada antes de mostrar `PROTEGIDO` (regra idêntica + `testMatchOutcome` para cada tipo com URLs `http`/`https`/`ws`/`wss`). Ver [architecture.md](architecture.md#status-de-proteção).

## Predição de rede (obrigatória)

O spike mostrou que, com `networkPredictionEnabled = true` (padrão do Chrome), uma navegação top-level para uma URL **bloqueada** pelo DNR ainda abre conexões TCP com o destino (preconnect do LoadingPredictor), sem enviar bytes HTTP. Detalhes em "Achado: preconnect em navegação bloqueada" abaixo.

Consequências implementadas:

- Ao ligar, `networkPredictionEnabled` é posto em `false` (escopo regular e, se a extensão tiver acesso ao modo anônimo, `incognito_session_only`). Ao desligar, `clear()` devolve o controle ao usuário/padrão.
- Essa configuração faz parte da garantia, não é opcional: `PROTEGIDO` exige `value: false` com `levelOfControl: controlled_by_this_extension`. Se uma política corporativa ou outra extensão controlar a configuração, o status é `PROTEÇÃO INCOMPLETA`.
- Mesmo no pior caso (predição ativa), nenhum dado da requisição (path, headers, body) é transmitido; vaza a existência da conexão (IP/porta e, em HTTPS, o hostname via SNI).

## Hooks e semântica de falha por API

Com ON, o estado é lido **sincronamente** no momento da chamada (ver [architecture.md](architecture.md#estado-síncrono-nos-hooks-33)); estado desconhecido ⇒ ON/Falhar.

| API | Modo Falhar | Modo Segurar | Liberar | Descartar |
|---|---|---|---|---|
| `fetch(input, init)` | Registra; rejeita com `TypeError('Failed to fetch')` (assíncrono, depois de o registro ser emitido). `Request` como input: body lido via `clone()` | `HELD`; promise pendente | `fetch` nativo com os argumentos originais; resolve/rejeita com o resultado real | Rejeita com `TypeError('Failed to fetch')` |
| `XMLHttpRequest` assíncrono (patch em `open`/`setRequestHeader`/`send` do protótipo) | Registra; `readyState` 4, `status` 0, `statusText`/`response`/`responseText`/`responseURL` vazios; dispara `readystatechange`, `error`, `loadend` (em `setTimeout 0`) | `HELD`; XHR fica em `readyState` 1 | `send` nativo no mesmo objeto com o body original | Como Falhar |
| `XMLHttpRequest` síncrono (`async=false`) | Registra; `send` lança `DOMException` `NetworkError` | **Não segura**: falha como no modo Falhar (nota "XHR síncrono: não pode ser segurado") | — | — |
| `navigator.sendBeacon` | Registra (método `POST`, `Content-Type` implícito do body); retorna `false` | `HELD`; retorna `true` (o navegador também retorna `true` ao enfileirar) | `sendBeacon` nativo | Nada a enviar |
| `WebSocket` | Registra; o construtor nativo é chamado com o placeholder `wss://blocked.invalid/` para obter um objeto genuíno que dispara `error` + `close` reais; `url` da instância mostra a URL original. `send()` registra cada mensagem tentada (`websocket-message`, método `SEND`) e chama o `send` nativo do socket placeholder (lança `InvalidStateError` enquanto `CONNECTING`, como o nativo) | Igual Falhar (sem Segurar) | — | — |
| `EventSource` | Igual WebSocket com placeholder `https://blocked.invalid/` | Igual Falhar | — | — |

Notas:

- **Placeholder sempre `wss://`**: `ws://` em página HTTPS lança `SecurityError` de mixed content. `.invalid` é TLD reservado e não resolve. As requisições aos placeholders (e relatórios CSP decorrentes delas) chegam ao DNR e são **descartadas do histórico** pelo fallback, para não duplicar registros. Testes: `realtime.spec.ts › placeholders are non-routable and mixed-content safe`, `dnr-capture.spec.ts › placeholder ignored`. Se o CSP da página (`connect-src`) bloquear o placeholder, o resultado continua `error`/`close`.
- **Validação nativa preservada**: URLs WebSocket inválidas, esquemas não permitidos, fragmentos e `protocols` inválidos lançam as mesmas exceções do construtor nativo, antes de registrar.
- **Fidelidade**: as funções substitutas reportam `name`, `length` e `toString()` nativos (`[native code]`); os construtores de WebSocket/EventSource mantêm protótipo, constantes estáticas e `instanceof`. Testes: `http-scenarios.spec.ts › hooks keep native function identity`, `realtime.spec.ts › constructors keep native identity`. Não é objetivo resistir a scripts hostis.
- **Um hook com falha de instalação não impede os outros**; o DNR continua bloqueando.
- **URLs locais passam direto**: `fetch` e XHR (inclusive síncrono) para `data:`, `blob:`, `about:`, `chrome-extension:` e `javascript:` chamam a API nativa sem registrar (`isLocalUrl` em `src/content/hooks/common.ts`); não são rede. Teste: `local-schemes.spec.ts › ON: data: and blob: URLs keep working and are not recorded`.
- Headers adicionados pelo navegador (Cookie, User-Agent, Origin, `Sec-*`) não existem no registro, porque o envio nunca ocorre. Todo registro de hook traz uma nota dizendo isso.

### Conexões abertas antes do ON

Os hooks guardam os WebSockets e EventSources criados pela página enquanto OFF. Ao receber ON (`onStateChange`):

- Cada conexão ainda aberta é fechada com o `close()` nativo e registrada com a nota "conexão aberta antes do ON encerrada pelo interceptor".
- **WebSocket**: o `close()` nativo envia um **frame de controle close** ao servidor (sem dados da aplicação) antes de encerrar o TCP. É o único byte que chega ao servidor nessa situação. Mensagens enviadas depois do fechamento são registradas e não chegam ao servidor. Teste: `realtime.spec.ts › connection opened while OFF is closed when the interceptor turns ON`.
- **EventSource**: fechado (encerra a conexão HTTP); não há frame de aplicação.
- Só são fechados os sockets criados **pelos hooks** enquanto OFF, em páginas que já tinham hooks. Continuam abertos, e podem continuar enviando dados com status PROTEGIDO (o DNR só atua em requisições novas):
  - WebSocket/EventSource abertos em páginas que só receberam os hooks no momento de ligar (abas já abertas, injetadas no toggle): os objetos nativos foram criados antes do patch e não são rastreáveis do MAIN world;
  - conexões abertas por **workers** (sem hooks);
  - sessões **WebTransport** (sem hook);
  - uploads `fetch` em streaming (body `ReadableStream`) já iniciados.
- Por isso, com ON, os avisos do status (`PERMANENT_GAPS`) sempre pedem para ligar o interceptor **antes** de abrir a funcionalidade que conecta.

## Captura de fallback (`onRuleMatchedDebug`)

`src/background/dnrlog.ts`. Exige a permissão `declarativeNetRequestFeedback` e **só funciona em extensão descompactada** (o caso deste projeto).

- Registra tudo o que a regra de bloqueio (id 1, `_dynamic`) bloqueou: navegações, `<form>`, `<img>`, CSS, fontes, mídia, iframes, workers, service workers, `ping`, relatórios CSP, WebTransport.
- Só URL, método, tipo, `tabId`/`frameId`, `initiator` e a URL do documento (via `webNavigation.getFrame`). `headers: []`, `body: {type: 'unavailable'}`, nota "headers/body indisponíveis: requisição bloqueada na camada de rede". `source: 'dnr'`.
- Ignora placeholders `*.blocked.invalid`.
- Espera a inicialização do histórico (`ready`) antes de gravar, para não perder eventos que chegam no wake-up do service worker.

Tipos (`kindFor`):

| `resourceType` do DNR | `kind` no registro |
|---|---|
| `main_frame`, `sub_frame`, `image`, `script`, `stylesheet`, `font`, `media`, `ping`, `csp_report`, `webtransport`, `websocket` | o mesmo nome |
| `xmlhttprequest` com `tabId < 0`, `frameId < 0` ou sem `documentId` | `worker` (ex.: fetch de **service worker**, `tabId -1`) |
| `xmlhttprequest` com aba/frame/documento | `other` |
| demais (`object`, `webbundle`, `other`) | `other` |

- Com ON, `fetch`/XHR de páginas com hooks nunca chegam à rede; então um `xmlhttprequest` no fallback veio de um contexto sem hooks. O fetch de um **Dedicated Worker** chega com o `tabId`, `frameId` e `documentId` da página — **indistinguível** de um fetch da página — e é registrado como `other`. Teste: `dnr-capture.spec.ts › workerFetch (dedicated worker) → other record`.
- O fetch de um **Service Worker** chega com `tabId -1` → `worker`, sem aba associada. Teste: `dnr-capture.spec.ts › serviceWorkerFetch → worker record`.
- `<form>` enviado a um iframe aparece como `sub_frame` com método `POST`; enviado na aba, como `main_frame` `POST`. O `kind: 'form'` existe no modelo mas o fallback não o produz (o DNR não distingue formulário de navegação). Teste: `dnr-capture.spec.ts › formSubmit (POST, iframe target) → sub_frame record`.

## Regra de liberação e seus riscos

Modo Segurar → **Liberar** (`src/background/release.ts`, `addAllowRule` em `dnr.ts`):

```ts
{
  id: >= 1000, priority: 2,               // vence a regra de bloqueio (prioridade 1)
  action: { type: 'allow' },
  condition: {
    tabIds: [tabId],
    regexFilter: '^<URL exata escapada, sem #fragmento>$',
    requestMethods: [<método>, 'options'], // inclui preflight CORS
    resourceTypes: ['xmlhttprequest', 'ping'],
  },
}
```

- Regra **de sessão** (não sobrevive a reinício do navegador); todas as regras `allow` são removidas em cada inicialização do service worker.
- Removida no **primeiro `onRuleMatchedDebug` do método original** (o match do preflight `OPTIONS` não a remove) ou após **10 s**, o que vier primeiro. Não se espera o resultado reportado pelo hook porque `sendBeacon` retorna antes de a requisição chegar à rede. Teste: `hold.spec.ts › release sends exactly once and removes the allow rule` (inclui: requisição idêntica seguinte volta a ser segurada).
- Só registros `HELD` capturados por hook (`fetch`, XHR assíncrono, `sendBeacon`). Registros do modo Falhar não são liberáveis (`hold.spec.ts › fail mode records are not releasable`).
- URLs cuja regex exceda 2000 caracteres (`MAX_REGEX_LEN`) não podem ser liberadas (`canRelease`); a UI desabilita o botão.

Riscos e limites:

1. **Janela de requisição idêntica**: enquanto a regra existe (até o match do método original ou 10 s), outra requisição **da mesma aba, mesma URL e mesmo método** também passaria. Na prática a janela fecha no primeiro match. Requisições idênticas disparadas por hook continuam sendo seguradas pelo hook (a regra só afeta o que chega à rede), então o risco real é de contextos sem hook na mesma aba (ex.: Dedicated Worker, que chega com o `tabId` da página).
2. **Redirect**: a regra cobre só a URL exata. A requisição original chega ao servidor (é a liberação), mas o redirect para outra URL é bloqueado pela regra global; a aplicação recebe erro de rede e o registro fica `RELEASED` com `releaseResult.ok = false` e motivo "provável bloqueio pelo bloqueio global (redirect ou service worker)". A regra **não** é alargada. Teste: `hold.spec.ts › redirect release fails cleanly`.
3. **Página controlada por service worker**: o `fetch` liberado passa pelo service worker, cuja requisição à rede chega com `tabId -1` e não casa com a regra → falha limpa como no redirect. Não testado automaticamente (o teste de Segurar usa página sem service worker, por design).
4. Se a página/frame que fez a requisição não existir mais, Liberar remove a regra e marca `DISCARDED_PAGE_GONE`. Aba fechada ou navegação também marcam os `HELD` (`hold.spec.ts › held request dies with its page`, `held request discarded when tab closes`).
5. A mensagem de erro de `releaseResult` sempre sugere "redirect ou service worker", mesmo que a falha tenha outra causa (ex.: servidor fora do ar).

### Riscos conhecidos

- **Registro `HELD` forjado**: uma página hostil pode disparar o evento da ponte (`__ni_to_bridge`) com um registro `HELD` falso (com método válido, que passa em `validHookRecord`). Se o usuário clicar **Liberar** nesse registro, a extensão abre a regra `allow` estreita para aquela aba/URL/método; durante essa janela (até o primeiro match ou 10 s) a página pode enviar **um body diferente** por uma referência nativa não interceptada (ex.: `fetch` guardado antes dos hooks ou de um contexto sem hook). Só libere registros de páginas confiáveis.

## Status fail-safe

- `PROTEGIDO` só com: regra presente e idêntica, `testMatchOutcome` confirmando todos os tipos, predição de rede desligada e controlada pela extensão, e nenhum erro na ativação. Qualquer outra coisa → `PROTEÇÃO INCOMPLETA` com motivos.
- O status é recalculado em cada consulta de estado: se a regra for removida por fora, o próximo `getState` mostra incompleto (`background.spec.ts › rule removed externally → INCOMPLETE on getState`).
- O build de teste tem uma flag (`__test_force_dnr_failure` em `chrome.storage.local`) que força a falha da instalação da regra (`background.spec.ts › forced DNR failure → INCOMPLETE`). No build de produção o trecho é removido (`__TEST__ = false`).
- Nos hooks, o fail-safe é o oposto do "desligado": estado desconhecido ⇒ ON/Falhar (`injection.spec.ts › missing state defaults to ON`).
- Ao desligar, a regra DNR é removida primeiro e o estado das páginas por último: na janela intermediária, os hooks ainda falham as requisições.
- Ao ligar, o status final só é publicado depois de as páginas receberem o estado ON (`applyPageState` antes de `refreshStatus`).
- Com ON, os avisos sempre listam as lacunas permanentes (`PERMANENT_GAPS` em `src/background/status.ts`), exibidas no popup (`background.spec.ts › enabled status lists the permanent gaps`).

## Resultados do spike

Ambiente: Chrome for Testing 155.0.8059.12 (Playwright chromium-1247), headless novo, extensão descompactada, Linux (WSL2).

| Suposição (spec §8) | Resultado | Evidência |
|---|---|---|
| Chromium headless carrega extensões | Confirmada | `spike.spec.ts › extension loads headless` |
| DNR bloqueia antes de abrir conexão TCP (fetch) | Confirmada | `ON: fetch blocked before TCP` — sink com 0 conexões |
| `onRuleMatchedDebug` dispara para xhr, worker e main_frame | Confirmada | fetch de Dedicated Worker chega como `xmlhttprequest` com o `tabId` da página; navegação como `main_frame` |
| `testMatchOutcome` disponível | Confirmada | retorna `{matchedRules:[{ruleId:1, rulesetId:"_dynamic"}]}` |
| Scripts MAIN registrados dinamicamente rodam na ordem de registro | Confirmada | `__NI_ORDER__ = ["a","b"]` |

### Achado: preconnect em navegação bloqueada

Com `networkPredictionEnabled = true` (padrão do Chrome), uma navegação top-level para uma URL **bloqueada pelo DNR** ainda fez o Chrome abrir **2 conexões TCP** com o servidor de destino (preconnect do LoadingPredictor), **sem enviar nenhum byte HTTP**. Com `networkPredictionEnabled = false`, **0 conexões**.

Consequência: desligar a predição de rede enquanto o interceptor está ON é **obrigatório** para a garantia "nada chega ao servidor" no nível de conexão — não apenas um endurecimento opcional. Se a extensão não conseguir controlar essa configuração (ex.: política corporativa), o status deve ser `PROTEÇÃO INCOMPLETA`. Mesmo com o preconnect, nenhum dado da requisição (URL path, headers, body) é transmitido; vaza apenas a existência da conexão (IP/porta e, em HTTPS, o hostname via SNI).

Regressão: `test/e2e/spike-preconnect.spec.ts`.

Observação de manutenção: o spike rodou antes de existir `src/background/privacy.ts`. Hoje, `setEnabled` sempre desliga a predição, então a variante `prediction=true` desse teste já não reproduz o preconnect (ela só afirma `requests === 0`); a variante `prediction=false` continua sendo a regressão efetiva (0 conexões).

## Última execução

Data: 2026-11-05. Chrome for Testing 155.0.8059.12 (Playwright chromium-1247), headless. `npm test` → 92 passed, 2 skipped (fixme: Reporting API). Todos os cenários com o interceptor ON afirmam `sink.connections === 0`.
