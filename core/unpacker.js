'use strict';
// Full unpacker port: detect version/watch, decode images to RGBA, build widget lists.
// Returns plain objects; PNG encoding is done by caller.
const { getDWord, getWord, getByte, getByteArray, getAsciiString, getUTF8String, getUnicodeString, convertToRGBA, rgb565AlphaToRGBA, bgraToRgba } = require('./binutils');
const { uncompressRLEv10, uncompressRLEv11, uncompressRLEv20 } = require('./rle');
const { rgb565ToRgba, bgraBufferToRgba, decodeGTR, decodeGTRv2, rw3aDecompress } = require('./img');
const { getWatchType, getScreenWidth, getScreenHeight, WatchType } = require('./watch');
const crypto = require('crypto');
// hash of decoded RGBA: lets the packer echo an image's original encoded blob
// verbatim when the decoded pixels are unchanged (preserves stock PAL8/LVGL
// payloads, whose exact palette ordering we cannot re-synthesise).
function sha1Hex(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

const MAGIC_V1_1 = 0x46616365, MAGIC_V1_2 = 0x46696C65, MAGIC_V2 = 0x5AA53412;
const MAGIC_V3_1 = 0x00000607, MAGIC_V3_2 = 0x00020001;

function detectVersion(data) {
  if (getDWord(data, 0, 1) === MAGIC_V1_1 && getDWord(data, 4, 1) === MAGIC_V1_2) return 1;
  if (getDWord(data, 0, 1) === MAGIC_V2) return 2;
  if (getDWord(data, 0, 1) === MAGIC_V3_1 && getDWord(data, 4, 1) === MAGIC_V3_2) return 3;
  return 0;
}

// ---------- shared preview digit sources ----------
function getStringSource(src) {
  switch (src) {
    case '1012': return '10'; case '1812': return '21'; case '2012': return '3';
    case '0811': return '12'; case '1000911': return '1'; case '0911': return '2';
    case '1011': return '45'; case '1211': return '4'; case '1111': return '5';
    case '1811': return '28'; case '1001911': return '2'; case '1911': return '8';
    case '0821': return '15652'; case '0823': return '12175'; case '0822': return '174';
    case '0824': return '10'; case '0826': return '42'; case '0828': return '60';
    case '0841': return '100'; case '2031': return '23'; case '3031': return '1'; case '5031': return '2';
    default: return '120000';
  }
}
function getTextAlignment(a) { return a === 2 ? 1 : a === 1 ? 2 : 0; }

// ---------- V1 ----------
function unpackV1(data, watchType) {
  const images = new Map(); // name -> {width,height,rgba}
  let offset = 0x14A;
  const blockCount = getDWord(data, offset);
  offset += 4;
  let found = 0, title = '', previewIndex = 0;
  const widgets = [];
  let faceBlock = null, imgBlock = null;
  for (let i = 0; i < blockCount; i++) {
    const bt = getDWord(data, offset);
    if (bt === 3) { found |= 1; imgBlock = offset; }
    else if (bt === 0) { found |= 2; faceBlock = offset; }
    offset += 0x10;
  }
  if (found !== 3) throw new Error('Bad V1 file (missing blocks)');
  // images
  {
    let o = getDWord(data, imgBlock + 0x0C);
    const size = getDWord(data, o);
    const base = o; o += 4;
    for (let i = 0; i < size; i++) {
      try {
        const idx = getDWord(data, o);
        const dataLen = getDWord(data, o + 8), dataOfs = getDWord(data, o + 0x0C);
        const bin = getByteArray(data, base + dataOfs, dataLen);
        const width = getWord(bin, 0x09), height = getWord(bin, 0x0B);
        const type = Math.floor(getWord(bin, 0x05) / width);
        let pxls = getByteArray(bin, 0x15, bin.length - 0x15);
        let clut = null;
        if (type === 1) {
          const pxlsLen = 0x15 + width * height;
          clut = getByteArray(bin, pxlsLen + 4, bin.length - pxlsLen - 4);
          pxls = getByteArray(bin, 0x15, pxlsLen - 0x15);
        }
        let rgba, w2 = width;
        if (type === 4) {
          const { rgba: r, width: w } = decodeGTR(pxls, width, height, 4, { blackTransparent: true });
          rgba = r; w2 = w;
        } else if (type === 1 && clut && clut.length >= 16) {
          // indexed: map through clut (assume BGRA entries)
          const { data: al } = require('./img').alignRowData(pxls, width, height, 1);
          rgba = Buffer.alloc(width * height * 4);
          for (let p = 0; p < width * height; p++) {
            const ci = al[p] * 4;
            const b = clut[ci] ?? 0, g = clut[ci + 1] ?? 0, r2 = clut[ci + 2] ?? 0, a = clut[ci + 3] ?? 255;
            rgba[p * 4] = r2; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b;
            rgba[p * 4 + 3] = (r2 === 0 && g === 0 && b === 0) ? 0 : a;
          }
        } else {
          const { rgba: r, width: w } = decodeGTR(pxls, width, height, type, { blackTransparent: true });
          rgba = r; w2 = w;
        }
        images.set(`img_${String(idx).padStart(4, '0')}.png`, { width: w2, height, rgba });
      } catch (e) { /* skip bad image */ }
      o += 0x10;
    }
  }
  // face
  {
    title = getUnicodeString(data, 0x1A);
    previewIndex = getDWord(data, 0x46);
    let o = getDWord(data, faceBlock + 0x0C);
    const size = getDWord(data, o);
    const base = o; o += 4;
    for (let i = 0; i < size; i++) {
      const dataLen = getDWord(data, o + 8), dataOfs = getDWord(data, o + 0x0C);
      const bin = getByteArray(data, base + dataOfs, dataLen);
      const itemType = getDWord(bin, 0);
      const x = getWord(bin, 8), y = getWord(bin, 12);
      const w = getWord(bin, 16), h = getWord(bin, 20);
      const alfa = getByte(bin, 0x1C);
      widgets.push({ Shape: itemType, Name: `widget_${String(i).padStart(2, '0')}`, X: x, Y: y, Width: w, Height: h, Alpha: alfa });
      o += 0x10;
    }
  }
  return { title, previewIndex, images, widgets };
}

// ---------- V2 image decoders ----------
function decodeV2Preview(data, watchType) {
  const offset = 0x20;
  const dataOfs = getDWord(data, offset);
  const dataLen = getDWord(data, dataOfs + 8);
  let bin = getByteArray(data, dataOfs, dataLen + 0x0C);
  const width = getWord(bin, 0x04), height = getWord(bin, 0x06);
  let rle = bin[0], type = bin[1];
  if (getDWord(bin, 0) === 0) type = 4;
  else if ([5, 8, 6].includes(watchType)) { type = bin[0] & 0xF; if (type === 4) type = 2; }
  let clut = null;
  let pxls = getByteArray(bin, 0x0C, bin.length - 0x0C);
  if (watchType === 362) {
    type = 1; clut = getByteArray(pxls, 0, 0x400); pxls = getByteArray(pxls, 0x400, pxls.length - 0x400);
  }
  const magic = getDWord(bin, 0x0C);
  if (magic !== 0x5AA521E0) {
    if (type === 1 && watchType !== 362) {
      const pxlsLen = 0x15 + width * height;
      clut = getByteArray(bin, pxlsLen + 4, bin.length - pxlsLen - 4);
      pxls = getByteArray(bin, 0x0C, pxlsLen - 0x0C);
    }
  } else {
    bin = getByteArray(data, dataOfs, dataLen + 12);
    const cpr = getByteArray(bin, 0x0C + 8, getDWord(bin, 8) - 8);
    type = bin[0x10] & 0x0F;
    const decLen = getDWord(bin, 0x10) >>> 4;
    pxls = rle === 0x10 ? uncompressRLEv20(cpr, decLen)
      : ([5, 6].includes(watchType) ? uncompressRLEv11(cpr, decLen, type) : uncompressRLEv10(cpr, decLen, type));
    if (type === 1) { pxls = convertToRGBA(pxls); type = 4; }
  }
  let rgba, w2 = width;
  if (magic === 0x5AA521E0) ({ rgba, width: w2 } = decodeGTRv2(pxls, width, height, type, { blackTransparent: false }));
  else if (type === 1 && clut) {
    // legacy indexed with external clut -> map
    rgba = Buffer.alloc(width * height * 4);
    for (let p = 0; p < width * height && p < pxls.length; p++) {
      const ci = pxls[p] * 4;
      rgba[p * 4] = clut[ci + 2] ?? 0; rgba[p * 4 + 1] = clut[ci + 1] ?? 0; rgba[p * 4 + 2] = clut[ci] ?? 0; rgba[p * 4 + 3] = clut[ci + 3] ?? 255;
    }
  } else ({ rgba, width: w2 } = decodeGTR(pxls, width, height, type, { blackTransparent: false }));
  // flip already handled inside decodeGTR; ensure height
  return { width: w2, height, rgba,
    OrigBlob: Buffer.from(getByteArray(data, dataOfs, dataLen + 0x0C)).toString('hex'),
    RgbaHash: sha1Hex(rgba) };
}

function decodeV2Single(bin, watchType, version) {
  const width = getWord(bin, 0x04), height = getWord(bin, 0x06);
  let rle = bin[0], type = bin[1];
  if (getDWord(bin, 0) === 0) type = 4;
  if (watchType === 3 && version === 0x800) {
    if (bin[0] === 0) type = 4;
    if (bin[0] === 3) type = 2;
  }
  const magic = getDWord(bin, 0x0C);
  let clut = null, alfa = null;
  let pxls = getByteArray(bin, 0x0C, bin.length - 0x0C);
  if ([5, 8, 6].includes(watchType) && (rle & 0x0F) === 0x04) {
    type = 2;
    const pxlLen = width * 2 * height;
    alfa = getByteArray(pxls, pxlLen, width * height);
    pxls = getByteArray(pxls, 0, pxlLen);
  }
  if (watchType === 362) {
    pxls = convertToRGBA(pxls); type = 4;
  }
  if (magic !== 0x5AA521E0) {
    if (type === 1 && watchType !== 362) {
      const pxlsLen = 0x15 + width * height;
      clut = getByteArray(bin, pxlsLen + 4, bin.length - pxlsLen - 4);
      pxls = getByteArray(bin, 0x0C, pxlsLen - 0x0C);
    }
    if (type === 4) {
      const { rgba, width: w2 } = decodeGTR(pxls, width, height, 4, { blackTransparent: true });
      return { width: w2, height, rgba, type, alfa: null };
    }
    if (type === 1 && clut) {
      const rgba = Buffer.alloc(width * height * 4);
      for (let p = 0; p < width * height && p < pxls.length; p++) {
        const ci = pxls[p] * 4;
        rgba[p * 4] = clut[ci + 2] ?? 0; rgba[p * 4 + 1] = clut[ci + 1] ?? 0; rgba[p * 4 + 2] = clut[ci] ?? 0; rgba[p * 4 + 3] = 255;
      }
      return { width, height, rgba, type, alfa: null };
    }
    const { rgba, width: w2 } = decodeGTR(pxls, width, height, type, { blackTransparent: true });
    return { width: w2, height, rgba, type, alfa };
  }
  // compressed path is handled by caller which reloads with correct size; here fallback
  const { rgba, width: w2 } = decodeGTRv2(pxls, width, height, type, { blackTransparent: false });
  return { width: w2, height, rgba, type, alfa: null };
}

// ---------- V2 full ----------
function getFaceTitleV2(data) {
  const OFF = 0x68;
  if (getDWord(data, OFF) === 0xFFFFFFFF) {
    const titleType = getByte(data, OFF + 7);
    const offTitle = getDWord(data, OFF + 0x0C);
    if (titleType === 6) {
      if (getDWord(data, offTitle) === 0x07) {
        const count = 3;
        let cur = offTitle + 8 + count * 4;
        const list = [];
        for (let i = 0; i < count; i++) {
          const len = getDWord(data, offTitle + 8 + i * 4);
          list.push(getUTF8String(data, cur, len).trim());
          cur += len;
        }
        return list.join('|');
      }
    }
    return '';
  }
  return getUTF8String(data, OFF);
}

function unpackV2(data, watchType) {
  const version = getDWord(data, 0x10);
  const shiftWordsUnk = getByte(data, 0x18);
  const count = getByte(data, 0x1C);
  const shiftWords = getByte(data, 0x1D);
  const subVersion = getWord(data, 0x1E);
  const preview = decodeV2Preview(data, watchType);
  const title = getFaceTitleV2(data);
  let offset = 0xA8 + shiftWords * 4 + shiftWordsUnk * 4;
  // Faces either are 88 bytes (header + section dir) or 160 (an extra 72-byte
  // "name" block after the dir, used by some store packs). subVersion hints at
  // it but is not reliable (Mi Watch S5 faces ship subVersion 38 with no name
  // block), so validate both layouts and keep the one whose section directory
  // is sane.
  const NAME_BLOCK = 72;
  const faceBlock = chooseFaceBlock(data, offset, count);
  const multiBlock = faceBlock > 88;
  const slots = [];
  for (let index = 0; index < count; index++) {
    const backImageId = getDWord(data, offset);
    const previewOffset = getDWord(data, offset + 4);
    offset += 8; // + previewImageOffset skipped
    let lste = [], lsti = [], lstil = [], lsta = [], lstw = [], lstApp = [];
    const sectionCounts = new Array(10).fill(0);
    for (let i = 0; i < 10; i++) {
      let blkCount = getDWord(data, offset), blkOff = getDWord(data, offset + 4);
      // safety: a mis-parsed directory must never spin the readers billions of
      // times — treat an implausible count as empty
      if (blkCount > 50000 || (blkCount > 0 && (blkOff < 168 || blkOff + 16 > data.length))) { blkCount = 0; blkOff = 0; }
      sectionCounts[i] = blkCount;
      if (i === 0) lste = readElements(data, blkCount, blkOff);
      if (i === 2) lsti = readSingles(data, blkCount, blkOff, watchType, version);
      if (i === 3) lstil = readLists(data, blkCount, blkOff, watchType);
      if (i === 5) lstApp = readApps(data, blkCount, blkOff);
      if (i === 7) lstw = readWidgets(data, blkCount, blkOff);
      if (i === 9) lsta = readActions(data, blkCount, blkOff);
      offset += 8;
    }
    if (watchType === 362) { offset += 0x44; const td = getDWord(data, offset); offset += 4; const sh = (td & 0xFF) >> 2; if (sh > 1) offset += sh * 4; }
    // per-face tail after the 88-byte header+dir (a name block and, on some
    // packs, an extra record). Echoed verbatim so the layout round-trips.
    let tail = null;
    if (faceBlock > 88) {
      tail = Buffer.from(data.subarray(offset, offset + (faceBlock - 88))).toString('hex');
      offset += faceBlock - 88;
    }
    if ([4, 362, 365].includes(watchType)) lste.unshift({ TargetId: backImageId, PosX: 0, PosY: 0 });
    // AOD face: multi-face packs give the AOD variant no preview of its own
    // (its second header dword is 0); normal faces carry a preview offset.
    const aod = count > 1 && previewOffset === 0;
    const aodFlag = 0;
    const sec9Targets = lste.filter((e) => (e.TargetId >>> 24) === 0x09).map((e) => e.TargetId >>> 0);
    // 76B sec9 containers (EasyFace Widget groups: temp digits+symbol, date
    // month+delim+day, big clock) desugar to plain elements before the main
    // loop, so children decode with the existing widget paths. Consumed group
    // blobs are dropped (flat equivalent on recompile); unresolvable ones
    // stay raw (today's behaviour).
    ({ lste, lsta } = desugarGroups(lste, lsti, lstil, lstw, lsta));
    const orphanSec9 = lsta
      .filter((a) => a.RawData && !sec9Targets.includes(a.Id >>> 0))
      .map((a) => Buffer.from(a.RawData).toString('hex'));
    const { widgets, rawActions } = buildWidgetsV2(watchType, lste, lsti, lstil, lstw, lstApp, lsta);
    const images = new Map();
    for (const im of lsti) images.set(im.Name, { width: im.Width, height: im.Height, rgba: im.Rgba, origBlob: im.OrigBlob, rgbaHash: im.RgbaHash });
    for (const il of lstil) for (const n of il.NameList) {
      const e = il.RgbaMap?.[n];
      if (e) images.set(n, { ...e, listEnc: { blob: il.OrigBlob, hash: il.RgbaHash } });
    }
    // section 4 = animation table (official SetupAnimation reads dir entry 4);
    // section 5 = app widgets. Both are unsupported on compile, so flag them.
    slots.push({
      index, subVersion, widgets, rawActions, images, lsti, lstil, lste,
      sectionCounts, aod, aodFlag, previewOffset, orphanSec9, tail, faceBlock,
      animationCount: sectionCounts[4] || 0,
      appCount: sectionCounts[5] || 0,
    });
  }
  const animationCount = slots.reduce((a, s) => a + (s.animationCount || 0), 0);
  const appCount = slots.reduce((a, s) => a + (s.appCount || 0), 0);
  return { title, preview, slots, subVersion, animationCount, appCount };
}

function readElements(data, blkCount, blkOff) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const dataOfs = getDWord(data, o + 8), dataLen = getDWord(data, o + 0x0C);
      const bin = getByteArray(data, dataOfs, dataLen);
      lst.push({ TargetId: getDWord(bin, 0), PosX: getWord(bin, 4), PosY: getWord(bin, 6) });
    } catch (e) { }
    o += 0x10;
  }
  return lst;
}
function readWidgets(data, blkCount, blkOff) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const id = getDWord(data, o);
      const dataOfs = getDWord(data, o + 8), dataLen = getDWord(data, o + 0x0C);
      const bin = getByteArray(data, dataOfs, dataLen);
      let digits = bin[2];
      const w0 = getWord(bin, 0);
      if ([0x1109, 0x110A, 0x1111, 0x1112, 0x1119, 0x111A].includes(w0)) digits = 1;
      lst.push({
        RawData: bin, Shape: bin[0], DataSrcDisplay: bin[1],
        X: bin.length >= 0x20 ? getWord(bin, 0x14) : 0, Y: bin.length >= 0x20 ? getWord(bin, 0x16) : 0,
        Id: id, Digits: digits, Align: bin[3] & 3, TypeId: bin[3] >> 4, TargetId: getDWord(bin, 8),
        // opaque per-device fields we must echo back untouched (Watch 6 uses
        // 1000 at +6, Redmi Watch 5 uses 0)
        U4: bin.length >= 8 ? getWord(bin, 4) : 0, U6: bin.length >= 8 ? getWord(bin, 6) : 1000,
      });
    } catch (e) { }
    o += 0x10;
  }
  return lst;
}
// Validate a candidate face stride (88 or 160): every face's section
// directory must have plausible counts and in-file offsets.
function dirsSane(data, start, count, stride) {
  for (let f = 0; f < count; f++) {
    const base = start + f * stride;
    for (let i = 0; i < 10; i++) {
      const n = getDWord(data, base + 8 + i * 8);
      const o = getDWord(data, base + 12 + i * 8);
      if (n > 0 && (n > 100000 || o < 168 || o + 16 > data.length)) return false;
    }
  }
  return true;
}
// Face block size: the section tables start right after `header + count*block`,
// so face 0's first section offset reveals the block size (88, 160, 176, …).
function chooseFaceBlock(data, start, count) {
  const off0 = getDWord(data, start + 12);
  if (off0 > 168) {
    const block = (off0 - 168) / count;
    if (Number.isInteger(block) && block >= 88 && block <= 4096) return block;
  }
  // fallback: validate 88 vs 160
  const a = dirsSane(data, start, count, 88);
  const b = count > 1 && dirsSane(data, start, count, 160);
  if (b && !a) return 160;
  if (a && !b) return 88;
  return getWord(data, 0x1E) >= 32 ? 160 : 88;
}
function subVersionHint(data) { return getWord(data, 0x1E) >= 32; }

