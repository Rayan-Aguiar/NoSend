// Visualizador em aba: lista/detalhe de todas as abas.
import { mountListDetail } from '../ui/list-detail';
import { send } from '../ui/client';

mountListDetail(document.getElementById('app')!, { send });
