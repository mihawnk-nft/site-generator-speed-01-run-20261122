# BUILD-NOTES — site-generator-speed-01-run-20261122

Entry: reimplementasi makefun-site 1.0.0 yang lebih cepat, byte-identik.
File: `main.ts` (salinan verbatim driver baseline) + `solve.js` (pure stdlib, tanpa
dependency) + `package.json` (`{"type":"module"}` supaya node tidak reparse main.ts
sebagai CommonJS dulu).

## Hasil

- `grade-local --driver process` (docker tidak tersedia di VM ini):
  `passed=1, cases_passed=3/3`, L1 regrade reproduced byte for byte.
  `result_sha256` lokal: `83599d47162b12ffde2fdf78d696fde9eed7cbb0bb7ab4ac5049792d761857e9`
  (tidak sama dengan server — dicatat tool: server pakai node v26.13.1, lokal v24.22.1).
- Uji tambahan di luar practice set: 120 kasus acak dari generator kit
  (`program/generator`, 40 seed × 3 case) + 64 kasus adversarial buatan tangan
  (front matter, Markdown, template, slug Unicode, shadowed/static, paging,
  include rekursif) — semuanya identik dengan baseline.
- Kecepatan (VM ini, node v24.22.1, CPU user+system per run via `wait4`,
  median 7 run; null-entry ~100k µs):
  - entry: median ~800–910k µs (antar-batch bervariasi); baseline: ~1.220–1.300k µs
  - speedup bersih (net of null): ~1,47–1,63x, rata-rata ~1,55x
  - build saja (warm, in-process): ~62 ms/case vs baseline ~173 ms/case → ~3,1x
  - build dingin (proses segar, per case): ~100–135 ms vs baseline ~190–255 ms → ~1,8–2,1x
  - sisa waktu run adalah biaya tetap yang sama-sama dibayar baseline:
    startup node (~100k µs), `JSON.parse(cases.json)` ~25 ms,
    `JSON.stringify(answers.json)` ~60 ms, cold JIT.

## Yang dioptimasi (semua di `solve.js`, semantik dipertahankan persis)

1. **Markdown inline satu pass** (`inline`): pemindaian berbasis range
   `(s, from, to)` tanpa slice rekursif; plain run di-slice utuh tanpa escaping
   ulang; escaping hanya di titik yang butuh. Sebelumnya: loop per karakter
   dengan `escapeHtml(c)` berbasis regex per karakter.
2. **`escapeHtml` manual**: scan sekali, kembalikan string asli bila tidak ada
   karakter spesial; `escapeHtmlInto` menulis langsung ke array output.
3. **Lexer Markdown menyatu dengan renderer** (`renderMarkdown`): tanpa objek
   token, tanpa regex per baris; dispatch blok dari karakter pertama baris.
4. **`slugify`**: fast path ASCII (tanpa `normalize`/`\p{M}`), cache per build
   (Map dibuat di dalam `build()` — tidak ada cache antar case); slug tag
   dihitung sekali per nama (baseline 2–3x).
5. **Front matter**: lokasi baris penutup via `indexOf` (`\n---\n` / `\n---` akhir)
   sehingga body tidak di-split lalu di-join ulang.
6. **`wordsOf` manual** (tanpa regex `/\S+/g`), dihitung sekali per source
   dan dipakai ulang oleh `cardOf` (baseline menghitung 2x per post).
7. **Template**: render ke satu array bersama + `join` (bukan `+=` string);
   array `tmp` inline dipakai ulang per halaman.
8. **Yang DICOBA lalu DIBATALKAN — kompilasi template via `new Function`:**
   diukur LEBIH LAMBAT. Fungsi hasil `new Function` dibuat baru tiap `build()`
   sehingga tidak sempat dioptimasi JIT, sementara interpreter `renderNodes`
   yang dipakai bersama sudah panas setelah case pertama. Dihapus; fallback
   interpreter dipertahankan sebagai satu-satunya jalur render.

## Yang belum terverifikasi

- **node22 tidak tersedia di VM ini** (hanya node v24.22.1; docker juga tidak
  ada). Semua tes jalan di v24 dengan `--driver process`. Perilaku di node22
  (runtime grading) belum dites langsung; semantik yang dipakai (String
  `normalize('NFKD')`, regex `\p{M}`, type stripping `main.ts`) sama di
  keduanya, tapi angka `cpu_us` final bisa bergeser.
- `grade-local` lokal tidak mencetak `cpu_us` (timing dev hanya dihitung di
  server/board); angka di atas dari pengukuran sendiri (`/tmp/timeit.py`,
  `wait4` rusage) — bandingkan hanya dengan baseline yang diukur di mesin
  yang sama.