// App/menu jump codes used by the new-format (e7-head) 56B actions, decoded
// at +0x28 from stock faces (matches their EasyFace jumpApp). These are menu
// jumps, not the 37 classic button apps.
const JUMP_APP_CODE = {
  '01001312': 'weather',
  '01003311': 'activities',
  '01005310': 'heartrate',
};
function readActions(data, blkCount, blkOff) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const idx = getWord(data, o), id = getDWord(data, o);
      const dataOfs = getDWord(data, o + 8), dataLen = getDWord(data, o + 0x0C);
      const bin = getByteArray(data, dataOfs, dataLen);
      // Only the 56-byte button template carries a background image id (at
      // 0x30). The 52-byte zone blob has NO image field — its dword at 0x30 is
      // the tap ordinal, which used to false-match single-image indices and
      // paint phantom images (e.g. a calories flame over the temp group).
      // Anything else (76B group containers, 16B records, ...) is opaque:
      // keep raw so it re-emits verbatim and never renders a phantom image.
      // New-format 56B tap records (e7-head: tap + child ref at +0x30) only
      // render as buttons when the child is a single image; a sec7/sec9 child
      // (nested content) stays raw until taps desugar too.
      let imageId = 0, childRef = null;
      if (bin.length === 56) {
        if (bin[0] === 0xE7 && bin[1] === 0xBB) childRef = getDWord(bin, 48) >>> 0;
        else {
          imageId = getDWord(bin, 0x20) & 0xFF;
          if (imageId === 0) imageId = getDWord(bin, 48) & 0xFF;
        }
      }
      if (imageId === 0 && childRef != null) {
        // new-format tap: child ref at +0x30; a single-image child renders
        // like a button, anything else (sec7/sec9 nested content) stays raw
        if ((childRef >>> 24) === 0x02) imageId = childRef & 0xFF;
        else { imageId = 0; childRef = null; }
      }
      if (imageId === 0) {
        // position-only tap zone (old 52B format): no image, keep raw
        let label = null;
        try {
          const nm = Buffer.from(bin.subarray(0, 16)).toString('ascii').replace(/\0.*$/, '');
          if (/^[a-z0-9_]{2,15}$/i.test(nm)) label = nm;
        } catch (e) { }
        // new-format 56B zone: app/jump code at +0x28 (0100xxxx)
        let jump = null;
        if (bin.length === 56 && bin[0] === 0xE7 && bin[1] === 0xBB) jump = JUMP_APP_CODE[Buffer.from(bin.subarray(0x28, 0x2C)).toString('hex')] || null;
        lst.push({ RawData: bin, Id: id, ImageName: null, JumpApp: jump, ActionId: getDWord(bin, 0x28), AppId: getDWord(bin, 0x2C), H0: Buffer.from(bin.subarray(0, 2)).toString('hex'), H40: Buffer.from(bin.subarray(40, 42)).toString('hex'), Label: jump || label });
        o += 0x10; continue;
      }
      // new-format 56B button: app/jump code at +0x28
      let jumpApp = null;
      if (bin.length === 56 && bin[0] === 0xE7 && bin[1] === 0xBB) jumpApp = JUMP_APP_CODE[Buffer.from(bin.subarray(0x28, 0x2C)).toString('hex')] || null;
      lst.push({ RawData: bin, Id: id, ImageName: `img_${String(imageId).padStart(4, '0')}.png`, ChildRef: childRef, JumpApp: jumpApp, ActionId: getDWord(bin, 0x28), AppId: getDWord(bin, 0x2C), H0: Buffer.from(bin.subarray(0, 2)).toString('hex'), H40: Buffer.from(bin.subarray(40, 42)).toString('hex') });
    } catch (e) { }
    o += 0x10;
  }
  return lst;
}
function readApps(data, blkCount, blkOff) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const id = getDWord(data, o);
      const dataOfs = getDWord(data, o + 8);
      const fileSize = getDWord(data, dataOfs) & 0xFFFFFF;
      const filenameLen = data[dataOfs + 3];
      const bin = getByteArray(data, dataOfs, 0x14 + filenameLen + fileSize);
      const filename = Buffer.from(getByteArray(bin, 0x14, filenameLen)).toString('ascii');
      lst.push({ Id: id, Name: filename, Data: getByteArray(bin, 0x14 + filenameLen, fileSize) });
    } catch (e) { }
    o += 0x10;
  }
  return lst;
}
function readSingles(data, blkCount, blkOff, watchType, version) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const idx = getWord(data, o), id = getDWord(data, o);
      const dataOfs = getDWord(data, o + 8), dataLen = getDWord(data, o + 0x0C);
      let bin = getByteArray(data, dataOfs, dataLen);
      const width = getWord(bin, 4), height = getWord(bin, 6);
      let rle = bin[0], type = bin[1];
      if (getDWord(bin, 0) === 0) type = 4;
      if (watchType === 3 && version === 0x800) { if (bin[0] === 0) type = 4; if (bin[0] === 3) type = 2; }
      const magic = getDWord(bin, 0x0C);
      let pxls, rgba, w2 = width;
      if (magic === 0x5AA521E0) {
        bin = getByteArray(data, dataOfs, dataLen + 4);
        const cprLen = getDWord(bin, 8);
        const cpr = getByteArray(bin, 0x0C + 8, cprLen - 8);
        type = bin[0x10] & 0x0F;
        const decLen = getDWord(bin, 0x10) >>> 4;
        pxls = rle === 0x10 ? uncompressRLEv20(cpr, decLen)
          : ([5, 6].includes(watchType) ? uncompressRLEv11(cpr, decLen, type) : uncompressRLEv10(cpr, decLen, type));
        if (type === 1) { pxls = convertToRGBA(pxls); type = 4; }
        ({ rgba, width: w2 } = decodeGTRv2(pxls, width, height, type, { blackTransparent: false }));
      } else {
        ({ rgba, width: w2 } = (() => {
          const d = decodeV2Single(bin, watchType, version);
          return { rgba: d.rgba, width: d.width };
        })());
      }
      const name = `img_${String(idx).padStart(4, '0')}.png`;
      // guard: skip entries with nonsense geometry (some slots carry
      // non-image records that decode to width/height 0) so they never reach
      // the PNG encoder and break the import
      if (!w2 || !height || !rgba || rgba.length < w2 * height * 4) throw new Error('skip');
      lst.push({ Id: id, Width: w2, Height: height, Name: name, Rgba: rgba,
        // verbatim echo: original encoded blob + hash of decoded pixels.
        // Packer reuses OrigBlob when pixels unchanged (PAL8 palette order
        // cannot be re-synthesised, so re-encode would never match).
        OrigBlob: Buffer.from(getByteArray(data, dataOfs, dataLen)).toString('hex'),
        RgbaHash: sha1Hex(rgba) });
    } catch (e) { /* console.error(e) */ }
    o += 0x10;
  }
  return lst;
}
function readLists(data, blkCount, blkOff, watchType) {
  const lst = [];
  let o = blkOff;
  for (let i = 0; i < blkCount; i++) {
    try {
      const idx = getWord(data, o), id = getDWord(data, o);
      const dataOfs = getDWord(data, o + 8), dataLen = getDWord(data, o + 0x0C);
      const bin = getByteArray(data, dataOfs, dataLen);
      const width = getWord(bin, 4), height = getWord(bin, 6);
      if (!width || !height) throw new Error('skip list');
      const rle = bin[0];
      let type = bin[2];
      if (rle === 0 && type === 0) type = 4;
      let imgSize = width * 4 * height, alfSize = 0;
      if ([5, 8, 7, 365, 11, 362, 366, 6, 367, 462, 465, 466, 562, 565, 567, 3651, 3652].includes(watchType)) {
        if ((rle & 0x0F) === 0x04) { type = 2; imgSize = width * 2 * height; alfSize = width * height; }
        if ([7, 365, 11, 465, 565].includes(watchType) && (rle & 0x0F) === 0x03) { type = 2; imgSize = width * 2 * height; alfSize = 0; }
        if (type === 0 && watchType === 362 && (rle & 0xFF) === 0x10) { type = 1; imgSize = width * height + 0x400; alfSize = 0; }
      }
      const arrCount = bin[1];
      const maxSize = getDWord(bin, 8) + 0x0C;
      const magic = getDWord(bin, 0x0C + 4 * arrCount);
      const nameList = [], rgbaMap = {};
      for (let j = 0; j < arrCount; j++) {
        let startOffset = 0x0C + j * (imgSize + alfSize);
        let leftSize = maxSize - startOffset >= imgSize ? imgSize : maxSize - startOffset;
        let pxls = null, pxlsFull = null, curType = type;
        if (magic === 0x5AA521E0) {
          const arrOff = 0x0C + 4 * arrCount;
          startOffset = arrOff;
          for (let x = 0; x < j; x++) startOffset += getDWord(bin, 0x0C + x * 4);
          const cprLen = getDWord(bin, 0x0C + j * 4);
          const cpr = getByteArray(bin, startOffset + 8, cprLen - 8);
          curType = bin[startOffset + 4] & 0x0F;
          const decLen = getDWord(bin, startOffset + 4) >>> 4;
          pxls = rle === 0x10 ? uncompressRLEv20(cpr, decLen)
            : ([5, 6].includes(watchType) ? uncompressRLEv11(cpr, decLen, curType) : uncompressRLEv10(cpr, decLen, curType));
          if (curType === 1) { pxls = convertToRGBA(pxls); curType = 4; }
          const { rgba, width: w2 } = decodeGTRv2(pxls, width, height, curType, { blackTransparent: false });
          const nm = `img_arr_${String(idx).padStart(4, '0')}_${String(j).padStart(2, '0')}.png`;
          nameList.push(nm); rgbaMap[nm] = { width: w2, height, rgba };
        } else {
          pxls = getByteArray(bin, startOffset, leftSize);
          pxlsFull = Buffer.alloc(imgSize); pxls.copy(pxlsFull, 0, 0, Math.min(pxls.length, imgSize));
          if (curType === 1 && watchType === 362) {
            const conv = convertToRGBA(pxlsFull);
            const { rgba, width: w2 } = decodeGTR(conv, width, height, 4, { blackTransparent: false });
            const nm = `img_arr_${String(idx).padStart(4, '0')}_${String(j).padStart(2, '0')}.png`;
            nameList.push(nm); rgbaMap[nm] = { width: w2, height, rgba };
          } else {
            const { rgba, width: w2 } = decodeGTR(pxlsFull, width, height, curType === 1 ? 4 : curType, { blackTransparent: true });
            const nm = `img_arr_${String(idx).padStart(4, '0')}_${String(j).padStart(2, '0')}.png`;
            nameList.push(nm); rgbaMap[nm] = { width: w2, height, rgba };
          }
        }
      }
      lst.push({ Id: id, Width: width, Height: height, NameList: nameList, RgbaMap: rgbaMap,
        OrigBlob: Buffer.from(getByteArray(data, dataOfs, dataLen)).toString('hex'),
        RgbaHash: sha1Hex(Buffer.concat(nameList.map((n) => rgbaMap[n].rgba))) });
    } catch (e) { }
    o += 0x10;
  }
  return lst;
}

