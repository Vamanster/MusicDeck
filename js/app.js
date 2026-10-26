// MusicDeck entry point: wires the UI to storage and playback, and registers the service worker.
import * as db from './db.js';
import { Player } from './player.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  fileInput: $('#file-input'),
  // views
  views: { library: $('#view-library'), playlists: $('#view-playlists'), playlist: $('#view-playlist') },
  tabs: document.querySelectorAll('.tab'),
  // library
  trackList: $('#track-list'),
  libraryEmpty: $('#library-empty'),
  // playlists
  playlistList: $('#playlist-list'),
  playlistsEmpty: $('#playlists-empty'),
  newPlaylistBtn: $('#new-playlist-btn'),
  // single playlist
  back: $('#back-btn'),
  plName: $('#pl-name'),
  plMeta: $('#pl-meta'),
  plTracks: $('#pl-tracks'),
  plEmpty: $('#pl-empty'),
  plPlay: $('#pl-play'),
  plAdd: $('#pl-add'),
  plRename: $('#pl-rename'),
  plDelete: $('#pl-delete'),
  // player
  title: $('#np-title'),
  source: $('#np-source'),
  play: $('#play-btn'),
  prev: $('#prev-btn'),
  next: $('#next-btn'),
  mode: $('#mode-btn'),
  seek: $('#seek'),
  // misc
  install: $('#install-btn'),
  toast: $('#update-toast'),
  updateBtn: $('#update-btn'),
  notice: $('#notice'),
};

const player = new Player();
const state = {
  loaded: false,
  tracks: [],
  playlists: [],
  view: 'library',
  openPlaylistId: null,
};

// ---------- Helpers ----------

function icon(name) {
  const span = document.createElement('span');
  span.className = `icon i-${name}`;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function iconButton(name, label, onClick, extraClass = '') {
  const btn = document.createElement('button');
  btn.className = `icon-btn ${extraClass}`.trim();
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.append(icon(name));
  btn.addEventListener('click', onClick);
  return btn;
}

function textButton(text, label, onClick, extraClass = '') {
  const btn = document.createElement('button');
  btn.className = `icon-btn ${extraClass}`.trim();
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let noticeTimer;
function notify(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { els.notice.hidden = true; }, 2200);
}

/** Opens a <dialog> and resolves with the value of the button that closed it. */
function openDialog(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true });
    dialog.showModal();
  });
}

// Cancel buttons are type="button" so Enter in a text field submits the primary action instead.
document.querySelectorAll('dialog [data-close]').forEach((btn) =>
  btn.addEventListener('click', () => btn.closest('dialog').close('cancel'))
);
// Tapping the dimmed backdrop closes a dialog.
document.querySelectorAll('dialog').forEach((d) =>
  d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); })
);

async function askName(title, initial = '') {
  const dialog = $('#name-dialog');
  const input = $('#name-input');
  $('#name-dialog-title').textContent = title;
  input.value = initial;
  const pending = openDialog(dialog);
  input.focus();
  input.select();
  const result = await pending;
  const name = input.value.trim();
  return result === 'ok' && name ? name : null;
}

async function confirmDelete(title, text) {
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  return (await openDialog($('#confirm-dialog'))) === 'ok';
}

const tracksById = () => new Map(state.tracks.map((t) => [t.id, t]));
const playlistTracks = (pl) => {
  const map = tracksById();
  return pl.trackIds.map((id) => map.get(id)).filter(Boolean);
};

// ---------- Rendering ----------

const LIBRARY = { type: 'library', name: 'All music' };
const playlistSource = (pl) => ({ type: 'playlist', id: pl.id, name: pl.name });

/** context: 'library' or a playlist id — a playlist's rows only light up when that playlist is playing. */
function trackRow(track, context, onPlay, actions) {
  const li = document.createElement('li');
  li.className = 'track';
  li.dataset.trackId = track.id;
  li.dataset.context = context;

  const btn = document.createElement('button');
  btn.className = 'track-play';
  btn.textContent = track.title;
  btn.addEventListener('click', onPlay);

  li.append(btn, ...actions);
  return li;
}

function renderLibrary() {
  const { tracks } = state;
  els.libraryEmpty.hidden = tracks.length > 0;
  els.trackList.replaceChildren(
    ...tracks.map((t, i) =>
      trackRow(t, 'library', () => player.setQueue(tracks, i, LIBRARY), [
        iconButton('playlist', `Add ${t.title} to a playlist`, () => addTrackToPlaylistFlow(t), 'track-action'),
        textButton('✕', `Remove ${t.title} from device`, () => deleteTrackFlow(t), 'track-action'),
      ])
    )
  );
}

