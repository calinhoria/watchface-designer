'use strict';
// V2 face compiler — pure-JS port of MiWatchCompiler DefaultPacker (official
// Xiaomi compiler) for the MiBand8ProRleCompressor watch family:
// { 11, 362, 365, 367, 462, 465, 562, 565 }.
// Input: designer project model. Output: .bin Buffer + warnings.
// Layout (all LE unless noted):
//   header 168B | faceHeaders 88B each | entry tables | blobs (4B-aligned on the
//   old generation, contiguous on the new one; preview last vs mid-stream)
const { setWord, setDWord, rgbaToBgra, bgraToPal8, bgraToRgba } = require('./binutils');
const { encodeV10, encodeV20 } = require('./rle');
const { PreviewSizes } = require('./watch');
const crypto = require('crypto');
// hash of an image's decoded RGBA, matching what the unpacker records so an
// untouched image's original encoded blob (PAL8/LVGL palette order we cannot
// re-synthesise) can be echoed verbatim.
function bgraHash(bgra) { return crypto.createHash('sha1').update(bgraToRgba(Buffer.from(bgra))).digest('hex'); }
function framesHash(frames) { return crypto.createHash('sha1').update(Buffer.concat(frames.map((f) => bgraToRgba(Buffer.from(f.bgra))))).digest('hex'); }

const SUPPORTED = new Set([11, 362, 365, 366, 367, 462, 465, 562, 565]);
// Devices whose stock faces store images palettized (PAL8 + LVGL, selector
// 0x10) whenever they fit in 256 colors: Watch 6 verified byte-for-byte;
// S3 / Mi Band 9 decode the same way (see unpacker) but have no stock sample
// here, so they share the rule. The 465 family stores RGBA even for 15-color
// images, so it is deliberately excluded.
const PAL8_DEVICES = new Set([362, 366, 565]);
const V2048 = new Set([4, 6, 7, 9, 11, 362, 365, 366, 367, 462, 465, 466, 562, 565, 567, 3651, 3652]);

const HEADER_HEX = '5AA5341200000000000000000000000001070000000000000000000001000000FFFFFFFF000000003136373231303036350000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
const FACE_HEADER_HEX = '00000000FFFFFFFFFFFFFFFF00FFFFFF0000000000000000FFFFFFFF02FFFFFFFFFFFFFF03FFFFFF00000000FFFFFFFF00000000FFFFFFFF00000000FFFFFFFFFFFFFFFF07FFFFFF00000000FFFFFFFF00000000FFFFFFFF';
const DEFAULT_FACE_ID = '167210065';
const MAGIC = Buffer.from([0xE0, 0x21, 0xA5, 0x5A]);

// RedmiWatch4ActionPacker 6-byte templates: blob[0..1]=t[0..1], blob[40..41]=t[2..3]
const RW4_ACTIONS = {
  steps: '310001003301', calories: '320001003301', standing: '330001003301', moving: '340001003301',
  hrm: '350001005300', spo2: '36000100E300', stress: '370001003300', sleep: '38000100C300',
  weather: '313005001302', alarm: '313101008302', timer: '313201006302', stopwatch: '313301000302',
  cards: '3134010CB302', music: '3135010C5301', compass: '323001008301', scheduler: '32310000B301',
  flashlight: '32320100A301', photo: '32330100C301', findphone: '323401007302', breath: '323501004300',
  contact: '32360100E302', egg: '323701003303', todo: '32380100C303', tomato: '32390100A303',
  worldclock: '35300100B303', phone: '353101003302', voice: '35320100D302', mihome: '35330100F303',
  women: '35340100F301', pressure: '353501003300', vitality: '353601006303', settings: '353701006301',
  launcher: '353A01001300', wechat: '333001005302', alipay: '33310100E301', checktool: '343001001304',
  calendar: '343101005304',
};
const ACTION_BLOB_SIZE = 56;
// Position-only tap zones (no button image) use the 52-byte NAME-based format
// seen in every stock Watch 6 face: name[0..15] + zeros + code[40..43] +
// zeros[44..47] + (ordinal | 0x02000000)[48..51]. Only the 9 apps below have
// byte-verified templates (harvested from stock faces); other apps must use an
// image layer (button format), which is what the official packer emits.
const ACTION_ZONE_SIZE = 52;
const ZONE_CODE = {
  music: '010c5f01', timer: '010c6f02', alarm: '010c8f02', flashlight: '010caf01',
  steps: '03023f01', calories: '03033f01', hrm: '03065f00', spo2: '0307ef00',
  weather: '030b1f02',
};
const ZONE_APPS = Object.keys(ZONE_CODE);
function zoneBlob(app, ordinal) {
  const code = ZONE_CODE[String(app).toLowerCase()];
  if (!code) throw new Error(`tap app "${app}" has no verified zone template — use an image layer for it`);
  const blob = Buffer.alloc(ACTION_ZONE_SIZE, 0);
  Buffer.from(String(app).toLowerCase(), 'ascii').copy(blob, 0, 0, 15);
  Buffer.from(code, 'hex').copy(blob, 40);
  setDWord(blob, 48, (ordinal | 0x02000000) >>> 0);
  return blob;
}