// 76-byte sec9 group container (stock subVersion 32/36/38 faces: temp
// digits+symbol, date month+delim+day, big clock). Layout from 5 blobs ×
// ground-truth editor.config.json:
//   +0x30: child-A sec7 widget id | +0x38: child-B single image id or sec7
//   widget id | +0x40: child-C single image id or sec7 widget id
//   +0x44: words (groupH, groupW). (+0x34/+0x3C are zero.)
// All observed groups are tapless (taps use 56B/52B records). The blob stores
// no child offsets — firmware flex-rows them — so single children are
// x-packed left-to-right at demo widths (WYSIWYG) and y-centred in the group
// box; a widget middle child (temp sign variant) overlaps child A the way
// stock does (shared origin — the group box is narrower than both). Digit
// children are forced left-aligned so the packing matches the canvas.
function parseGroup76(bin) {
  if (!bin || bin.length !== 76) throw new Error('not a group blob');
  return {
    a: bin.readUInt32LE(0x30) >>> 0, b: bin.readUInt32LE(0x38) >>> 0,
    c: bin.readUInt32LE(0x40) >>> 0,
    h: bin.readUInt16LE(0x44), w: bin.readUInt16LE(0x46),
  };
}
// Replace group elements with synthetic child elements (positions computed),
// dropping the consumed group blobs. Anything unresolvable stays untouched
// (raw zone path, today's behaviour) — never duplicate, never drop.
function desugarGroups(lste, lsti, lstil, lstw, lsta) {
  const wById = new Map(lstw.map((w) => [w.Id >>> 0, w]));
  const sById = new Map(lsti.map((im) => [im.Id >>> 0, im]));
  const listById = new Map(lstil.map((l) => [l.Id >>> 0, l]));
  const claimedSec7 = new Set(lste.map((e) => e.TargetId >>> 0));
  const claimedSingle = new Set();
  for (const e of lste) if ((e.TargetId >>> 24) === 0x02) claimedSingle.add(e.TargetId >>> 0);
  // render width of a sec7 widget's content (digits demo string or single)
  const contentOfSec7 = (w) => {
    const li = listById.get(w.TargetId >>> 0);
    if (li) {
      const src = lookupDataSrc(w.Shape, w.DataSrcDisplay);
      const demo = getStringSource(src);
      return { w: Math.max(demo.length, 1) * li.Width, h: li.Height };
    }
    const si = sById.get(w.TargetId >>> 0);
    if (si) return { w: si.Width, h: si.Height };
    return null;
  };
  // NOTE: the canvas draws digits left from the widget X regardless of
  // Alignment, so children pack left at demo widths; raw Align bytes stay
  // untouched (they round-trip through the model exactly).
  const outE = [];
  const dropActions = new Set();
  for (const e of lste) {
    const keep = () => outE.push(e);
    if ((e.TargetId >>> 24) !== 0x09) { keep(); continue; }
    const act = lsta.find((a) => (a.Id >>> 0) === (e.TargetId >>> 0));
    if (!act || !act.RawData || act.RawData.length !== 76) { keep(); continue; }
    let g;
    try { g = parseGroup76(act.RawData); } catch (err) { keep(); continue; }
    const A = wById.get(g.a);
    if (!A || claimedSec7.has(g.a)) { keep(); continue; }
    // middle child: single image (date delim, clock colon) packs after A;
    // a widget (temp sign variant) overlaps A at the shared origin.
    let Bs = null, Bw = null;
    if ((g.b >>> 24) === 0x02) {
      Bs = sById.get(g.b);
      if (!Bs || claimedSingle.has(g.b)) { keep(); continue; }
    } else if ((g.b >>> 24) === 0x07) {
      Bw = wById.get(g.b);
      if (!Bw || claimedSec7.has(g.b)) { keep(); continue; }
    } else { keep(); continue; }
    let Cw = null, Cs = null;
    if ((g.c >>> 24) === 0x07) {
      Cw = wById.get(g.c);
      if (!Cw || claimedSec7.has(g.c)) { keep(); continue; }
    } else if ((g.c >>> 24) === 0x02) {
      Cs = sById.get(g.c);
      if (!Cs || claimedSingle.has(g.c)) { keep(); continue; }
    } else { keep(); continue; }
    const dA = contentOfSec7(A);
    if (!dA) { keep(); continue; }
    const dBs = Bs ? { w: Bs.Width, h: Bs.Height } : null;
    const dBw = Bw ? contentOfSec7(Bw) : null;
    if (Bw && !dBw) { keep(); continue; }
    const dC = Cw ? contentOfSec7(Cw) : { w: Cs.Width, h: Cs.Height };
    if (!dC) { keep(); continue; }
    // metric key for the unit-alternate rule (temp C/F share a list + a slot)
    const metricOf = (w) => {
      const c = lookupDataSrc(w.Shape, w.DataSrcDisplay);
      return (c === '2031' || c === 'd031' || c === 'd032') ? 'temp' : c;
    };
    // a widget child that reuses an earlier widget's list AND metric is an
    // inactive unit variant (e.g. °C vs °F digits) the editor shows once —
    // rendering both overlaps the numbers
    const usedTarget = new Map(); // list id -> metric
    usedTarget.set(A.TargetId >>> 0, metricOf(A));
    let skipB = false, skipC = false;
    if (Bw && usedTarget.get(Bw.TargetId >>> 0) === metricOf(Bw)) skipB = true;
    if (Bw && !skipB) usedTarget.set(Bw.TargetId >>> 0, metricOf(Bw));
    if (Cw && usedTarget.get(Cw.TargetId >>> 0) === metricOf(Cw)) skipC = true;
    const yOf = (h) => e.PosY + (g.h > 0 && h > 0 ? Math.round((g.h - h) / 2) : 0);
    let x = e.PosX;
    outE.push({ TargetId: g.a, PosX: x, PosY: yOf(dA.h) }); x += dA.w;
    if (Bs) { outE.push({ TargetId: g.b, PosX: x, PosY: yOf(dBs.h) }); x += dBs.w; }
    if (Bw && !skipB) outE.push({ TargetId: g.b, PosX: e.PosX, PosY: yOf(dBw.h) });
    if (Cw && !skipC) outE.push({ TargetId: g.c, PosX: x, PosY: yOf(dC.h) });
    else if (Cs) outE.push({ TargetId: g.c, PosX: x, PosY: yOf(dC.h) });
    claimedSec7.add(g.a);
    if (Bw) claimedSec7.add(g.b);
    if (Cw) claimedSec7.add(g.c);
    if (Bs) claimedSingle.add(g.b);
    if (Cs) claimedSingle.add(g.c);
    dropActions.add(act.Id >>> 0);
  }
  return { lste: outE, lsta: lsta.filter((a) => !dropActions.has(a.Id >>> 0)) };
}

