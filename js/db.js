// IndexedDB storage for tracks (audio blobs + metadata) and playlists.
const DB_NAME = 'musicdeck';
const DB_VERSION = 1;

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const result = fn(store);
        t.oncomplete = () => resolve(result?.result ?? result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
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
    addedAt: Date.now(),
    blob: file,
  };
  await tx('tracks', 'readwrite', (s) => s.put(track));
  return track;
}

export const getTrack = (id) => tx('tracks', 'readonly', (s) => s.get(id));
export const deleteTrack = (id) => tx('tracks', 'readwrite', (s) => s.delete(id));

/** All tracks, oldest first, without blobs (keeps the list light). */
export async function listTracks() {
  const all = await tx('tracks', 'readonly', (s) => s.index('addedAt').getAll());
  return all.map(({ blob, ...meta }) => meta);
}

// ---- Playlists ----

export async function savePlaylist({ id = uid(), name, trackIds = [] }) {
  const playlist = { id, name, trackIds, updatedAt: Date.now() };
  await tx('playlists', 'readwrite', (s) => s.put(playlist));
  return playlist;
}

export const listPlaylists = () => tx('playlists', 'readonly', (s) => s.getAll());
export const deletePlaylist = (id) => tx('playlists', 'readwrite', (s) => s.delete(id));

// ---- Storage ----

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
