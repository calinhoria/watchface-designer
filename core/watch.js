'use strict';
// Watch types, screen sizes, preview sizes, detection. Port of WatchScreen + WatchDetector.
const { getDWord, getWord, getByte, getAsciiString } = require('./binutils');

const WatchType = {
  Undefined: 0, Gen1: 1, Gen2: 3, Gen3: 4,
  RedmiWatch2: 5, MiBand7Pro: 6, RedmiWatch3: 7, RedmiBandPro: 8,
  MiBand8: 9, RedmiWatch2Lite: 10, MiBand8Pro: 11, RedmiWatch3Active: 12,
  MiWatchS3: 362, RedmiWatch4: 365, MiBand9: 366,
  MiBand9Pro: 367, MiWatchS4: 462, RedmiWatch5: 465, MiBand10: 466,
  MiWatchS5: 562, RedmiWatch6: 565, MiBand10Pro: 567,
  RedmiWatch5Active: 3651, RedmiWatch5Lite: 3652,
};
const WatchTypeName = Object.fromEntries(Object.entries(WatchType).map(([k, v]) => [v, k]));
// Human-friendly display: RedmiWatch6 -> "Redmi Watch 6", MiBand9Pro -> "Mi Band 9 Pro"
function watchDisplayName(type) {
  const raw = WatchTypeName[type];
  if (!raw) return `Unknown(${type})`;
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2');
}

const ScreenWidth = { 0: 454, 1: 454, 2: 368, 3: 466, 4: 480, 5: 320, 6: 280, 7: 390, 8: 368, 9: 192, 10: 320, 11: 336, 12: 240, 362: 466, 365: 390, 366: 192, 367: 336, 462: 466, 465: 432, 466: 212, 562: 480, 565: 432, 567: 336, 3651: 320, 3652: 410 };
const ScreenHeight = { 0: 454, 1: 454, 2: 448, 3: 466, 4: 480, 5: 360, 6: 456, 7: 450, 8: 456, 9: 490, 10: 360, 11: 480, 12: 280, 362: 466, 365: 450, 366: 490, 367: 480, 462: 466, 465: 514, 466: 520, 562: 480, 565: 514, 567: 480, 3651: 385, 3652: 502 };
// (watchType, w, h) table from XiaomiWatch.Common previewSize
// Official previewSize table (XiaomiWatch.Common, newer DLL) plus the 0.6x
// Watch6 thumbnail seen in the wild (259x308 for a 432x514 face).
const PreviewSizes = [
  // Official XiaomiWatch.Common previewSize table (a face may also ship a
  // full-screen preview, which those entries cover) plus the EasyFace wiki
  // corrections: Redmi Watch 2 / 2 Lite preview is 178x200 (not 178x178) and
  // Gen1 ships 234x234. Order matters: the first match wins, exactly like the
  // official WatchDetector.
  [1, 234, 234],
  [3, 246, 246], [4, 280, 280],
  [362, 326, 326], [362, 464, 464],
  [462, 326, 326], [462, 464, 464], [562, 480, 480],
  [5, 178, 200], [5, 178, 178], [10, 178, 200], [10, 178, 178],
  [7, 234, 270], [12, 156, 182],
  [365, 234, 270], [365, 390, 450], [465, 432, 514], [565, 432, 514],
  [565, 259, 308],
  [3651, 180, 216], [3651, 320, 385], [3652, 244, 298], [3652, 410, 502],
  [2, 184, 224],
  [8, 110, 208], [9, 122, 310],
  [366, 122, 310], [366, 192, 490], [466, 212, 520],
  [6, 220, 358], [11, 230, 328], [11, 336, 480],
  [367, 230, 328], [367, 336, 480], [567, 230, 328], [567, 336, 480],
];
// Full device catalog: name, screen, preview size, display shape and whether
// our compiler can write that family. Sources: EasyFace wiki resolution table,
// the Mi Fitness device list and the official XiaomiWatch.Common enums.
const DeviceCatalog = [
  { type: 0, name: 'Mi Color', screen: [454, 454], preview: [234, 234], shape: 'circle', compilable: false },
  { type: 1, name: 'Xiaomi Watch Color', screen: [454, 454], preview: [234, 234], shape: 'circle', compilable: false },
  { type: 2, name: '70mai Saphir', screen: [368, 448], preview: [184, 224], shape: 'rounded', compilable: false },
  { type: 3, name: 'Xiaomi Watch Color 2 / S1', screen: [466, 466], preview: [246, 246], shape: 'circle', compilable: false },
  { type: 4, name: 'Xiaomi Watch S1 Pro', screen: [480, 480], preview: [280, 280], shape: 'circle', compilable: false },
  { type: 5, name: 'Redmi Watch 2', screen: [320, 360], preview: [178, 200], shape: 'rounded', compilable: false },
  { type: 6, name: 'Mi Band 7 Pro', screen: [280, 456], preview: [220, 358], shape: 'rounded', compilable: false },
  { type: 7, name: 'Redmi Watch 3', screen: [390, 450], preview: [234, 270], shape: 'rounded', compilable: false },
  // EasyFace's DeviceInfo.db puts the Redmi Band Pro at 194x368 (not 368x456)
  { type: 8, name: 'Redmi Band Pro', screen: [194, 368], preview: [110, 208], shape: 'rounded', compilable: false },
  { type: 9, name: 'Mi Band 8', screen: [192, 490], preview: [122, 310], shape: 'rounded', compilable: false },
  { type: 10, name: 'Redmi Watch 2 Lite', screen: [320, 360], preview: [178, 200], shape: 'rounded', compilable: false },
  { type: 11, name: 'Mi Band 8 Pro', screen: [336, 480], preview: [230, 328], shape: 'rounded', compilable: true },
  { type: 12, name: 'Redmi Watch 3 Active', screen: [240, 280], preview: [156, 182], shape: 'rounded', compilable: false },
  { type: 362, name: 'Mi Watch S3', screen: [466, 466], preview: [326, 326], shape: 'circle', compilable: true },
  { type: 365, name: 'Redmi Watch 4', screen: [390, 450], preview: [234, 270], shape: 'rounded', compilable: true },
  { type: 366, name: 'Mi Band 9', screen: [192, 490], preview: [122, 310], shape: 'rounded', compilable: false },
  { type: 367, name: 'Mi Band 9 Pro', screen: [336, 480], preview: [230, 328], shape: 'rounded', compilable: true },
  { type: 462, name: 'Mi Watch S4', screen: [466, 466], preview: [326, 326], shape: 'circle', compilable: true },
  { type: 465, name: 'Redmi Watch 5', screen: [432, 514], preview: [432, 514], shape: 'rounded', compilable: true },
  { type: 466, name: 'Mi Band 10', screen: [212, 520], preview: [212, 520], shape: 'rounded', compilable: false },
  { type: 562, name: 'Mi Watch S5', screen: [480, 480], preview: [480, 480], shape: 'circle', compilable: true },
  { type: 565, name: 'Redmi Watch 6', screen: [432, 514], preview: [259, 308], shape: 'rounded', compilable: true },
  { type: 567, name: 'Mi Band 10 Pro', screen: [336, 480], preview: [230, 328], shape: 'rounded', compilable: false },
  { type: 3651, name: 'Redmi Watch 5 Active', screen: [320, 385], preview: [180, 216], shape: 'rounded', compilable: false },
  { type: 3652, name: 'Redmi Watch 5 Lite', screen: [410, 502], preview: [244, 298], shape: 'rounded', compilable: false },
];
function deviceByType(t) { return DeviceCatalog.find((d) => d.type === t) || null; }
function devicePreview(t) {
  const d = deviceByType(t);
  return d ? { w: d.preview[0], h: d.preview[1] } : null;
}