function renderPlaylists() {
  const { playlists } = state;
  els.playlistsEmpty.hidden = playlists.length > 0;
  els.playlistList.replaceChildren(
    ...playlists.map((pl) => {
      const li = document.createElement('li');
      li.className = 'track playlist-row';
      li.dataset.playlistId = pl.id;

      const open = document.createElement('button');
      open.className = 'track-play';
      open.append(icon('playlist'));
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = pl.name;
      const count = document.createElement('span');
      count.className = 'row-meta';
      count.textContent = plural(playlistTracks(pl).length, 'track');
      open.append(name, count);
      open.addEventListener('click', () => openPlaylist(pl.id));

      li.append(open, iconButton('player-play', `Play ${pl.name}`, () => togglePlaylist(pl), 'track-action pl-row-play'));
      return li;
    })
  );
}

function renderPlaylistDetail() {
  const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
  if (!pl) {
    if (state.view === 'playlist') showView('playlists');
    return;
  }
  const tracks = playlistTracks(pl);
  els.plName.textContent = pl.name;
  els.plMeta.textContent = plural(tracks.length, 'track');
  els.plEmpty.hidden = tracks.length > 0;
  els.plPlay.disabled = tracks.length === 0;
  els.plTracks.replaceChildren(
    ...tracks.map((t, i) =>
      trackRow(t, pl.id, () => player.setQueue(tracks, i, playlistSource(pl)), [
        textButton('✕', `Remove ${t.title} from ${pl.name}`, async () => {
          await db.removeFromPlaylist(pl.id, t.id);
          refresh();
        }, 'track-action'),
      ])
    )
  );
}

async function refresh() {
  [state.tracks, state.playlists] = await Promise.all([db.listTracks(), db.listPlaylists()]);
  state.loaded = true;
  els.libraryEmpty.textContent = EMPTY_LIBRARY_TEXT;
  syncQueue();
  renderLibrary();
  renderPlaylists();
  renderPlaylistDetail();
  syncUI();
}

/** Keep the player's queue in step with library/playlist edits, without interrupting playback. */
function syncQueue() {
  const src = player.source;
  if (!src) return;
  if (src.type === 'library') return player.replaceQueue(state.tracks);
  if (src.type === 'playlist') {
    const pl = state.playlists.find((p) => p.id === src.id);
    if (!pl) return player.detach();
    src.name = pl.name;
    player.replaceQueue(playlistTracks(pl));
  }
}

// ---------- State reflection ----------

/** Which control set the mode button shows: what's playing wins, otherwise the tab you're on. */
function controlMode() {
  if (player.current) return player.mode;
  return state.view === 'library' ? 'library' : 'playlist';
}

const MODE_UI = {
  'loop-off': ['repeat-off', 'Loop: off'],
  'loop-all': ['repeat', 'Loop: all'],
  'loop-one': ['repeat-once', 'Loop: one'],
  order: ['sort-descending', 'Play order: in order (tap for shuffle)'],
  shuffle: ['arrows-shuffle', 'Play order: shuffle (tap for in order)'],
};

function syncUI() {
  const current = player.current;
  const playing = player.playing;

  // Transport
  setButtonIcon(els.play, playing ? 'player-pause' : 'player-play', playing ? 'Pause' : 'Play');
  els.title.textContent = current?.title ?? 'Nothing playing';
  els.source.textContent = current && player.source?.type !== 'detached' ? player.source?.name ?? '' : '';
  els.source.hidden = !els.source.textContent;

  // Loop (All music) or play order (playlists)
  const key = controlMode() === 'playlist' ? (player.shuffle ? 'shuffle' : 'order') : `loop-${player.loop}`;
  const [name, label] = MODE_UI[key];
  setButtonIcon(els.mode, name, label);
  els.mode.dataset.mode = key;
  els.mode.classList.toggle('is-active', ['shuffle', 'loop-all', 'loop-one'].includes(key));

  // Track rows: a playlist's rows only light up when that playlist is the one playing
  const id = current?.id;
  document.querySelectorAll('.track[data-track-id]').forEach((li) => {
    const ctx = li.dataset.context;
    const inSource = ctx === 'library' || player.isSource(ctx);
    li.classList.toggle('is-current', li.dataset.trackId === id && inSource);
  });

  // Playlist rows: highlight the playing playlist and swap its play icon for pause
  document.querySelectorAll('.playlist-row').forEach((li) => {
    const isSrc = !!current && player.isSource(li.dataset.playlistId);
    li.classList.toggle('is-current', isSrc);
    const name = li.querySelector('.row-name').textContent;
    const showPause = isSrc && playing;
    setButtonIcon(li.querySelector('.pl-row-play'), showPause ? 'player-pause' : 'player-play', `${showPause ? 'Pause' : 'Play'} ${name}`);
  });

  // Playlist page Play button: Play → Pause → Resume
  const openIsSrc = !!current && player.isSource(state.openPlaylistId);
  const detailPlaying = openIsSrc && playing;
  els.plPlay.replaceChildren(
    icon(detailPlaying ? 'player-pause' : 'player-play'),
    detailPlaying ? 'Pause' : openIsSrc ? 'Resume' : 'Play'
  );
}

