'use strict';
// Renderer: load unpacked data, layer list, canvas composer, drag-move, property edit, export.
let project = null;      // {version, watchType, watchName, screenW, screenH, title, slots, base,...}
let slotIndex = 0;
let selected = -1;
let groupSel = new Set();   // multi-select for grouping
let groupSeq = 1;
const collapsedGroups = new Set();   // group ids collapsed in the Layers list
const groupNames = {};               // gid -> user name (persisted in designer.json)
function groupName(gid) { return groupNames[gid] || `Group ${String(gid).replace(/^g/, '')}`; }
const imgCache = new Map(); // name -> HTMLImageElement

const $ = (id) => document.getElementById(id);
const escAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cv = $('cv'), ctx = cv.getContext('2d');

// Human-readable DataSrc mapping (XiaomiWatch.Common FaceItemDataSrc).
// 4-char codes = shape+display hex bytes, shared across all devices.
const DATASRC = [
  ['0811', 'Hour'], ['0911', 'Hour (ones)'], ['1000911', 'Hour (tens)'],
  ['1011', 'Minute'], ['1111', 'Minute (ones)'], ['1211', 'Minute (tens)'],
  ['1811', 'Second'], ['1911', 'Second (ones)'], ['1001911', 'Second (tens)'],
  ['0813', 'AM/PM'],
  ['1012', 'Month'], ['1812', 'Day'], ['1912', 'Day (ones)'], ['1001912', 'Day (tens)'],
  ['2012', 'Weekday'], ['12818', 'Unknown param'], ['22818', 'Vitality'],
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
  ['0825', 'Unknown (Watch 6 faces)'],
];
const DATASRC_LABEL = Object.fromEntries(DATASRC);
function datasrcLabel(code) { return DATASRC_LABEL[code] || `Unknown (${code})`; }

