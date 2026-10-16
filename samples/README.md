# Watchface samples

Real faces used as compiler test corpus (`node tools/roundtrip.js samples/*.bin`)
and design reference. The five original regression faces live in
`/Users/calinbelut/Downloads/*.bin` (not committed); these are committed so the
project is self-contained.

| file | store id | device | notable |
|---|---|---|---|
| `465700750_redmi-watch-5_comet-twilight.bin` | 465700750 (m0tral) | Redmi Watch 5 (465) | animations (sec4), tap actions |
| `120917368850_redmi-watch-5_amber.bin` | 120917368850 (Xiaomi) | Redmi Watch 5 (465) | raw AOD slot, group containers |
| `120917368855_redmi-watch-5_high-efficiency-1.bin` | 120917368855 | Redmi Watch 5 (465) | analog clock, groups, tap actions |
| `120917368887_redmi-watch-5_modern-classic.bin` | 120917368887 | Redmi Watch 5 (465) | analog clock, tap zone |
| `120917368958_redmi-watch-5_neon-night.bin` | 120917368958 | Redmi Watch 5 (465) | 5 slots (4 styles + AOD), nested taps |
| `120917368961_redmi-watch-5_number-jumble.bin` | 120917368961 | Redmi Watch 5 (465) | tiny (89 KB) |
| `120917368969_redmi-watch-5_tetris.bin` | 120917368969 | Redmi Watch 5 (465) | digits + lists |
| `266211405_mi-band-9_shark-doodle.bin` | 266211405 (`m66`) | Mi Band 9 (366) | first MB9 face, PAL8/LVGL, 88-byte blocks |
| `266211553_mi-band-9_big-eyes.bin` | 266211553 | Mi Band 9 (366) | PAL8/LVGL |
| `266213066_mi-band-9_starry-fishing.bin` | 266213066 | Mi Band 9 (366) | PAL8/LVGL |
| `266269338_mi-band-9_eco-neon.bin` | 266269338 (conversmod) | Mi Band 9 (366) | 28 widgets |
| `366110010_mi-band-9_racetrack.bin` | 366110010 (`n66cn`) | Mi Band 9 (366) | 3 slots, 160-byte blocks |
| `366150013_mi-band-9_colordynamics.bin` | 366150013 | Mi Band 9 (366) | 5 slots |
| `366150014_mi-band-9_vibrantdigits.bin` | 366150014 | Mi Band 9 (366) | 6 slots, 3.9 MB |
| `367701406_mi-band-9-pro_strava-8-ru.bin` | 367701406 (`n67cn`) | Mi Band 9 Pro (367) | 336×480, 6 slots, 88-byte blocks |
| `367701407_mi-band-9-pro_strava-8-en.bin` | 367701407 | Mi Band 9 Pro (367) | 336×480, 6 slots |
| `120917378817_mi-watch-s5_text-display-1.bin` | 120917378817 (`p62`) | Mi Watch S5 (562) | 480×480, 176-byte face blocks |
| `120917380249_mi-watch-s5_moonbeam.bin` | 120917380249 | Mi Watch S5 (562) | 10 slots (5 styles + 5 AOD), hung the unpacker before the block-size fix |
| `120917381519_mi-watch-s5_text-display-4.bin` | 120917381519 | Mi Watch S5 (562) | 176-byte blocks |
| `120917383973_mi-watch-s5_explorer.bin` | 120917383973 | Mi Watch S5 (562) | 5 slots, 160-byte blocks |

The `.mwz` files are the original store packages (editor project metadata:
`capability.json`, `description.xml`, `editor.config.json`, previews). The
`.bin` files are the compiled faces extracted from them.

Sources: Xiaomi watchface store (`face.miwatch.de`, models `miwear.watch.m66`
Mi Band 9, `n67cn` Mi Band 9 Pro, `p62` Mi Watch S5) and the m0tral/community
host (`cmod.miwatch.de`, `miwatch.conversmod.ru`). Captured Oct 2026; the global
`config_file` URLs are permanent (`Expires=9223372036854775807`) and download
with plain `curl`. Families with **no** downloadable URL (S3 `o63`, Redmi
Watch 4 `o65`, Redmi Watch 5 `p65`) need an authenticated session.

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
- New families import + compile: Mi Band 9 (366), Mi Band 9 Pro (367) and
  Mi Watch S5 (562) round-trip through the compiler without error; their DIFF
  is structural (sec0/2/7 — group flattening and re-encoded singles/lists),
  not a codec failure.
- Face block size is now **derived**, not guessed from subVersion: the first
  section table offset gives `block = (off0 - 168) / count`. Seen in the wild:
  88 (Mi Band 9 / 9 Pro), 160 (Redmi Watch 5, some S5) and 176 (20 S5 faces —
  an extra 16-byte record before the 72-byte name block). The whole tail is
  echoed verbatim on compile. Guessing 160 for subVersion ≥ 32 mis-parsed the
  S5 packs and produced a 3.8-billion entry count that hung the unpacker; the
  readers also now clamp implausible counts.