function buildWidgetsV2(watchType, lste, lsti, lstil, lstw, lstApp, lsta) {
  const widgets = [];
  const rawActions = [];
  let idx = 0;
  for (const e of lste) {
    try {
      const hi = e.TargetId >>> 24;
      if (hi === 0x02) {
        const img = lsti.find(c => (c.Id & 0xFF00FFFF) === e.TargetId);
        if (!img) { idx++; continue; }
        widgets.push({ Shape: 30, Name: `image_${String(idx).padStart(2, '0')}`, X: e.PosX, Y: e.PosY, Width: img.Width, Height: img.Height, Alpha: 255, Bitmap: img.Name });
      } else if (hi === 0x07) {
        const wdgt = lstw.find(c => c.Id === e.TargetId);
        if (!wdgt) { idx++; continue; }
        const imgl = lstil.find(c => c.Id === wdgt.TargetId);
        const imgi = lsti.find(c => c.Id === wdgt.TargetId);
        if (!imgl && !imgi) { idx++; continue; }
        if (wdgt.TypeId === 1 && imgl) {
          if (imgl.NameList.length === 10) imgl.NameList = [...imgl.NameList, imgl.NameList[0]];
          const digits = wdgt.Digits;
          const key = `${wdgt.Shape.toString(16).padStart(2, '0')}${wdgt.DataSrcDisplay.toString(16).padStart(2, '0')}`.toLowerCase();
          const digit = getStringSource(Object.entries({ '0811': 1 }).length ? lookupDataSrc(wdgt.Shape, wdgt.DataSrcDisplay) : key);
          const maxLen = Math.min(digits, digit.length);
          let posX = e.PosX;
          const width = imgl.Width, spacing = 0;
          if (wdgt.Align === 2 && [3, 4, 362, 8, 5, 7, 365, 9, 366, 11, 6, 367, 462, 465, 466, 562, 565, 567, 3651, 3652].includes(watchType)) posX -= (width + spacing) * maxLen / 2;
          else if (wdgt.Align === 0 && [3, 4, 362, 8, 5, 7, 365, 9, 366, 11, 6, 367, 462, 465, 466, 562, 565, 567, 3651, 3652].includes(watchType)) posX -= (width + spacing) * maxLen;
          widgets.push({
            Shape: 32, Name: `widget_${String(idx).padStart(2, '0')}`, X: Math.round(posX), Y: e.PosY,
            Width: imgl.Width, Height: imgl.Height, Digits: digits, Alignment: getTextAlignment(wdgt.Align),
            Spacing: wdgt.RawData.length > 13 ? wdgt.RawData[13] : 0,
            _u4: wdgt.U4, _u6: wdgt.U6,
            Blanking: (wdgt.RawData.length > 3 && (wdgt.RawData[3] & 4)) ? 0 : 1,
            Alpha: 255, DataSrcValue: lookupDataSrc(wdgt.Shape, wdgt.DataSrcDisplay), BitmapList: imgl.NameList.join('|'),
          });
        } else if (wdgt.TypeId === 4 && imgi) {
          // Value-driven image widget (Redmi Watch 5 faces): a widget entry whose
          // target is a single image — the watch picks/renders it by value.
          // Keep it as an image layer carrying its own widget entry so the
          // structure survives a recompile.
          widgets.push({
            Shape: 30, Name: `image_${String(idx).padStart(2, '0')}`, X: e.PosX, Y: e.PosY,
            Width: imgi.Width, Height: imgi.Height, Alpha: 255, Bitmap: imgi.Name,
            DataSrcValue: lookupDataSrc(wdgt.Shape, wdgt.DataSrcDisplay),
            _imgWidget: { align: wdgt.Align, shape: wdgt.Shape, disp: wdgt.DataSrcDisplay,
              raw: Buffer.from(wdgt.RawData).toString('hex') },
          });
        } else if (wdgt.TypeId === 2 && imgl) {
          const hasCustom = wdgt.RawData.length > 0x0c && ((wdgt.RawData[0x0c] | (wdgt.RawData[0x0d] << 8)) === 0x200);
          let bmpList = '';
          for (let x = 0; x < imgl.NameList.length; x++) {
            let value = x;
            try { if (hasCustom) value = getDWord(wdgt.RawData, 0x10 + x * 4); } catch (e2) { }
            if (bmpList) bmpList += '|';
            bmpList += `(${(hasCustom ? value : x)}):${imgl.NameList[x]}`;
          }
          widgets.push({
            Shape: 31, Name: `widget_${String(idx).padStart(2, '0')}`, X: e.PosX, Y: e.PosY,
            Width: imgl.Width, Height: imgl.Height, Alpha: 255,
            DataSrcIndex: lookupDataSrc(wdgt.Shape, wdgt.DataSrcDisplay), BitmapList: bmpList,
            _listValues: hasCustom,   // stock faces may ship the array even if it equals the indices
          });
        } else if (wdgt.TypeId === 3) {
          if (wdgt.DataSrcDisplay === 0x11) {
            let clock = widgets.find(w => w.Shape === 27);
            if (!clock) {
              clock = { Shape: 27, Name: `analogClock_${String(idx).padStart(2, '0')}`, Width: getScreenWidth(watchType), Height: getScreenHeight(watchType), Alpha: 255, X: 0, Y: 0 };
              widgets.push(clock);
            }
            if (wdgt.Shape === 0x08) { clock.HourHandImage = imgi?.Name; clock.HourImageRotateX = wdgt.X; clock.HourImageRotateY = wdgt.Y; }
            else if (wdgt.Shape === 0x10) { clock.MinuteHandImage = imgi?.Name; clock.MinuteImageRotateX = wdgt.X; clock.MinuteImageRotateY = wdgt.Y; }
            else if (wdgt.Shape === 0x18) { clock.SecondHandImage = imgi?.Name; clock.SecondImageRotateX = wdgt.X; clock.SecondImageRotateY = wdgt.Y; }
          } else if (imgi) {
            widgets.push({
              Shape: 43, Name: `widget_${String(idx).padStart(2, '0')}`, X: e.PosX, Y: e.PosY,
              Width: imgi.Width, Height: imgi.Height, Alpha: 255,
              DataSrcVal: lookupDataSrc(wdgt.Shape, wdgt.DataSrcDisplay), PointerImage: imgi.Name,
            });
          }
        }
      } else if (hi === 0x09) {
        const action = lsta.find(c => c.Id === e.TargetId);
        const im = action && action.ImageName ? lsti.find(c => c.Name === action.ImageName) : null;
        if (action && im) {
          let suffix = '';
          let appName = action.JumpApp || null;
          if (action.ActionId === 0x23721400) {
            const app = lstApp.find(c => c.Id === action.AppId);
            if (app) { suffix = `_[${app.Name}]`; appName = app.Name; }
          } else if (appName) {
            suffix = `_[${appName}]`;
          }
          widgets.push({
            Shape: 30, Name: `btn_${String(idx).padStart(2, '0')}${suffix}`, X: e.PosX, Y: e.PosY, Alpha: 255,
            Bitmap: action.ImageName, Width: im.Width, Height: im.Height,
            _action: { h0: action.H0, h40: action.H40 }, _app: appName,
            _actionRaw: Buffer.from(action.RawData).toString('hex'),
          });
        } else {
          // orphan tap zone (no image widget): preserve raw blob for recompile
          rawActions.push({
            x: e.PosX, y: e.PosY, target: e.TargetId >>> 0,
            blob: action ? Buffer.from(action.RawData).toString('hex') : null,
            label: (action && action.Label) || 'tap',
          });
        }
      } else if (hi === 0x05) {
        const app = lstApp.find(c => c.Id === e.TargetId);
        if (app) widgets.push({ Shape: 34, Name: `app_${app.Name}`, X: 0, Y: 0, Width: getScreenWidth(watchType), Height: getScreenHeight(watchType), Alpha: 255 });
      }
    } catch (e) { }
    idx++;
  }
  return { widgets, rawActions };
}
// shape+display -> FaceItemDataSrc string code
function lookupDataSrc(shape, disp) {
  const s = shape.toString(16).padStart(2, '0'), d = disp.toString(16).padStart(2, '0');
  const key = (s + d).toLowerCase();
  const map = {
    '0811': '0811', '0911': '0911', '100911': '1000911', '1011': '1011', '1111': '1111', '1211': '1211',
    '1811': '1811', '1911': '1911', '1001911': '1001911', '0813': '0813', '1012': '1012', '1812': '1812',
    '1912': '1912', '1001912': '1001912', '2012': '2012', '0821': '0821', '1021': '1021', '0822': '0822',
    '1022': '1022', '0823': '0823', '1023': '1023', '0824': '0824', '0826': '0826', '0828': '0828',
    '0841': '0841', '1041': '1041', '2031': '2031', '3031': '3031', '5031': '5031',
  };
  return map[key] || key;
}

