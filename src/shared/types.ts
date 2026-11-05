// Modelo de dados compartilhado (spec §3.5).

export type Mode = 'fail' | 'hold';
export type Status = 'OFF' | 'ACTIVATING' | 'PROTECTED' | 'INCOMPLETE';

export type RequestKind =
  | 'fetch' | 'xhr' | 'beacon' | 'websocket' | 'websocket-message' | 'eventsource'
  | 'main_frame' | 'sub_frame' | 'form' | 'image' | 'script' | 'stylesheet' | 'font'
  | 'media' | 'worker' | 'ping' | 'csp_report' | 'webtransport' | 'other';

export type RecordStatus = 'BLOCKED' | 'HELD' | 'RELEASED' | 'DISCARDED' | 'DISCARDED_PAGE_GONE';

export interface Truncation { originalSize: number }

export type CapturedBody =
  | { type: 'json'; raw: string; parsed: unknown; truncated?: Truncation }
  | { type: 'text'; raw: string; truncated?: Truncation }
  | { type: 'urlencoded'; raw: string; params: Array<[string, string]> }
  | {
      type: 'formdata';
      fields: Array<
        | { name: string; value: string }
        | { name: string; file: { name: string; type: string; size: number } }
      >;
    }
  | { type: 'binary'; mime: string | null; size: number; previewHex: string }
  | { type: 'stream'; note: string }
  | { type: 'unavailable'; reason: string };

export interface RequestOrigin {
  tabId: number;          // -1 para workers sem aba
  frameId?: number;
  frameUrl?: string;
  documentUrl?: string;
  initiator?: string;     // do DNR
  stack?: string;         // stack JS sem frames do hook
}

export interface InterceptedRequest {
  id: string;
  seq: number;
  timestamp: string;
  url: string;
  method: string;
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  contentType: string | null;
  body: CapturedBody | null;
  kind: RequestKind;
  source: 'hook' | 'dnr';
  status: RecordStatus;
  releaseResult?: { ok: boolean; status?: number; error?: string };
  origin: RequestOrigin;
  notes: string[];
  incognito?: boolean;
  hookId?: string;        // id local do hook (release/discard)
}

export interface ExtState {
  enabled: boolean;
  mode: Mode;
  limit: number;
  status: Status;
  reasons: string[];
  warnings: string[];
  count: number;
  heldCount: number;
  hookedTabs: number[];
}

/** Registro produzido pelo hook no MAIN world; o background completa id/seq/status. */
export interface HookRecord {
  hookId: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: CapturedBody | null;
  kind: RequestKind;
  held: boolean;
  frameUrl: string;
  stack: string;
  timestamp: string;
  notes?: string[];
}