// ---------- test data (drives the preview) ----------
const TEST_FIELDS = [
  ['hour', 'Hour'], ['minute', 'Minute'], ['second', 'Second'], ['ampm', 'AM/PM'],
  ['month', 'Month'], ['day', 'Day'], ['weekday', 'Weekday'],
  ['steps', 'Steps'], ['stepsPct', 'Steps %'], ['hr', 'Heart rate'], ['hrInterval', 'HR interval'],
  ['calories', 'Calories'], ['caloriesPct', 'Calories %'],
  ['distanceM', 'Distance m'], ['distanceKm', 'Distance km'],
  ['activity', 'Activity'], ['stress', 'Stress'], ['sleep', 'Sleep'],
  ['battery', 'Battery'], ['charging', 'Charging'],
  ['tempC', 'Weather \u00b0C'], ['tempF', 'Weather \u00b0F'], ['weatherType', 'Weather type'], ['air', 'Air quality'],
];
const TEST_DEFAULTS = {
  hour: '12', minute: '45', second: '28', ampm: 'AM', month: '10', day: '21', weekday: '3',
  steps: '15652', stepsPct: '50', hr: '174', hrInterval: '60', calories: '12175', caloriesPct: '40',
  distanceM: '1500', distanceKm: '15', activity: '10', stress: '42', sleep: '60',
  battery: '100', charging: '100', tempC: '23', tempF: '74', weatherType: '1', air: '2',
};
const TIME_FIELDS = ['hour', 'minute', 'second', 'month', 'day'];
let TEST_DATA = { ...TEST_DEFAULTS };
let useCurrentTime = false;
// DataSrc code -> [test field, which slice]
const CODE_FIELD = {
  '0811': ['hour', 'both'], '0911': ['hour', 'ones'], '1000911': ['hour', 'tens'],
  '1011': ['minute', 'both'], '1111': ['minute', 'ones'], '1211': ['minute', 'tens'],
  '1811': ['second', 'both'], '1911': ['second', 'ones'], '1001911': ['second', 'tens'],
  '0813': ['ampm', 'both'],
  '1012': ['month', 'both'], '1812': ['day', 'both'], '1912': ['day', 'ones'], '1001912': ['day', 'tens'],
  '2012': ['weekday', 'both'],
  '0821': ['steps', 'both'], '1021': ['stepsPct', 'both'], '0822': ['hr', 'both'], '1022': ['hrInterval', 'both'],
  '0823': ['calories', 'both'], '1023': ['caloriesPct', 'both'],
  '0851': ['distanceM', 'both'], '0951': ['distanceM', 'both'], '10951': ['distanceM', 'both'], '20951': ['distanceM', 'both'],
  '1051': ['distanceKm', 'both'], '0824': ['activity', 'both'], '0826': ['stress', 'both'], '0828': ['sleep', 'both'],
  '0841': ['battery', 'both'], '1041': ['charging', 'both'],
  '1841': ['sleep', 'both'], '2041': ['charging', 'both'], '3041': ['battery', 'both'],
  '2031': ['tempC', 'both'], '40009031': ['tempF', 'both'], '3031': ['weatherType', 'both'], '5031': ['air', 'both'],
  '0825': ['activity', 'both'], '18218': ['tempC', 'both'], '22818': ['activity', 'both'],
};
// numeric value of the test data behind a data-source code (for value-mapped lists)
function testNumeric(code) {
  const map = CODE_FIELD[String(code || '')];
  if (!map) return null;
  const raw = TEST_DATA[map[0]];
  const n = parseInt(String(raw == null ? '' : raw).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function pad2(v) { return String(v).replace(/[^0-9]/g, '').padStart(2, '0').slice(-2); }
function nowFields() {
  const d = new Date();
  const h24 = d.getHours();
  return {
    hour: pad2(h24 % 12 === 0 ? 12 : h24 % 12), minute: pad2(d.getMinutes()), second: pad2(d.getSeconds()),
    ampm: h24 < 12 ? 'AM' : 'PM', month: pad2(d.getMonth() + 1), day: pad2(d.getDate()),
    weekday: String(d.getDay() === 0 ? 7 : d.getDay()),
  };
}
// string the preview should show for a widget's data source
function demoDigits(w) {
  const map = CODE_FIELD[String(w.DataSrcValue || w.DataSrcIndex || '')];
  const pad = (f, v) => (TIME_FIELDS.includes(f) || f === 'ampm' ? String(v) : String(v));
  if (!map) return String(TEST_DATA.hour || '12');
  const [field, which] = map;
  let v = pad(field, TEST_DATA[field] != null ? TEST_DATA[field] : TEST_DEFAULTS[field]);
  if (TIME_FIELDS.includes(field) || field === 'ampm') v = field === 'ampm' ? v : pad2(v);
  if (which === 'ones') return v.slice(-1);
  if (which === 'tens') return v.length > 1 ? v.slice(0, v.length - 1) : v;
  return v;
}
// Blanking = hide leading zeros (08 -> 8). Device-verified: the hidden-zeros
// behaviour is the compiled bit4 CLEAR, which is model Blanking truthy
// (packer: buf[3] |= w.Blanking ? 0 : 4).
function demoDigitsBlanking(w) {
  const d = demoDigits(w);
  const hideZeros = w.Blanking === 1 || w.Blanking === true;
  return hideZeros ? d.replace(/^0+(?=\d)/, '') : d;
}
// combine: test data + blanking (single entry point used everywhere)
function testString(w) { return demoDigitsBlanking(w); }
function digitalCount(w) {
  const maps = (w.BitmapList || '').split('|').filter(Boolean);
  if (!maps.length) return 0;
  return Math.min(w.Digits || 1, testString(w).length);
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

// safe accessor: returns a dummy slot when no project is open
function slot() { return project ? project.slots[slotIndex] : { widgets: [], images: [], rawActions: [] }; }
// ---------- project font (default for new digital/list layers) ----------
function updateProjFontSelect() {
  const sel = $('projFont');
  if (!sel) return;
  const cur = (project && project.font) || '';
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— none —';
  sel.appendChild(none);
  for (const fam of fontFamilies()) {
    const o = document.createElement('option'); o.value = fam; o.textContent = fam; sel.appendChild(o);
  }
  const imp = document.createElement('option'); imp.value = '__import'; imp.textContent = 'Import custom…'; sel.appendChild(imp);
  if (cur && ![...sel.options].some((o) => o.value === cur)) {
    const o = document.createElement('option'); o.value = cur; o.textContent = `${cur} (missing)`; sel.appendChild(o);
  }
  sel.value = cur;
}
$('projFont').onchange = async () => {
  const sel = $('projFont');
  if (sel.value === '__import') { fontImportTarget = -1; projFontImport = true; $('fileFont').click(); sel.value = (project && project.font) || ''; return; }
  if (!project) return;
  if (sel.value) project.font = sel.value; else delete project.font;
  pushHistory();
  if (sel.value) { await ensureFont(sel.value); $('meta').textContent = `Project font: ${sel.value}`; }
};
function closeProject() {
  project = null; slotIndex = 0; selected = -1;
  past = []; future = []; dirty = false; imgCache.clear();
  $('inpTitle').value = '';
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (const id of ['btnExport', 'btnCompile', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = true;
  updateHistoryButtons();
  $('meta').textContent = '';
  setEmptyState();
  refreshPanels();
}
$('btnCloseProject').onclick = () => {
  if (!project) return;
  if (dirty && !confirm('This project has unsaved changes. Close it anyway?')) return;
  closeProject();
};

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
  const label = slotName(i);
  const wasFace = i === 0;
  pushHistory();
  project.slots.splice(i, 1);
  project.slots.forEach((x, k) => { x.index = k; if (k === 0) x.role = 'face'; else if (!x.role || x.role === 'face') x.role = 'aod'; });
  slotIndex = Math.max(0, Math.min(slotIndex, project.slots.length - 1));
  selected = -1; imgCache.clear();
  refreshPanels(); render();
  const counts = `${s.widgets.length} layer(s), ${s.images.length} image(s)`;
  showUndoToast(`${label} removed (${counts})${wasFace ? ' — next slot is now the Face' : ''}`, undo);
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
let dirty = false; // project edited since load -> regenerate previews
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
  dirty = true;
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
  dirty = true;
}
function redo() {
  if (!project || !future.length) return;
  past.push(snap());
  restoreHistory(future.pop());
  dirty = true;
}

// ---------- undo toast (destructive actions: 10s to take it back) ----------
const TOAST_MS = 10000;
let toastEl = null, toastTimer = null, toastStart = 0, toastLeft = TOAST_MS;
function dismissToast() {
  clearTimeout(toastTimer); toastTimer = null;
  if (toastEl) { toastEl.remove(); toastEl = null; }
}
// Single toast at a time: it always undoes the most recent change.
function showUndoToast(message, onUndo, label = 'Undo') {
  dismissToast();
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = '<div class="tbar"></div>'
    + '<span class="tmsg"></span><span class="flex-1"></span>'
    + '<button class="tbtn"></button>'
    + '<button class="tclose" title="Dismiss"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  el.querySelector('.tmsg').textContent = message;
  const btn = el.querySelector('.tbtn');
  btn.textContent = label;
  btn.onclick = () => { dismissToast(); onUndo(); };
  el.querySelector('.tclose').onclick = dismissToast;
  // hover pauses the countdown (both bar and timer)
  toastLeft = TOAST_MS;
  const schedule = () => { toastStart = Date.now(); clearTimeout(toastTimer); toastTimer = setTimeout(dismissToast, toastLeft); };
  el.addEventListener('mouseenter', () => {
    toastLeft -= Date.now() - toastStart;
    clearTimeout(toastTimer);
    el.classList.add('paused');
  });
  el.addEventListener('mouseleave', () => { el.classList.remove('paused'); schedule(); });
  $('toastHost').appendChild(el);
  toastEl = el;
  schedule();
}

async function loadImage(name, url) {
  if (imgCache.has(name)) return imgCache.get(name);
  const img = new Image();
  img.src = url;
  await img.decode();
  imgCache.set(name, img);
  return img;
}
// Analog clock: demo pose + hand/pivot field mapping (mirrors core/packer.js)
function testTime() {
  return { h: parseInt(TEST_DATA.hour, 10) || 0, m: parseInt(TEST_DATA.minute, 10) || 0, s: parseInt(TEST_DATA.second, 10) || 0 };
}
const CLOCK_HANDS = [
  ['HourHandImage', 'HourImageRotateX', 'HourImageRotateY', 'hour'],
  ['MinuteHandImage', 'MinuteImageRotateX', 'MinuteImageRotateY', 'minute'],
  ['SecondHandImage', 'SecondImageRotateX', 'SecondImageRotateY', 'second'],
];
function CLOCK_ANGLE(t, which) {
  if (which === 'hour') return ((t.h % 12) + t.m / 60 + t.s / 3600) * 30;
  if (which === 'minute') return (t.m + t.s / 60) * 6;
  return t.s * 6;
}
function shapeName(s) {
  return s === 30 ? 'Image' : s === 31 ? 'ImageList' : s === 32 ? 'DigitalNum'
    : s === 27 ? 'AnalogClock' : s === 43 ? 'Gauge' : s === 34 ? 'Container' : `Shape${s}`;
}
const SVG = {
  img: '<path d="M3 5h18v14H3z" opacity="0"/><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m5 19 5-5 3 3 3-3 3 3"/>',
  grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="5" cy="18" r="1.2"/>',
  num: '<path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  gauge: '<path d="M12 5a8 8 0 0 1 8 8"/><path d="M12 5a8 8 0 0 0-8 8v1h3l1-2h8"/>',
  box: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/>',
  square: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M10.6 5.7A8.7 8.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.5 17.5 0 0 1-2.3 3.1M6.6 6.9C4 8.8 2.5 12 2.5 12S6 18.5 12 18.5c1.2 0 2.3-.2 3.3-.6"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
};
function shapeIcon(s) {
  const p = s === 30 ? SVG.img : s === 31 ? SVG.list : s === 32 ? SVG.num
    : s === 27 ? SVG.clock : s === 43 ? SVG.gauge : s === 34 ? SVG.box : SVG.square;
  return `<svg class="licon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
// ---------- reusable drag-to-reorder (delegated, attach once per container) ----------
function enableDragSort(container, opts) {
  if (container.dataset.sortReady) return;
  container.dataset.sortReady = '1';
  const { rowSel, handleSel } = opts;
  let from = -1;
  const rows = () => [...container.querySelectorAll(rowSel)];
  const clearMarks = () => rows().forEach((r) => r.classList.remove('drop-before', 'drop-after', 'dragging'));
  const idxOf = (el) => rows().indexOf(el.closest(rowSel));
  container.addEventListener('dragstart', (e) => {
    const h = e.target.closest(handleSel);
    if (!h) { e.preventDefault(); return; }
    const row = h.closest(rowSel);
    from = idxOf(row);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(from)); } catch (err) { /* ignore */ }
  });
  container.addEventListener('dragover', (e) => {
    if (from < 0) return;
    const row = e.target.closest(rowSel);
    if (!row || idxOf(row) === from) return;
    e.preventDefault();
    clearMarks();
    row.classList.add('dragging');
    const after = (e.clientY - row.getBoundingClientRect().top) > row.offsetHeight / 2;
    row.classList.remove('dragging');
    row.classList.add(after ? 'drop-after' : 'drop-before');
  });
  container.addEventListener('drop', (e) => {
    if (from < 0) return;
    const row = e.target.closest(rowSel);
    if (!row) return;
    e.preventDefault();
    const over = idxOf(row);
    const after = row.classList.contains('drop-after');
    clearMarks();
    let to = over + (after ? 1 : 0);
    if (to > from) to -= 1;
    const f = from; from = -1;
    if (to !== f && to >= 0) opts.onDrop(f, to);
  });
  container.addEventListener('dragend', () => { from = -1; clearMarks(); });
}

document.querySelectorAll('[data-panel]').forEach((p) => {
  p.querySelector('[data-panel-head]').addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // toolbar buttons stay clickable
    p.classList.toggle('collapsed');
  });
});
function hasTap(w) { return Boolean(w && (w._tap || w._action || /\[[^\]]+\]/.test(w.Name || ''))); }
function paintLayer(i) {
  const s = slot();
  const w = s.widgets[i];
  const d = document.querySelectorAll('#layers .layer')[i];
  if (!d || !w) return;
  const badge = w._group ? ` <span class="grp">G${String(w._group).replace(/^g/, '')}</span>` : '';
  d.className = 'layer'
    + (w._group ? ' ingroup' : '')
    + (w._group && collapsedGroups.has(w._group) ? ' gcollapsed' : '')
    + (i === selected ? ' sel' : (groupSel.has(i) ? ' multi' : ''))
    + (w._hidden ? ' hid' : '')
    + (w._locked ? ' locked' : '');
  d.innerHTML = `<span class="lname"><span class="grip" draggable="true" title="Drag to reorder"><svg viewBox="0 0 24 24" fill="currentColor">${SVG.grip}</svg></span>${shapeIcon(w.Shape)}<span class="nname">${w.Name || ''}${badge}${w._hidden ? ' <em>(hidden)</em>' : ''}${w._locked ? ' <em>(locked)</em>' : ''}</span></span>`
    + `<span class="lrow-r">`
    + `<button class="lb lock${w._locked ? ' on' : ''}" title="${w._locked ? 'Unlock layer' : 'Lock layer (no dragging)'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${w._locked ? SVG.lock : SVG.unlock}</svg></button>`
    + `<button class="lb eye" title="${w._hidden ? 'Show layer' : 'Hide layer'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${w._hidden ? SVG.eyeOff : SVG.eye}</svg></button>`
    + `<button class="lb trash" title="Delete layer"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SVG.trash}</svg></button>`
    + `</span>`;
  if (i === selected) updatePinfo();
  d.querySelector('.lock').onclick = (ev) => {
    ev.stopPropagation();
    pushHistory();
    w._locked = !w._locked;
    if (w._locked && drag && drag.primary === w) drag = null;
    paintLayer(i); render();
  };
  d.querySelector('.eye').onclick = (ev) => {
    ev.stopPropagation();
    pushHistory();
    w._hidden = !w._hidden;
    paintLayer(i); render();
  };
  d.querySelector('.trash').onclick = (ev) => {
    ev.stopPropagation();
    pushHistory();
    const gone = s.widgets[i];
    s.widgets.splice(i, 1);
    if (selected === i) selected = -1;
    else if (selected > i) selected -= 1;
    refreshPanels(); render();
    showUndoToast(`Layer "${gone.Name || ''}" deleted`, undo);
  };
  d.onclick = (ev) => {
    if (ev.ctrlKey || ev.metaKey) {
      // multi-select for grouping
      if (groupSel.has(i)) groupSel.delete(i); else groupSel.add(i);
      selected = i;
      refreshPanels(); render();
      return;
    }
    // clicking inside an already-selected group keeps the whole group selected
    if (w._group && groupSel.size > 1 && groupSel.has(i)) {
      selected = i; refreshPanels(); render();
      return;
    }
    selected = i; groupSel = new Set([i]); refreshPanels(); render();
  };
}
// Tap targets known by the RW4 action packer (core/packer.js RW4_ACTIONS).
// Apps with byte-verified stock tap-ZONE templates (non-image layers).
const ZONE_TAP_APPS = ['alarm', 'timer', 'music', 'flashlight', 'steps', 'calories', 'hrm', 'spo2', 'weather'];
const TAP_APPS = ['steps', 'calories', 'standing', 'moving', 'hrm', 'spo2', 'stress', 'sleep', 'weather', 'alarm', 'timer', 'stopwatch', 'cards', 'music', 'compass', 'scheduler', 'flashlight', 'photo', 'findphone', 'breath', 'contact', 'egg', 'todo', 'tomato', 'worldclock', 'phone', 'voice', 'mihome', 'women', 'pressure', 'vitality', 'settings', 'launcher', 'wechat', 'alipay', 'checktool', 'calendar'];

// Bundled OFL digit fonts (assets/fonts, all verified to contain 0-9).
// Names are the FontFace families we register, so they can be friendlier than
// the fonts' internal names.
const BUNDLED_FONTS = [
  // first batch: techy display faces
  { family: 'Orbitron', file: 'assets/fonts/Orbitron-Bold.ttf' },
  { family: 'Oswald', file: 'assets/fonts/Oswald-SemiBold.ttf' },
  { family: 'Bebas Neue', file: 'assets/fonts/BebasNeue-Regular.ttf' },
  { family: 'Share Tech Mono', file: 'assets/fonts/ShareTechMono-Regular.ttf' },
  { family: 'Roboto Condensed', file: 'assets/fonts/RobotoCondensed-Bold.ttf' },
  // most-used faces (excellent for watch digits)
  { family: 'Inter', file: 'assets/fonts/Inter-Bold.ttf' },
  { family: 'Open Sans', file: 'assets/fonts/OpenSans-Bold.ttf' },
  { family: 'Lato', file: 'assets/fonts/Lato-Bold.ttf' },
  { family: 'Montserrat', file: 'assets/fonts/Montserrat-Bold.ttf' },
  { family: 'Roboto Mono', file: 'assets/fonts/RobotoMono-Bold.ttf' },
  { family: 'Barlow Condensed', file: 'assets/fonts/BarlowCondensed-SemiBold.ttf' },
  { family: 'Anton', file: 'assets/fonts/Anton-Regular.ttf' },
  { family: 'Rajdhani', file: 'assets/fonts/Rajdhani-SemiBold.ttf' },
  { family: 'Teko', file: 'assets/fonts/Teko-SemiBold.ttf' },
  // segmented / matrix / pixel clock faces
  { family: 'Doto', file: 'assets/fonts/Doto-Black.ttf' },
  { family: 'Handjet', file: 'assets/fonts/Handjet-Bold.ttf' },
  { family: 'Silkscreen', file: 'assets/fonts/Silkscreen-Regular.ttf' },
];
// variable-font instances we want (Handjet's element grid/shape make the
// segmented look); applied while measuring and drawing glyphs
const FONT_VARIATIONS = {
  'Handjet': "'wght' 700, 'ELGR' 1, 'ELSH' 6",
};
function setFontOn(ctx, family, size) {
  ctx.font = `${size}px "${family}"`;
  if (FONT_VARIATIONS[family]) ctx.fontVariationSettings = FONT_VARIATIONS[family];
}
const customFonts = []; // {family, buf?, url?, fileName?}
async function ensureFont(family) {
  if ([...document.fonts].some((f) => f.family === family)) return true;
  const b = BUNDLED_FONTS.find((x) => x.family === family);
  const c = customFonts.find((x) => x.family === family);
  const src = b ? `url("${b.file}")` : c ? (c.buf || (c.url ? `url("${c.url}")` : null)) : null;
  if (!src) return false;
  const ff = new FontFace(family, src);
  await ff.load();
  document.fonts.add(ff);
  await document.fonts.ready;
  return true;
}
function fontFamilies() { return [...BUNDLED_FONTS.map((f) => f.family), ...customFonts.map((f) => f.family)]; }
function bufToBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
// families actually used by widgets in this project (bundled or custom)
function usedCustomFonts() {
  const used = new Set();
  for (const s of project.slots) for (const w of s.widgets) if (w._font && w._font.family) used.add(w._font.family);
  return customFonts.filter((f) => used.has(f.family) && f.buf)
    .map((f) => ({ family: f.family, fileName: f.fileName || `${f.family}.ttf`, dataBase64: bufToBase64(f.buf) }));
}
function widgetBitmaps(w) {
  if (w.Shape === 30) return w.Bitmap ? [w.Bitmap] : [];
  const list = (w.BitmapList || '').split('|').map(x => x.includes(':') ? x.split(':')[1] : x).filter(Boolean);
  if (w.Shape === 27) return [w.BackgroundImage, w.HourHandImage, w.MinuteHandImage, w.SecondHandImage].filter(Boolean);
  if (w.Shape === 43) return w.PointerImage ? [w.PointerImage] : [];
  return list.slice(0, 4);
}
// ---------- grid, center cues & snapping ----------
let showGrid = true; // grid + snapping on by default
let exportRender = false; // true while composing a preview (no editor overlays)
let guides = { v: [], h: [] };       // active snap guide coordinates (device px)
const GRID_PX = 20;                   // grid pitch in device px
const SNAP_PX = 4;                    // snap threshold in device px
function gridTargets() {
  const W = project.screenW || 1, H = project.screenH || 1;
  const xs = [], ys = [];
  for (let x = GRID_PX; x < W; x += GRID_PX) xs.push(x);
  for (let y = GRID_PX; y < H; y += GRID_PX) ys.push(y);
  return { xs, ys };
}
// candidate align lines from the other visible widgets (edges + centers)
function alignTargets(excludeIdx) {
  const s = slot();
  const xs = [], ys = [];
  s.widgets.forEach((o, i) => {
    if (i === excludeIdx || o._hidden || o.Alpha === 0) return;
    const b = visualBox(o);
    xs.push(b.x, b.x + b.w / 2, b.x + b.w);
    ys.push(b.y, b.y + b.h / 2, b.y + b.h);
  });
  return { xs, ys };
}
// snap one axis: compares the moving box's left/center/right against targets
function snapAxis(value, size, targets, snapTo) {
  const refs = [value, value + size / 2, value + size];
  let best = null;
  for (const t of targets) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(refs[k] - t);
      if (d <= SNAP_PX && (!best || d < best.d)) best = { d, delta: t - refs[k], at: t, edge: k, snapTo };
    }
  }
  return best;
}
function snapMove(w, x, y, idx) {
  const vb = visualBox(w);
  const W = project.screenW || 1, H = project.screenH || 1;
  const cx = W / 2, cy = H / 2;
  const al = alignTargets(idx), gr = gridTargets();
  // alignment targets win ties over the grid (they are explicit relationships)
  const bx = snapAxis(x, vb.w, [...al.xs, cx], 'align') || snapAxis(x, vb.w, gr.xs, 'grid');
  const by = snapAxis(y, vb.h, [...al.ys, cy], 'align') || snapAxis(y, vb.h, gr.ys, 'grid');
  const v = [], h = [];
  let nx = x, ny = y;
  if (bx) { nx = Math.round(x + bx.delta); if (bx.snapTo === 'align' || bx.at === cx) v.push(bx.at); }
  if (by) { ny = Math.round(y + by.delta); if (by.snapTo === 'align' || by.at === cy) h.push(by.at); }
  // center cues stay visible while dragging near them
  if (!v.length) for (const k of [0, 1, 2]) if (Math.abs(x + [0, vb.w / 2, vb.w][k] - cx) <= 1) v.push(cx);
  if (!h.length) for (const k of [0, 1, 2]) if (Math.abs(y + [0, vb.h / 2, vb.h][k] - cy) <= 1) h.push(cy);
  guides = { v, h };
  return { x: nx, y: ny };
}
function drawGuides(scale) {
  if (!showGrid && !guides.v.length && !guides.h.length) return;
  const W = project.screenW || 1, H = project.screenH || 1;
  const cw = cv.width, ch = cv.height;
  if (showGrid) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    for (let x = GRID_PX; x < W; x += GRID_PX) { const px = Math.round(x * scale) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, ch); }
    for (let y = GRID_PX; y < H; y += GRID_PX) { const py = Math.round(y * scale) + 0.5; ctx.moveTo(0, py); ctx.lineTo(cw, py); }
    ctx.stroke();
    // every 4th line slightly stronger
    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.beginPath();
    for (let x = GRID_PX * 4; x < W; x += GRID_PX * 4) { const px = Math.round(x * scale) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, ch); }
    for (let y = GRID_PX * 4; y < H; y += GRID_PX * 4) { const py = Math.round(y * scale) + 0.5; ctx.moveTo(0, py); ctx.lineTo(cw, py); }
    ctx.stroke();
    // center cues
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = 'rgba(91,140,255,0.45)';
    ctx.beginPath();
    const cx = Math.round((W / 2) * scale) + 0.5, cy = Math.round((H / 2) * scale) + 0.5;
    ctx.moveTo(cx, 0); ctx.lineTo(cx, ch);
    ctx.moveTo(0, cy); ctx.lineTo(cw, cy);
    ctx.stroke();
    ctx.restore();
  }
  if (guides.v.length || guides.h.length) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,120,220,0.95)';
    ctx.beginPath();
    for (const x of guides.v) { const px = Math.round(x * scale) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, ch); }
    for (const y of guides.h) { const py = Math.round(y * scale) + 0.5; ctx.moveTo(0, py); ctx.lineTo(cw, py); }
    ctx.stroke();
    ctx.restore();
  }
}
$('btnGrid').classList.toggle('on', showGrid);
$('btnGrid').onclick = () => {
  showGrid = !showGrid;
  $('btnGrid').classList.toggle('on', showGrid);
  if (!showGrid) guides = { v: [], h: [] };
  if (project) render();
};

