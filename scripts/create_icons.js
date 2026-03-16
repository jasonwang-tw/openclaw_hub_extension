/**
 * 產生 OpenClaw Hub 插件圖示
 * 執行：node scripts/create_icons.js
 *
 * 純 Node.js，不需要額外套件
 * 修正：使用 Uint32Array 確保 CRC32 無符號正確計算
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// ── CRC32（修正版：Uint32Array + writeUInt32BE）─────────────────────────────

let _crcTable = null;

function makeCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[n] = c;
  }
  return _crcTable;
}

function crc32(buf) {
  const table = makeCrcTable();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0; // unsigned
}

function makeChunk(type, data) {
  const typeB = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crcVal = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.allocUnsafe(4);
  crcB.writeUInt32BE(crcVal, 0); // ← 修正：writeUInt32BE（非 writeInt32BE）
  return Buffer.concat([len, typeB, data, crcB]);
}

// ── PNG encoder ───────────────────────────────────────────────────────────────

function encodePng(width, height, rgba) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bitDepth=8, colorType=6(RGBA)
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw scanlines with filter byte 0 (None) prepended to each row
  const raw = Buffer.allocUnsafe(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * (1 + width * 4) + 1 + x * 4;
      raw[dst]     = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Icon 繪製：橘色蟹爪 + 深色背景 ───────────────────────────────────────────

function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);

  // 色票
  const BG   = [0x1a, 0x1a, 0x2e]; // #1a1a2e 深藍底
  const RIM  = [0xff, 0x6b, 0x35]; // #ff6b35 橘色框
  const BODY = [0xff, 0x6b, 0x35]; // #ff6b35 主體
  const CLAW = [0xff, 0xa0, 0x60]; // #ffa060 爪子（淺橘）
  const EYE  = [0x1a, 0x1a, 0x2e]; // 眼睛（深色）

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const R  = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // 圓形遮罩（帶 AA）
      const alpha = dist > R ? 0
        : dist > R - 1 ? Math.round((R - dist) * 255)
        : 255;

      if (alpha === 0) {
        setPixel(rgba, size, x, y, 0, 0, 0, 0);
        continue;
      }

      // 座標正規化 -1..1
      const nx = dx / R;
      const ny = dy / R;

      let color = BG;

      // 橘色圓環框
      if (dist >= R * 0.80 && dist < R * 0.95) {
        color = RIM;
      }

      // 蟹身（橢圓）
      const body = (nx * nx) / 0.18 + (ny * ny) / 0.28;
      if (body <= 1.0) color = BODY;

      // 觸角（左右短棍）—— 僅較大尺寸繪製
      if (size >= 48) {
        const ant1 = Math.abs(nx + 0.28) < 0.06 && ny < -0.28 && ny > -0.60;
        const ant2 = Math.abs(nx - 0.28) < 0.06 && ny < -0.28 && ny > -0.60;
        if (ant1 || ant2) color = CLAW;
      }

      // 爪子（左右下角小圓）
      const claw1 = (nx + 0.38) ** 2 / 0.07 + (ny - 0.42) ** 2 / 0.07;
      const claw2 = (nx - 0.38) ** 2 / 0.07 + (ny - 0.42) ** 2 / 0.07;
      if (claw1 <= 1.0 || claw2 <= 1.0) color = CLAW;

      // 眼睛（蟹身上方兩個小點）
      if (size >= 32) {
        const eye1 = (nx + 0.18) ** 2 / 0.018 + (ny + 0.14) ** 2 / 0.018;
        const eye2 = (nx - 0.18) ** 2 / 0.018 + (ny + 0.14) ** 2 / 0.018;
        if (eye1 <= 1.0 || eye2 <= 1.0) color = EYE;
      }

      setPixel(rgba, size, x, y, color[0], color[1], color[2], alpha);
    }
  }

  return rgba;
}

function setPixel(buf, size, x, y, r, g, b, a) {
  const i = (y * size + x) * 4;
  buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = a;
}

// ── 產生並輸出 ────────────────────────────────────────────────────────────────

[16, 48, 128].forEach(size => {
  const pixels = drawIcon(size);
  const png = encodePng(size, size, pixels);
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✅ icons/icon${size}.png  (${png.length} bytes)`);
});

console.log('\n🦞 OpenClaw Hub icons 產生完成！');
