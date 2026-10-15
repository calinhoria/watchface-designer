# Watchface Designer (Electron, cross-platform)

Port of [UnpackMiColorFace](https://github.com/kindyear/UnpackMiColorFace) (.NET, Windows-only, Magick.NET)
to a pure-JS Electron app that runs on **macOS, Windows, Linux**.

## What it does
- Open Xiaomi watchface `.bin` (v1/v2/v3 magic detection, same as `Unpacker.cs`)
- Detect watch (`WatchDetector` + `WatchScreen` tables ported: Gen1/Gen2/Gen3, Redmi Watch 2/3/4, Mi Band 7 Pro/8/8 Pro/9, Mi Watch S3, RedmiWatch3Active…)
- Decode images without native deps (RLE v10/v11/v20, RGB565→RGBA, indexed8+palette, RedmiWatch3Active sparse codecs ported from `XiaomiWatch.Common` IL)
- Designer: canvas preview (watch name above it), collapsible panels (max-height 600 with scroll), layers (add/reorder/hide/delete inline), drag-move, property editor (incl. tap actions ⚡), title edit, undo/redo (toolbar + Ctrl+Z / Ctrl+Shift+Z)
- New watchface: toolbar `New` button → device picker (8 supported devices) + name field → blank face at the right screen size (preview auto-composed from canvas on compile)
- Slots: `+` adds a slot with a role dialog (Face / AOD), and each chip has a remove (`✕`) button; at least one slot is always kept. Status line lives under the canvas, not in the toolbar.
- Open: reopen a saved project folder (`.fprj` + `images/`, plus `AOD/` `AOD2/`…); remembers the folder so Save overwrites in place
- Images: PNG upload, per-image delete (with usage check)
- Fonts → digits: pick one of 5 bundled OFL Google fonts (or import .ttf/.otf) on any DigitalNum/ImageList layer to generate the 0-9 BitmapList PNGs on the fly (size + color + faux bold/italic, auto-regenerates on every change, stale files deleted)
- Save: `images/*.png` + `<name>.fprj` (FaceProject XML, same attrs as C# `Serialize()`) + composed `preview.png`; extra slots go to `AOD/` `AOD2/`… Stale images are pruned on re-save. First save asks for a folder, later saves reuse it.
- **Compile `.bin`**: rebuild an installable V2 face from the designer project (port of the official `Compiler.exe` `DefaultPacker`, pure JS). The output is re-unpacked and verified automatically before saving.

No BMP/Magick round-trip: RGBA goes straight to PNG via `pngjs` (pure JS, no native modules → `electron-builder` works everywhere).

## Run
```bash
npm install
npm start        # UI styling is pre-built (styles.css compiled from styles-src.css)
npm run css      # rebuild styles.css after editing styles-src.css (Tailwind v4 CLI, offline)
```

UI: Tailwind v4 (bundled/compiled at build time, no runtime CDN). Design tokens
live in `styles-src.css` (@theme: bg/panel/line/ink/mut/acc). Toolbar: New |
undo/redo | Import/Open · Save (Ctrl+S) | add-tools group (Img/Digital/List/Clock/Btn/PNG)
| primary Compile on the right.

## Package
```bash
npm run dist        # current OS
npm run dist-mac / dist-win / dist-linux
```

## Notes / limits
- V3 currently supports `RedmiWatch3Active` (same as original `FaceV3Decompiler.IsSupported`).
- V2 adds `RedmiWatch6` (device type 565, 432×514) plus the other current-gen IDs (Mi Band 9 Pro/10/10 Pro, Watch S4/S5, Watch 5/5 Active/5 Lite) on top of the original's device table.
- Unpacking covers v1/v2/v3 (see above); compiling back to `.bin` supports the 8Pro-family V2 watches listed under Compiler.
- Black → transparent conversion mirrors the original `MagickImage.Transparent(black)` step.

## Compiler (core/packer.js)
Pure-JS port of the official `Compiler.exe` `DefaultPacker` for the
MiBand8ProRleCompressor watch family: **11, 362, 365, 367, 462, 465, 562, 565**.
Image payloads are BGRA/RLE-v10 (`type 4`, header `00040000`); the editor
preview and all widget/element tables were verified byte-identical against the
official packer (element/widget blobs, analog-clock hands, digital alignment /
spacing / blanking, ImageList custom values, RW4 button actions).

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
