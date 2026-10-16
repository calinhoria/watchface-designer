# Watchface samples

Real faces used as compiler test corpus (`node tools/roundtrip.js samples/*.bin`)
and design reference. Names are `<store id>_<watch model>_<slug>.bin` so a face
can be matched to its family at a glance. The five original regression faces live
in `/Users/calinbelut/Downloads/*.bin` (not committed); these are committed so the
project is self-contained.

| file | store id | device | slots / widgets |
|---|---|---|---|
| `120917368850_redmi-watch-5_amber.bin` | 120917368850 | Redmi Watch 5 (465) | 2 / 18 |
| `120917368855_redmi-watch-5_high-efficiency-1.bin` | 120917368855 | Redmi Watch 5 (465) | 2 / 18 |
| `120917368887_redmi-watch-5_modern-classic.bin` | 120917368887 | Redmi Watch 5 (465) | 1 / 6 |
| `120917368958_redmi-watch-5_neon-night.bin` | 120917368958 | Redmi Watch 5 (465) | 5 / 55 |
| `120917368961_redmi-watch-5_number-jumble.bin` | 120917368961 | Redmi Watch 5 (465) | 1 / 2 |
| `120917368969_redmi-watch-5_tetris.bin` | 120917368969 | Redmi Watch 5 (465) | 1 / 6 |
| `120917378817_mi-watch-s5_text-display-1.bin` | 120917378817 | Mi Watch S5 (562) | 2 / 15 |
| `120917380249_mi-watch-s5_moonbeam.bin` | 120917380249 | Mi Watch S5 (562) | 10 / 95 |
| `120917381519_mi-watch-s5_text-display-4.bin` | 120917381519 | Mi Watch S5 (562) | 2 / 2 |
| `120917383973_mi-watch-s5_explorer.bin` | 120917383973 | Mi Watch S5 (562) | 5 / 62 |
| `266211405_mi-band-9_shark-doodle.bin` | 266211405 | Mi Band 9 (366) | 2 / 16 |
| `266211553_mi-band-9_big-eyes.bin` | 266211553 | Mi Band 9 (366) | 2 / 16 |
| `266213066_mi-band-9_starry-fishing.bin` | 266213066 | Mi Band 9 (366) | 2 / 17 |
| `266269338_mi-band-9_eco-neon.bin` | 266269338 | Mi Band 9 (366) | 2 / 28 |
| `366110010_mi-band-9_racetrack.bin` | 366110010 | Mi Band 9 (366) | 3 / 38 |
| `366150013_mi-band-9_colordynamics.bin` | 366150013 | Mi Band 9 (366) | 5 / 72 |
| `366150014_mi-band-9_vibrantdigits.bin` | 366150014 | Mi Band 9 (366) | 6 / 45 |
| `366700368_mi-band-9_evangelion.bin` | 366700368 | Mi Band 9 (366) | 1 / 12 |
| `367701405_mi-band-9-pro_calculator.bin` | 367701405 | Mi Band 9 Pro (367) | 1 / 1 |
| `367701406_mi-band-9-pro_strava-8-ru.bin` | 367701406 | Mi Band 9 Pro (367) | 6 / 103 |
| `367701407_mi-band-9-pro_strava-8-en.bin` | 367701407 | Mi Band 9 Pro (367) | 6 / 103 |
| `367701409_mi-band-9-pro_stat-rings-2.bin` | 367701409 | Mi Band 9 Pro (367) | 2 / 4 |
| `462700164_mi-watch-s4_neptune-ru.bin` | 462700164 | Mi Watch S4 (462) | 2 / 40 |
| `462700166_mi-watch-s4_enduro3.bin` | 462700166 | Mi Watch S4 (462) | 3 / 62 |
| `462700167_mi-watch-s4_active2.bin` | 462700167 | Mi Watch S4 (462) | 2 / 21 |
| `462700168_mi-watch-s4_active2-ru.bin` | 462700168 | Mi Watch S4 (462) | 2 / 21 |
| `465700750_redmi-watch-5_comet-twilight.bin` | 465700750 | Redmi Watch 5 (465) | 1 / 15 |
| `465700752_redmi-watch-5_turi.bin` | 465700752 | Redmi Watch 5 (465) | 1 / 17 |
| `465700753_redmi-watch-5_outlines.bin` | 465700753 | Redmi Watch 5 (465) | 4 / 35 |
| `465700754_redmi-watch-5_mavik.bin` | 465700754 | Redmi Watch 5 (465) | 5 / 90 |
| `465700755_redmi-watch-5_outlines-en.bin` | 465700755 | Redmi Watch 5 (465) | 4 / 35 |