// ---------- V3 (RedmiWatch3Active only) ----------
function v3Widget(sectionId, names, posX, posY, width, height, color = 0) {
  const post = color ? `_color[${color.toString(16).toUpperCase().padStart(6, '0')}]` : '';
  const pct = () => { let p = -10; return names.map(n => `(${(p += 10)}):${n}`).join('|'); };
  const seq = (start = 1) => { let n = start - 1; return names.map(x => `(${++n}):${x}`).join('|'); };
  const num = (digits, src) => ({
    Shape: 32, Name: `${sectionId.toString(16).toUpperCase().padStart(2, '0')}_num_${src}${post}`,
    BitmapList: [...names, names[0]].join('|'), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, Digits: digits, Blanking: 1,
  });
  const img = (tag) => ({ Shape: 30, Name: `${sectionId.toString(16).toUpperCase().padStart(2, '0')}_img_${tag}${post}`, Bitmap: names[0], X: posX, Y: posY, Width: width, Height: height, Alpha: tag.includes('CN1') || tag.includes('CN2') ? 0 : 255 });
  const hex = sectionId.toString(16).toUpperCase().padStart(2, '0');
  switch (sectionId) {
    case 0x04: return { Shape: 31, Name: `${hex}_imgList_batt${post}`, BitmapList: pct(), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 50, DataSrcIndex: '0841' };
    case 0x05: return img('battCN1'); case 0x06: return img('battEN'); case 0x07: return img('battCN2');
    case 0x09: return { ...num(3, 'batt'), DataSrcValue: '0841' };
    case 0x0A: return img('delim');
    case 0x0D: return { ...num(2, 'month'), DataSrcValue: '1012' };
    case 0x0E: return img('delim');
    case 0x0F: return { ...num(2, 'day'), DataSrcValue: '1812' };
    case 0x10: return { Shape: 31, Name: `${hex}_imgList_weekCN1`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 0, DefaultIndex: 1, DataSrcIndex: '2012' };
    case 0x11: return { Shape: 31, Name: `${hex}_imgList_weekEN`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 1, DataSrcIndex: '2012' };
    case 0x12: return { Shape: 31, Name: `${hex}_imgList_weekCN2`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 0, DefaultIndex: 1, DataSrcIndex: '2012' };
    case 0x13: return { Shape: 31, Name: `${hex}_imgList_AMPM-CN1${post}`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 0, DefaultIndex: 1, DataSrcIndex: '0813' };
    case 0x14: return { Shape: 31, Name: `${hex}_imgList_AMPM-EN${post}`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 1, DataSrcIndex: '0813' };
    case 0x15: return { Shape: 31, Name: `${hex}_imgList_AMPM-CN2${post}`, BitmapList: seq(), X: posX, Y: posY, Width: width, Height: height, Alpha: 0, DefaultIndex: 1, DataSrcIndex: '0813' };
    case 0x18: return { Shape: 31, Name: `${hex}_imgList_stepsPercent${post}`, BitmapList: pct(), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 50, DataSrcIndex: '1021' };
    case 0x19: return img('stepsCN1'); case 0x1A: return img('stepsEN'); case 0x1B: return img('stepsCN2');
    case 0x1C: return { ...num(5, 'steps'), DataSrcValue: '0821' };
    case 0x23: return { Shape: 31, Name: `${hex}_imgList_calPercent${post}`, BitmapList: pct(), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 50, DataSrcIndex: '1023' };
    case 0x24: return img('calCN1'); case 0x25: return img('calEN'); case 0x26: return img('calCN2');
    case 0x27: return { ...num(4, 'calories'), DataSrcValue: '0823' };
    case 0x31: return { ...num(3, 'hrm'), DataSrcValue: '0822' };
    case 0x32: return img('noHrm'); case 0x33: return img('hrmCN1'); case 0x34: return img('hrmEN'); case 0x35: return img('hrmCN2');
    case 0x38: return { ...num(1, 'hourHigh'), DataSrcValue: '1000911' };
    case 0x39: return { ...num(1, 'hourLow'), DataSrcValue: '0911' };
    case 0x3A: return img('delim');
    case 0x3B: return { ...num(1, 'minHigh'), DataSrcValue: '1211' };
    case 0x3C: return { ...num(1, 'minLow'), DataSrcValue: '1111' };
    case 0x3D: return img('delim');
    case 0x3E: return { ...num(1, 'secHigh'), DataSrcValue: '1001911' };
    case 0x3F: return { ...num(1, 'secLow'), DataSrcValue: '1911' };
    case 0x42: { let n = 0; return { Shape: 31, Name: `${hex}_imgList_hour${post}`, BitmapList: names.map(x => `(${n++}):${x}`).join('|'), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 10, DataSrcIndex: '0811' }; }
    case 0x43: { let n = 0; return { Shape: 31, Name: `${hex}_imgList_min${post}`, BitmapList: names.map(x => `(${n++}):${x}`).join('|'), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 0, DataSrcIndex: '1011' }; }
    case 0x44: { let n = 0; return { Shape: 31, Name: `${hex}_imgList_second${post}`, BitmapList: names.map(x => `(${n++}):${x}`).join('|'), X: posX, Y: posY, Width: width, Height: height, Alpha: 255, DefaultIndex: 5, DataSrcIndex: '1811' }; }
    default: throw new Error(`Unknown V3 section 0x${sectionId.toString(16)}`);
  }
}

