# Product film source — v3

The 36-second film is an original vector product illustration, not a live room recording.
`/film.html?render=1` is a fixed 1440×810 surface. `window.renderFilm(seconds)` produces
deterministic frames after `window.filmReady`, without starting playback, sending business commands
or granting website permissions. The preview is silent; the public MP4 has an original 36-second
electronic score.

## Direction and pacing

One person browses for three seconds. The second person enters on the 3.000-second drum/bass onset.
The edit alternates browser context, a video close-up, shared-page lists, a full-page annotation,
parallel playback groups, two independent device views, compact recovery, three first-use stages,
and site permission. At 30 seconds it explicitly switches to another already-authorized compatible
page. Two new people enter on the 30.5 and 31-second beats; all four remain visible from 31.7
seconds through the ending. Four local pointers converging on a shared focus also form the new brand
mark.

The film is 36 seconds / 30 fps / 1,080 frames. Content uses 280 ms crossfades with a subtle scale
settle; typography leaves and arrives continuously. Pointers are drawn once above those content
transforms and are never repositioned by a scene change. Chapter transitions do not fade or recreate
them.

`film-motion.js` owns four complete canvas-space trajectories (`you`, `friend`, `mei`, `zhou`),
including offscreen travel. Time-aware cubic Hermite segments preserve velocity through ordinary
browsing knots. Authored reading and clicking stops dwell; curved approaches, unequal timings and
small target corrections replace the old repeated straight-line quintic starts/stops. No random
jitter, identical orbit, cursor trail or pointer rotation is added. These are authored motion
choices, not measured human traces or a claim of biometric realism. Numerical checks are regression
guards; final real-time motion and decoded frames need visual review too.

Clicks and UI confirmations share one event timeline. Seek and the pen stroke share their progress
with their pointer tips. `window.filmState` includes every identity/position, targets, transition
progress, fixed camera offset and visibility even when outside the canvas. Canvas clipping alone
controls physical visibility. Names/colors stay stable, including the four-person ending.

| Seconds | Illustrated action                                                               |
| ------- | -------------------------------------------------------------------------------- |
| 0–3     | One cursor on an already-authorized video page                                   |
| 3–6     | Friend explicitly joins on their own device                                      |
| 6–9     | Leader pauses/seeks; following aligns and remains paused                         |
| 9–12    | Share, find a member location, open a page without joining playback              |
| 12–15   | Authorized same-page pointer, deliberately sent danmaku and drawing              |
| 15–18   | View B while remaining in A, then return                                         |
| 18–21   | Recipient accepts invitation; a separate owner approves another room's request   |
| 21–24   | Reconnect and reread committed room state; media status stays separate           |
| 24–27   | Verify server, await admin approval, explicitly log in, continue original target |
| 27–30   | Read/agree, allow site collaboration, revoke future collaboration                |
| 30–33   | A different already-authorized compatible page, four people together             |
| 33–36   | Four identities continue moving around brand and URL                             |

## Assets, distribution and verification

The landscape and UI are code-drawn. The new Converge icon is the original canonical SVG from
`design/brand`, with optical 16/32 px artwork and a monochrome variant; no Apple footage, fonts or
interface assets are bundled. Restrained light surfaces, blue emphasis and purposeful motion are
inspired by Apple design principles. No external song, sample, video, real account or private room
is used. The score has no speech, and ends with a designed cadence rather than a hard trim.

The homepage uses `syncaction-film-v3-*` assets and loads no MP4/poster/VTT until opened. Native
controls support playback, seeking, volume, captions and fullscreen. Closing unloads media and
returns focus. No-JavaScript direct links and a transcript remain. Previous v1/v2 media URLs are
retained for cached pages and existing links. The illustration does not promise every website or
player works, DOM coediting, video streaming, or connection automatically meaning media is followed.

`pnpm test:tooling` covers all four identities, continuity, curved pass-through routes, click
anchors, shared seek/pen progress, independent endings and final four-person spacing. Independent
acceptance samples at 120 Hz and 30 fps, checks rendered and actual encoded frames, decodes the full
H264/AAC media and exercises the real browser player. Native controls and the video itself remain
user initiated; reduced-motion users are never forced into autoplay.
