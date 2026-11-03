# WCET Labs

Two small browser labs for learning how static worst-case execution time (WCET) analysis tools work.
They are teaching re-implementations of ideas from two open research tools, not the tools themselves.

| Lab | Modelled on | What you can explore |
|---|---|---|
| `sweet.html` | SWEET (Mälardalen University) | Abstract execution on a mini-C language lowered to ALF-style code: loop bounds, infeasible paths, state merging |
| `tcrest.html` | T-CREST: Patmos processor and platin | Patmos-style assembly on a cycle-level simulator, method/stack/data cache and scratchpad, per-block costs and IPET |

Everything runs in the browser. There is no server and no build step is needed to use the pages in `dist/`.

## Put it on GitHub Pages

1. Create a new repository on GitHub, for example `wcet-labs`.
2. Upload the contents of this folder (or at least `dist/`).
3. In the repository, open **Settings → Pages**, choose **Deploy from a branch**, branch `main`, folder `/docs` or `/ (root)`.
   - Simplest: rename `dist/` to `docs/` before uploading and pick `/docs`.
4. After a minute the labs are at `https://<your-user>.github.io/wcet-labs/`.

## Project layout

```
src/sweet-core.js       parser, lowering to ALF-like IR, abstract execution, flow facts
src/tcrest-core.js      assembler, CFG, loops, timing model, simplex/IPET, simulator
src/tcrest-examples.js  example programs for the T-CREST lab
src/*.html, common.css  page templates
build.js                node build.js  ->  dist/ (standalone pages)
```

The cores are plain JavaScript and also run in Node, for example:

```js
const S = require('./src/sweet-core.js');
console.log(S.analyze('int n = nondet(1,10); int i = 0; while (i < n) i++;').facts);
```

## What is simplified

See the "How it works" tab in each lab. In short: the input languages, ALF printout, flow-fact notation and
instruction syntax are approximations; cycle latencies are configurable round numbers; only one core is modelled.

## The real tools

- T-CREST repositories: https://github.com/t-crest (Patmos, compiler, platin)
- platin: https://github.com/t-crest/platin
- SWEET: see B. Lisper, "SWEET – a tool for WCET flow analysis", ISoLA 2014, and the Mälardalen University WCET group.