// ---------- Images (BitmapList) dialog ----------
// entries: { value: number|null, name }
function listEntries(w) {
  if (w.Shape === 30) return w.Bitmap ? [{ value: null, name: w.Bitmap }] : [];
  return String(w.BitmapList || '').split('|').map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^\(([^)]*)\):([\s\S]*)$/.exec(x);
    if (m) return { value: m[1] === '' ? null : parseInt(m[1], 10), name: m[2] };
    return { value: null, name: x };
  });
}
let ilmState = null; // { widget, entries }
function ilmRender() {
  const list = $('ilmList');
  const s = slot();
  const urlByName = new Map(s.images.map((i) => [i.name, i.url]));
  list.innerHTML = '';
  ilmState.entries.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'ilm-row';
    const grip = document.createElement('span');
    grip.className = 'grip'; grip.draggable = true; grip.title = 'Drag to reorder';
    grip.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor">${SVG.grip}</svg>`;
    row.appendChild(grip);
    const idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = String(i);
    row.appendChild(idx);
    const img = document.createElement('img');
    img.src = urlByName.get(e.name) || '';
    img.alt = '';
    if (!urlByName.has(e.name)) img.title = 'image not in project';
    row.appendChild(img);
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = e.name;
    if (!urlByName.has(e.name)) nm.style.color = '#ff9d9d';
    row.appendChild(nm);
    if (ilmState.widget.Shape === 31) {
      const val = document.createElement('input');
      val.type = 'number'; val.className = 'val'; val.title = 'Custom value (empty = index)';
      val.value = e.value == null ? '' : String(e.value);
      val.placeholder = String(i);
      val.oninput = () => { e.value = val.value === '' ? null : (parseInt(val.value, 10) || 0); };
      row.appendChild(val);
    }
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕'; rm.title = 'Remove from list';
    rm.onclick = () => { ilmState.entries.splice(i, 1); ilmRender(); };
    row.appendChild(rm);
    list.appendChild(row);
  });
  $('ilmCount').textContent = `(${ilmState.entries.length})`;
  // picker of project images not already in the list
  const used = new Set(ilmState.entries.map((e) => e.name));
  const pick = $('ilmPick');
  pick.innerHTML = '';
  const avail = s.images.map((i) => i.name).filter((n) => !used.has(n));
  for (const n of avail) {
    const o = document.createElement('option'); o.value = n; o.textContent = n; pick.appendChild(o);
  }
  const single = ilmState.widget.Shape === 30;
  if (single && ilmState.entries.length) {
    // an image layer shows exactly one image: replace via the row's ✕ then Add
    $('ilmPick').disabled = true;
    $('ilmAdd').disabled = true;
    $('ilmUploadBtn').textContent = 'Replace…';
  } else {
    pick.disabled = !avail.length;
    $('ilmAdd').disabled = !avail.length;
    $('ilmUploadBtn').textContent = 'Upload…';
  }
}
function openImgListDialog(w) {
  ilmState = { widget: w, entries: listEntries(w) };
  ilmRender();
  enableDragSort($('ilmList'), {
    rowSel: '.ilm-row', handleSel: '.grip',
    onDrop: (from, to) => {
      const [e] = ilmState.entries.splice(from, 1);
      ilmState.entries.splice(to, 0, e);
      ilmRender();
    },
  });
  $('imgListModal').hidden = false;
}
$('ilmCancel').onclick = () => { $('imgListModal').hidden = true; ilmState = null; };
$('ilmAdd').onclick = () => {
  const n = $('ilmPick').value;
  if (!n) return;
  if (ilmState.widget.Shape === 30) ilmState.entries = [{ value: null, name: n }];
  else ilmState.entries.push({ value: null, name: n });
  ilmRender();
};
$('ilmUploadBtn').onclick = () => $('ilmUpload').click();
$('ilmUpload').onchange = async () => {
  const s = slot();
  const taken = new Set(s.images.map((im) => im.name));
  for (const file of $('ilmUpload').files) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const img = new Image(); img.src = url;
    try { await img.decode(); } catch (e) { continue; }
    const name = uniqName(file.name, taken); taken.add(name);
    imgCache.delete(name);
    s.images.push({ name, width: img.naturalWidth, height: img.naturalHeight, url });
    if (ilmState.widget.Shape === 30) ilmState.entries = [{ value: null, name }];
    else ilmState.entries.push({ value: null, name });
  }
  $('ilmUpload').value = '';
  ilmRender();
};
$('ilmSave').onclick = () => {
  const w = ilmState.widget;
  if (w.Shape === 30) {
    w.Bitmap = ilmState.entries.length ? ilmState.entries[0].name : '';
  } else {
    const custom = ilmState.entries.some((e, i) => e.value != null && e.value !== i);
    w.BitmapList = ilmState.entries.map((e, i) => (custom ? `(${e.value == null ? i : e.value}):${e.name}` : e.name)).join('|');
  }
  $('imgListModal').hidden = true;
  ilmState = null;
  pushHistory();
  refreshPanels(); render();
};
$('imgListModal').addEventListener('mousedown', (e) => { if (e.target === $('imgListModal')) { $('imgListModal').hidden = true; ilmState = null; } });

// ---------- device masks ----------
// assets/masks/<type>.svg clips the preview to the display outline; masks.json
// (generated by tools/gen-masks.js) carries the frame radius per device.
let maskMeta = null;
let showMask = true;
async function loadMaskMeta() {
  if (maskMeta) return maskMeta;
  try {
    const r = await fetch('assets/masks/masks.json');
    maskMeta = await r.json();
  } catch (e) { maskMeta = {}; }
  return maskMeta;
}
function applyDeviceMask() {
  const dev = document.getElementById('cvDevice');
  const m = maskMeta && maskMeta[project.watchType];
  if (!showMask || !m) {
    cv.style.webkitMaskImage = cv.style.maskImage = 'none';
    dev.classList.add('square');
    return;
  }
  const url = `url("assets/masks/${project.watchType}.svg")`;
  cv.style.webkitMaskImage = url; cv.style.maskImage = url;
  cv.style.webkitMaskSize = cv.style.maskSize = '100% 100%';
  cv.style.webkitMaskRepeat = cv.style.maskRepeat = 'no-repeat';
  // bezel radius follows the canvas scale so the frame matches the clip
  const scale = cv.width / (m.w || cv.width);
  dev.classList.toggle('square', m.kind !== 'circle' && Math.round(m.radius * scale) < 20);
  dev.style.borderRadius = `${Math.round(m.radius * scale)}px`;
}
$('btnMask').classList.toggle('on', showMask);
$('btnMask').onclick = () => {
  showMask = !showMask;
  $('btnMask').classList.toggle('on', showMask);
  if (project) { applyDeviceMask(); render(); }
};

// ---------- empty state (no project) ----------
function setEmptyState() {
  const empty = !project;
  document.querySelector('main').classList.toggle('empty', empty);
  $('emptyState').hidden = !empty;
  if (empty) renderRecents();
}
// ---------- recent projects (under the empty-state buttons) ----------
async function renderRecents() {
  const wrap = $('recentWrap'), list = $('recentList');
  if (!wrap) return;
  if (project) { wrap.hidden = true; return; } // only in the empty state
  let items = [];
  try { items = (await window.api.recentList()) || []; } catch (e) { items = []; }
  list.innerHTML = '';
  wrap.hidden = !items.length;
  for (const r of items) {
    const d = document.createElement('div');
    d.className = 'recent-item' + (r.exists ? '' : ' missing');
    d.title = r.path;
    const dev = SUPPORTED_DEVICES.find((x) => x.type === r.device);
    const main = document.createElement('div');
    main.className = 'ri-main';
    const nm = document.createElement('div');
    nm.className = 'ri-name';
    nm.textContent = r.name || r.path.split('/').pop();
    const pth = document.createElement('div');
    pth.className = 'ri-path';
    pth.textContent = (dev ? dev.name + ' · ' : '') + r.path + (r.exists ? '' : ' · missing');
    main.appendChild(nm); main.appendChild(pth);
    d.appendChild(main);
    const open = document.createElement('button');
    open.className = 'icon-only';
    open.textContent = r.exists ? 'Open' : '—';
    open.disabled = !r.exists;
    open.onclick = async (ev) => {
      ev.stopPropagation();
      const res = await window.api.openProjectPath(r.path);
      if (res && res.error) { $('meta').textContent = res.error; return; }
      if (res) loadProject(res);
    };
    d.appendChild(open);
    if (r.exists) d.onclick = () => open.onclick(new Event('click'));
    list.appendChild(d);
  }
}
$('btnEmptyNew').onclick = () => openNewFaceDialog();
$('btnEmptyOpenProject').onclick = () => $('btnOpenProject').click();
$('btnEmptyImport').onclick = () => $('btnOpen').click();

