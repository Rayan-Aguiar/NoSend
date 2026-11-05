// Endurecimento: desliga predição de rede (DNS prefetch / preconnect) enquanto ON.
// O spike mostrou preconnect TCP em navegações bloqueadas sem isso (docs/blocking.md).
const setting = () => chrome.privacy.network.networkPredictionEnabled;

async function incognitoAllowed(): Promise<boolean> {
  return new Promise((r) => chrome.extension.isAllowedIncognitoAccess(r));
}

export async function disablePrediction(): Promise<void> {
  await setting().set({ value: false, scope: 'regular' });
  if (await incognitoAllowed()) {
    await setting().set({ value: false, scope: 'incognito_session_only' }).catch(() => {});
  }
}

export async function restorePrediction(): Promise<void> {
  await setting().clear({ scope: 'regular' });
  if (await incognitoAllowed()) {
    await setting().clear({ scope: 'incognito_session_only' }).catch(() => {});
  }
}

export async function verifyPrediction(): Promise<string[]> {
  const d = await setting().get({});
  const reasons: string[] = [];
  if (d.levelOfControl !== 'controlled_by_this_extension') {
    reasons.push(`predição de rede (preconnect/DNS prefetch) não controlada pela extensão (${d.levelOfControl})`);
  }
  if (d.value !== false) reasons.push('predição de rede (preconnect/DNS prefetch) ainda ativa');
  return reasons;
}
