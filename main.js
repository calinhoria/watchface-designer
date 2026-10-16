'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const { unpack } = require('./core/unpacker');
const { serializeFaceProject } = require('./core/fprj');
const { getScreenWidth, getScreenHeight, watchDisplayName, DeviceCatalog, deviceInfo } = require('./core/watch');

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    title: 'Watchface Designer',
  });
  win.loadFile('index.html');
}
app.whenReady().then(() => { pruneRecents(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function rgbaToPngBuffer(width, height, rgba) {
  const png = new PNG({ width, height });
  Buffer.from(rgba).copy(png.data);
  return PNG.sync.write(png);
}

// Unpack .bin -> {meta, slots, pngDataUrls} (images sent as data URLs, capped)
async function handleOpenBin(filePath) {
  const buf = fs.readFileSync(filePath);
  const res = unpack(buf);
  const base = path.basename(filePath, path.extname(filePath));
  const slots = res.slots.map((s) => ({
    index: s.index,
    role: s.aod ? 'aod' : 'face',
    aod: Boolean(s.aod),
    aodFlag: s.aodFlag >>> 0,
    previewOffset: s.previewOffset >>> 0,
    tail: s.tail || null,
    orphanSec9: s.orphanSec9 || [],
    orphanWidgets: s.orphanWidgets || [],
    orphanImages: s.orphanImages || [],
    orphanSingles: s.orphanSingles || [],
    orphanLists: s.orphanLists || [],
    widgets: s.widgets,
    rawActions: s.rawActions || [],
    images: [...s.images.entries()]
      .filter(([, im]) => im && im.width > 0 && im.height > 0 && im.rgba && im.rgba.length >= im.width * im.height * 4)
      .map(([name, im]) => ({
        name, width: im.width, height: im.height,
        url: 'data:image/png;base64,' + rgbaToPngBuffer(im.width, im.height, im.rgba).toString('base64'),
        origBlob: im.origBlob || null, rgbaHash: im.rgbaHash || null, listEnc: im.listEnc || null,
      })),
  }));
  let previewUrl = null;
  if (res.preview) previewUrl = 'data:image/png;base64,' + rgbaToPngBuffer(res.preview.width, res.preview.height, res.preview.rgba).toString('base64');
  let screenW = getScreenWidth(res.watchType), screenH = getScreenHeight(res.watchType);
  if (!screenW || !screenH) {
    // Unknown watch: fall back to widget extents so the canvas is still usable
    for (const s of slots) for (const w of s.widgets) {
      screenW = Math.max(screenW, (w.X || 0) + (w.Width || 0));
      screenH = Math.max(screenH, (w.Y || 0) + (w.Height || 0));
    }
  }
  return {
    filePath, base,
    animationCount: res.animationCount || 0,
    appCount: res.appCount || 0,
    subVersion: res.subVersion || 0,
    version: res.version, watchType: res.watchType,
    watchName: watchDisplayName(res.watchType),
    screenW, screenH,
    title: res.title, slots, previewUrl, faceId: res.faceId || '',
  };
}

ipcMain.handle('open-bin-dialog', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Watchface (.bin)', extensions: ['bin'] }] });
  if (r.canceled || !r.filePaths.length) return null;
  return handleOpenBin(r.filePaths[0]);
});
ipcMain.handle('open-bin-path', async (_e, p) => handleOpenBin(p));

// ---------- recent projects (last 5, persisted in userData) ----------
const RECENT_MAX = 5;
function recentsFile() { return path.join(app.getPath('userData'), 'recent-projects.json'); }
function loadRecents() {
  try { const l = JSON.parse(fs.readFileSync(recentsFile(), 'utf8')); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
function writeRecents(list) { try { fs.writeFileSync(recentsFile(), JSON.stringify(list, null, 2)); } catch (e) { } }
function pushRecent(dir, name, deviceType) {
  const list = loadRecents().filter((r) => r.path !== dir);
  list.unshift({ path: dir, name: name || path.basename(dir), device: deviceType || 0, at: Date.now() });
  writeRecents(list.slice(0, RECENT_MAX));
}
function listRecents() {
  return loadRecents().slice(0, RECENT_MAX).map((r) => ({ ...r, exists: fs.existsSync(r.path) }));
}
// Startup cleanup: drop entries whose folder is gone (a missing drive or folder
// removed outside the app shouldn't linger in the list forever).
function pruneRecents() {
  const list = loadRecents();
  const kept = list.filter((r) => r && r.path && fs.existsSync(r.path));
  if (kept.length !== list.length) writeRecents(kept.slice(0, RECENT_MAX));
  return list.length - kept.length;
}
ipcMain.handle('recent-list', async () => listRecents());
ipcMain.handle('recent-clear', async () => { writeRecents([]); return []; });

// Open a saved project folder: <dir>/<base>.fprj + images/ (+ AOD/ AOD2/…)
function openProjectDir(root) {
  const { parseFprj } = require('./core/fprj');
  // accept either the project dir itself or a parent containing it
  const candidates = [root, ...fs.readdirSync(root)
    .map((n) => path.join(root, n))
    .filter((p) => { try { return fs.statSync(p).isDirectory() && fs.readdirSync(p).some((f) => f.endsWith('.fprj')); } catch (e) { return false; } })];
  const projDir = candidates.find((p) => { try { return fs.readdirSync(p).some((f) => f.endsWith('.fprj')); } catch (e) { return false; } });
  if (!projDir) return { error: 'No .fprj file found in that folder.' };
  const fprjName = fs.readdirSync(projDir).find((f) => f.endsWith('.fprj'));
  const base = path.basename(fprjName, '.fprj');
  const xface = parseFprj(fs.readFileSync(path.join(projDir, fprjName), 'utf8'));

  const readSlot = (dir, index, role) => {
    const imgDir = path.join(dir, 'images');
    const images = [];
    if (fs.existsSync(imgDir)) {
      for (const f of fs.readdirSync(imgDir)) {
        if (!f.toLowerCase().endsWith('.png')) continue;
        const png = PNG.sync.read(fs.readFileSync(path.join(imgDir, f)));
        images.push({ name: f, width: png.width, height: png.height, url: 'data:image/png;base64,' + fs.readFileSync(path.join(imgDir, f)).toString('base64') });
      }
    }
    let previewUrl = null;
    const pv = path.join(dir, 'preview.png');
    if (fs.existsSync(pv)) previewUrl = 'data:image/png;base64,' + fs.readFileSync(pv).toString('base64');
    return { index, role, aod: role === 'aod', aodFlag: role === 'aod' ? 0x80000000 : 0, orphanSec9: [], widgets: index === 0 ? xface.Screen.Widgets : [], rawActions: [], images, previewUrl };
  };

  // designer-only metadata: font settings + hidden layers (designer.json)
  let designer = null;
  const dj = path.join(projDir, 'designer.json');
  try { if (fs.existsSync(dj)) designer = JSON.parse(fs.readFileSync(dj, 'utf8')); } catch (e) { designer = null; }
  const slotMeta = (i) => (designer && Array.isArray(designer.slots) ? designer.slots.find((s) => s.index === i) : null);
  const restoreMeta = (slot) => {
    const meta = slotMeta(slot.index);
    if (!meta) return slot;
    if (meta.role) slot.role = meta.role;
    if (meta.aod != null) slot.aod = !!meta.aod;
    if (meta.aodFlag != null) slot.aodFlag = meta.aodFlag >>> 0;
    if (Array.isArray(meta.orphanSec9)) slot.orphanSec9 = meta.orphanSec9.slice();
    if (meta.previewOffset != null) slot.previewOffset = meta.previewOffset >>> 0;
    if (typeof meta.tail === 'string') slot.tail = meta.tail;
    const hidden = new Set(meta.hidden || []);
    const taps = meta.taps || {};
    const presets = meta.presets || {};
    const groups = meta.groups || {};
    const locked = new Set(meta.locked || []);
    const unlocked = new Set(meta.unlocked || []);
    const imgProps = meta.imgProps || {};
    for (const w of slot.widgets) {
      if (hidden.has(w.Name)) w._hidden = true;
      if (taps[w.Name]) w._tap = taps[w.Name];
      if (presets[w.Name]) w._preset = presets[w.Name];
      if (groups[w.Name]) w._group = groups[w.Name];
      if (locked.has(w.Name)) w._locked = true;
      if (unlocked.has(w.Name)) { w._unlockKeep = true; w._locked = false; }
      const ip = imgProps[w.Name];
      if (ip) {
        if (ip.fit) w._fit = ip.fit;
        if (ip.fill) w._fill = ip.fill;
        if (ip.background) w._background = true;
      }
      const f = meta.fonts && meta.fonts[w.Name];
      if (f) {
        w._font = {
          family: f.family, size: f.size || undefined, color: f.color || undefined,
          bold: !!f.bold, italic: !!f.italic, kind: f.kind || 'bundled',
          _base: f.base || undefined,
          glyphs: Array.isArray(f.glyphs) ? f.glyphs : undefined,
          files: Array.isArray(f.files) ? f.files.slice() : [],
          fill: f.fill || undefined,
          gradFrom: f.gradFrom || undefined,
          gradTo: f.gradTo || undefined,
          gradAngle: f.gradAngle == null ? undefined : f.gradAngle,
          cssFill: f.cssFill || undefined,
          outlineColor: f.outlineColor || undefined,
          outlineWidth: f.outlineWidth == null ? undefined : f.outlineWidth,
        };
      }
    }
    return slot;
  };
  // custom fonts live in <project>/fonts and are re-registered in the renderer
  const usedCustom = [];
  if (designer) {
    for (const s of designer.slots || []) {
      for (const f of Object.values(s.fonts || {})) {
        if (f.kind === 'custom' && f.fontFile && !usedCustom.some((u) => u.family === f.family)) {
          const p = path.join(projDir, 'fonts', f.fontFile);
          if (fs.existsSync(p)) usedCustom.push({ family: f.family, url: 'file://' + encodeURI(p), fileName: f.fontFile });
        }
      }
    }
  }

  const slots = [];
  let i = 0;
  for (const name of fs.readdirSync(projDir)) {
    if (!fs.statSync(path.join(projDir, name)).isDirectory()) continue;
    if (name === 'images') continue;
    if (/^AOD\d*$/i.test(name)) {
      const n = name === 'AOD' ? 1 : parseInt(name.slice(3), 10) || 1;
      slots[n] = readSlot(path.join(projDir, name), n, 'aod');
      i = Math.max(i, n);
    }
  }
  slots[0] = readSlot(projDir, 0, 'face');
  for (let k = 0; k <= i; k++) if (!slots[k]) slots[k] = { index: k, role: 'aod', widgets: [], rawActions: [], images: [], previewUrl: null };
  const clean = slots.filter(Boolean).map(restoreMeta);

  const type = xface.DeviceType;
  return {
    filePath: null, base, savePath: projDir,
    version: 2, watchType: type, watchName: watchDisplayName(type),
    screenW: getScreenWidth(type) || 466, screenH: getScreenHeight(type) || 466,
    title: xface.Screen.Title || base, faceId: '',
    previewUrl: clean[0].previewUrl,
    font: (designer && designer.font) || null,
    groupSeq: (designer && designer.groupSeq) || 1,
    groupNames: (designer && designer.groupNames) || null,
    testData: (designer && designer.testData) || null,
    useCurrentTime: !!(designer && designer.useCurrentTime),
    subVersion: (designer && designer.subVersion != null) ? designer.subVersion : null,
    customFonts: usedCustom,
    slots: clean,
  };
}
ipcMain.handle('open-project', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const res = openProjectDir(r.filePaths[0]);
  if (res && !res.error) pushRecent(res.savePath, res.title || res.base, res.watchType);
  return res;
});
ipcMain.handle('open-project-path', async (_e, dir) => {
  if (!dir || !fs.existsSync(dir)) return { error: 'Project folder not found.' };
  const res = openProjectDir(dir);
  if (res && !res.error) pushRecent(res.savePath, res.title || res.base, res.watchType);
  return res;
});

// ---------- imported (custom) fonts: app-wide, persistent ----------
function customFontsDir() { return path.join(app.getPath('userData'), 'fonts'); }
ipcMain.handle('pick-font', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import font', properties: ['openFile'],
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  try { return { name: path.basename(p), dataBase64: fs.readFileSync(p).toString('base64') }; } catch (e) { return null; }
});
ipcMain.handle('fonts-save', async (_e, { family, fileName, dataBase64 }) => {
  try {
    const dir = customFontsDir();
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(fileName || '') || '.ttf';
    const safe = `${String(family).replace(/^Custom-/, '').replace(/[^\w\-]+/g, '_')}${ext}`;
    fs.writeFileSync(path.join(dir, safe), Buffer.from(dataBase64, 'base64'));
    return safe;
  } catch (e) { return null; }
});
ipcMain.handle('fonts-list', async () => {
  try {
    const dir = customFontsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /\.(ttf|otf|woff2?|TTF|OTF)$/.test(f)).map((f) => ({
      family: (() => { const b = path.basename(f, path.extname(f)); return b.startsWith('Custom-') ? b : `Custom-${b}`; })(),
      fileName: f,
      dataBase64: fs.readFileSync(path.join(dir, f)).toString('base64'),
    }));
  } catch (e) { return []; }
});

// Device catalog (single source of truth: core/watch.js)
ipcMain.handle('device-catalog', async () => DeviceCatalog);
// authorative EasyFace tables (data/device-info.json, see tools/gen-deviceinfo.js)
ipcMain.handle('device-info', async () => deviceInfo());

// Compile current project state to .bin (V2, 8Pro-family watches)
ipcMain.handle('compile-bin', async (_e, payload) => {
  const { compileFaceProject } = require('./core/packer');
  const { unpack } = require('./core/unpacker');
  const slots = payload.slots.map((s) => ({
    widgets: s.widgets,
    rawActions: s.rawActions || [],
    aod: Boolean(s.aod), aodFlag: s.aodFlag >>> 0,
    previewOffset: s.previewOffset >>> 0, tail: s.tail || null,
    orphanSec9: s.orphanSec9 || [],
    orphanWidgets: s.orphanWidgets || [],
    orphanImages: s.orphanImages || [],
    orphanSingles: s.orphanSingles || [],
    orphanLists: s.orphanLists || [],
    images: Object.fromEntries(s.images.map((im) => {
      const png = PNG.sync.read(Buffer.from(im.dataBase64, 'base64'));
      return [im.name, { width: png.width, height: png.height, data: Buffer.from(png.data), origBlob: im.origBlob || null, rgbaHash: im.rgbaHash || null, listEnc: im.listEnc || null }];
    })),
    preview: s.previewBase64 ? (() => {
      const png = PNG.sync.read(Buffer.from(s.previewBase64, 'base64'));
      return { width: png.width, height: png.height, data: Buffer.from(png.data) };
    })() : null,
  }));
  if (payload.animationCount || payload.appCount) {
    const ok = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Cancel', 'Compile anyway'], defaultId: 0, cancelId: 0,
      message: 'This face contains features the compiler cannot write yet',
      detail: `${payload.animationCount || 0} animation entr${(payload.animationCount || 0) === 1 ? 'y' : 'ies'} and ${payload.appCount || 0} app widget(s) will be DROPPED, so the compiled .bin will not match the original. Inspect it with: node tools/inspect.js <file>`,
    });
    if (ok !== 1) return { ok: false, error: 'cancelled (unsupported features)' };
  }
  let compiled;
  try {
    compiled = compileFaceProject({
      deviceType: payload.deviceType, title: payload.title,
      faceId: payload.faceId, subVersion: payload.subVersion, slots,
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const r = await dialog.showSaveDialog(win, {
    defaultPath: `${payload.defaultBase || 'watchface'}_compiled.bin`,
    filters: [{ name: 'Watchface', extensions: ['bin'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
  fs.writeFileSync(r.filePath, compiled.bin);
  // verify: unpack the output and compare structure
  const issues = [];
  try {
    const re = unpack(compiled.bin);
    if (re.version !== 2) issues.push('re-unpack version != 2');
    if (re.watchType !== payload.deviceType) issues.push(`watch mismatch: ${re.watchType} != ${payload.deviceType}`);
    if ((re.title || '') !== (payload.title || '')) issues.push(`title mismatch: ${JSON.stringify(re.title)}`);
    if (re.slots.length !== slots.length) issues.push(`slot count ${re.slots.length} != ${slots.length}`);
    re.slots.forEach((s, i) => {
      const want = slots[i].widgets.filter((wg) => !wg._hidden).length;
      if (s.widgets.length !== want) issues.push(`slot ${i}: ${s.widgets.length} widgets != ${want}`);
      const wantTaps = (slots[i].rawActions || []).length;
      if ((s.rawActions || []).length !== wantTaps) issues.push(`slot ${i}: ${(s.rawActions || []).length} tap zones != ${wantTaps}`);
      if (slots.length === 1) {
        // orphan images are intentionally dropped (see warnings)
        const dropped = (compiled.warnings || []).filter((m) => /^Dropped unreferenced image /.test(m)).length;
        const wantImgs = Object.keys(slots[i].images).length - dropped;
        if (s.images.size !== wantImgs) issues.push(`slot ${i}: ${s.images.size} images != ${wantImgs}`);
      }
    });
  } catch (err) {
    issues.push('re-unpack failed: ' + String(err.message || err));
  }
  return { ok: true, path: r.filePath, bytes: compiled.bin.length, warnings: compiled.warnings, issues };
});

// Save project: <dir>/{images/*.png, base.fprj, preview.png} per slot
// (slot 0 at the root, extra slots under AOD/ AOD2/ ...). Reuses
// payload.savePath when the project was saved before, else asks where.
ipcMain.handle('export-project', async (_e, payload) => {
  const { defaultBase, title, deviceType, slots, savePath, customFonts } = payload;
  let outDir = savePath || null;
  if (!outDir) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to save the project folder',
      buttonLabel: 'Save here', properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    outDir = path.join(r.filePaths[0], defaultBase);
  }
  // custom (user-imported) fonts travel with the project so digit
  // regeneration still works after reopening
  const fontsDir = path.join(outDir, 'fonts');
  const fontRefs = new Map();
  if (customFonts && customFonts.length) {
    fs.mkdirSync(fontsDir, { recursive: true });
    for (const f of customFonts) {
      const safe = `${String(f.family).replace(/[^\w\-]+/g, '_')}${(path.extname(f.fileName || '') || '.ttf')}`;
      fs.writeFileSync(path.join(fontsDir, safe), Buffer.from(f.dataBase64, 'base64'));
      fontRefs.set(f.family, safe);
    }
    for (const old of fs.readdirSync(fontsDir)) {
      if (![...fontRefs.values()].includes(old)) { try { fs.unlinkSync(path.join(fontsDir, old)); } catch (e) { } }
    }
  } else if (fs.existsSync(fontsDir)) {
    fs.rmSync(fontsDir, { recursive: true, force: true });
  }
  // designer-only metadata (font settings, hidden layers) — never part of .fprj
  const designer = { format: 'watchface-designer', version: 1, font: payload.projectFont || null, groupSeq: Number(payload.groupSeq) || 1, groupNames: payload.groupNames || null,
    testData: payload.testData || null, useCurrentTime: !!payload.useCurrentTime, subVersion: payload.subVersion != null ? payload.subVersion : null, slots: [] };
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const dir = i === 0 ? outDir : path.join(outDir, i === 1 ? 'AOD' : `AOD${i}`);
    const imgDir = path.join(dir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    // drop images that are no longer part of the project (renamed/deleted ones)
    const keep = new Set(s.images.map((im) => im.name));
    for (const old of fs.readdirSync(imgDir)) {
      if (old.endsWith('.png') && !keep.has(old)) { try { fs.unlinkSync(path.join(imgDir, old)); } catch (e) { } }
    }
    for (const im of s.images) {
      fs.writeFileSync(path.join(imgDir, im.name), Buffer.from(im.dataBase64, 'base64'));
    }
    if (s.previewPngBase64) fs.writeFileSync(path.join(dir, 'preview.png'), Buffer.from(s.previewPngBase64, 'base64'));
    const face = { DeviceType: deviceType, Screen: { Title: title, Bitmap: 'preview.png', Widgets: s.widgets } };
    fs.writeFileSync(path.join(dir, `${defaultBase}.fprj`), serializeFaceProject(face));
    // collect per-widget designer metadata
    const fonts = {}, hidden = [], taps = {}, presets = {}, groups = {}, locked = [], unlocked = [], imgProps = {};
    for (const w of s.widgets) {
      if (w._hidden) hidden.push(w.Name);
      if (w._tap) taps[w.Name] = w._tap;
      if (w._preset) presets[w.Name] = w._preset;
      if (w._group) groups[w.Name] = w._group;
      if (w._locked) locked.push(w.Name);
      if (w._unlockKeep) unlocked.push(w.Name);
      // editor-only image props (the device just stretches to the box, so these
      // live here rather than in the .fprj): background flag, image fit, fill
      if (w._fit || w._fill || w._background) {
        imgProps[w.Name] = { fit: w._fit || null, fill: w._fill || null, background: !!w._background };
      }
      const f = w._font;
      if (f && f.family) {
        fonts[w.Name] = {
          family: f.family,
          size: f.size || null,
          color: f.color || null,
          bold: !!f.bold,
          italic: !!f.italic,
          kind: fontRefs.has(f.family) ? 'custom' : 'bundled',
          fontFile: fontRefs.get(f.family) || null,
          base: f._base || null,
          glyphs: Array.isArray(f.glyphs) ? f.glyphs : null,
          files: Array.isArray(f.files) ? f.files.slice() : [],
          // fill style: keep every property so reload restores the exact look
          fill: f.fill || 'solid',
          gradFrom: f.gradFrom || null,
          gradTo: f.gradTo || null,
          gradAngle: f.gradAngle == null ? null : f.gradAngle,
          cssFill: f.cssFill || null,
          outlineColor: f.outlineColor || null,
          outlineWidth: f.outlineWidth == null ? null : f.outlineWidth,
        };
      }
    }
    designer.slots.push({ index: i, role: s.role || (i === 0 ? 'face' : 'aod'), aod: !!s.aod, aodFlag: s.aodFlag >>> 0, previewOffset: s.previewOffset >>> 0, tail: s.tail || null, orphanSec9: s.orphanSec9 || [], fonts, hidden, taps, presets, groups, locked, unlocked, imgProps });
    for (const g of Object.values(groups)) {
      const n = parseInt(String(g).replace(/\D/g, ''), 10) || 0;
      if (n >= designer.groupSeq) designer.groupSeq = n + 1;
    }
  }
  fs.writeFileSync(path.join(outDir, 'designer.json'), JSON.stringify(designer, null, 2));
  pushRecent(outDir, title || defaultBase, deviceType);
  return outDir;
});
