// Gera static/icons/{on,off}-{16,32,48,128}.png (círculo preenchido, anti-aliased).
// Sem dependências: PNG RGBA escrito à mão com zlib do Node. Uso: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Círculo preenchido com furo central branco. */
function icon(size, [r, g, b]) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = size / 2, R = size / 2 - Math.max(0.5, size / 32);
  const dot = R * 0.38;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro None
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = Math.max(0, Math.min(1, R - d + 0.5));
      const inDot = Math.max(0, Math.min(1, dot - d + 0.5));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round(r + (255 - r) * inDot);
      raw[o + 1] = Math.round(g + (255 - g) * inDot);
      raw[o + 2] = Math.round(b + (255 - b) * inDot);
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('static/icons', { recursive: true });
const colors = { on: [210, 30, 30], off: [128, 128, 128] };
for (const [name, rgb] of Object.entries(colors)) {
  for (const size of [16, 32, 48, 128]) writeFileSync(`static/icons/${name}-${size}.png`, icon(size, rgb));
}
console.log('icons ok -> static/icons');
