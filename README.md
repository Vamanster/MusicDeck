# MusicDeck
Local music player — a plain HTML/CSS/JavaScript Progressive Web App. Audio files you add are stored in the browser's IndexedDB on your device and never uploaded anywhere.

## Run it locally

Service workers only run on `https://` or `http://localhost`, so open the app through a local server rather than double-clicking `index.html`. Any static server works, for example:

```sh
# Python
python -m http.server 8080

# Node
npx serve .
```

Then visit <http://localhost:8080>. In Chrome/Edge an **Install** button appears in the top bar (or use the install icon in the address bar).

## Project structure

```
index.html              App shell markup
manifest.webmanifest    PWA manifest (name, icons, colors, file handlers)
sw.js                   Service worker — caches the app shell for offline use
css/styles.css          Styles (dark/light via prefers-color-scheme)
js/app.js               Entry point: UI wiring, install prompt, SW registration + update toast
js/db.js                IndexedDB storage for tracks (audio blobs) and playlists
js/player.js            Playback: queue, prev/next, loop (off/all/one), Media Session controls
icons/                  App icons (any + maskable) and favicon
icons/ui/               Interface icons (Tabler SVGs), drawn via CSS masks so they follow the theme colour
```

To add an interface icon: drop the SVG in `icons/ui/`, add a `.i-<name>` rule in `css/styles.css`, list it in `APP_SHELL` in `sw.js`, and use `<span class="icon i-<name>"></span>`.

## Updating the app

When you change any file listed in `APP_SHELL` inside `sw.js`, bump `CACHE_VERSION` (e.g. `v1` → `v2`). Returning users get a "new version available" toast and can reload into the update.

## Debugging tips

- Chrome DevTools → **Application** tab shows the manifest, service worker, cache storage and IndexedDB.
- Tick **Update on reload** under Service Workers while developing so changes show up immediately.
- Lighthouse → **PWA** checks installability.

## Features so far

- Add audio by file picker, drag-and-drop, or "Open with" (Chromium desktop, when installed)
- Library persisted in IndexedDB, with persistent-storage request
- Play / pause, previous / next, seek, with elapsed / total time above the scrubber (m:ss); dragging the scrubber seeks a few times a second at lower volume instead of screeching
- Track lengths shown on the right of each track; measured once at import (older tracks are measured in the background)
- All music: shuffle button plus loop off / all / one (loop all reshuffles each pass)
- Controls use the same layout everywhere: play order on the left, repeat on the right. Playlists: in order / shuffle + repeat on/off (off by default). Favorites has its own settings: in order / shuffle / one track + repeat (on by default) — in one-track mode repeat loops the current track, and with repeat off playback stops after it. Pressing Play after a playlist finishes starts it again from the top
- Playing playlist is highlighted with a pause button on the Playlists page; the player shows where the track is playing from
- All music / Playlists / Favorites tabs above the player; player controls are centred at every screen size
- Favorites: tap the star on any track; stored as a hidden playlist (not listed under Playlists), newest first, repeats by default (reshuffling each pass)
- Playlists: create, rename, delete, add tracks (from a track's playlist button or "Add tracks" in a playlist), remove tracks, play
- iOS: the Install button opens a short Add to Home Screen guide (iOS has no install prompt)
- Lock-screen and media-key controls via the Media Session API
- Works offline after first load

Planned: reordering playlist tracks, metadata (ID3 tags/artwork), search.
