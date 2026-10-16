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

// ---------- custom select ----------
// Progressive enhancement: every native <select> keeps its value/onchange but
// is rendered as a styled dropdown so options can carry a thumbnail
// (option.dataset.img) — one glance tells you what you are picking. The native
// select stays in the DOM (hidden) as the single source of truth, so all
// existing code ($(id).value / .onchange / innerHTML) keeps working.
function enhanceSelect(sel) {
  if (sel._enhanced || sel.multiple) return;
  sel._enhanced = true;
  try {
    sel.classList.add('nsel-native');
    const wrap = document.createElement('div');
    wrap.className = 'nsel';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'nsel-btn';
    const pop = document.createElement('div');
    pop.className = 'nsel-pop';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(btn); wrap.appendChild(pop); wrap.appendChild(sel);

    const contentRow = (opt) => {
      const row = document.createElement('span'); row.className = 'nsel-opt-in';
      const img = opt.dataset && opt.dataset.img;
      if (img) { const i = document.createElement('img'); i.className = 'nsel-thumb'; i.src = img; i.alt = ''; row.appendChild(i); }
      const sp = document.createElement('span'); sp.className = 'nsel-opt-tx'; sp.textContent = opt.textContent; row.appendChild(sp);
      return row;
    };
    const renderBtn = () => {
      btn.innerHTML = '';
      const opt = sel.options[sel.selectedIndex];
      if (opt) btn.appendChild(contentRow(opt));
      else { const sp = document.createElement('span'); sp.className = 'nsel-opt-tx'; sp.textContent = '\u2014'; btn.appendChild(sp); }
      btn.disabled = sel.disabled;
      btn.classList.toggle('empty', !opt);
    };
    const renderPop = () => {
      pop.innerHTML = '';
      const walk = (parent, host) => {
        for (const child of parent.children) {
          if (child.tagName === 'OPTGROUP') {
            const g = document.createElement('div'); g.className = 'nsel-group'; g.textContent = child.label; host.appendChild(g);
            walk(child, host);
          } else if (child.tagName === 'OPTION') {
            const o = document.createElement('button');
            o.type = 'button';
            o.className = 'nsel-opt' + (child.value === sel.value ? ' sel' : '') + (child.disabled ? ' dis' : '');
            o.appendChild(contentRow(child));
            o.onclick = () => {
              if (child.disabled) return;
              sel.value = child.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              close(); render();
            };
            host.appendChild(o);
          }
        }
      };
      walk(sel, pop);
    };
    const render = () => { renderBtn(); renderPop(); };
    let open = false;
    const onDoc = (e) => { if (!wrap.contains(e.target) && !pop.contains(e.target)) close(); };
    const onScroll = (e) => { if (!pop.contains(e.target)) close(); };
    const close = () => {
      if (!open) return;
      open = false;
      pop.classList.remove('open');
      pop.style.cssText = '';
      wrap.appendChild(pop);
      btn.classList.remove('open');
      document.removeEventListener('mousedown', onDoc, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
    // popup is moved to <body> with fixed positioning so it is never clipped
    // by the scrollable panels; repositioned under the trigger button
    const show = () => {
      if (open) return;
      open = true;
      renderPop();
      document.body.appendChild(pop);
      pop.classList.add('open');
      const r = btn.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.left = r.left + 'px';
      pop.style.width = Math.max(r.width, 180) + 'px';
      const ph = pop.offsetHeight;
      pop.style.top = (r.bottom + 4 + ph > window.innerHeight && r.top - 4 - ph > 0)
        ? (r.top - 4 - ph) + 'px' : (r.bottom + 4) + 'px';
      btn.classList.add('open');
      document.addEventListener('mousedown', onDoc, true);
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('resize', onScroll);
    };
    btn.onclick = () => (open ? close() : show());
    sel.addEventListener('change', render);
    sel._nselRender = render;
    new MutationObserver(render).observe(sel, { childList: true, subtree: true });
    render();
  } catch (e) {
    // never break the UI for a cosmetic upgrade
    sel._enhanced = true;
  }
}
function enhanceAllSelects(root = document) {
  if (root.tagName === 'SELECT') { enhanceSelect(root); return; }
  root.querySelectorAll('select').forEach(enhanceSelect);
}
const selObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === 'childList') {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'SELECT') enhanceSelect(node);
        else if (node.querySelectorAll) node.querySelectorAll('select').forEach(enhanceSelect);
      }
      // option lists rebuilt in place: refresh label + popup
      if (m.target.tagName === 'SELECT' && m.target._nselRender) m.target._nselRender();
    }
  }
});
selObserver.observe(document.documentElement, { childList: true, subtree: true });
enhanceAllSelects(document); // selects present at load (observer only sees new ones)

// ---------- number inputs: wheel to step ----------
// Hovering a numeric field and scrolling increments/decrements it (1 or its
// step), clamped to min/max, and fires input+change so existing handlers run.
document.addEventListener('wheel', (e) => {
  const t = e.target;
  if (!t || t.tagName !== 'INPUT' || t.type !== 'number' || t.disabled || t.readOnly) return;
  if (t.dataset.noWheel === '1') return;
  e.preventDefault();
  const step = parseFloat(t.step) || 1;
  let v = parseFloat(t.value);
  if (!Number.isFinite(v)) v = 0;
  v += e.deltaY < 0 ? step : -step;
  const mn = parseFloat(t.min), mx = parseFloat(t.max);
  if (t.min !== '' && Number.isFinite(mn)) v = Math.max(v, mn);
  if (t.max !== '' && Number.isFinite(mx)) v = Math.min(v, mx);
  t.value = String(Math.round(v * 1e6) / 1e6);
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });

// Human-readable DataSrc mapping (XiaomiWatch.Common FaceItemDataSrc).
// 4-char codes = shape+display hex bytes, shared across all devices.
// Data sources — authoritative list from EasyFace's dataSrc_list.txt (m0tral),
// which documents the official enum as (display << 8) | shape; our widget code
// is the same two bytes in "shape+display" order, so 0x1108 (timeHour) -> '0811'.
// Third value = the Test-data field that drives the preview.
const DATASRC_RAW = [
  ['0811', 'Hour', 'hour'],
  ['0911', 'Hour (ones)', 'hour'],
  ['0A11', 'Hour (tens)', 'hour'],
  ['1011', 'Minute', 'minute'],
  ['1111', 'Minute (ones)', 'minute'],
  ['1211', 'Minute (tens)', 'minute'],
  ['1811', 'Second', 'second'],
  ['1911', 'Second (ones)', 'second'],
  ['1A11', 'Second (tens)', 'second'],
  ['2011', 'Centisecond', 'centi'],
  ['2111', 'Centisecond (ones)'],
  ['2211', 'Centisecond (tens)'],
  ['0812', 'Year', 'year'],
  ['0912', 'Year digit 1'],
  ['0A12', 'Year digit 2'],
  ['0B12', 'Year digit 3'],
  ['0C12', 'Year digit 4'],
  ['1012', 'Month', 'month'],
  ['1112', 'Month (ones)', 'month'],
  ['1212', 'Month (tens)', 'month'],
  ['1812', 'Day', 'day'],
  ['1912', 'Day (ones)', 'day'],
  ['1A12', 'Day (tens)', 'day'],
  ['2012', 'Weekday', 'weekday'],
  ['2812', 'Lunar year'],
  ['3012', 'Lunar month'],
  ['3812', 'Lunar day'],
  ['5812', 'Weekday name (short CN)'],
  ['5912', 'Weekday name (full CN)'],
  ['5A12', 'Weekday name (Monday)'],
  ['5B12', 'Weekday name (MONDAY)'],
  ['5C12', 'Weekday name (monday)'],
  ['5D12', 'Weekday name (Mon)'],
  ['5E12', 'Weekday name (MON)'],
  ['5F12', 'Weekday name (mon)'],
  ['6012', 'Month name (short CN)'],
  ['6112', 'Month name (January)'],
  ['6212', 'Month name (JANUARY)'],
  ['6312', 'Month name (january)'],
  ['6412', 'Month name (Jan)'],
  ['6512', 'Month name (JAN)'],
  ['6612', 'Month name (jan)'],
  ['0813', 'AM/PM (is AM)', 'ampm'],
  ['1013', 'AM/PM (is PM)', 'ampm'],
  ['1813', '24-hour mode', 'is24h'],
  ['0821', 'Steps', 'steps'],
  ['0921', 'Steps digit 1'],
  ['0A21', 'Steps digit 2'],
  ['0B21', 'Steps digit 3'],
  ['0C21', 'Steps digit 4'],
  ['0D21', 'Steps digit 5'],
  ['1021', 'Steps (%)', 'stepsPct'],
  ['1821', 'Distance (km)', 'distanceKm'],
  ['0822', 'Heart rate', 'hr'],
  ['1022', 'Heart-rate zone', 'hrZone'],
  ['1822', 'Heart rate min'],
  ['2022', 'Heart rate max'],
  ['0823', 'Calories', 'calories'],
  ['1023', 'Calories (%)', 'caloriesPct'],
  ['0824', 'Stand', 'stand'],
  ['1024', 'Stand (%)', 'standPct'],
  ['0825', 'Blood oxygen', 'spo2'],
  ['0826', 'Stress / pressure', 'stress'],
  ['0827', 'Blood pressure (diastolic)'],
  ['1027', 'Blood pressure (systolic)'],
  ['1827', 'Blood pressure (diastolic kPa)'],
  ['2027', 'Blood pressure (systolic kPa)'],
  ['2827', 'Blood pressure unit'],
  ['0828', 'Sleep', 'sleep'],
  ['0028', 'Sleep (min)', 'sleep'],
  ['1028', 'Sleep score'],
  ['2028', 'Sleep quality'],
  ['1828', 'Sleep goal (%)'],
  ['0829', 'Exercise (min)'],
  ['1029', 'Exercise (%)'],
  ['082A', 'Energy consumed'],
  ['082B', 'Recovery time'],
  ['102B', 'Run power index'],
  ['182B', 'Vitality', 'vitality'],
  ['202B', 'Vitality (7 days)'],
  ['B031', 'Sunrise hour'],
  ['B831', 'Sunrise minute'],
  ['C031', 'Sunset hour'],
  ['C831', 'Sunset minute'],
  ['0831', 'Temperature unit'],
  ['2031', 'Temperature', 'tempC'],
  ['D031', 'Temperature (\u00b0F)', 'tempF'],
  ['1831', 'Feels like', 'tempFeel'],
  ['2831', 'Humidity', 'humidity'],
  ['3031', 'Weather icon', 'weatherType'],
  ['A831', 'Wind direction'],
  ['3831', 'Wind angle'],
  ['4031', 'Wind speed', 'windSpeed'],
  ['4831', 'Wind level'],
  ['5031', 'Air quality (AQI)', 'air'],
  ['5831', 'Air quality level'],
  ['6031', 'Rain chance (%)', 'rain'],
  ['6831', 'Pressure (weather)', 'airPressure'],
  ['7031', 'Visibility'],
  ['7831', 'UV index'],
  ['8031', 'Dress index'],
  ['1832', 'Today max', 'todayMax'],
  ['2032', 'Today min', 'todayMin'],
  ['6832', 'Today max (\u00b0F)'],
  ['7032', 'Today min (\u00b0F)'],
  ['1833', 'Tomorrow max', 'tomorrowMax'],
  ['2033', 'Tomorrow min', 'tomorrowMin'],
  ['6833', 'Tomorrow max (\u00b0F)'],
  ['7033', 'Tomorrow min (\u00b0F)'],
  ['0841', 'Battery', 'battery'],
  ['1041', 'Charging', 'charging'],
  ['1841', 'Do not disturb'],
  ['2041', 'Bluetooth', 'bt'],
  ['2841', 'WiFi'],
  ['3041', 'Screen lock', 'lock'],
  ['0842', 'Altitude'],
  ['0851', 'Alarm hour'],
  ['1051', 'Alarm minute'],
];
// Codes seen in the wild that are NOT in the authoritative enum (older or
// vendor-encoded forms); kept so imported faces still resolve to a label.
const DATASRC_LEGACY = [
  ['1000911', 'Hour (tens, legacy)', 'hour', 'tens'],
  ['1001911', 'Second (tens, legacy)', 'second', 'tens'],
  ['1001912', 'Day (tens, legacy)', 'day', 'tens'],
  ['40009031', 'Temperature (\u00b0F, legacy)', 'tempF', 'both'],
  ['12818', 'Legacy param 0x182A'],
  ['22818', 'Vitality (legacy)', 'vitality', 'both'],
  ['0951', 'Legacy distance D1'],
  ['10951', 'Legacy distance D2'],
  ['20951', 'Legacy distance D3'],
];
function dsWhich(label) {
  if (/\(ones\)/.test(label)) return 'ones';
  if (/\(tens\)/.test(label)) return 'tens';
  return 'both';
}
const DATASRC = [
  ...DATASRC_RAW.map(([code, label]) => [code, label]),
  ...DATASRC_LEGACY.map(([code, label]) => [code, label]),
];
const DATASRC_LABEL = Object.fromEntries(DATASRC);
// codes are 4 hex bytes and case-insensitive (EasyFace writes D031, the
// unpacker yields d031): alias the lowercase form so lookups never miss
for (const [code, label] of DATASRC) { const lc = String(code).toLowerCase(); if (!(lc in DATASRC_LABEL)) DATASRC_LABEL[lc] = label; }
const CODE_FIELD = {};
for (const [code, label, field] of DATASRC_RAW) if (field) CODE_FIELD[code] = [field, dsWhich(label)];
for (const [code, , field, which] of DATASRC_LEGACY) if (field) CODE_FIELD[code] = [field, which || 'both'];
for (const code of Object.keys(CODE_FIELD)) { const lc = code.toLowerCase(); if (!(lc in CODE_FIELD)) CODE_FIELD[lc] = CODE_FIELD[code]; }
function datasrcLabel(code) { return DATASRC_LABEL[code] || `Unknown (${code})`; }

