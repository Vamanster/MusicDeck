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
```

## Updating the app

When you change any file listed in `APP_SHELL` inside `sw.js`, bump `CACHE_VERSION` (e.g. `v1` → `v2`). Returning users get a "new version available" toast and can reload into the update.

## Debugging tips

- Chrome DevTools → **Application** tab shows the manifest, service worker, cache storage and IndexedDB.
- Tick **Update on reload** under Service Workers while developing so changes show up immediately.
- Lighthouse → **PWA** checks installability.

## Features so far

- Add audio by file picker, drag-and-drop, or "Open with" (Chromium desktop, when installed)
- Library persisted in IndexedDB, with persistent-storage request
- Play / pause, previous / next, seek, loop off / all / one
- Lock-screen and media-key controls via the Media Session API
- Works offline after first load

Planned: playlists UI, shuffle, metadata (ID3 tags/artwork), search.
