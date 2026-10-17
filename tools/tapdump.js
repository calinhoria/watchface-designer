'use strict';
// Debug helper: dump the tap-relevant section tables of a face (sec0 elements,
// sec7 widgets, sec9 actions) so an authored tap can be compared with stock.
// Usage: node tools/tapdump.js <face.bin> [slotIndex]
const fs = require('fs');
const { getDWord, getWord, getByte, getByteArray } = require('../core/binutils.js');

const bin = fs.readFileSync(process.argv[2]);
const only = process.argv[3] != null ? parseInt(process.argv[3], 10) : -1;
const hex = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');
const ascii = (b) => {
  let s = '';
  for (const c of b) s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
  return s;
};

const version = getDWord(bin, 0x10);
const shiftWordsUnk = getByte(bin, 0x18);
const count = getByte(bin, 0x1C);
const shiftWords = getByte(bin, 0x1D);
const subVersion = getWord(bin, 0x1E);
let offset = 0xA8 + shiftWords * 4 + shiftWordsUnk * 4;
console.log(`file=${process.argv[2]} size=${bin.length} faces=${count} version=${version} shift=${shiftWords}/${shiftWordsUnk} subVersion=${subVersion}`);

// face block size is derived from the first section offset (see unpacker)
const sec0 = getDWord(bin, offset + 8);
const firstOff = getDWord(bin, offset + 0x0C);
const faceBlock = (firstOff - 168) / count;
console.log(`faceBlock=${faceBlock}`);

for (let index = 0; index < count; index++) {
  const backImageId = getDWord(bin, offset);
  const previewOffset = getDWord(bin, offset + 4);
  offset += 8;
  const secs = [];
  for (let i = 0; i < 10; i++) {
    secs.push({ n: getDWord(bin, offset), off: getDWord(bin, offset + 4) });
    offset += 8;
  }
  if (index !== only && only >= 0) { /* still need to skip the tail */ }
  if (faceBlock > 88) offset += faceBlock - 88;
  if (index !== only && only >= 0) continue;
  console.log(`\n== slot ${index}  back=${hex(backImageId)} preview=${hex(previewOffset)}`);
  console.log(`   sections ${secs.map((s, i) => `${i}:${s.n}${s.n ? '@' + hex(s.off, 6) : ''}`).join(' ')}`);
  // sec0: 16-byte elements; the decoded record lives in the blob (target, x, y)
  console.log(`   sec0 (${secs[0].n}):`);
  for (let i = 0; i < secs[0].n; i++) {
    const o = secs[0].off + i * 16;
    const dOff = getDWord(bin, o + 8), dLen = getDWord(bin, o + 12);
    const blob = getByteArray(bin, dOff, dLen);
    const tid = blob.length >= 4 ? getDWord(blob, 0) : 0;
    const x = blob.length >= 8 ? getWord(blob, 4) : 0, y = blob.length >= 8 ? getWord(blob, 6) : 0;
    console.log(`     #${String(i).padStart(2)} target=${hex(tid)} ${String(x).padStart(4)},${String(y).padStart(4)}  blob=${dLen}B  [${[...blob].map((v) => v.toString(16).padStart(2, '0')).join(' ')}]`);
  }
  // sec7: widgets (16-byte table entries: ordinal, id/marker, ?, ?, dataOff, dataLen)
  console.log(`   sec7 (${secs[7].n}):`);
  for (let i = 0; i < secs[7].n; i++) {
    const o = secs[7].off + i * 16;
    const ord = getByte(bin, o), id = getDWord(bin, o), dOff = getDWord(bin, o + 8), dLen = getDWord(bin, o + 12);
    const type = getDWord(bin, dOff);
    console.log(`     #${String(i).padStart(2)} ord=${ord} id=${hex(id)} blob=${dLen}B type=${hex(type)}`);
  }
  // sec9: actions
  console.log(`   sec9 (${secs[9].n}):`);
  for (let i = 0; i < secs[9].n; i++) {
    const o = secs[9].off + i * 16;
    const ord = getByte(bin, o), id = getDWord(bin, o), dOff = getDWord(bin, o + 8), dLen = getDWord(bin, o + 12);
    const blob = getByteArray(bin, dOff, dLen);
    const c40 = blob.length >= 44 ? blob.subarray(40, 44).toString('hex') : '--';
    const d48 = blob.length >= 52 ? getDWord(blob, 48) : 0;
    const w = blob.length >= 56 ? getWord(blob, 52) : 0, h = blob.length >= 56 ? getWord(blob, 54) : 0;
    const d36 = blob.length >= 40 ? getDWord(blob, 36) : 0;
    console.log(`     #${String(i).padStart(2)} ord=${ord} id=${hex(id)} ${String(dLen).padStart(3)}B len=${String(blob.length).padStart(3)} +0="${ascii(blob.subarray(0, 8))}" +40=${c40} +36=${hex(d36)} +48=${hex(d48)} ${w || h ? `W=${w} H=${h}` : ''}`);
  }
}
