'use strict';
// Renderer: load unpacked data, layer list, canvas composer, drag-move, property edit, export.
let project = null;      // {version, watchType, watchName, screenW, screenH, title, slots, base,...}
let slotIndex = 0;
let selected = -1;
const imgCache = new Map(); // name -> HTMLImageElement

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');

// Human-readable DataSrc mapping (XiaomiWatch.Common FaceItemDataSrc).
// 4-char codes = shape+display hex bytes, shared across all devices.
const DATASRC = [
  ['0811', 'Hour'], ['0911', 'Hour (ones)'], ['1000911', 'Hour (tens)'],
  ['1011', 'Minute'], ['1111', 'Minute (ones)'], ['1211', 'Minute (tens)'],
  ['1811', 'Second'], ['1911', 'Second (ones)'], ['1001911', 'Second (tens)'],
  ['0813', 'AM/PM'],
  ['1012', 'Month'], ['1812', 'Day'], ['1912', 'Day (ones)'], ['1001912', 'Day (tens)'],
  ['2012', 'Weekday'], ['12818', 'Param 0x182A'], ['22818', 'Vitality'],
  ['0821', 'Steps'], ['1021', 'Steps (%)'],
  ['0822', 'Heart rate'], ['1022', 'Heart-rate interval'],
  ['0823', 'Calories'], ['1023', 'Calories (%)'],
  ['0851', 'Distance (m)'], ['0951', 'Distance D1'], ['10951', 'Distance D2'],
  ['20951', 'Distance D3'], ['1051', 'Distance (km)'],
  ['0824', 'Activity count'], ['0826', 'Stress'], ['0828', 'Sleep'],
  ['0841', 'Battery (%)'], ['1041', 'Battery charging'], ['1841', 'Sleep status'],
  ['2041', 'Bluetooth status'], ['3041', 'Screen lock'],
  ['2031', 'Weather temp (°C)'], ['40009031', 'Weather temp (°F)'],
  ['3031', 'Weather type'], ['5031', 'Air quality'],
  ['0825', 'Unknown 0825 (seen on Watch 6 faces)'],
];
const DATASRC_LABEL = Object.fromEntries(DATASRC);
function datasrcLabel(code) { return DATASRC_LABEL[code] || `Unknown (${code})`; }

// Demo digit strings for DigitalNum preview (mirrors unpacker getStringSource).
const DEMO_DIGITS = {
  '0811': '12', '0911': '2', '1000911': '1', '1011': '45', '1111': '5',
  '1211': '4', '1811': '28', '1911': '8', '1001911': '2', '0813': '1',
  '1012': '10', '1812': '21', '1912': '1', '1001912': '2', '2012': '3',
  '0821': '15652', '1021': '50', '0822': '174', '1022': '60',
  '0823': '12175', '1023': '40', '0851': '1500', '1051': '15',
  '0824': '10', '0826': '42', '0828': '60', '0841': '100', '1041': '100',
  '2031': '23', '3031': '1', '5031': '2',
};
function digitalCount(w) {
  const maps = (w.BitmapList || '').split('|').filter(Boolean);
  if (!maps.length) return 0;
  return Math.min(w.Digits || 1, (DEMO_DIGITS[w.DataSrcValue] || '12').length);
}
// Effective inter-digit gap. Stock faces exist with garbage here (e.g. Kool
// Carbon hour/minute carry 244); firmware renders those compact, so values
// at/above the digit width are treated as 0 for preview/hit-testing.
// The raw byte is still preserved verbatim on compile.
function effSpacing(w) {
  const s = w.Spacing || 0, ww = w.Width || 0;
  return (s > 0 && ww > 0 && s < ww) ? s : 0;
}
// Click/selection box: digitals render N digits wide, not one.
function visualBox(w) {
  const ww = w.Width || 40, hh = w.Height || 40;
  if (w.Shape === 32) {
    const n = digitalCount(w);
    if (n > 1) return { x: w.X || 0, y: w.Y || 0, w: n * ww + (n - 1) * effSpacing(w), h: hh };
  }
  return { x: w.X || 0, y: w.Y || 0, w: ww, h: hh };
}

function slot() { return project.slots[slotIndex]; }
function slotName(i) {
  const r = project.slots[i] && project.slots[i].role;
  if (r === 'aod') return i === 0 ? 'AOD' : `AOD ${i}`;
  if (r === 'face') return i === 0 ? 'Face' : `Face ${i + 1}`;
  return i === 0 ? 'Face' : `AOD ${i}`;
}
$('btnAddSlot').onclick = () => { if (project) $('slotModal').hidden = false; };
function removeSlot(i) {
  if (!project || project.slots.length <= 1) return; // keep at least one
  const s = project.slots[i];
  const n = s.widgets.length + s.images.length;
  if (n && !confirm(`Remove ${slotName(i)}? It has ${s.widgets.length} layer(s) and ${s.images.length} image(s).`)) return;
  if (i === 0) {
    // deleting the face keeps an AOD as the new face so the file stays valid
    if (!confirm('This is the main Face slot. The next slot becomes the new Face. Continue?')) return;
  }
  pushHistory();
  project.slots.splice(i, 1);
  project.slots.forEach((x, k) => { x.index = k; if (k === 0) x.role = 'face'; else if (!x.role || x.role === 'face') x.role = 'aod'; });
  slotIndex = Math.max(0, Math.min(slotIndex, project.slots.length - 1));
  selected = -1; imgCache.clear();
  refreshPanels(); render();
}
$('slotCancel').onclick = () => { $('slotModal').hidden = true; };
$('slotCreate').onclick = () => {
  if (!project) return;
  $('slotModal').hidden = true;
  pushHistory();
  const role = $('slotRole').value;
  const n = project.slots.length;
  project.slots.push({ index: n, role, widgets: [], rawActions: [], images: [] });
  slotIndex = n; selected = -1;
  refreshPanels(); render();
};
$('slotModal').addEventListener('mousedown', (e) => { if (e.target === $('slotModal')) $('slotModal').hidden = true; });