// ---------- per-device data sources (from EasyFace's DeviceInfo.db) ----------
// The ids are NOT shared across devices: Gen1-era devices (Mi Color, 70mai
// Saphir) use plain decimal ids (8 = Hour) while everything newer uses the
// packed "shape+display" form (0811 = Hour). The device also decides which
// sources exist at all (Mi Band 8 has 40, Mi Band 8 Pro 80).
let DEVICE_INFO = null;
function deviceSourcesFor(type) {
  const d = DEVICE_INFO && DEVICE_INFO.devices.find((x) => x.type === type);
  return d ? d.sources : [];
}
function dsLabelFor(code, officialName) {
  if (DATASRC_LABEL[code]) return DATASRC_LABEL[code];
  const n = officialName && officialName.trim();
  return n || `Unknown (${code})`;
}
// the data-source choices for the current project: the watch's own list first,
// then anything else we know (so imported faces and deliberate choices keep working)
function dataSrcOptions() {
  const list = (project && deviceSourcesFor(project.watchType)) || [];
  const supported = new Set(list.map((s) => s.id));
  const onDevice = list.map((s) => [s.id, dsLabelFor(s.id, s.name)]);
  const others = DATASRC.filter(([code]) => !supported.has(code));
  return { onDevice, others, supported };
}
// legacy / alternate spellings of a source, so a preset built for one watch can
// be re-pointed at the equivalent source of another
const SRC_ALIAS = {
  '0A11': 'Hour High', '1000911': 'Hour High',
  '1001911': 'Second High', '1001912': 'Day High',
  '0A12': 'Year 2', '0B12': 'Year 3', '0C12': 'Year 4',
  '0028': 'Sleep Duration',
  D031: 'Weather temp (F)', '40009031': 'Weather temp (F)',
  A831: 'CurrentWindDirection',
  B031: 'CurrentSunRiseHour', B831: 'CurrentSunRiseMinute',
  C031: 'CurrentSunSetHour', C831: 'CurrentSunSetMinute',
};
let _srcNames = null;
function refSourceName(code) {
  if (!_srcNames) {
    _srcNames = new Map();
    for (const d of (DEVICE_INFO ? DEVICE_INFO.devices : [])) {
      for (const s of d.sources) {
        const n = (s.name || '').trim();
        if (n && !_srcNames.has(s.id)) _srcNames.set(s.id, n);
      }
    }
  }
  return SRC_ALIAS[code] || _srcNames.get(code) || null;
}
// translate one of our canonical (packed) codes to the id this watch uses;
// returns the code unchanged when the watch has no such source
function toDeviceSource(type, code) {
  const list = deviceSourcesFor(type);
  if (!list.length || list.some((s) => s.id === code)) return code;
  let name = refSourceName(code);
  if (!name) {
    const l = DATASRC_LABEL[code];
    name = l ? l.replace(/\s*\(.*?\)\s*$/, '').trim() : null;
  }
  if (!name) return code;
  const want = name.toLowerCase();
  const hit = list.find((s) => (s.name || '').trim().toLowerCase() === want)
    || list.find((s) => (s.name || '').trim().toLowerCase().startsWith(want))
    || list.find((s) => want.startsWith((s.name || '').trim().toLowerCase()) && (s.name || '').trim().length > 2);
  return hit ? hit.id : code;
}

