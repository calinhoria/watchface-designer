'use strict';
// Port of XiaomiWatch.Common.BinaryExtender (little-endian default, bigEndian flag)
function getDWord(data, offset = 0, bigEndian = 0) {
  offset >>>= 0;
  const b0 = data[offset] | 0, b1 = data[offset + 1] | 0, b2 = data[offset + 2] | 0, b3 = data[offset + 3] | 0;
  if (bigEndian) return (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0);
  return (((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0);
}
function getWord(data, offset = 0, bigEndian = 0) {
  offset >>>= 0;
  const b0 = data[offset] | 0, b1 = data[offset + 1] | 0;
  if (bigEndian) return ((b0 << 8) | b1) & 0xffff;
  return ((b1 << 8) | b0) & 0xffff;
}
function getByte(data, offset = 0) { return data[offset >>> 0] | 0; }
function getByteArray(src, offset = 0, len = 1) {
  offset >>>= 0; len >>>= 0;
  return Buffer.from(src.subarray(offset, offset + len));
}
function getAsciiString(data, offset = 0) {
  offset >>>= 0;
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  return Buffer.from(data.subarray(offset, end)).toString('ascii');
}
function getUTF8String(data, offset = 0, strlen = 0, bigEndian = 0) {
  offset >>>= 0;
  if (strlen && strlen > 0) {
    let end = offset + strlen;
    // trim trailing zeros like C# (stops at first 0 when scanning?)
    let buf = Buffer.from(data.subarray(offset, end));
    const z = buf.indexOf(0);
    if (z >= 0) buf = buf.subarray(0, z);
    return buf.toString('utf8');
  }
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  return Buffer.from(data.subarray(offset, end)).toString('utf8');
}
function getUnicodeString(data, offset = 0, bigEndian = 0) {
  offset >>>= 0;
  let end = offset;
  while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2;
  const buf = Buffer.from(data.subarray(offset, end));
  return bigEndian ? buf.swap16().toString('utf16le') : buf.toString('utf16le');
}
function dwordAligned(v) { v >>>= 0; return (v + 3) & ~3; }
function reverseWord(data) {
  const out = Buffer.from(data);
  for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
  return out;
}
// Indexed8 (first 1024 bytes palette, rest indices) -> BGRA bytes (palette copied raw)
function convertToRGBA(src) {
  if (!src) return null;
  src = Buffer.from(src);
  if (src.length <= 1024) return Buffer.alloc(0);
  const pal = src.subarray(0, 1024);
  const idx = src.subarray(1024);
  const out = Buffer.alloc(idx.length * 4);
  for (let i = 0; i < idx.length; i++) pal.copy(out, i * 4, idx[i] * 4, idx[i] * 4 + 4);
  return out; // BGRA order (matches BMP expectation)
}
// 3 bytes/pixel [lo, hi, alpha] RGB565+alpha -> BGRA
function rgb565AlphaToRGBA(data) {
  data = Buffer.from(data);
  const n = Math.floor(data.length / 3);
  const out = Buffer.alloc(n * 4);
  for (let k = 0; k < n; k++) {
    const b0 = data[k * 3], b1 = data[k * 3 + 1], alpha = data[k * 3 + 2];
    const r5 = b1 >> 3;
    const g6 = ((b1 & 7) << 3) | (b0 >> 5);
    const b5 = b0 & 31;
    const r8 = (r5 * 527 + 23) >> 6;
    const g8 = (g6 * 259 + 33) >> 6;
    const b8 = (b5 * 527 + 23) >> 6;
    out[k * 4] = b8; out[k * 4 + 1] = g8; out[k * 4 + 2] = r8; out[k * 4 + 3] = alpha;
  }
  return out; // BGRA
}
function bgraToRgba(bgra) {
  const out = Buffer.from(bgra);
  for (let i = 0; i + 3 < out.length + 1; i += 4) { const t = out[i]; out[i] = out[i + 2]; out[i + 2] = t; }
  return out;
}
function rgbaToBgra(rgba) { return bgraToRgba(rgba); }
function setByte(data, offset, val) { data[offset >>> 0] = val & 0xFF; }
function setWord(data, offset, val, bigEndian = 0) {
  offset >>>= 0; val &= 0xFFFF;
  if (bigEndian) { data[offset] = (val >> 8) & 0xFF; data[offset + 1] = val & 0xFF; }
  else { data[offset] = val & 0xFF; data[offset + 1] = (val >> 8) & 0xFF; }
}
function setDWord(data, offset, val, bigEndian = 0) {
  offset >>>= 0; val >>>= 0;
  if (bigEndian) { data[offset] = (val >>> 24) & 0xFF; data[offset + 1] = (val >>> 16) & 0xFF; data[offset + 2] = (val >>> 8) & 0xFF; data[offset + 3] = val & 0xFF; }
  else { data[offset] = val & 0xFF; data[offset + 1] = (val >>> 8) & 0xFF; data[offset + 2] = (val >>> 16) & 0xFF; data[offset + 3] = (val >>> 24) & 0xFF; }
}
module.exports = { getDWord, getWord, getByte, getByteArray, getAsciiString, getUTF8String, getUnicodeString, dwordAligned, reverseWord, convertToRGBA, rgb565AlphaToRGBA, bgraToRgba, rgbaToBgra, setByte, setWord, setDWord };