// FaceItemDataSrc.Parse port: hex(last4) + hex(leading)
function parseDataSrc(s) {
  s = String(s || '');
  const h = s.length > 4 ? s.slice(-4) : s;
  const l = s.length > 4 ? s.slice(0, -4) : '';
  return ((parseInt(h, 16) || 0) + (l ? parseInt(l, 16) || 0 : 0)) & 0xFFFF;
}
function parseAlignment(a) { return a === 1 ? 2 : a === 2 ? 0 : 1; }
const isButton = (n) => /^btn_/i.test(n || '');
const isAppW = (n) => /^app_/i.test(n || '');
const isAnimName = (n) => /^anim_/i.test(n || '');

function appNameOf(name) {
  const m = /\[([^\]]+)\]/.exec(name || '');
  return m ? m[1] : null;
}
// BitmapList entries: "(v):name" | "name"  -> {value|null, name}
function splitBitmaps(list) {
  return String(list || '').split('|').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^\(([^)]*)\):([\s\S]*)$/.exec(s);
    if (m) {
      const v = m[1] === '' ? null : parseInt(m[1], 10);
      return { value: Number.isFinite(v) ? v : null, name: m[2] };
    }
    return { value: null, name: s };
  });
}
// Normalized frame list for packing: inverts the unpacker's 10-frame digital
// artifact (appends a dup of frame 0 for display).
function packFrames(w) {
  let bmps = splitBitmaps(w.BitmapList);
  if (w.Shape === 32 && bmps.length === 11 && bmps[10].name === bmps[0].name) bmps = bmps.slice(0, 10);
  return bmps;
}
const HANDS = ['HourHandImage', 'MinuteHandImage', 'SecondHandImage'];
// A widget can carry a tap action two ways, mirroring the file format:
//  - Image layers become *button* layers: one element targets the action and the
//    action blob carries the image + size (this is how stock buttons work).
//  - any other layer keeps its own element and gets an EXTRA tap-zone element
//    (sec0 entry -> action) at the layer's top-left, like stock tap zones.
function tapApp(w) { return w._tap || (isButton(w.Name) ? appNameOf(w.Name) : null); }
function isButtonWidget(w) { return w.Shape === 30 && Boolean(w._tap || w._action || isButton(w.Name) || appNameOf(w.Name)); }
function isZoneTap(w) { return Boolean(w._tap) && w.Shape !== 30; }
// bounding box used for the action's W/H and the tap point
function tapBox(w) {
  const ww = w.Width || 0, hh = w.Height || 0;
  if (w.Shape === 32) {
    const n = Math.min(w.Digits || 1, (DIGIT_DEMO[String(w.DataSrcValue)] || '120000').length);
    return { x: w.X || 0, y: w.Y || 0, w: n > 1 ? n * ww + (n - 1) * (w.Spacing || 0) : ww, h: hh };
  }
  return { x: w.X || 0, y: w.Y || 0, w: ww, h: hh };
}
// Demo digit strings per DataSrcValue (mirrors unpacker's getStringSource);
// only the length matters (maxLen = min(Digits, len)).
const DIGIT_DEMO = {
  '1012': '10', '1812': '21', '2012': '3', '0811': '12', '1000911': '1',
  '0911': '2', '1011': '45', '1211': '4', '1111': '5', '1811': '28',
  '1001911': '2', '1911': '8', '0821': '15652', '0823': '12175', '0822': '174',
  '0824': '10', '0826': '42', '0828': '60', '0841': '100', '2031': '23',
  '3031': '1', '5031': '2',
};

