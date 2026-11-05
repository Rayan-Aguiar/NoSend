# Mecanismos de bloqueio

> Documento completo na Task 10. Esta seção registra os resultados do spike (Task 1).

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
