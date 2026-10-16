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

const MASK_SPECS = {
  11: { kind: 'rounded', radius: 92, label: 'Mi Band 8 Pro' },
  362: { kind: 'circle', label: 'Mi Watch S3' },
  365: { kind: 'rounded', radius: 92, label: 'Redmi Watch 4' },
  367: { kind: 'rounded', radius: 92, label: 'Mi Band 9 Pro' },
  462: { kind: 'circle', label: 'Mi Watch S4' },
  465: { kind: 'rounded', radius: 104, label: 'Redmi Watch 5' },
  562: { kind: 'circle', label: 'Mi Watch S5' },
  565: { kind: 'rounded', radius: 104, label: 'Redmi Watch 6' },
};

// SVG geometry for a device mask (white = visible). Used both to generate
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
