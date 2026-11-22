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
