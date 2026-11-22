# Site Generator Speed — Faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![make.fun rank](https://make.fun/badge/site-generator-speed-01-run-20261122/mihawnk-nft/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![make.fun reward](https://make.fun/badge/site-generator-speed-01-run-20261122/mihawnk-nft/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own **makefun-site 1.0.0**, for the make.fun competition
**site-generator-speed-01-run-20261122** ("Build a static site faster, 22 November 2026").
It answers exactly as makefun-site 1.0.0 does on every case — byte for byte — with less CPU time.

## What it is

- `solve.js` — a dependency-free ES module (pure Node.js stdlib, no network, no WASM).
  `run(input)` returns the output tree makefun-site 1.0.0's `build` returns for one
  generated site: every page's `index.html`, the index and tag pages, `build-report.txt`
  and each static file, as a JSON object of path to file text.
- `main.ts` — the harness driver: reads every case from `/input/cases.json`, answers
  each one with `run`, and writes `/output/answers.json`.

## How it is faster

A from-scratch reimplementation of makefun-site's own dialect (front matter, template
dialect, Markdown subset, slug rule, report), optimised for CPU time without changing
any semantics:

- single-pass inline Markdown scanner (range-based, no recursive slicing, no
  per-character regex), hand-written HTML escaping;
- Markdown lexer fused with the renderer, dispatching on the first character of a line;
- fast-path ASCII `slugify` with a per-build cache, front matter parsed via `indexOf`,
  word counts computed once per source;
- templates rendered into a shared output array.

Measured on the practice set (this VM, Node v24.22.1, median of 7 runs, net of the
null-entry control): ~1.55x faster than the house baseline end-to-end, ~3.1x on the
build itself. See `BUILD-NOTES.md` for the numbers.

## Grade locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repository> --driver docker
```

Practice set: `passed=1, cases_passed=3/3`, L1 regrade reproduced byte for byte.
Also verified identical to the baseline on 120 randomly drawn cases from the kit's
generator and 64 hand-built adversarial cases.

## License

MIT — see [LICENSE](LICENSE).