// ---------- undo / redo (snapshot history, deduped, capped) ----------
let past = [], future = [];
function snap() {
  return JSON.stringify({ t: project.title, s: project.slots.map((s) => ({ i: s.index, role: s.role || null, w: s.widgets, r: s.rawActions || [], im: s.images })) });
}
function updateHistoryButtons() {
  $('btnUndo').disabled = !past.length;
  $('btnRedo').disabled = !future.length;
}
function pushHistory() {
  if (!project) return;
  const cur = snap();
  if (past.length && past[past.length - 1] === cur) return;
  past.push(cur);
  if (past.length > 30) past.shift();
  future.length = 0;
  updateHistoryButtons();
}
function restoreHistory(json) {
  const st = JSON.parse(json);
  project.title = st.t;
  project.slots = st.s.map((s, i) => ({ ...(project.slots[i] || {}), index: s.i, role: s.role, widgets: s.w, rawActions: s.r, images: s.im }));
  if (slotIndex >= project.slots.length) slotIndex = 0;
  if (selected >= slot().widgets.length) selected = -1;
  $('inpTitle').value = project.title || '';
  imgCache.clear();
  refreshPanels(); render();
  updateHistoryButtons();
}
function undo() {
  if (!project || !past.length) return;
  future.push(snap());
  restoreHistory(past.pop());
}
function redo() {
  if (!project || !future.length) return;
  past.push(snap());
  restoreHistory(future.pop());
}

async function loadImage(name, url) {
  if (imgCache.has(name)) return imgCache.get(name);
  const img = new Image();
  img.src = url;
  await img.decode();
  imgCache.set(name, img);
  return img;
}
function shapeName(s) {
  return s === 30 ? 'Image' : s === 31 ? 'ImageList' : s === 32 ? 'DigitalNum'
    : s === 27 ? 'AnalogClock' : s === 43 ? 'Gauge' : s === 34 ? 'Container' : `Shape${s}`;
}
const SVG = {
  img: '<path d="M3 5h18v14H3z" opacity="0"/><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5-5 3 3 3-3 3 3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="18" r="1.2"/>',
  num: '<path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gauge: '<path d="M12 5a8 8 0 0 1 8 8"/><path d="M12 5a8 8 0 0 0-8 8v1h3l1-2h8"/>',
  box: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M10.6 5.7A8.7 8.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.5 17.5 0 0 1-2.3 3.1M6.6 6.9C4 8.8 2.5 12 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
};
function shapeIcon(s) {
  const p = s === 30 ? SVG.img : s === 31 ? SVG.list : s === 32 ? SVG.num
    : s === 27 ? SVG.clock : s === 43 ? SVG.gauge : s === 34 ? SVG.box : SVG.square;
  return `<svg class="licon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
// collapsible panels: header click toggles (buttons inside header excluded)
document.querySelectorAll('[data-panel]').forEach((p) => {
  p.querySelector('[data-panel-head]').addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // toolbar buttons stay clickable
    p.classList.toggle('collapsed');
  });
});
function hasTap(w) { return Boolean(w && (w._action || /\[[^\]]+\]/.test(w.Name || ''))); }
function paintLayer(i) {
  const s = slot();
  const w = s.widgets[i];
  const d = document.querySelectorAll('#layers .layer')[i];
  if (!d || !w) return;
  const src = w.DataSrcValue || w.DataSrcIndex;
  const extra = src ? ` · ${datasrcLabel(src)}` : '';
  const tap = hasTap(w) ? ' ⚡' : '';
  const tagText = `${shapeName(w.Shape)} ${w.X},${w.Y}${extra}${tap}`;
  d.innerHTML = `<span class="lname">${shapeIcon(w.Shape)}<span class="nname">${w.Name || ''}${w._hidden ? ' <em>(hidden)</em>' : ''}</span></span>`
    + `<span class="lrow-r"><span class="tag">${tagText}</span>`
    + `<button class="lb eye" title="${w._hidden ? 'Show layer' : 'Hide layer'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${w._hidden ? SVG.eyeOff : SVG.eye}</svg></button>`
    + `<button class="lb trash" title="Delete layer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG.trash}</svg></button>`
    + `</span>`;
  d.querySelector('.eye').onclick = (ev) => {
    ev.stopPropagation();
    pushHistory();
    w._hidden = !w._hidden;
    paintLayer(i); render();
  };
  d.querySelector('.trash').onclick = (ev) => {
    ev.stopPropagation();
    pushHistory();
    s.widgets.splice(i, 1);
    if (selected === i) selected = -1;
    else if (selected > i) selected -= 1;
    refreshPanels(); render();
  };
  d.onclick = () => { selected = i; refreshPanels(); render(); };
}
// Tap targets known by the RW4 action packer (core/packer.js RW4_ACTIONS).
const TAP_APPS = ['steps', 'calories', 'standing', 'moving', 'hrm', 'spo2', 'stress', 'sleep', 'weather', 'alarm', 'timer', 'stopwatch', 'cards', 'music', 'compass', 'scheduler', 'flashlight', 'photo', 'findphone', 'breath', 'contact', 'egg', 'todo', 'tomato', 'worldclock', 'phone', 'voice', 'mihome', 'women', 'pressure', 'vitality', 'settings', 'launcher', 'wechat', 'alipay', 'checktool', 'calendar'];

