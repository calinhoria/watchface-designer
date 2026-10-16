# Watchface samples

Real faces used as compiler test corpus (`node tools/roundtrip.js samples/*.bin`)
and design reference. The five original regression faces live in
`/Users/calinbelut/Downloads/*.bin` (not committed); these are committed so the
project is self-contained.

| file | store id | device | subVersion | slots | notable |
|---|---|---|---|---|---|
| `465700750_comet-twilight.bin` | 465700750 "Comet Twilight" (m0tral) | Redmi Watch 5 (465) | 0 | 1 | **animations** (sec4, 2 entries), tap actions |
| `120917368850_amber.bin` | 120917368850 "Amber" (Xiaomi) | Redmi Watch 5 (465) | 36 | 2 | raw AOD slot (sec8 flag + sec9 elements) |
| `120917368855_high-efficiency-1.bin` | 120917368855 "High efficiency 1" (Xiaomi) | Redmi Watch 5 (465) | 36 | 2 | analog clock, tap actions, raw AOD slot |
| `120917368887_modern-classic.bin` | 120917368887 "Modern classic" (Xiaomi) | Redmi Watch 5 (465) | 32 | 1 | analog clock, tap zone |
| `120917368958_neon-night.bin` | 120917368958 "Neon night" (Xiaomi) | Redmi Watch 5 (465) | 38 | 5 | 5 slots, tap zones |
| `120917368961_number-jumble.bin` | 120917368961 "Number jumble" (Xiaomi) | Redmi Watch 5 (465) | 32 | 1 | analog clock, tiny (89KB) |
| `120917368969_tetris.bin` | 120917368969 "Tetris" (Xiaomi) | Redmi Watch 5 (465) | 32 | 1 | digits + lists |
| `266211405_shark-doodle.bin` | 266211405 (Xiaomi, model `miwear.watch.m66`) | Mi Band 9 (366) | 4 | 2 | **first Mi Band 9 face** (192×490, PAL8/LVGL) |
| `266269338_eco-neon.bin` | 266269338 "ECO NEON" (conversmod) | Mi Band 9 (366) | 4 | 2 | Mi Band 9, 22 widgets |
| `366150013_colordynamics.bin` | 366150013 "Colordynamics" (Xiaomi, `n66cn`) | Mi Band 9 (366) | 4 | 5 | Mi Band 9, 5 variants |
| `367701406_strava-8-ru.bin` | 367701406 "Strava 8 RU" (m0tral, `n67cn`) | Mi Band 9 Pro (367) | 4 | 6 | **first Mi Band 9 Pro face** (336×480) |
| `120917383973_explorer.bin` | 120917383973 "Explorer" (Xiaomi, `p62`) | Mi Watch S5 (562) | 4 | 5 | **first Mi Watch S5 face** (480×480 round) |

The `.mwz` files are the original store packages (editor project metadata:
`capability.json`, `description.xml`, `editor.config.json`, previews). The
`.bin` files are the compiled faces extracted from them.

Sources: Xiaomi watchface store (`face.miwatch.de`, model `miwear.watch.p65gl`)
and the m0tral community store (`cmod.miwatch.de`), captured Oct 2026 via the
Mi Fitness mod app's own log files — no proxy needed, see below.

## Getting more samples

The store APIs work **without auth** for listing/metadata (download URLs need a
logged-in app session, or are unsigned on `cmod.miwatch.de`):

```
# faces for a model (model = miot URN, e.g. miwear.watch.m66 = Mi Band 9)
curl 'https://face.miwatch.de/api/v2/mall/watchface/entrance?data={"firmware_version":"3.200.065","model":"miwear.watch.m66"}'
# face detail (ids, icons, hashes; config_file needs auth)
curl 'https://face.miwatch.de/api/v2/paidwatchface/detail?data={"firmware_version":"3.200.065","id":"<id>","ids":[],"model":"miwear.watch.p65gl"}'
```

Known model URNs (from the APK): m66/m66gl (Mi Band 9), n67cn (Mi Band 9 Pro),
o63 (Mi Watch S3), o65 (Redmi Watch 4), p62 (Mi Watch S5), p65/p65gl
(Redmi Watch 5). The app logs every URL it touches to
`/sdcard/Android/data/com.xiaomi.wearable/files/log/XiaomiFit.main.log`
(pull with `adb pull`) — including signed per-face `.bin`/`.mwz` download
URLs, which work with plain `curl` while fresh.

## Round-trip status (2026-10-16)

- 3 original 465 faces: byte-identical (`fwc26xarg`, `giulia_cerchi`,
  `horizontal`). 2 original 565 faces: sec0/7/9 identical, sec2 drops 9
  phantom singles per face (tap-zone ordinals used to false-match image
  indices and paint duplicate layers — fixed 2026-10-16, see unpacker
  `readActions`: only 56B blobs carry an image id).
- Comet: differs (sec4 animations need echo — first animation sample).
- Amber + 5 new faces: differ (raw AOD slots, PAL8-on-465 images, subVersion
  32/36/38) — the next compiler chunk is per-image codec echo + section echo.
- 76B group containers (temp digits+symbol, date, big clock) explode to flat
  layers on import (WYSIWYG x-pack, y-centred); recompile emits the flat
  equivalent. Still open: 56B-new nested taps (neon weather/nested groups),
  52B-new image holders, slot-3 big sec9 records, temp sign-variant overlap
  semantics.
- AOD preserved: the AOD variant (a face whose own preview offset is 0) keeps
  its layers and its unreferenced sec9 records round-trip verbatim. Multi-style
  packs (subVersion >= 32) use a 160-byte face block (88-byte header+dir +
  72-byte style-name block); tables start at `168 + count*160`. Global packs
  ship N styles + 1 AOD, so only one slot is AOD.
- Mi Band 9 (366): the m66 faces store images as LVGL/PAL8 like Mi Band 8, so
  366 now uses the generic path (the 362-only per-face extra block and the
  external-palette special-cases were removed for 366 — they hung the
  unpacker). 366 is also in the compiler's supported set again. `266211405`
  compiles; remaining DIFF is the usual sec0/2/7 (group flattening + single
  re-encode).
- Detection: many families share a screen/preview size (Mi Band 8/9 both
  192×490; Mi Band 8 Pro / 9 Pro / 10 Pro all 336×480). Device-coded store ids
  (`367701406` → 367) now win over the size table when they resolve to a device
  with a matching preview/screen. Global ids (`120917383973`) have no device
  code and still resolve by size.
- New families import + compile: Mi Band 9 Pro (367) and Mi Watch S5 (562)
  round-trip through the compiler without error; their DIFF is structural
  (sec0/2/7 — group flattening and re-encoded singles/lists), not a codec
  failure.