function unpackV3(data, watchType) {
  if (watchType !== WatchType.RedmiWatch3Active) throw new Error('V3 only supports RedmiWatch3Active in this port');
  const images = new Map();
  const widgets = [];
  // block 1: preview + background
  {
    const blockStart = getDWord(data, 0x59), blockLen = getDWord(data, 0x59 + 4);
    const blk = getByteArray(data, blockStart, blockLen);
    const names = ['preview', 'background'];
    let off = 0;
    for (let i = 0; i < 2; i++) {
      const sectionId = blk[off]; off++;
      const posX = getWord(blk, off), posY = getWord(blk, off + 2);
      const width = getWord(blk, off + 4), height = getWord(blk, off + 6);
      const type = blk[off + 9];
      const dataOfs = getDWord(blk, off + 0x0A), dataLen = getDWord(blk, off + 0x0E);
      const bin = getByteArray(blk, dataOfs, dataLen);
      const dec = rw3aDecompress(bin, width, height, type);
      const { rgba } = decodeGTR(dec, width, height, 2, { blackTransparent: false });
      images.set(`${names[i]}.png`, { width, height, rgba });
      if (i > 0) widgets.push({ Shape: 30, Name: names[i], Bitmap: `${names[i]}.png`, X: posX, Y: posY, Width: width, Height: height, Alpha: 255 });
      off += 0x70 - 1;
    }
  }
  // block 2: image lists (at 0x59 - 0x08 = 0x51)
  {
    const b2s = getDWord(data, 0x51), b2l = getDWord(data, 0x55);
    const blk = getByteArray(data, b2s, b2l);
    let off = 0x1E;
    while (off < blk.length && blk[off] > 0) {
      const sectionId = blk[off]; off++;
      const posX = getWord(blk, off), posY = getWord(blk, off + 2);
      const width = getWord(blk, off + 4), height = getWord(blk, off + 6);
      const count = blk[off + 8], type = blk[off + 9];
      if (type === 0) {
        const names = [];
        for (let i = 0; i < count; i++) {
          const dataOfs = getDWord(blk, off + 0x0A + i * 8), dataLen = getDWord(blk, off + 0x0E + i * 8);
          const bin = getByteArray(blk, dataOfs, dataLen);
          const dec = rw3aDecompress(bin, width, height, type);
          const { rgba } = decodeGTR(dec, width, height, 2, { blackTransparent: true });
          const nm = `image_${String(sectionId).padStart(2, '0')}_${String(i).padStart(4, '0')}.png`;
          images.set(nm, { width, height, rgba }); names.push(nm);
        }
        if (names.length) { try { widgets.push(v3Widget(sectionId, names, posX, posY, width, height)); } catch (e) { } }
      } else if (type === 2) {
        const names = [];
        const dataOfs = getDWord(blk, off + 0x0A), dataLen = getDWord(blk, off + 0x0E);
        for (let i = 0; i < count; i++) {
          const hdr = getByteArray(blk, dataOfs + i * dataLen, dataLen);
          const posLast = (getWord(hdr, 0) << 2) + 0x0c - 2;
          const dataSize = getWord(hdr, posLast) * 3;
          const pixelData = getByteArray(blk, getDWord(hdr, 2), dataSize);
          const bin = Buffer.concat([hdr, Buffer.alloc((4 - (pixelData.length % 4)) % 4), pixelData]);
          const dec = rw3aDecompress(bin, width, height, (dataLen << 8) | type);
          const bgra = rgb565AlphaToRGBA(dec);
          const rgba = bgraToRgba(bgra);
          const nm = `image_${String(sectionId).padStart(2, '0')}_${String(i).padStart(4, '0')}.png`;
          images.set(nm, { width, height, rgba }); names.push(nm);
        }
        if (names.length) { try { widgets.push(v3Widget(sectionId, names, posX, posY, width, height)); } catch (e) { } }
      } else if (type === 3) {
        const names = [];
        const dataOfs = getDWord(blk, off + 0x0A), dataLen = getDWord(blk, off + 0x0E);
        const color = getDWord(blk, off + 0x6A, 1);
        for (let i = 0; i < count; i++) {
          const hdr = getByteArray(blk, dataOfs + i * dataLen, dataLen);
          const posLast = (getWord(hdr, 0) << 2) + 0x0c - 2;
          const dataSize = getWord(hdr, posLast);
          const pixelData = getByteArray(blk, getDWord(hdr, 2), dataSize);
          const bin = Buffer.concat([hdr, Buffer.alloc((4 - (pixelData.length % 4)) % 4), pixelData]);
          const dec = rw3aDecompress(bin, width, height, (dataLen << 8) | type);
          const r = (color >> 16) & 0xFF, g = (color >> 8) & 0xFF, b = color & 0xFF;
          const rgba0 = Buffer.alloc(width * height * 4);
          for (let p = 0; p < width * height && p < dec.length; p++) {
            rgba0[p * 4] = r; rgba0[p * 4 + 1] = g; rgba0[p * 4 + 2] = b; rgba0[p * 4 + 3] = dec[p];
          }
          const flip = rgba0;
          const nm = `image_${String(sectionId).padStart(2, '0')}_${String(i).padStart(4, '0')}.png`;
          images.set(nm, { width, height, rgba: flip }); names.push(nm);
        }
        if (names.length) { try { widgets.push(v3Widget(sectionId, names, posX, posY, width, height, color >> 8)); } catch (e) { } }
      }
      off += 0x70 - 1;
    }
  }
  const titleLen = getByte(data, 0x14);
  const title = getUTF8String(data, 0x15, titleLen);
  return { title, images, widgets };
}

