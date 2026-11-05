import { isIncognitoTab } from './incognito';
// Captura de fallback (spec §3.1): registra o que o DNR bloqueou e os hooks não viram
// (navegações, <form>, <img>, CSS, workers, service workers). Só URL, método, tipo e origem.
import type { RequestKind, RequestOrigin } from '../shared/types';
import { BLOCK_RULE_ID } from './dnr';
import { addRecord } from './history';

type DnrRequest = chrome.declarativeNetRequest.RequestDetails;

const DIRECT_KINDS: Record<string, RequestKind> = {
  main_frame: 'main_frame',
  sub_frame: 'sub_frame',
  image: 'image',
  script: 'script',
  stylesheet: 'stylesheet',
  font: 'font',
  media: 'media',
  ping: 'ping',
  csp_report: 'csp_report',
  webtransport: 'webtransport',
  websocket: 'websocket',
};

/**
 * Tipo do registro a partir do resourceType do DNR.
 * `xmlhttprequest`: com ON, fetch/XHR de páginas com hooks nunca chegam à rede, então o que
 * aparece aqui veio de um contexto sem hooks. Sem aba/frame/documento (tabId -1, frameId -1
 * ou sem documentId) ⇒ `worker` (ex.: service worker). Caso contrário ⇒ `other`: o fetch de
 * um Dedicated Worker chega com o tabId, frameId e documentId da página e é indistinguível.
 */
export function kindFor(req: Pick<DnrRequest, 'type' | 'tabId' | 'frameId' | 'documentId'>): RequestKind {
  const direct = DIRECT_KINDS[req.type];
  if (direct) return direct;
  if (req.type === 'xmlhttprequest') {
    return req.tabId < 0 || req.frameId < 0 || !req.documentId ? 'worker' : 'other';
  }
  return 'other';
}

function isPlaceholder(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'blocked.invalid' || host.endsWith('.blocked.invalid');
  } catch {
    return false;
  }
}

function parseQuery(url: string): Array<[string, string]> {
  try {
    return [...new URL(url).searchParams.entries()];
  } catch {
    return [];
  }
}

const isIncognito = isIncognitoTab;

/** URL do documento que fez a requisição (para navegação de iframe: o documento pai). */
async function documentUrlFor(req: DnrRequest): Promise<string | undefined> {
  const documentId = req.documentId ?? (req.type === 'sub_frame' ? req.parentDocumentId : undefined);
  if (!documentId) return undefined;
  try {
    return (await chrome.webNavigation.getFrame({ documentId }))?.url || undefined;
  } catch {
    return undefined;
  }
}

async function record(req: DnrRequest): Promise<void> {
  const [incognito, documentUrl] = await Promise.all([isIncognito(req.tabId), documentUrlFor(req)]);
  const origin: RequestOrigin = { tabId: req.tabId, frameId: req.frameId };
  if (req.initiator) origin.initiator = req.initiator;
  if (documentUrl) origin.documentUrl = documentUrl;
  addRecord({
    timestamp: new Date().toISOString(),
    url: req.url,
    method: (req.method || 'GET').toUpperCase(),
    query: parseQuery(req.url),
    headers: [],
    contentType: null,
    body: { type: 'unavailable', reason: 'capturado pela camada de rede' },
    kind: kindFor(req),
    source: 'dnr',
    status: 'BLOCKED',
    origin,
    notes: ['headers/body indisponíveis: requisição bloqueada na camada de rede'],
    incognito,
  });
}

/**
 * Registra o listener (chamar no topo do service worker, para valer em todo wake-up).
 * `ready`: promessa de inicialização do histórico; registros esperam por ela para não serem
 * descartados por um `loadHistory` ainda em andamento.
 */
export function startDnrLog(ready: Promise<unknown> = Promise.resolve()): void {
  chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
    if (info.rule.ruleId !== BLOCK_RULE_ID || info.rule.rulesetId !== '_dynamic') return;
    if (isPlaceholder(info.request.url)) return;
    void ready
      .catch(() => {})
      .then(() => record(info.request))
      .catch((e) => console.warn('dnrlog: falha ao registrar', e));
  });
}
