# The Streamio Cast protocol

This is the canonical description of what a Streamio **sender** must send and what this
**receiver** does with it. The receiver is the one implementation both senders have to satisfy,
so the contract lives in this repo; the senders are:

- `public/scripts/watch.js` (`buildCastCustomData()`) in **streamio-website**
- `lib/core/cast/cast_payload.dart` (`CastPayload`) in **streamio-app**

Three independent implementations of one shape. Changing it means changing three files.

---

## 1. `customData` (contract version 1)

Attached to every `LOAD` request. **Every field is optional** — the receiver degrades field by
field rather than rejecting a payload. Adding a field therefore never needs a coordinated
release across the three repos; removing or renaming one does.

| Field | Type | Meaning if absent |
| --- | --- | --- |
| `v` | number | Contract version. Defaults to 1. |
| `apiBase` | string | **The Streamio install to talk to.** Without it the receiver has no backend at all: no autoplay-next, no re-resolve, no remote logging. Trailing slashes are stripped. |
| `castProxyBase` | string | Absolute prefix for `/api/cast-proxy?url=`. Derived from `apiBase` if omitted. Must match `CAST_PROXY_PREFIX` in the backend's `routes/content.router.ts` character for character — the receiver has no page origin, so a mismatch means the master manifest loads and every segment 404s. |
| `provider` | string | Sent as `?provider=` on API calls. Omitted entirely when empty, so the server picks its default — an empty `provider=` is not the same as no param. |
| `contentType` | `"episode"` \| `"movie"` | `"episode"`. A movie gets no up-next; recovery still works. |
| `showId`, `seasonId`, `episodeId` | string | Queue and recovery are disabled without `showId`/`episodeId`. |
| `showTitle`, `episodeTitle`, `episodeLabel`, `description` | string | Falls back to `MediaInformation.metadata` (`seriesTitle`, `title`, `season`/`episode`), then to `"Streamio"`. |
| `poster`, `backdrop` | string (URL) | Falls back to `metadata.images[0].url`; the backdrop falls back to the poster. |
| `seasonNumber`, `episodeNumber`, `durationSeconds` | number \| null | Cosmetic. |
| `serverName`, `serverIndex` | string / number | Which upstream server the sender was using. The receiver prefers it when re-resolving, then rotates through the rest. |
| `subtitles` | array | See below. |
| `episodes` | array | The receiver fetches the episode list itself from the API instead. Capped at 500. |
| `episodeIndex` | number | Located by matching `episodeId` against `episodes`. |
| `autoplayNext` | boolean | `true`. Only `false` disables it. |
| `upNextSeconds` | number | `20` — how long before the end the up-next card appears. |

**`episodes[]`** entries are deliberately short-keyed, because the whole list travels in every
LOAD: `{ id, sid, s, e, t }` — id, season id, season number, episode number, title. `sid` is what
lets the receiver keep `seasonId` correct when it crosses a season boundary on its own;
streamio-app sends it, `buildCastCustomData()` in watch.js currently does not (the receiver then
keeps the season id it already had).

**`subtitles[]`** entries accept `{ label, lang, url | file | src, default | initialDefault }`.
Each URL is wrapped through `castProxyBase` before being handed to CAF.

### The degradation ladder

1. **No `customData` at all** — title/poster from `MediaInformation.metadata`, no autoplay-next,
   no re-resolve. This is a live code path, not a hypothetical: an older streamio-app build still
   installed on someone's phone lands here, and it must play rather than error.
2. **No `episodes`** — the receiver fetches the list itself.
3. **No `showId`/`provider`** — metadata renders; queue and recovery are off.
4. **`contentType: "movie"`** — no up-next; recovery still works.

---

## 2. The control channel

Namespace: **`urn:x-cast:com.streamio.control`**

### Sender → receiver

