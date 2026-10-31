#!/usr/bin/env node
/* 文言文生词 · PWA 图标生成器（零依赖）
 *
 * 用法：
 *   node tools/make-icons.mjs          生成 icons/ 下的三个 PNG，并回读校验
 *   node tools/make-icons.mjs --check  只回读校验（不重新生成）
 *
 * 只用 Node 内置模块：手写 PNG chunk（IHDR / IDAT / IEND）+ zlib deflate。
 * 图形：深墨绿 #0f766e 圆角底 + 白色「文」字（笔画用锥形描边 + 扫描线抗锯齿绘制）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'icons');
const BG = [0x0f, 0x76, 0x6e];
const FG = [0xff, 0xff, 0xff];

/* ---- 「文」的笔画：归一化字形坐标（x 向右 / y 向下 / 字形框为 [0,1]²）----
 * p0 起点、c 控制点、p1 终点（二次贝塞尔）；w = [起点半宽, 中点半宽, 终点半宽] */
const STROKES = [
  { p0: [0.440, 0.080], c: [0.470, 0.135], p1: [0.548, 0.212], w: [0.020, 0.048, 0.080] }, // 点
  { p0: [0.120, 0.318], c: [0.500, 0.300], p1: [0.880, 0.288], w: [0.076, 0.070, 0.058] }, // 横
  { p0: [0.548, 0.300], c: [0.330, 0.560], p1: [0.100, 0.905], w: [0.086, 0.048, 0.012] }, // 撇
  { p0: [0.435, 0.338], c: [0.650, 0.560], p1: [0.900, 0.910], w: [0.030, 0.078, 0.012] }, // 捺
];

const bez = (a, b, c, t) => {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]];
};
const bezD = (a, b, c, t) => {
  const u = 1 - t;
  return [2 * u * (b[0] - a[0]) + 2 * t * (c[0] - b[0]), 2 * u * (b[1] - a[1]) + 2 * t * (c[1] - b[1])];
};
const widthAt = (w, t) => {
  const u = 1 - t;
  return u * u * w[0] + 2 * u * t * w[1] + t * t * w[2];
};

/* 把一条锥形笔画展开成闭合多边形（像素坐标）。size = 字形框边长，ox/oy = 字形框左上角 */
function strokePolygon(st, size, ox, oy, N = 128) {
  const left = [];
  const right = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = bez(st.p0, st.c, st.p1, t);
    const d = bezD(st.p0, st.c, st.p1, t);
    const len = Math.hypot(d[0], d[1]) || 1;
    const hw = widthAt(st.w, t) * size;
    const nx = (-d[1] / len) * hw;
    const ny = (d[0] / len) * hw;
    const x = ox + p[0] * size;
    const y = oy + p[1] * size;
    left.push([x + nx, y + ny]);
    right.push([x - nx, y - ny]);
  }
  return left.concat(right.reverse());
}

/* 扫描线填充：纵向 4x 超采样，横向解析覆盖度，写入 coverage 缓冲 */
function fillPolygon(poly, size, cov, SUB = 4) {
  const n = poly.length;
  for (let py = 0; py < size; py++) {
    for (let s = 0; s < SUB; s++) {
      const y = py + (s + 0.5) / SUB;
      const xs = [];
      for (let i = 0; i < n; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % n];
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
          xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) addSpan(cov, py * size, size, xs[k], xs[k + 1], 1 / SUB);
    }
  }
}

function addSpan(cov, base, size, x0, x1, w) {
  if (!(x1 > x0)) return;
  if (x0 < 0) x0 = 0;
  if (x1 > size) x1 = size;
  if (!(x1 > x0)) return;
  const i0 = Math.floor(x0);
  const i1 = Math.min(size - 1, Math.floor(x1 - 1e-9));
  if (i0 === i1) {
    cov[base + i0] += (x1 - x0) * w;
    return;
  }
  cov[base + i0] += (i0 + 1 - x0) * w;
  for (let i = i0 + 1; i < i1; i++) cov[base + i] += w;
  cov[base + i1] += (x1 - i1) * w;
}