function compileFaceProject(proj) {
  const { deviceType, title, faceId, slots } = proj;
  const warnings = [];
  if (Buffer.from(HEADER_HEX, 'hex').length !== 168 || Buffer.from(FACE_HEADER_HEX, 'hex').length !== 88)
    throw new Error('Internal error: bad header templates.');
  if (!SUPPORTED.has(deviceType)) throw new Error(`Compiler v1 supports watches ${[...SUPPORTED].join(', ')}; got ${deviceType}.`);
  if (!slots || !slots.length) throw new Error('No slots to compile.');
  if (slots.length > 1 && !slots.some((s) => s.aod))
    warnings.push(`${slots.length} faces compiled, none flagged AOD — slot 2+ will show as normal faces.`);

  const header = Buffer.from(HEADER_HEX, 'hex');
  setDWord(header, 28, slots.length);
  if (V2048.has(deviceType)) setDWord(header, 16, 2048);
  // subVersion echo: stock 565 faces carry 1, dual-slot 465 faces carry 2, plain
  // 465 faces carry 0. New projects default the same way (PAL8 devices -> 1).
  let subVer = proj.subVersion;
  if (subVer == null) subVer = slots.length > 1 ? 2 : (PAL8_DEVICES.has(deviceType) ? 1 : 0);
  setWord(header, 30, subVer);
  // subVersion >= 32 faces (global store multi-style packs) carry a 72-byte
  // per-face name block: each face occupies 160 bytes and the tables start
  // at 168 + count*160.
  const multiBlock = subVer >= 32;
  const FACE_BLOCK = multiBlock ? 160 : 88;
  const NAME_BLOCK = 72;
  const titleBuf = Buffer.from(String(title || ''), 'utf8');
  if (titleBuf.length > 64) throw new Error(`Title too long (${titleBuf.length}B, max 64).`);
  titleBuf.copy(header, 104);
  const idBuf = Buffer.from(String(faceId || DEFAULT_FACE_ID), 'ascii');
  if (idBuf.length > 64) throw new Error('Face ID too long (max 64).');
  header.fill(0, 40, 104);
  idBuf.copy(header, 40);

  const faces = slots.map((s, fi) => prepareFace(deviceType, s, fi, warnings));
  // file-wide ordinals for sec 2/3/7 (stock keeps counting across faces)
  {
    const run = { 2: 0, 3: 0, 7: 0 };
    for (const f of faces) {
      f.ordBase = { 2: run[2], 3: run[3], 7: run[7] };
      run[2] += f.counts[2]; run[3] += f.counts[3]; run[7] += f.counts[7];
    }
  }
  // entry ids are fully determined by the ordinals, so assign every
  // cross-reference up front: the blob allocation order below can then follow
  // stock (which differs per generation) without breaking the links
  for (const f of faces) {
    f.singles.forEach((s, i) => {
      const id = (0x02000000 | ((f.ordBase[2] + i) & 0xFF)) >>> 0;
      s.entryId = id; s.assign(id);
    });
    f.lists.forEach((L, i) => {
      const id = (0x03000000 | ((f.ordBase[3] + i) & 0xFF)) >>> 0;
      L.users.forEach(u => u(id));
    });
    f.widgets7.forEach((w7, i) => {
      const id = (0x07000000 | ((f.ordBase[7] + i) & 0xFF)) >>> 0;
      if (w7.hand) w7.widget['_' + w7.hand.replace('HandImage', '') + 'TargetId'] = id;
      else w7.widget._TargetId = id;
    });
    f.actions.forEach((a, i) => {
      if (a.kind === 'button') a.widget._ActionId = (0x09000000 | (i & 0xFF)) >>> 0;
    });
  }

  // table layout: contiguous per face, sections 0..9 in order
  const faceAreaEnd = 168 + slots.length * FACE_BLOCK;
  let tableCursor = faceAreaEnd;
  for (const f of faces) {
    for (let k = 0; k < 10; k++) {
      f.secTable[k] = tableCursor;
      tableCursor += f.counts[k] * 16;
    }
    f.secTable[1] = f.secTable[2]; // sec1 shares sec2 table pos (official)
    f.secTable[6] = f.secTable[7]; // sec6 shares sec7 table pos (official)
  }
  const tables = Buffer.alloc(tableCursor - faceAreaEnd, 0);
  const tablesBase = faceAreaEnd;
  let blobCursor = tableCursor;
  const blobParts = [];
  // the old generation pads every blob to 4 bytes (gaps of 1-3 zeros between
  // blobs); the new one packs blobs contiguously with no padding
  const padBlobs = !PAL8_DEVICES.has(deviceType);
  const alloc = (size) => {
    const off = blobCursor;
    blobCursor += padBlobs ? (size + 3) & ~3 : size;
    return off;
  };
  const entryAt = (f, sec, idx) => f.secTable[sec] + idx * 16 - tablesBase;
  // Entry ids carry a per-section ordinal, not just the table position: image /
  // list / widget entries (sec 2/3/7) keep counting across the faces of a
  // multi-slot file (slot 1 of a 2-slot face starts at 16/4/10), while elements
  // and actions (sec 0/9) restart at 0 per face. Pass ordinal for the former,
  // omit it for the latter.
  const wEntry = (f, sec, idx, marker, blobOff, blobSize, ordinal) => {
    const ord = ordinal == null ? idx : ordinal;
    const p = entryAt(f, sec, idx);
    tables[p] = ord & 0xFF;
    tables[p + 3] = marker;
    setDWord(tables, p + 8, blobOff);
    setDWord(tables, p + 12, blobSize);
    return ((ord & 0xFF) | (marker << 24)) >>> 0;
  };

  // preview payload (built once; allocated mid-stream for the new generation)
  const pv = faces[0].preview;
  checkPreviewSize(deviceType, pv.w, pv.h);
  let pvBlob;
  if (pv.enc && pv.enc.hash === bgraHash(pv.bgra)) {
    pvBlob = Buffer.from(pv.enc.blob, 'hex'); // untouched: echo the stock preview
  } else {
    const pvPay = imagePayload(deviceType, pv.w, pv.h, pv.bgra, 'auto');
    pvBlob = Buffer.alloc(12 + pvPay.cpr.length, 0);
    pvBlob.set([pvPay.rle, 4, 0, 0], 0);
    setWord(pvBlob, 4, pv.w); setWord(pvBlob, 6, pv.h);
    setDWord(pvBlob, 8, pvPay.cpr.length);
    pvPay.cpr.copy(pvBlob, 12);
  }
  // the old generation pads blobs (including the preview) to 4 bytes; the
  // new one appends the preview unpadded. Trailing pad zeros sit outside cprLen
  // and are ignored by the decoder.
  const pvPadded = padBlobs ? Buffer.alloc((pvBlob.length + 3) & ~3, 0) : pvBlob;
  if (padBlobs) pvBlob.copy(pvPadded, 0);
  let previewOff = 0;
  const allocPreview = () => {
    previewOff = alloc(pvPadded.length);
    blobParts.push({ off: previewOff, buf: pvPadded });
  };
  // stock shares one data blob between entries whose image content is identical
  // (same section only — never observed across sections), but only in the new
  // generation: 465 stock keeps identical blobs at separate offsets, while
  // Watch 6 stock points the second entry at the first blob
  const crypto = require('crypto');
  const dedupImages = PAL8_DEVICES.has(deviceType);
  const sharedBlobs = new Map();
  const allocShared = (sec, blob) => {
    if (!dedupImages) {
      const off = alloc(blob.length);
      return { off, fresh: true };
    }
    const key = sec + ':' + crypto.createHash('sha1').update(blob).digest('hex');
    const hit = sharedBlobs.get(key);
    if (hit != null) return { off: hit, fresh: false };
    const off = alloc(blob.length);
    sharedBlobs.set(key, off);
    return { off, fresh: true };
  };
  // stock blob order differs per generation: the new one (Watch 6) packs
  // elements, widgets, actions, then the preview, then the image data; the old
  // one packs all image data first and the preview last
  const newOrder = PAL8_DEVICES.has(deviceType);

  faces.forEach((f, fi) => {
    // face header + section dir
    const fh = Buffer.from(FACE_HEADER_HEX, 'hex');
    if (multiBlock) {
      // global-store faces: header dword0 = 0x80000000, dword1 = own preview
      // offset (0 for the AOD variant); a 72-byte name block follows the dir
      setDWord(fh, 0, 0x80000000);
      setDWord(fh, 4, fi === 0 ? 0 : (f.aod ? 0 : (f.previewOffset || 0)));
    }
    const nameBlk = Buffer.alloc(NAME_BLOCK, 0);
    if (multiBlock && f.nameBlock) {
      try { Buffer.from(f.nameBlock, 'hex').copy(nameBlk, 0, 0, NAME_BLOCK); } catch (e) { }
    }
    for (let k = 0; k < 10; k++) {
      setDWord(fh, 8 + k * 8, f.counts[k]);
      if (k === 1) setDWord(fh, 12 + k * 8, f.secTable[2]);
      else if (k === 6) { /* count stays template 0 */ setDWord(fh, 12 + k * 8, f.secTable[7]); }
      else setDWord(fh, 12 + k * 8, f.secTable[k]);
    }
    // concat after the counts are written into fh
    f.fh = multiBlock ? Buffer.concat([fh, nameBlk]) : fh;
    // ordinals for this face: sec 2/3/7 continue the file-wide counters so a
    // second slot's images/lists/widgets keep stock numbering
    const ord2 = f.ordBase[2], ord3 = f.ordBase[3], ord7 = f.ordBase[7];
    const zoneTotal = f.actions.filter(a => a.kind === 'zone').length;
    // ELEMENTS
    const allocElements = () => {
      f.elements.forEach((el, i) => {
        const bo = alloc(16);
        wEntry(f, 0, i, 0, bo, 16);
        const blob = Buffer.alloc(16, 0);
        blobParts.push({ off: bo, buf: blob, el });
      });
    };
    // WIDGETS (reserve; content in fillWidget)
    const allocWidgets = () => {
      f.widgets7.forEach((w7, i) => {
        const bo = alloc(w7.blobSize);
        wEntry(f, 7, i, 7, bo, w7.blobSize, ord7 + i);
        const blob = Buffer.alloc(w7.blobSize, 0);
        blobParts.push({ off: bo, buf: blob, w7 });
      });
    };
    // SINGLES
    const allocSingles = () => {
      f.singles.forEach((s, i) => {
        let blob;
        if (s.enc && s.enc.hash === bgraHash(s.bgra)) {
          blob = Buffer.from(s.enc.blob, 'hex'); // untouched: echo verbatim
        } else {
          const pay = imagePayload(deviceType, s.w, s.h, s.bgra, 'auto');
          blob = Buffer.alloc(12 + pay.cpr.length, 0);
          blob.set([pay.rle, 4, 0, 0], 0); // byte0 = rle selector: 0x00 = v10, 0x10 = LVGL
          setWord(blob, 4, s.w); setWord(blob, 6, s.h);
          setDWord(blob, 8, pay.cpr.length);
          pay.cpr.copy(blob, 12);
        }
        const al = allocShared(2, blob);
        wEntry(f, 2, i, 2, al.off, blob.length, ord2 + i);
        if (al.fresh) blobParts.push({ off: al.off, buf: blob });
      });
    };
    // LISTS
    const allocLists = () => {
      f.lists.forEach((L, i) => {
        let blob;
        if (L.listEnc && L.listEnc.hash === framesHash(L.frames)) {
          blob = Buffer.from(L.listEnc.blob, 'hex'); // untouched: echo verbatim
        } else {
          // one blob, one rle selector: PAL8 only when every frame palettizes
          const listPal8 = PAL8_DEVICES.has(deviceType) && L.frames.every(fr => bgraToPal8(fr.bgra));
          const payloads = L.frames.map(fr => imagePayload(deviceType, fr.w, fr.h, fr.bgra, listPal8 ? 'pal8' : 'rgba').cpr);
          const rle = listPal8 ? 0x10 : 0x00;
          const total = 12 + 4 * payloads.length + payloads.reduce((a, p) => a + p.length, 0);
          blob = Buffer.alloc(total, 0);
          blob.set([rle, payloads.length, 4, 0], 0); // byte0 = rle selector
          setWord(blob, 4, L.w); setWord(blob, 6, L.h);
          // PAL8 lists count the per-frame size table as payload (total-12);
          // RGBA lists count stream bytes only (total-12-4n). Both verified stock.
          setDWord(blob, 8, listPal8 ? total - 12 : total - 12 - 4 * payloads.length);
          payloads.forEach((p, j) => setDWord(blob, 12 + j * 4, p.length));
          let po = 12 + 4 * payloads.length;
          for (const p of payloads) { p.copy(blob, po); po += p.length; }
        }
        const al = allocShared(3, blob);
        wEntry(f, 3, i, 3, al.off, blob.length, ord3 + i);
        if (al.fresh) blobParts.push({ off: al.off, buf: blob });
      });
    };
    // ACTIONS (button ImageIds were assigned up front)
    const allocActions = () => {
      let zoneCount = 0;
      f.actions.forEach((a, i) => {
        const w = a.widget;
        const box = tapBox(w);
        const isZone = a.kind === 'zone';
        const blob = isZone ? zoneBlob(tapApp(w), i + 1)
          : (w._actionRaw ? (() => {
            const b2 = Buffer.from(w._actionRaw, 'hex');
            setDWord(b2, 48, (w._ImageId || 0) >>> 0);   // keep the stock layout
            return b2;
          })()
            : (w._action ? actionFromHeads(w._action, w._ImageId, box.w, box.h)
              : actionFromTemplate(tapApp(w), w._ImageId, box.w, box.h)));
        const blobLen = blob.length;
        const bo = alloc(blobLen);
        const id = wEntry(f, 9, i, 9, bo, blobLen);
        blobParts.push({ off: bo, buf: blob });
        if (a.kind !== 'button') {
          // zone: extra element at the layer's top-left targeting the action
          const eb = Buffer.alloc(16, 0);
          const ebo = alloc(16);
          wEntry(f, 0, f.elements.length + zoneCount, 0, ebo, 16);
          zoneCount += 1;
          blobParts.push({ off: ebo, buf: eb, el: { widget: { X: box.x, Y: box.y }, face: f, tidOverride: id } });
        }
      });
    };
    // orphan tap zones: verbatim blobs + elements (stock order: after widgets)
    const allocRaw = () => {
      f.rawActions.forEach((r, j) => {
        const blob = Buffer.from(r.blob, 'hex');
        const bo = alloc(blob.length);
        const id = wEntry(f, 9, f.actions.length + j, 9, bo, blob.length);
        blobParts.push({ off: bo, buf: blob });
        const eb = Buffer.alloc(16, 0);
        const ebo = alloc(16);
        wEntry(f, 0, f.elements.length + zoneTotal + j, 0, ebo, 16);
        blobParts.push({ off: ebo, buf: eb, el: { widget: { X: r.x, Y: r.y }, face: f, tidOverride: id } });
      });
    };
    // orphan sec9 records (AOD slots): verbatim, no element, after raw zones
    const allocOrphans = () => {
      const base = f.actions.length + f.rawActions.length;
      f.orphanSec9.forEach((hex, j) => {
        const blob = Buffer.from(hex, 'hex');
        const bo = alloc(blob.length);
        wEntry(f, 9, base + j, 9, bo, blob.length);
        blobParts.push({ off: bo, buf: blob });
      });
    };
    if (newOrder) {
      allocElements(); allocWidgets(); allocActions(); allocRaw(); allocOrphans();
      if (fi === 0) allocPreview();
      allocSingles(); allocLists();
    } else {
      allocElements(); allocWidgets(); allocSingles(); allocLists(); allocActions(); allocRaw(); allocOrphans();
    }
    for (const bp of blobParts) if (bp.el && bp.el.face === f) fillElement(bp.buf, bp.el);
    for (const bp of blobParts) if (bp.w7 && bp.w7.face === f) fillWidget(bp.buf, bp.w7);
  });
  if (!newOrder) allocPreview();

  // assemble
  const parts = [header];
  faces.forEach((f) => parts.push(f.fh));
  parts.push(tables);
  const totalLen = blobCursor;
  const bin = Buffer.alloc(totalLen, 0);
  let pos = 0;
  for (const part of parts) { part.copy(bin, pos); pos += part.length; }
  for (const bp of blobParts) bp.buf.copy(bin, bp.off);
  // preview location recorded at allocation time (mid-stream for the new
  // generation, at the end otherwise)
  setDWord(bin, 32, previewOff);
  setDWord(bin, 168 + 4, previewOff);
  return { bin, warnings };
}

