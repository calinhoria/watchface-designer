# Watchface Designer (Electron, cross-platform)

Port of [UnpackMiColorFace](https://github.com/kindyear/UnpackMiColorFace) (.NET, Windows-only, Magick.NET)
to a pure-JS Electron app that runs on **macOS, Windows, Linux**.

## What it does
- Open Xiaomi watchface `.bin` (v1/v2/v3 magic detection, same as `Unpacker.cs`)
- Detect watch (`WatchDetector` + `WatchScreen` tables ported: Gen1/Gen2/Gen3, Redmi Watch 2/3/4, Mi Band 7 Pro/8/8 Pro/9, Mi Watch S3, RedmiWatch3Active…)
- Decode images without native deps (RLE v10/v11/v20, RGB565→RGBA, indexed8+palette, RedmiWatch3Active sparse codecs ported from `XiaomiWatch.Common` IL)
- Tap actions on any layer (Properties → Tap action). Formats match stock exactly:
  - **Image layer → button**: element targets the action, action blob is the official 56-byte RedmiWatch4ActionPacker template (image + W×H bound). All 37 apps.
  - **Other layers → tap zone**: 56-byte blob with the app jump code at `+40` (byte-verified against the stock `neon-night` face), a `kind | id` dword at `+48` (kind 2 = position-only, no button image) and the tap box W×H at `+52/+54` — the shape every stock tap blob in the corpus uses. Verified codes exist for the zone apps (alarm, timer, music, flashlight, steps, calories, hrm, spo2, weather) plus the jump codes read out of stock faces (weather, activities, heartrate); the rest need an image layer.
  - Tap elements are appended after widget elements in `sec0`, matching stock draw/priority order.
- **Unused images** are detected continuously and shown dimmed + tagged `unused` in Project images, with a `Remove unused (N)` button. They are removed automatically before **save** and **compile** (undo toast lets you take it back). Hidden layers count as referenced, so hiding a layer never costs its images.
- `Images` row (image, list and digital layers) opens a helper dialog: the raw filename field is gone — image layers show a `1 image…` button (filename on hover); list/digital layers get indexed entries, custom value per entry (list layers), add from project images or upload new files, drag to reorder
- **Upload fit dialog**: any upload (the toolbar `Upload` and the Images dialog's `Upload…`) opens a helper that previews the picture inside the watch screen and offers three ways in: **As is** (original pixels, nothing resized), **Cover** (scaled to fill the screen; drag the picture under the frame to pick which part shows) and **Contain** (scaled so its *width* matches the screen, height follows). The result size is shown live, the last choice is remembered while you work, and the chosen fit is written to the layer. Digit/list frames skip it — every frame must be the same size for the format to work, so they are cropped to the cell box.
- **Data sources**: the authoritative EasyFace enum (118 codes: time/date/lunar/weekday-month name strings, step digits, HR zone/min/max, SpO2, stress, blood pressure, sleep score/goal, exercise, vitality, sunrise/sunset, feels-like, humidity, wind, AQI, rain, visibility, UV, dress index, today/tomorrow min–max, battery/charging/DND/BT/WiFi/lock, altitude, alarm) mapped to widget codes, plus legacy vendor codes kept as aliases. Several previously wrong labels were corrected (`0851` = Alarm hour, `0825` = Blood oxygen, `0824` = Stand, `1821` = Distance km, `D031` = °F)
- **Test data** panel: 39 editable preview values in groups (Time / Date / Health / Weather / System) (hour, minute, second, AM/PM, month, day, weekday, steps, steps %, heart rate, HR interval, calories, calories %, distance m/km, activity, stress, sleep, battery, charging, weather °C/°F, weather type, air quality) plus a **Current time** checkbox that drives the time/date fields from the real clock (live, 1 s) while leaving the rest editable. The preview digits and the clock pose both read from it; values persist in `designer.json`
- Analog clock: Properties exposes the dial image plus each hand (image + pivot X/Y, with a `Centre` shortcut; picking a hand auto-centres its pivot). The preview renders hands **rotated about their pivots** at the clock centre using a demo pose of 10:09:36, and the geometry matches the compiled elements exactly (`centre − pivot`)
- Digital-layer fields: `Alignment` (runtime align on the watch, Left/Center/Right), `Spacing` (px between digits), `Blanking` (hide leading zeros) — all three are compiled into the .bin and the preview reflects Spacing and Blanking directly. Blanking is **device-verified**: `Hide leading zeros` checked = the compiled bit4 is clear (08:45 → 8:45); unchecked keeps the zeros. New layers default to hidden zeros
- Grid mode (toolbar toggle, **on by default**): 20px grid, screen center cues, alignment guides, and drag snapping (left/center/right vs. other layers' edges+centers and the grid)
- Properties rows are aligned on a fixed label column; `DataSrcValue` is shown as **Shows** (source code on hover); `Delete`/`Backspace` removes the selected layer (undo toast)
- **Resizing a preset group**: setting the size on the **group** (or on a single child for tweaking) regenerates every child's glyphs — including the 11-frame digit list's minus frame — and **re-flows the layout** so the reading keeps its spacing and short layers (colon, degree) stay vertically centred
- **Group font editing**: with 2+ layers selected, Properties shows a group box (family, size, colour, bold/italic + `Apply to group`, `Ungroup`, `Lock all`, `Unlock all`) that rewrites every child's font and regenerates its glyphs in one go, **keeping the group selected** and the panel scrolled to the group controls afterwards (glyph regeneration restores focus without scrolling, so the font box can't be pushed out of view); clicking a member of a selected group keeps the whole group selected (Ctrl/Cmd-click still narrows to single layers for tweaking)
- **Distance km workaround preset**: the watches can't render km, so EasyFace's approach is an ImageList on the step count with threshold values — `Distance km (workaround)` creates it and the Images dialog's `Distance values` button fills 0, 500, 1000 … 14000
- **ImageList index origins**: hints in the dialog (weekday index 0 = Sunday, month index 1 = January, percentage = reading thresholds); the clock-driven weekday now follows the 0 = Sunday convention
- **Value-mapped image lists**: percentage rings (`(0):0% | (10):10% | … | (100):100%`) and similar now pick their frame from the test data — largest value ≤ the reading — instead of always drawing frame 0. Battery/steps percentages preview correctly (10 → "10%", 77 → "70%", 100 → "100%")
- **Negative-sign frame (mandatory per EasyFace FAQ #9)**: digit presets always build 11 frames — a copy of `0` for normal values, `-` for temperature/altitude/distance — verified against stock faces (a real digital-hour face ships frame 10 as a digit copy; a temperature list ships it as a short bar). `Add sign frame` in the Images dialog converts an existing 10-frame set
- **Negative values (solved)**: stock digit lists carry **frame 10 = the minus sign** (verified on a stock Redmi Watch 5 face: frame 10's ink box is 13x4, a bar, vs 12x39 digits). The Temperature preset builds an 11-frame list (0-9 + minus) plus the `°` as its own layer, and the preview renders frame 10 for negative test values.
- **Grouping**: Ctrl/Cmd+click layer rows to multi-select, then `Ctrl+G` (or the ⧉ button) groups them — grouped layers drag as one unit keeping their relative offsets; `Ctrl+Shift+G` ungroups. In the Layers panel a group renders as a **collapsible header** with its members indented beneath: `▾ [name] 3 layers ◉ ⤡`. The name is editable inline (default `Group N`) and persisted in `designer.json` (`groupNames`), clicking the header selects the whole group (same as ◉), and ⤡ ungroups. Groups and the group counter persist in `designer.json` (`groups`, `groupSeq`).
- **Lock**: the padlock on a layer row prevents dragging, canvas selection and Delete-key removal (unlock to move it again). Persisted too.
- Designer: canvas preview (watch name above it), collapsible panels (max-height 600 with scroll; `Project images` sits under Layers on the left and starts collapsed), layers (add / drag-reorder via handle / hide / delete inline, Alt+↑↓ also reorders), drag-move, property editor (incl. tap actions ⚡), title edit, undo/redo (toolbar + Ctrl+Z / Ctrl+Shift+Z)
- New watchface: toolbar `New` button → device picker (8 supported devices) + name field → blank face at the right screen size (preview auto-composed from canvas on compile)
- **Project** panel (was Slots): slot chips, Title, **Project font**, screen info and **Close project**
  - Project font (bundled or imported) is the default for new digital/list layers — adding `Digital` with a project font set generates the 0–9 digit PNGs immediately. Persisted in `designer.json`.
  - Digit sets are **shared by font parameters**: identical family/size/color/bold/italic layers point at the same PNGs (generated once, reused by every later layer). Customising size/color gives that layer its own set and leaves the shared one intact; shared images are never deleted from under another layer.
  - Close project clears the editor, warns when there are unsaved changes, and returns to the empty state.
  - `+` adds a slot with a role dialog (Face / AOD); each chip has a remove (`✕`) button, at least one slot is kept.
- Destructive actions (delete layer/image/slot, replacing a BitmapList) are no longer blocking prompts: they apply immediately and offer an undo toast with a close icon, auto-dismissed after 10s (countdown pauses on hover)
- Open: reopen a saved project folder (`.fprj` + `images/`, plus `AOD/` `AOD2/`…); remembers the folder so Save overwrites in place
- Images: PNG upload, per-image delete (with usage check)
- Fonts → digits: pick one of 17 bundled OFL Google fonts, or import your own `.ttf/.otf/.woff` (`Presets → Import font…`, or `Font → Import custom…` on a layer). Imported fonts are applied immediately (project font and/or the selected layer), sanity-checked for 0-9 glyphs, copied into the app's own font library (`userData/fonts`) so they are available in every session and project, and also saved with a project under `fonts/`. The picker is the native file dialog (no HTML `accept` filtering), and the font list is grouped: `Import font…` on top, then **Bundled** and **Imported**. Digit/tile generation supports size, colour and faux bold/italic, auto-regenerates on change, and removes stale tiles.
- Save: `images/*.png` + `<name>.fprj` (FaceProject XML, same attrs as C# `Serialize()`) + composed `preview.png`; extra slots go to `AOD/` `AOD2/`… Stale images are pruned on re-save. First save asks for a folder, later saves reuse it.
- **Save before compile**: compiling saves the project first (folder picker on the first save, silent afterwards) so the `.bin` always matches an on-disk project; cancelling the save aborts the compile
- **Preview regeneration**: untouched imported faces keep their device-accurate embedded thumbnail; once edited, save/compile recompose the preview from the current canvas (clean render — no grid, guides, selection box or tap markers)
- Font metadata (family, size, color, bold/italic, generated files) and hidden-layer flags are stored in a sidecar `designer.json` — `.fprj` stays clean for official tools. Imported custom fonts are copied to `<project>/fonts/` so digit regeneration keeps working after reopening.
- **Compile `.bin`**: rebuild an installable V2 face from the designer project (port of the official `Compiler.exe` `DefaultPacker`, pure JS). The output is re-unpacked and verified automatically before saving.

No BMP/Magick round-trip: RGBA goes straight to PNG via `pngjs` (pure JS, no native modules → `electron-builder` works everywhere).

## Run
```bash
npm install
npm start        # UI styling is pre-built (styles.css compiled from styles-src.css)
npm run css      # rebuild styles.css after editing styles-src.css (Tailwind v4 CLI, offline)
```

Presets (toolbar) drop in the usual blocks at 100px by default — **Digital clock** (12:45) and **Digital clock + seconds** build the whole reading from one font/size as a *grouped* set (hour, colon, minute [, colon, second]) with the colon vertically centred; Hour, Minutes, Seconds, AM/PM, Day, Month, Weekday, Steps, Heart rate, Calories, Battery, Temperature (11 frames: 0-9 + minus, `°` as its own grouped layer), Colon (static or 2-frame blink, experimental), Custom text. They inherit the **Project font** (no font set = the layer is created and digits appear once you pick one). Preset layers carry a `_preset` tag and remember their **glyph spec**: changing size, colour, bold/italic or the Glyph character regenerates *that* glyph (or the 2 blink frames) instead of falling back to 0-9, and the image name follows the character so a new glyph never reuses an old PNG. Glyph specs and preset tags persist in `designer.json`. Glyph sets are keyed by font parameters and shared, so presets reuse the same PNGs; Temperature adds its `°` and `−` glyphs as their own images (`−` is created hidden, ready for negative values).

Layout: columns scroll internally, the page never scrolls, and the preview is sticky at the top so expanding Test data or any panel can't push it off-screen.

Preview: clipped to a per-device display mask. `assets/masks/<type>.svg` is generated from the screen dimensions and a corner-radius profile by `npm run masks` (round watches = circle, bands/Watch 4-6 = rounded rect) — drop real vendor artwork at the same path to override. A `Mask` toolbar toggle turns clipping off for pixel-accurate work.

The preview has no outer panel/border — just the device placeholder frame. With no project open every panel disappears and the editor shows a centered empty state (New project / Open project / Import .bin) with the **last 5 projects** listed underneath (recorded on open/save in `userData/recent-projects.json`). Folders that no longer exist are pruned at startup, so the list only shows projects you can actually open instead of an empty preview.

UI: Tailwind v4 (bundled/compiled at build time, no runtime CDN). Design tokens
live in `styles-src.css` (@theme: bg/panel/line/ink/mut/acc). Toolbar: New |
undo/redo | Import/Open · Save (Ctrl+S) | add-tools group (Img/Digital/List/Clock/Btn/PNG)
| **Presets** menu | primary Compile on the right (saves the project first, then compiles). Grid toggle lives in the add-tools group.

## Package
```bash
npm run dist        # current OS
npm run dist-mac / dist-win / dist-linux
```

## Project check (lint)
`Check` in the Project panel runs the EasyFace-derived rules over every slot:
missing referenced images, frames with mismatched dimensions, digit sets without
the mandatory negative-sign frame, `btn_` layers with no action, km data sources
(watches cannot render km), weather lists over 40 icons, layers off-screen,
`_RGB` on families that always store RGBA, unused images, and AOD flattening for
multi-slot projects. Results are grouped by severity (✕ error / ⚠ warn / ℹ info).
Stock faces lint clean apart from genuinely unused images.

## Image formats (`_RGB` / `_RGBA`)
EasyFace selects the stored format with a `_RGB` / `_RGBA` suffix on the widget
`Name` (and the preview filename). We keep that convention in the model, write it
on `.fprj` export, parse it back, and expose an `Image fmt` property on image
layers. **But** the byte-level format is decided by the watch family, verified
against the official compressors: Redmi Watch 5/6, Mi Watch S3/S4/S5 and Mi Band
8/9 Pro (our compilable family) always store 32-bit RGBA — `RepackRgbaToRgb565`
never runs for them, so `_RGB` there is ignored (the lint says so). RGB565 is used
by Mi Band 8 / Redmi Watch 3 when alpha is off, and Mi Band 9 uses 3 bytes/px —
all design-only in this app.

## Weather icons
`ImageList` on the weather-icon source (`3031`): index = weather type, 0–41.

| | | | |
|---|---|---|---|
|0 Clear|1 Cloudy|2 Overcast|3 Showers|
|4 Thunderstorm|5 Hail|6 Sleet|7 Light rain|
|8 Moderate rain|9 Heavy rain|10 Thundery rain|11 Downpour|
|12 Severe storm|13 Snow|14 Light snow|15 Moderate snow|
|16 Heavy snow|17 Snowstorm|18 Mist|19 Freezing rain|
|20 Sandstorm|21 Light/moderate rain|22 Moderate/heavy rain|23 Heavy rain/thunder|
|24 Rainstorm/flood|25 Cloudburst|26 Light/moderate snow|27 Moderate/heavy snow|
|28 Heavy snow/blizzard|29 Dust|30 Windy|31 Sandstorm|
|32 Fog|33 Dense fog|34 Light haze|35 Moderate haze|
|36 Heavy haze|37 Severe haze|38 Fog|39 Severe fog|
|40 Not reported|41 Rain|||

Mi Band 7 Pro supports at most 40 icons (20 on the global firmware). The Images
dialog shows the first icons inline for weather lists.

## Device-specific quirks
- **Mi Band 7 Pro (6) and Mi Band 8 (9)** need **unique images per digit widget**
  (sharing one set renders readings wrong) and prefer the High/Low data sources.
  When such a face is open the generator switches to per-widget image sets
  automatically (`font_<layer>_<font>_<size>…`).
- **Distance in km** cannot be rendered by any watch; use the `Distance km
  (workaround)` preset (step-threshold ImageList).
- **Animations** (`anim_[xx@yy]`) do not work on Mi Band 8 / Mi Band 7 Pro Global.

## Supported devices
Catalog shared by the app and the compiler (`core/watch.js` → `DeviceCatalog`),
built from the EasyFace wiki resolution table, the Mi Fitness device list and the
official `XiaomiWatch.Common` enums. The per-device data-source ids, widget
shapes and animation/event types come from EasyFace's own `DeviceInfo.db`
(`npm run deviceinfo` regenerates `data/device-info.json`); the data-source
picker is filtered to the watch you are designing for, presets are re-pointed
to that watch's ids, and the project check warns about sources it does not have. `New` shows compilable families first; the
rest can be designed and exported (compile with EasyFace) — both groups are
**selectable**; the built-in Compile button is just disabled for those families
and says why. `npm run masks` regenerates a display mask per device.

| ID | Device | Screen | Preview | Shape | Compile |
|---|---|---|---|---|---|
| 1 | Xiaomi Watch Color | 454×454 | 234×234 | round | – |
| 3 | Xiaomi Watch Color 2 / S1 | 466×466 | 246×246 | round | – |
| 4 | Xiaomi Watch S1 Pro | 480×480 | 280×280 | round | – |
| 5 | Redmi Watch 2 | 320×360 | 178×200 | rounded | – |
| 6 | Mi Band 7 Pro | 280×456 | 220×358 | rounded | – |
| 7 | Redmi Watch 3 | 390×450 | 234×270 | rounded | – |
| 8 | Redmi Band Pro | 368×456 | 110×208 | rounded | – |
| 9 | Mi Band 8 | 192×490 | 122×310 | rounded | – |
| 10 | Redmi Watch 2 Lite | 320×360 | 178×200 | rounded | – |
| 11 | Mi Band 8 Pro | 336×480 | 230×328 | rounded | ✅ |
| 12 | Redmi Watch 3 Active | 240×280 | 156×182 | rounded | – |
| 362 | Mi Watch S3 | 466×466 | 326×326 | round | ✅ |
| 365 | Redmi Watch 4 | 390×450 | 234×270 | rounded | ✅ |
| 366 | Mi Band 9 | 192×490 | 122×310 | rounded | – |
| 367 | Mi Band 9 Pro | 336×480 | 230×328 | rounded | ✅ |
| 462 | Mi Watch S4 | 466×466 | 326×326 | round | ✅ |
| 465 | Redmi Watch 5 | 432×514 | 432×514 | rounded | ✅ |
| 466 | Mi Band 10 | 212×520 | 212×520 | rounded | – |
| 562 | Mi Watch S5 | 480×480 | 480×480 | round | ✅ |
| 565 | Redmi Watch 6 | 432×514 | 259×308 | rounded | ✅ |
| 567 | Mi Band 10 Pro | 336×480 | 230×328 | rounded | – |
| 3651 | Redmi Watch 5 Active | 320×385 | 180×216 | rounded | – |
| 3652 | Redmi Watch 5 Lite | 410×502 | 244×298 | rounded | – |

Testing without a watch: EasyFace ships an emulator (m0tral/MiWatchEmulator —
a cut-down Watch S3 system image) that EasyFace pushes builds to over adb; our
compiled `.bin` files can be pushed the same way.

## Finding animated faces
Many stock faces are animated, but neither of the two reference faces is, so the
animation section is not implemented yet. To spot them before/while working:

```bash
node tools/inspect.js <file.bin>     # or: npm run inspect -- <file.bin>
```

It prints the per-section table counts and flags `ANIMATIONS` (section 4, what the
official packer's `SetupAnimation` reads) and `APPS` (section 5). Faces with those
are refused silently no more: the editor shows a ⚠ in the status line, **skips
unused-image cleanup** (animation frames are not widgets, so pruning would eat
them) and asks for confirmation before compiling, because the animation/app
sections would be dropped.

Where animated faces come from: they ship through the Mi Fitness watchface store
(only visible with a paired watch), so the practical route is community sources —
the faces you already have came from a third-party maker ("APK_SCRIPTS"), i.e.
maker sites / Telegram & forum threads that publish `*.bin` (search terms:
`wtchface bin`, `xiaomi watchface bin download`, `Mi Band 9 watchface bin`).
Drop a few into a folder and run `npm run inspect` over them to find an animated
one to work from.

### Fidelity notes
Recompiling a stock face is byte-identical for all five reference faces
(`node tools/roundtrip.js`), because anything the
model does not author is echoed back: opaque widget words at +4/+6 (Watch 6 ships
`1000`, Watch 5 ships `0`), value-driven image widgets (widget TypeId 4, kept with
their original blobs), action blobs (re-emitted verbatim, image id patched) and
whether an image list shipped a values array even when it matches the indices.

## Notes / limits
- V3 currently supports `RedmiWatch3Active` (same as original `FaceV3Decompiler.IsSupported`).
- V2 adds `RedmiWatch6` (device type 565, 432×514) plus the other current-gen IDs (Mi Band 9 Pro/10/10 Pro, Watch S4/S5, Watch 5/5 Active/5 Lite) on top of the original's device table.
- Unpacking covers v1/v2/v3 (see above); compiling back to `.bin` supports the 8Pro-family V2 watches listed under Compiler.
- Black → transparent conversion mirrors the original `MagickImage.Transparent(black)` step.

## Compiler (core/packer.js)
Pure-JS port of the official `Compiler.exe` `DefaultPacker` for the
MiBand8ProRleCompressor watch family: **11, 362, 365, 367, 462, 465, 562, 565**.
Image payloads are BGRA/RLE-v10 (`type 4`, header `00040000`); on the
565/362/366 devices images with ≤256 colors are stored palettized PAL8+RLE-v20
(`type 1`, selector `0x10`) exactly like stock, larger ones fall back to RGBA.
The editor preview and all widget/element tables were verified byte-identical
against the official packer (element/widget blobs, analog-clock hands, digital
alignment / spacing / blanking, ImageList custom values, RW4 button actions).

Stock round-trips (`node tools/roundtrip.js`) are byte-identical for all five
reference faces (2× Watch 6, 3× Watch 5 incl. a 2-slot face). Per-generation
details reproduced from stock: file-wide image/list/widget ordinals across
slots (sec 2/3/7 keep counting, sec 0/9 restart per face), blob order
(elements, widgets, actions, preview, images on the new generation; preview
last on the old one), 4-byte blob padding on the old generation only,
content-shared image blobs on the new generation only, and the header
subVersion (1 / 0 / 2-slot dual = 2, echoed on reimport).

Round-trip on `redmi_watch_6_test_wtchface.bin`: section 0/7 blobs
byte-identical, all 145 packed images + preview pixel-identical, 0 widget
diffs (9 truly unreferenced images are dropped with a warning, like official).

Supported widget shapes: Image (30), ImageList (31), DigitalNum (32),
AnalogClock (27). Buttons are `btn_…_[app]` layers (`Tap action` dropdown,
37 RW4 apps) or raw `_action` blobs preserved from the source file.
Digit `Spacing` values ≥ digit width (e.g. 244 on Kool Carbon hour/minute)
are rendered as 0 to match the watch/reference preview, but the raw byte is
preserved on compile.
Not supported in v1: app widgets (`app_…`), animations (`anim_…`), AOD slots,
gauges/circles, other watch families (open an issue with a sample face).
Orphan tap zones (position-only sec9 actions with no button widget) are shown
as ⚡ markers and re-emitted verbatim, so stock tap behavior survives compile.
