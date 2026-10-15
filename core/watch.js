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

const ScreenWidth = { 1: 454, 3: 466, 4: 480, 5: 320, 6: 280, 7: 390, 8: 368, 9: 192, 10: 320, 11: 336, 12: 240, 362: 466, 365: 390, 366: 192, 367: 336, 462: 466, 465: 432, 466: 212, 562: 480, 565: 432, 567: 336, 3651: 320, 3652: 410 };
const ScreenHeight = { 1: 454, 3: 466, 4: 480, 5: 360, 6: 456, 7: 450, 8: 456, 9: 490, 10: 360, 11: 480, 12: 280, 362: 466, 365: 450, 366: 490, 367: 480, 462: 466, 465: 514, 466: 520, 562: 480, 565: 514, 567: 480, 3651: 385, 3652: 502 };
// (watchType, w, h) table from XiaomiWatch.Common previewSize
// Official previewSize table (XiaomiWatch.Common, newer DLL) plus the 0.6x
// Watch6 thumbnail seen in the wild (259x308 for a 432x514 face).
const PreviewSizes = [
  [3, 246, 246], [4, 280, 280], [362, 326, 326], [362, 464, 464],
  [462, 326, 326], [462, 464, 464], [562, 480, 480],
  [5, 178, 178], [10, 178, 178], [7, 234, 270], [12, 156, 182],
  [365, 234, 270], [365, 390, 450], [465, 432, 514], [565, 432, 514],
  [565, 259, 308],
  [3651, 180, 216], [3651, 320, 385], [3652, 244, 298], [3652, 410, 502],
  [8, 110, 208], [9, 122, 310],
  [366, 122, 310], [366, 192, 490], [466, 212, 520],
  [6, 220, 358], [11, 230, 328], [11, 336, 480],
  [367, 230, 328], [367, 336, 480], [567, 230, 328], [567, 336, 480],
];
function getScreenWidth(wt) { return ScreenWidth[wt] || 0; }
function getScreenHeight(wt) { return ScreenHeight[wt] || 0; }
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
    if (name.startsWith('1209')) wt = WatchType.MiBand9;
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
module.exports = { WatchType, WatchTypeName, watchDisplayName, getScreenWidth, getScreenHeight, getWatchTypeBySize, getWatchType, PreviewSizes };
