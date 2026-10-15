'use strict';
// Raw V2 table parser for the compiler: captures entry bytes + blobs verbatim
// so unknown sections survive a rebuild. Mirrors core/unpacker.js section walk.
const { getDWord, getWord, getByte } = require('./binutils');

function parseRawV2(data) {
  data = Buffer.from(data);
  const shiftUnk = getByte(data, 0x18);
  const count = getByte(data, 0x1C);
  const shift = getByte(data, 0x1D);
  const subVer = getWord(data, 0x1E);
  const slotStart = 0xA8 + shift * 4 + shiftUnk * 4;
  const previewOff = getDWord(data, 0x20);
  const previewLen = getDWord(data, previewOff + 8) + 0x0C;
  const titleDword = getDWord(data, 0x68);
  let title = null;
  if (titleDword !== 0xFFFFFFFF) {
    let end = 0x68;
    while (end < data.length && data[end] !== 0) end++;
    title = { mode: 'inline', text: Buffer.from(data.subarray(0x68, end)).toString('utf8'), capacity: slotStart - 0x68 };
  } else {
    title = { mode: 'relocated', type: getByte(data, 0x68 + 7), off: getDWord(data, 0x68 + 0x0C), len: getDWord(data, 0x68 + 0x10) };
  }
  let offset = slotStart;
  const slots = [];
  for (let s = 0; s < count; s++) {
    const backId = getDWord(data, offset);
    const prevOff = getDWord(data, offset + 4);
    offset += 8;
    const sections = [];
    for (let i = 0; i < 10; i++) {
      const blkCount = getDWord(data, offset);
      const blkOff = getDWord(data, offset + 4);
      const entries = [];
      let eo = blkOff;
      for (let k = 0; k < blkCount; k++) {
        const id = getDWord(data, eo);
        const unk = getDWord(data, eo + 4);
        const dofs = getDWord(data, eo + 8);
        const dlen = getDWord(data, eo + 12);
        entries.push({ id, unk, dofs, dlen, blob: Buffer.from(data.subarray(dofs, dofs + dlen)) });
        eo += 0x10;
      }
      sections.push({ count: blkCount, entries });
      offset += 8;
    }
    slots.push({ backId, prevOff, sections });
  }
  return {
    version: getDWord(data, 0x10), subVer, count, slotStart,
    preview: { off: previewOff, blob: Buffer.from(data.subarray(previewOff, previewOff + previewLen)) },
    title, slots,
  };
}

module.exports = { parseRawV2 };