// compressed payload shared by singles/lists/preview: [magic][(len<<4)|type][stream]
function rgbaPayload(w, h, bgra) {
  if (bgra.length !== w * h * 4) throw new Error(`Pixel data ${bgra.length} mismatches ${w}x${h}.`);
  const payload = encodeV10(bgra, 4);
  const head = Buffer.alloc(8, 0);
  MAGIC.copy(head, 0);
  setDWord(head, 4, ((bgra.length << 4) | 4) >>> 0);
  return Buffer.concat([head, payload]);
}
// PAL8 payload for the 565 family (and S3 / Mi Band 9): [magic][(decLen<<4)|1]
// followed by the LVGL stream over (1024B palette + indices). Returns null when
// the image has more than 256 colors — caller falls back to RGBA.
function pal8Payload(w, h, bgra) {
  if (bgra.length !== w * h * 4) throw new Error(`Pixel data ${bgra.length} mismatches ${w}x${h}.`);
  const pal = bgraToPal8(bgra);
  if (!pal) return null;
  const raw = Buffer.concat([pal.palette, pal.indices]);
  if (raw.length !== 1024 + w * h) return null;
  const stream = encodeV20(raw);
  const head = Buffer.alloc(8, 0);
  MAGIC.copy(head, 0);
  setDWord(head, 4, (((raw.length << 4) | 1) >>> 0));
  return Buffer.concat([head, stream]);
}
// mode 'auto': PAL8 on PAL8 devices when the image fits, else RGBA.
// 'pal8'/'rgba' force the codec (pal8 falls back to RGBA when impossible).
function imagePayload(deviceType, w, h, bgra, mode) {
  const wantPal8 = mode === 'pal8' || (mode !== 'rgba' && PAL8_DEVICES.has(deviceType));
  if (wantPal8) {
    const p = pal8Payload(w, h, bgra);
    if (p) return { rle: 0x10, cpr: p };
    if (mode === 'pal8') throw new Error(`Image ${w}x${h} has more than 256 colors, cannot store as PAL8.`);
  }
  return { rle: 0x00, cpr: rgbaPayload(w, h, bgra) };
}

