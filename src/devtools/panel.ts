// Painel DevTools: lista/detalhe filtrável pela aba inspecionada.
import { mountListDetail } from '../ui/list-detail';
import { send } from '../ui/client';

mountListDetail(document.getElementById('app')!, { tabId: chrome.devtools.inspectedWindow.tabId, send });