async function render() {
  if (!project) return;
  const W = project.screenW || 240, H = project.screenH || 280;
  const scale = Math.min(560 / W, 560 / H, 2);
  cv.width = Math.round(W * scale); cv.height = Math.round(H * scale);
  applyDeviceMask();
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
        const entries = listEntries(w);
        if (!entries.length) continue;
        // Value-mapped lists (e.g. battery/steps % as (0):0% | (10):10% | …):
        // choose the frame whose custom value is the largest one <= the value.
        let pickIdx = Math.min(w.DefaultIndex || 0, entries.length - 1);
        const pairs = entries.map((en, i) => [en.value == null ? null : en.value, i]).filter(([v]) => v != null);
        const val = testNumeric(w.DataSrcIndex);
        if (pairs.length && val != null) {
          pairs.sort((a, b) => a[0] - b[0]);
          pickIdx = pairs[0][1];
          for (const [v, i] of pairs) { if (val >= v) pickIdx = i; else break; }
        }
        const nm = entries[pickIdx].name;
        if (!urlByName.has(nm)) continue;
        const img = await loadImage(nm, urlByName.get(nm));
        ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, (w.Width || img.naturalWidth) * scale, (w.Height || img.naturalHeight) * scale);
      } else if (w.Shape === 32) {
        const maps = (w.BitmapList || '').split('|').filter(Boolean);
        if (!maps.length) continue;
        let demo = testString(w);
        let x = (w.X || 0) * scale;
        const y = (w.Y || 0) * scale, dw = (w.Width || 20) * scale, dh = (w.Height || 30) * scale;
        const gap = effSpacing(w) * scale;
        // negative values: a stock digit list carries the minus as frame 10, so
        // keep the '-' for the loop below. Only when the list has no sign frame
        // do we fall back to drawing the font's minus glyph (an authored sign
        // layer, if present, already covers it).
        const hasSignFrame = maps.length > SIGN_FRAME;
        if (!hasSignFrame && demo.startsWith('-')) {
          demo = demo.replace(/^-+/, '');
          const fam = w._font && w._font.family;
          const layerSign = s.widgets.some((o) => o !== w && !o._hidden && /(^|:)minus$/.test(String(o._preset || '')) && o.Bitmap);
          if (!layerSign && fam) {
            const signIm = s.images.find((im) => im.name.startsWith(`font_${String(fam).replace(/[^\w]+/g, '-')}_`) && /_minus\.png$/.test(im.name));
            if (signIm) {
              const si = await loadImage(signIm.name, signIm.url);
              ctx.drawImage(si, x, y + Math.max(0, (w.Height || 0) * scale - signIm.height * scale) / 2, signIm.width * scale, signIm.height * scale);
              x += (signIm.width + (effSpacing(w) || 0)) * scale;
            }
          }
        }
        const n = Math.min(w.Digits || 1, demo.length);
        for (let i = 0; i < n; i++) {
          const ch = demo[i];
          const d = parseInt(ch, 10);
          // negative values: frame 10 is the minus sign on stock faces
          const nm = Number.isNaN(d)
            ? (ch === '-' && maps.length > SIGN_FRAME ? maps[SIGN_FRAME] : null)
            : maps[Math.min(d, maps.length - 1)];
          if (!nm || !urlByName.has(nm)) continue;
          const img = await loadImage(nm, urlByName.get(nm));
          ctx.drawImage(img, x, y, dw, dh);
          x += dw + gap;
        }
      } else if (w.Shape === 27) {
        // clock centre = widget box centre; each hand rotates about its pivot,
        // which is placed exactly on that centre (same geometry the packer writes)
        const cx = ((w.X || 0) + (w.Width || 0) / 2) * scale;
        const cy = ((w.Y || 0) + (w.Height || 0) / 2) * scale;
        if (w.BackgroundImage && urlByName.has(w.BackgroundImage)) {
          const bg = await loadImage(w.BackgroundImage, urlByName.get(w.BackgroundImage));
          ctx.drawImage(bg, cx - (bg.naturalWidth * scale) / 2, cy - (bg.naturalHeight * scale) / 2,
            bg.naturalWidth * scale, bg.naturalHeight * scale);
        }
        const t = testTime();
        for (const [imgKey, pxKey, pyKey, deg] of CLOCK_HANDS) {
          if (!w[imgKey] || !urlByName.has(w[imgKey])) continue;
          const img = await loadImage(w[imgKey], urlByName.get(w[imgKey]));
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(CLOCK_ANGLE(t, deg) * Math.PI / 180);
          ctx.drawImage(img, -(w[pxKey] || 0) * scale, -(w[pyKey] || 0) * scale,
            img.naturalWidth * scale, img.naturalHeight * scale);
          ctx.restore();
        }
      } else if (w.Shape === 43 && w.PointerImage && urlByName.has(w.PointerImage)) {
        const img = await loadImage(w.PointerImage, urlByName.get(w.PointerImage));
        ctx.drawImage(img, (w.X || 0) * scale, (w.Y || 0) * scale, (w.Width || img.naturalWidth) * scale, (w.Height || img.naturalHeight) * scale);
      }
    } catch (e) { /* missing img */ }
    if (vi === selected && !exportRender) {
      const vb = visualBox(s.widgets[vi]);
      ctx.strokeStyle = '#2f6feb'; ctx.lineWidth = 2;
      ctx.strokeRect(vb.x * scale, vb.y * scale, Math.max(vb.w * scale, 8), Math.max(vb.h * scale, 8));
    }
  }
  if (exportRender) return; // grid, guides and tap markers are editor-only
  drawGuides(scale);
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
  if (!project) { setEmptyState(); return; }
  const s = slot();
  $('wcount').textContent = `(${s.widgets.length})`;
  $('icount').textContent = `(${s.images.length})`;
  $('screenInfo').textContent = `v${project.version} · ${project.watchName} · ${project.screenW}×${project.screenH} · ${slotName(slotIndex)}`;
  updateProjFontSelect();
  renderTestDataPanel();
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
    b.onclick = () => { slotIndex = i; selected = -1; groupSel.clear(); imgCache.clear(); refreshPanels(); render(); };
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
  const seenGroups = new Set();
  s.widgets.forEach((w, i) => {
    if (w._group && !seenGroups.has(w._group)) {
      seenGroups.add(w._group);
      const members = s.widgets.filter((x) => x._group === w._group);
      const collapsed = collapsedGroups.has(w._group);
      const head = document.createElement('div');
      head.className = 'group-row' + (collapsed ? ' collapsed' : '');
      head.innerHTML = `<span class="gchev">\u25be</span>`
        + `<input class="gname" value="${escAttr(groupName(w._group))}" title="Group name" />`
        + `<span class="gcount">${members.length} layer${members.length > 1 ? 's' : ''}</span>`
        + `<span class="flex-1"></span>`
        + `<button class="lb gsel" title="Select the whole group">\u25c9</button>`
        + `<button class="lb gungroup" title="Ungroup">\u2921</button>`;
      const selectGroup = () => {
        groupSel = new Set(s.widgets.map((x, k) => (x._group === w._group ? k : -1)).filter((k) => k >= 0));
        selected = groupSel.size ? [...groupSel][0] : -1;
        refreshPanels(); render();
      };
      // clicking the header (name, count, empty space) selects the whole group
      head.querySelector('.gname').onclick = (ev) => ev.stopPropagation();
      head.querySelector('.gname').onchange = (ev) => {
        const v = ev.target.value.trim();
        pushHistory();
        if (v) groupNames[w._group] = v; else delete groupNames[w._group];
      };
      head.querySelector('.gchev').onclick = (ev) => {
        ev.stopPropagation();
        if (collapsedGroups.has(w._group)) collapsedGroups.delete(w._group); else collapsedGroups.add(w._group);
        refreshPanels();
      };
      head.querySelector('.gcount').onclick = selectGroup;
      head.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.classList.contains('gname') || ev.target.classList.contains('gchev')) return;
        selectGroup();
      });
      head.querySelector('.gsel').onclick = (ev) => { ev.stopPropagation(); selectGroup(); };
      head.querySelector('.gungroup').onclick = (ev) => {
        ev.stopPropagation();
        groupSel = new Set(s.widgets.map((x, k) => (x._group === w._group ? k : -1)).filter((k) => k >= 0));
        ungroupSelection();
      };
      L.appendChild(head);
    }
    const d = document.createElement('div');
    const inGroup = Boolean(w._group);
    d.className = 'layer' + (inGroup ? ' ingroup' : '') + (i === selected ? ' sel' : '') + (w._hidden ? ' hid' : '');
    if (inGroup && collapsedGroups.has(w._group)) d.classList.add('gcollapsed');
    d.dataset.wi = String(i);
    L.appendChild(d); paintLayer(i);
  });
  if ((s.rawActions || []).length) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = `${s.rawActions.length} tap zone(s) from file (⚡ markers, preserved on compile)`;
    L.appendChild(t);
  }
  enableDragSort(L, {
    rowSel: '.layer', handleSel: '.grip',
    onDrop: (from, to) => {
      const ss = slot();
      if (from === to) return;
      pushHistory();
      const [w2] = ss.widgets.splice(from, 1);
      ss.widgets.splice(to, 0, w2);
      selected = to;
      refreshPanels(); render();
    },
  });
  // images
  const G = $('images'); G.innerHTML = '';
  const usedNames = usedImageNames(s);
  for (const im of s.images.slice(0, 400)) {
    const unused = !usedNames.has(im.name);
    const d = document.createElement('div');
    d.className = 'img' + (unused ? ' unused' : '');
    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '✕'; del.title = `Delete ${im.name}`;
    del.onclick = (ev) => { ev.stopPropagation(); deleteImage(im.name); };
    d.appendChild(del);
    const img = document.createElement('img');
    img.loading = 'lazy'; img.src = im.url; img.title = im.name;
    d.appendChild(img);
    const cap = document.createElement('div');
    cap.textContent = `${im.name} ${im.width}×${im.height}`;
    if (unused) { const t = document.createElement('span'); t.className = 'unused-tag'; t.textContent = 'unused'; cap.appendChild(t); }
    d.appendChild(cap);
    G.appendChild(d);
  }
  updatePruneButton();
  // props
  const P = $('props'); P.innerHTML = '';
  if (selected < 0 || !s.widgets[selected]) { P.innerHTML = '<p class="muted">Select a layer.</p>'; return; }
  const w = s.widgets[selected];
  const PROP_LABELS = { Name: 'Name', X: 'X', Y: 'Y', Width: 'Width', Height: 'Height', Alpha: 'Alpha', Bitmap: 'Image', DataSrcValue: 'Shows', DataSrcIndex: 'Shows', Digits: 'Digits', Alignment: 'Alignment', Spacing: 'Spacing', Blanking: 'Hide leading zeros' };
  const fields = [['Name', 'text'], ['X', 'number'], ['Y', 'number'], ['Width', 'number'], ['Height', 'number'], ['Alpha', 'number'], ['DataSrcValue', 'text'], ['DataSrcIndex', 'text'], ['Digits', 'number'], ['Alignment', 'number'], ['Spacing', 'number'], ['Blanking', 'number']];
  // read-only summary (moved out of the layer rows)
  const info = document.createElement('div');
  info.className = 'pinfo';
  info.innerHTML = '<div class="k">Type</div><div class="v" id="pinfoType"></div>'
    + '<div class="k">Position</div><div class="v" id="pinfoPos"></div>'
    + '<div class="k">Size</div><div class="v" id="pinfoSize"></div>'
    + '<div class="k">Source</div><div class="v" id="pinfoSrc"></div>'
    + '<div class="k">Tap</div><div class="v" id="pinfoTap"></div>';
  const grid = document.createElement('div');
  // group editing: font + bulk actions for a multi-selection
  const selIdx = [...groupSel].filter((i) => s.widgets[i]);
  if (selIdx.length > 1) {
    const gb = document.createElement('div');
    gb.className = 'group-box';
    const head = document.createElement('div');
    head.className = 'gb-head';
    const gid = s.widgets[selIdx[0]]._group;
    head.textContent = gid ? `${groupName(gid)} \u00b7 ${selIdx.length} layers` : `${selIdx.length} layers selected`;
    gb.appendChild(head);
    const withFont = selIdx.filter((i) => s.widgets[i]._font || s.widgets[i].Shape === 30 || s.widgets[i].Shape === 31 || s.widgets[i].Shape === 32);
    const first = withFont.length ? s.widgets[withFont[0]] : s.widgets[selIdx[0]];
    const cur = (first._font && first._font.family) || project.font || '';
    const frow = mkRow('Font');
    const fsel = document.createElement('select');
    for (const fam of fontFamilies()) {
      const o = document.createElement('option'); o.value = fam; o.textContent = fam; fsel.appendChild(o);
    }
    fsel.value = [...fsel.options].some((o) => o.value === cur) ? cur : '';
    frow.appendChild(fsel);
    gb.appendChild(frow);
    const srow = document.createElement('div'); srow.className = 'row rowcontrols';
    const sizeInp = document.createElement('input');
    sizeInp.type = 'number'; sizeInp.title = 'Font size (px)';
    sizeInp.value = (first._font && first._font.size) || PRESET_SIZE;
    const colInp = document.createElement('input');
    colInp.type = 'color'; colInp.title = 'Colour';
    colInp.value = (first._font && first._font.color) || '#ffffff';
    const mkCheck = (key, title) => {
      const l = document.createElement('label'); l.className = 'small'; l.title = title;
      const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!(first._font && first._font[key]);
      l.appendChild(c); l.appendChild(document.createTextNode(' ' + key[0].toUpperCase()));
      return { l, c };
    };
    const bC = mkCheck('bold', 'Faux bold'), iC = mkCheck('italic', 'Faux italic');
    const apply = document.createElement('button');
    apply.className = 'grow-btn'; apply.textContent = 'Apply to group';
    apply.title = 'Set this font/size/colour on every selected layer and regenerate its glyphs';
    apply.onclick = async () => {
      const ids = [...groupSel].filter((i) => s.widgets[i]);
      const keepSel = selected;                 // regeneration rebuilds the panels
      const keepGroup = new Set(groupSel);
      pushHistory();
      for (const i of ids) {
        const w2 = s.widgets[i];
        if (!(w2.Shape === 30 || w2.Shape === 31 || w2.Shape === 32)) continue;
        w2._font = w2._font || {};
        if (fsel.value) w2._font.family = fsel.value;
        w2._font.size = parseInt(sizeInp.value, 10) || PRESET_SIZE;
        w2._font.color = colInp.value;
        w2._font.bold = bC.c.checked;
        w2._font.italic = iC.c.checked;
        await regenerateWidgetGlyphs(w2, s);
      }
      const touched = new Set(selIdx.map((i) => s.widgets[i] && s.widgets[i]._group).filter(Boolean));
      for (const g of touched) relayoutPresetGroup(g);
      // keep the selection so the group stays selected for further tweaking
      groupSel = new Set([...keepGroup].filter((i) => s.widgets[i]));
      selected = s.widgets[keepSel] ? keepSel : (groupSel.size ? [...groupSel][0] : keepSel);
      refreshPanels(); render();
      $('meta').textContent = `Font applied to ${ids.length} layers.`;
    };
    srow.appendChild(sizeInp); srow.appendChild(colInp); srow.appendChild(bC.l); srow.appendChild(iC.l); srow.appendChild(apply);
    gb.appendChild(srow);
    const arow = document.createElement('div'); arow.className = 'row rowcontrols';
    const ungroup = document.createElement('button'); ungroup.textContent = 'Ungroup';
    ungroup.onclick = () => ungroupSelection();
    const lockAll = document.createElement('button'); lockAll.textContent = 'Lock all';
    lockAll.onclick = () => {
      pushHistory();
      for (const i of selIdx) s.widgets[i]._locked = true;
      refreshPanels(); render();
    };
    const unlockAll = document.createElement('button'); unlockAll.textContent = 'Unlock all';
    unlockAll.onclick = () => {
      pushHistory();
      for (const i of selIdx) delete s.widgets[i]._locked;
      refreshPanels(); render();
    };
    arow.appendChild(ungroup); arow.appendChild(lockAll); arow.appendChild(unlockAll);
    gb.appendChild(arow);
    grid.appendChild(gb);
  }

  if (w.Shape === 27) {
    const s = slot();
    const imgRow = (labelText, key, title) => {
      const row = mkRow(labelText, title);
      const sel = document.createElement('select');
      const none = document.createElement('option');
      none.value = ''; none.textContent = '\u2014 none \u2014';
      sel.appendChild(none);
      for (const im of s.images) {
        const o = document.createElement('option'); o.value = im.name; o.textContent = im.name; sel.appendChild(o);
      }
      if (w[key] && !s.images.some((im) => im.name === w[key])) {
        const o = document.createElement('option'); o.value = w[key]; o.textContent = `${w[key]} (missing)`; sel.appendChild(o);
      }
      sel.value = w[key] || '';
      sel.onchange = () => {
        w[key] = sel.value;
        const hand = CLOCK_HANDS.find((h) => h[0] === key);
        if (hand && sel.value) {
          // first pick: pivot at the image centre so the hand spins about itself
          if (!w[hand[1]] && !w[hand[2]]) {
            const im = s.images.find((x) => x.name === sel.value);
            if (im) { w[hand[1]] = Math.round(im.width / 2); w[hand[2]] = Math.round(im.height / 2); }
          }
        }
        pushHistory();
        refreshPanels(); render();
      };
      row.appendChild(sel);
      return row;
    };
    grid.appendChild(imgRow('Background', 'BackgroundImage', 'Optional dial image, centred on the clock'));
    for (const [imgKey, pxKey, pyKey] of CLOCK_HANDS) {
      const name = imgKey.replace('HandImage', '').replace('Image', '');
      grid.appendChild(imgRow(`${name} hand`, imgKey, 'Hand image; it rotates about its pivot'));
      const prow = document.createElement('div');
      prow.className = 'row rowcontrols';
      const mkNum = (key, label) => {
        const wrap = document.createElement('label');
        wrap.className = 'mini';
        wrap.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'number'; inp.value = w[key] || 0; inp.title = 'Pivot (rotation centre) inside the hand image';
        inp.oninput = () => { w[key] = parseInt(inp.value, 10) || 0; render(); };
        wrap.appendChild(inp);
        return wrap;
      };
      prow.appendChild(mkNum(pxKey, 'pivot X'));
      prow.appendChild(mkNum(pyKey, 'pivot Y'));
      const centre = document.createElement('button');
      centre.textContent = 'Centre';
      centre.title = 'Set the pivot to the middle of the hand image';
      centre.onclick = () => {
        const im = s.images.find((x) => x.name === w[imgKey]);
        if (!im) return;
        pushHistory();
        w[pxKey] = Math.round(im.width / 2); w[pyKey] = Math.round(im.height / 2);
        refreshPanels(); render();
      };
      prow.appendChild(centre);
      grid.appendChild(prow);
    }
  }
  if (w.Shape === 30 || w.BitmapList !== undefined) {
    const lrow = mkRow('Images', w.Shape === 30 ? 'Image this layer shows' : 'Images this layer shows, in order');
    const btn = document.createElement('button');
    btn.className = 'grow-btn';
    const entries = listEntries(w);
    if (w.Shape === 30) {
      btn.textContent = entries.length ? '1 image…' : 'Choose image…';
      btn.title = entries.length ? entries[0].name : '(empty)';
    } else {
      btn.textContent = entries.length ? `${entries.length} image${entries.length > 1 ? 's' : ''}…` : 'Choose images…';
      btn.title = w.BitmapList || '(empty)';
    }
    btn.onclick = () => openImgListDialog(w);
    lrow.appendChild(btn);
    grid.appendChild(lrow);
  }
  for (const [k, t] of fields) {
    if (w[k] === undefined) continue;
    const lab = mkRow(PROP_LABELS[k] || k);
    if (k === 'DataSrcValue' || k === 'DataSrcIndex') {
      const sel = document.createElement('select');
      const cur = String(w[k]);
      if (!DATASRC_LABEL[cur]) {
        const o = document.createElement('option');
        o.value = cur; o.textContent = 'Unknown value'; o.title = cur; sel.appendChild(o);
      }
      for (const [code, label] of DATASRC) {
        const o = document.createElement('option');
        o.value = code; o.textContent = label; o.title = code;
        sel.appendChild(o);
      }
      sel.value = cur;
      sel.title = `Source code: ${cur}`;
      // light update: no panel rebuild, focus stays in the control
      sel.onchange = () => { w[k] = sel.value; sel.title = `Source code: ${sel.value}`; paintLayer(selected); render(); };
      lab.appendChild(sel);
    } else if (k === 'Alignment') {
      // the watch's runtime alignment: matters when the digit count changes
      // (9 -> 10). The editor always anchors digits at X, like the compiled file.
      const sel = document.createElement('select');
      sel.title = 'Runtime alignment on the watch: how this value stays aligned when its digit count changes (9:00 vs 10:00). It is stored in the .bin; the editor always anchors digits at X, which is what the compiled file shows.';
      for (const [v, name] of [[0, 'Left'], [1, 'Center'], [2, 'Right']]) {
        const o = document.createElement('option'); o.value = String(v); o.textContent = name; sel.appendChild(o);
      }
      sel.value = String(w.Alignment ?? 0);
      sel.onchange = () => { w.Alignment = parseInt(sel.value, 10) || 0; paintLayer(selected); render(); };
      lab.appendChild(sel);
    } else if (k === 'Blanking') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      // checked = hide leading zeros. Device-verified mapping: hiding zeros is
      // the compiled bit4 CLEAR, i.e. model Blanking truthy.
      cb.checked = w.Blanking === 1 || w.Blanking === true;
      cb.title = 'Hide leading zeros (08 → 8). Compiled into the .bin; the preview shows it as soon as the value would start with 0.';
      cb.onchange = () => { w.Blanking = cb.checked ? 1 : 0; paintLayer(selected); render(); };
      lab.appendChild(cb);
    } else if (k === 'Spacing') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.value = w.Spacing ?? 0;
      inp.title = 'Extra px between digits (compiled into the .bin). Values ≥ the digit width are ignored by the watch — some stock faces ship 244 here.';
      inp.oninput = () => { w.Spacing = parseInt(inp.value, 10) || 0; paintLayer(selected); render(); };
      lab.appendChild(inp);
    } else {
      const inp = document.createElement('input'); inp.type = t; inp.value = w[k];
      if (k === 'Name' && w.Shape === 30 && !w._tap && (w._action || /\[[^\]]+\]/.test(w.Name || ''))) {
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
  {
    const isImageLayer = w.Shape === 30;
    const row = mkRow('Tap action', isImageLayer
      ? 'Makes this image layer a tappable button (image + action are bound, like stock buttons). All 37 apps available.'
      : 'Adds a tap zone at this layer\u2019s top-left; the layer keeps rendering normally. Zones use the stock name-based format, verified for these apps only.');
    const sel = document.createElement('select');
    const m = /\[([^\]]+)\]/.exec(w.Name || '');
    const curApp = (w._tap || (m ? m[1] : '') || '').toLowerCase() || null;
    const none = document.createElement('option');
    none.value = ''; none.textContent = (!curApp && w._action) ? 'Custom (from file)' : 'None';
    sel.appendChild(none);
    const apps = isImageLayer ? TAP_APPS : ZONE_TAP_APPS;
    for (const a of apps) {
      const o = document.createElement('option');
      o.value = a; o.textContent = a;
      sel.appendChild(o);
    }
    if (!isImageLayer) {
      const hint = document.createElement('option');
      hint.disabled = true; hint.textContent = '\u2014 image layers can use any app \u2014';
      sel.appendChild(hint);
    }
    if (curApp && !apps.includes(curApp)) {
      const o = document.createElement('option');
      o.value = curApp; o.textContent = `${curApp} (unknown — compile will fail)`;
      sel.appendChild(o);
    }
    sel.value = curApp || '';
    sel.onchange = () => {
      if (sel.value) { w._tap = sel.value; delete w._action; }
      else {
        delete w._tap;
        // drop a stale [app] suffix so the layer is no longer a button
        w.Name = (w.Name || '').replace(/_?\[[^\]]+\]\s*$/, '');
      }
      paintLayer(selected); render();
    };
    row.appendChild(sel);
    grid.appendChild(row);
  }
  if (w.Shape === 32 || w.Shape === 31 || (w._font && w._font.glyphs)) {
    const f = w._font = w._font || {};
    const frow = mkRow('Font');
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
      const srow = document.createElement('div'); srow.className = 'row rowcontrols';
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
      const gen = document.createElement('button'); gen.className = 'grow-btn'; gen.textContent = f.glyphs ? 'Regenerate' : 'Generate 0-9';
      gen.onclick = () => regenerateWidgetGlyphs(w, slot());
      srow.appendChild(sizeInp); srow.appendChild(colInp);
      srow.appendChild(mkCheck('bold', 'Faux bold')); srow.appendChild(mkCheck('italic', 'Faux italic'));
      srow.appendChild(gen);
      grid.appendChild(srow);
      if (f.glyphs && f.glyphs.length === 1) {
        const grow = mkRow('Glyph', 'Character this layer renders from the font');
        const ginp = document.createElement('input');
        ginp.type = 'text'; ginp.value = f.glyphs[0].char; ginp.maxLength = 2;
        ginp.oninput = () => {
          // the tag feeds the image name, so it must follow the character —
          // otherwise a new character would reuse the old PNG.
          const ch = ginp.value || ' ';
          const tag = /^[0-9]$/.test(ch) ? ch : `u${ch.codePointAt(0).toString(16)}`;
          f.glyphs = [{ tag, char: ch }];
          queueFontGen(w);
        };
        grow.appendChild(ginp);
        grid.appendChild(grow);
      } else if (f.glyphs && f.glyphs.length > 1) {
        const note = document.createElement('div'); note.className = 'muted';
        const isDigitsPlusSign = f.glyphs.length === 11 && f.glyphs[10].tag === 'minus';
        note.textContent = isDigitsPlusSign
          ? '11 frames: digits 0-9 + minus (frame 10 renders negative values)'
          : `${f.glyphs.length} frames: ${f.glyphs.map((g) => `"${g.char}"`).join(' ')}`;
        grid.appendChild(note);
      }
      if (w._preset) {
        const note = document.createElement('div'); note.className = 'muted';
        note.textContent = `Preset: ${w._preset} \u2014 this layer regenerates its own glyph instead of 0-9.`;
        grid.appendChild(note);
      }
      if ((f.files || []).length) {
        const note = document.createElement('div'); note.className = 'muted';
        note.textContent = `${f.files.length} images from ${f.family} (regenerating replaces them).`;
        grid.appendChild(note);
      }
    }
  }
  P.appendChild(info); P.appendChild(grid);
  updatePinfo();
  // capture pre-edit state for undo (dedupe makes repeats harmless)
  grid.querySelectorAll('input,select').forEach((el) => {
    el.addEventListener('focus', pushHistory);
    el.addEventListener('pointerdown', pushHistory);
  });
}

