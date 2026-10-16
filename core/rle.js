'use strict';
// Port of BmpHelper RLE decoders (UncompressRLE, v20, v10, v11)
const { getByteArray, getByte } = require('./binutils');

function uncompressRLE(data, destLen) {
  data = Buffer.from(data);
  let offset = 0, lenUnpacked = 0;
  const out = Buffer.alloc(destLen);
  try {
    do {
      const control = data[offset]; offset += 1;
      if (control === 0xFF) break;
      if ((control & 0x80) === 0x80) {
        const size = control & 0x7F;
        const point = getByteArray(data, offset, 4);
        for (let i = 0; i <= size; i++) { point.copy(out, lenUnpacked); lenUnpacked += 4; }
        offset += 4;
      } else {
        const size = control;
        for (let i = 0; i <= size; i++) {
          const point = getByteArray(data, offset, 4);
          point.copy(out, lenUnpacked); lenUnpacked += 4; offset += 4;
        }
      }
    } while (offset < data.length);
  } catch (e) { /* truncated */ }
  return out;
}
function uncompressRLEv20(data, destLen) {
  data = Buffer.from(data);
  let offset = 0, lenUnpacked = 0;
  const out = Buffer.alloc(destLen);
  try {
    do {
      const control = data[offset]; offset += 1;
      if ((control & 0x80) === 0x00) {
        if (offset >= data.length) break;
        const size = control & 0x7F;
        const point = data[offset];
        for (let i = 0; i < size; i++) {
          if (lenUnpacked >= out.length) break;
          out[lenUnpacked++] = point;
        }
        offset += 1;
      } else {
        const size = control & 0x7F;
        for (let i = 0; i < size; i++) {
          if (lenUnpacked >= out.length) break;
          out[lenUnpacked++] = data[offset++];
        }
      }
    } while (offset < data.length);
  } catch (e) { /* truncated */ }
  return out;
}
function uncompressRLEv10(data, destLen, recordSize = 4) {
  data = Buffer.from(data);
  let offset = 0, lenUnpacked = 0;
  const out = Buffer.alloc(destLen);
  try {
    do {
      const control = data[offset]; offset += 1;
      if ((control & 0x80) === 0x00) {
        if (offset + recordSize > data.length) break;
        const size = control & 0x7F;
        const point = getByteArray(data, offset, recordSize);
        for (let i = 0; i < size; i++) { point.copy(out, lenUnpacked); lenUnpacked += recordSize; }
        offset += recordSize;
      } else {
        const size = control & 0x7F;
        for (let i = 0; i < size; i++) {
          const point = getByteArray(data, offset, recordSize);
          point.copy(out, lenUnpacked); lenUnpacked += recordSize; offset += recordSize;
        }
      }
    } while (offset < data.length);
  } catch (e) { /* truncated */ }
  return out;
}
function uncompressRLEv11(data, destLen, recordSize = 4) {
  data = Buffer.from(data);
  let offset = 0, lenUnpacked = 0;
  const out = Buffer.alloc(destLen);
  try {
    do {
      const control = data[offset]; offset += 1;
      if ((control & 0x80) === 0x80) {
        if (offset + recordSize > data.length) break;
        const size = control & 0x7F;
        const point = getByteArray(data, offset, recordSize);
        for (let i = 0; i <= size; i++) { point.copy(out, lenUnpacked); lenUnpacked += recordSize; }
        offset += recordSize;
      } else {
        const size = control & 0x7F;
        for (let i = 0; i <= size; i++) {
          const point = getByteArray(data, offset, recordSize);
          point.copy(out, lenUnpacked); lenUnpacked += recordSize; offset += recordSize;
        }
      }
    } while (offset < data.length);
  } catch (e) { /* truncated */ }
  return out;
}
// RLE v10 encoder (matches RleEncoder.EncodeV10_N: greedy identical-run,
// max 127; single unique record emitted as (129, record)).
function encodeV10(src, recordSize = 4) {
  src = Buffer.from(src);
  if (src.length % recordSize !== 0) throw new Error(`encodeV10: length ${src.length} not multiple of ${recordSize}`);
  const out = [];
  let i = 0;
  while (i < src.length) {
    let run = 1;
    while (run < 127 && i + run * recordSize + recordSize <= src.length) {
      let eq = true;
      for (let k = 0; k < recordSize; k++) {
        if (src[i + k] !== src[i + run * recordSize + k]) { eq = false; break; }
      }
      if (!eq) break;
      run++;
    }
    out.push(run === 1 ? 129 : run);
    for (let k = 0; k < recordSize; k++) out.push(src[i + k]);
    i += run * recordSize;
  }
  return Buffer.from(out);
}
// RLE v20 (LVGL, byte-oriented) encoder. Verified byte-identical against stock
// Watch 6 blobs (320/320 singles, list frames and previews): runs of 3+
// identical bytes become (count, byte), everything else goes out as literal
// chunks of up to 127 bytes ((0x80|count), bytes...). Short runs of 1-2 stay
// inside the literals — unlike v10, which also run-codes length-2+ runs.
function encodeV20(src) {
  src = Buffer.from(src);
  const out = [];
  let i = 0;
  const n = src.length;
  const runLen = (p) => {
    let r = 1;
    while (r < 127 && p + r < n && src[p + r] === src[p]) r++;
    return r;
  };
  while (i < n) {
    const r = runLen(i);
    if (r >= 3) {
      out.push(r);
      out.push(src[i]);
      i += r;
    } else {
      let j = i;
      while (j < n && j - i < 127) {
        if (runLen(j) >= 3) break;
        j++;
      }
      out.push(0x80 | (j - i));
      for (let k = i; k < j; k++) out.push(src[k]);
      i = j;
    }
  }
  return Buffer.from(out);
}
// RLE v11 encoder. Oracle-verified against RleEncoder.EncodeV11_4 and the
// MiBand7Pro compressor on structured + random vectors: runs of 2..128 become
// ((0x80|(run-1)), record); every other record is its own 1-literal ((0x00),
// record) — singles are never grouped into multi-record literals.
function encodeV11(src, recordSize = 4) {
  src = Buffer.from(src);
  if (src.length % recordSize !== 0) throw new Error(`encodeV11: length ${src.length} not multiple of ${recordSize}`);
  const out = [];
  let i = 0;
  const n = src.length / recordSize;
  while (i < n) {
    let run = 1;
    while (run < 128 && i + run < n) {
      let eq = true;
      for (let k = 0; k < recordSize; k++) {
        if (src[i * recordSize + k] !== src[(i + run) * recordSize + k]) { eq = false; break; }
      }
      if (!eq) break;
      run++;
    }
    if (run >= 2) {
      out.push(0x80 | (run - 1));
      for (let k = 0; k < recordSize; k++) out.push(src[i * recordSize + k]);
      i += run;
    } else {
      out.push(0);
      for (let k = 0; k < recordSize; k++) out.push(src[i * recordSize + k]);
      i += 1;
    }
  }
  return Buffer.from(out);
}
module.exports = { uncompressRLE, uncompressRLEv20, uncompressRLEv10, uncompressRLEv11, encodeV10, encodeV11, encodeV20 };