// ---------- test data (drives the preview) ----------
const TEST_FIELDS = [
  ['__group', 'Time'],
  ['hour', 'Hour'], ['minute', 'Minute'], ['second', 'Second'], ['centi', 'Centisecond (x10ms)'],
  ['ampm', 'AM/PM'], ['is24h', '24-hour mode'],
  ['__group', 'Date'],
  ['year', 'Year'], ['month', 'Month'], ['day', 'Day'], ['weekday', 'Weekday (0 = Sun)'],
  ['__group', 'Health'],
  ['steps', 'Steps'], ['stepsPct', 'Steps %'], ['distanceKm', 'Distance km'],
  ['hr', 'Heart rate'], ['hrZone', 'HR zone'],
  ['calories', 'Calories'], ['caloriesPct', 'Calories %'],
  ['stand', 'Stand'], ['standPct', 'Stand %'],
  ['spo2', 'Blood oxygen'], ['stress', 'Stress / pressure'], ['sleep', 'Sleep'], ['vitality', 'Vitality'],
  ['__group', 'Weather'],
  ['tempC', 'Weather \u00b0C'], ['tempF', 'Weather \u00b0F'], ['tempFeel', 'Feels like'], ['humidity', 'Humidity'],
  ['windSpeed', 'Wind speed'], ['rain', 'Rain chance %'], ['air', 'Air quality (AQI)'], ['airPressure', 'Pressure'],
  ['todayMax', 'Today max'], ['todayMin', 'Today min'], ['tomorrowMax', 'Tomorrow max'], ['tomorrowMin', 'Tomorrow min'],
  ['__group', 'System'],
  ['battery', 'Battery'], ['charging', 'Charging'], ['bt', 'Bluetooth'], ['lock', 'Screen lock'],
];
const TEST_DEFAULTS = {
  hour: '12', minute: '45', second: '28', centi: '50', ampm: 'AM', is24h: '1',
  year: '2026', month: '10', day: '21', weekday: '3',
  steps: '15652', stepsPct: '50', distanceKm: '11',
  hr: '174', hrZone: '3', calories: '12175', caloriesPct: '40', stand: '7', standPct: '80',
  spo2: '97', stress: '42', sleep: '480', vitality: '65',
  tempC: '23', tempF: '74', tempFeel: '21', humidity: '55', windSpeed: '12', rain: '20',
  air: '2', airPressure: '1013', todayMax: '26', todayMin: '14', tomorrowMax: '24', tomorrowMin: '13',
  battery: '100', charging: '100', bt: '1', lock: '0',
};
const TIME_FIELDS = ['hour', 'minute', 'second', 'centi', 'month', 'day', 'year'];
const WEEKDAY_ZERO_SUNDAY = true;
let TEST_DATA = { ...TEST_DEFAULTS };
let useCurrentTime = true;
// numeric value a value-mapped list should index by: the same as testNumeric but
// with the (ones)/(tens) sources reduced to the digit they actually carry, so a
// list keyed on e.g. the seconds digit picks frames 0..9 and not the whole value.
function testNumericForList(code) {
  const v = testNumeric(code);
  if (v == null) return null;
  const map = CODE_FIELD[String(code || '')];
  if (!map) return v;
  const which = map[1];
  if (which !== 'ones' && which !== 'tens') return v;
  const str = pad2(Math.abs(v));
  return parseInt(which === 'ones' ? str.slice(-1) : (str.length > 1 ? str.slice(0, -1) : str), 10);
}
// numeric value of the test data behind a data-source code (for value-mapped lists)
function testNumeric(code) {
  const map = CODE_FIELD[String(code || '')];
  if (!map) return null;
  let raw = TEST_DATA[map[0]];
  if (map[0] === 'hour') raw = hourPreview(raw);
  const n = parseInt(String(raw == null ? '' : raw).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// glyph tag for the image name: digits keep their digit, everything else is
// encoded by code point so different characters never collide
function glyphTag(ch) { return /^[0-9]$/.test(ch) ? `sign_u${ch.codePointAt(0).toString(16)}` : `u${ch.codePointAt(0).toString(16)}`; }
function pad2(v) { return String(v).replace(/[^0-9]/g, '').padStart(2, '0').slice(-2); }
// 0811-family hour: the watch shows 24h or 12h per the user's setting, which
// the Test-data "24-hour mode" toggle mirrors. 24h => 18; 12h => 6 (0 -> 12).
// Analog hands already mod 12.
function is24hMode() { return TEST_DATA.is24h != null && String(TEST_DATA.is24h) !== '0'; }
function hourPreview(v) {
  const h = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(h)) return v;
  if (is24hMode()) return String(h);
  return String(h % 12 === 0 ? 12 : h % 12);
}
function nowFields() {
  const d = new Date();
  const h24 = d.getHours();
  return {
    // raw 24h value; hourPreview() applies the 12/24h display mode
    hour: pad2(h24), minute: pad2(d.getMinutes()), second: pad2(d.getSeconds()),
    centi: pad2(Math.floor(d.getMilliseconds() / 10)),
    ampm: h24 < 12 ? 'AM' : 'PM',
    year: String(d.getFullYear()), month: pad2(d.getMonth() + 1), day: pad2(d.getDate()),
    // ImageList weekday convention is Index0 = Sunday (per EasyFace)
    weekday: String(d.getDay()),
  };
}
// string the preview should show for a widget's data source
function demoDigits(w) {
  const map = CODE_FIELD[String(w.DataSrcValue || w.DataSrcIndex || '')];
  const pad = (f, v) => (TIME_FIELDS.includes(f) || f === 'ampm' ? String(v) : String(v));
  if (!map) return String(TEST_DATA.hour || '12');
  const [field, which] = map;
  let v = pad(field, TEST_DATA[field] != null ? TEST_DATA[field] : TEST_DEFAULTS[field]);
  if (field === 'hour') v = hourPreview(v);
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
  for (const id of ['btnExport', 'btnCompile', 'btnConvert', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = true;
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
  const s = project.slots[i] || {};
  const r = s.role;
  if (r === 'aod') return i === 0 ? 'AOD' : `AOD ${i}`;
  // multiple styles: label non-first normal faces as Style N (global-store
  // packs ship several styles + one AOD, not one AOD per slot)
  if (r === 'face') return i === 0 ? 'Face' : `Style ${i + 1}`;
  return i === 0 ? 'Face' : (s.aod ? `AOD ${i}` : `Style ${i + 1}`);
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
  const aod = role === 'aod';
  project.slots.push({ index: n, role, aod, aodFlag: aod ? 0x80000000 : 0, orphanSec9: [], widgets: [], rawActions: [], images: [] });
  slotIndex = n; selected = -1;
  refreshPanels(); render();
};
$('slotModal').addEventListener('mousedown', (e) => { if (e.target === $('slotModal')) $('slotModal').hidden = true; });

// ---------- undo / redo (snapshot history, deduped, capped) ----------
let past = [], future = [];
let dirty = false; // project edited since load -> regenerate previews
function snap() {
  return JSON.stringify({ t: project.title, s: project.slots.map((s) => ({ i: s.index, role: s.role || null, aod: Boolean(s.aod), af: s.aodFlag >>> 0, o9: s.orphanSec9 || [], w: s.widgets, r: s.rawActions || [], im: s.images })) });
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
  project.slots = st.s.map((s, i) => ({ ...(project.slots[i] || {}), index: s.i, role: s.role, aod: s.aod, aodFlag: s.af >>> 0, orphanSec9: s.o9 || [], widgets: s.w, rawActions: s.r, images: s.im }));
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
    // a plain click selects exactly this layer — including a child of a group,
    // so it can be moved on its own; the group row (or ◉) selects the whole
    // group, and Ctrl/Cmd-click selects several layers
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
// font <select>: import first, then bundled and imported groups
function fillFontSelect(sel, noneLabel) {
  sel.innerHTML = '';
  if (noneLabel) { const o = document.createElement('option'); o.value = ''; o.textContent = noneLabel; sel.appendChild(o); }
  const imp = document.createElement('option');
  imp.value = '__import'; imp.textContent = 'Import font…';
  sel.appendChild(imp);
  const bundled = document.createElement('optgroup');
  bundled.label = 'Bundled';
  for (const f of BUNDLED_FONTS) { const o = document.createElement('option'); o.value = f.family; o.textContent = f.family; bundled.appendChild(o); }
  sel.appendChild(bundled);
  if (customFonts.length) {
    const mine = document.createElement('optgroup');
    mine.label = 'Imported';
    for (const c of customFonts) { const o = document.createElement('option'); o.value = c.family; o.textContent = c.family.replace(/^Custom-/, ''); mine.appendChild(o); }
    sel.appendChild(mine);
  }
  return sel;
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}
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
// key: optional single-image widget field (analog clock hands/background).
// With a key the dialog manages exactly that one image, like a Shape-30 layer.
function listEntries(w, key) {
  if (key) return w[key] ? [{ value: null, name: w[key] }] : [];
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
  // single-image fields (analog hands/background) reuse this dialog; the
  // reorder/index copy does not apply to them
  const singleImg = ilmState.singleKey != null;
  $('ilmTitle').textContent = singleImg ? 'Image' : 'Images';
  $('ilmSub').textContent = singleImg
    ? 'Pick one image for this field'
    : 'Drag the handle to reorder \u00b7 first entry is index 0';
  // index-origin hints (EasyFace: weekday Index0 = Sunday, month Index1 = January)
  const hintEl = $('ilmHint');
  const src = String(ilmState.widget.DataSrcIndex || ilmState.widget.DataSrcValue || '');
  const hints = {
    '2012': 'Weekday: index 0 = Sunday, then Monday … Saturday.',
    '1012': 'Month: index 1 = January … 12 = December.',
    '3031': 'Weather icon: index = weather type (0-41).',
    '1021': 'Percentage: values are the readings, e.g. (0),(10),…,(100).',
    '0841': 'Percentage: values are the readings, e.g. (0),(10),…,(100).',
    '0821': 'Distance km workaround: values are step thresholds (0, 500, …).',
  };
  let hintText = hints[src] || '';
  if (src === '3031' || src === '5031') {
    hintText += ` Icons: ${WEATHER_ICONS.slice(0, 12).map((n, i) => `${i} ${n}`).join(' · ')} … (0-41, see README)`;
  }
  hintEl.textContent = hintText;
  hintEl.hidden = !hintText;
  // picker of project images not already in the list
  const used = new Set(ilmState.entries.map((e) => e.name));
  const pick = $('ilmPick');
  pick.innerHTML = '';
  const avail = s.images.map((i) => i.name).filter((n) => !used.has(n));
  const urlOf = new Map(s.images.map((i) => [i.name, i.url]));
  for (const n of avail) {
    const o = document.createElement('option'); o.value = n; o.textContent = n;
    if (urlOf.get(n)) o.dataset.img = urlOf.get(n); // thumbnail in the custom dropdown
    pick.appendChild(o);
  }
  // preset helpers: distance thresholds, sign frame
  const kmBtn = $('ilmKm');
  const signBtn = $('ilmSign');
  kmBtn.hidden = !(ilmState.widget._kmValues || /^0?821$/.test(String(ilmState.widget.DataSrcIndex || '')));
  signBtn.hidden = !(ilmState.widget.Shape === 31 || ilmState.widget.Shape === 32);
  const single = ilmState.widget.Shape === 30 || ilmState.singleKey != null;
  // single-image field: one button, labelled Replace; multiple: Add (+ Upload)
  $('ilmAdd').textContent = single ? (ilmState.entries.length ? 'Replace' : 'Choose') : 'Add';
  $('ilmUploadBtn').hidden = single;
  pick.disabled = !avail.length;
  $('ilmAdd').disabled = !avail.length;
  // live preview of the highlighted option so images are identifiable
  const prev = $('ilmPreview');
  const showPrev = () => {
    const u = new Map(s.images.map((i) => [i.name, i.url]));
    prev.src = u.get(pick.value) || '';
    prev.hidden = !u.has(pick.value);
    prev.title = pick.value || '';
  };
  pick.onchange = showPrev;
  showPrev();
}
function openImgListDialog(w, key) {
  ilmState = { widget: w, entries: listEntries(w, key), singleKey: key || null };
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
$('ilmKm').onclick = () => {
  ilmState.entries.forEach((e, i) => { e.value = KM_THRESHOLDS[Math.min(i, KM_THRESHOLDS.length - 1)]; });
  ilmRender();
  $('meta').textContent = 'Distance thresholds filled (0, 500, 1000 … 14000 steps).';
};
$('ilmSign').onclick = async () => {
  const w = ilmState.widget;
  $('imgListModal').hidden = true; ilmState = null;
  selected = slot().widgets.indexOf(w);
  await addSignFrameToSelected();
};
$('ilmAdd').onclick = () => {
  const n = $('ilmPick').value;
  if (!n) return;
  if (ilmState.widget.Shape === 30 || ilmState.singleKey != null) ilmState.entries = [{ value: null, name: n }];
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
    if (ilmState.widget.Shape === 30 || ilmState.singleKey != null) ilmState.entries = [{ value: null, name }];
    else ilmState.entries.push({ value: null, name });
  }
  $('ilmUpload').value = '';
  ilmRender();
};
$('ilmSave').onclick = () => {
  const w = ilmState.widget;
  if (ilmState.singleKey != null) {
    w[ilmState.singleKey] = ilmState.entries.length ? ilmState.entries[0].name : '';
    // same convenience as picking from the dropdown: first image centres the pivot
    const hand = CLOCK_HANDS.find((h) => h[0] === ilmState.singleKey);
    if (hand && w[ilmState.singleKey]) {
      if (!w[hand[1]] && !w[hand[2]]) {
        const im = slot().images.find((x) => x.name === w[ilmState.singleKey]);
        if (im) { w[hand[1]] = Math.round(im.width / 2); w[hand[2]] = Math.round(im.height / 2); }
      }
    }
  } else if (w.Shape === 30) {
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
// optional per-device bezel artwork: assets/frames/<type>.png replaces the
// CSS placeholder frame (the PNG should show the real device body with a
// transparent screen cut-out, sized to the screen aspect). Missing -> CSS.
const frameArt = new Map(); // type -> url|null
function applyFrameArt(dev, type) {
  const set = (url) => {
    if (url) {
      dev.style.backgroundImage = `url("${url}")`;
      dev.style.backgroundSize = '100% 100%';
      dev.style.backgroundRepeat = 'no-repeat';
      dev.classList.add('framed');
    } else {
      dev.style.backgroundImage = '';
      dev.classList.remove('framed');
    }
  };
  if (frameArt.has(type)) { set(frameArt.get(type)); return; }
  const url = `assets/frames/${type}.png`;
  const im = new Image();
  im.onload = () => { frameArt.set(type, url); set(url); };
  im.onerror = () => { frameArt.set(type, null); set(null); };
  im.src = url;
}
function applyDeviceMask() {
  const dev = document.getElementById('cvDevice');
  const m = maskMeta && maskMeta[project.watchType];
  if (!showMask || !m) {
    // mask off: hide the placeholder too, leaving only the flat preview
    cv.style.webkitMaskImage = cv.style.maskImage = 'none';
    dev.classList.add('plain');
    dev.style.borderRadius = '0px';
    return;
  }
  dev.classList.remove('plain');
  const url = `url("assets/masks/${project.watchType}.svg")`;
  cv.style.webkitMaskImage = url; cv.style.maskImage = url;
  cv.style.webkitMaskSize = cv.style.maskSize = '100% 100%';
  cv.style.webkitMaskRepeat = cv.style.maskRepeat = 'no-repeat';
  // bezel radius = screen radius + frame padding so the two curves are
  // concentric (screen sits inset by the padding, edges stay parallel)
  const scale = cv.width / (m.w || cv.width);
  const pad = parseFloat(getComputedStyle(dev).paddingTop) || 0;
  dev.style.borderRadius = `${Math.round(m.radius * scale + pad)}px`;
  applyFrameArt(dev, project.watchType);
}
$('btnMask').classList.toggle('on', showMask);
$('btnMask').onclick = () => {
  showMask = !showMask;
  $('btnMask').classList.toggle('on', showMask);
  if (project) { applyDeviceMask(); render(); }
};

// ---------- empty state (no project) ----------
// fonts imported in earlier sessions (userData/fonts)
async function loadSavedFonts() {
  let list = [];
  try { list = (await window.api.fontsList()) || []; } catch (e) { list = []; }
  for (const f of list) {
    if (customFonts.some((c) => c.family === f.family)) continue;
    customFonts.push({ family: f.family, buf: base64ToBuf(f.dataBase64), fileName: f.fileName });
  }
  updateProjFontSelect();
  return list.length;
}

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
    const dev = deviceByType(r.device);
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
        const val = testNumericForList(w.DataSrcIndex);
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
    if (vi === selected && !exportRender && groupSel.size <= 1) {
      const vb = visualBox(s.widgets[vi]);
      ctx.strokeStyle = '#2f6feb'; ctx.lineWidth = 2;
      ctx.strokeRect(vb.x * scale, vb.y * scale, Math.max(vb.w * scale, 8), Math.max(vb.h * scale, 8));
    }
  }
  // A group (or any multi-selection) gets one box around the whole selection,
  // with a faint outline per member, instead of only the primary's box.
  if (!exportRender && groupSel.size > 1) {
    const ids = [...groupSel].filter((i) => s.widgets[i] && !s.widgets[i]._hidden);
    if (ids.length > 1) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of ids) {
        const vb = visualBox(s.widgets[i]);
        x0 = Math.min(x0, vb.x); y0 = Math.min(y0, vb.y);
        x1 = Math.max(x1, vb.x + vb.w); y1 = Math.max(y1, vb.y + vb.h);
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(47,111,235,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      for (const i of ids) {
        const vb = visualBox(s.widgets[i]);
        ctx.strokeRect(vb.x * scale, vb.y * scale, Math.max(vb.w * scale, 8), Math.max(vb.h * scale, 8));
      }
      ctx.setLineDash([]);
      ctx.strokeStyle = '#2f6feb'; ctx.lineWidth = 2;
      ctx.strokeRect(x0 * scale, y0 * scale, Math.max((x1 - x0) * scale, 8), Math.max((y1 - y0) * scale, 8));
      ctx.restore();
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
        + `<span class="gname" title="${escAttr(groupName(w._group))}">${escAttr(groupName(w._group))}</span>`
        + `<span class="gcount">${members.length} layer${members.length > 1 ? 's' : ''}</span>`
        + `<span class="flex-1"></span>`
        + `<button class="lb gsel" title="Select the whole group (click again to deselect)">\u25c9</button>`
        + `<button class="lb gungroup" title="Ungroup">\u2921</button>`;
      // Selecting a group selects every member (and the drag moves them as one);
      // clicking the same group again clears the selection, so a component added
      // afterwards lands outside the group. The name is edited in Properties.
      const groupIds = () => s.widgets.map((x, k) => (x._group === w._group ? k : -1)).filter((k) => k >= 0);
      const selectGroup = () => {
        const all = groupIds();
        const already = all.length > 0 && groupSel.size === all.length && all.every((k) => groupSel.has(k));
        if (already) { selected = -1; groupSel = new Set(); }
        else { groupSel = new Set(all); selected = all.length ? all[0] : -1; }
        refreshPanels(); render();
      };
      head.querySelector('.gchev').onclick = (ev) => {
        ev.stopPropagation();
        if (collapsedGroups.has(w._group)) collapsedGroups.delete(w._group); else collapsedGroups.add(w._group);
        refreshPanels();
      };
      head.querySelector('.gcount').onclick = selectGroup;
      head.addEventListener('click', (ev) => {
        if (ev.target.closest('button') || ev.target.classList.contains('gchev')) return;
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
  const PROP_LABELS = { Name: 'Name', X: 'X', Y: 'Y', Width: 'Width', Height: 'Height', Alpha: 'Alpha', imgfmt: 'Image fmt', Bitmap: 'Image', DataSrcValue: 'Shows', DataSrcIndex: 'Shows', Digits: 'Digits', Alignment: 'Alignment', Spacing: 'Spacing', Blanking: 'Hide leading zeros' };
  const fields = [['Name', 'text'], ['X', 'number'], ['Y', 'number'], ['Width', 'number'], ['Height', 'number'], ['Alpha', 'number'], ['imgfmt', 'select'], ['DataSrcValue', 'text'], ['DataSrcIndex', 'text'], ['Digits', 'number'], ['Alignment', 'number'], ['Spacing', 'number'], ['Blanking', 'number']];
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
  const firstSel = selIdx.length ? s.widgets[selIdx[0]] : null;
  const selGid = firstSel ? firstSel._group : null;
  const gidMembers = selGid ? s.widgets.filter((x) => x._group === selGid) : [];
  // the box shows for a multi-selection and for a whole group (so a group gets
  // the same Name/Font properties as a layer; its name is edited here)
  const wholeGroup = Boolean(selGid) && gidMembers.length > 0 && selIdx.length === gidMembers.length;
  let groupBoxEl = null;
  if (selIdx.length > 1 || wholeGroup) {
    const gb = document.createElement('div');
    gb.className = 'group-box';
    groupBoxEl = gb;
    const head = document.createElement('div');
    head.className = 'gb-head';
    const gid = selGid;
    head.textContent = gid ? `${groupName(gid)} \u00b7 ${selIdx.length} layers` : `${selIdx.length} layers selected`;
    gb.appendChild(head);
    if (gid) {
      const nrow = mkRow('Name');
      const ninp = document.createElement('input');
      ninp.type = 'text';
      ninp.value = groupName(gid);
      ninp.title = 'Group name (shown in the Layers list)';
      ninp.onchange = () => {
        const v = ninp.value.trim();
        pushHistory();
        if (v) groupNames[gid] = v; else delete groupNames[gid];
        refreshPanels(); render();
      };
      nrow.appendChild(ninp);
      gb.appendChild(nrow);
    }
    const withFont = selIdx.filter((i) => s.widgets[i]._font || s.widgets[i].Shape === 30 || s.widgets[i].Shape === 31 || s.widgets[i].Shape === 32);
    const first = withFont.length ? s.widgets[withFont[0]] : s.widgets[selIdx[0]];
    const cur = (first._font && first._font.family) || project.font || '';
    const frow = mkRow('Font');
    const fsel = document.createElement('select');
    fillFontSelect(fsel, '');
    if (cur && ![...fsel.options].some((o) => o.value === cur)) {
      const o = document.createElement('option'); o.value = cur; o.textContent = `${cur} (missing)`; fsel.appendChild(o);
    }
    fsel.value = cur;
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
      // keep the group's font controls in view after the panel rebuilds
      const pb = $('props');
      if (pb) pb.scrollTop = 0;
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
    // single-image field: thumbnail + name button opening the same picker
    // dialog the digital layers use (with preview + upload). No dropdown.
    const imgRow = (labelText, key, title) => {
      const row = mkRow(labelText, title);
      const btn = document.createElement('button');
      btn.className = 'grow-btn imgbtn';
      const thumb = document.createElement('img');
      thumb.className = 'imgthumb-sm';
      const cur = s.images.find((im) => im.name === w[key]);
      // no src when empty — a broken-image icon is worse than no thumbnail
      if (cur) thumb.src = cur.url;
      else thumb.hidden = true;
      thumb.alt = '';
      const nm = document.createElement('span');
      nm.textContent = w[key] || 'Choose image…';
      btn.title = w[key] ? `${w[key]} — click to change` : 'Choose image (with preview)…';
      if (!w[key]) btn.classList.add('empty');
      else if (!cur) btn.classList.add('missing');
      btn.appendChild(thumb); btn.appendChild(nm);
      btn.onclick = () => openImgListDialog(w, key);
      row.appendChild(btn);
      return row;
    };
    grid.appendChild(imgRow('Background', 'BackgroundImage', 'Optional dial image, centred on the clock'));
    const div = document.createElement('div');
    div.className = 'prop-sep';
    grid.appendChild(div);
    for (const [imgKey, pxKey, pyKey] of CLOCK_HANDS) {
      const name = imgKey.replace('HandImage', '').replace('Image', '');
      grid.appendChild(imgRow(`${name} hand`, imgKey, 'Hand image; it rotates about its pivot'));
      // pivots use the usual row layout: label left, full-width value right
      const mkAxis = (key, label, axis) => {
        const row = mkRow(label);
        const inp = document.createElement('input');
        inp.type = 'number'; inp.value = w[key] || 0;
        inp.title = `Pivot ${axis} inside the hand image (scroll to step)`;
        inp.oninput = () => { w[key] = parseInt(inp.value, 10) || 0; render(); };
        row.appendChild(inp);
        return row;
      };
      grid.appendChild(mkAxis(pxKey, 'Pivot X', 'X'));
      grid.appendChild(mkAxis(pyKey, 'Pivot Y', 'Y'));
      // one Centre per axis, on its own compact row
      const crow = mkRow('Centre');
      const cwrap = document.createElement('div');
      cwrap.className = 'rowctl';
      const centreFor = (key, axis) => {
        const b = document.createElement('button');
        b.textContent = axis;
        b.title = `Set pivot ${axis} to the middle of the hand image`;
        b.onclick = () => {
          const im = s.images.find((x) => x.name === w[imgKey]);
          if (!im) return;
          pushHistory();
          w[key] = Math.round((axis === 'X' ? im.width : im.height) / 2);
          refreshPanels(); render();
        };
        return b;
      };
      cwrap.appendChild(centreFor(pxKey, 'X'));
      cwrap.appendChild(centreFor(pyKey, 'Y'));
      crow.appendChild(cwrap);
      grid.appendChild(crow);
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
    if (w[k] === undefined && k !== 'imgfmt') continue;
    if (k === 'imgfmt' && w.Shape !== 30) continue;
    const lab = mkRow(PROP_LABELS[k] || k);
    if (k === 'DataSrcValue' || k === 'DataSrcIndex') {
      const sel = document.createElement('select');
      const cur = String(w[k]);
      const { onDevice, others } = dataSrcOptions();
      const seen = new Set();
      const addOpt = (parent, code, label) => {
        if (seen.has(code)) return;
        seen.add(code);
        const o = document.createElement('option');
        o.value = code; o.textContent = label; o.title = code;
        parent.appendChild(o);
      };
      if (onDevice.length) {
        const g = document.createElement('optgroup');
        g.label = `On this watch (${onDevice.length})`;
        for (const [code, label] of onDevice) addOpt(g, code, label);
        sel.appendChild(g);
        if (others.length) {
          const g2 = document.createElement('optgroup');
          g2.label = 'Not on this watch';
          for (const [code, label] of others) addOpt(g2, code, label);
          sel.appendChild(g2);
        }
      } else {
        for (const [code, label] of DATASRC) addOpt(sel, code, label);
      }
      if (!seen.has(cur)) {
        const o = document.createElement('option');
        o.value = cur;
        o.textContent = DATASRC_LABEL[cur] ? `${DATASRC_LABEL[cur]} (not on this watch)` : `Unknown value (${cur})`;
        o.title = cur;
        sel.insertBefore(o, sel.firstChild);
      }
      sel.value = cur;
      sel.title = `Source code: ${cur}` + (DATASRC_LABEL[cur] ? '' : ' (not in the official table)');
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
    } else if (k === 'imgfmt') {
      const sel = document.createElement('select');
      sel.title = 'EasyFace image-format suffix. Note: the 8Pro family (Redmi Watch 5/6, S3/S4/S5, Mi Band 8/9 Pro) always stores RGBA in the .bin \u2014 the official packer ignores _RGB there. It matters for Mi Band 8 / Redmi Watch 3.';
      for (const [v, t] of [['', 'Auto (RGBA)'], ['RGBA', '_RGBA (32-bit)'], ['RGB', '_RGB (565, other families)']]) {
        const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o);
      }
      sel.value = w._fmt || '';
      sel.onchange = () => { if (sel.value) w._fmt = sel.value; else delete w._fmt; paintLayer(selected); render(); };
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
    fillFontSelect(fsel, '');
    if (f.family && ![...fsel.options].some((o) => o.value === f.family)) {
      const o = document.createElement('option'); o.value = f.family; o.textContent = `${f.family} (missing)`; fsel.appendChild(o);
    }
    fsel.value = f.family || '';
    fsel.onchange = () => {
      if (fsel.value === '__import') { pickAndImportFont(selected); fsel.value = f.family || ''; return; }
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
        const isDigitsPlusSign = f.glyphs.length === 11 && !/^[0-9]$/.test(String(f.glyphs[10].char));
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
  // A group (or any multi-selection) gets its own panel: name + font only.
  // A member's position/size/source rows describe that one layer, so they are
  // not mixed in here — click a single layer to edit those.
  if (groupBoxEl) P.appendChild(groupBoxEl);
  else { P.appendChild(info); P.appendChild(grid); }
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
  { id: 'km', label: 'Distance km (workaround)', sub: 'steps list, 500 km-steps' },
  { id: 'sign', label: 'Negative-sign frame', sub: 'add a sign image to this set' },
  { group: 'Extras' },
  { id: 'colon', label: 'Colon', sub: 'static', glyphs: [{ tag: 'colon', char: ':' }] },
  { id: 'colonblink', label: 'Colon (blink)', sub: 'blinks 1\u00d7/s', glyphs: [{ tag: 'colon', char: ':' }, { tag: 'colonOff', char: ' ' }] },
  { id: 'text', label: 'Custom text\u2026', sub: 'from the project font' },
  { id: 'importfont', label: 'Import font\u2026', sub: 'ttf / otf / woff' },
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
    Digits: digitCount, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: toDeviceSource(project.watchType, src),
    _srcCanonical: src,
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
    const canon = w2._srcCanonical || w2.DataSrcValue;
    w2.Name = uniqName(part.kind === 'colon' ? 'clock_colon' : (canon === '0811' ? 'clock_hour' : canon === '1011' ? 'clock_minute' : 'clock_second'), taken);
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
  if (p.id === 'importfont') { await pickAndImportFont(selected); return; }
  if (p.id === 'km') { applyKmPreset(); return; }
  if (p.id === 'sign') { addSignFrameToSelected(); return; }
  const s = slot();
  const taken = new Set(s.widgets.map((w) => w.Name));
  const font = project.font;
  // Colon (blink): a 10-frame list on the seconds digit. Even frames show the
  // colon, odd frames are blank, so it blinks at 1 Hz. Every frame gets its own
  // image (like a stock digit list, and like our own import which names one
  // image per frame); generating all ten glyphs in one call also guarantees they
  // share one box, which a list requires.
  if (p.id === 'colonblink') {
    if (!font) { $('meta').textContent = 'Set a Project font first (Project panel).'; return; }
    pushHistory();
    const specs = Array.from({ length: 10 }, (_, k) => ({ tag: `colonBlink${k}`, char: k % 2 === 0 ? ':' : ' ' }));
    let set10;
    try {
      set10 = await ensureGlyphSet(s, font, PRESET_SIZE, '#ffffff', false, false, specs, {});
    } catch (e) {
      $('meta').textContent = `Colon (blink): ${e.message}`;
      return;
    }
    const wg = {
      Shape: 31, Name: uniqName('colon_blink', taken), X: 0, Y: 0,
      Width: set10.width, Height: set10.height, Alpha: 255,
      DataSrcIndex: toDeviceSource(project.watchType, '1911'),   // second digit
      _srcCanonicalIndex: '1911', DefaultIndex: 0,
      BitmapList: specs.map((sp, k) => `(${k}):${set10.names[sp.tag]}`).join('|'),
      _preset: 'colonblink',
      _font: { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: specs.slice(), files: specs.map((sp) => set10.names[sp.tag]) },
    };
    const a = presetAnchor(wg.Width, wg.Height);
    wg.X = a.x; wg.Y = a.y;
    s.widgets.push(wg);
    selected = s.widgets.length - 1;
    groupSel = new Set([selected]);
    refreshPanels(); render();
    pushHistory();
    $('meta').textContent = 'Colon (blink) added: 10 frames on the seconds digit (one image per frame) \u2014 shows on even seconds, hides on odd (1 Hz).';
    return;
  }
  // glyphs this preset needs
  // EasyFace FAQ: the negative sign image is mandatory for digit widgets — we
  // always build 11 frames, using "-" for temperature-ish values and a copy of
  // "0" elsewhere (what EasyFace's own docs recommend).
  const signChar = p.signChar || (p.minusFrame ? '-' : '0');
  const digitSpec = [...DIGIT_GLYPHS, { tag: glyphTag(signChar), char: signChar }];
  const glyphs = p.glyphs || digitSpec;
  let set = null;
  if (font) {
    try { set = await ensureGlyphSet(s, font, PRESET_SIZE, '#ffffff', false, false, glyphs, { mono: !p.glyphs, uniqueFor: needsUniqueSets() ? p.id : null }); }
    catch (e) { $('meta').textContent = `Preset font failed: ${e.message}`; }
  }
  const gw = set ? set.width : Math.round(PRESET_SIZE * 0.6), gh = set ? set.height : Math.round(PRESET_SIZE * 1.2);
  pushHistory();
  if (p.glyphs) {
    // glyph-only preset (colon): a single image layer
    const onName = set ? set.names[p.glyphs[0].tag] : null;
    if (!onName) { $('meta').textContent = 'Set a Project font first (Project panel).'; return; }
    const wg = { Shape: 30, Name: uniqName(p.id, taken), X: 0, Y: 0, Width: gw, Height: gh, Alpha: 255, Bitmap: onName,
      _preset: p.id, _font: { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: p.glyphs.slice(), files: Object.values(set.names) } };
    const anchor = presetAnchor(wg.Width, wg.Height);
    wg.X = anchor.x; wg.Y = anchor.y;
    s.widgets.push(wg);
    selected = s.widgets.length - 1;
    groupSel = new Set([selected]);
    refreshPanels(); render();
    pushHistory();
    $('meta').textContent = 'Colon added.';
    return;
  }
  if (p.id === 'ampm' || (p.text && !font)) {
    // text-ish values: one image rendered from the sample text
    const anchor = presetAnchor(gw, gh);
    const wg = { Shape: 30, Name: uniqName(p.id, taken), X: anchor.x, Y: anchor.y, Width: gw, Height: gh, Alpha: 255, Bitmap: set ? set.names['0'] : '' };
    s.widgets.push(wg);
    selected = s.widgets.length - 1;
    groupSel = new Set([selected]);
    refreshPanels(); render();
    return;
  }
  const names = set ? glyphs.map((g) => set.names[g.tag]) : [];
  const wg = {
    Shape: 32, Name: uniqName(p.id, taken), X: 0, Y: 0, Width: gw, Height: gh, Alpha: 255,
    Digits: p.digits || 2, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: toDeviceSource(project.watchType, p.src), _srcCanonical: p.src,
    BitmapList: names.join('|'),
    _preset: p.id,   // marks the layer as preset-built (re-flow + glyph behaviour)
    _font: font ? { family: font, size: PRESET_SIZE, color: '#ffffff', glyphs: font && glyphs !== DIGIT_GLYPHS ? glyphs.slice() : undefined, files: names.slice() } : null,
  };
  const anchor = presetAnchor(wg.Width * wg.Digits, wg.Height);
  wg.X = anchor.x; wg.Y = anchor.y;
  s.widgets.push(wg);
  selected = s.widgets.length - 1;
  groupSel = new Set([selected]);
  refreshPanels(); render();
  if (!font) { $('meta').textContent = `${p.label} added \u2014 choose a font in Properties to generate the digits.`; return; }
  // extras (temperature: \u00b0 and \u2212) become their own layers next to the value
  for (const tag of p.extras || []) {
    let ex = null;
    try { ex = await ensureGlyphSet(s, font, PRESET_SIZE, '#ffffff', false, false, [{ tag, char: EXTRA_GLYPHS[tag] }], { mono: false, uniqueFor: needsUniqueSets() ? `${p.id}-${tag}` : null }); }
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

// Add a negative-sign frame to the selected digit layer's set (FAQ #9).
async function addSignFrameToSelected() {
  const s = slot();
  const w = s.widgets[selected];
  if (!w || (w.Shape !== 32 && w.Shape !== 31)) { $('meta').textContent = 'Select a Digital or ImageList layer first.'; return; }
  const f = w._font = w._font || {};
  if (!f.family) { $('meta').textContent = 'Pick a font for that layer first.'; return; }
  const spec = (f.glyphs && f.glyphs.length > 1) ? f.glyphs.slice() : [...DIGIT_GLYPHS];
  if (spec.length > 10 && spec[10] && spec[10].tag === 'minus') { $('meta').textContent = 'This set already has a sign frame.'; return; }
  const signChar = /2031|2032|2033|1831|1821/.test(String(w._srcCanonical || w._srcCanonicalIndex || w.DataSrcValue || w.DataSrcIndex)) ? '-' : '0';
  spec.push({ tag: glyphTag(signChar), char: signChar });
  f.glyphs = spec;
  await regenerateWidgetGlyphs(w, s);
  $('meta').textContent = 'Sign frame added (frame 10) — negative values now render it.';
}

// Distance in km is not supported by the watches; EasyFace's workaround is an
// ImageList driven by the step count with distance thresholds as its values.
function applyKmPreset() {
  if (!project) return;
  const s = slot();
  const taken = new Set(s.widgets.map((w) => w.Name));
  const anchor = presetAnchor(120, 30);
  const km = {
    Shape: 31, Name: uniqName('distance_km', taken), X: anchor.x, Y: anchor.y,
    Width: 40, Height: 25, Alpha: 255, DataSrcIndex: toDeviceSource(project.watchType, '0821'), DefaultIndex: 0,
    BitmapList: '', _preset: 'km', _kmValues: true,
  };
  pushHistory();
  s.widgets.push(km);
  selected = s.widgets.length - 1;
  groupSel = new Set([selected]);
  refreshPanels(); render();
  openImgListDialog(km);   // let the user pick/upload the km images right away
  $('meta').textContent = 'Distance km: add the km images (one per threshold), then Apply — values are filled automatically.';
}
// thresholds from EasyFace's distance_km example
const KM_THRESHOLDS = [0, 500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000, 13000, 14000];

// ---------- project lint (EasyFace-derived rules) ----------
// Weather icon index reference (EasyFace wiki, WeatherTableIT): 0-41.
const WEATHER_ICONS = ['Clear','Cloudy','Overcast','Showers','Thunderstorm','Hail','Sleet','Light rain','Moderate rain','Heavy rain','Thundery rain','Downpour','Severe storm','Snow','Light snow','Moderate snow','Heavy snow','Snowstorm','Mist','Freezing rain','Sandstorm','Light/moderate rain','Moderate/heavy rain','Heavy rain/thunder','Rainstorm/flood','Cloudburst','Light/moderate snow','Moderate/heavy snow','Heavy snow/blizzard','Dust','Windy','Sandstorm','Fog','Dense fog','Light haze','Moderate haze','Heavy haze','Severe haze','Fog','Severe fog','Not reported','Rain'];
// Devices whose watches cannot render the km data source (use the workaround).
const KM_UNSUPPORTED = [11, 362, 365, 367, 462, 465, 562, 565, 466, 567];
function lintProject() {
  const out = [];
  if (!project) return out;
  const push = (sev, msg) => out.push({ sev, msg });
  const dev = deviceByType(project.watchType);
  if (dev && dev.compilable === false) {
    push('warn', `${dev.name} is design/export only — the compiler has no writer for device ${dev.type}. Export and compile it with EasyFace.`);
  }
  project.slots.forEach((s, si) => {
    const where = project.slots.length > 1 ? `slot ${si}: ` : '';
    // referenced but missing images
    const used = new Set();
    for (const w of s.widgets) for (const n of widgetImageRefs(w)) used.add(n);
    for (const n of used) if (!s.images.some((im) => im.name === n)) push('error', `${where}image "${n}" is referenced by a layer but missing from the project.`);
    const unused = unusedImages(s);
    if (unused.length) push('info', `${where}${unused.length} unused image(s) — removed automatically on save/compile.`);
    // per-layer rules
    s.widgets.forEach((w) => {
      const nm = w.Name || '(unnamed)';
      if (w.Shape === 30 && /^btn_/i.test(nm) && !/\[[^\]]+\]/.test(nm) && !w._action) {
        push('error', `${where}"${nm}" looks like a tap button but has no [app] suffix and no action data.`);
      }
      if ((w.Shape === 32 || w.Shape === 31) && w.BitmapList) {
        const frames = listEntries(w);
        const f0 = s.images.find((im) => im.name === frames[0] && frames[0]);
        for (const e of frames) {
          const im = s.images.find((x) => x.name === e.name);
          if (im && f0 && (im.width !== f0.width || im.height !== f0.height)) {
            push('error', `${where}"${nm}": frames must share dimensions (${frames[0].name} is ${f0.width}×${f0.height}, ${e.name} is ${im.width}×${im.height}).`);
            break;
          }
        }
        if (w.Shape === 32 && frames.length === 10) {
          push('warn', `${where}"${nm}": no negative-sign frame — EasyFace requires one (usually a copy of "0"; "-" for temperature).`);
        }
        // a list keyed on a single digit ((ones)/(tens)) needs all 10 frames: the
        // watch shows frame = digit, falling back to the last frame for the rest
        const which = (CODE_FIELD[String(w.DataSrcIndex || '')] || [])[1];
        if (w.Shape === 31 && (which === 'ones' || which === 'tens') && frames.length < 10) {
          push('warn', `${where}"${nm}" is a list on a single digit but has only ${frames.length} frame(s) — digits above ${frames.length - 1} fall back to the last frame (a 2-frame "blink" colon this way only shows once every 10 s). Use 10 frames.`);
        }
        if (needsUniqueSets() && frames.length) {
          const shared = s.widgets.some((o) => o !== w && String(o.BitmapList || '') === String(w.BitmapList || ''));
          if (shared) push('warn', `${where}"${nm}": ${dev ? dev.name : 'this watch'} needs unique images per digit widget — two layers share the same set.`);
        }
      }
      const kmSrc = String(w.DataSrcValue || '') === '1821' || ['1051', '0851'].includes(String(w.DataSrcValue || ''));
      if (kmSrc && KM_UNSUPPORTED.includes(project.watchType)) {
        push('warn', `${where}"${nm}" uses a distance-km source; the watches don't render km — use the Distance km workaround preset (step thresholds).`);
      }
      if (String(w.DataSrcIndex || '') === '3031' || String(w.DataSrcIndex || '') === '5031') {
        const n = listEntries(w).length;
        if (n > 40) push('warn', `${where}"${nm}": ${n} weather icons — Mi Band 7 Pro supports at most 40 (20 on the global firmware).`);
      }
      // the source must exist on this watch (ids differ per device; see EasyFace's DeviceInfo.db)
      {
        const list = deviceSourcesFor(project.watchType);
        const code = String(w.DataSrcValue || '');
        if (list.length && code && !list.some((s) => s.id === code)) {
          push('warn', `${where}"${nm}": source ${code}${DATASRC_LABEL[code] ? ` (${DATASRC_LABEL[code]})` : ''} is not in ${dev ? dev.name : 'this watch'}'s data-source list — use the device-aware preset or pick "On this watch".`);
        }
      }
      if (w._fmt === 'RGB' && dev && dev.compilable) {
        push('info', `${where}"${nm}" is marked _RGB, but the ${dev.name} family always stores RGBA — the official packer ignores _RGB there.`);
      }
      if (w.X + w.Width <= 0 || w.Y + w.Height <= 0 || w.X >= project.screenW || w.Y >= project.screenH) {
        push('warn', `${where}"${nm}" is fully outside the ${project.screenW}×${project.screenH} screen.`);
      }
    });
    if (s.widgets.length && s.images.some((im) => im.name.startsWith('preview'))) push('info', `${where}an image named like the preview is part of the slot images.`);
  });
  if (project.slots.length > 1 && !project.slots.some((s) => s.aod)) push('warn', `${project.slots.length} slots: none flagged as AOD — slot 2+ compiles as a normal face (set the AOD slot to get an always-on variant).`);
  if (!project.slots.some((s) => s.widgets.length)) push('warn', 'the project has no layers yet.');
  return out;
}
function showLint() {
  const items = lintProject();
  const host = $('lintList');
  host.innerHTML = '';
  const icon = { error: '\u2715', warn: '\u26a0', info: '\u2139' };
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'lint-item info';
    d.textContent = 'No issues found.';
    host.appendChild(d);
  }
  for (const it of items.sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a.sev] - ({ error: 0, warn: 1, info: 2 })[b.sev])) {
    const d = document.createElement('div');
    d.className = 'lint-item ' + it.sev;
    d.textContent = `${icon[it.sev]}  ${it.msg}`;
    host.appendChild(d);
  }
  $('lintCount').textContent = items.length ? `(${items.length})` : '';
  $('lintModal').hidden = false;
}
$('btnLint').onclick = showLint;
$('lintClose').onclick = () => { $('lintModal').hidden = true; };
$('lintModal').addEventListener('mousedown', (e) => { if (e.target === $('lintModal')) $('lintModal').hidden = true; });

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
  groupSel = new Set([selected]);
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
    if (key === '__group') {
      const g = document.createElement('div');
      g.className = 'td-group';
      g.textContent = label;
      host.appendChild(g);
      continue;
    }
    const row = mkRow(label);
    if (key === 'is24h') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = TEST_DATA[key] != null && String(TEST_DATA[key]) !== '0';
      cb.setAttribute('data-td', key);
      cb.title = '24-hour clock: on = 18, off = 6';
      cb.onchange = () => { TEST_DATA[key] = cb.checked ? '1' : '0'; render(); };
      row.appendChild(cb);
      host.appendChild(row);
      continue;
    }
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
    if (inp.type === 'checkbox') { inp.checked = v !== '0' && v !== ''; return; }
    if (document.activeElement !== inp && inp.value !== v) inp.value = v;
    inp.disabled = useCurrentTime && TIME_FIELDS.includes(k);
  });
}
function setUseCurrentTime(on) {
  useCurrentTime = !!on;
  const cb = $('tdCurrent'); if (cb) cb.checked = useCurrentTime;
  if (useCurrentTime) {
    applyCurrentTime();
    if (!testTicker) testTicker = setInterval(() => { applyCurrentTime(); syncTestDataInputs(); render(); }, 1000);
  } else if (testTicker) {
    clearInterval(testTicker); testTicker = null;
  }
  syncTestDataInputs();
}
$('tdCurrent').onchange = () => { setUseCurrentTime($('tdCurrent').checked); render(); };

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
// Remove unused images. Called before save/compile (whole project) and from
// the panel button (current slot only, so the button count matches the panel).
function pruneUnusedImages(reason, slotOnly) {
  if (!project) return 0;
  // animation frames are not represented as widgets, so pruning would eat them
  if (project.animationCount || project.appCount) {
    $('meta').textContent = 'Skipped unused-image cleanup: this face has unsupported sections (animations/apps).';
    return 0;
  }
  let removed = 0;
  const targets = slotOnly ? [slot()] : project.slots;
  targets.forEach((s) => {
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
  // count only the current slot so the button agrees with the panel below it;
  // save/compile still clean the whole project
  const n = project ? unusedImages(slot()).length : 0;
  btn.disabled = !n;
  btn.textContent = n ? `Remove unused (${n})` : 'Remove unused';
  btn.title = 'Delete images no layer in this slot references (save/compile clean every slot)';
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
  else if (kind === 'num') w = { Shape: 32, Name: uniqName('widget_new', taken), X: cx - 40, Y: cy - 30, Width: 40, Height: 60, Alpha: 255, Digits: 2, Alignment: 0, Spacing: 0, Blanking: 1, DataSrcValue: toDeviceSource(project.watchType, '0811'), _srcCanonical: '0811', BitmapList: '' };
  else if (kind === 'list') w = { Shape: 31, Name: uniqName('widget_new', taken), X: cx - 30, Y: cy - 20, Width: 60, Height: 40, Alpha: 255, DataSrcIndex: toDeviceSource(project.watchType, '2012'), DefaultIndex: 0, BitmapList: '' };
  else if (kind === 'clock') w = { Shape: 27, Name: uniqName('analogClock_new', taken), X: 0, Y: 0, Width: W, Height: H, Alpha: 255, HourHandImage: '', HourImageRotateX: 0, HourImageRotateY: 0, MinuteHandImage: '', MinuteImageRotateX: 0, MinuteImageRotateY: 0, SecondHandImage: '', SecondImageRotateX: 0, SecondImageRotateY: 0 };
  else if (kind === 'btn') w = { Shape: 30, Name: uniqName('btn_new', taken) + '_[alarm]', X: cx - 30, Y: cy - 30, Width: 60, Height: 60, Alpha: 255, Bitmap: firstImg };
  else return;
  pushHistory();
  s.widgets.push(w);
  selected = s.widgets.length - 1;
  groupSel = new Set([selected]);
  refreshPanels(); render();
  // inherit the project font: generate (or reuse) the digit PNGs straight away
  if ((kind === 'num' || kind === 'list') && project.font) {
    w._font = { family: project.font, kind: customFonts.some((c) => c.family === project.font) ? 'custom' : 'bundled' };
    generateFontBitmaps(w, s);
  }
}
// Shared digit sets: identical font parameters reuse the same PNGs across
// layers, so a project font is generated once and every layer points at it.
function fontSetBase(family, size, color, bold, italic, uniqueFor) {
  const fam = String(family).replace(/[^\w]+/g, '-');
  const col = String(color || '#ffffff').replace('#', '');
  const uniq = uniqueFor ? `${String(uniqueFor).replace(/[^\w]+/g, '-')}_` : '';
  return `font_${uniq}${fam}_${size}${bold ? 'b' : ''}${italic ? 'i' : ''}_${col}`;
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
async function ensureGlyphSet(s, family, size, color, bold, italic, glyphs, { mono = true, uniqueFor = null } = {}) {
  const base = fontSetBase(family, size, color, bold, italic, uniqueFor);
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
// Mi Band 7 Pro / Mi Band 8 need unique images per digit widget (EasyFace):
// sharing one set makes the readings render wrong on those watches.
const UNIQUE_SET_DEVICES = [6, 9];
function needsUniqueSets() { return Boolean(project && UNIQUE_SET_DEVICES.includes(project.watchType)); }

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
  // focus without scrolling: focusing normally jumps the panel down and hides
  // the group font box at the top
  if (si) { si.focus({ preventScroll: true }); si.select(); }
}
// Regenerate whatever glyphs a layer actually uses. Digit layers produce 0-9;
// glyph layers (presets like Colon, or the °/- extras) regenerate exactly their
// own glyph(s), so changing size/colour can never blank them out.
async function regenerateWidgetGlyphs(w, s) {
  const f = w._font = w._font || {};
  const spec = f.glyphs;
  const uniq = needsUniqueSets() ? w.Name : null;
  if (!spec || !spec.length) return generateFontBitmaps(w, s);
  if (!f.family) { $('meta').textContent = 'Pick a font first.'; return; }
  const size = Math.max(8, f.size || w.Height || 60);
  const color = f.color || '#ffffff';
  $('meta').textContent = `Rendering ${spec.length > 1 ? `${spec.length} frames` : `"${spec[0].char}"`}\u2026`;
  let set;
  try {
    // multi-frame sets must share dimensions (the packer requires it)
    set = await ensureGlyphSet(s, f.family, size, color, !!f.bold, !!f.italic, spec, { mono: spec.length > 1, uniqueFor: uniq });
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
  // focus without scrolling: focusing normally jumps the panel down and hides
  // the group font box at the top
  if (si) { si.focus({ preventScroll: true }); si.select(); }
}

// Debounced auto-regenerate: every font/size/color/style change re-renders
// the PNG set (stale files are deleted inside generateFontBitmaps).
let fontGenTimer = null;
function queueFontGen(w) {
  clearTimeout(fontGenTimer);
  const s = slot();
  fontGenTimer = setTimeout(() => { if (project && s.widgets.includes(w)) regenerateWidgetGlyphs(w, s); }, 450);
}

// Full device catalog (core/watch.js via IPC) — the New-project dialog shows
// compilable families first, then the rest for design/unpack work.
let DEVICES = [];
async function loadDevices() {
  if (DEVICES.length) return DEVICES;
  try { DEVICES = await window.api.deviceCatalog(); } catch (e) { DEVICES = []; }
  try { DEVICE_INFO = await window.api.deviceInfo(); } catch (e) { DEVICE_INFO = null; }
  if (!DEVICES.length) {
    DEVICES = [{ type: 565, name: 'Redmi Watch 6', screen: [432, 514], preview: [259, 308], shape: 'rounded', compilable: true }];
  }
  return DEVICES;
}
function deviceByType(t) { return DEVICES.find((d) => d.type === t) || null; }
// preview size written on compile (full face, except the 565 thumbnail)
function devicePreview(t) {
  const d = deviceByType(t);
  return d ? { w: d.preview[0], h: d.preview[1] } : { w: project ? project.screenW : 432, h: project ? project.screenH : 514 };
}
function deviceSlot(d) {
  const o = document.createElement('option');
  o.value = String(d.type);
  const pv = d.preview.join('\u00d7');
  o.textContent = `${d.name} \u00b7 ${d.screen[0]}\u00d7${d.screen[1]}` + (pv !== `${d.screen[0]}\u00d7${d.screen[1]}` ? ` (${pv} preview)` : '');
  return o;
}
// ---------- device convert ----------
function resampleDataUrl(url, tw, th) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.max(tw, 1); c.height = Math.max(th, 1);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
async function convertResData(res, devType, fitMode) {
  const warns = [];
  const dev = deviceByType(parseInt(devType, 10));
  if (!dev) throw new Error(`Unknown device ${devType}.`);
  if (dev.type === res.watchType) return warns;
  let sx = dev.screen[0] / res.screenW, sy = dev.screen[1] / res.screenH;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) throw new Error('Cannot scale from unknown screen size.');
  const R = (v) => Math.round(v);
  // 'fit' keeps the aspect ratio (uniform scale, design centred); otherwise
  // each axis stretches to the new screen.
  let dx = 0, dy = 0;
  if (fitMode === 'fit') {
    const s = Math.min(sx, sy); sx = sy = s;
    dx = R((dev.screen[0] - res.screenW * s) / 2);
    dy = R((dev.screen[1] - res.screenH * s) / 2);
  }
  const SX = new Set(['Width', 'Spacing', 'HourImageRotateX', 'MinuteImageRotateX', 'SecondImageRotateX', '_firstBmpW']);
  const SY = new Set(['Height', 'HourImageRotateY', 'MinuteImageRotateY', 'SecondImageRotateY']);
  let imgs = 0, raws = 0;
  for (const s of res.slots) {
    for (const w of s.widgets) {
      for (const k of SX) if (Number.isFinite(w[k])) w[k] = R(w[k] * sx);
      for (const k of SY) if (Number.isFinite(w[k])) w[k] = R(w[k] * sy);
      if (Number.isFinite(w.X)) w.X = R(w.X * sx) + dx;
      if (Number.isFinite(w.Y)) w.Y = R(w.Y * sy) + dy;
      // 56B button blobs carry W/H at 52/54: keep them in sync with the box
      if (w._actionRaw && w._actionRaw.length === 112) {
        try {
          const b = Buffer.from(w._actionRaw, 'hex');
          b.writeUInt16LE(R(b.readUInt16LE(52) * sx), 52);
          b.writeUInt16LE(R(b.readUInt16LE(54) * sy), 54);
          w._actionRaw = b.toString('hex');
        } catch (e) { }
      }
      // value-driven widget raws embed unscaled coords: drop, packer rebuilds
      if (w._imgWidget && w._imgWidget.raw) { delete w._imgWidget.raw; raws += 1; }
      for (const f of ['DataSrcValue', 'DataSrcIndex']) {
        if (w[f] == null || w[f] === '') continue;
        const canon = w[f === 'DataSrcValue' ? '_srcCanonical' : '_srcCanonicalIndex'] || String(w[f]);
        const mapped = toDeviceSource(dev.type, canon);
        if (mapped !== String(w[f])) w[f] = mapped;
        if (f === 'DataSrcValue') w._srcCanonical = w._srcCanonical || String(canon);
        else w._srcCanonicalIndex = w._srcCanonicalIndex || String(canon);
      }
    }
    for (const im of s.images) {
      const tw = R(im.width * sx), th = R(im.height * sy);
      if (tw === im.width && th === im.height) continue;
      const url = await resampleDataUrl(im.url, tw, th);
      if (!url) { warns.push(`Could not resample ${im.name}.`); continue; }
      im.url = url; im.width = tw; im.height = th; imgs += 1;
      imgCache.delete(im.name);
    }
    // orphan tap zones keep their own anchor coords + any embedded W/H
    for (const r of (s.rawActions || [])) {
      if (Number.isFinite(r.x)) r.x = R(r.x * sx) + dx;
      if (Number.isFinite(r.y)) r.y = R(r.y * sy) + dy;
      if (r.blob && r.blob.length === 112) {
        try {
          const b = Buffer.from(r.blob, 'hex');
          b.writeUInt16LE(R(b.readUInt16LE(52) * sx), 52);
          b.writeUInt16LE(R(b.readUInt16LE(54) * sy), 54);
          r.blob = b.toString('hex');
        } catch (e) { }
      }
    }
    // per-slot preview (saved projects carry their own)
    if (s.previewUrl) {
      const dims = await new Promise((res2) => {
        const im = new Image();
        im.onload = () => res2({ w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res2(null);
        im.src = s.previewUrl;
      });
      if (dims) {
        const url = await resampleDataUrl(s.previewUrl, R(dims.w * sx), R(dims.h * sy));
        if (url) s.previewUrl = url;
      }
    }
  }
  if (res.previewUrl) {
    const dims = await new Promise((res2) => {
      const im = new Image();
      im.onload = () => res2({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res2(null);
      im.src = res.previewUrl;
    });
    if (dims) {
      const url = await resampleDataUrl(res.previewUrl, R(dims.w * sx), R(dims.h * sy));
      if (url) res.previewUrl = url;
    }
  }
  res.watchType = dev.type; res.watchName = dev.name;
  res.screenW = dev.screen[0]; res.screenH = dev.screen[1];
  res.compilable = dev.compilable !== false;
  // subVersion is device-specific (RW5 stock = 0/32/36/38): drop the echo so
  // the compiler picks the new device's default
  res.subVersion = null;
  if (raws) warns.push(`${raws} value-widget raw blob(s) dropped (rebuilt on compile).`);
  if (imgs) warns.push(`${imgs} image(s) resampled ${sx.toFixed(2)}×${sy.toFixed(2)} — lossy.`);
  return warns;
}
let convertCtx = null; // { res, sourceType, fileLabel, forImport }
async function openConvertDialog(ctx) {
  await loadDevices();
  convertCtx = ctx;
  const src = deviceByType(ctx.res.watchType);
  $('convTitle').textContent = ctx.forImport ? 'Import watchface' : 'Convert project';
  $('convFile').textContent = `${ctx.fileLabel} · ${ctx.res.screenW}×${ctx.res.screenH}` + (src ? ` · ${src.name}` : '');
  $('convModeRow').hidden = !!ctx.forImport;
  const sel = $('convDevice');
  sel.innerHTML = '';
  const addGroup = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const d of list) {
      const o = deviceSlot(d);
      if (d.type === ctx.res.watchType) o.textContent += ' · original';
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  addGroup('Compilable', DEVICES.filter((d) => d.compilable));
  addGroup('Other watches (design + export — compile with EasyFace)', DEVICES.filter((d) => !d.compilable));
  sel.value = String(ctx.res.watchType);
  $('convAspect').value = 'fit';
  updateConvScale();
  $('convGo').textContent = ctx.forImport ? 'Import' : 'Convert';
  $('convertModal').hidden = false;
}
function updateConvScale() {
  if (!convertCtx) return;
  const dev = deviceByType(parseInt($('convDevice').value, 10));
  const el = $('convScale');
  const same = !dev || dev.type === convertCtx.res.watchType;
  // no scaling choices when staying on the original device
  $('convScaleRow').hidden = same;
  $('convScale').hidden = same;
  if (same) return;
  let sx = dev.screen[0] / convertCtx.res.screenW, sy = dev.screen[1] / convertCtx.res.screenH;
  const fit = $('convAspect').value === 'fit';
  if (fit) { const s = Math.min(sx, sy); sx = sy = s; }
  el.textContent = `${convertCtx.res.screenW}×${convertCtx.res.screenH} → ${dev.screen[0]}×${dev.screen[1]}`
    + ` (×${sx.toFixed(2)}${fit ? ' fit' : ' ×' + sy.toFixed(2)}) · images resampled, lossy · undoable`;
}
async function runConvertDialog() {
  const ctx = convertCtx;
  if (!ctx) return;
  const target = parseInt($('convDevice').value, 10);
  const fitMode = $('convAspect').value;
  const copy = !ctx.forImport && document.querySelector('input[name=convMode]:checked').value === 'copy';
  $('convertModal').hidden = true;
  convertCtx = null;
  if (ctx.forImport) {
    if (target !== ctx.res.watchType) {
      const warns = await convertResData(ctx.res, target, fitMode);
      if (warns.length) $('meta').textContent = `Converted to ${deviceByType(target).name}: ${warns.join(' ')}`;
    }
    loadProject(ctx.res);
    return;
  }
  if (copy) {
    const clone = structuredClone(project);
    clone.base = `${clone.base}-copy`; clone.filePath = null;
    await convertResData(clone, target, fitMode);
    loadProject(clone);
    dirty = true;
    $('meta').textContent = `Converted copy on ${deviceByType(target).name} — original untouched.`;
    return;
  }
  pushHistory();
  await convertResData(project, target, fitMode);
  dirty = true;
  const dc = deviceByType(project.watchType);
  $('btnCompile').disabled = (dc && dc.compilable === false) || project.version !== 2;
  imgCache.clear();
  refreshPanels(); render();
  $('meta').textContent = `Converted to ${project.watchName} ${project.screenW}×${project.screenH} — undo restores the original.`;
}
async function openNewFaceDialog() {
  await loadDevices();
  const sel = $('newFaceDevice');
  sel.innerHTML = '';
  // Both groups are selectable: for the non-compilable families you can still
  // import, design and export (then compile with EasyFace) — only the built-in
  // Compile button is unavailable and says so.
  const addGroup = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const d of list) g.appendChild(deviceSlot(d));
    sel.appendChild(g);
  };
  addGroup('Compilable', DEVICES.filter((d) => d.compilable));
  addGroup('Other watches (design + export — compile with EasyFace)', DEVICES.filter((d) => !d.compilable));
  sel.value = DEVICES.some((d) => d.type === 565 && d.compilable) ? '565' : String((DEVICES.find((d) => d.compilable) || DEVICES[0]).type);
  $('newFaceName').value = 'My face';
  $('newFaceModal').hidden = false;
  setTimeout(() => $('newFaceName').select(), 0);
}
function createNewFace() {
  const dev = deviceByType(parseInt($('newFaceDevice').value, 10)) || DEVICES.find((d) => d.compilable) || DEVICES[0];
  const title = $('newFaceName').value.trim() || 'My face';
  $('newFaceModal').hidden = true;
  project = {
    base: title.replace(/[^\w\-]+/g, '_'), filePath: null,
    version: 2, watchType: dev.type, watchName: dev.name,
    screenW: dev.screen[0], screenH: dev.screen[1], title, faceId: '', compilable: dev.compilable !== false,
    previewUrl: null, subVersion: null,
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
  setUseCurrentTime(true);
  for (const id of ['btnExport', 'btnCompile', 'btnConvert', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = false;
  const dc = deviceByType(project.watchType);
  if (dc && dc.compilable === false) $('btnCompile').disabled = true;
  refreshPanels(); render();
  if (dev.compilable === false) $('meta').textContent = `${dev.name} is design/export only — the compiler does not support that family yet.`;
}
$('btnNew').onclick = () => { openNewFaceDialog(); };
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
  openConvertDialog({ res, fileLabel: `${res.base}.bin`, forImport: true });
};
$('convDevice').onchange = updateConvScale;
$('convAspect').onchange = updateConvScale;
$('convCancel').onclick = () => { $('convertModal').hidden = true; convertCtx = null; };
$('convGo').onclick = runConvertDialog;
$('convertModal').addEventListener('mousedown', (e) => { if (e.target === $('convertModal')) { $('convertModal').hidden = true; convertCtx = null; } });
$('btnConvert').onclick = () => {
  if (!project) return;
  openConvertDialog({ res: project, fileLabel: project.base || project.title || 'project', forImport: false });
};
async function loadProject(res) {
  await loadMaskMeta();
  if (res.groupSeq) groupSeq = res.groupSeq;
  if (res.groupNames) Object.assign(groupNames, res.groupNames);
  if (res.testData) TEST_DATA = { ...TEST_DEFAULTS, ...res.testData };
  setUseCurrentTime(res.useCurrentTime == null ? true : !!res.useCurrentTime);
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
  for (const id of ['btnExport', 'btnCompile', 'btnConvert', 'btnAddSlot', 'btnAddImg', 'btnAddNum', 'btnAddList', 'btnAddClock', 'btnAddBtn', 'btnUpload', 'btnPresets']) $(id).disabled = false;
  const dc = deviceByType(project.watchType);
  if (dc && dc.compilable === false) $('btnCompile').disabled = true;
  if (res.version !== 2) $('btnCompile').disabled = true;
  refreshPanels(); render();
}
$('btnAddImg').onclick = () => addWidget('img');
$('btnAddNum').onclick = () => addWidget('num');
$('btnAddList').onclick = () => addWidget('list');
$('btnAddClock').onclick = () => addWidget('clock');
$('btnAddBtn').onclick = () => addWidget('btn');
$('btnUpload').onclick = () => $('fileUpload').click();
$('btnPruneImages').onclick = () => pruneUnusedImages('removing', true);
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
// font import goes through pickAndImportFont() now
// Import a .ttf/.otf/.woff as a project font and/or the selected layer's font.
// Returns the registered family name, or null on failure.
async function importFontFile(file, { projectWide = false, layerIndex = -1 } = {}) {
  if (!file || !project) return null;
  const buf = await file.arrayBuffer();
  const family = 'Custom-' + String(file.name || 'font').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_');
  try {
    const ff = new FontFace(family, buf);
    await ff.load();
    document.fonts.add(ff);
    await document.fonts.ready;
  } catch (e) {
    $('meta').textContent = `Could not load ${file.name}: ${e.message}`;
    return null;
  }
  if (!customFonts.some((c) => c.family === family)) customFonts.push({ family, buf, fileName: file.name });
  // persist app-wide so the font survives restarts and is available in any project
  try { await window.api.fontSave({ family, fileName: file.name, dataBase64: bufToBase64(buf) }); } catch (e) { /* non-fatal */ }
  // sanity: the generator needs digits
  const meas = document.createElement('canvas').getContext('2d');
  setFontOn(meas, family, 100);
  const hasDigits = '0123456789'.split('').every((d) => meas.measureText(d).width > 1);

  pushHistory();
  let target = null;
  if (layerIndex >= 0) {
    const w = slot().widgets[layerIndex];
    if (w) {
      w._font = w._font || {};
      w._font.family = family;
      w._font.kind = 'custom';
      target = w;
    }
  }
  if (projectWide || !target) project.font = family;
  updateProjFontSelect();
  refreshPanels(); render();
  $('meta').textContent = `Imported "${family}"` + (hasDigits ? '' : ' — warning: no 0-9 glyphs, digit tiles will be empty')
    + (target ? ` and applied it to ${target.Name}` : ' as the project font');
  if (target && (target.Shape === 31 || target.Shape === 32)) await regenerateWidgetGlyphs(target, slot());
  return family;
}

// pick a font with the native dialog (no <input accept> filtering issues)
async function pickAndImportFont(layerIndex) {
  if (!project) return null;
  $('meta').textContent = 'Choose a font file…';
  let picked = null;
  try { picked = await window.api.pickFont(); } catch (e) { picked = null; }
  if (!picked) { $('meta').textContent = 'Font import cancelled.'; return null; }
  const buf = base64ToBuf(picked.dataBase64);
  const file = new File([buf], picked.name, { type: 'font/ttf' });
  return importFontFile(file, { projectWide: true, layerIndex: typeof layerIndex === 'number' ? layerIndex : -1 });
}
$('inpTitle').onchange = (e) => { if (project) project.title = e.target.value; };
$('inpTitle').addEventListener('focus', pushHistory);
$('inpTitle').addEventListener('pointerdown', pushHistory);
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
// ---------- keyboard nudge ----------
// Arrow keys move the selection by 1px, Shift+arrow by 10px (Alt+arrow still
// reorders layers). One undo entry per burst, so holding a key down doesn't fill
// the history, and the panels catch up once the key repeat stops.
const NUDGE_KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
let nudgeAt = 0;
let nudgeTimer = null;
function nudgeHistory() {
  const now = Date.now();
  if (now - nudgeAt > 600) pushHistory();
  nudgeAt = now;
}
function nudgeRender() {
  render();
  paintLayer(selected);
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { nudgeTimer = null; refreshPanels(); }, 200);
}
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
  if (project && !inField && !e.altKey && !e.ctrlKey && !e.metaKey && NUDGE_KEYS[e.key]) {
    // an open dialog owns the keyboard
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;
    const ss = slot();
    // same rule as dragging: the whole group / multi-selection moves together,
    // a single child moves on its own; locked layers stay put
    const ids = (groupSel.size ? [...groupSel] : [selected]).filter((i) => ss.widgets[i] && !ss.widgets[i]._locked);
    if (!ids.length) return;
    e.preventDefault();
    const [dx, dy] = NUDGE_KEYS[e.key];
    const step = e.shiftKey ? 10 : 1;
    nudgeHistory();
    for (const i of ids) {
      const w2 = ss.widgets[i];
      w2.X = (w2.X || 0) + dx * step;
      w2.Y = (w2.Y || 0) + dy * step;
    }
    nudgeRender();
    return;
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
  const cd = deviceByType(project.watchType);
  if (project.compilable === false || (cd && cd.compilable === false)) {
    $('meta').textContent = `${project.watchName} is design/export only \u2014 the compiler has no writer for that family yet (${deviceByType(project.watchType) ? '[11,362,365,367,462,465,562,565]' : ''}). Use Export/Save and compile with EasyFace.`;
    return;
  }
  // save first so the .bin always matches an on-disk project
  $('meta').textContent = 'Saving…';
  const saved = await saveProject();
  if (!saved) { $('meta').textContent = 'Compile cancelled (project not saved).'; return; }
  pruneUnusedImages('compiling');
  $('meta').textContent = 'Compiling…';
  // new faces/slots have no decoded preview: compose each from the canvas at
  // the device's preview size (full face, except the 565 thumbnail)
  const pv = devicePreview(project.watchType);
  const pvW = pv.w, pvH = pv.h;
  const slots = [];
  for (let i = 0; i < project.slots.length; i++) {
    const s = project.slots[i];
    slots.push({
      widgets: s.widgets,
      rawActions: s.rawActions || [],
      aod: Boolean(s.aod), aodFlag: s.aodFlag >>> 0,
      previewOffset: s.previewOffset >>> 0, nameBlock: s.nameBlock || null,
      orphanSec9: s.orphanSec9 || [],
      images: s.images.map((im) => ({ name: im.name, dataBase64: im.url.split(',')[1], origBlob: im.origBlob || null, rgbaHash: im.rgbaHash || null, listEnc: im.listEnc || null })),
      previewBase64: await slotPreviewB64(i, pvW, pvH),
    });
  }
  const res = await window.api.compileBin({
    defaultBase: project.base, title: $('inpTitle').value || project.title || project.base,
    deviceType: project.watchType, faceId: project.faceId || '',
    animationCount: project.animationCount || 0, appCount: project.appCount || 0,
    subVersion: project.subVersion != null ? project.subVersion : null,
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
    testData: TEST_DATA, useCurrentTime, subVersion: project.subVersion != null ? project.subVersion : null,
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
// Topmost visible layer under a client point (canvas coordinates, like the drag
// path). Used by the drag and by double-click drill-in.
function hitWidget(clientX, clientY) {
  if (!project) return -1;
  const r = cv.getBoundingClientRect();
  const sc = cv.width / (project.screenW || 240);
  const mx = (clientX - r.left) * (cv.width / r.width), my = (clientY - r.top) * (cv.height / r.height);
  const s = slot();
  for (let i = s.widgets.length - 1; i >= 0; i--) {
    if (s.widgets[i]._hidden) continue;
    const vb = visualBox(s.widgets[i]);
    const x = vb.x * sc, y = vb.y * sc, ww = vb.w * sc, hh = vb.h * sc;
    if (mx >= x && mx <= x + ww && my >= y && my <= y + hh) return i;
  }
  return -1;
}
// Double-clicking a layer picks it out of a group/multi-selection, so the group
// stops being selected and the child can be moved or edited on its own.
cv.addEventListener('dblclick', (e) => {
  if (!project) return;
  const i = hitWidget(e.clientX, e.clientY);
  if (i < 0) return;
  const s = slot();
  if (s.widgets[i]._locked) return;
  selected = i; groupSel = new Set([i]);
  refreshPanels(); render();
});
cv.addEventListener('mousedown', (e) => {
  if (!project) return;
  const r = cv.getBoundingClientRect();
  const sc = cv.width / (project.screenW || 240);
  const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
  const s = slot();
  let hit = -1;
  for (let i = s.widgets.length - 1; i >= 0; i--) {
    if (s.widgets[i]._hidden) continue;
    const vb = visualBox(s.widgets[i]);
    const x = vb.x * sc, y = vb.y * sc, ww = vb.w * sc, hh = vb.h * sc;
    if (mx >= x && mx <= x + ww && my >= y && my <= y + hh) { hit = i; break; }
  }
  if (hit < 0) return;
  if (s.widgets[hit]._locked) return;
  // Ctrl/Cmd-click on the canvas toggles multi-selection (like the layer list)
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (groupSel.has(hit)) groupSel.delete(hit); else groupSel.add(hit);
    selected = hit;
    refreshPanels(); render();
    return;
  }
  {
    const i = hit;
    const vb = visualBox(s.widgets[i]);
    const x = vb.x * sc, y = vb.y * sc;
    pushHistory();
    // Dragging follows the selection. Clicking a layer that is not selected
    // selects just it, so it moves on its own; clicking one that is already
    // selected keeps the selection — select a group (its row or ◉), or
    // Ctrl/Cmd-click several layers, to move them together.
    if (!(selected === i || groupSel.has(i))) { selected = i; groupSel = new Set([i]); }
    refreshPanels(); render();
    const primary = s.widgets[i];
    const mates = [...groupSel]
      .filter((k) => k !== i && s.widgets[k] && !s.widgets[k]._locked)
      .map((k) => s.widgets[k]);
    drag = {
      dx: mx - x, dy: my - y, primary, ox: primary.X || 0, oy: primary.Y || 0,
      mates: mates.map((o) => ({ o, x: o.X || 0, y: o.Y || 0 })),
    };
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
  // the rest of the selection keeps its offsets: move it by the same delta
  const ddx = w.X - drag.ox, ddy = w.Y - drag.oy;
  for (const m of drag.mates || []) { m.o.X = Math.round(m.x + ddx); m.o.Y = Math.round(m.y + ddy); }
  render();
  paintLayer(slot().widgets.indexOf(w));
});
setEmptyState();
loadMaskMeta();
loadDevices();
loadSavedFonts().then(() => { buildPresetsMenu(); });

window.addEventListener('mouseup', () => { if (drag) { drag = null; guides = { v: [], h: [] }; if (project) { refreshPanels(); render(); } } });
