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
| `tmdbId`, `imdbId`, `year` | number / string / number | Hints for the receiver's own Skip Intro/Recap/Credits/Preview lookup (§5). Absent `tmdbId` is derived from `showId` itself when it looks like `movie-<id>`/`tv-<id>` (the `tmdb` family's wire shape); absent everything falls back to a title-only fuzzy match against `showTitle`. |
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

Skip Intro/Recap/Credits/Preview (§5) sits *outside* this ladder, deliberately looser than the
queue: it only needs a usable `title` (from `customData.showTitle`, or the MediaInformation
fallback in rung 1) or a `tmdbId`/`imdbId`, so it can still work when queue/recovery can't.

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
| `SET_AUDIO_TRACK` | `{ trackId }` or `{ language }` | Switches the audio rendition. `trackId` wins when both are present; `language` exists so a sender can ask for what it wants without holding an id that an episode change has invalidated. A no-op when the device can't enumerate the tracks — see `audioTracks` below. |
| `SKIP_SEGMENT_NOW` | — | Runs the same action as pressing the on-screen Skip button (§5) if one is currently active; no-op otherwise. |

### Receiver → sender

| Message | Payload |
| --- | --- |
| `STATE` | `phase`, `provider`, `showId`, `showTitle`, `contentType`, `episodeId`, `episodeIndex`, `episodeLabel`, `episodeTitle`, `positionSeconds`, `durationSeconds`, `playing`, `autoplayNext`, `subtitleTracks[{id,name,lang}]`, `activeTrackId`, `audioTracks[{id,name,lang}]`, `activeAudioTrackId`, `skipSegment`. Broadcast on every phase change, on every skip-segment show/hide, and every 5s while playing. |
| `EPISODE_CHANGED` | `episodeId`, `episodeIndex`, `episodeLabel`, `seasonNumber`, `episodeNumber`, `title` |
| `UPNEXT` | `episodeId`, `label`, `title`, `secondsLeft` |
| `RECOVERING` | `attempt`, `positionSeconds` |
| `ERROR` | `code`, `message`, `recoverable` |

`phase` is one of `IDLE`, `LOADING`, `RESOLVING`, `PLAYING`, `PAUSED`, `UPNEXT`, `RECOVERING`,
`ERROR`.

**`subtitleTracks` and `audioTracks` come from different places, and only one of them is
guaranteed.** Subtitles are tracks the sender (or the receiver) declared on the LOAD, so they are
always enumerable. Audio renditions live *inside* the HLS manifest and are read back from CAF's
`AudioTracksManager` — but playback here is the device's native pipeline, so whether CAF's JS
layer can see them at all is a property of the device and the stream. **`audioTracks: []` is a
normal answer**: a sender must hide its language control rather than show an empty picker, and
must tolerate the field being absent entirely (a Chromecast may be running a cached receiver
older than this contract). The receiver logs the count once a minute while playing, so
`[CAST-RECEIVER] audio tracks n=` in the backend's logs is how you tell the two apart.

`skipSegment` is `null`, or `{ type, label, endMs, runsToEnd }` — `type` is one of `intro`, `recap`,
`credits`, `preview`; `label` is the button text the receiver is showing ("Skip Intro", etc.).
Unlike every other `STATE` field, this one can also change *without* a phase change (it overlays
`PLAYING`/`PAUSED`, see §5), which is why the receiver broadcasts on its own show/hide too instead
of waiting for the next periodic tick.

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
| `GET /api/intro-segments?...` | Skip Intro/Recap/Credits/Preview timestamps (§5), via [TheIntroDB](https://theintrodb.org). Provider-agnostic, ungated, fail-silent server-side — an unanswerable request just means no Skip button, never a blocked or delayed LOAD. |

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

---

## 5. Skip Intro/Recap/Credits/Preview and remote control

The receiver fetches `/api/intro-segments` **itself**, the same way it fetches its own episode
queue (§3) — deliberately, not by having a sender hand it the segments directly, so this keeps
working for an episode the receiver advanced to on its own after the sender's tab/app is gone.
`tmdbId`/`imdbId`/`year` in `customData` (§1) are hints only: absent `tmdbId` is derived from
`showId` when it looks like the `tmdb` family's `movie-<id>`/`tv-<id>` shape, and absent everything
falls back to a title-only fuzzy match — the same fallback both senders' own local Skip Intro
lookups already use, and the same Redis-cached match `services/intro-db.service.ts` performs
either way, so asking twice (once from a sender, once from the receiver) costs nothing extra on a
cache hit.

The Skip button overlays `PLAYING`/`PAUSED` directly rather than being a `phase` of its own (a
`data-skip` attribute, alongside the existing transient info-bar/toast attributes) — it has to
coexist with ordinary playback, not replace it. It is mutually exclusive with the up-next card:
neither shows while the other is active. A `credits`/`preview` segment whose end "runs to the end
of media" behaves like up-next's "play now" instead of seeking to the literal last frame.

**Remote control.** The receiver listens for raw `keydown` events — the only way a physical TV
remote's D-pad reaches a Cast receiver at all, since that hardware doesn't speak through the Cast
media-command channel the way a remote's *dedicated* transport buttons do (those are already
covered by `options.supportedCommands` and need no code here). OK/Select activates whatever is
on screen (skips the active segment, or plays an armed up-next episode now) and otherwise toggles
play/pause; Back dismisses whatever is on screen without acting on it (snoozes the skip prompt for
the rest of that segment, or cancels up-next — the same effect as the sender's own `CANCEL_UPNEXT`);
Left/Right seek ±10s; a remote's own media play/pause key also toggles playback. None of this
requires a Cast session at all — it works against the receiver directly, exactly like a real
remote does.

**The keydown path only exists on devices that have input hardware** — a Cast-enabled TV, an
Android TV, a smart display. On a Chromecast **dongle** it is inert, and the distinction is not
academic: the stick has no receiver of its own, and an HDMI-CEC user-control message from the TV
is translated by the platform into a Cast *media command*, never into a `KeyboardEvent`. The
observable signature is a TV remote whose play/pause works while OK/Back/D-pad do nothing at
all — nothing is being delivered to the page for the section above to handle.

So on a dongle the transport keys are the only remote input there is — and there are fewer of them
than you would expect. Measured on a gen-1 behind a Samsung TV with Anynet+ on, **the only
commands that arrive at all are `PLAY` and `PAUSE`.** ⏭/⏮, FF/REW and STOP send nothing to the
dongle, and `QUEUE_NEXT`/`QUEUE_PREV` are not interceptable message types in CAF, so they cannot
be claimed even in principle (attempting it logs `[R][remote] cannot intercept QUEUE_NEXT`); they
are deliberately absent from `options.supportedCommands` so the phone's media notification doesn't
grow controls the receiver has no way to act on.

That leaves an input budget of two buttons, so the receiver overloads the one press that is
otherwise wasted: **a `PLAY` received while playback is already playing acts as OK/Select** —
it takes an active Skip, or starts an armed up-next early. `PAUSE` is deliberately left alone,
since pausing during an intro is legitimate and a two-button remote can't afford a conditional
button. Every intercepted command is logged as `[R][remote] cmd=`, because which physical button
maps to which command is a property of the TV's CEC implementation and cannot be determined
off-device.
