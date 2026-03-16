/**
 * 產生 OpenClaw Hub 插件圖示
 * 執行：node scripts/create_icons.js
 * 使用純 Node.js，不需要額外套件
 * 產生最小合法 PNG (使用 zlib deflate)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICONS_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

function createPng(size) {
  // 繪製簡單圖示：深色背景 + 橘色螃蟹爪符號
  const pixels = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = size / 2, cy = size / 2;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = size / 2;

      // 背景 #1a1a2e
      let red = 0x1a, green = 0x1a, blue = 0x2e, alpha = 255;

      // 圓形裁切
      if (dist > r - 1) {
        alpha = 0;
      } else if (dist <= r) {
        // 橘色圓圈 border
        if (dist > r * 0.72 && dist <= r * 0.88) {
          red = 0xff; green = 0x6b; blue = 0x35;
        }
        // 中心：簡單的 🦞 形狀（用幾何近似）
        const nx = dx / r, ny = dy / r; // normalize -1..1

        // 主體橢圓
        const body = (nx * nx / 0.16) + (ny * ny / 0.25);
        if (body <= 1) {
          red = 0xff; green = 0x6b; blue = 0x35;
        }
        // 爪子（左右各一個小圓）
        const claw1 = ((nx + 0.38) * (nx + 0.38) / 0.06) + ((ny + 0.35) * (ny + 0.35) / 0.06);
        const claw2 = ((nx - 0.38) * (nx - 0.38) / 0.06) + ((ny + 0.35) * (ny + 0.35) / 0.06);
        if (claw1 <= 1 || claw2 <= 1) {
          red = 0xff; green = 0x8c; blue = 0x5a;
        }
        // 眼睛
        const eye1 = ((nx + 0.15) * (nx + 0.15) / 0.015) + ((ny - 0.12) * (ny - 0.12) / 0.015);
        const eye2 = ((nx - 0.15) * (nx - 0.15) / 0.015) + ((ny - 0.12) * (ny - 0.12) / 0.015);
        if (eye1 <= 1 || eye2 <= 1) {
          red = 0x1a; green = 0x1a; blue = 0x2e;
        }
      }

      pixels.push(red, green, blue, alpha);
    }
  }

  return encodePng(size, size, pixels);
}

function encodePng(width, height, pixels) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Raw image data with filter bytes
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const pi = (y * width + x) * 4;
      const ri = y * (1 + width * 4) + 1 + x * 4;
      raw[ri] = pixels[pi];
      raw[ri+1] = pixels[pi+1];
      raw[ri+2] = pixels[pi+2];
      raw[ri+3] = pixels[pi+3];
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeB, data]));
  const crcB = Buffer.alloc(4);
  crcB.writeInt32BE(crc);
  return Buffer.concat([len, typeB, data, crcB]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = makeCrcTable();
  for (const byte of buf) {
    crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) | 0;
}

let _crcTable = null;
function makeCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    _crcTable[n] = c;
  }
  return _crcTable;
}

// 產生三個尺寸
[16, 48, 128].forEach(size => {
  const png = createPng(size);
  const outPath = path.join(ICONS_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`✅ icons/icon${size}.png (${png.length} bytes)`);
});

console.log('\n🦞 OpenClaw Hub icons 產生完成！');
