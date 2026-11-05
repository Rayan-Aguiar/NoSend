// Status de proteção fail-safe (spec §3.7). PROTECTED só com todas as verificações ok.
import type { Status } from '../shared/types';
import { verifyBlockRule } from './dnr';
import { verifyPrediction } from './privacy';

export interface StatusResult { status: Status; reasons: string[]; warnings: string[] }

async function warnings(): Promise<string[]> {
  const allowed = await new Promise<boolean>((r) => chrome.extension.isAllowedIncognitoAccess(r));
  return allowed ? [] : ['Modo anônimo não permitido para a extensão: abas anônimas NÃO são bloqueadas.'];
}

export async function computeStatus(enabled: boolean, extraReasons: string[] = []): Promise<StatusResult> {
  const w = await warnings();
  if (!enabled) return { status: 'OFF', reasons: [], warnings: w };
  let reasons: string[];
  try {
    const [a, b] = await Promise.all([verifyBlockRule(), verifyPrediction()]);
    reasons = [...extraReasons, ...a, ...b];
  } catch (e) {
    reasons = [...extraReasons, `verificação falhou: ${(e as Error).message}`];
  }
  reasons = Array.from(new Set(reasons));
  return { status: reasons.length ? 'INCOMPLETE' : 'PROTECTED', reasons, warnings: w };
}