// live read-only summary in Properties (kept in sync while dragging/editing)
// every Properties row: <label class="row"><span class="lbl">..</span>control</label>
function mkRow(labelText, title) {
  const lab = document.createElement('label');
  lab.className = 'row';
  const sp = document.createElement('span');
  sp.className = 'lbl';
  sp.textContent = labelText;
  if (title) { lab.title = title; sp.title = title; }
  lab.appendChild(sp);
  return lab;
}
function updatePinfo() {
  const el = $('pinfoType');
  if (!el) return;
  const s = slot();
  const w = s.widgets[selected];
  if (!w) return;
  const src = w.DataSrcValue || w.DataSrcIndex;
  const tapApp = (/\[([^\]]+)\]/.exec(w.Name || '') || [])[1];
  el.textContent = shapeName(w.Shape);
  $('pinfoPos').textContent = `${w.X || 0}, ${w.Y || 0}`;
  $('pinfoSize').textContent = `${w.Width || 0} × ${w.Height || 0}`;
  $('pinfoSrc').textContent = src ? datasrcLabel(src) : '—';
  $('pinfoTap').textContent = tapApp ? tapApp : (w._action ? 'custom (from file)' : '—');
  if (w._hidden) {
    $('pinfoType').textContent += ' · hidden';
  }
}
// ---------- grouping ----------
function membersOf(w, s) {
  if (!w._group) return [w];
  return s.widgets.filter((x) => x._group === w._group);
}
function groupSelection() {
  if (!project) return;
  const s = slot();
  const ids = [...groupSel].filter((i) => s.widgets[i]);
  if (ids.length < 2) { $('meta').textContent = 'Select 2+ layers (Ctrl/Cmd+click) to group.'; return; }
  pushHistory();
  const gid = `g${groupSeq++}`;
  for (const i of ids) s.widgets[i]._group = gid;
  $('meta').textContent = `Grouped ${ids.length} layers (${gid}) \u2014 they now move together.`;
  refreshPanels(); render();
}
function ungroupSelection() {
  if (!project) return;
  const s = slot();
  const ids = groupSel.size ? [...groupSel] : [selected];
  const touched = new Set();
  pushHistory();
  for (const i of ids) {
    const w = s.widgets[i];
    if (!w || !w._group) continue;
    for (const m of membersOf(w, s)) touched.add(m);
  }
  for (const m of touched) delete m._group;
  $('meta').textContent = touched.size ? `Ungrouped ${touched.size} layers.` : 'Nothing grouped here.';
  refreshPanels(); render();
}
$('btnGroup').onclick = groupSelection;
$('btnUngroup').onclick = ungroupSelection;

