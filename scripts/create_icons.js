/**
 * 產生 OpenClaw Hub 插件圖示
 * 執行：node scripts/create_icons.js
 *
 * 設計：深藍圓形底 + 橘色圓環 + 三道橘色爪痕斜線
 * 純 Node.js，不需要額外套件
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// ── CRC32 ─────────────────────────────────────────────────────────────────────

let _crcTable = null;
function makeCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    _crcTable[n] = c;
  }
  return _crcTable;
}

function crc32(buf) {
  const table = makeCrcTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const len   = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crcB  = Buffer.allocUnsafe(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function encodePng(width, height, rgba) {
  const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = 1 + width * 4;
  const raw = Buffer.allocUnsafe(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * stride + 1 + x * 4;
      raw[dst] = rgba[src]; raw[dst+1] = rgba[src+1];
      raw[dst+2] = rgba[src+2]; raw[dst+3] = rgba[src+3];
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
}

function setPixel(buf, size, x, y, r, g, b, a) {
  const i = (y * size + x) * 4;
  buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
}

// 點到線段的最短距離
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return Math.sqrt((px-ax)**2 + (py-ay)**2);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / len2));
  return Math.sqrt((px - ax - t*dx)**2 + (py - ay - t*dy)**2);
}

// ── Icon 繪製 ─────────────────────────────────────────────────────────────────
//
// 設計規範：
//   - 三道 "/" 方向爪痕（左下→右上），水平排列
//   - 橘色圓環外框（rimInner ~ rimOuter）
//   - 深藍圓形底
//   - 所有尺寸自適應：16 / 48 / 128
//   - 不使用 emoji 或文字字元

function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);

  // 色票（符合 OpenClaw Hub 品牌色）
  const BG   = [0x1a, 0x1a, 0x2e]; // 深藍底 #1a1a2e
  const RIM  = [0xff, 0x6b, 0x35]; // 橘色環 #ff6b35
  const MARK = [0xff, 0xb8, 0x80]; // 爪痕淺橘 #ffb880

  const cx = size / 2;
  const cy = size / 2;
  const R  = size / 2;

  // 圓環尺寸
  const rimOuter = R * 0.94;
  const rimInner = R * (size >= 48 ? 0.80 : 0.76);

  // 爪痕參數（尺寸自適應）
  const halfLen  = R * 0.38;                    // 半長
  const thick    = Math.max(1.6, R * 0.10);    // 線條粗細
  const gap      = R * (size >= 48 ? 0.28 : 0.26); // 三道間距

  // "/" 方向：左下→右上（angle = -45°）
  const angle = -Math.PI / 4;
  const dX = Math.cos(angle); //  0.7071
  const dY = Math.sin(angle); // -0.7071

  // 三道爪痕中心（水平排列，略偏上以視覺平衡）
  const offsetY = R * 0.04;
  const centers = [
    { x: cx - gap, y: cy + offsetY },
    { x: cx,       y: cy + offsetY },
    { x: cx + gap, y: cy + offsetY },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);

      // 圓形遮罩（含 1px AA 邊緣）
      let maskA;
      if (dist > R)       { maskA = 0; }
      else if (dist > R - 1) { maskA = Math.round((R - dist) * 255); }
      else                { maskA = 255; }

      if (maskA === 0) { setPixel(rgba, size, x, y, 0, 0, 0, 0); continue; }

      let color = BG;

      // 橘色圓環
      if (dist >= rimInner && dist < rimOuter) color = RIM;

      // 爪痕（僅在環內繪製）
      if (dist < rimInner) {
        for (const c of centers) {
          const x1 = c.x - halfLen * dX;
          const y1 = c.y - halfLen * dY;
          const x2 = c.x + halfLen * dX;
          const y2 = c.y + halfLen * dY;
          if (distToSegment(px, py, x1, y1, x2, y2) <= thick) {
            color = MARK;
            break;
          }
        }
      }

      setPixel(rgba, size, x, y, color[0], color[1], color[2], maskA);
    }
  }

  return rgba;
}

// ── 產生並輸出 ────────────────────────────────────────────────────────────────

[16, 48, 128].forEach(size => {
  const pixels = drawIcon(size);
  const png    = encodePng(size, size, pixels);
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`Generated icons/icon${size}.png  (${png.length} bytes)`);
});

console.log('\nOpenClaw Hub icons generated.');
