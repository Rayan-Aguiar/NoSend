// Configurações persistidas.
import type { Mode } from '../shared/types';

export interface Settings { enabled: boolean; mode: Mode; limit: number }

export const LIMIT_MIN = 100;
export const LIMIT_MAX = 10000;
export const DEFAULT_SETTINGS: Settings = { enabled: false, mode: 'fail', limit: 1000 };

export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.limit;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, Math.round(n)));
}

export async function getSettings(): Promise<Settings> {
  const { ni_settings } = await chrome.storage.local.get('ni_settings');
  return { ...DEFAULT_SETTINGS, ...(ni_settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ ni_settings: next });
  return next;
}