// ---------- Views / tabs ----------

function showView(view) {
  state.view = view;
  for (const [name, section] of Object.entries(els.views)) section.hidden = name !== view;
  const tab = view === 'library' ? 'library' : 'playlists';
  els.tabs.forEach((t) => {
    if (t.dataset.view === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  syncUI();
}

els.tabs.forEach((tab) => tab.addEventListener('click', () => showView(tab.dataset.view)));
els.back.addEventListener('click', () => showView('playlists'));

function openPlaylist(id) {
  state.openPlaylistId = id;
  renderPlaylistDetail();
  showView('playlist');
}

function playPlaylist(pl) {
  const tracks = playlistTracks(pl);
  if (!tracks.length) return notify(`“${pl.name}” is empty`);
  player.setQueue(tracks, null, playlistSource(pl));
}

/** Play a playlist, or pause/resume it if it's the one already playing. */
function togglePlaylist(pl) {
  if (player.current && player.isSource(pl.id)) player.toggle();
  else playPlaylist(pl);
}

// ---------- Playlist flows ----------

async function createPlaylist(trackIds = []) {
  const name = await askName('New playlist');
  if (!name) return null;
  const pl = await db.savePlaylist({ name, trackIds });
  await refresh();
  return pl;
}

els.newPlaylistBtn.addEventListener('click', async () => {
  const pl = await createPlaylist();
  if (pl) openPlaylist(pl.id);
});

/** From All music: pick (or create) a playlist for one track. */
async function addTrackToPlaylistFlow(track) {
  const dialog = $('#pick-playlist-dialog');
  const list = $('#pick-playlist-list');
  $('#pick-playlist-track').textContent = track.title;

  let chosen = null;
  list.replaceChildren(
    ...state.playlists.map((pl) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick-item';
      const has = pl.trackIds.includes(track.id);
      btn.append(icon('playlist'), Object.assign(document.createElement('span'), { className: 'row-name', textContent: pl.name }));
      if (has) btn.append(Object.assign(document.createElement('span'), { className: 'row-meta', textContent: 'Added' }));
      btn.disabled = has;
      btn.addEventListener('click', () => { chosen = pl; dialog.close('pick'); });
      li.append(btn);
      return li;
    })
  );

  const result = await openDialog(dialog);
  if (result === 'pick' && chosen) {
    await db.addToPlaylist(chosen.id, [track.id]);
    await refresh();
    notify(`Added to “${chosen.name}”`);
  } else if (result === 'new') {
    const pl = await createPlaylist([track.id]);
    if (pl) notify(`Added to “${pl.name}”`);
  }
}

/** From a playlist: choose several tracks from the device to add. */
async function addTracksToOpenPlaylist() {
  const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
  if (!pl) return;
  if (!state.tracks.length) return notify('Add some music first');

  const available = state.tracks.filter((t) => !pl.trackIds.includes(t.id));
  const list = $('#pick-tracks-list');
  const ok = $('#pick-tracks-ok');
  $('#pick-tracks-empty').hidden = available.length > 0;

  const updateOk = () => {
    const n = list.querySelectorAll('input:checked').length;
    ok.disabled = n === 0;
    ok.textContent = n ? `Add ${n}` : 'Add';
  };

  list.replaceChildren(
    ...available.map((t) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'pick-item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = t.id;
      box.addEventListener('change', updateOk);
      const name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = t.title;
      label.append(box, name);
      li.append(label);
      return li;
    })
  );
  updateOk();

  if ((await openDialog($('#pick-tracks-dialog'))) !== 'ok') return;
  const ids = [...list.querySelectorAll('input:checked')].map((b) => b.value);
  const added = await db.addToPlaylist(pl.id, ids);
  await refresh();
  if (added) notify(`Added ${plural(added, 'track')}`);
}

els.plAdd.addEventListener('click', addTracksToOpenPlaylist);
els.plPlay.addEventListener('click', () => {
  const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
  if (pl) togglePlaylist(pl);
});
els.plRename.addEventListener('click', async () => {
  const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
  if (!pl) return;
  const name = await askName('Rename playlist', pl.name);
  if (name && name !== pl.name) {
    await db.savePlaylist({ ...pl, name });
    refresh();
  }
});
els.plDelete.addEventListener('click', async () => {
  const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
  if (!pl) return;
  if (!(await confirmDelete('Delete playlist?', `“${pl.name}” will be deleted. The tracks stay in All music.`))) return;
  await db.deletePlaylist(pl.id);
  state.openPlaylistId = null;
  showView('playlists');
  refresh();
});

async function deleteTrackFlow(track) {
  if (!(await confirmDelete('Remove track?', `“${track.title}” will be removed from this device and from any playlists.`))) return;
  if (player.current?.id === track.id) player.stop();
  await db.deleteTrack(track.id);
  refresh();
}

// ---------- Importing ----------

async function importFiles(files) {
  const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|aif|aiff|flac|webm)$/i.test(f.name));
  for (const file of audio) await db.addTrack(file);
  if (audio.length) {
    db.requestPersistentStorage();
    await refresh();
    notify(`Added ${plural(audio.length, 'track')}`);
  }
}