// ---------- entry ----------
function unpack(buffer) {
  const data = Buffer.from(buffer);
  const version = detectVersion(data);
  if (!version) throw new Error('Not a Xiaomi watchface (.bin) — bad magic');
  const { watchType, name } = getWatchType(data, version);
  if (version === 1) {
    const r = unpackV1(data, watchType);
    return { version, watchType, title: r.title, slots: [{ index: 0, widgets: r.widgets, images: r.images }], preview: null, rawName: name, faceId: getAsciiString(data, 40) };
  }
  if (version === 2) {
    const r = unpackV2(data, watchType);
    const allImages = new Map();
    for (const s of r.slots) for (const [k, v] of s.images) if (!allImages.has(k)) allImages.set(k, v);
    if (r.preview) allImages.set('preview.png', r.preview);
    return { version, watchType, title: r.title, slots: r.slots, preview: r.preview, allImages,
      animationCount: r.animationCount || 0, appCount: r.appCount || 0,
      subVersion: r.subVersion || 0,
      rawName: name, faceId: getAsciiString(data, 40) };
  }
  const r = unpackV3(data, watchType);
  return { version, watchType, title: r.title, slots: [{ index: 0, widgets: r.widgets, images: r.images }], preview: r.images.get('preview.png') || null, allImages: r.images, rawName: name, faceId: getAsciiString(data, 40) };
}

module.exports = { detectVersion, unpack };
