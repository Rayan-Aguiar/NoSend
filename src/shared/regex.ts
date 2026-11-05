// Regex exata (ancorada) para allow rule DNR de Liberar.
export const MAX_REGEX_LEN = 2000;

export function exactUrlRegex(url: string): string {
  const i = url.indexOf('#');
  const noFrag = i >= 0 ? url.slice(0, i) : url;
  return `^${noFrag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export function canRelease(url: string): boolean {
  return exactUrlRegex(url).length <= MAX_REGEX_LEN;
}
