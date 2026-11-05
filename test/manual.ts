// App de teste manual: `npm run test-app`.
// Sobe o sink (registra toda conexão TCP / requisição / frame WS) e a app de teste,
// imprime a URL da app e mostra no terminal, ao vivo, cada novo acesso ao sink.
// Com o interceptor ON, nada deve aparecer aqui.
import { startSink } from './servers/sink.ts';
import { startApp } from './servers/app.ts';

const sink = await startSink();
const app = await startApp();
const appUrl = `${app.origin}/index.html?sink=${encodeURIComponent(sink.origin)}`;

const time = () => new Date().toISOString().slice(11, 23);

console.log('Network Interceptor — app de teste manual');
console.log(`  sink: ${sink.origin}  (ws: ${sink.wsOrigin})`);
console.log(`  app:  ${appUrl}`);
console.log('');
console.log('Fluxo: abra a URL da app com o interceptor OFF, ligue o interceptor e clique nos cenários.');
console.log('Com ON, nenhuma linha "conexão"/"requisição"/"frame WS" deve aparecer abaixo.');
console.log('Ctrl+C para sair.');
console.log('');

let seenConnections = 0;
let seenRequests = 0;
let seenFrames = 0;

const timer = setInterval(() => {
  if (sink.connections > seenConnections) {
    const n = sink.connections - seenConnections;
    seenConnections = sink.connections;
    console.log(`[${time()}] +${n} conexão(ões) TCP no sink (total ${seenConnections})`);
  }
  while (seenRequests < sink.requests.length) {
    const r = sink.requests[seenRequests++];
    console.log(`[${time()}] requisição: ${r.method} ${r.url} (${r.body.length} bytes de body)`);
  }
  while (seenFrames < sink.wsFrames.length) {
    const f = sink.wsFrames[seenFrames++];
    console.log(`[${time()}] frame WS: ${f.length > 200 ? f.slice(0, 200) + '…' : f}`);
  }
}, 500);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  console.log(`\nTotais: ${sink.connections} conexão(ões), ${sink.requests.length} requisição(ões), ${sink.wsFrames.length} frame(s) WS.`);
  await Promise.allSettled([sink.close(), app.close()]);
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