function getScreenWidth(wt) { return ScreenWidth[wt] || 0; }
function getScreenHeight(wt) { return ScreenHeight[wt] || 0; }

// ---------- authoritative tables from EasyFace's DeviceInfo.db ----------
// data/device-info.json is generated by tools/gen-deviceinfo.js from the file
// that ships with Compiler.exe: per-device data sources (the ids differ between
// the Gen1 "plain" scheme and the packed one), widget shapes, animation and
// event types.
let _deviceInfo = null;
function deviceInfo() {
  if (!_deviceInfo) {
    try { _deviceInfo = require('../data/device-info.json'); } catch (e) { _deviceInfo = { devices: [], widgets: [], animations: [], events: [] }; }
  }
  return _deviceInfo;
}
function deviceInfoFor(type) { return deviceInfo().devices.find((d) => d.type === type) || null; }
function deviceSources(type) { const d = deviceInfoFor(type); return d ? d.sources : []; }
// the id the given device uses for a data source we know by another device's id
// (returns null when the device has no such source)
function deviceSourceName(type, id) {
  const s = deviceSources(type).find((x) => x.id === id);
  return s ? s.name : null;
}
function getWatchTypeBySize(w, h) {
  for (const [wt, pw, ph] of PreviewSizes) if (pw === w && ph === h) return wt;
  return 0;
}
function getWatchType(data, version) {
  data = Buffer.from(data);
  let name = '';
  if (version === 1) return { watchType: WatchType.Gen1, imageW: 0, imageH: 0, name };
  if (version === 2) {
    const off = getDWord(data, 32);
    const w = getWord(data, off + 4);
    const h = getWord(data, off + 6);
    name = getAsciiString(data, 40);
    let wt = getWatchTypeBySize(w, h);
    if (wt === WatchType.RedmiWatch3 && name.startsWith('365')) wt = WatchType.RedmiWatch4;
    else if (wt === WatchType.MiBand8 && name.startsWith('366')) wt = WatchType.MiBand9;
    // NOTE: no prefix rule for '1209' — those are global store face IDs, not
    // device codes (a 432x514 Redmi Watch 5 face was once misdetected as
    // Mi Band 9 because its id starts with 1209). m0tral/community ids ARE
    // device-coded (e.g. 465700750) and already resolve via preview size.
    return { watchType: wt, imageW: w, imageH: h, name };
  }
  if (version === 3) {
    const off = getDWord(data, 89);
    if (getByte(data, off) !== 1) throw new Error('Watchface has wrong preview data, version: 3');
    const w = getWord(data, off + 5);
    const h = getWord(data, off + 7);
    const wt = getWatchTypeBySize(w, h);
    return { watchType: wt, imageW: w, imageH: h, name };
  }
  return { watchType: 0, imageW: 0, imageH: 0, name };
}
module.exports = { WatchType, WatchTypeName, watchDisplayName, getScreenWidth, getScreenHeight, getWatchTypeBySize, getWatchType, PreviewSizes, DeviceCatalog, deviceByType, devicePreview, deviceInfo, deviceInfoFor, deviceSources, deviceSourceName };
