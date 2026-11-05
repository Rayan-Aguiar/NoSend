// Background mínimo da Task 1 (spike). Substituído/expandido na Task 3.
import type { BgRequest } from '../shared/messages';

const BLOCK_RULE_ID = 1;
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
] as chrome.declarativeNetRequest.ResourceType[];

async function handle(req: BgRequest): Promise<unknown> {
  switch (req.type) {
    case 'setEnabled':
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [BLOCK_RULE_ID],
        addRules: req.enabled
          ? [{
              id: BLOCK_RULE_ID,
              priority: 1,
              action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
              condition: { resourceTypes: ALL_RESOURCE_TYPES },
            }]
          : [],
      });
      return { enabled: req.enabled };
    default:
      return { error: 'not implemented' };
  }
}

(globalThis as any).niDebug = { handle };
