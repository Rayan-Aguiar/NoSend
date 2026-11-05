# Network Interceptor

Extensão Chrome (Manifest V3, TypeScript) para desenvolvimento e análise de aplicações web. Quando **ligada**, impede que as requisições das páginas saiam do navegador e **registra localmente** o que teria sido enviado (URL, método, headers definidos pela aplicação, query, body interpretado, origem/stack), com visualização parecida com a aba Network do DevTools.

Regra fundamental: **nenhuma requisição interceptada chega ao servidor**. O bloqueio é feito na pilha de rede do Chrome (`declarativeNetRequest`), não apenas observado. Os testes automatizados provam isso no nível de conexão TCP.

O que a extensão **não** cobre (tráfego interno do Chrome, outras extensões, WebRTC, etc.) está em [docs/coverage-matrix.md](docs/coverage-matrix.md).

## Requisitos

- Node.js **24+** (o app de teste manual usa a execução nativa de `.ts` do Node 24).
- Google Chrome ou Chromium recente (manifest exige 121+; desenvolvido e testado com Chrome for Testing 155).

## Build

```bash
npm ci
npm run build      # gera dist/ (build de produção)
```

Outros scripts:

| Script | O que faz |
|---|---|
| `npm run build` | Build de produção em `dist/`. |
| `npm run build:test` | Build de teste em `dist-test/` (inclui a flag de falha forçada do DNR e fixtures de teste). **Nunca carregue `dist-test/` para uso real.** |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | `build:test` + toda a suíte Playwright (unitários + e2e). |
| `npm run test:unit` | Só os testes unitários. |
| `npm run test-app` | Sobe o sink e a app de teste para uso manual (ver abaixo). |

## Instalação

1. Rode `npm run build`.
2. Abra `chrome://extensions`.
3. Ative **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta `dist/` do projeto.
5. (Opcional, recomendado) Em **Detalhes** da extensão, ative **Permitir no modo anônimo**. Sem isso, **abas anônimas não são bloqueadas** — a extensão mostra um aviso permanente enquanto essa permissão estiver desligada.

Depois de um novo `npm run build`, clique no botão de recarregar da extensão em `chrome://extensions`. As abas já abertas recebem os hooks automaticamente (injeção ao instalar/recarregar e ao ligar).

A instalação descompactada é obrigatória: a captura de fallback (`onRuleMatchedDebug`) e a verificação do bloqueio (`testMatchOutcome`) só funcionam em extensões descompactadas.

## Uso

### Fluxo recomendado

1. Com o interceptor **OFF**, abra e carregue a aplicação normalmente (login, navegação até a tela que interessa).
2. **Ligue** o interceptor pelo popup. O status deve ficar **PROTEGIDO**.
3. Interaja com a aplicação. Toda requisição é bloqueada e aparece no histórico.

Com o interceptor ON, **navegações e recarregamentos que vão à rede falham** (recarregar a aba, abrir uma URL nova, enviar um `<form>`). Isso é esperado: a navegação também é uma requisição. Navegações atendidas pelo service worker da página ou pelo bfcache podem "funcionar", porque não tocam a rede — nenhum servidor é contatado. Para recarregar a aplicação, desligue, recarregue e ligue de novo.

Ligue o interceptor **antes** de abrir a funcionalidade que conecta: WebSockets/EventSources abertos pela página antes do ON são fechados ao ligar, mas conexões abertas por workers continuam (ver matriz).

### Status

| Status | Significado |
|---|---|
| **DESLIGADO** | Nada é bloqueado nem registrado. |
| **ATIVANDO** | Ligando; instalação/verificação em andamento. |
| **PROTEGIDO** | Regra de bloqueio presente e idêntica à esperada, matcher do DNR confirmou bloqueio para todos os tipos de recurso, predição de rede desligada e controlada pela extensão. |
| **PROTEÇÃO INCOMPLETA** | Ligado, mas alguma verificação falhou. Os motivos são listados. Não confie no bloqueio até resolver. |

