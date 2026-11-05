// Painel DevTools: lista/detalhe filtrável pela aba inspecionada.
import { mountListDetail } from '../ui/list-detail';
import { connectUi, send } from '../ui/client';
import { renderTabNote } from '../ui/tab-note';
import type { ExtState } from '../shared/types';

mountListDetail(document.getElementById('app')!, { tabId: chrome.devtools.inspectedWindow.tabId, send });

// Aviso de captura reduzida para a aba inspecionada.
const tabNote = document.getElementById('ni-tab-note')!;
const showNote = (s: ExtState) => renderTabNote(tabNote, s, chrome.devtools.inspectedWindow.tabId);
send<ExtState>({ type: 'getState' }).then(showNote, () => {});
connectUi({ onState: showNote });