- Belum dibuat: repo GitHub, README + badge, LICENSE (tugas parent).
  JANGAN submit sebelum lampu hijau user.

## Hasil optimasi lanjutan — 23 Nov 2026 (opt2, commit baru)

Target user: kejar kecepatan dulu sebelum submit (1,55x kemungkinan NPC).
Perubahan (semua di `solve.js`, kecuali serialisasi di `main.ts`):

1. **`inline` regex-scan**: karakter markup berikutnya dicari satu regex
   `/[\\`*\[&<>"']/g` (native) bukan loop per karakter; penanganan tiap
   karakter spesial tidak berubah. Terukur ~30% lebih cepat di micro-benchmark
   dan output identik di 1.070 body.
2. **`trimLine` fast path**: kembalikan string apa adanya bila tidak ada
   spasi/tab di ujung (tanpa slice) — sebagian besar baris tidak perlu trim.
3. **Front matter CRLF fast path**: `indexOf('\r')` dulu; `replace` regex
   hanya bila ada `\r`. Fase 1: 2,2 → 0,7 ms/case (warm).
4. **`ESCAPABLE` jadi tabel `Uint8Array(128)`** + `charCodeAt` (ganti
   `Set.has(s[i])` yang mengalokasi string 1 karakter per cek) di
   `findUnescaped`/`findSingleStar`/cabang backslash `inline`.
5. **`renderNodes` for-scope reuse**: satu objek scope + satu objek `loop`
   per eksekusi `for` (bukan per iterasi); field `loop` di-mutasi per
   iterasi. Render sinkron dan sekuensial, jadi aman. Fase 7: 36,1 → 30,7
   ms/case (warm).
6. **`baseScope` template**: `site`/`tags`/`recent` dibuat sekali per case
   sebagai parent scope; tiap `render` hanya membuat child scope berisi
   vars-nya (tanpa spread per render).
7. **`pageOf` satu literal** (tanpa spread `cardOf`) — urutan key sama,
   output `JSON.stringify` tetap byte-identik.
8. **`main.ts` serialisasi per case**: `JSON.stringify` per case + `join`
   (bukan satu `JSON.stringify(answers)`) — byte-identik (terverifikasi),
   alokasi puncak lebih kecil. ~1,5% lebih cepat end-to-end.

Yang DICOBA lalu DIBATALKAN — spread chunk `tmp` ke `parts` di
`renderMarkdown` (hindari `tmp.join` kedua): terukur LEBIH LAMBAT ~7%
(interleaved) karena `parts.join` akhir memproses jauh lebih banyak potongan.
Dibatalkan; `solve.js` kembali ke opt2.

Kecepatan (VM ini, node v24.22.1, median run `node main.ts` + `wait4`,
interleaved A/B untuk batalkan drift VM; null-entry ~280 ms):
- entry lama: ~1.100 ms (net ~816 ms) → speedup net ~1,80x
- opt2: ~975 ms (net ~695 ms) → speedup net ~1,89x vs baseline
- opt2 + main.ts baru: ~1.019 ms → ~1,90x net
- baseline: ~1.595 ms (net ~1.315 ms)
- Catatan jujur: rasio berfluktuasi antar batch (1,82–2,16x net) karena VM
  shared; angka interleaved (~1,89x) yang paling bisa dipercaya. Target 2x
  belum tercapai penuh secara lokal; yang dicapai adalah kenaikan nyata
  ~0,15–0,2x dari 1,55x dan posisi yang (dengan patokan klaim 1,7x di
  peringkat 12–15) semestinya masuk 10 besar. Papan atas tidak menampilkan
  waktu baseline / speedup resmi, jadi posisi pasti tidak bisa dihitung
  dari leaderboard saja.

Verifikasi kebenaran (opt2 vs oracle makefun-site 1.0.0):
- `grade-local --driver process`: `passed=1, cases_passed=3/3`, L1 regrade
  reproduced byte for byte.
- 120 kasus acak dari generator kit (40 seed × 3 case): 0 beda.
- 52 kasus adversarial buatan tangan (front matter, Markdown, template,
  slug Unicode, shadowed/static, paging, include rekursif): 0 beda.
- `main.ts` baru: `answers.json` byte-identik dengan versi lama.

## Hasil optimasi ronde 2 — 23 Nov 2026 (cari LIMIT, target user 2,0x+)

Perubahan (semua di `solve.js`):

1. **Template-constancy caching**: analisis free-variable statis per template
   sampai fixpoint atas include (`templateFreeVars`), tinggi include dengan
   cycle → Infinity (`templateHeights`), klasifikasi per template
   (`classifyTemplates`): `const` (hanya nama base-scope site/tags/recent —
   satu string per build), `arg` (satu nama tambahan — satu string per nilai),
   `dyn` (sisanya — selalu di-render ulang). `renderNodes` include memakai
   cache hanya bila `depth + 1 + height <= INCLUDE_DEPTH` (8) sehingga cap
   kedalaman tetap eksak; cache hidup di `ctx` (segar per `build()`, tidak
   bocor antar case); kunci `arg` = nilai hasil `lookup` (identitas objek
   untuk cards/pages). PH7 warm: 19,38 → 7,5 ms/case (−61%).
2. **`findUnescaped` / `findSingleStar` fast path `indexOf`**: bila tidak
   ada backslash di range, pakai `indexOf` native (bukan loop per karakter +
   `startsWith`); jalur hati-hati dipertahankan bila ada backslash.
3. **`escapeHtmlInto` fast path regex**: satu `exec` `ESC_G` untuk cek ada
   tidaknya karakter spesial di range; bila tidak ada, push slice sekali.
4. **Paragraph range fast path**: array `starts[]` (offset byte tiap baris)
   dihitung sekali per `renderMarkdown`; bila tidak ada baris paragraf yang
   butuh trim (cek char pertama/terakhir), `inline` langsung pada range byte
   mentah `src` — tanpa array `body`, tanpa `join`, tanpa slice `trimLine`
   per baris. Jalur lama dipertahankan bila ada baris yang butuh trim.
5. **`parseFrontMatter` parsing manual**: ganti `LINE.exec` + `replace`
   trailing-ws regex dengan `indexOf(':')`, validasi key `[a-z_]` manual,
   dan trim trailing manual. Micro-bench 42% lebih cepat, sama di 1.070
   file practice.

Yang DICOBA lalu DIBATALKAN di ronde 2:
- Flag V8 `--max-semi-space-size=32`, `--no-lazy`: tidak ada manfaat jelas
  (noise VM ±5%); `main.ts` tetap `--no-incremental-marking` saja.
- JIT warmup build di import (input sintetik kecil): tidak ada manfaat —
  build dingin bukan didominasi JIT (cold ≈ warm dalam proses segar).
- `wordsOf` regex `/\S+/g` / varian lain: loop per karakter sudah tercepat
  (23,86 ms/set vs 27,61 regex); vendor sendiri pakai `match(/\S+/g)` dan
  loop ini terbukti sama persis dengannya (425.755 = 425.755 di body practice).
- `slugify` fast path ASCII: SUDAH ADA (`NON_ASCII.test` + cache per build).
- Hoisting closure `env.link` per source: hemat ~0,05 ms/case, tidak
  sebanding risiko shared mutable state — tidak diimplementasikan.

Kecepatan (interleaved A/B, n=12 per batch, node v24.22.1, VM shared):
- dev vs baseline, net (5 batch): 2,383 / 2,138 / 2,231 / 2,034 / 2,112 →
  **median 2,138x, rentang 2,03–2,38x, rata-rata 2,18x**.
- opt2 vs baseline (kondisi sama): net 1,985x.
- dev vs opt2 (langsung): gross 1,020x, net 1,028x → dev ~2,8% lebih
  cepat net dari opt2; net stabil tersirat ≈ 1,985 × 1,028 ≈ **2,04x**.
- Batch individual terbaik: 2,38x net (gross 1,97x).
- Warm build: 43,7 ms/case (opt2 ~55); PH4 31,5 / PH7 7,5 / PH2 2,1 ms/case.

Verifikasi kebenaran (dev vs oracle makefun-site 1.0.0):
- `grade-local --driver process`: `passed=1, cases_passed=3/3`, L1 regrade
  reproduced byte for byte.
- 120 kasus acak dari generator kit (40 seed × 3 case): 0 beda.
- 52 kasus adversarial buatan tangan: 0 beda.
- 3/3 practice case identik dengan opt2 (`cur==old: true`).

Bottleneck yang bikin mentok (LIMIT):
- Biaya tetap yang sama-sama dibayar baseline (null ~195 ms, import ~23 ms,
  `JSON.parse` ~28 ms, `JSON.stringify` ~70–90 ms) mengencerkan rasio —
  ini yang membatasi seberapa tinggi net bisa naik meski build → 0.
- PH4 Markdown ~31,5 ms/case warm adalah fase terbesar yang tersisa;
  `wordsOf` (~5 ms) sudah di floor; `inline` + `renderMarkdown` sudah
  dioptimasi berat; sisa optimasi masing-masing <1% dan tenggelam dalam
  noise VM ±5% antar batch.
- JANGAN submit sebelum lampu hijau user untuk commit baru ini.