// Bundled OFL digit fonts (assets/fonts). Names must match FontFace family.
const BUNDLED_FONTS = [
  { family: 'Orbitron', file: 'assets/fonts/Orbitron-Bold.ttf' },
  { family: 'Oswald', file: 'assets/fonts/Oswald-SemiBold.ttf' },
  { family: 'Bebas Neue', file: 'assets/fonts/BebasNeue-Regular.ttf' },
  { family: 'Share Tech Mono', file: 'assets/fonts/ShareTechMono-Regular.ttf' },
  { family: 'Roboto Condensed', file: 'assets/fonts/RobotoCondensed-Bold.ttf' },
];
const customFonts = []; // {family, url(data:)}
async function ensureFont(family) {
  if ([...document.fonts].some((f) => f.family === family)) return true;
  const b = BUNDLED_FONTS.find((x) => x.family === family);
  const c = customFonts.find((x) => x.family === family);
  const src = b ? `url("${b.file}")` : c && c.buf ? c.buf : null;
  if (!src) return false;
  const ff = new FontFace(family, src);
  await ff.load();
  document.fonts.add(ff);
  await document.fonts.ready;
  return true;
}
function fontFamilies() { return [...BUNDLED_FONTS.map((f) => f.family), ...customFonts.map((f) => f.family)]; }
function widgetBitmaps(w) {
  if (w.Shape === 30) return w.Bitmap ? [w.Bitmap] : [];
  const list = (w.BitmapList || '').split('|').map(x => x.includes(':') ? x.split(':')[1] : x).filter(Boolean);
  if (w.Shape === 27) return [w.BackgroundImage, w.HourHandImage, w.MinuteHandImage, w.SecondHandImage].filter(Boolean);
  if (w.Shape === 43) return w.PointerImage ? [w.PointerImage] : [];
  return list.slice(0, 4);
}
async function render() {
  if (!project) return;
  const W = project.screenW || 240, H = project.screenH || 280;
  const scale = Math.min(560 / W, 560 / H, 2);
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  const s = slot();
  const urlByName = new Map(s.images.map(i => [i.name, i.url]));
  for (let vi = 0; vi < s.widgets.length; vi++) {
    const w = s.widgets[vi];
    if (w.Alpha === 0 || w._hidden) continue;
    try {
      if (w.Shape === 30 && w.Bitmap && urlByName.has(w.Bitmap)) {
        const img = await loadImage(w.Bitmap, urlByName.get(w.Bitmap));
        ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, (w.Width || img.naturalWidth) * scale, (w.Height || img.naturalHeight) * scale);
      } else if (w.Shape === 31) {
        const parts = (w.BitmapList || '').split('|').filter(Boolean);
        if (!parts.length) continue;
        const pick = parts[Math.min(w.DefaultIndex || 0, parts.length - 1)];
        const nm = pick.includes(':') ? pick.split(':')[1] : pick;
        if (!urlByName.has(nm)) continue;
        const img = await loadImage(nm, urlByName.get(nm));
        ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, (w.Width || img.naturalWidth) * scale, (w.Height || img.naturalHeight) * scale);
      } else if (w.Shape === 32) {
        const maps = (w.BitmapList || '').split('|').filter(Boolean);
        if (!maps.length) continue;
        const demo = DEMO_DIGITS[w.DataSrcValue] || '12';
        let x = (w.X || 0) * scale;
        const y = (w.Y || 0) * scale, dw = (w.Width || 20) * scale, dh = (w.Height || 30) * scale;
        const gap = effSpacing(w) * scale;
        const n = Math.min(w.Digits || 1, demo.length);
        for (let i = 0; i < n; i++) {
          const d = parseInt(demo[i], 10);
          const nm = maps[Math.min(d, maps.length - 1)];
          if (!urlByName.has(nm)) continue;
          const img = await loadImage(nm, urlByName.get(nm));
          ctx.drawImage(img, x, y, dw, dh);
          x += dw + gap;
        }
      } else if (w.Shape === 27) {
        for (const k of ['BackgroundImage', 'HourHandImage', 'MinuteHandImage', 'SecondHandImage']) {
          if (w[k] && urlByName.has(w[k])) {
            const img = await loadImage(w[k], urlByName.get(w[k]));
            ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, cv.width, cv.height);
          }
        }
      } else if (w.Shape === 43 && w.PointerImage && urlByName.has(w.PointerImage)) {
        const img = await loadImage(w.PointerImage, urlByName.get(w.PointerImage));
        ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, (w.Width || img.naturalWidth) * scale, (w.Height || img.naturalHeight) * scale);
      }
    } catch (e) { /* missing img */ }
    if (vi === selected) {
      const vb = visualBox(s.widgets[vi]);
      ctx.strokeStyle = '#2f6feb'; ctx.lineWidth = 2;
      ctx.strokeRect(vb.x * scale, vb.y * scale, Math.max(vb.w * scale, 8), Math.max(vb.h * scale, 8));
    }
  }
  // orphan tap zones from the file (preserved on compile): dashed markers
  for (const t of (s.rawActions || [])) {
    ctx.strokeStyle = 'rgba(255,180,0,0.85)'; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(((t.x || 0)) * scale, ((t.y || 0)) * scale, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,180,0,0.9)';
    ctx.font = '11px sans-serif';
    ctx.fillText('⚡' + (t.label || ''), ((t.x || 0)) * scale + 18, ((t.y || 0)) * scale + 4);
  }
}
function refreshPanels() {
  const s = slot();
  $('wcount').textContent = `(${s.widgets.length})`;
  $('icount').textContent = `(${s.images.length})`;
  $('screenInfo').textContent = `v${project.version} · ${project.watchName} · ${project.screenW}×${project.screenH} · ${slotName(slotIndex)}`;
  $('watchTitle').textContent = project.watchName || 'Unknown watch';
  $('watchSub').textContent = `${project.title || project.base || ''} · ${project.screenW}×${project.screenH} · ${slotName(slotIndex)}`;
  // slots
  const sl = $('slots'); sl.innerHTML = '';
  project.slots.forEach((x, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'slot-chip' + (i === slotIndex ? ' sel' : '');
    const b = document.createElement('button');
    b.className = 'slot-btn';
    b.textContent = slotName(i);
    b.title = (x.role || (i === 0 ? 'face' : 'aod')) === 'face' ? 'Main watchface' : 'Always-on display variant';
    b.onclick = () => { slotIndex = i; selected = -1; imgCache.clear(); refreshPanels(); render(); };
    wrap.appendChild(b);
    if (project.slots.length > 1) {
      const x2 = document.createElement('button');
      x2.className = 'slot-del';
      x2.textContent = '✕';
      x2.title = `Remove ${slotName(i)}`;
      x2.onclick = (ev) => { ev.stopPropagation(); removeSlot(i); };
      wrap.appendChild(x2);
    }
    sl.appendChild(wrap);
  });
  // layers
  const L = $('layers'); L.innerHTML = '';
  s.widgets.forEach((w, i) => {
    const d = document.createElement('div');
    d.className = 'layer' + (i === selected ? ' sel' : '') + (w._hidden ? ' hid' : '');
    L.appendChild(d); paintLayer(i);
  });
  if ((s.rawActions || []).length) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = `${s.rawActions.length} tap zone(s) from file (⚡ markers, preserved on compile)`;
    L.appendChild(t);
  }
  // images
  const G = $('images'); G.innerHTML = '';
  for (const im of s.images.slice(0, 400)) {
    const d = document.createElement('div');
    d.className = 'img';
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = `Delete ${im.name}`;
    del.onclick = (ev) => { ev.stopPropagation(); deleteImage(im.name); };
    d.appendChild(del);
    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = im.url; img.title = im.name;
    d.appendChild(img);
    const cap = document.createElement('div');
    cap.textContent = `${im.name} ${im.width}×${im.height}`;
    d.appendChild(cap);
    G.appendChild(d);
  }
  // props
  const P = $('props'); P.innerHTML = '';
  if (selected < 0 || !s.widgets[selected]) { P.innerHTML = '<p class="muted">Select a layer.</p>'; return; }
  const w = s.widgets[selected];
  const fields = [['Name', 'text'], ['X', 'number'], ['Y', 'number'], ['Width', 'number'], ['Height', 'number'], ['Alpha', 'number'], ['Bitmap', 'text'], ['BitmapList', 'text'], ['DataSrcValue', 'text'], ['DataSrcIndex', 'text'], ['Digits', 'number'], ['Alignment', 'number'], ['Spacing', 'number'], ['Blanking', 'number']];
  const grid = document.createElement('div');
  for (const [k, t] of fields) {
    if (w[k] === undefined) continue;
    const lab = document.createElement('label'); lab.className = 'row';
    lab.textContent = k;
    if (k === 'DataSrcValue' || k === 'DataSrcIndex') {
      const sel = document.createElement('select');
      const cur = String(w[k]);
      if (!DATASRC_LABEL[cur]) {
        const o = document.createElement('option');
        o.value = cur; o.textContent = `Unknown (${cur})`; sel.appendChild(o);
      }
      for (const [code, label] of DATASRC) {
        const o = document.createElement('option');
        o.value = code; o.textContent = `${label} (${code})`;
        sel.appendChild(o);
      }
      sel.value = cur;
      // light update: no panel rebuild, focus stays in the control
      sel.onchange = () => { w[k] = sel.value; paintLayer(selected); render(); };
      lab.appendChild(sel);
    } else {
      const inp = document.createElement('input'); inp.type = t; inp.value = w[k];
      if (k === 'Name' && w.Shape === 30 && hasTap(w)) {
        // tap-action names drive compilation (btn_ prefix + [app] suffix):
        // rename via the Tap action dropdown instead
        inp.readOnly = true; inp.title = 'Managed by the Tap action row below — renaming breaks the button';
      }
      // live edit without rebuilding the panel (rebuild steals focus)
      inp.oninput = () => { w[k] = t === 'number' ? parseInt(inp.value, 10) || 0 : inp.value; paintLayer(selected); render(); };
      lab.appendChild(inp);
    }
    grid.appendChild(lab);
  }
  if (w.Shape === 30) {
    const row = document.createElement('label'); row.className = 'row';
    row.textContent = 'Tap action';
    const sel = document.createElement('select');
    const m = /\[([^\]]+)\]/.exec(w.Name || '');
    const curApp = m ? m[1].toLowerCase() : null;
    const none = document.createElement('option');
    none.value = ''; none.textContent = (!curApp && w._action) ? 'Custom (from file)' : 'None';
    sel.appendChild(none);
    for (const a of TAP_APPS) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      sel.appendChild(o);
    }
    if (curApp && !TAP_APPS.includes(curApp)) {
      const o = document.createElement('option');
      o.value = curApp; o.textContent = `${curApp} (unknown — compile will fail)`;
      sel.appendChild(o);
    }
    sel.value = curApp || '';
    sel.onchange = () => {
      const base = (w.Name || '').replace(/_?\[[^\]]+\]\s*$/, '');
      if (sel.value) { w.Name = `${base}_[${sel.value}]`; delete w._action; }
      else { w.Name = base; }
      paintLayer(selected); render();
    };
    row.appendChild(sel);
    grid.appendChild(row);
  }
  if (w.Shape === 32 || w.Shape === 31) {
    const f = w._font = w._font || {};
    const frow = document.createElement('label'); frow.className = 'row';
    frow.textContent = 'Font';
    const fsel = document.createElement('select');
    const none = document.createElement('option'); none.value = ''; none.textContent = '—'; fsel.appendChild(none);
    for (const fam of fontFamilies()) {
      const o = document.createElement('option'); o.value = fam; o.textContent = fam; fsel.appendChild(o);
    }
    if (f.family && ![...fsel.options].some((o) => o.value === f.family)) {
      const o = document.createElement('option'); o.value = f.family; o.textContent = `${f.family} (missing)`; fsel.appendChild(o);
    }
    const imp = document.createElement('option'); imp.value = '__import'; imp.textContent = 'Import custom…'; fsel.appendChild(imp);
    fsel.value = f.family || '';
    fsel.onchange = () => {
      if (fsel.value === '__import') { fontImportTarget = selected; $('fileFont').click(); fsel.value = f.family || ''; return; }
      f.family = fsel.value;
      paintLayer(selected); render();
      if (f.family) queueFontGen(w);
    };
    frow.appendChild(fsel);
    grid.appendChild(frow);
    if (f.family) {
      const srow = document.createElement('div'); srow.className = 'row';
      const sizeInp = document.createElement('input'); sizeInp.type = 'number'; sizeInp.title = 'Digit height (px)';
      sizeInp.value = f.size || w.Height || 60;
      sizeInp.setAttribute('data-font-size', '1');
      sizeInp.oninput = () => { f.size = parseInt(sizeInp.value, 10) || 60; queueFontGen(w); };
      const colInp = document.createElement('input'); colInp.type = 'color'; colInp.title = 'Digit color';
      colInp.value = f.color || '#ffffff';
      colInp.oninput = () => { f.color = colInp.value; queueFontGen(w); };
      const mkCheck = (key, title) => {
        const l = document.createElement('label'); l.className = 'small'; l.title = title;
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!f[key];
        c.onchange = () => { f[key] = c.checked; queueFontGen(w); };
        l.appendChild(c); l.appendChild(document.createTextNode(' ' + key[0].toUpperCase()));
        l.title = title;
        return l;
      };
      const gen = document.createElement('button'); gen.className = 'grow-btn'; gen.textContent = 'Generate 0-9';
      gen.onclick = () => generateFontBitmaps(w, slot());
      srow.appendChild(sizeInp); srow.appendChild(colInp);
      srow.appendChild(mkCheck('bold', 'Faux bold')); srow.appendChild(mkCheck('italic', 'Faux italic'));
      srow.appendChild(gen);
      grid.appendChild(srow);
      if ((f.files || []).length) {
        const note = document.createElement('div'); note.className = 'muted';
        note.textContent = `${f.files.length} images from ${f.family} (regenerating replaces them).`;
        grid.appendChild(note);
      }
    }
  }
  P.appendChild(grid);
  // capture pre-edit state for undo (dedupe makes repeats harmless)
  grid.querySelectorAll('input,select').forEach((el) => {
    el.addEventListener('focus', pushHistory);
    el.addEventListener('pointerdown', pushHistory);
  });
}