// ---- face preparation: validate + expand model into pack plan ----
function prepareFace(deviceType, slot, faceIndex, warnings) {
  // hidden layers are design-time only: excluded from compile
  const widgets = (slot.widgets || []).filter(w => !w._hidden);
  const images = slot.images || {};
  const getImg = (name) => {
    const im = images[name];
    if (!im || !im.data) throw new Error(`Image not found: ${name}`);
    return { width: im.width, height: im.height, data: Buffer.from(im.data), origBlob: im.origBlob, rgbaHash: im.rgbaHash, listEnc: im.listEnc };
  };
  for (const w of widgets) {
    if (![30, 31, 32, 27].includes(w.Shape)) throw new Error(`Widget "${w.Name}": shape ${w.Shape} unsupported in v1 (30/31/32/27 only).`);
    if (w.Shape === 30 && isAppW(w.Name)) throw new Error(`Widget "${w.Name}": app widgets unsupported in v1.`);
    if (w.Shape === 31 && isAnimName(w.Name)) throw new Error(`Widget "${w.Name}": animations unsupported in v1.`);
    if (w.Shape === 31 || w.Shape === 32) {
      if (!splitBitmaps(w.BitmapList).length) throw new Error(`Widget "${w.Name}": empty BitmapList.`);
    }
    if (w.Shape === 30 && isButton(w.Name) && !appNameOf(w.Name) && !w._action)
      throw new Error(`Button "${w.Name}": needs an [app] suffix (e.g. ${w.Name}_[alarm]) or original action data.`);
  }
  const handsOf = (w) => HANDS.filter(k => w[k]);
  // counts
  let nElem = 0, nSingle = 0, nWidget = 0, nAction = 0;
  const listOrder = [];
  const seenList = new Set();
  for (const w of widgets) {
    if (w.Shape === 30) { nElem += 1; nSingle += 1; if (isButtonWidget(w)) nAction += 1; }
    if (w._imgWidget) nWidget += 1;   // value-driven image: needs a sec7 entry
    else if (w.Shape === 27) { const h = handsOf(w).length; nElem += h; nSingle += h; nWidget += h; }
    else if (w.Shape === 31 || w.Shape === 32) {
      nElem += 1; nWidget += 1;
      if (isZoneTap(w)) { nElem += 1; nAction += 1; } // extra tap-zone element
      const key = packFrames(w).map(b => b.name).join('|');
      if (!seenList.has(key)) { seenList.add(key); listOrder.push(key); }
    }
  }
  // orphan tap zones (raw sec9 blobs + their sec0 elements) round-trip verbatim
  const rawActions = (slot.rawActions || []).filter(r => r && r.blob);
  // sec9 records with no element (AOD slots): verbatim, no element
  const orphanSec9 = (slot.orphanSec9 || []).filter(h => typeof h === 'string' && h.length);
  nElem += rawActions.length;
  nAction += rawActions.length + orphanSec9.length;
  const counts = [nElem, 0, nSingle, listOrder.length, 0, 0, 0, nWidget, 0, nAction];
  const f = { counts, aod: Boolean(slot.aod), aodFlag: slot.aodFlag >>> 0, previewOffset: slot.previewOffset >>> 0, nameBlock: slot.nameBlock || null, orphanSec9, secTable: new Array(10).fill(0), elements: [], singles: [], lists: [], widgets7: [], actions: [], widgets, preview: null, rawActions };
  // elements (widget order; clocks expand to hands)
  widgets.forEach((w) => {
    if (w.Shape === 27) {
      for (const k of HANDS) if (w[k]) f.elements.push({ widget: w, hand: k, face: f });
    } else f.elements.push({ widget: w, hand: null, face: f });
  });
  // singles (widget order)
  const pushSingle = (name, assign) => {
    const im = getImg(name);
    f.singles.push({ name, w: im.width, h: im.height, bgra: rgbaToBgra(im.data), assign, enc: im.origBlob && im.rgbaHash ? { blob: im.origBlob, hash: im.rgbaHash } : null });
  };
  for (const w of widgets) {
    if (w.Shape === 30) pushSingle(w.Bitmap, (id) => { w._ImageId = id; });
    else if (w.Shape === 27) {
      for (const k of HANDS) {
        if (!w[k]) continue;
        const tkey = '_' + k.replace('HandImage', '') + 'ImageId';
        pushSingle(w[k], (id) => { w[tkey] = id; });
      }
    }
  }
  // lists (dedup by bitmap names)
  const byKey = {};
  for (const w of widgets) {
    if (w.Shape !== 31 && w.Shape !== 32) continue;
    const bmps = packFrames(w);
    const key = bmps.map(b => b.name).join('|');
    if (!byKey[key]) {
      const frames = bmps.map(b => {
        const im = getImg(b.name);
        return { name: b.name, w: im.width, h: im.height, bgra: rgbaToBgra(im.data), enc: im.listEnc || null };
      });
      for (const fr of frames) {
        if (fr.w !== frames[0].w || fr.h !== frames[0].h) throw new Error(`Widget "${w.Name}": list images must share dimensions.`);
      }
      byKey[key] = {
        key, w: frames[0].w, h: frames[0].h, frames,
        listEnc: frames[0].enc || null,
        values: bmps.map((b, i) => (b.value == null ? i : b.value)),
        users: [],
      };
    }
    byKey[key].users.push((id) => { w._ImageId = id; });
    if (w.Shape === 32) w._firstBmpW = byKey[key].frames[0].w;
  }
  for (const key of listOrder) {
    const L = byKey[key];
    f.lists.push(L);
  }
  // widgets7 (sec7; clocks expand)
  for (const w of widgets) {
    if (w.Shape === 30 && w._imgWidget) {
      const rawLen = w._imgWidget.raw ? w._imgWidget.raw.length / 2 : 20;
      f.widgets7.push({ widget: w, hand: null, blobSize: rawLen, imgWidget: true, face: f });
      continue;
    }
    if (w.Shape === 30) continue;
    if (w.Shape === 27) {
      for (const k of HANDS) if (w[k]) f.widgets7.push({ widget: w, hand: k, blobSize: 32, face: f });
    } else if (w.Shape === 31) {
      const frames = packFrames(w);
      const values = frames.map((b, i) => (b.value == null ? i : b.value));
      // Values array exists only when custom (any value != its index);
      // otherwise a fixed 20-byte blob with [12]=0 (observed in stock).
      const custom = Boolean(w._listValues) || values.some((v, i) => v !== i);
      const L = byKey[frames.map(b => b.name).join('|')];
      f.widgets7.push({ widget: w, hand: null, blobSize: custom ? 16 + 4 * frames.length : 20, values, custom, face: f });
    } else if (w.Shape === 32) {
      f.widgets7.push({ widget: w, hand: null, blobSize: 20, face: f });
    }
  }
  // actions (buttons in widget order; blobs built at pack time)
  for (const w of widgets) {
    if (isButtonWidget(w)) {
      if (!w._action && !tapApp(w)) throw new Error(`Button "${w.Name}": needs a tap app (e.g. alarm).`);
      f.actions.push({ widget: w, kind: 'button' });
    } else if (isZoneTap(w)) {
      const app = String(w._tap).toLowerCase();
      if (!RW4_ACTIONS[app]) throw new Error(`Layer "${w.Name}": unknown tap app "${w._tap}".`);
      if (!ZONE_CODE[app]) {
        throw new Error(`Layer "${w.Name}": "${app}" has no verified tap-zone template. Use an image layer for it (image layers can carry any of the 37 apps).`);
      }
      f.actions.push({ widget: w, kind: 'zone' });
    }
  }
  // preview
  const pv = slot.preview;
  if (!pv || !pv.data) throw new Error('Slot needs a preview image.');
  f.preview = { w: pv.width, h: pv.height, bgra: rgbaToBgra(pv.data), enc: pv.origBlob && pv.rgbaHash ? { blob: pv.origBlob, hash: pv.rgbaHash } : null };
  // orphan images (not referenced by any packed entry) are dropped like official does.
  // NOTE: collected from the pack plan (singles/lists), not by re-scanning widgets.
  const used = new Set();
  for (const s of f.singles) used.add(s.name);
  for (const L of f.lists) for (const fr of L.frames) used.add(fr.name);
  for (const name of Object.keys(images)) {
    if (!used.has(name)) warnings.push(`Dropped unreferenced image ${name}.`);
  }
  return f;
}

