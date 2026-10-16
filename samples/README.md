# Watchface samples

Real faces used as compiler test corpus (`node tools/roundtrip.js samples/*.bin`)
and design reference. The five original regression faces live in
`/Users/calinbelut/Downloads/*.bin` (not committed); these are committed so the
project is self-contained.

| file | store id | device | subVersion | slots | notable |
|---|---|---|---|---|---|
| `465700750_comet-twilight.bin` | 465700750 "Comet Twilight" (m0tral) | Redmi Watch 5 (465) | 0 | 1 | **animations** (sec4, 2 entries), tap actions |
| `120917368850_amber.bin` | 120917368850 "Amber" (Xiaomi) | Redmi Watch 5 (465) | 36 | 2 | raw AOD slot (sec8 flag + sec9 elements) |

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

- Original 5 faces: byte-identical.
- Comet: differs (sec4 animations need echo — first animation sample).
- Amber: differs (raw AOD slot, subVersion 36) — newest sample.
- Removed 2026-10-16: two Chinese-named faces (120917380718, 120917426911,
  subVersion 4 with the same raw-AOD pattern); to be replaced with English
  faces. See `tools/roundtrip.js` output; tracked as the next compiler work.