function uniqName(base, taken) {
  const clean = String(base || 'item').replace(/[^\w\-.]+/g, '_');
  if (!taken.has(clean)) return clean;
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  let i = 1;
  while (taken.has(`${stem}_${i}${ext}`)) i++;
  return `${stem}_${i}${ext}`;
}
function imageUsers(s, name) {
  const out = [];
  s.widgets.forEach((w, i) => {
    const blobs = [w.Bitmap, w.BitmapList, w.BackgroundImage, w.HourHandImage, w.MinuteHandImage, w.SecondHandImage, w.PointerImage].filter(Boolean).join('|');
    if (blobs.split('|').some((p) => (p.includes(':') ? p.split(':')[1] : p) === name)) out.push(`${i}:${w.Name || ''}`);
  });
  return out;
}
function deleteImage(name) {
  if (!project) return;
  const s = slot();
  const users = imageUsers(s, name);
  if (users.length && !confirm(`Image ${name} is used by ${users.join(', ')}. Delete anyway?`)) return;
  const i = s.images.findIndex((im) => im.name === name);
  if (i >= 0) { pushHistory(); s.images.splice(i, 1); }
  imgCache.delete(name);
  refreshPanels(); render();
}
function moveSelected(dir) {
  if (!project) return;
  pushHistory();
  const s = slot();
  const j = selected + dir;
  if (selected < 0 || j < 0 || j >= s.widgets.length) return;
  const [w] = s.widgets.splice(selected, 1);
  s.widgets.splice(j, 0, w);
  selected = j;
  refreshPanels(); render();
}
function addWidget(kind) {
  if (!project) return;
  const s = slot();
  const W = project.screenW || 432, H = project.screenH || 514;
  const taken = new Set(s.widgets.map((w) => w.Name));
  const firstImg = s.images.length ? s.images[0].name : '';
  const cx = Math.round(W / 2), cy = Math.round(H / 2);
  let w;
  if (kind === 'img') w = { Shape: 30, Name: uniqName('image_new', taken), X: cx - 50, Y: cy - 50, Width: 100, Height: 100, Alpha: 255, Bitmap: firstImg };
  else if (kind === 'num') w = { Shape: 32, Name: uniqName('widget_new', taken), X: cx - 40, Y: cy - 30, Width: 40, Height: 60, Alpha: 255, Digits: 2, Alignment: 0, Spacing: 0, Blanking: 0, DataSrcValue: '0811', BitmapList: '' };
  else if (kind === 'list') w = { Shape: 31, Name: uniqName('widget_new', taken), X: cx - 30, Y: cy - 20, Width: 60, Height: 40, Alpha: 255, DataSrcIndex: '2012', DefaultIndex: 0, BitmapList: '' };
  else if (kind === 'clock') w = { Shape: 27, Name: uniqName('analogClock_new', taken), X: 0, Y: 0, Width: W, Height: H, Alpha: 255, HourHandImage: '', HourImageRotateX: 0, HourImageRotateY: 0, MinuteHandImage: '', MinuteImageRotateX: 0, MinuteImageRotateY: 0, SecondHandImage: '', SecondImageRotateX: 0, SecondImageRotateY: 0 };
  else if (kind === 'btn') w = { Shape: 30, Name: uniqName('btn_new', taken) + '_[alarm]', X: cx - 30, Y: cy - 30, Width: 60, Height: 60, Alpha: 255, Bitmap: firstImg };
  else return;
  pushHistory();
  s.widgets.push(w);
  selected = s.widgets.length - 1;
  refreshPanels(); render();
}
async function generateFontBitmaps(w, s) {
  const f = w._font = w._font || {};
  if (!f.family) { alert('Pick a font first.'); return; }
  const current = (w.BitmapList || '').split('|').filter(Boolean);
  if (current.length && !(f.files || []).length && !confirm(`Replace the current BitmapList (${current.length} images) with generated digits?`)) return;
  const size = Math.max(8, f.size || w.Height || 60);
  const color = f.color || '#ffffff';
  const bold = !!f.bold, italic = !!f.italic;
  $('meta').textContent = `Loading font ${f.family}…`;
  if (!await ensureFont(f.family)) { $('meta').textContent = `Font not found: ${f.family}`; return; }
  try { await document.fonts.load(`${size}px "${f.family}"`, '0123456789'); } catch (e) { /* keep going */ }
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `${size}px "${f.family}"`;
  const stroke = bold ? Math.max(1, Math.round(size / 18)) : 0;
  let mw = 1, top = 1, bot = 1;
  for (let d = 0; d < 10; d++) {
    const m = meas.measureText(String(d));
    mw = Math.max(mw, Math.ceil(m.width));
    top = Math.max(top, Math.ceil(m.actualBoundingBoxAscent || size * 0.8));
    bot = Math.max(bot, Math.ceil(m.actualBoundingBoxDescent || size * 0.2));
  }
  const H = top + bot;
  pushHistory();
  const slant = italic ? Math.ceil(H * 0.212) : 0;
  mw += stroke + slant;
  // delete the previous generated set (stale files never linger)
  if (f.files) for (const n of f.files) {
    const i = s.images.findIndex((im) => im.name === n);
    if (i >= 0) s.images.splice(i, 1);
    imgCache.delete(n);
  }
  const base = String(w.Name || 'digits').replace(/[^\w\-]+/g, '_');
  const taken = new Set(s.images.map((im) => im.name));
  f.files = []; f.size = size; f.color = color;
  const names = [];
  for (let d = 0; d < 10; d++) {
    const c2 = document.createElement('canvas'); c2.width = mw; c2.height = H;
    const c = c2.getContext('2d');
    c.font = `${size}px "${f.family}"`; c.fillStyle = color; c.strokeStyle = color;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.save();
    // draw around the glyph center so the shear stays inside the canvas
    c.translate(mw / 2 + (italic ? slant / 2 - H * 0.106 : 0), H / 2);
    if (italic) c.transform(1, 0, -0.212, 1, 0, 0);
    if (bold) { c.lineWidth = stroke; c.strokeText(String(d), 0, 0); }
    c.fillText(String(d), 0, 0);
    c.restore();
    const name = uniqName(`${base}_${d}.png`, taken); taken.add(name);
    s.images.push({ name, width: mw, height: H, url: c2.toDataURL('image/png') });
    names.push(name); f.files.push(name);
  }
  w.BitmapList = names.join('|');
  w.Width = mw; w.Height = H;
  $('meta').textContent = `Font ${f.family}: 10 digits generated (${mw}×${H}).`;
  refreshPanels(); render();
  // auto-regen rebuilds the panel: hand focus back to the size field
  const si = document.querySelector('[data-font-size]');
  if (si) { si.focus(); si.select(); }
}
// Debounced auto-regenerate: every font/size/color/style change re-renders
// the PNG set (stale files are deleted inside generateFontBitmaps).
let fontGenTimer = null;
function queueFontGen(w) {
  clearTimeout(fontGenTimer);
  const s = slot();
  fontGenTimer = setTimeout(() => { if (project && s.widgets.includes(w)) generateFontBitmaps(w, s); }, 450);
}

