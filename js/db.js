// IndexedDB storage for tracks (audio blobs + metadata) and playlists.
const DB_NAME = 'musicdeck';
const DB_VERSION = 1;

let dbPromise = null;

/**
 * Open (or reuse) the database connection.
 *
 * Hardened for two WebKit (Safari / iOS) behaviours that otherwise leave the library looking empty:
 *  - the first indexedDB.open() after a page load can stay pending until IndexedDB is touched
 *    again, so we nudge it with indexedDB.databases() and retry if it still doesn't open;
 *  - the connection can be closed by the OS while the app is in the background, so a lost
 *    connection is forgotten and reopened on the next request.
 */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await openOnce([1500, 4000, 8000][attempt - 1]);
      } catch (err) {
        lastError = err;
        console.warn(`MusicDeck: opening storage failed (attempt ${attempt})`, err);
      }
    }
    throw lastError;
  })();
  dbPromise.catch(() => { dbPromise = null; }); // let the next call try again
  return dbPromise;
}

function openOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      settled = true;
      clearInterval(nudge);
      clearTimeout(timer);
    };

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    const nudge = setInterval(() => { indexedDB.databases?.().catch(() => {}); }, 100);
    const timer = setTimeout(() => {
      finish();
      reject(new Error('Timed out opening storage'));
    }, timeoutMs);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const tracks = db.createObjectStore('tracks', { keyPath: 'id' });
        tracks.createIndex('addedAt', 'addedAt');
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; } // a retry already took over
      finish();
      const forget = () => { if (dbPromise) dbPromise = null; };
      db.onclose = forget;                                   // closed by the browser/OS
      db.onversionchange = () => { db.close(); forget(); };  // a newer version opened elsewhere
      resolve(db);
    };
    req.onerror = () => { finish(); reject(req.error); };
    req.onblocked = () => console.warn('MusicDeck: storage is blocked by another open tab of the app');
  });
}

function runTx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode); // throws if the connection was lost
    const store = t.objectStore(storeName);
    const result = fn(store);
    // A request resolves to its result — which is undefined when a get() finds nothing.
    t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  try {
    return await runTx(db, storeName, mode, fn);
  } catch (err) {
    // Connection went away (e.g. iOS suspended the app): reopen once and retry.
    if (err?.name === 'InvalidStateError' || /connection|closing/i.test(err?.message ?? '')) {
      dbPromise = null;
      return runTx(await openDB(), storeName, mode, fn);
    }
    throw err;
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

// ---- Tracks ----

/** Store a File/Blob. Returns the saved track record. */
export async function addTrack(file) {
  const track = {
    id: uid(),
    title: file.name.replace(/\.[^.]+$/, ''),
    fileName: file.name,
    type: file.type,
    size: file.size,
    duration: await probeDuration(file), // seconds, or null if the browser can't tell
    addedAt: Date.now(),
    blob: file,
  };
  await tx('tracks', 'readwrite', (s) => s.put(track));
  return track;
}

export const getTrack = (id) => tx('tracks', 'readonly', (s) => s.get(id));

/** Read a file's length in seconds by loading just its metadata. Resolves null if unknown. */
export function probeDuration(blob, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    let timer;
    const done = (value) => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : null);
    };
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) return done(audio.duration);
      // Some files (e.g. WebM) report Infinity until the browser seeks to the end.
      audio.addEventListener('durationchange', () => {
        if (Number.isFinite(audio.duration)) done(audio.duration);
      });
      audio.currentTime = 1e9;
    });
    audio.addEventListener('error', () => done(null));
    timer = setTimeout(() => done(null), timeoutMs);
    audio.src = url;
  });
}

/** Fill in the duration for a track saved before durations were recorded. */
export async function backfillDuration(id) {
  const record = await getTrack(id);
  if (!record || record.duration !== undefined) return record?.duration ?? null;
  const duration = await probeDuration(record.blob);
  await tx('tracks', 'readwrite', (s) => s.put({ ...record, duration }));
  return duration;
}

/** Delete a track and remove it from every playlist that contains it. */
export async function deleteTrack(id) {
  await tx('tracks', 'readwrite', (s) => s.delete(id));
  const playlists = await allPlaylists(); // includes Favorites
  for (const pl of playlists) {
    if (pl.trackIds.includes(id)) {
      await savePlaylist({ ...pl, trackIds: pl.trackIds.filter((t) => t !== id) });
    }
  }
}

/** All tracks, oldest first, without blobs (keeps the list light). */
export async function listTracks() {
  const all = await tx('tracks', 'readonly', (s) => s.index('addedAt').getAll());
  return all.map(({ blob, ...meta }) => meta);
}

// ---- Playlists ----

export async function savePlaylist({ id = uid(), name, trackIds = [], createdAt = Date.now() }) {
  const playlist = { id, name, trackIds, createdAt, updatedAt: Date.now() };
  await tx('playlists', 'readwrite', (s) => s.put(playlist));
  return playlist;
}

export const getPlaylist = (id) => tx('playlists', 'readonly', (s) => s.get(id));

/** All playlists, oldest first. */
const allPlaylists = () => tx('playlists', 'readonly', (s) => s.getAll());

/** User playlists, oldest first (Favorites is stored here too but kept out of this list). */
export async function listPlaylists() {
  const all = await allPlaylists();
  return all
    .filter((pl) => pl.id !== FAVORITES_ID)
    .sort((a, b) => (a.createdAt ?? a.updatedAt) - (b.createdAt ?? b.updatedAt));
}

// ---- Favorites (a playlist under the hood, with a fixed id) ----

export const FAVORITES_ID = 'favorites';

export async function getFavorites() {
  return (await getPlaylist(FAVORITES_ID)) ?? { id: FAVORITES_ID, name: 'Favorites', trackIds: [] };
}

/** Star / unstar a track. Returns true if it's now a favorite. Newest favorites go to the top. */
export async function toggleFavorite(trackId) {
  const fav = await getFavorites();
  const isFav = fav.trackIds.includes(trackId);
  const trackIds = isFav ? fav.trackIds.filter((id) => id !== trackId) : [trackId, ...fav.trackIds];
  await savePlaylist({ ...fav, trackIds });
  return !isFav;
}

/** Append tracks to a playlist, skipping ones already in it. Returns how many were added. */
export async function addToPlaylist(playlistId, trackIds) {
  const pl = await getPlaylist(playlistId);
  if (!pl) return 0;
  const fresh = trackIds.filter((id) => !pl.trackIds.includes(id));
  if (fresh.length) await savePlaylist({ ...pl, trackIds: [...pl.trackIds, ...fresh] });
  return fresh.length;
}

export async function removeFromPlaylist(playlistId, trackId) {
  const pl = await getPlaylist(playlistId);
  if (!pl) return;
  await savePlaylist({ ...pl, trackIds: pl.trackIds.filter((id) => id !== trackId) });
}
export const deletePlaylist = (id) => tx('playlists', 'readwrite', (s) => s.delete(id));

// ---- Storage ----

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