function actionFromTemplate(app, imageId, W, H) {
  const t = RW4_ACTIONS[String(app).toLowerCase()];
  if (!t) throw new Error(`Unknown tap app "${app}" (not in action table).`);
  return actionBytes(Buffer.from(t, 'hex'), imageId, W, H);
}
function actionFromHeads(heads, imageId, W, H) {
  const tb = Buffer.alloc(6, 0);
  Buffer.from(heads.h0, 'hex').copy(tb, 0);
  Buffer.from(heads.h40, 'hex').copy(tb, 2);
  return actionBytes(tb, imageId, W, H);
}
function actionBytes(tb, imageId, W, H) {
  const blob = Buffer.alloc(ACTION_BLOB_SIZE, 0);
  tb.copy(blob, 0, 0, 2);
  tb.copy(blob, 40, 2, 4);
  // imageId 0 = position-only tap zone (no button image), as in stock faces
  setDWord(blob, 48, (imageId || 0) >>> 0);
  setWord(blob, 52, W || 0); setWord(blob, 54, H || 0);
  return blob;
}

function checkPreviewSize(dev, w, h) {
  const ok = (PreviewSizes || []).some(([t, pw, ph]) => t === dev && pw === w && ph === h);
  if (!ok) throw new Error(`Preview is ${w}x${h}; no known preview size for device ${dev}.`);
}