| Message | Payload | Effect |
| --- | --- | --- |
| `HELLO` | — | Receiver replies with a `STATE`. Send it on connect. |
| `SET_CONTEXT` | `{ customData }` | Re-applies the whole contract above without a new LOAD. |
| `SET_QUEUE` | `{ episodes, episodeIndex? }` | Replaces the episode list (capped at 500). |
| `SET_AUTOPLAY` | `{ enabled }` | Only `false` turns it off. Cancels an armed up-next. |
| `PLAY_EPISODE` | `{ index }` or `{ episodeId }`, `positionSeconds?` | Jumps to an episode in the queue. |
| `PLAY_NEXT_NOW` | — | Fires an armed up-next immediately, or resolves the next episode if none is armed. |
| `CANCEL_UPNEXT` | — | Cancels the up-next **and** turns autoplay off. |
| `SET_SUBTITLE` | `{ trackId }` | `trackId <= 0` clears all text tracks. |

### Receiver → sender

| Message | Payload |
| --- | --- |
| `STATE` | `phase`, `provider`, `showId`, `showTitle`, `contentType`, `episodeId`, `episodeIndex`, `episodeLabel`, `episodeTitle`, `positionSeconds`, `durationSeconds`, `playing`, `autoplayNext`, `subtitleTracks[{id,name,lang}]`, `activeTrackId`. Broadcast on every phase change and every 5s while playing. |
| `EPISODE_CHANGED` | `episodeId`, `episodeIndex`, `episodeLabel`, `seasonNumber`, `episodeNumber`, `title` |
| `UPNEXT` | `episodeId`, `label`, `title`, `secondsLeft` |
| `RECOVERING` | `attempt`, `positionSeconds` |
| `ERROR` | `code`, `message`, `recoverable` |

`phase` is one of `IDLE`, `LOADING`, `RESOLVING`, `PLAYING`, `PAUSED`, `UPNEXT`, `RECOVERING`,
`ERROR`.

---

## 3. The backend API the receiver calls itself

This is what makes autoplay survive the sender's tab closing, and it is a **cross-repo contract**:
the receiver deploys independently of any Streamio install, so it has to keep working against
backends older than itself.

All calls go to `apiBase`, with `?provider=` appended when a provider is known.

| Endpoint | Used for |
| --- | --- |
| `GET /api/shows/:id` | Season list, when the receiver has to build the queue itself. |
| `GET /api/seasons/:id/episodes` | The episode list (scans up to 20 seasons). |
| `GET /api/episodes/:id/servers?contentType=` | Available servers for an episode/movie. |
| `POST /api/episodes/:id/video?contentType=` body `{server}` | Resolving a playable URL. The response is coalesced `playlistUrl \|\| source \|\| url`, same as `buildPlayableUrl()` in watch.js. Non-`http(s)` sources (`blob:`, `data:`) are rejected — a Chromecast can't fetch them. |
| `GET /api/cast-proxy?url=` | Every media and subtitle URL. Never bypass it: several upstreams pin CORS to their own origin or require headers a page can't set. |
| `GET /api/cast-log?ts=&msg=` | Remote logging — `[CAST-RECEIVER]` lines in the backend's container logs. A Chromecast has no visible console, so this is the primary way to diagnose "connects but won't play". |

Two backend requirements follow from hosting this receiver on a separate origin:

- **CORS.** All of the above must be reachable cross-origin. The Streamio backend already sends
  `Access-Control-Allow-Origin: *` globally.
- **HTTPS.** This page is served over https, so an `apiBase` on plain `http://` is blocked as
  mixed content — the receiver then falls back to rung 1 of the ladder.

---

## 4. Rules that are easy to break

- **A resolved stream is never cached.** The URLs expire in minutes; the receiver re-resolves per
  playback attempt, and again after a segment error.
- **Never redirect `/api`.** CAF refuses to chase a cross-origin 302 for an HLS master manifest
  (instant error 905), and a 302'd POST doesn't survive as a POST, which would break
  re-resolution. The `redirect/` service in streamio-website reverse-proxies `/api` for exactly
  this reason.
- **`castProxyBase` must be absolute.** The receiver has no page origin to resolve a relative URL
  against.
