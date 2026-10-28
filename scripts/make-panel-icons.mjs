// Gera os ícones do painel (PNG) sem dependências: formas por distância com supersampling 4x4.
// Uso: node make-icons.mjs <pasta de saída>
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const TOP = hex('#1b2540'), BOTTOM = hex('#121a2e');
const CONTROLLER = hex('#6d8cff'), CODEX = hex('#33c3c5'), CLAUDE = hex('#f0955a'), LINK = hex('#c9d2e6');

const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
function sdSegment(x, y, ax, ay, bx, by, r) {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - dx * t, py - dy * t) - r;
}
function sdRoundRect(x, y, radius) {
  const qx = Math.abs(x - 0.5) - (0.5 - radius), qy = Math.abs(y - 0.5) - (0.5 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Desenho em coordenadas 0..1; tudo dentro do círculo seguro de raio 0,4 (ícone "maskable").
const nodes = { top: [0.5, 0.31, 0.105], left: [0.305, 0.655, 0.09], right: [0.695, 0.655, 0.09] };
function sample(x, y, rounded) {
  if (rounded && sdRoundRect(x, y, 0.22) > 0) return [0, 0, 0, 0];
  let c = TOP.map((v, i) => v + (BOTTOM[i] - v) * y);
  const paint = (color, alpha) => { c = c.map((v, i) => v + (color[i] - v) * alpha); };
  const [tx, ty] = nodes.top;
  for (const [nx, ny] of [nodes.left, nodes.right]) if (sdSegment(x, y, tx, ty, nx, ny, 0.02) < 0) paint(LINK, 0.55);
  if (sdSegment(x, y, nodes.left[0], nodes.left[1], nodes.right[0], nodes.right[1], 0.014) < 0) paint(LINK, 0.25);
  for (const [[cx, cy, r], color] of [[nodes.top, CONTROLLER], [nodes.left, CODEX], [nodes.right, CLAUDE]]) {
    const d = sdCircle(x, y, cx, cy, r);
    if (d < 0.022 && d >= 0) paint(TOP, 1);          // anel escuro separa o nó das linhas
    if (d < 0) paint(color, 1);
    if (sdCircle(x, y, cx - r * 0.3, cy - r * 0.3, r * 0.28) < 0) paint([1, 1, 1], 0.18); // brilho discreto
  }
  return [...c, 1];
}

function render(size, rounded) {
  const SS = 4, px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const acc = [0, 0, 0, 0];
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const s = sample((i + (si + 0.5) / SS) / size, (j + (sj + 0.5) / SS) / size, rounded);
      for (let k = 0; k < 3; k++) acc[k] += s[k] * s[3];
      acc[3] += s[3];
    }
    const a = acc[3] / (SS * SS), o = (j * size + i) * 4;
    for (let k = 0; k < 3; k++) px[o + k] = Math.round(255 * (acc[3] ? acc[k] / acc[3] : 0));
    px[o + 3] = Math.round(255 * a);
  }
  return png(size, px);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const files = [
  ['icon-192.png', 192, true], ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false], ['apple-touch-icon.png', 180, false], ['favicon-32.png', 32, true]
];
for (const [name, size, rounded] of files) {
  fs.writeFileSync(path.join(out, name), render(size, rounded));
  console.log(name, size);
}
