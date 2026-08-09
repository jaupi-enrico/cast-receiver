# Streamio Cast Receiver

Streamio's custom Google Cast (CAF v3) web receiver. One self-contained static HTML file,
deployed to Vercel, registered in the Google Cast console as receiver app **`BF64D6B2`**.

- **Contract with the senders:** [`docs/protocol.md`](docs/protocol.md)
- **Senders:** `public/scripts/watch.js` in [streamio-website](https://github.com/streamio-org/streamio-website),
  `lib/core/cast/` in [streamio-app](https://github.com/streamio-org/streamio-app)

## Why a custom receiver

The Default Media Receiver mishandles Streamio's HLS: vixcloud serves demuxed multi-rendition
manifests with separate audio tracks. This receiver hands playback to the Chromecast's native
media pipeline instead, which plays them correctly, and forces the HLS content-type in the LOAD
interceptor because the proxied URL carries no file extension.

It also does things the default receiver structurally cannot:

- draws its own UI (idle / loading / playing / paused / up-next / error) over `<cast-media-player>`
- **advances episodes by itself**, resolving servers and stream URLs against the Streamio API — so
  autoplay keeps working after the sender's browser tab is closed
- **re-resolves an expired stream** after a segment error and resumes at the same position,
  instead of dying on a black screen

## No backend is baked in

This deployment is shared by every Streamio install. It learns which backend to talk to from
`customData.apiBase` on each cast, so a receiver fix is a `git push` here — not a rebuild of
everyone's containers.

Two consequences for a self-hosted install:

- **`APP_URL` must be https.** This page is served over https, so an `apiBase` on plain `http://`
  is blocked as mixed content. The receiver still plays what the sender handed it, but loses
  autoplay-next, re-resolution and remote logging. A cloudflared tunnel is https, so a normal
  install is fine; `http://localhost:3003` is not.
- **The backend must answer cross-origin.** It already sends `Access-Control-Allow-Origin: *`.

## Development

```sh
npm ci
npm run check   # Chrome 70 compatibility gate — also runs in CI
npm run serve   # static server on :3000
```

There is no build step. `index.html` is the deployment.

### The one hard rule: Chrome 70

1st/2nd-gen Chromecasts run Chrome 70 (CrKey/1.36). Syntax they don't know is not a degraded
feature — the HTML loads, the inline script never runs, and casting *silently does nothing* with
no error visible anywhere. Optional chaining (`?.`) and nullish coalescing (`??`) are the usual
way this happens.

`npm run check` (`scripts/check-compat.mjs`) is what keeps that from shipping: it parses the
inline script as ES2019 (exactly Chrome 70's ceiling — ES2019 syntax is all supported, ES2020 is
not), greps for runtime APIs a parser can't see (`Object.fromEntries`, `replaceAll`, `globalThis`,
…), and greps the CSS for properties that are too new (`gap` in flex, `inset`, `clamp()`,
`:is()`, `aspect-ratio`, `backdrop-filter`, logical properties). The full reasoning is in the
comments at the top of `index.html`.

The file stays a **single** file with inline CSS and JS on purpose: a Chromecast will happily hold
stale JS against freshly fetched HTML.

## Deploying

Push to `main`; Vercel builds nothing and serves `index.html` at `/` (`/receiver` also works, via
a rewrite in `vercel.json`).

**The URL registered in the Cast console must be the production alias**,
`https://cast-receiver-enrico08.vercel.app/` — *not* the per-deployment
`cast-receiver-<hash>-enrico08.vercel.app`, which changes on every push and would point the app id
at a build that is about to go stale.

Two settings that are not optional:

- **`Cache-Control: no-store`** on everything — set in `vercel.json`. Chromecasts cache receiver
  HTML aggressively enough to hide a build you just deployed and cost you a day of debugging.
- **Deployment Protection must be off.** It is on by default on new projects, and with Vercel's
  SSO enabled the Chromecast gets a 302 to `vercel.com/sso-api` instead of the receiver — a
  failure that looks exactly like "casting does nothing". Settings → Deployment Protection →
  Vercel Authentication → Disabled.

## Registering your own receiver

The default app id `BF64D6B2` points at this deployment. To run your own:

1. In the [Google Cast SDK Developer Console](https://cast.google.com/publish), add a **Custom
   Receiver** whose URL is your deployment's https URL.
2. Register your Chromecast's serial number as a test device — unpublished receiver changes are
   only visible to registered devices, and it takes ~15 minutes plus a reboot to take effect.
3. Set `CAST_RECEIVER_APP_ID` in your Streamio backend's `.env`. It's served to both senders at
   runtime via `GET /api/cast-config`, so no client release is needed.

## Debugging

A Chromecast has no visible console, so the receiver mirrors its logs to
`GET /api/cast-log` on whatever `apiBase` it was given — they appear as `[CAST-RECEIVER]` lines in
the backend's container logs. Lines produced before the first LOAD (SDK start, sender connect) are
buffered and flushed as soon as an `apiBase` arrives, since those are the ones that matter when
nothing plays.

For a device on your network, `chrome://inspect` → **Other** also reaches the receiver's real
DevTools once the device is registered for debugging.
