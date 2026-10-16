'use strict';
// Device display masks.
//
// These are generated from each device's screen dimensions plus a corner-radius
// profile (round watches = full circle, the bands/Watch 4-6 = rounded rectangle).
// They are NOT vendor artwork: they approximate the visible display outline so
// the preview is clipped like the real watch. If you drop a real asset at
// assets/masks/<type>.svg it is used instead of the generated geometry, so the
// exact outline can be replaced later without touching code.
//
// radius is expressed in device pixels at the native screen size and scales
// with the preview.

// Radii come from EasyFace's DeviceInfo.db (data/device-info.json) — round
// screens are full circles, everything else uses the DB's Radius attribute.
// The label is only used in generated SVG comments / the device list.
const { DeviceCatalog, deviceInfo } = require('./watch');
const MASK_SPECS = (() => {
  const info = {};
  for (const d of deviceInfo().devices) info[d.type] = d;
  const specs = {};
  for (const dev of DeviceCatalog) {
    const di = info[dev.type];
    if (!di) {
      // not in EasyFace's list (Mi Watch S5): keep the manual shape
      specs[dev.type] = dev.shape === 'circle' ? { kind: 'circle', label: dev.name } : { kind: 'rounded', radius: 60, label: dev.name };
      continue;
    }
    specs[dev.type] = /rounded/i.test(di.shape || '')
      ? { kind: 'rounded', radius: di.radius || 60, label: dev.name }
      : { kind: 'circle', label: dev.name };
  }
  return specs;
})();// SVG geometry for a device mask (white = visible). Used both to generate
// assets/masks/*.svg and as a runtime fallback.
function maskSvg(type, w, h) {
  const spec = MASK_SPECS[type];
  if (!spec || !w || !h) return null;
  const shape = spec.kind === 'circle'
    ? `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}"/>`
    : `<rect x="0" y="0" width="${w}" height="${h}" rx="${spec.radius}" ry="${spec.radius}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${shape}</svg>`;
}

// Corner radius in device px for the bezel/frame (circle -> half the short side)
function maskRadiusPx(type, w, h) {
  const spec = MASK_SPECS[type];
  if (!spec || !w || !h) return 0;
  return spec.kind === 'circle' ? Math.min(w, h) / 2 : Math.min(spec.radius, Math.min(w, h) / 2);
}

function hasMask(type, w, h) {
  return Boolean(MASK_SPECS[type] && w && h);
}

module.exports = { MASK_SPECS, maskSvg, maskRadiusPx, hasMask };