// Devices the compiler supports (core/packer.js SUPPORTED + screen sizes).
// pv is the preview size written on compile: full face size everywhere
// except 565, whose 0.6x thumbnail is what disambiguates it from 465
// (both are 432x514; see core/watch.js PreviewSizes).
const SUPPORTED_DEVICES = [
  { type: 11, name: 'Mi Band 8 Pro', w: 336, h: 480, pvW: 336, pvH: 480 },
  { type: 362, name: 'Mi Watch S3', w: 466, h: 466, pvW: 464, pvH: 464 },
  { type: 365, name: 'Redmi Watch 4', w: 390, h: 450, pvW: 390, pvH: 450 },
  { type: 367, name: 'Mi Band 9 Pro', w: 336, h: 480, pvW: 336, pvH: 480 },
  { type: 462, name: 'Mi Watch S4', w: 466, h: 466, pvW: 464, pvH: 464 },
  { type: 465, name: 'Redmi Watch 5', w: 432, h: 514, pvW: 432, pvH: 514 },
  { type: 562, name: 'Mi Watch S5', w: 480, h: 480, pvW: 480, pvH: 480 },
  { type: 565, name: 'Redmi Watch 6', w: 432, h: 514, pvW: 259, pvH: 308 },
];
function openNewFaceDialog() {
  const sel = $('newFaceDevice');
  sel.innerHTML = '';
  for (const d of SUPPORTED_DEVICES) {
    const o = document.createElement('option');
    o.value = d.type;
    o.textContent = `${d.name} · ${d.w}×${d.h}`;
    sel.appendChild(o);
  }
  sel.value = '565';
  $('newFaceName').value = 'My face';
  $('newFaceModal').hidden = false;
  setTimeout(() => $('newFaceName').select(), 0);
}
function createNewFace() {
  const dev = SUPPORTED_DEVICES.find((d) => d.type === parseInt($('newFaceDevice').value, 10)) || SUPPORTED_DEVICES[0];
  const title = $('newFaceName').value.trim() || 'My face';
  $('newFaceModal').hidden = true;
  project = {
    base: title.replace(/[^\w\-]+/g, '_'), filePath: null,
    version: 2, watchType: dev.type, watchName: dev.name,
    screenW: dev.w, screenH: dev.h, title, faceId: '',
    previewUrl: null,
    slots: [{ index: 0, role: 'face', widgets: [], rawActions: [], images: [] }],
  };
  slotIndex = 0; selected = -1; imgCache.clear();
  past = []; future = [];
  pushHistory();
  updateHistoryButtons();
  $('inpTitle').value = title;
  for (const id of ['btnExport', 'btnCompile', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnUp', 'btnDown']) $(id).disabled = false;
  refreshPanels(); render();
}
$('btnNew').onclick = openNewFaceDialog;
$('newFaceCancel').onclick = () => { $('newFaceModal').hidden = true; };
$('newFaceCreate').onclick = createNewFace;
$('newFaceModal').addEventListener('mousedown', (e) => { if (e.target === $('newFaceModal')) $('newFaceModal').hidden = true; });
$('btnOpenProject').onclick = async () => {
  const res = await window.api.openProject();
  if (!res) return;
  if (res.error) { $('meta').textContent = res.error; return; }
  loadProject(res);
};
$('btnOpen').onclick = async () => {
  const res = await window.api.openBinDialog();
  if (!res) return;
  loadProject(res);
};
function loadProject(res) {
  project = res; slotIndex = 0; selected = -1; imgCache.clear();
  past = []; future = [];
  pushHistory(); // baseline for undo
  updateHistoryButtons();
  $('inpTitle').value = project.title || '';
  $('meta').textContent = `${res.base} · v${res.version} · ${res.watchName} · ${res.screenW}×${res.screenH} · ${res.slots.length} slot(s)`;
  for (const id of ['btnExport', 'btnCompile', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnUp', 'btnDown']) $(id).disabled = false;
  if (res.version !== 2) $('btnCompile').disabled = true;
  refreshPanels(); render();
}
$('btnAddImg').onclick = () => addWidget('img');
$('btnAddNum').onclick = () => addWidget('num');
$('btnAddList').onclick = () => addWidget('list');
$('btnAddClock').onclick = () => addWidget('clock');
$('btnAddBtn').onclick = () => addWidget('btn');
$('btnUp').onclick = () => moveSelected(-1);
$('btnDown').onclick = () => moveSelected(1);
$('btnUpload').onclick = () => $('fileUpload').click();
$('fileUpload').onchange = async () => {
  if (!project) return;
  pushHistory();
  const s = slot();
  const taken = new Set(s.images.map((im) => im.name));
  for (const file of $('fileUpload').files) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch (e) { continue; }
    const name = uniqName(file.name, taken); taken.add(name);
    imgCache.delete(name);
    s.images.push({ name, width: img.naturalWidth, height: img.naturalHeight, url });
  }
  $('fileUpload').value = '';
  refreshPanels(); render();
};
let fontImportTarget = -1;
$('fileFont').onchange = async () => {
  const file = $('fileFont').files[0];
  $('fileFont').value = '';
  if (!file || !project || fontImportTarget < 0) return;
  const buf = await file.arrayBuffer();
  const family = 'Custom-' + file.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_');
  try {
    const ff = new FontFace(family, buf);
    await ff.load();
    document.fonts.add(ff);
    await document.fonts.ready;
  } catch (e) { alert(`Could not load font: ${e.message}`); return; }
  customFonts.push({ family, buf });
  const w = slot().widgets[fontImportTarget];
  if (w) { w._font = w._font || {}; w._font.family = family; }
  refreshPanels(); render();
};
$('inpTitle').onchange = (e) => { if (project) project.title = e.target.value; };
$('inpTitle').addEventListener('focus', pushHistory);
$('inpTitle').addEventListener('pointerdown', pushHistory);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || project == null) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return; // native text undo
  if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 's' && !$('btnExport').disabled) { e.preventDefault(); $('btnExport').click(); }
});
$('btnUp').disabled = true; $('btnDown').disabled = true; $('btnAddSlot').disabled = true;
$('btnCompile').onclick = async () => {
  if (!project) return;
  $('meta').textContent = 'Compiling…';
  // new faces/slots have no decoded preview: compose each from the canvas at
  // the device's preview size (full face, except the 565 thumbnail)
  const dev = SUPPORTED_DEVICES.find((d) => d.type === project.watchType);
  const pvW = dev ? dev.pvW : project.screenW, pvH = dev ? dev.pvH : project.screenH;
  const slots = [];
  for (let i = 0; i < project.slots.length; i++) {
    const s = project.slots[i];
    slots.push({
      widgets: s.widgets,
      rawActions: s.rawActions || [],
      images: s.images.map((im) => ({ name: im.name, dataBase64: im.url.split(',')[1] })),
      previewBase64: await slotPreviewB64(i, pvW, pvH),
    });
  }
  const res = await window.api.compileBin({
    defaultBase: project.base, title: $('inpTitle').value || project.title || project.base,
    deviceType: project.watchType, faceId: project.faceId || '',
    slots,
  });
  if (!res || !res.ok) {
    $('meta').textContent = `Compile failed: ${res ? res.error : 'cancelled'}`;
    return;
  }
  const notes = [...(res.warnings || []), ...(res.issues || [])];
  $('meta').textContent = `Compiled → ${res.path} (${res.bytes}B)${notes.length ? ' · ' + notes.join(' · ') : ' · verified OK'}`;
};
// Compose a slot to a face-sized PNG (used when a slot has no decoded
// preview of its own, e.g. newly created faces/slots).
async function composeSlotPng(si, w, h) {
  const prevSlot = slotIndex, prevSel = selected;
  slotIndex = si; selected = -1;
  await render();
  const pv = document.createElement('canvas');
  pv.width = w; pv.height = h;
  pv.getContext('2d').drawImage(cv, 0, 0, w, h);
  const b64 = pv.toDataURL('image/png').split(',')[1];
  slotIndex = prevSlot; selected = prevSel;
  await render();
  return b64;
}
async function slotPreviewB64(si, w, h) {
  const s = project.slots[si];
  if (s && s.previewUrl) return s.previewUrl.split(',')[1];
  if (si === 0 && project.previewUrl) return project.previewUrl.split(',')[1];
  return composeSlotPng(si, w, h);
}
$('btnExport').onclick = async () => {
  if (!project) return;
  const title = $('inpTitle').value || project.title || project.base;
  const outs = [];
  for (let i = 0; i < project.slots.length; i++) {
    outs.push({
      widgets: project.slots[i].widgets,
      images: project.slots[i].images.map((im) => ({ name: im.name, dataBase64: im.url.split(',')[1] })),
      previewPngBase64: await slotPreviewB64(i, project.screenW, project.screenH),
    });
  }
  const out = await window.api.exportProject({
    defaultBase: project.base, title, deviceType: project.watchType,
    savePath: project.savePath || null, slots: outs,
  });
  if (out) {
    project.savePath = out;
    project.title = title;
    $('meta').textContent = `Saved → ${out} (${project.slots.length} slot${project.slots.length > 1 ? 's' : ''})`;
  }
};
// canvas hit-test + drag
let drag = null;
cv.addEventListener('mousedown', (e) => {
  if (!project) return;
  const r = cv.getBoundingClientRect();
  const sc = cv.width / (project.screenW || 240);
  const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
  const s = slot();
  for (let i = s.widgets.length - 1; i >= 0; i--) {
    if (s.widgets[i]._hidden) continue;
    const vb = visualBox(s.widgets[i]);
    const x = vb.x * sc, y = vb.y * sc, ww = vb.w * sc, hh = vb.h * sc;
    if (mx >= x && mx <= x + ww && my >= y && my <= y + hh) {
      pushHistory();
      selected = i; drag = { dx: mx - x, dy: my - y }; refreshPanels(); render(); break;
    }
  }
});
window.addEventListener('mousemove', (e) => {
  if (!drag || !project) return;
  const r = cv.getBoundingClientRect();
  const sc = cv.width / (project.screenW || 240);
  const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
  const w = slot().widgets[selected];
  w.X = Math.round((mx - drag.dx) / sc); w.Y = Math.round((my - drag.dy) / sc);
  render();
  paintLayer(selected);
});
window.addEventListener('mouseup', () => { if (drag) { drag = null; if (project) refreshPanels(); } });