// Lay a preset-built group out again left-to-right using the current widths, so
// changing a font size in one child (or the whole group) keeps the spacing and
// keeps short layers (colon, degree) vertically centred on the digits.
function relayoutPresetGroup(gid) {
  const s = slot();
  const members = s.widgets.filter((x) => x._group === gid);
  if (members.length < 2) return;
  // only preset assemblies have a known reading order
  const digits = members.filter((m) => m.Shape === 32);
  const rowY = digits.length ? digits[0].Y || 0 : Math.min(...members.map((m) => m.Y || 0));
  const rowH = digits.length ? Math.max(...digits.map((m) => m.Height)) : Math.max(...members.map((m) => m.Height));
  const size = (digits[0] && digits[0]._font && digits[0]._font.size) || rowH || 100;
  const gap = Math.round(size * 0.06);
  const ordered = members.slice().sort((a, b) => (a.X || 0) - (b.X || 0));
  let x = ordered[0].X || 0;
  for (const m of ordered) {
    m.X = Math.round(x);
    m.Y = m.Shape === 32 ? rowY : Math.round(rowY + (rowH - m.Height) / 2);
    x += (m.Shape === 32 ? m.Width * (m.Digits || 2) : m.Width) + gap;
  }
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
// ---------- Presets ----------
// A preset drops in the usual building blocks, inheriting the project font when
// one is set (otherwise pick a font afterwards in Properties and the digits are
// generated then).
const PRESET_SIZE = 100;
const PRESETS = [
  { group: 'Time' },
  { id: 'hour', label: 'Hour', sub: '2 digits', src: '0811', digits: 2 },
  { id: 'minute', label: 'Minutes', sub: '2 digits', src: '1011', digits: 2 },
  { id: 'second', label: 'Seconds', sub: '2 digits', src: '1811', digits: 2 },
  { id: 'clock', label: 'Digital clock', sub: '12:45 \u00b7 grouped' },
  { id: 'clocksec', label: 'Digital clock + seconds', sub: '12:45:28 \u00b7 grouped' },
  { id: 'ampm', label: 'AM / PM', sub: 'text', src: '0813', digits: 2, text: 'AM' },
  { group: 'Date' },
  { id: 'day', label: 'Day', src: '1812', digits: 2 },
  { id: 'month', label: 'Month', src: '1012', digits: 2 },
  { id: 'weekday', label: 'Weekday', src: '2012', digits: 1, text: '3' },
  { group: 'Health & weather' },
  { id: 'steps', label: 'Steps', src: '0821', digits: 5 },
  { id: 'hr', label: 'Heart rate', src: '0822', digits: 3 },
  { id: 'calories', label: 'Calories', src: '0823', digits: 5 },
  { id: 'battery', label: 'Battery', sub: '%', src: '0841', digits: 3 },
  { id: 'temp', label: 'Temperature', sub: '\u00b0 layer + minus frame', src: '2031', digits: 2, extras: ['deg'], minusFrame: true },
  { group: 'Extras' },
  { id: 'colon', label: 'Colon', sub: 'static', glyphs: [{ tag: 'colon', char: ':' }] },
  { id: 'colonblink', label: 'Colon (blink)', sub: '2-frame list \u2014 experimental', glyphs: [{ tag: 'colon', char: ':' }, { tag: 'colonOff', char: ' ' }] },
  { id: 'text', label: 'Custom text\u2026', sub: 'from the project font' },
];
let presetMenuOpen = false;
function buildPresetsMenu() {
  const m = $('presetsMenu');
  m.innerHTML = '';
  for (const p of PRESETS) {
    if (p.group) {
      const t = document.createElement('div');
      t.className = 'pm-title';
      t.textContent = p.group;
      m.appendChild(t);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    const nm = document.createElement('span');
    nm.textContent = p.label;
    b.appendChild(nm);
    if (p.sub) {
      const sb = document.createElement('span');
      sb.className = 'pm-sub';
      sb.textContent = p.sub;
      b.appendChild(sb);
    }
    b.onclick = () => { togglePresets(false); applyPreset(p); };
    m.appendChild(b);
  }
}
function togglePresets(open) {
  presetMenuOpen = open == null ? !presetMenuOpen : open;
  $('presetsMenu').hidden = !presetMenuOpen;
  $('btnPresets').classList.toggle('on', presetMenuOpen);
}
$('btnPresets').onclick = (e) => { e.stopPropagation(); togglePresets(); };
document.addEventListener('click', (e) => { if (presetMenuOpen && !e.target.closest('.presets')) togglePresets(false); });

// place a new widget near the centre, staggered so presets don't stack exactly
function presetAnchor(w, h) {
  const s = slot();
  const n = s.widgets.length;
  const cx = Math.round((project.screenW || 432) / 2), cy = Math.round((project.screenH || 514) / 2);
  return { x: cx - Math.round(w / 2) + (n % 3) * 6, y: cy - Math.round(h / 2) + (n % 5) * 20 };
}
// Digital clock: hour : minute [: second] built from one font/size and grouped
// so the whole reading drags as a single unit.
async function applyClockPreset(withSeconds) {
  const s = slot();
  const font = project.font;
  const size = PRESET_SIZE;
  const taken = new Set(s.widgets.map((w) => w.Name));
  if (!font) { $('meta').textContent = 'Set a Project font first (Project panel) \u2014 then add the clock preset.'; return; }
  let digits, colon;
  try {
    digits = await ensureGlyphSet(s, font, size, '#ffffff', false, false, DIGIT_GLYPHS, { mono: true });
    colon = await ensureGlyphSet(s, font, size, '#ffffff', false, false, [{ tag: 'colon', char: ':' }], { mono: false });
  } catch (e) { $('meta').textContent = `Clock preset failed: ${e.message}`; return; }
  const names = DIGIT_GLYPHS.map((g) => digits.names[g.tag]);
  const fontMeta = () => ({ family: font, size, color: '#ffffff', files: names.slice() });
  const gap = Math.round(size * 0.06);
  const parts = [];
  const digitLayer = (src, digitCount) => ({
    Shape: 32, Name: '', X: 0, Y: 0, Width: digits.width, Height: digits.height, Alpha: 255,
    Digits: digitCount, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: src,
    BitmapList: names.join('|'), _font: fontMeta(),
  });
  const colonLayer = () => ({
    Shape: 30, Name: '', X: 0, Y: 0, Width: colon.width, Height: colon.height, Alpha: 255,
    Bitmap: colon.names.colon, _font: { family: font, size, color: '#ffffff', glyphs: [{ tag: 'colon', char: ':' }], files: [colon.names.colon] },
  });
  parts.push({ layer: digitLayer('0811', 2), kind: 'digits' });
  parts.push({ layer: colonLayer(), kind: 'colon' });
  parts.push({ layer: digitLayer('1011', 2), kind: 'digits' });
  if (withSeconds) {
    parts.push({ layer: colonLayer(), kind: 'colon' });
    parts.push({ layer: digitLayer('1811', 2), kind: 'digits' });
  }
  // total width, then centre the reading on screen
  const total = parts.reduce((a, p2) => a + (p2.kind === 'digits' ? p2.layer.Width * 2 : p2.layer.Width), 0) + gap * (parts.length - 1);
  const cx = Math.round((project.screenW || 432) / 2 - total / 2);
  const cy = Math.round((project.screenH || 514) / 2 - digits.height / 2);
  const gid = `g${groupSeq++}`;
  pushHistory();
  let x = cx;
  for (const part of parts) {
    const w2 = part.layer;
    w2.X = Math.round(x);
    // the colon is short: centre it against the digits
    w2.Y = part.kind === 'colon' ? Math.round(cy + (digits.height - w2.Height) / 2) : cy;
    w2.Name = uniqName(part.kind === 'colon' ? 'clock_colon' : (w2.DataSrcValue === '0811' ? 'clock_hour' : w2.DataSrcValue === '1011' ? 'clock_minute' : 'clock_second'), taken);
    taken.add(w2.Name);
    w2._preset = 'clock';
    w2._group = gid;
    s.widgets.push(w2);
    x += (part.kind === 'digits' ? w2.Width * 2 : w2.Width) + gap;
  }
  selected = s.widgets.length - 1;
  groupSel = new Set(s.widgets.map((w2, i) => (w2._group === gid ? i : -1)).filter((i) => i >= 0));
  refreshPanels(); render();
  $('meta').textContent = `Digital clock${withSeconds ? ' with seconds' : ''} added: ${parts.length} layers in group ${gid} (${font} ${size}px).`;
}

async function applyPreset(p) {
  if (!project) return;
  if (p.id === 'text') { openTextDialog(); return; }
  if (p.id === 'clock' || p.id === 'clocksec') { await applyClockPreset(p.id === 'clocksec'); return; }
  const s = slot();
  const taken = new Set(s.widgets.map((w) => w.Name));
  // glyphs this preset needs
  const glyphs = p.glyphs || (p.minusFrame ? DIGIT_GLYPHS_MINUS : DIGIT_GLYPHS);
  const font = project.font;
  let set = null;
  if (font) {
    try { set = await ensureGlyphSet(s, font, PRESET_SIZE, '#ffffff', false, false, glyphs, { mono: !p.glyphs }); }
    catch (e) { $('meta').textContent = `Preset font failed: ${e.message}`; }
  }
  const gw = set ? set.width : Math.round(PRESET_SIZE * 0.6), gh = set ? set.height : Math.round(PRESET_SIZE * 1.2);
  pushHistory();
  if (p.glyphs) {
    // glyph-only preset (colon): one image layer, or a 2-frame list for blink
    const onName = set ? set.names[p.glyphs[0].tag] : null;
    if (!onName) { $('meta').textContent = 'Set a Project font first (Project panel).'; return; }
    const wg = { Shape: 30, Name: uniqName(p.id, taken), X: 0, Y: 0, Width: gw, Height: gh, Alpha: 255, Bitmap: onName,
      _preset: p.id, _font: { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: p.glyphs.slice(), files: Object.values(set.names) } };
    if (p.id === 'colonblink') {
      const offName = await ensureGlyphSet(s, font, 60, '#ffffff', false, false, [{ tag: 'colonOff', char: ' ' }], { mono: false })
        .then((r) => r.names.colonOff).catch(() => null);
      if (offName) {
        wg.Shape = 31;
        wg.DataSrcIndex = '1911';                 // second ones
        wg.DefaultIndex = 0;
        wg.BitmapList = `(0):${onName}|(1):${offName}`;
        wg._font = { family: font, size: PRESET_SIZE, color: '#ffffff', files: [onName, offName],
          glyphs: [{ tag: 'colon', char: ':' }, { tag: 'colonOff', char: ' ' }] };
      }
    }
    const anchor = presetAnchor(wg.Width, wg.Height);
    wg.X = anchor.x; wg.Y = anchor.y;
    s.widgets.push(wg);
    selected = s.widgets.length - 1;
    refreshPanels(); render();
    pushHistory();
    $('meta').textContent = p.id === 'colonblink'
      ? 'Colon (blink) added as a 2-frame list on seconds \u2014 experimental, verify on the watch.'
      : 'Colon added.';
    return;
  }
  if (p.id === 'ampm' || (p.text && !font)) {
    // text-ish values: one image rendered from the sample text
    const anchor = presetAnchor(gw, gh);
    const wg = { Shape: 30, Name: uniqName(p.id, taken), X: anchor.x, Y: anchor.y, Width: gw, Height: gh, Alpha: 255, Bitmap: set ? set.names['0'] : '' };
    s.widgets.push(wg);
    selected = s.widgets.length - 1;
    refreshPanels(); render();
    return;
  }
  const names = set ? glyphs.map((g) => set.names[g.tag]) : [];
  const wg = {
    Shape: 32, Name: uniqName(p.id, taken), X: 0, Y: 0, Width: gw, Height: gh, Alpha: 255,
    Digits: p.digits || 2, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: p.src,
    BitmapList: names.join('|'),
    _preset: p.id,   // marks the layer as preset-built (re-flow + glyph behaviour)
    _font: font ? { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: font && glyphs !== DIGIT_GLYPHS ? glyphs.slice() : undefined, files: names.slice() } : null,
  };
  const anchor = presetAnchor(wg.Width * wg.Digits, wg.Height);
  wg.X = anchor.x; wg.Y = anchor.y;
  s.widgets.push(wg);
  selected = s.widgets.length - 1;
  refreshPanels(); render();
  if (!font) { $('meta').textContent = `${p.label} added \u2014 choose a font in Properties to generate the digits.`; return; }
  // extras (temperature: \u00b0 and \u2212) become their own layers next to the value
  for (const tag of p.extras || []) {
    let ex = null;
    try { ex = await ensureGlyphSet(s, font, PRESET_SIZE, '#ffffff', false, false, [{ tag, char: EXTRA_GLYPHS[tag] }], { mono: false }); }
    catch (e) { continue; }
    const name = ex.names[tag];
    const ew = { Shape: 30, Name: uniqName(`${p.id}_${tag}`, taken), X: wg.X + wg.Width * wg.Digits, Y: wg.Y, Width: ex.width, Height: ex.height,
      Alpha: 255, Bitmap: name, _preset: `${p.id}:${tag}`,
      _font: { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: [{ tag, char: EXTRA_GLYPHS[tag] }], files: [name] } };
    // the sign sits left of the value and is part of the group, so the whole
    // reading ("-12\u00b0") can be dragged as one unit
    if (!wg._group) wg._group = `g${groupSeq++}`;
    ew._group = wg._group;
    if (tag === 'minus') ew.X = wg.X - ex.width;
    s.widgets.push(ew);
    taken.add(ew.Name);
  }
  pushHistory();
  refreshPanels(); render();
  $('meta').textContent = `${p.label} added${p.minusFrame ? ' (11 frames: 0-9 + minus, so negative values render the sign)' : ''}${p.extras ? ` with ${p.extras.join(' + ')} glyph as its own layer` : ''}.`;
}

// ---------- custom text ----------
let textTargets = [];
function openTextDialog() {
  const sel = $('txtFont');
  sel.innerHTML = '';
  for (const fam of fontFamilies()) {
    const o = document.createElement('option'); o.value = fam; o.textContent = fam; sel.appendChild(o);
  }
  if (project.font && [...sel.options].some((o) => o.value === project.font)) sel.value = project.font;
  $('txtValue').value = '';
  $('txtSize').value = String(PRESET_SIZE);
  $('textModal').hidden = false;
  setTimeout(() => $('txtValue').focus(), 0);
}
$('txtCancel').onclick = () => { $('textModal').hidden = true; };
$('textModal').addEventListener('mousedown', (e) => { if (e.target === $('textModal')) $('textModal').hidden = true; });
$('txtCreate').onclick = async () => {
  const text = $('txtValue').value;
  if (!project || !text) { $('textModal').hidden = true; return; }
  const family = $('txtFont').value, size = parseInt($('txtSize').value, 10) || 48, color = $('txtColor').value;
  $('textModal').hidden = true;
  const s = slot();
  try { await ensureFont(family); } catch (e) { $('meta').textContent = `Font not found: ${family}`; return; }
  try { await document.fonts.load(`${size}px "${family}"`, text); } catch (e) { /* keep going */ }
  const m = document.createElement('canvas').getContext('2d');
  setFontOn(m, family, size);
  const tw = Math.ceil(m.measureText(text).width) + 2;
  const th = Math.ceil(size * 1.35);
  const c2 = document.createElement('canvas'); c2.width = Math.max(1, tw); c2.height = th;
  const c = c2.getContext('2d');
  setFontOn(c, family, size); c.fillStyle = color;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, tw / 2, th / 2);
  const taken = new Set(s.images.map((im) => im.name));
  const name = uniqName(`text_${text.slice(0, 12).replace(/[^\w]+/g, '_')}.png`, taken);
  pushHistory();
  s.images.push({ name, width: tw, height: th, url: c2.toDataURL('image/png') });
  const anchor = presetAnchor(tw, th);
  s.widgets.push({ Shape: 30, Name: uniqName('text', new Set(s.widgets.map((w) => w.Name))), X: anchor.x, Y: anchor.y, Width: tw, Height: th, Alpha: 255, Bitmap: name });
  selected = s.widgets.length - 1;
  refreshPanels(); render();
  $('meta').textContent = `Text "${text}" added (${tw}\u00d7${th}).`;
};

// ---------- Test data panel ----------
let testTicker = null;
function applyCurrentTime() {
  const f = nowFields();
  for (const k of Object.keys(f)) TEST_DATA[k] = f[k];
}
function renderTestDataPanel() {
  const host = $('testData');
  if (!host) return;
  host.innerHTML = '';
  for (const [key, label] of TEST_FIELDS) {
    const row = mkRow(label);
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = TEST_DATA[key] != null ? TEST_DATA[key] : '';
    inp.setAttribute('data-td', key);
    inp.oninput = () => { TEST_DATA[key] = inp.value; render(); };
    row.appendChild(inp);
    host.appendChild(row);
  }
  syncTestDataInputs();
}
function syncTestDataInputs() {
  document.querySelectorAll('#testData input[data-td]').forEach((inp) => {
    const k = inp.getAttribute('data-td');
    const v = TEST_DATA[k] != null ? String(TEST_DATA[k]) : '';
    if (document.activeElement !== inp && inp.value !== v) inp.value = v;
    inp.disabled = useCurrentTime && TIME_FIELDS.includes(k);
  });
}
$('tdCurrent').onchange = () => {
  useCurrentTime = $('tdCurrent').checked;
  if (useCurrentTime) {
    applyCurrentTime();
    if (!testTicker) testTicker = setInterval(() => { applyCurrentTime(); syncTestDataInputs(); render(); }, 1000);
  } else if (testTicker) {
    clearInterval(testTicker); testTicker = null;
  }
  syncTestDataInputs();
  render();
};

// ---------- unused images ----------
// every image name a layer can display
function widgetImageRefs(w) {
  const out = [];
  if (w.Bitmap) out.push(w.Bitmap);
  for (const part of String(w.BitmapList || '').split('|')) {
    const t = part.trim();
    if (!t) continue;
    out.push(t.includes(':') ? t.split(':')[1] : t);
  }
  for (const k of ['BackgroundImage', 'HourHandImage', 'MinuteHandImage', 'SecondHandImage', 'PointerImage']) {
    if (w[k]) out.push(w[k]);
  }
  return out;
}
// hidden layers still count as referenced: hiding is a design-time toggle
function usedImageNames(s) {
  const used = new Set();
  for (const w of s.widgets) for (const n of widgetImageRefs(w)) used.add(n);
  return used;
}
function unusedImages(s) {
  const used = usedImageNames(s);
  return s.images.filter((im) => !used.has(im.name));
}
// Remove unused images. Called before save/compile and from the panel button.
function pruneUnusedImages(reason) {
  if (!project) return 0;
  // animation frames are not represented as widgets, so pruning would eat them
  if (project.animationCount || project.appCount) {
    $('meta').textContent = 'Skipped unused-image cleanup: this face has unsupported sections (animations/apps).';
    return 0;
  }
  let removed = 0;
  project.slots.forEach((s) => {
    const un = unusedImages(s);
    if (!un.length) return;
    if (!removed) pushHistory();
    for (const im of un) {
      const i = s.images.findIndex((x) => x.name === im.name);
      if (i >= 0) s.images.splice(i, 1);
      imgCache.delete(im.name);
      removed += 1;
    }
  });
  if (removed) {
    refreshPanels(); render();
    showUndoToast(`Removed ${removed} unused image${removed > 1 ? 's' : ''}${reason ? ' before ' + reason : ''}`, undo);
  }
  return removed;
}
function updatePruneButton() {
  const btn = $('btnPruneImages');
  if (!btn) return;
  const n = project ? project.slots.reduce((a, s) => a + unusedImages(s).length, 0) : 0;
  btn.disabled = !n;
  btn.textContent = n ? `Remove unused (${n})` : 'Remove unused';
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
  const i = s.images.findIndex((im) => im.name === name);
  if (i < 0) return;
  pushHistory();
  s.images.splice(i, 1);
  imgCache.delete(name);
  refreshPanels(); render();
  showUndoToast(users.length ? `Image ${name} deleted (used by ${users.join(', ')})` : `Image ${name} deleted`, undo);
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
  else if (kind === 'num') w = { Shape: 32, Name: uniqName('widget_new', taken), X: cx - 40, Y: cy - 30, Width: 40, Height: 60, Alpha: 255, Digits: 2, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: '0811', BitmapList: '' };
  else if (kind === 'list') w = { Shape: 31, Name: uniqName('widget_new', taken), X: cx - 30, Y: cy - 20, Width: 60, Height: 40, Alpha: 255, DataSrcIndex: '2012', DefaultIndex: 0, BitmapList: '' };
  else if (kind === 'clock') w = { Shape: 27, Name: uniqName('analogClock_new', taken), X: 0, Y: 0, Width: W, Height: H, Alpha: 255, HourHandImage: '', HourImageRotateX: 0, HourImageRotateY: 0, MinuteHandImage: '', MinuteImageRotateX: 0, MinuteImageRotateY: 0, SecondHandImage: '', SecondImageRotateX: 0, SecondImageRotateY: 0 };
  else if (kind === 'btn') w = { Shape: 30, Name: uniqName('btn_new', taken) + '_[alarm]', X: cx - 30, Y: cy - 30, Width: 60, Height: 60, Alpha: 255, Bitmap: firstImg };
  else return;
  pushHistory();
  s.widgets.push(w);
  selected = s.widgets.length - 1;
  refreshPanels(); render();
  // inherit the project font: generate (or reuse) the digit PNGs straight away
  if ((kind === 'num' || kind === 'list') && project.font) {
    w._font = { family: project.font, kind: customFonts.some((c) => c.family === project.font) ? 'custom' : 'bundled' };
    generateFontBitmaps(w, s);
  }
}
// Shared digit sets: identical font parameters reuse the same PNGs across
// layers, so a project font is generated once and every layer points at it.
function fontSetBase(family, size, color, bold, italic) {
  const fam = String(family).replace(/[^\w]+/g, '-');
  const col = String(color || '#ffffff').replace('#', '');
  return `font_${fam}_${size}${bold ? 'b' : ''}${italic ? 'i' : ''}_${col}`;
}
function fontSetNames(f, i) {
  const b = f._base || fontSetBase(f.family, f.size, f.color, f.bold, f.italic);
  return Array.from({ length: i == null ? 10 : i }, (_, d) => `${b}_${d}.png`);
}
// is this generated image still referenced by another layer?
function fontImageUsedElsewhere(s, name, exceptWidget) {
  return s.widgets.some((o) => o !== exceptWidget
    && ((o._font && (o._font.files || []).includes(name))
      || String(o.BitmapList || '').split('|').some((x) => (x.includes(':') ? x.split(':')[1] : x) === name)));
}

// Draw a set of glyphs from one font into transparent PNGs.
// mono=true shares one cell width (needed for even digit spacing); otherwise each
// glyph gets its natural width (used for °, -, : and custom text).
async function ensureGlyphSet(s, family, size, color, bold, italic, glyphs, { mono = true } = {}) {
  const base = fontSetBase(family, size, color, bold, italic);
  const names = {};
  const missing = glyphs.filter((g) => !s.images.some((im) => im.name === `${base}_${g.tag}.png`));
  const first = s.images.find((im) => im.name === `${base}_${glyphs[0].tag}.png`);
  if (!missing.length && first) {
    for (const g of glyphs) names[g.tag] = `${base}_${g.tag}.png`;
    return { names, width: first.width, height: first.height, base };
  }
  if (!await ensureFont(family)) throw new Error(`Font not found: ${family}`);
  try { await document.fonts.load(`${size}px "${family}"`, glyphs.map((g) => g.char).join('')); } catch (e) { /* keep going */ }
  const stroke = bold ? Math.max(1, Math.round(size / 18)) : 0;
  const pad = Math.max(1, Math.round(size / 28)) + Math.ceil(stroke / 2);
  // Measure the real ink box of every glyph (not just the advance) so nothing
  // is clipped — this is what cut the degree symbol off before.
  const meas = document.createElement('canvas').getContext('2d');
  setFontOn(meas, family, size);
  const info = glyphs.map((g) => {
    const m = meas.measureText(g.char);
    return {
      g,
      left: m.actualBoundingBoxLeft || 0,
      right: m.actualBoundingBoxRight || 0,
      asc: m.actualBoundingBoxAscent || size * 0.8,
      desc: m.actualBoundingBoxDescent || 0,
    };
  });
  const ascent = Math.ceil(Math.max(...info.map((i) => i.asc)));
  const descent = Math.ceil(Math.max(...info.map((i) => i.desc)));
  const H = ascent + descent + pad * 2;
  const slant = italic ? Math.ceil(H * 0.212) : 0;
  const wide = Math.ceil(Math.max(...info.map((i) => i.left + i.right)));
  const taken = new Set(s.images.map((im) => im.name));
  const cellOf = (i) => (mono ? wide : Math.ceil(i.left + i.right)) + pad * 2 + slant;
  for (const i of info) {
    const name = `${base}_${i.g.tag}.png`;
    if (s.images.some((im) => im.name === name)) { names[i.g.tag] = name; continue; }
    const cw = Math.max(1, cellOf(i));
    const c2 = document.createElement('canvas'); c2.width = cw; c2.height = H;
    const c = c2.getContext('2d');
    setFontOn(c, family, size);
    c.fillStyle = color; c.strokeStyle = color;
    // place the measured INK box inside the cell: origin at pad+left, baseline at
    // pad+ascent, with the italic shear compensated by the added slant width.
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.save();
    c.translate(pad + i.left + slant, pad + ascent);
    if (italic) c.transform(1, 0, -0.212, 1, 0, 0);
    if (bold) { c.lineWidth = stroke; c.strokeText(i.g.char, 0, 0); }
    c.fillText(i.g.char, 0, 0);
    c.restore();
    const uniq = uniqName(name, taken); taken.add(uniq);
    s.images.push({ name: uniq, width: cw, height: H, url: c2.toDataURL('image/png') });
    names[i.g.tag] = uniq;
  }
  const cellW = Math.max(...info.map((i) => cellOf(i)));
  return { names, width: cellW, height: H, base };
}
const DIGIT_GLYPHS = '0123456789'.split('').map((ch, i) => ({ tag: String(i), char: ch }));
// extra glyphs presets can ask for (index after the digits, e.g. temperature)
const EXTRA_GLYPHS = { deg: '\u00b0', minus: '-', plus: '+', colon: ':', percent: '%' };
// Device convention (verified on a stock Redmi Watch 5 face): digit lists may
// carry an 11th frame = the minus sign, used for negative values. Frame 10.
const MINUS_GLYPH = { tag: 'minus', char: '-' };
const DIGIT_GLYPHS_MINUS = [...DIGIT_GLYPHS, MINUS_GLYPH];
const SIGN_FRAME = 10;

async function generateFontBitmaps(w, s) {
  const f = w._font = w._font || {};
  if (!f.family) { alert('Pick a font first.'); return; }
  const current = (w.BitmapList || '').split('|').filter(Boolean);
  // replacing a hand-made BitmapList is undoable via the toast below
  const replacedForeign = current.length > 0 && !(f.files || []).length;
  const size = Math.max(8, f.size || w.Height || 60);
  const color = f.color || '#ffffff';
  const bold = !!f.bold, italic = !!f.italic;
  f.size = size; f.color = color;
  $('meta').textContent = `Loading font ${f.family}\u2026`;
  let set;
  try {
    set = await ensureGlyphSet(s, f.family, size, color, bold, italic, DIGIT_GLYPHS);
  } catch (err) { $('meta').textContent = String(err.message || err); return; }
  pushHistory();
  // drop this layer's previous set, but keep images shared with other layers
  if (f.files) for (const n of f.files) {
    if (fontImageUsedElsewhere(s, n, w)) continue;
    const i = s.images.findIndex((im) => im.name === n);
    if (i >= 0) s.images.splice(i, 1);
    imgCache.delete(n);
  }
  const names = DIGIT_GLYPHS.map((g) => set.names[g.tag]);
  f.files = names.slice(); f._base = set.base;
  w.BitmapList = names.join('|');
  w.Width = set.width; w.Height = set.height;
  $('meta').textContent = `Font ${f.family}: 10 digits (${set.width}\u00d7${set.height}).`;
  refreshPanels(); render();
  if (replacedForeign) showUndoToast(`BitmapList replaced with ${f.family} digits (${current.length} image(s))`, undo);
  const si = document.querySelector('[data-font-size]');
  if (si) { si.focus(); si.select(); }
}
// Regenerate whatever glyphs a layer actually uses. Digit layers produce 0-9;
// glyph layers (presets like Colon, or the °/- extras) regenerate exactly their
// own glyph(s), so changing size/colour can never blank them out.
async function regenerateWidgetGlyphs(w, s) {
  const f = w._font = w._font || {};
  const spec = f.glyphs;
  if (!spec || !spec.length) return generateFontBitmaps(w, s);
  if (!f.family) { $('meta').textContent = 'Pick a font first.'; return; }
  const size = Math.max(8, f.size || w.Height || 60);
  const color = f.color || '#ffffff';
  $('meta').textContent = `Rendering ${spec.length > 1 ? `${spec.length} frames` : `"${spec[0].char}"`}\u2026`;
  let set;
  try {
    // multi-frame sets must share dimensions (the packer requires it)
    set = await ensureGlyphSet(s, f.family, size, color, !!f.bold, !!f.italic, spec, { mono: spec.length > 1 });
  } catch (err) { $('meta').textContent = String(err.message || err); return; }
  const names = spec.map((g) => set.names[g.tag]);
  pushHistory();
  if (f.files) for (const n of f.files) {
    if (names.includes(n) || fontImageUsedElsewhere(s, n, w)) continue;
    const i = s.images.findIndex((im) => im.name === n);
    if (i >= 0) s.images.splice(i, 1);
    imgCache.delete(n);
  }
  f.files = names.slice(); f.size = size; f.color = color; f._base = set.base;
  if (w.Shape === 31) {
    const entries = listEntries(w);
    w.BitmapList = names.map((n, i) => `(${entries[i] && entries[i].value != null ? entries[i].value : i}):${n}`).join('|');
  } else if (w.Shape === 32) {
    // digit list (with the minus frame at index 10 when the spec has it)
    w.BitmapList = names.join('|');
  } else {
    w.Bitmap = names[0];
  }
  w.Width = set.width; w.Height = set.height;
  // preset-built groups re-flow so the reading keeps its spacing after a resize
  if (w._group && w._preset) relayoutPresetGroup(w._group);
  $('meta').textContent = `Rendered ${f.family} ${spec.map((g) => `"${g.char}"`).join(' ')}\u2009(${set.width}\u00d7${set.height}).`;
  refreshPanels(); render();
  const si = document.querySelector('[data-font-size]');
  if (si) { si.focus(); si.select(); }
}

// Debounced auto-regenerate: every font/size/color/style change re-renders
// the PNG set (stale files are deleted inside generateFontBitmaps).
let fontGenTimer = null;
function queueFontGen(w) {
  clearTimeout(fontGenTimer);
  const s = slot();
  fontGenTimer = setTimeout(() => { if (project && s.widgets.includes(w)) regenerateWidgetGlyphs(w, s); }, 450);
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
  setEmptyState();
  slotIndex = 0; selected = -1; imgCache.clear();
  $('imagesPanel').classList.add('collapsed');
  past = []; future = [];
  pushHistory();
  dirty = false;
  updateHistoryButtons();
  $('inpTitle').value = title;
  for (const id of ['btnExport', 'btnCompile', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = false;
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
async function loadProject(res) {
  await loadMaskMeta();
  if (res.groupSeq) groupSeq = res.groupSeq;
  if (res.groupNames) Object.assign(groupNames, res.groupNames);
  if (res.testData) TEST_DATA = { ...TEST_DEFAULTS, ...res.testData };
  useCurrentTime = !!res.useCurrentTime;
  $('tdCurrent').checked = useCurrentTime;
  if (useCurrentTime) { applyCurrentTime(); if (!testTicker) testTicker = setInterval(() => { applyCurrentTime(); syncTestDataInputs(); render(); }, 1000); }
  else if (testTicker) { clearInterval(testTicker); testTicker = null; }
  project = res; slotIndex = 0; selected = -1; imgCache.clear();
  setEmptyState();
  $('imagesPanel').classList.add('collapsed'); // Images always opens collapsed
  // custom fonts saved with the project (fonts/<file>) -> re-register
  for (const f of res.customFonts || []) {
    if (!customFonts.some((c) => c.family === f.family)) {
      customFonts.push({ family: f.family, url: f.url, fileName: f.fileName });
    }
  }
  // bundled/custom font choices restored from designer.json: warm them up
  for (const s of res.slots) {
    for (const w of s.widgets) {
      if (w._font && w._font.family) ensureFont(w._font.family).catch(() => { });
    }
  }
  past = []; future = [];
  pushHistory(); // baseline for undo
  dirty = false;
  updateHistoryButtons();
  $('inpTitle').value = project.title || '';
  $('meta').textContent = `${res.base} · v${res.version} · ${res.watchName} · ${res.screenW}×${res.screenH} · ${res.slots.length} slot(s)`
    + (res.animationCount ? ` · ⚠ ${res.animationCount} animation entr${res.animationCount === 1 ? 'y' : 'ies'} (not supported — compile would drop them)` : '')
    + (res.appCount ? ` · ⚠ ${res.appCount} app widget(s)` : '');
  for (const id of ['btnExport', 'btnCompile', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = false;
  if (res.version !== 2) $('btnCompile').disabled = true;
  refreshPanels(); render();
}
$('btnAddImg').onclick = () => addWidget('img');
$('btnAddNum').onclick = () => addWidget('num');
$('btnAddList').onclick = () => addWidget('list');
$('btnAddClock').onclick = () => addWidget('clock');
$('btnAddBtn').onclick = () => addWidget('btn');
$('btnUpload').onclick = () => $('fileUpload').click();
$('btnPruneImages').onclick = () => pruneUnusedImages('removing');
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
let projFontImport = false;
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
  customFonts.push({ family, buf, fileName: file.name });
  if (projFontImport) {
    projFontImport = false;
    if (project) { project.font = family; pushHistory(); }
    updateProjFontSelect();
    refreshPanels(); render();
    return;
  }
  const w = project && slot().widgets[fontImportTarget];
  if (w) { w._font = w._font || {}; w._font.family = family; w._font.kind = 'custom'; }
  refreshPanels(); render();
};
$('inpTitle').onchange = (e) => { if (project) project.title = e.target.value; };
$('inpTitle').addEventListener('focus', pushHistory);
$('inpTitle').addEventListener('pointerdown', pushHistory);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
window.addEventListener('keydown', (e) => {
  const inField = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
  if (project && selected >= 0 && !inField && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    const ss = slot();
    const w2 = ss.widgets[selected];
    if (w2 && w2._locked) { showUndoToast('Layer is locked \u2014 unlock it first.', () => { }); return; }
    if (w2) {
      pushHistory();
      ss.widgets.splice(selected, 1);
      selected = -1;
      refreshPanels(); render();
      showUndoToast(`Layer "${w2.Name || ''}" deleted`, undo);
    }
    return;
  }
  if (project && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault(); moveSelected(e.key === 'ArrowUp' ? -1 : 1); return;
  }
  if (!(e.ctrlKey || e.metaKey) || project == null) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return; // native text undo
  if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 's' && !$('btnExport').disabled) { e.preventDefault(); $('btnExport').click(); }
  else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); }
});
$('btnAddSlot').disabled = true;
$('btnCompile').onclick = async () => {
  if (!project) return;
  // save first so the .bin always matches an on-disk project
  $('meta').textContent = 'Saving…';
  const saved = await saveProject();
  if (!saved) { $('meta').textContent = 'Compile cancelled (project not saved).'; return; }
  pruneUnusedImages('compiling');
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
    animationCount: project.animationCount || 0, appCount: project.appCount || 0,
    slots,
  });
  if (!res || !res.ok) {
    $('meta').textContent = `Compile failed: ${res ? res.error : 'cancelled'}`;
    return;
  }
  const notes = [...(res.warnings || []), ...(res.issues || [])];
  $('meta').textContent = `Saved → ${saved.out} · Compiled → ${res.path} (${res.bytes}B)${notes.length ? ' · ' + notes.join(' · ') : ' · verified OK'}`;
};
// Compose a slot to a face-sized PNG (used when a slot has no decoded
// preview of its own, e.g. newly created faces/slots).
async function composeSlotPng(si, w, h) {
  const prevSlot = slotIndex, prevSel = selected;
  slotIndex = si; selected = -1; exportRender = true;
  await render();
  const pv = document.createElement('canvas');
  pv.width = w; pv.height = h;
  pv.getContext('2d').drawImage(cv, 0, 0, w, h);
  const b64 = pv.toDataURL('image/png').split(',')[1];
  exportRender = false;
  slotIndex = prevSlot; selected = prevSel;
  await render();
  return b64;
}
// Preview for save/compile. Untouched faces keep their device-accurate
// embedded thumbnail; once the project is edited we regenerate it from the
// current composition so the saved/compiled preview is never stale.
async function slotPreviewB64(si, w, h) {
  const s = project.slots[si];
  if (!dirty) {
    if (s && s.previewUrl) return s.previewUrl.split(',')[1];
    if (si === 0 && project.previewUrl) return project.previewUrl.split(',')[1];
  }
  return composeSlotPng(si, w, h);
}
// Save the project (fprj + images + previews + designer.json).
// Returns { out, regenerated } or null when the user cancels the folder picker.
async function saveProject() {
  if (!project) return null;
  pruneUnusedImages('saving');
  const regenerated = dirty;             // preview will be recomposed
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
    customFonts: usedCustomFonts(), projectFont: project.font || null, groupSeq, groupNames,
    testData: TEST_DATA, useCurrentTime,
  });
  if (!out) return null;
  project.savePath = out;
  project.title = title;
  dirty = false;                          // on-disk copy is current again
  if (!project) renderRecents();
  return { out, regenerated };
}
$('btnExport').onclick = async () => {
  const r = await saveProject();
  if (!r) return;
  const n = project.slots.length;
  $('meta').textContent = `Saved → ${r.out} (${n} slot${n > 1 ? 's' : ''}${r.regenerated ? ', preview regenerated' : ''})`;
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
      if (s.widgets[i]._locked) continue; // locked layers are not draggable
      pushHistory();
      selected = i; groupSel = new Set([i]); refreshPanels(); render();
      const primary = s.widgets[i];
      const mates = membersOf(primary, s).filter((o) => o !== primary && !o._locked);
      drag = {
        dx: mx - x, dy: my - y, primary, ox: primary.X || 0, oy: primary.Y || 0,
        mates: mates.map((o) => ({ o, x: o.X || 0, y: o.Y || 0 })),
      };
      break;
    }
  }
});
window.addEventListener('mousemove', (e) => {
  if (!drag || !project) return;
  const r = cv.getBoundingClientRect();
  const sc = cv.width / (project.screenW || 240);
  const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
  const w = drag.primary || slot().widgets[selected];
  let nx = (mx - drag.dx) / sc, ny = (my - drag.dy) / sc;
  if (showGrid) { const sn = snapMove(w, nx, ny, slot().widgets.indexOf(w)); nx = sn.x; ny = sn.y; }
  else guides = { v: [], h: [] };
  w.X = Math.round(nx); w.Y = Math.round(ny);
  // grouped layers keep their offsets: move the whole group by the same delta
  const ddx = w.X - drag.ox, ddy = w.Y - drag.oy;
  for (const m of drag.mates || []) { m.o.X = Math.round(m.x + ddx); m.o.Y = Math.round(m.y + ddy); }
  render();
  paintLayer(slot().widgets.indexOf(w));
});
setEmptyState();
loadMaskMeta();
buildPresetsMenu();

window.addEventListener('mouseup', () => { if (drag) { drag = null; guides = { v: [], h: [] }; if (project) { refreshPanels(); render(); } } });