Total: **31 faces** across Redmi Watch 5 (465), Mi Watch S4 (462), Mi Watch S5
(562), Mi Band 9 (366) and Mi Band 9 Pro (367).

## Sources

Xiaomi watchface store `face.miwatch.de`, one `entrance` call per model URN —
the **`config_file_v2`** field carries the real download URL (a `cmod.miwatch.de`
`.zip` or a `region-cdn-fds.xiaomiwear.com` `.mwz`); the older `config_file`
field is often empty. Both are plain `curl`-able. Packages unzip to
`resource.bin` + `resources/` + `description.xml`.

```
curl 'https://face.miwatch.de/api/v2/mall/watchface/entrance?data={"firmware_version":"3.200.065","model":"miwear.watch.o65"}'
```

Model URNs seen: `m66`/`m66gl` (Mi Band 9), `n66cn`/`n66nfc` (Mi Band 9),
`n67cn`/`n67gl` (Mi Band 9 Pro), `o63`/`o63w` (Mi Watch S4), `o65`/`p65`/`p65gl`
(Redmi Watch 5), `p62` (Mi Watch S5). URNs `n66`, `n67`, `o66`, `p63`, `p67`,
`m67`, `n65cin`, `o61` return no faces.

## Round-trip status (2026-10-16)

- 3 original 465 faces byte-identical; 2 original 565 faces OK except sec2
  (phantom singles from tap-zone ordinals false-matching image indices — fixed).
- Face block size is **derived**, not guessed from subVersion: the first section
  table offset gives `block = (off0 - 168) / count`. Seen: **88** (Mi Band 9 /
  9 Pro), **160** (Redmi Watch 5, some S5), **176** (most S5 — a 16-byte record
  before the 72-byte name block). The whole per-face tail is echoed on compile.
  Guessing 160 for subVersion ≥ 32 mis-parsed the S5 packs into a
  3.8-billion-entry count that hung the unpacker.
- Readers clamp implausible counts so a bad directory can never spin forever.
- Device detection prefers a device-coded id prefix when families share a
  screen/preview size (Mi Band 8/9 both 192×490; Mi Band 8/9/10 Pro all 336×480;
  Mi Watch S3/S4 both 466×466).
- Mi Band 9 (366): m66 faces store images as LVGL/PAL8 like Mi Band 8, so 366
  uses the generic path (the 362-only per-face extra block and external-palette
  special-cases do not apply).
- Image payloads are echoed verbatim when unchanged, so PAL8/LVGL palette order
  round-trips (sec2/sec3/preview byte-identical on several faces).
- Remaining DIFF is structural and shared across families: sec0/7/9 group
  flattening (76-byte group containers become flat layers) and re-encoded
  singles/lists.
- AOD is marked in header byte 0x1E bit 2 (`aod ? 4 : 0`, official
  SetupHeader); bit 1 means "more than one non-AOD face". Without bit 2 the
  watch shows the AOD slot as a regular style. The compiler now derives both
  bits from the slots.
- Layer tap zones: the 565-family 52-byte name zone repeats the ordinal at +36
  and +48; the older 465 layout is 56 bytes with the tap box W/H at +52/+54.
  The compiler emits the right size per device (app codes verified for the
  52-byte form).
- Shape 43 gauges are supported now: the widget's 32-byte sec7 blob (same family
  as the clock hands) is echoed verbatim with the pointer image id patched, and
  the pointer image is emitted as a single. `moonbeam` compiles (its gauge blobs
  match stock, one renumbered to our image order, pointing at the same picture).
- Known failures: faces carrying **Shape 34 app widgets** (Lua apps in sec5) —
  `367701405_mi-band-9-pro_calculator`, `462700166/167/168_mi-watch-s4_*` — are
  still rejected by the compiler. Also two suspicious size drops to check:
  `120917381519_mi-watch-s5_text-display-4` (302→118 KB) and
  `367701409_mi-band-9-pro_stat-rings-2` (460→69 KB).
