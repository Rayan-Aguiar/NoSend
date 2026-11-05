// Histórico: memória (ring buffer) + chrome.storage.local (spec §3.6).
// Registros de abas anônimas ficam só em memória.
import type { InterceptedRequest } from '../shared/types';
import { RingBuffer } from '../shared/ring';
import { DEFAULT_SETTINGS } from './state';

type Listener = () => void;

let buf = new RingBuffer<InterceptedRequest>(DEFAULT_SETTINGS.limit);
let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();
type EvictListener = (removed: InterceptedRequest[]) => void;
const evictListeners = new Set<EvictListener>();

/** Avisa quem precisa reagir a registros que saem do histórico (limite ou Limpar). */
function evicted(removed: InterceptedRequest[]): void {
  if (!removed.length) return;
  for (const l of evictListeners) { try { l(removed); } catch { /* ouvinte */ } }
}

export function onEvicted(cb: EvictListener): () => void {
  evictListeners.add(cb);
  return () => evictListeners.delete(cb);
}

function notify(): void { for (const l of listeners) { try { l(); } catch { /* listener de UI */ } } }

export async function flushHistory(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  await chrome.storage.local.set({
    ni_history: buf.toArray().filter((r) => !r.incognito),
    ni_seq: seq,
  });
}

function schedulePersist(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushHistory(); }, 300);
}

export async function loadHistory(limit: number): Promise<void> {
  const { ni_history, ni_seq } = await chrome.storage.local.get(['ni_history', 'ni_seq']);
  const stored: InterceptedRequest[] = Array.isArray(ni_history) ? ni_history : [];
  buf = new RingBuffer<InterceptedRequest>(limit);
  for (const r of stored.sort((a, b) => a.seq - b.seq)) buf.push(r);
  seq = Math.max(Number(ni_seq) || 0, stored.length ? stored[stored.length - 1].seq : 0);
  notify();
}

export function addRecord(partial: Omit<InterceptedRequest, 'id' | 'seq'>): InterceptedRequest {
  const rec: InterceptedRequest = { ...partial, id: crypto.randomUUID(), seq: ++seq };
  evicted(buf.push(rec));
  schedulePersist();
  notify();
  return rec;
}

export function findRecord(pred: (r: InterceptedRequest) => boolean): InterceptedRequest | undefined {
  return buf.toArray().find(pred);
}

export function updateRecord(id: string, patch: Partial<InterceptedRequest>): InterceptedRequest | undefined {
  const rec = buf.toArray().find((r) => r.id === id);
  if (!rec) return undefined;
  Object.assign(rec, patch);
  schedulePersist();
  notify();
  return rec;
}

export function getRecords(tabId?: number): InterceptedRequest[] {
  const all = buf.toArray();
  return tabId === undefined ? all : all.filter((r) => r.origin.tabId === tabId);
}

export async function clearRecords(): Promise<void> {
  const removed = buf.toArray();
  buf.clear();
  evicted(removed);
  await flushHistory();
  notify();
}

export function setHistoryLimit(n: number): void {
  evicted(buf.setLimit(n));
  schedulePersist();
  notify();
}

export function onHistoryChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
