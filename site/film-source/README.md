# Product film source

The 47-second film is an original vector product illustration, not a recording of a live room.
`/film.html?render=1` is the fixed 1440×810 rendering surface; `/film.js` exposes
`window.renderFilm(seconds)` after `window.filmReady` becomes true. Rendering a given time does not
start playback, make a business request or grant a website permission. The preview has no
soundtrack.

The public MP4 combines 1,410 deterministic frames at 30 fps with an original 47-second electronic
score. The first kick/bass occurs at exactly 3.000 seconds, matching the second cursor's entrance.
No external song, video, stock recording, audio sample, real account or private room is used. The
landscape is drawn in code, and the logo is the existing project asset. The soundtrack has no
speech. Chinese captions and an HTML transcript describe the illustrated actions.

| Seconds | Illustrated action                                                              |
| ------- | ------------------------------------------------------------------------------- |
| 0–3     | One cursor browsing a playing video page; current site already authorized       |
| 3–7     | Second cursor enters; friend explicitly joins on their own device               |
| 7–11    | Leader pauses and seeks; follower aligns without implicitly resuming            |
| 11–15   | Share a page, identify member location and open a shared page                   |
| 15–19   | Authorized same-page pointer, user-sent danmaku and drawing together            |
| 19–23   | View group B while remaining in group A                                         |
| 23–27   | Recipient accepts invitation; separate owner approves a join request            |
| 27–31   | Reconnect and reread a committed room snapshot; media status remains separate   |
| 31–35   | Server setup, pending approval, explicit login and original-target continuation |
| 35–39   | Read site consent, explicitly allow, then revoke; remote collaboration stops    |
| 39–43   | Desktop Chrome/Edge ZIP, MIT source and self-hosting                            |
| 43–47   | Brand, URL and invitation to learn/download                                     |

The homepage loads no film or caption bytes until the viewer opens it. Native video controls provide
pause, seeking, volume, captions and fullscreen. Closing the dialog pauses and unloads the media;
leaving the tab pauses playback. The download link works without JavaScript. This illustration does
not promise every website/player works or that connection alone means media is following.

## Motion and visual direction (v2)

The film uses a restrained light canvas, neutral surfaces, subtle depth, standard small arrow
pointers and blue emphasis. These are Apple-inspired visual principles; no Apple font, footage or
interface asset is bundled. The SyncAction logo and product remain their own identity.

`film-motion.js` owns one full 47-second world-space trajectory for each person (`you` and
`friend`). Chapters do not create, reposition or hide cursors. Both are rendered on every frame,
including when outside the canvas; the canvas clips them naturally. The second person enters from
the right on the 3-second downbeat. Each person exits continuously when the next workflow belongs to
a different device. The friend returns from the right on the 39-second phrase. Names and colors stay
stable, including the ending. No ending-only pointers are drawn.

Quintic interpolation gives semantic stops zero velocity and acceleration. Clicks occur during
stationary holds, inside the drawn controls; the same event timeline confirms the resulting UI. The
paused seek and continuous pen stroke share their progress with their pointer tracks. There are no
chapter camera translations. `window.filmState` exposes both tracks, including offscreen positions,
their target rectangles and the fixed camera offset for independent sampling.

`pnpm test:tooling` includes motion regression coverage across all chapters, offscreen movement,
click targets and the pen transition. Rendering acceptance also samples every 1/120 second and
validates all 1,410 rendered frames at 30 fps, fully decodes the encoded video and reviews decoded
keyframes. Speed limits in those tests are project regression guards, not Apple accessibility or
design standards.

The homepage selects the versioned `syncaction-film-v2-*` media. Previous media URLs remain
available for cached pages and existing direct links; they are not preloaded or selected by the new
player.
