'use strict';
// V2 face compiler — pure-JS port of MiWatchCompiler DefaultPacker (official
// Xiaomi compiler) for the MiBand8ProRleCompressor watch family:
// { 11, 362, 365, 367, 462, 465, 562, 565 }.
// Input: designer project model. Output: .bin Buffer + warnings.
// Layout (all LE unless noted):
//   header 168B | faceHeaders 88B each | entry tables | blobs (4B-aligned)
const { setWord, setDWord, rgbaToBgra } = require('./binutils');
const { encodeV10 } = require('./rle');
const { PreviewSizes } = require('./watch');

const SUPPORTED = new Set([11, 362, 365, 367, 462, 465, 562, 565]);
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
  if (slots.length > 1) warnings.push(`${slots.length} slots compiled as plain faces (AOD-ness not preserved).`);

  const header = Buffer.from(HEADER_HEX, 'hex');
  setDWord(header, 28, slots.length);
  if (V2048.has(deviceType)) setDWord(header, 16, 2048);
  if (slots.length > 1) header[30] = 2;
  const titleBuf = Buffer.from(String(title || ''), 'utf8');
  if (titleBuf.length > 64) throw new Error(`Title too long (${titleBuf.length}B, max 64).`);
  titleBuf.copy(header, 104);
  const idBuf = Buffer.from(String(faceId || DEFAULT_FACE_ID), 'ascii');
  if (idBuf.length > 64) throw new Error('Face ID too long (max 64).');
  header.fill(0, 40, 104);
  idBuf.copy(header, 40);

  const faces = slots.map((s, fi) => prepareFace(deviceType, s, fi, warnings));

  // table layout: contiguous per face, sections 0..9 in order
  let tableCursor = 168 + slots.length * 88;
  for (const f of faces) {
    for (let k = 0; k < 10; k++) {
      f.secTable[k] = tableCursor;
      tableCursor += f.counts[k] * 16;
    }
    f.secTable[1] = f.secTable[2]; // sec1 shares sec2 table pos (official)
    f.secTable[6] = f.secTable[7]; // sec6 shares sec7 table pos (official)
  }
  const tables = Buffer.alloc(tableCursor - (168 + slots.length * 88), 0);
  const tablesBase = 168 + slots.length * 88;
  let blobCursor = tableCursor;
  const blobParts = [];
  const alloc = (size) => {
    const off = blobCursor;
    blobCursor += (size + 3) & ~3;
    return off;
  };
  const entryAt = (f, sec, idx) => f.secTable[sec] + idx * 16 - tablesBase;
  const wEntry = (f, sec, idx, marker, blobOff, blobSize) => {
    const p = entryAt(f, sec, idx);
    tables[p] = idx & 0xFF;
    tables[p + 3] = marker;
    setDWord(tables, p + 8, blobOff);
    setDWord(tables, p + 12, blobSize);
    return ((idx & 0xFF) | (marker << 24)) >>> 0;
  };

  faces.forEach((f, fi) => {
    // face header + section dir
    const fh = Buffer.from(FACE_HEADER_HEX, 'hex');
    f.fh = fh;
    for (let k = 0; k < 10; k++) {
      setDWord(fh, 8 + k * 8, f.counts[k]);
      if (k === 1) setDWord(fh, 12 + k * 8, f.secTable[2]);
      else if (k === 6) { /* count stays template 0 */ setDWord(fh, 12 + k * 8, f.secTable[7]); }
      else setDWord(fh, 12 + k * 8, f.secTable[k]);
    }
    // ELEMENTS
    f.elements.forEach((el, i) => {
      const bo = alloc(16);
      wEntry(f, 0, i, 0, bo, 16);
      const blob = Buffer.alloc(16, 0);
      blobParts.push({ off: bo, buf: blob, el });
    });
    // WIDGETS (reserve; content in fillWidget)
    f.widgets7.forEach((w7, i) => {
      const bo = alloc(w7.blobSize);
      const id = wEntry(f, 7, i, 7, bo, w7.blobSize);
      if (w7.hand) w7.widget['_' + w7.hand.replace('HandImage', '') + 'TargetId'] = id;
      else w7.widget._TargetId = id;
      const blob = Buffer.alloc(w7.blobSize, 0);
      blobParts.push({ off: bo, buf: blob, w7 });
    });
    // SINGLES
    f.singles.forEach((s, i) => {
      const id = 0x02000000 | (i & 0xFF);
      s.entryId = id;
      const cpr = singlePayload(s.w, s.h, s.bgra);
      const bo = alloc(12 + cpr.length);
      wEntry(f, 2, i, 2, bo, 12 + cpr.length);
      const blob = Buffer.alloc(12 + cpr.length, 0);
      blob.set([0, 4, 0, 0], 0); // byte0 = rle selector: 0x00 = v10 (matches GetHeader 00040000)
      setWord(blob, 4, s.w); setWord(blob, 6, s.h);
      setDWord(blob, 8, cpr.length);
      cpr.copy(blob, 12);
      blobParts.push({ off: bo, buf: blob });
      s.assign(id);
    });
    // LISTS
    f.lists.forEach((L, i) => {
      const id = 0x03000000 | (i & 0xFF);
      const payloads = L.frames.map(fr => singlePayload(fr.w, fr.h, fr.bgra));
      const total = 12 + 4 * payloads.length + payloads.reduce((a, p) => a + p.length, 0);
      const bo = alloc(total);
      wEntry(f, 3, i, 3, bo, total);
      const blob = Buffer.alloc(total, 0);
      blob.set([0, payloads.length, 4, 0], 0); // byte0 = rle selector: 0x00 = v10
      setWord(blob, 4, L.w); setWord(blob, 6, L.h);
      setDWord(blob, 8, total - 12 - 4 * payloads.length); // payload bytes only (excl. sizes)
      payloads.forEach((p, j) => setDWord(blob, 12 + j * 4, p.length));
      let po = 12 + 4 * payloads.length;
      for (const p of payloads) { p.copy(blob, po); po += p.length; }
      blobParts.push({ off: bo, buf: blob });
      L.users.forEach(u => u(id));
    });
    // ACTIONS (built here: button ImageIds are assigned above)
    f.actions.forEach((a, i) => {
      const w = a.widget;
      const blob = w._action ? actionFromHeads(w._action, w._ImageId, w.Width, w.Height)
        : actionFromTemplate(appNameOf(w.Name), w._ImageId, w.Width, w.Height);
      const bo = alloc(ACTION_BLOB_SIZE);
      w._ActionId = wEntry(f, 9, i, 9, bo, ACTION_BLOB_SIZE);
      blobParts.push({ off: bo, buf: blob });
    });
    // orphan tap zones: verbatim blobs + elements (stock order: after widgets)
    f.rawActions.forEach((r, j) => {
      const blob = Buffer.from(r.blob, 'hex');
      const bo = alloc(blob.length);
      const id = wEntry(f, 9, f.actions.length + j, 9, bo, blob.length);
      blobParts.push({ off: bo, buf: blob });
      const eb = Buffer.alloc(16, 0);
      const ebo = alloc(16);
      wEntry(f, 0, f.elements.length + j, 0, ebo, 16);
      blobParts.push({ off: ebo, buf: eb, el: { widget: { X: r.x, Y: r.y }, face: f, tidOverride: id } });
    });
    for (const bp of blobParts) if (bp.el && bp.el.face === f) fillElement(bp.buf, bp.el);
    for (const bp of blobParts) if (bp.w7 && bp.w7.face === f) fillWidget(bp.buf, bp.w7);
  });

  // assemble
  const parts = [header];
  faces.forEach((f) => parts.push(f.fh));
  parts.push(tables);
  const totalLen = blobCursor;
  const bin = Buffer.alloc(totalLen, 0);
  let pos = 0;
  for (const part of parts) { part.copy(bin, pos); pos += part.length; }
  for (const bp of blobParts) bp.buf.copy(bin, bp.off);
  // PREVIEW (main face only, like official)
  const pv = faces[0].preview;
  checkPreviewSize(deviceType, pv.w, pv.h);
  const cpr = singlePayload(pv.w, pv.h, pv.bgra);
  const pvBlob = Buffer.alloc(12 + cpr.length, 0);
  pvBlob.set([0, 4, 0, 0], 0);
  setWord(pvBlob, 4, pv.w); setWord(pvBlob, 6, pv.h);
  setDWord(pvBlob, 8, cpr.length);
  cpr.copy(pvBlob, 12);
  const grow = Buffer.concat([bin, pvBlob]);
  setDWord(grow, 32, bin.length);
  setDWord(grow, 168 + 4, bin.length);
  return { bin: grow, warnings };
}

