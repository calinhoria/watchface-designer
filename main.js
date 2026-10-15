'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const { unpack } = require('./core/unpacker');
const { serializeFaceProject } = require('./core/fprj');
const { getScreenWidth, getScreenHeight, watchDisplayName } = require('./core/watch');

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    title: 'Watchface Designer',
  });
  win.loadFile('index.html');
}
app.whenReady().then(createWindow);
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
    role: s.index === 0 ? 'face' : 'aod',
    widgets: s.widgets,
    rawActions: s.rawActions || [],
    images: [...s.images.entries()].map(([name, im]) => ({
      name, width: im.width, height: im.height,
      url: 'data:image/png;base64,' + rgbaToPngBuffer(im.width, im.height, im.rgba).toString('base64'),
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

// Compile current project state to .bin (V2, 8Pro-family watches)
ipcMain.handle('compile-bin', async (_e, payload) => {
  const { compileFaceProject } = require('./core/packer');
  const { unpack } = require('./core/unpacker');
  const slots = payload.slots.map((s) => ({
    widgets: s.widgets,
    rawActions: s.rawActions || [],
    images: Object.fromEntries(s.images.map((im) => {
      const png = PNG.sync.read(Buffer.from(im.dataBase64, 'base64'));
      return [im.name, { width: png.width, height: png.height, data: Buffer.from(png.data) }];
    })),
    preview: s.previewBase64 ? (() => {
      const png = PNG.sync.read(Buffer.from(s.previewBase64, 'base64'));
      return { width: png.width, height: png.height, data: Buffer.from(png.data) };
    })() : null,
  }));
  let compiled;
  try {
    compiled = compileFaceProject({
      deviceType: payload.deviceType, title: payload.title,
      faceId: payload.faceId, slots,
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
  const { defaultBase, title, deviceType, slots, savePath } = payload;
  let outDir = savePath || null;
  if (!outDir) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to save the project folder',
      buttonLabel: 'Save here', properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    outDir = path.join(r.filePaths[0], defaultBase);
  }
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
  }
  return outDir;
});
