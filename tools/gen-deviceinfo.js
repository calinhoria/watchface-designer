'use strict';
// Turns EasyFace's DeviceInfo.db (an XML file, despite the name) into
// data/device-info.json — the authoritative device / widget / data-source /
// animation / event tables used by the official Compiler.exe.
//
//   node tools/gen-deviceinfo.js [path-to-DeviceInfo.db] [out.json]
//
// Defaults to the EasyFace compiler folder in ~/Downloads and writes
// data/device-info.json. The output is committed, so the app never needs the
// EasyFace install itself.
const fs = require('fs');
const path = require('path');

const DEFAULT_SRC = path.join(process.env.HOME || '', 'Downloads', 'EasyFace_Gen2_CompilerV423', 'DeviceInfo.db');
const SRC = process.argv[2] || DEFAULT_SRC;
const OUT = process.argv[3] || path.join(__dirname, '..', 'data', 'device-info.json');

// EasyFace ships some entries commented out (e.g. 182B/202B Vitality): they are
// not selectable, so drop comments before parsing.
const xml = fs.readFileSync(SRC, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

function attrs(s) {
  const o = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = m[2];
  return o;
}
// every self-closing or paired child element name inside `inner`
function children(inner) {
  const out = [];
  const re = /<(\w+)\s+([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(inner))) out.push({ tag: m[1], ...attrs(m[2]) });
  return out;
}
function section(inner, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = re.exec(inner);
  return m ? m[1] : '';
}
function deviceBlocks() {
  const out = [];
  const re = /<DeviceInfo\b([^>]*)>([\s\S]*?)<\/DeviceInfo>/g;
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: attrs(m[1]), inner: m[2] });
  return out;
}

const devices = deviceBlocks().map((b) => {
  const a = b.attrs;
  const kids = (tag) => children(section(b.inner, tag));
  return {
    type: parseInt(a.Type, 10),
    name: a.Name,
    screen: [parseInt(a.Width, 10), parseInt(a.Height, 10)],
    radius: a.Radius ? parseInt(a.Radius, 10) : null,
    pixelFormat: parseInt(a.PixelFormat, 10),
    shape: a.ScreenShape || null,
    supportedFaces: a.SupportedFaceTypeList || null,
    sources: kids('SourceDataList').map((s) => ({
      id: s.ID,
      name: s.Name,
      // a source may require a newer face-programma version than its neighbours
      faceVersion: parseInt(s.SupportedFaceProgramma_Version || s.FaceProgramma_Version || '0', 10),
      tip: s.Tip || undefined,
    })),
    widgets: kids('WidgetList').map((w) => ({
      tag: w.tag,
      shape: parseInt(w.Shape, 10),
      faceVersion: parseInt(w.FaceProgramma_Version || '0', 10),
      newFileTypeIds: w.UsingNewFileTypeID_En === '1',
      excludeSources: (w.ExcludeSourceDataItems || '').split(',').filter(Boolean).map(Number),
    })),
    animations: kids('AnimationList').map((x) => ({ tag: x.tag, type: parseInt(x.Type, 10), faceVersion: parseInt(x.FaceProgramma_Version || '0', 10) })),
    events: kids('EventList').map((x) => ({ tag: x.tag, type: parseInt(x.Type, 10), faceVersion: parseInt(x.FaceProgramma_Version || '0', 10) })),
  };
});

// Widget / animation / event tables are identical for every device: keep one copy.
const shared = devices.length
  ? { widgets: devices[0].widgets, animations: devices[0].animations, events: devices[0].events }
  : { widgets: [], animations: [], events: [] };

const out = {
  source: 'EasyFace Compiler.exe DeviceInfo.db',
  generatedFrom: path.basename(SRC),
  devices: devices.map((d) => ({ ...d, widgets: undefined, animations: undefined, events: undefined })),
  widgets: shared.widgets,
  animations: shared.animations,
  events: shared.events,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
const packed = (d) => d.sources.some((s) => !/^\d{1,3}$/.test(s.id));
console.log(`wrote ${OUT}`);
console.log(`${devices.length} devices, ${shared.widgets.length} widget shapes, ${shared.animations.length} animations, ${shared.events.length} events`);
for (const d of out.devices) {
  console.log(`  ${String(d.type).padStart(5)} ${d.name.padEnd(24)} ${d.screen[0]}x${d.screen[1]} r=${d.radius} src=${d.sources.length} ${packed(d) ? 'packed' : 'plain '}`);
}
