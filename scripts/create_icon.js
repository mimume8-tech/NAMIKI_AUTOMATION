// Generate a 32x32 ICO file for DigiKar下書き保存
const fs = require('fs');
const path = require('path');

const SIZE = 32;

// Create pixel data (BGRA, bottom-up for ICO/BMP)
const pixels = Buffer.alloc(SIZE * SIZE * 4);

// Colors (BGRA format)
const GREEN  = [0x3C, 0x8C, 0x2E, 0xFF]; // dark green bg
const GOLD   = [0x30, 0xC8, 0xFF, 0xFF]; // gold/yellow
const WHITE  = [0xFF, 0xFF, 0xFF, 0xFF];
const DGREEN = [0x28, 0x64, 0x1E, 0xFF]; // darker green border

function setPixel(x, y, color) {
  // ICO bitmaps are bottom-up
  const row = (SIZE - 1 - y);
  const idx = (row * SIZE + x) * 4;
  pixels[idx]   = color[0]; // B
  pixels[idx+1] = color[1]; // G
  pixels[idx+2] = color[2]; // R
  pixels[idx+3] = color[3]; // A
}

function fillRect(x1, y1, x2, y2, color) {
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      setPixel(x, y, color);
}

// Background: rounded green rectangle
fillRect(0, 0, 31, 31, [0,0,0,0]); // transparent
fillRect(2, 0, 29, 31, GREEN);
fillRect(0, 2, 31, 29, GREEN);
fillRect(1, 1, 30, 30, GREEN);

// Border
for (let i = 2; i <= 29; i++) { setPixel(i, 0, DGREEN); setPixel(i, 31, DGREEN); }
for (let i = 2; i <= 29; i++) { setPixel(0, i, DGREEN); setPixel(31, i, DGREEN); }
setPixel(1, 1, DGREEN); setPixel(30, 1, DGREEN);
setPixel(1, 30, DGREEN); setPixel(30, 30, DGREEN);

// Draw "¥" symbol in gold (centered, large)
// Top V shape
const yenLines = [
  // Two diagonal lines forming V (top part, y=5 to y=14)
  // Left stroke
  [[10,5],[11,6],[12,7],[13,8],[14,9],[15,10],[15,11],[16,12],[16,13],[16,14]],
  [[11,5],[12,6],[13,7],[14,8],[15,9],[16,10],[16,11],[17,12],[17,13],[17,14]],
  // Right stroke
  [[22,5],[21,6],[20,7],[19,8],[18,9],[17,10],[17,11],[17,12],[17,13],[17,14]],
  [[21,5],[20,6],[19,7],[18,8],[17,9],[16,10]],
  // Vertical stem (y=14 to y=26)
  ...Array.from({length: 13}, (_, i) => [[16, 14+i], [17, 14+i]]),
  // Horizontal bars
  [[11,16],[12,16],[13,16],[14,16],[15,16],[16,16],[17,16],[18,16],[19,16],[20,16],[21,16]],
  [[11,19],[12,19],[13,19],[14,19],[15,19],[16,19],[17,19],[18,19],[19,19],[20,19],[21,19]],
];

for (const line of yenLines) {
  for (const [x, y] of line) {
    setPixel(x, y, GOLD);
    // Make strokes thicker
  }
}

// Add "M3" text at top in small white letters (4px high)
// M (x=3..8, y=2..5)
const M = [
  [3,2],[3,3],[3,4],[3,5], // left
  [4,3], // inner left
  [5,3],[5,4], // middle
  [6,3], // inner right
  [7,2],[7,3],[7,4],[7,5], // right
];
// 3 (x=3..7, y=8..12) - not needed, keep it clean

for (const [x, y] of M) setPixel(x, y, WHITE);

// AND mask (1-bit, rows padded to 4 bytes)
const andMaskRowBytes = Math.ceil(SIZE / 8);
const andMaskPaddedRow = Math.ceil(andMaskRowBytes / 4) * 4;
const andMask = Buffer.alloc(andMaskPaddedRow * SIZE, 0);

// ICO structure
const headerSize = 6;
const dirEntrySize = 16;
const bmpHeaderSize = 40;
const pixelDataSize = SIZE * SIZE * 4;
const andMaskSize = andMask.length;
const imageSize = bmpHeaderSize + pixelDataSize + andMaskSize;
const fileSize = headerSize + dirEntrySize + imageSize;

const buf = Buffer.alloc(fileSize);
let off = 0;

// ICONDIR header
buf.writeUInt16LE(0, off); off += 2;     // reserved
buf.writeUInt16LE(1, off); off += 2;     // type: icon
buf.writeUInt16LE(1, off); off += 2;     // count: 1

// ICONDIRENTRY
buf.writeUInt8(SIZE, off); off += 1;     // width
buf.writeUInt8(SIZE, off); off += 1;     // height
buf.writeUInt8(0, off); off += 1;        // color count
buf.writeUInt8(0, off); off += 1;        // reserved
buf.writeUInt16LE(1, off); off += 2;     // planes
buf.writeUInt16LE(32, off); off += 2;    // bits per pixel
buf.writeUInt32LE(imageSize, off); off += 4; // image size
buf.writeUInt32LE(headerSize + dirEntrySize, off); off += 4; // offset

// BITMAPINFOHEADER
buf.writeUInt32LE(bmpHeaderSize, off); off += 4; // header size
buf.writeInt32LE(SIZE, off); off += 4;            // width
buf.writeInt32LE(SIZE * 2, off); off += 4;        // height (x2 for ICO)
buf.writeUInt16LE(1, off); off += 2;              // planes
buf.writeUInt16LE(32, off); off += 2;             // bpp
buf.writeUInt32LE(0, off); off += 4;              // compression
buf.writeUInt32LE(pixelDataSize + andMaskSize, off); off += 4;
buf.writeInt32LE(0, off); off += 4;               // x ppm
buf.writeInt32LE(0, off); off += 4;               // y ppm
buf.writeUInt32LE(0, off); off += 4;              // colors used
buf.writeUInt32LE(0, off); off += 4;              // important colors

// Pixel data
pixels.copy(buf, off); off += pixelDataSize;

// AND mask
andMask.copy(buf, off); off += andMaskSize;

const icoPath = path.join(__dirname, 'digikar_icon.ico');
fs.writeFileSync(icoPath, buf);
console.log('ICO created:', icoPath);
