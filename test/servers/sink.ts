// Servidor "sink": registra TUDO que chega, inclusive conexões TCP sem requisição.
// Prova central dos testes de segurança: com o interceptor ON, connections === 0.
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';

export interface SinkRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface Sink {
  origin: string;
  wsOrigin: string;
  connections: number;
  requests: SinkRequest[];
  wsFrames: string[];
  reset(): void;
  close(): Promise<void>;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function cors(req: http.IncomingMessage): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': (req.headers.origin as string) || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': (req.headers['access-control-request-method'] as string) || '*',
    'Access-Control-Allow-Headers': (req.headers['access-control-request-headers'] as string) || '*',
  };
}

/** Codifica um frame de texto não mascarado (servidor -> cliente). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleWebSocket(sink: Sink, socket: Socket, req: http.IncomingMessage): void {
  const key = req.headers['sec-websocket-key'] as string;
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        sink.wsFrames.push(text);
        socket.write(encodeFrame(0x1, payload)); // eco
      } else if (opcode === 0x8) {
        socket.write(encodeFrame(0x8, payload.subarray(0, 2)));
        socket.end();
      } else if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
      }
    }
  });
}

export async function startSink(): Promise<Sink> {
  const sockets = new Set<Socket>();
  const sink: Sink = {
    origin: '',
    wsOrigin: '',
    connections: 0,
    requests: [],
    wsFrames: [],
    reset() { this.connections = 0; this.requests = []; this.wsFrames = []; },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      sink.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const h = cors(req);
      const path = (req.url ?? '/').split('?')[0];
      if (req.method === 'OPTIONS') { res.writeHead(204, h); res.end(); return; }
      if (path === '/sse') {
        res.writeHead(200, { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: hello\n\n');
        return; // mantém aberto
      }
      if (path === '/redirect') { res.writeHead(302, { ...h, Location: '/target' }); res.end(); return; }
      res.writeHead(200, { ...h, 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (s: Socket) => {
    sink.connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket: Socket) => {
    sink.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.alloc(0) });
    handleWebSocket(sink, socket, req);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  sink.origin = `http://127.0.0.1:${port}`;
  sink.wsOrigin = `ws://127.0.0.1:${port}`;
  return sink;
}