// compressed payload shared by singles/lists/preview: [magic][(len<<4)|4][v10(BGRA)]
function singlePayload(w, h, bgra) {
  if (bgra.length !== w * h * 4) throw new Error(`Pixel data ${bgra.length} mismatches ${w}x${h}.`);
  const payload = encodeV10(bgra, 4);
  const head = Buffer.alloc(8, 0);
  MAGIC.copy(head, 0);
  setDWord(head, 4, ((bgra.length << 4) | 4) >>> 0);
  return Buffer.concat([head, payload]);
}

// ---- face preparation: validate + expand model into pack plan ----
function prepareFace(deviceType, slot, faceIndex, warnings) {
  // hidden layers are design-time only: excluded from compile
  const widgets = (slot.widgets || []).filter(w => !w._hidden);
  const images = slot.images || {};
  const getImg = (name) => {
    const im = images[name];
    if (!im || !im.data) throw new Error(`Image not found: ${name}`);
    return { width: im.width, height: im.height, data: Buffer.from(im.data) };
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
    if (w.Shape === 30) { nElem += 1; nSingle += 1; if (isButton(w.Name)) nAction += 1; }
    else if (w.Shape === 27) { const h = handsOf(w).length; nElem += h; nSingle += h; nWidget += h; }
    else if (w.Shape === 31 || w.Shape === 32) {
      nElem += 1; nWidget += 1;
      const key = packFrames(w).map(b => b.name).join('|');
      if (!seenList.has(key)) { seenList.add(key); listOrder.push(key); }
    }
  }
  // orphan tap zones (raw sec9 blobs + their sec0 elements) round-trip verbatim
  const rawActions = (slot.rawActions || []).filter(r => r && r.blob);
  nElem += rawActions.length;
  nAction += rawActions.length;
  const counts = [nElem, 0, nSingle, listOrder.length, 0, 0, 0, nWidget, 0, nAction];
  const f = { counts, secTable: new Array(10).fill(0), elements: [], singles: [], lists: [], widgets7: [], actions: [], widgets, preview: null, rawActions };
  // elements (widget order; clocks expand to hands)
  widgets.forEach((w) => {
    if (w.Shape === 27) {
      for (const k of HANDS) if (w[k]) f.elements.push({ widget: w, hand: k, face: f });
    } else f.elements.push({ widget: w, hand: null, face: f });
  });
  // singles (widget order)
  const pushSingle = (name, assign) => {
    const im = getImg(name);
    f.singles.push({ name, w: im.width, h: im.height, bgra: rgbaToBgra(im.data), assign });
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
        return { name: b.name, w: im.width, h: im.height, bgra: rgbaToBgra(im.data) };
      });
      for (const fr of frames) {
        if (fr.w !== frames[0].w || fr.h !== frames[0].h) throw new Error(`Widget "${w.Name}": list images must share dimensions.`);
      }
      byKey[key] = {
        key, w: frames[0].w, h: frames[0].h, frames,
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
    if (w.Shape === 30) continue;
    if (w.Shape === 27) {
      for (const k of HANDS) if (w[k]) f.widgets7.push({ widget: w, hand: k, blobSize: 32, face: f });
    } else if (w.Shape === 31) {
      const frames = packFrames(w);
      const values = frames.map((b, i) => (b.value == null ? i : b.value));
      // Values array exists only when custom (any value != its index);
      // otherwise a fixed 20-byte blob with [12]=0 (observed in stock).
      const custom = values.some((v, i) => v !== i);
      const L = byKey[frames.map(b => b.name).join('|')];
      f.widgets7.push({ widget: w, hand: null, blobSize: custom ? 16 + 4 * frames.length : 20, values, custom, face: f });
    } else if (w.Shape === 32) {
      f.widgets7.push({ widget: w, hand: null, blobSize: 20, face: f });
    }
  }
  // actions (buttons in widget order; blobs built at pack time)
  for (const w of widgets) {
    if (w.Shape !== 30 || !isButton(w.Name)) continue;
    if (!w._action && !appNameOf(w.Name))
      throw new Error(`Button "${w.Name}": needs an [app] suffix (e.g. ${w.Name}_[alarm]).`);
    f.actions.push({ widget: w });
  }
  // preview
  const pv = slot.preview;
  if (!pv || !pv.data) throw new Error('Slot needs a preview image.');
  f.preview = { w: pv.width, h: pv.height, bgra: rgbaToBgra(pv.data) };
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
  if (!t) throw new Error(`Unknown button app "${app}" (not in action table).`);
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
  setDWord(blob, 48, imageId >>> 0);
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
  const tid = w.Shape === 30 ? (w._ActionId != null ? w._ActionId : w._ImageId) : w._TargetId;
  setDWord(buf, 0, tid >>> 0);
  setWord(buf, 4, X); setWord(buf, 6, Y);
}

function fillWidget(buf, w7) {
  const w = w7.widget;
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
    setWord(buf, 4, 0);
    setWord(buf, 6, 1000); // observed 1000 in all stock digital blobs
    setDWord(buf, 8, w._ImageId >>> 0);
    buf[13] = w.Spacing || 0;
  }
}

module.exports = { compileFaceProject, SUPPORTED, parseDataSrc, parseAlignment, RW4_ACTIONS };
