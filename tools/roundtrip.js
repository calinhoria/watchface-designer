'use strict';
// Round-trip regression: unpack a .bin, recompile it and compare the result.
//
//   node tools/roundtrip.js <face.bin> [more.bin ...]
//
// Compares the meaningful payload: for every face and every section, the
// multiset of *dereferenced* blobs (image data, widget/list/action blobs) — not
// the table bytes, whose absolute offsets legitimately shift. Section 0/7/9 were
// the original acceptance gate; 2/3 are compared too (image singles and lists).
//
// Section 1 (preview) is informational: this tool feeds the file's own preview,
// while the app recomposes it from the canvas, so it may differ.
//
// Exit code 1 if any face's payload differs.
const fs = require('fs');
const crypto = require('crypto');
const { unpack } = require('../core/unpacker');
const { compileFaceProject, SUPPORTED } = require('../core/packer');

const HALF = '  ';

// Per face: 8 bytes back-image id, then 10 (count, offset) pairs; each section's
// entry table is `count` × 16 bytes of (id, _, dataOff, dataLen).
function faces(buf) {
  const shiftWordsUnk = buf.readUInt8(0x18);
  const count = buf.readUInt8(0x1C) || 1;
  const shiftWords = buf.readUInt8(0x1D);
  let off = 0xA8 + shiftWords * 4 + shiftWordsUnk * 4;
  // face block = (first table offset - 168) / count (88 / 160 / 176 seen)
  const off0 = buf.readUInt32LE(off + 12);
  let block = count ? Math.round((off0 - 168) / count) : 88;
  if (!Number.isInteger(block) || block < 88 || block > 4096) block = 88;
  const out = [];
  for (let f = 0; f < count; f++) {
    const start = off;
    off += 8;
    const dir = [];
    for (let i = 0; i < 10; i++) {
      dir.push({ n: buf.readUInt32LE(off), o: buf.readUInt32LE(off + 4) });
      off += 8;
    }
    off = start + block;
    out.push(dir);
  }
  return out;
}
function blobs(buf, sec) {
  const dir = faces(buf);
  const list = [];
  for (const face of dir) {
    for (const s of sec) {
      const d = face[s];
      for (let i = 0; i < d.n; i++) {
        const e = d.o + i * 16;
        const len = buf.readUInt32LE(e + 12);
        const dataOff = buf.readUInt32LE(e + 8);
        const body = len > 0 && dataOff > 0 && dataOff + len <= buf.length ? buf.subarray(dataOff, dataOff + len) : Buffer.alloc(0);
        list.push({ sec: s, len, sha: crypto.createHash('sha1').update(body).digest('hex').slice(0, 10) });
      }
    }
  }
  return list;
}
function sig(list) {
  const by = {};
  for (const b of list) {
    by[b.sec] = by[b.sec] || {};
    by[b.sec][b.sha] = (by[b.sec][b.sha] || 0) + 1;
  }
  return by;
}
function cmpSig(a, b) {
  const diffs = [];
  for (const s of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const A = a[s] || {}, B = b[s] || {};
    const onlyA = Object.keys(A).filter((h) => A[h] !== (B[h] || 0));
    const onlyB = Object.keys(B).filter((h) => B[h] !== (A[h] || 0));
    if (onlyA.length || onlyB.length) {
      const n = (x) => Object.values(x).reduce((p, c) => p + c, 0);
      diffs.push(`sec${s}: ${n(A)}->${n(B)} blobs, ${onlyA.length} changed/removed, ${onlyB.length} new`);
    }
  }
  return diffs;
}

let fails = 0;
for (const file of process.argv.slice(2)) {
  const orig = fs.readFileSync(file);
  const name = file.split('/').pop();
  let u;
  try {
    u = unpack(orig);
  } catch (e) {
    console.log(`FAIL ${name}: unpack: ${e.message}`);
    fails++;
    continue;
  }
  if (!SUPPORTED.has(u.watchType)) {
    console.log(`SKIP ${name}: device ${u.watchType} is not in the compiler's supported set`);
    continue;
  }
  const slots = u.slots.map((s) => ({
    widgets: s.widgets,
    rawActions: s.rawActions || [],
    aod: Boolean(s.aod),
    aodFlag: s.aodFlag >>> 0,
    previewOffset: s.previewOffset >>> 0,
    tail: s.tail || null,
    orphanSec9: s.orphanSec9 || [],
    orphanWidgets: s.orphanWidgets || [],
    orphanImages: s.orphanImages || [],
    orphanSingles: s.orphanSingles || [],
    orphanLists: s.orphanLists || [],
    rawApps: s.rawApps || [],
    images: Object.fromEntries([...s.images].map(([n, im]) => [n, { width: im.width, height: im.height, data: im.rgba, origBlob: im.origBlob, rgbaHash: im.rgbaHash, listEnc: im.listEnc }])),
    preview: u.preview ? { width: u.preview.width, height: u.preview.height, data: u.preview.rgba, origBlob: u.preview.OrigBlob, rgbaHash: u.preview.RgbaHash } : null,
  }));
  let compiled;
  try {
    compiled = compileFaceProject({ deviceType: u.watchType, title: u.title, faceId: u.faceId, subVersion: u.subVersion, slots });
  } catch (e) {
    console.log(`FAIL ${name}: compile: ${e.message}`);
    fails++;
    continue;
  }
  const same = Buffer.compare(orig, compiled.bin) === 0;
  const diffs = cmpSig(sig(blobs(orig, [0, 2, 3, 7, 9])), sig(blobs(compiled.bin, [0, 2, 3, 7, 9])));
  if (same) console.log(`OK    ${name}  ${u.watchType}  ${orig.length} bytes  byte-identical`);
  else if (!diffs.length) console.log(`PAYLOAD-OK ${name}  ${u.watchType}  ${orig.length} -> ${compiled.bin.length} bytes  every payload blob identical (layout/trailer differs)`);
  else { console.log(`DIFF  ${name}  ${u.watchType}  ${orig.length} -> ${compiled.bin.length} bytes`); for (const d of diffs) console.log(HALF + d); fails++; }
}
console.log(fails ? `\n${fails} problem(s)` : '\nall faces round-tripped');
process.exit(fails ? 1 : 0);
