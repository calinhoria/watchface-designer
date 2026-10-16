'use strict';
// Watchface format inspector.
//   node tools/inspect.js <file.bin> [...]
// Prints the version, device, per-section table counts and what the designer
// supports, so you can tell at a glance whether a downloaded face is animated,
// uses app widgets, or is a plain static face.
const fs = require('fs');
const { unpack } = require('../core/unpacker');
const { watchDisplayName } = require('../core/watch');

const SECTION_NAMES = [
  'elements', 'reserved1', 'images', 'image-lists', 'ANIMATIONS',
  'APPS', 'reserved6', 'widgets', 'reserved8', 'actions',
];

let problems = 0;
for (const file of process.argv.slice(2)) {
  console.log('='.repeat(70));
  console.log(file);
  try {
    const buf = fs.readFileSync(file);
    const r = unpack(buf);
    const dev = `${watchDisplayName(r.watchType)} (${r.watchType})`;
    console.log(`  size        ${buf.length} bytes`);
    console.log(`  format      v${r.version}  subVersion=${r.subVersion ?? '-'}`);
    console.log(`  device      ${dev}`);
    console.log(`  title       ${JSON.stringify(r.title)}`);
    console.log(`  face id     ${r.faceId || '-'}`);
    console.log(`  preview     ${r.preview ? `${r.preview.width}x${r.preview.height}` : 'none'}`);
    console.log(`  slots       ${r.slots.length}`);
    for (const s of r.slots) {
      const counts = (s.sectionCounts || []).map((c, i) => (c ? `${SECTION_NAMES[i]}=${c}` : null)).filter(Boolean).join(' ');
      const shapes = {};
      for (const w of s.widgets) shapes[w.Shape] = (shapes[w.Shape] || 0) + 1;
      console.log(`    slot ${s.index}: ${s.widgets.length} widgets (${Object.entries(shapes).map(([k, v]) => `shape${k}x${v}`).join(' ') || '-'}), ${s.images.size} images, ${(s.rawActions || []).length} tap zones`);
      console.log(`      sections: ${counts}`);
    }
    const anim = r.animationCount || 0;
    const apps = r.appCount || 0;
    console.log('  --- support ---');
    console.log(`  animations  ${anim ? `${anim} entr${anim === 1 ? 'y' : 'ies'}  ⚠ NOT SUPPORTED (dropped on compile)` : 'none'}`);
    console.log(`  app widgets ${apps ? `${apps}  ⚠ NOT SUPPORTED (dropped on compile)` : 'none'}`);
    if (anim) problems += 1;
    console.log('  verdict     ' + (anim ? 'ANIMATED watchface' : r.version === 2 ? 'supported / round-trips' : 'supported for unpacking only'));
  } catch (e) {
    console.log('  ERROR: ' + (e.message || e));
    problems += 1;
  }
}
console.log('='.repeat(70));
console.log(problems ? `${problems} file(s) need attention` : 'all files are plain static V2 faces');
