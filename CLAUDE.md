# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project

Streamio's custom Google Cast (CAF v3) web receiver: **one file**, `index.html`, deployed as a
static page to Vercel and registered in the Google Cast console as receiver app `BF64D6B2`.
No build step, no framework, no dependencies at runtime — the only external `<script>` is
Google's CAF SDK.

`README.md` covers why a custom receiver exists and how to deploy/register one.
`docs/protocol.md` is the **canonical** description of the `customData` contract, the
`urn:x-cast:com.streamio.control` messages, and the backend API this receiver calls itself.

## Commands

- `npm run check` — the Chrome 70 compatibility gate (`scripts/check-compat.mjs`). Also CI.
  **Run it after any edit to `index.html`.**
- `npm run serve` — static server on :3000. The page loads and sits idle without a backend;
  actual playback needs a real cast session.

There are no unit tests. What's worth testing here is whether a physical Chromecast can parse and
run the file, which only a device can answer — `npm run check` is the closest mechanical proxy.

## Invariants

- **ES2019 / Chrome 70, no exceptions.** Gen-1/2 Chromecasts are Chrome 70 (CrKey/1.36). `?.` and
  `??` are a *silent* parse error there: the HTML loads, the script never runs, casting appears to
  do nothing, and nothing anywhere says why. Use `a && a.b` or the `get()` helper in `[2]`. Same
  for CSS — `gap` in flex, `inset`, `clamp()`, `:is()`, `aspect-ratio`, `backdrop-filter` and
  logical properties are all too new. `npm run check` enforces both; the ban lists are in the
  comments at the top of `index.html` and in `scripts/check-compat.mjs`.
- **One file, inline CSS and JS.** Splitting it lets a device hold stale JS against fresh HTML.
- **`no-store`, always** (`vercel.json`). Chromecasts cache receiver HTML hard enough to hide a
  build you just deployed.
- **No backend is baked in.** `apiBase`/`castProxyBase` arrive per cast in `customData`; this
  deployment is shared by every Streamio install. Nothing may assume a particular one.
- **Everything degrades, field by field.** The four-rung ladder is documented in `[4]` and in
  `docs/protocol.md`. Rung 1 (no `customData` at all) is a live code path — older streamio-app
  builds still installed on phones land there — not a hypothetical. **Every contract field stays
  optional**: adding one needs no coordinated release across the three repos, removing or
  renaming one does.
- **`castProxyBase` must match `CAST_PROXY_PREFIX`** in streamio-website's
  `routes/content.router.ts` character for character. The receiver has no page origin, so a
  mismatch means the master manifest loads and every single segment 404s.
- **Resolved streams are never cached.** They expire in minutes; re-resolve per playback attempt.
- **Remote logging is the only debugger.** `rlog()` posts to `/api/cast-log` on `ctx.apiBase`
  (buffered until one arrives). Keep new diagnostics going through it, and keep them throttled —
  the 500ms ticker would otherwise mean one GET every half second through someone's tunnel.

## Layout of `index.html`

Numbered sections, referred to by number in the comments: `[0]` constants, `[1]` remote logging,
`[2]` ES-safe helpers, `[3]` DOM + phase, `[4]` session context (the `customData` contract),
`[5]` API client, `[6]` proxy, `[7]` load normalization, `[8]` episode queue + resolution,
`[9]` skip segments (TheIntroDB), `[10]` up next, `[11]` recovery / re-resolve, `[12]` custom
namespace, `[13]` remote control (key input), `[14]` player events + ticker, `[15]` suppress the
built-in chrome, `[16]` boot.

## Related repos

- **streamio-website** — the backend + browser sender. Bare paths in `index.html` comments
  (`watch.js`, `routes/content.router.ts`) are files there.
- **streamio-app** — the Flutter sender (`lib/core/cast/`).

A change to the contract touches all three.