O status é recalculado ao ligar, a cada inicialização do service worker e a cada consulta de estado (abertura do popup/painel). Detalhes em [docs/architecture.md](docs/architecture.md#status-de-proteção).

### Modos

- **Falhar** (padrão): a requisição é registrada como `BLOCKED` e a aplicação recebe uma falha de rede coerente (`fetch` rejeita com `TypeError: Failed to fetch`, XHR dispara `error` com `status` 0, `sendBeacon` retorna `false`, WebSocket/EventSource disparam `error`). Nunca há resposta falsa.
- **Segurar**: requisições `fetch`, XHR assíncrono e `sendBeacon` ficam pendentes como `HELD`. Para cada uma:
  - **Liberar**: a extensão abre uma exceção estreita e temporária e a requisição original é enviada **uma vez**; a aplicação recebe a resposta real. Registro vira `RELEASED`.
  - **Descartar**: a aplicação recebe a falha de rede; nada é enviado. Registro vira `DISCARDED`.
  - Se a aba fechar ou navegar, os `HELD` dela viram `DISCARDED_PAGE_GONE`.
  - WebSocket, EventSource e XHR síncrono não podem ser segurados: falham imediatamente mesmo em Segurar.
  - A liberação é deliberadamente estreita: em redirect ou página controlada por service worker ela falha de forma limpa (a aplicação recebe erro de rede e o registro mostra o motivo). Ver [docs/blocking.md](docs/blocking.md#regra-de-liberação-e-seus-riscos).

Ao desligar, requisições `HELD` existentes continuam `HELD` (você decide liberar ou descartar).

### Visualização

- **Popup** (ícone da extensão): liga/desliga, seletor Falhar/Segurar, limite do histórico (100–10000, padrão 1000), status com motivos e avisos, contadores (total e `HELD`), **Limpar histórico**, **Abrir visualizador**, e a dica "F12 → aba Network Interceptor".
- **Visualizador** (`viewer.html`, aberto pelo popup em uma aba): lista de todos os registros, filtros, detalhe e ações.
- **Painel DevTools**: F12 → aba **Network Interceptor**. Mesmo componente do visualizador, filtrando pela aba inspecionada (com opção de ver todas).
- **Badge do ícone**: vermelho `ON` quando protegido, laranja `!` quando incompleto, laranja `…` ativando, vazio quando desligado.

Na lista: método, URL, horário, tipo, content-type, status. No detalhe: General, Request Headers, Query Parameters, Request Payload (interpretado, com opção de ver o original), Origem (aba, frame, initiator, stack), Notas. Ações: **Copiar como cURL**, **Liberar**/**Descartar** (só registros `HELD` capturados na página).

TODO(UI): confirmar no código da Task 9 (`src/popup/popup.ts`, `src/ui/list-detail.ts`, `src/devtools/*.ts`) os rótulos exatos do popup (toggle, seletor, campo de limite, botões), o checkbox "só esta aba" do painel, o tooltip de Liberar desabilitado e a variante de ícone ON/OFF (`action.setIcon`).

Registros capturados só pela camada de rede (navegação, `<form>`, `<img>`, CSS, workers) não têm headers nem body — apenas URL, método, tipo e origem.

## Testes

```bash
npm test
```

Roda o build de teste (`dist-test/`) e a suíte Playwright: unitários (body, cURL, ring buffer, regex) e e2e com a extensão carregada em um Chromium com perfil temporário. Os e2e sobem dois servidores locais em `127.0.0.1`: o **sink** (recebe as requisições e conta **cada conexão TCP**) e a **app de teste** (outra origem). Com o interceptor ON, a asserção central é `sink.connections === 0`.

Requisitos e variáveis:

- O Chrome precisa conseguir iniciar na máquina (headless por padrão). Em sandboxes que bloqueiam sockets Unix, os testes de navegador não sobem.
- `CHROME_PATH`: caminho do executável do Chrome/Chromium. Padrão: `~/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome`.
- `NI_OUT`: pasta do build usada pelo build e pelos testes (padrão `dist-test` no build de teste). Útil para rodar suítes em paralelo sem conflitar: `NI_OUT=dist-test-x npm test`.
- `HEADED=1`: abre o navegador visível.

Exemplo: `CHROME_PATH=/usr/bin/chromium HEADED=1 npm test`.

### Teste manual

```bash
npm run test-app
```

Sobe o sink e a app de teste, imprime a URL da app (`.../index.html?sink=...`) e mostra no terminal, ao vivo, cada conexão TCP, requisição e frame WebSocket que chega ao sink. Abra a URL no Chrome com a extensão **OFF**, ligue o interceptor e clique nos cenários (um botão por cenário; o resultado visto pela aplicação aparece na página): com ON, nada deve aparecer no terminal. Ctrl+C encerra e imprime os totais.

Com ON, a própria origem da app também é bloqueada. Por isso clique em `prepareWorker` (pré-carrega o código do Dedicated Worker) e `registerSw` (registra o service worker) **antes** de ligar; `openWsThenEnable` abre um WebSocket que deve ser fechado ao ligar.

## Privacidade e dados sensíveis

- O histórico pode conter **tokens, cookies enviados manualmente em headers, senhas e dados pessoais** — é exatamente o que a aplicação tentou enviar.
- Ele fica salvo **sem criptografia** no perfil do Chrome (`chrome.storage.local`, com permissão `unlimitedStorage`) até ser limpo. Use **Limpar histórico** ao terminar e não use a extensão em perfis compartilhados.
- **Nada é enviado para fora da máquina**: a extensão não faz nenhuma chamada de rede, não tem analytics e as páginas da extensão não carregam fontes/CDN externas.
- Registros de abas anônimas ficam **só em memória** e nunca são gravados em disco; somem quando o service worker reinicia ou o histórico é limpo.
- **Copiar como cURL** só copia texto para a área de transferência; nada é executado.

## Documentação

- [docs/architecture.md](docs/architecture.md) — camadas, fluxo de mensagens, estado síncrono, toggle, status, armazenamento, build.
- [docs/blocking.md](docs/blocking.md) — mecanismos de bloqueio, semântica de falha por API, fallback, regra de liberação, resultados do spike.
- [docs/coverage-matrix.md](docs/coverage-matrix.md) — o que é bloqueado, como, o que é capturado e o que não é coberto.
- [docs/superpowers/specs/2026-11-05-network-interceptor-design.md](docs/superpowers/specs/2026-11-05-network-interceptor-design.md) — documento de design.
