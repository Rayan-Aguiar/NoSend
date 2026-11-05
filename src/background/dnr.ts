// Camada de bloqueio (spec §3.2): única barreira de segurança.
import { exactUrlRegex } from '../shared/regex';

type RT = chrome.declarativeNetRequest.ResourceType;

export const BLOCK_RULE_ID = 1;
const ALLOW_RULE_BASE_ID = 1000;

/** TODOS os tipos, explícitos: se omitido, o DNR exclui main_frame por padrão. */
export const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
] as RT[];

function blockRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: BLOCK_RULE_ID,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: { resourceTypes: [...ALL_RESOURCE_TYPES] },
  };
}

export async function installBlockRule(): Promise<void> {
  if (__TEST__) {
    const { __test_force_dnr_failure } = await chrome.storage.local.get('__test_force_dnr_failure');
    if (__test_force_dnr_failure === true) throw new Error('falha forçada na instalação da regra DNR (teste)');
  }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [BLOCK_RULE_ID], addRules: [blockRule()] });
}

export async function removeBlockRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [BLOCK_RULE_ID] });
}

function sampleUrls(type: RT): string[] {
  if (type === 'websocket') return ['ws://example.test/', 'wss://example.test/'];
  return ['http://example.test/', 'https://example.test/'];
}

/** Verifica a regra instalada e o resultado real do matcher. Lista vazia = ok. */
export async function verifyBlockRule(): Promise<string[]> {
  const reasons: string[] = [];
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = rules.find((r) => r.id === BLOCK_RULE_ID);
  if (!rule) return ['regra de bloqueio DNR ausente'];

  const c = rule.condition;
  const types = new Set(c.resourceTypes ?? []);
  const missing = ALL_RESOURCE_TYPES.filter((t) => !types.has(t));
  if (rule.action.type !== 'block') reasons.push('regra de bloqueio DNR com ação diferente de block');
  if (missing.length) reasons.push(`regra de bloqueio DNR sem os tipos: ${missing.join(', ')}`);
  if (c.urlFilter || c.regexFilter || c.requestDomains || c.initiatorDomains || c.requestMethods || c.tabIds || c.domainType) {
    reasons.push('regra de bloqueio DNR com condição restritiva inesperada');
  }

  const dnr = chrome.declarativeNetRequest as any;
  if (typeof dnr.testMatchOutcome !== 'function') {
    reasons.push('testMatchOutcome indisponível: bloqueio não pôde ser confirmado (instale a extensão descompactada)');
    return reasons;
  }
  const failed: string[] = [];
  await Promise.all(
    ALL_RESOURCE_TYPES.flatMap((type) =>
      sampleUrls(type).map(async (url) => {
        try {
          const out = await dnr.testMatchOutcome({ url, type });
          const ok = (out?.matchedRules ?? []).some((m: any) => m.ruleId === BLOCK_RULE_ID && m.rulesetId === '_dynamic');
          if (!ok) failed.push(`${type} ${url}`);
        } catch (e) {
          failed.push(`${type} ${url} (${(e as Error).message})`);
        }
      }),
    ),
  );
  if (failed.length) reasons.push(`matcher DNR não confirmou bloqueio para: ${failed.sort().join('; ')}`);
  return reasons;
}

/** Exceção estreita para Liberar (spec §3.2). Retorna o id da regra de sessão. */
/** Métodos que o DNR conhece; qualquer outro (PROPFIND, REPORT…) só é casável como 'other'. */
const DNR_METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);
export function dnrMethod(method: string): string {
  const m = method.toLowerCase();
  return DNR_METHODS.has(m) ? m : 'other';
}

export async function addAllowRule(tabId: number, url: string, method: string): Promise<number> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const id = Math.max(ALLOW_RULE_BASE_ID - 1, ...existing.map((r) => r.id)) + 1;
  const methods = Array.from(new Set([dnrMethod(method), 'options'])) as chrome.declarativeNetRequest.RequestMethod[];
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id,
      priority: 2,
      action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
      condition: {
        tabIds: [tabId],
        regexFilter: exactUrlRegex(url),
        requestMethods: methods,
        resourceTypes: ['xmlhttprequest', 'ping'] as RT[],
      },
    }],
  });
  return id;
}

export async function removeAllowRule(id: number): Promise<void> {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
}

/** Remove todas as regras de liberação (ex.: ao iniciar o service worker). */
export async function removeAllAllowRules(): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ids = existing.filter((r) => r.id >= ALLOW_RULE_BASE_ID).map((r) => r.id);
  if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}
