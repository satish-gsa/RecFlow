#!/usr/bin/env node
/**
 * Icon generator for RecFlow Chrome Extension
 * Creates PNG icons with no external dependencies (uses built-in zlib + fs)
 *
 * Run: node setup.js
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- CRC32 implementation ----
function buildCRCTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}
const CRC_TABLE = buildCRCTable();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- PNG chunk builder ----
function pngChunk(typeStr, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ---- Icon renderer ----
// Draws a rounded-square record button: red bg + white circle in center
function createIconPNG(size) {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Build raw pixel data
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outerR = size / 2 - 0.5;
  const innerR = size * 0.22;
  const cornerR = size * 0.18; // rounded square corner radius

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0]; // filter byte (None)
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;

      // Rounded square mask (using superellipse approximation)
      const sqDist = Math.pow(Math.abs(dx) / outerR, 8) + Math.pow(Math.abs(dy) / outerR, 8);

      if (sqDist <= 1.0) {
        // Inside rounded square
        const circleDist = Math.sqrt(dx * dx + dy * dy);
        if (circleDist <= innerR) {
          // White inner circle
          row.push(255, 255, 255, 255);
        } else {
          // Red background
          row.push(228, 44, 44, 255);
        }
      } else {
        // Outside (transparent)
        row.push(0, 0, 0, 0);
      }
    }
    rows.push(...row);
  }

  const raw = Buffer.from(rows);
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Main ----
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

for (const size of [16, 48, 128]) {
  const png = createIconPNG(size);
  const dest = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`✓ Created icons/icon${size}.png (${png.length} bytes)`);
}

console.log('\n✅ Icons generated! Load the extension:');
console.log('   1. Open chrome://extensions/');
console.log('   2. Enable "Developer mode" (top-right toggle)');
console.log('   3. Click "Load unpacked"');
console.log('   4. Select this directory: ' + __dirname);