/* 圆角矩形（r=0 即正方形）的带符号距离 → 覆盖率 */
function roundedRectCoverage(size, radius) {
  const cov = new Float32Array(size * size);
  const half = size / 2;
  const b = half - radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.abs(x + 0.5 - half);
      const py = Math.abs(y + 0.5 - half);
      const qx = px - b;
      const qy = py - b;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const d = outside + inside - radius;
      cov[y * size + x] = Math.min(1, Math.max(0, 0.5 - d));
    }
  }
  return cov;
}

/* 渲染一张图标 → RGBA Buffer */
function renderIcon(size, { radius = 0, glyphScale = 0.62 } = {}) {
  const bg = roundedRectCoverage(size, radius);
  const gcov = new Float32Array(size * size);
  const gs = size * glyphScale;
  const gx = (size - gs) / 2;
  const gy = (size - gs) / 2;
  for (const st of STROKES) fillPolygon(strokePolygon(st, gs, gx, gy), size, gcov);
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(1, bg[i]);
    const g = Math.min(1, gcov[i]);
    out[i * 4] = Math.round(BG[0] * (1 - g) + FG[0] * g);
    out[i * 4 + 1] = Math.round(BG[1] * (1 - g) + FG[1] * g);
    out[i * 4 + 2] = Math.round(BG[2] * (1 - g) + FG[2] * g);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/* ---- PNG 编码 ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩
  ihdr[11] = 0; // 过滤
  ihdr[12] = 0; // 逐行扫描
  const rows = size * 4;
  const raw = Buffer.alloc((rows + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rows + 1)] = 0; // filter: None
    rgba.copy(raw, y * (rows + 1) + 1, y * rows, y * rows + rows);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 回读校验：PNG 魔数 + 解析 IHDR 得到真实宽高 ---- */
function inspect(file) {
  const buf = readFileSync(file);
  const magic = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const ihdrType = buf.subarray(12, 16).toString('latin1');
  const w = buf.length >= 24 ? buf.readUInt32BE(16) : -1;
  const h = buf.length >= 24 ? buf.readUInt32BE(20) : -1;
  const bitDepth = buf.length >= 25 ? buf[24] : -1;
  const colorType = buf.length >= 26 ? buf[25] : -1;
  return { file, magic, ihdrType, w, h, bitDepth, colorType, bytes: buf.length };
}

/* ---- 主流程 ---- */
const TARGETS = [
  { file: 'icon-192.png', size: 192, radius: Math.round(192 * 0.22), glyphScale: 0.64 },
  { file: 'icon-512.png', size: 512, radius: Math.round(512 * 0.22), glyphScale: 0.64 },
  // maskable：底色满版，字形收进中心 80% 安全区内（0.52 的字形框对角线 ≈ 0.74 < 0.8）
  { file: 'icon-maskable-512.png', size: 512, radius: 0, glyphScale: 0.52 },
];

const checkOnly = process.argv.includes('--check');
if (!checkOnly) {
  mkdirSync(ICON_DIR, { recursive: true });
  for (const t of TARGETS) {
    const png = encodePNG(t.size, renderIcon(t.size, t));
    writeFileSync(join(ICON_DIR, t.file), png);
    console.log('写入 ' + t.file + ' (' + t.size + 'x' + t.size + ') ' + png.length + ' bytes');
  }
}

let bad = 0;
for (const t of TARGETS) {
  const info = inspect(join(ICON_DIR, t.file));
  const ok = info.magic && info.ihdrType === 'IHDR' && info.w === t.size && info.h === t.size;
  if (!ok) bad++;
  console.log(
    (ok ? 'OK   ' : 'FAIL ') +
      'icons/' + t.file +
      '  magic=' + (info.magic ? 'PNG' : 'NOT-PNG') +
      '  chunk=' + info.ihdrType +
      '  尺寸=' + info.w + 'x' + info.h +
      '  位深=' + info.bitDepth + ' 颜色类型=' + info.colorType +
      '  期望=' + t.size + 'x' + t.size +
      '  ' + info.bytes + ' bytes'
  );
}
if (bad) {
  console.error(bad + ' 个图标校验失败');
  process.exit(1);
}
console.log('全部图标校验通过（魔数 PNG / IHDR 尺寸 / 文件已落盘）');
