'use strict';
// Generates assets/masks/<deviceType>.svg from the screen dimensions in
// core/watch.js and the radius profile in core/masks.js.
//   node tools/gen-masks.js
const fs = require('fs');
const path = require('path');
const { MASK_SPECS, maskSvg } = require('../core/masks');
const { getScreenWidth, getScreenHeight, watchDisplayName } = require('../core/watch');

const outDir = path.join(__dirname, '..', 'assets', 'masks');
fs.mkdirSync(outDir, { recursive: true });

let n = 0;
for (const type of Object.keys(MASK_SPECS).map(Number).sort((a, b) => a - b)) {
  const w = getScreenWidth(type), h = getScreenHeight(type);
  if (!w || !h) { console.warn(`skip ${type}: unknown screen size`); continue; }
  const svg = maskSvg(type, w, h);
  const note = `<!-- ${watchDisplayName(type)} ${w}x${h} (${MASK_SPECS[type].kind}) — generated, replace with real artwork if available -->`;
  fs.writeFileSync(path.join(outDir, `${type}.svg`), note + '\n' + svg + '\n');
  n += 1;
  console.log(`wrote assets/masks/${type}.svg  ${watchDisplayName(type)} ${w}x${h}`);
}
// metadata mirror so the renderer has one source of truth for frame radii
const meta = {};
for (const type of Object.keys(MASK_SPECS).map(Number)) {
  const w = getScreenWidth(type), h = getScreenHeight(type);
  if (!w || !h) continue;
  const { maskRadiusPx } = require('../core/masks');
  meta[type] = { kind: MASK_SPECS[type].kind, w, h, radius: maskRadiusPx(type, w, h) };
}
fs.writeFileSync(path.join(outDir, 'masks.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`${n} mask(s) generated + masks.json`);
