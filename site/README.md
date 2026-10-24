# SyncAction product site

This standalone, dependency-free static site introduces SyncAction through one original product
film. Serve this directory as the document root; no build, account, database or extension permission
is needed. It does not connect to a room, collect telemetry or make external requests until a
visitor follows an external download or documentation link.

## Film as the product surface

The v6 homepage opens with “天涯共此时” and a single integrated 30-second film. It replaces the
simulated browser hero, interactive fake room and FAQ. Three short feature links seek within the
same film; downloads and a compact first-use path follow. The existing brand and original landscape
remain. No external fonts, framework or third-party playback library is required.

The film starts muted when visible. Sound requires a deliberate action. Native media controls,
captions, pause, fullscreen, direct MP4 download and a text description remain available. Manual
pause survives scrolling away and returning. Offscreen or inactive playback pauses and resumes only
if playback was wanted. Reduced-motion and save-data preferences show the small WebP poster without
loading MP4 or VTT until requested. Navigation, installation instructions and direct film/download
links work without JavaScript. The page never captures scrolling or scrubs the film from scroll.

`hero.css` owns the homepage layout, `hero.js` owns the media lifecycle, and `app.js` owns server
address copying with a manual-selection fallback. Historical `styles.css` and v1–v5 media URLs
remain present for cached pages. The separate deterministic Canvas authoring surface is documented
in [film source notes](film-source/README.md). The imagery and soundtrack are original
illustrations, not a live room recording or an Apple asset.

## Product and release boundaries

Each person installs the desktop Chrome / Edge extension and plays their own content. Opening a
page, room connection and media-group participation are separate actions. Page collaboration needs
site permission and compatible content. Permission revocation stops future collaboration; it does
not delete previously shared room information. Screen/video streaming and remote device control are
not promised.

Application download links still target v0.9.14. Website/film revisions do not upgrade the extension
or server. The public server address is not an administrative URL; never put credentials or private
configuration in this directory. Existing users should retain the extension directory and identity
when reloading an update. Detailed installation and compatibility notes live in the linked client
guide rather than in a marketing-page FAQ.

## Hosting and verification

Serve `index.html` over HTTPS. Preserve the existing upstream for public API and Socket.IO routes;
do not expose administrative routes or rewrite unknown static files to the homepage. Serve MP4 as
`video/mp4` with byte ranges, VTT as `text/vtt`, and WebP as `image/webp`.

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cache-Control: public, max-age=300
```

Keep unversioned HTML/CSS/JS caches short. Apply static-site policies only to the static site, not
API responses. Stage an immutable release, preserve previous media and a rollback snapshot, then
atomically update the owned route. Do not reload an unverified configuration or restart unrelated
services.

Browser acceptance covers 320–1920px layout, direct muted playback, sound, native controls,
fullscreen, chapter seeking, manual-pause continuity, offscreen suspension, captions, reduced
motion, save-data fallback, no-JavaScript links, keyboard access, copy rejection and real HTTPS
downloads. Browser emulation and code checks do not constitute physical-device or user research.