function fillElement(buf, el) {
  const w = el.widget;
  if (el.tidOverride != null) {
    setDWord(buf, 0, el.tidOverride >>> 0);
    setWord(buf, 4, w.X || 0); setWord(buf, 6, w.Y || 0);
    return;
  }
  if (el.hand) {
    const piv = el.hand === 'HourHandImage' ? [w.HourImageRotateX || 0, w.HourImageRotateY || 0]
      : el.hand === 'MinuteHandImage' ? [w.MinuteImageRotateX || 0, w.MinuteImageRotateY || 0]
      : [w.SecondImageRotateX || 0, w.SecondImageRotateY || 0];
    const tkey = '_' + el.hand.replace('HandImage', '') + 'TargetId';
    const X = ((w.X || 0) + Math.floor((w.Width || 0) / 2)) - piv[0];
    const Y = ((w.Y || 0) + Math.floor((w.Height || 0) / 2)) - piv[1];
    setDWord(buf, 0, w[tkey] >>> 0);
    setWord(buf, 4, X); setWord(buf, 6, Y);
    return;
  }
  let X = w.X || 0, Y = w.Y || 0;
  if (w.Shape === 32) {
    // Inverse of the unpacker's align shift (model domain: 0=left/full,
    // 1=center/half, 2=right/none; spacing ignored like both sides do).
    const bw = w._firstBmpW || 0;
    const demoLen = (DIGIT_DEMO[String(w.DataSrcValue)] || '120000').length;
    const maxLen = Math.min(w.Digits || 0, demoLen);
    if (w.Alignment === 0) X += bw * maxLen;
    else if (w.Alignment === 1) X += (bw * maxLen) / 2;
  }
  const tid = w.Shape === 30
    ? (w._ActionId != null ? w._ActionId : (w._imgWidget && w._TargetId != null ? w._TargetId : w._ImageId))
    : w._TargetId;
  setDWord(buf, 0, tid >>> 0);
  setWord(buf, 4, X); setWord(buf, 6, Y);
}

