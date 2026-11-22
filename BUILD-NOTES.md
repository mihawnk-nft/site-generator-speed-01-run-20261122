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
