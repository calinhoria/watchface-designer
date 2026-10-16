'use strict';
// Image pixel helpers: RGB565 -> RGBA, row align/flip, BGRA handling.
const { dwordAligned, bgraToRgba } = require('./binutils');

function expand565(word) {
  const r5 = (word >> 11) & 31, g6 = (word >> 5) & 63, b5 = word & 31;
  return [(r5 * 527 + 23) >> 6, (g6 * 259 + 33) >> 6, (b5 * 527 + 23) >> 6];
}
// RGB888 -> RGB565 word with the official quantization (oracle-verified against
// PackRgbaToRgb565Alpha / RepackRgbaToRgb565 on full channel sweeps): scaled
// floor, NOT truncation — r5 = (R*31/255)|0, g6 = (G*63/255)|0,
// b5 = (B*31/255)|0. Truncation (>>3/>>2) agrees at the top end but rounds
// interior values down one step.
function pack565(r, g, b) {
  return ((((r * 31 / 255) | 0) << 11) | (((g * 63 / 255) | 0) << 5) | (((b * 31 / 255) | 0))) & 0xFFFF;
}
// RGB565 LE buffer -> RGBA (opaque; pure black -> transparent like Magick Transparent(black))
function rgb565ToRgba(pxls, { blackTransparent = true } = {}) {
  const n = Math.floor(pxls.length / 2);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const w = pxls[i * 2] | (pxls[i * 2 + 1] << 8);
    const [r, g, b] = expand565(w);
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b;
    out[i * 4 + 3] = (blackTransparent && r === 0 && g === 0 && b === 0) ? 0 : 255;
  }
  return out;
}
// BGRA buffer -> RGBA (+ optional black->transparent)
function bgraBufferToRgba(bgra, { blackTransparent = true } = {}) {
  const out = Buffer.alloc(bgra.length);
  for (let i = 0; i + 3 < bgra.length + 1; i += 4) {
    const b = bgra[i], g = bgra[i + 1], r = bgra[i + 2], a = bgra[i + 3];
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
    if (blackTransparent && r === 0 && g === 0 && b === 0 && a !== 0) out[i + 3] = 0;
    else out[i + 3] = a;
  }
  return out;
}
function alignRowData(src, width, height, bytesPerPixel) {
  const rowLen = width * bytesPerPixel;
  const rowLenNew = dwordAligned(rowLen);
  if (rowLenNew === rowLen) return { data: Buffer.from(src), width };
  const dstWidth = Math.floor(rowLenNew / bytesPerPixel);
  const dst = Buffer.alloc(rowLenNew * height);
  let so = 0;
  for (let i = 0; i < height; i++) {
    Buffer.from(src.subarray(so, so + rowLen)).copy(dst, i * rowLenNew);
    so += rowLen;
  }
  return { data: dst, width: dstWidth };
}
function flipRows(src, width, height, bytesPerPixel) {
  const rowLen = width * bytesPerPixel;
  const dst = Buffer.alloc(src.length);
  let so = src.length - rowLen;
  for (let i = 0; i < height; i++) {
    Buffer.from(src.subarray(so, so + rowLen)).copy(dst, i * rowLen);
    so -= rowLen;
  }
  return dst;
}
// GTR (old) path: type 4 = BGRA32, else RGB565 (type 1 indexed handled by caller via clut)
// NOTE: no vertical flip — source rows are top-down and PNG is top-down.
// (C# FlipImageData only exists because BMP storage is bottom-up.)
function decodeGTR(pxls, width, height, type, { blackTransparent = true } = {}) {
  pxls = Buffer.from(pxls);
  if (type === 4) {
    return { rgba: bgraBufferToRgba(pxls, { blackTransparent }), width, height };
  }
  const bpp = 2; // rgb565 (type 0/2/3)
  const { data: aligned, width: w2 } = alignRowData(pxls, width, height, bpp);
  const rgba = rgb565ToRgba(aligned.subarray(0, w2 * height * bpp), { blackTransparent });
  return { rgba, width: w2, height };
}
// GTRv2 (compressed/magic) path
function decodeGTRv2(pxls, width, height, type, { blackTransparent = false } = {}) {
  pxls = Buffer.from(pxls);
  if (type === 4) {
    // BGRA from ConvertToRGBA
    return { rgba: bgraBufferToRgba(pxls, { blackTransparent }), width, height };
  }
  const bpp = type === 1 ? 1 : 2;
  if (bpp === 1) {
    // indexed without palette here should already be converted; fallback grayscale
    const { data: aligned, width: w2 } = alignRowData(pxls, width, height, 1);
    const rgba = Buffer.alloc(w2 * height * 4);
    for (let i = 0; i < w2 * height; i++) {
      const v = aligned[i];
      rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = (blackTransparent && v === 0) ? 0 : 255;
    }
    return { rgba, width: w2, height };
  }
  const { data: aligned, width: w2 } = alignRowData(pxls, width, height, 2);
  return { rgba: rgb565ToRgba(aligned, { blackTransparent }), width: w2, height };
}
// RedmiWatch3Active default decompress: RLE(word value, byte count) triples
function decompressRW3ADefault(data, width, height) {
  data = Buffer.from(data);
  const out = Buffer.alloc(width * 2 * height);
  const { getWord, getByte } = require('./binutils');
  const rest = data.subarray(height * 2);
  let outPos = 0, off = 0;
  while (off + 3 <= rest.length) {
    const val = getWord(rest, off);
    const cnt = getByte(rest, off + 2);
    for (let i = 0; i < cnt; i++) {
      if (outPos + 2 > out.length) break;
      out[outPos] = val & 0xff; out[outPos + 1] = (val >> 8) & 0xff;
      outPos += 2;
    }
    off += 3;
  }
  return require('./binutils').reverseWord(out);
}
// Sparse decompressors type2 (3B/px) and type3 (1B alpha/px). Direct IL translation.
function decompressRW3ASparse(data, width, height, headerSize, bytesPerPixel) {
  const { getWord, getByteArray } = require('./binutils');
  data = Buffer.from(data);
  const out = Buffer.alloc(width * bytesPerPixel * height);
  const header = data.subarray(0, headerSize);
  const pixels = data.subarray(headerSize);
  const count = getWord(header, 0);
  const startRow = getWord(header, 6);
  // header[8] unused here except bounds; header[10] unused
  const limit = count * 4 + 12;
  let off = 12, prev = 0, dstRow = 0;
  for (let row = 0; row < height; row++) {
    if (row < startRow) { dstRow += width * bytesPerPixel; continue; }
    if (row >= startRow + count) { dstRow += width * bytesPerPixel; continue; }
    if (off + 4 > header.length) { dstRow += width * bytesPerPixel; continue; }
    const dstCol = getWord(header, off) * bytesPerPixel;
    const endPos = getWord(header, off + 2);
    const len = (endPos - prev) * bytesPerPixel;
    const chunk = getByteArray(pixels, prev * bytesPerPixel, len);
    chunk.copy(out, dstRow + dstCol);
    dstRow += width * bytesPerPixel;
    prev = endPos;
    off += 4;
    if (off >= limit) {
      // remaining rows blank
      for (let r = row + 1; r < height; r++) dstRow += width * bytesPerPixel;
      break;
    }
  }
  return out;
}
function rw3aDecompress(data, width, height, type) {
  data = Buffer.from(data);
  if (data.length === width * 2 * height) return require('./binutils').reverseWord(data);
  const lo = type & 0xff, hi = type >>> 8;
  if (lo === 2) return decompressRW3ASparse(data, width, height, hi, 3);
  if (lo === 3) return decompressRW3ASparse(data, width, height, hi, 1);
  return decompressRW3ADefault(data, width, height);
}
module.exports = { expand565, pack565, rgb565ToRgba, bgraBufferToRgba, alignRowData, flipRows, decodeGTR, decodeGTRv2, decompressRW3ADefault, decompressRW3ASparse, rw3aDecompress };