function fillWidget(buf, w7) {
  const w = w7.widget;
  if (w7.imgWidget) {
    // TypeId 4 value-driven image: stock blobs carry extra bytes we do not
    // model, so emit the original verbatim and patch only the image id.
    const raw = w._imgWidget && w._imgWidget.raw ? Buffer.from(w._imgWidget.raw, 'hex') : null;
    if (raw && raw.length >= 12) {
      raw.copy(buf, 0, 0, Math.min(raw.length, buf.length));
      setDWord(buf, 8, w._ImageId >>> 0);
      return;
    }
    setWord(buf, 0, parseDataSrc(w.DataSrcValue), 1);
    buf[2] = 0;
    const align = w._imgWidget ? (w._imgWidget.align || 0) : 0;
    buf[3] = 64 | (align & 3); // 4 << 4
    setDWord(buf, 8, w._ImageId >>> 0);
    return;
  }
  if (w7.hand) {
    const isH = w7.hand === 'HourHandImage', isM = w7.hand === 'MinuteHandImage';
    setWord(buf, 0, parseDataSrc(isH ? '0811' : isM ? '1011' : '1811'), 1);
    buf[3] = 48;
    setWord(buf, 6, 1000);
    const iid = isH ? w._HourImageId : isM ? w._MinuteImageId : w._SecondImageId;
    setDWord(buf, 8, iid >>> 0);
    buf[17] = isH ? 24 : 60;
    const piv = isH ? [w.HourImageRotateX || 0, w.HourImageRotateY || 0] : isM ? [w.MinuteImageRotateX || 0, w.MinuteImageRotateY || 0] : [w.SecondImageRotateX || 0, w.SecondImageRotateY || 0];
    setWord(buf, 20, piv[0]); setWord(buf, 22, piv[1]);
    setWord(buf, 24, 0);
    setWord(buf, 26, isH ? 7200 : 3600);
    return;
  }
  if (w.Shape === 31) {
    setWord(buf, 0, parseDataSrc(w.DataSrcIndex), 1);
    buf[3] = 32;
    setDWord(buf, 8, w._ImageId >>> 0);
    setDWord(buf, 12, w7.custom ? 512 : 0);
    if (w7.custom) w7.values.forEach((v, i) => setDWord(buf, 16 + i * 4, v));
    return;
  }
  if (w.Shape === 32) {
    setWord(buf, 0, parseDataSrc(w.DataSrcValue), 1);
    buf[2] = w.Digits || 0;
    // Low 2 bits must reproduce the source byte: our model Alignment is in
    // unpacker domain (getTextAlignment: raw 0->0, 1->2, 2->1), so invert it
    // (0->0, 1->2, 2->1). NOTE this differs from official ParseAlignment
    // (1->2, 2->0, else->1) which operates on new-DLL-domain values.
    const al = w.Alignment || 0;
    buf[3] = 16 | (w.Blanking ? 0 : 4) | (al === 1 ? 2 : al === 2 ? 1 : 0);
    // echo the source values when known (Watch 6 ships 1000 at +6, Redmi
    // Watch 5 ships 0) so untouched faces recompile byte-identically
    setWord(buf, 4, w._u4 != null ? w._u4 : 0);
    setWord(buf, 6, w._u6 != null ? w._u6 : 1000);
    setDWord(buf, 8, w._ImageId >>> 0);
    buf[13] = w.Spacing || 0;
  }
}

module.exports = { compileFaceProject, SUPPORTED, parseDataSrc, parseAlignment, RW4_ACTIONS, ZONE_APPS };
