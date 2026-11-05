// Decide se um registro vem de contexto anônimo. Na dúvida: anônimo (só memória, nunca disco).

export async function resolveIncognito(
  tabId: number,
  getTab: (id: number) => Promise<{ incognito?: boolean }>,
  hasIncognitoWindow: () => Promise<boolean>,
): Promise<boolean> {
  if (tabId >= 0) {
    try { return (await getTab(tabId)).incognito === true; } catch { return true; }
  }
  // Sem aba (ex.: service worker): a requisição não diz o perfil; conservador se houver janela anônima.
  try { return await hasIncognitoWindow(); } catch { return true; }
}

export function isIncognitoTab(tabId: number): Promise<boolean> {
  return resolveIncognito(
    tabId,
    (id) => chrome.tabs.get(id),
    async () => (await chrome.windows.getAll()).some((w) => w.incognito),
  );
}
