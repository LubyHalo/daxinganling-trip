// 生成 PWA 图标（纯 Node 手写 PNG 编码，不依赖任何图像库）。
// 图案：深绿底 + 纸色山峦 + 暖色太阳——一眼能认出是"山野行程"。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.join(import.meta.dirname, '..', 'icons');

/* ---- CRC32 ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 几何 ---- */
const lerp = (a, b, t) => a + (b - a) * t;

function inRoundedRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

function inTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const SUN = { cx: 0.705, cy: 0.285, r: 0.098 };
const PEAK_A = [[0.06, 0.80], [0.455, 0.285], [0.85, 0.80]];
const PEAK_B = [[0.30, 0.80], [0.60, 0.475], [0.90, 0.80]];

function sample(x, y, size) {
  const u = x / size;
  const v = y / size;
  // 背景
  const t = v;
  let r = lerp(18, 42, t);
  let g = lerp(58, 92, t);
  let b = lerp(44, 66, t);
  // 圆角：外部透明
  if (!inRoundedRect(x, y, size, size, size * 0.22)) return [0, 0, 0, 0];
  // 太阳
  if ((u - SUN.cx) ** 2 + (v - SUN.cy) ** 2 <= SUN.r ** 2) { r = 232; g = 178; b = 104; }
  // 后山（纸色）
  if (inTriangle(u, v, ...PEAK_A)) { r = 238; g = 233; b = 218; }
  // 前山（略深的纸色）
  if (inTriangle(u, v, ...PEAK_B)) { r = 216; g = 210; b = 190; }
  return [r, g, b, 255];
}

function render(size) {
  const SS = 3; // 3x3 超采样做抗锯齿
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          const w = sa / 255;
          r += sr * w; g += sg * w; b += sb * w; a += sa;
        }
      }
      const n = SS * SS;
      const al = a / n;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(r / (a / 255 || 1));
      buf[i + 1] = Math.round(g / (a / 255 || 1));
      buf[i + 2] = Math.round(b / (a / 255 || 1));
      buf[i + 3] = Math.round(al);
    }
  }
  return encodePng(size, size, buf);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of targets) {
  const png = render(size);
  fs.writeFileSync(path.join(OUT_DIR, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}
