# SyncAction product site

This directory is a standalone, dependency-free marketing site. Serve its contents as the document
root; it does not require a build, account, database or extension permission. The interactive
product demonstration is local simulation, with no telemetry or connection to a room. It makes no
external requests until a visitor follows a download or documentation link.

The three scenes distinguish viewing a shared page, joining a playback group, and consent for page
collaboration. Playback starts only on request and its one-second timer stops when the demo is off
screen, the tab is hidden, or another scene is selected. Navigation, downloads, setup instructions
and native FAQ disclosure remain available without JavaScript. Browser testing should cover
responsive layout, keyboard tab selection, reduced motion, copy failure, timer suspension, and
no-JavaScript use.

## Hosting

Serve this directory over HTTPS with `index.html` as the root. Keep public API routes (`/v1/*`,
`/socket.io/*`, `/healthz`, `/readyz`) on the existing application upstream when hosting at the same
origin. Do not expose administrative routes. Return 404 for unknown files instead of rewriting every
request to the landing page. Do not replace another service's live configuration with an unverified
configuration file; preserve existing routes and take a rollback snapshot before adding a host.

Suggested response headers:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cache-Control: public, max-age=300
```

Keep cache duration short for the unversioned HTML, CSS and JavaScript. Apply these restrictive CSP
and cache policies to the static website, not API or Socket.IO responses. Deploy to an immutable
release directory and atomically update a `current` symlink so a failed release can be rolled back
without restarting the application or database.

## Release updates

The two download links and visible version currently target v0.9.14. When updating them, verify both
assets against the published GitHub release, update the client guide, and test the final links. The
server address is a public service address; never put credentials, administrative URLs or private
configuration in this directory.

## Product film

The homepage opens a 32-second original product illustration on request. Four cursors enter
progressively at0/3/8.5/14seconds and stay through the ending. It does not preload the MP4, poster
or Chinese captions before that request. Native controls, an HTML transcript, an MP4 download and
captions are available; closing the dialog unloads its media and returns focus. The soundtrack is
original synthesis with impact beats at3/8.5/14/28seconds. Its landscape is an original AI-generated
still with animated framing; UI and pointers remain code-drawn. See
[film source notes](film-source/README.md) for the scene contract and deterministic Canvas rendering
surface. Serve MP4 as `video/mp4` with byte range support and VTT as `text/vtt`; keep media allowed
only from the same origin in the static CSP.
