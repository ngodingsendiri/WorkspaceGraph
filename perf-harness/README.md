# perf-harness — Real-browser graph benchmark

Measures the production graph modules (`graphCanvas2D`, `graphRenderTokens`,
`graphPerfStats`, `graphShared`) on a synthetic 1000-node vault, in a real
browser, at two zoom levels:

1. **canvas2D gesture draw** — `drawCanvas2DScene` on a real 2D context
2. **SVG DOM frame build** — post-cull frame element creation + append in a real
   `<svg>` (the dominant term of the React commit that `SVG_PUSH_THROTTLE_MS`
   gates)
3. **pre→post cull counts** — the shared `pointOnScreen` / `edgeOnScreen` /
   `labelZoomAlpha` frustum wins
4. **AdaptiveThrottle window trajectory** — how the adaptive window would move
   given the measured commit p95

This is **not** the Electron app — React reconciliation itself and the in-app
`D` overlay live in `GraphCanvas` (which needs `window.api`). The DOM-append
cost measured here scales identically and is the honest browser-side number.

## Build

```bash
npx esbuild perf-harness/main.ts --bundle --format=iife --outfile=perf-harness/harness.js
```

## Run

Open `perf-harness/index.html` in a browser (e.g. `start perf-harness/index.html`),
or use the fully self-contained `perf-harness/inlined.html` (no rebuild needed
after source changes only to `main.ts`).

## Keeping it honest

- The harness imports the **production modules** by relative path — a refactor
  that breaks `graphRenderTokens`/`graphCanvas2D`/`graphPerfStats` breaks the
  build here too, which is a feature: it pins the contracts the overlay relies on.
- `commit p95 proxy` = DOM frame build (creation + append), not React
  reconciliation — that is only measurable inside the app via the `D` overlay.