els.fileInput.addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';
});

// Drag and drop onto the window
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
});

// Files opened via the OS "Open with" (manifest file_handlers, Chromium desktop)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async ({ files }) => {
    if (!files?.length) return;
    const blobs = await Promise.all(files.map((h) => h.getFile()));
    importFiles(blobs);
  });
}

// ---------- Player UI ----------

function setButtonIcon(btn, name, label) {
  btn.replaceChildren(icon(name));
  btn.setAttribute('aria-label', label);
}

/** Play/pause; with nothing loaded, start whatever the current screen shows. */
function playPause() {
  if (player.toggle()) return;
  if (state.view === 'playlist') {
    const pl = state.playlists.find((p) => p.id === state.openPlaylistId);
    if (pl) return playPlaylist(pl);
  }
  if (state.tracks.length) player.setQueue(state.tracks, 0, LIBRARY);
}

els.play.addEventListener('click', playPause);
els.prev.addEventListener('click', () => player.prev());
els.next.addEventListener('click', () => player.next());
els.mode.addEventListener('click', () => {
  if (controlMode() === 'playlist') player.toggleShuffle();
  else player.cycleLoop();
});
els.seek.addEventListener('input', () => {
  const d = player.audio.duration;
  if (d) player.seek((els.seek.value / 100) * d);
});

for (const type of ['play', 'pause', 'trackchange', 'sourcechange', 'modechange']) {
  player.addEventListener(type, syncUI);
}
player.addEventListener('timeupdate', () => {
  const { currentTime, duration } = player.audio;
  if (duration) els.seek.value = (currentTime / duration) * 100;
});

// Keyboard: space toggles play when not typing or inside a dialog
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'BUTTON', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  playPause();
});

// ---------- PWA: install prompt ----------

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.install.hidden = false;
});
els.install.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.install.hidden = true;
});
window.addEventListener('appinstalled', () => { els.install.hidden = true; });

// ---------- PWA: service worker + update flow ----------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');

      // Reload only when the user asked for the update, never on our own.
      let updateRequested = false;
      const showUpdate = (worker) => {
        els.toast.hidden = false;
        els.updateBtn.onclick = () => {
          updateRequested = true;
          worker.postMessage('SKIP_WAITING');
        };
      };

      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw);
        });
      });

      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!updateRequested || reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
    }
  });
}

// ---------- Initial load ----------

const EMPTY_LIBRARY_TEXT = els.libraryEmpty.textContent;

/** Load the library, retrying if storage isn't ready yet, and say so if it really fails. */
async function loadLibrary() {
  if (!state.loaded) els.libraryEmpty.textContent = 'Loading your music…';
  const delays = [0, 400, 1200, 3000];
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      await refresh();
      return;
    } catch (err) {
      console.error(`MusicDeck: loading the library failed (attempt ${i + 1})`, err);
    }
  }
  els.libraryEmpty.hidden = false;
  els.libraryEmpty.textContent = "Couldn't open your saved music. Close and reopen the app to try again.";
}

// Re-read storage when the app comes back to the foreground or is restored from the
// back/forward cache — mobile browsers can drop the storage connection while it's hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadLibrary();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) loadLibrary(); });

loadLibrary();
