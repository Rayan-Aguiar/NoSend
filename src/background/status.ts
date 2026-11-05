// Status de proteção fail-safe (spec §3.7). PROTECTED só com todas as verificações ok.
import type { Status } from '../shared/types';
import { verifyBlockRule } from './dnr';
import { verifyPrediction } from './privacy';

export interface StatusResult { status: Status; reasons: string[]; warnings: string[] }

async function warnings(): Promise<string[]> {
  const allowed = await new Promise<boolean>((r) => chrome.extension.isAllowedIncognitoAccess(r));
  return allowed ? [] : ['Modo anônimo não permitido para a extensão: abas anônimas NÃO são bloqueadas.'];
}

/** Lacunas permanentes (spec §4): informativas, não rebaixam o status, mas ficam visíveis. */
export const PERMANENT_GAPS = [
  'Conexões (WebSocket, EventSource, uploads, WebTransport) abertas antes de ligar podem continuar ativas: ligue o interceptor antes de abrir a funcionalidade que conecta.',
  'Requisições de workers, formulários, navegações e tags HTML são bloqueadas, mas registradas sem headers/body.',
  'Não bloqueado: WebRTC, tráfego interno do Chrome, outras extensões, requisições já em voo no momento de ligar.',
  'Não verificado: uploads da Reporting API (CSP report-to, NEL) — ver docs/coverage-matrix.md.',
];

export async function computeStatus(enabled: boolean, extraReasons: string[] = []): Promise<StatusResult> {
  const base = await warnings();
  if (!enabled) return { status: 'OFF', reasons: [], warnings: base };
  const w = [...base, ...PERMANENT_GAPS];
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
