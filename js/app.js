// MusicDeck entry point: wires the UI to storage and playback, and registers the service worker.
import * as db from './db.js';
import { Player } from './player.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  fileInput: $('#file-input'),
  // views
  views: { library: $('#view-library'), playlists: $('#view-playlists'), playlist: $('#view-playlist'), favorites: $('#view-favorites') },
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
  // favorites
  favList: $('#favorites-list'),
  favEmpty: $('#favorites-empty'),
  favPlay: $('#fav-play'),
  plAdd: $('#pl-add'),
  plRename: $('#pl-rename'),
  plDelete: $('#pl-delete'),
  // player
  title: $('#np-title'),
  source: $('#np-source'),
  play: $('#play-btn'),
  prev: $('#prev-btn'),
  next: $('#next-btn'),
  loop: $('#loop-btn'),
  order: $('#order-btn'),
  shuffle: $('#shuffle-btn'),
  repeat: $('#repeat-btn'),
  iosInstall: $('#ios-install-dialog'),
  seek: $('#seek'),
  timeCurrent: $('#time-current'),
  timeTotal: $('#time-total'),
  // misc
  install: $('#install-btn'),
  toast: $('#update-toast'),
  updateBtn: $('#update-btn'),
  notice: $('#notice'),
};

const player = new Player();
const state = {
  loaded: false,
  favorites: { id: db.FAVORITES_ID, name: 'Favorites', trackIds: [] },
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

/** 356 → "5:56", 3725 → "1:02:05"; unknown → "-:--". */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
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
  const time = document.createElement('span');
  time.className = 'track-time';
  time.textContent = formatTime(track.duration);
  const title = document.createElement('span');
  title.className = 'track-title';
  title.textContent = track.title;
  btn.append(title, time); // length sits on the right, just left of the row's icons
  btn.addEventListener('click', onPlay);

  li.append(btn, ...actions);
  return li;
}

/** Star button: fills in when the track is a favorite. */
function favButton(t) {
  const isFav = state.favorites.trackIds.includes(t.id);
  const btn = iconButton(
    isFav ? 'star-filled' : 'star',
    isFav ? `Remove ${t.title} from Favorites` : `Add ${t.title} to Favorites`,
    () => toggleFavoriteFlow(t),
    `track-action fav-btn${isFav ? ' is-fav' : ''}`
  );
  btn.setAttribute('aria-pressed', String(isFav));
  return btn;
}

async function toggleFavoriteFlow(t) {
  const nowFav = await db.toggleFavorite(t.id);
  await refresh();
  notify(nowFav ? 'Added to Favorites' : 'Removed from Favorites');
}

/** Favorites is a playlist under the hood, but lives outside state.playlists. */
const findPlaylist = (id) => (id === db.FAVORITES_ID ? state.favorites : state.playlists.find((p) => p.id === id));

function renderFavorites() {
  const fav = state.favorites;
  const tracks = playlistTracks(fav);
  els.favEmpty.hidden = tracks.length > 0;
  els.favPlay.disabled = tracks.length === 0;
  els.favList.replaceChildren(
    ...tracks.map((t, i) => trackRow(t, fav.id, () => player.setQueue(tracks, i, playlistSource(fav)), [favButton(t)]))
  );
}

function renderLibrary() {
  const { tracks } = state;
  els.libraryEmpty.hidden = tracks.length > 0;
  els.trackList.replaceChildren(
    ...tracks.map((t, i) =>
      trackRow(t, 'library', () => player.setQueue(tracks, i, LIBRARY), [
        favButton(t),
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
        favButton(t),
        textButton('✕', `Remove ${t.title} from ${pl.name}`, async () => {
          await db.removeFromPlaylist(pl.id, t.id);
          refresh();
        }, 'track-action'),
      ])
    )
  );
}

async function refresh() {
  [state.tracks, state.playlists, state.favorites] = await Promise.all([db.listTracks(), db.listPlaylists(), db.getFavorites()]);
  state.loaded = true;
  els.libraryEmpty.textContent = EMPTY_LIBRARY_TEXT;
  syncQueue();
  renderLibrary();
  renderPlaylists();
  renderPlaylistDetail();
  renderFavorites();
  syncUI();
  backfillDurations();
}

/** Tracks added before durations were recorded: measure them once, in the background. */
let backfilling = false;
async function backfillDurations() {
  if (backfilling) return;
  backfilling = true;
  try {
    for (const t of state.tracks.filter((x) => x.duration === undefined)) {
      const duration = await db.backfillDuration(t.id);
      t.duration = duration;
      document.querySelectorAll(`.track[data-track-id="${CSS.escape(t.id)}"] .track-time`)
        .forEach((el) => { el.textContent = formatTime(duration); });
    }
  } catch (err) {
    console.warn('MusicDeck: measuring track lengths failed', err);
  } finally {
    backfilling = false;
  }
}

/** Keep the player's queue in step with library/playlist edits, without interrupting playback. */
function syncQueue() {
  const src = player.source;
  if (!src) return;
  if (src.type === 'library') return player.replaceQueue(state.tracks);
  if (src.type === 'playlist') {
    const pl = findPlaylist(src.id);
    if (!pl) return player.detach();
    src.name = pl.name;
    player.replaceQueue(playlistTracks(pl));
  }
}

// ---------- State reflection ----------

/** Which repeat setting the toggle shows: the playing playlist's, otherwise the screen you're on. */
function repeatKeyForUI() {
  if (player.current && player.mode === 'playlist') return player.repeatKey();
  return state.view === 'favorites' ? 'favorites' : 'playlist';
}

/** Which control pair to show — All music's or the playlist one: what's playing wins, otherwise the tab you're on. */
function controlMode() {
  if (player.current) return player.mode;
  return state.view === 'library' ? 'library' : 'playlist';
}

const LOOP_UI = {
  off: ['repeat-off', 'Loop: off'],
  all: ['repeat', 'Loop: all'],
  one: ['repeat-once', 'Loop: one'],
};
const ORDER_UI = {
  order: ['sort-descending', 'Play order: in order'],
  shuffle: ['arrows-shuffle', 'Play order: shuffle'],
  one: ['repeat-once', 'Play order: one track'],
};

function syncUI() {
  const current = player.current;
  const playing = player.playing;

  // Transport
  setButtonIcon(els.play, playing ? 'player-pause' : 'player-play', playing ? 'Pause' : 'Play');
  els.title.textContent = current?.title ?? 'Nothing playing';
  els.source.textContent = current && player.source?.type !== 'detached' ? player.source?.name ?? '' : '';
  els.source.hidden = !els.source.textContent;

  // Same layout on every screen: play order on the left, repeat on the right.
  //   All music:            shuffle on/off  |  loop off / all / one
  //   Playlists, Favorites: order button    |  repeat on/off
  const mode = controlMode();
  const isLib = mode === 'library';
  els.shuffle.hidden = !isLib;
  els.loop.hidden = !isLib;
  els.order.hidden = isLib;
  els.repeat.hidden = isLib;

  const libShuffle = player.isLibraryShuffled();
  const shuffleLabel = libShuffle ? 'Shuffle: on' : 'Shuffle: off';
  els.shuffle.classList.toggle('is-active', libShuffle);
  els.shuffle.setAttribute('aria-pressed', String(libShuffle));
  els.shuffle.setAttribute('aria-label', shuffleLabel);
  els.shuffle.title = shuffleLabel;

  const [loopIcon, loopLabel] = LOOP_UI[player.loop];
  setButtonIcon(els.loop, loopIcon, loopLabel);
  els.loop.title = loopLabel;
  els.loop.classList.toggle('is-active', player.loop !== 'off');

  const key = repeatKeyForUI();
  const order = player.orderOf(key);
  const [orderIcon, orderLabel] = ORDER_UI[order];
  setButtonIcon(els.order, orderIcon, orderLabel);
  els.order.title = orderLabel;
  els.order.dataset.order = order;
  els.order.classList.toggle('is-active', order !== 'order');

  const repeating = player.isRepeating(key);
  const what = order === 'one' ? 'track' : key === 'favorites' ? 'Favorites' : 'playlist';
  const repeatLabel = `Repeat ${what}: ${repeating ? 'on' : 'off'}`;
  setButtonIcon(els.repeat, repeating ? 'repeat' : 'repeat-off', repeatLabel);
  els.repeat.title = repeatLabel;
  els.repeat.classList.toggle('is-active', repeating);
  els.repeat.setAttribute('aria-pressed', String(repeating));

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

  // Playlist page and Favorites Play buttons: Play → Pause → Resume
  setPlayButton(els.plPlay, state.openPlaylistId);
  setPlayButton(els.favPlay, db.FAVORITES_ID);
}

function setPlayButton(btn, playlistId) {
  const isSrc = !!player.current && player.isSource(playlistId);
  const isPlaying = isSrc && player.playing;
  btn.replaceChildren(icon(isPlaying ? 'player-pause' : 'player-play'), isPlaying ? 'Pause' : isSrc ? 'Resume' : 'Play');
}

// ---------- Views / tabs ----------

function showView(view) {
  state.view = view;
  for (const [name, section] of Object.entries(els.views)) section.hidden = name !== view;
  const tab = view === 'playlist' ? 'playlists' : view; // a single playlist lives under the Playlists tab
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
els.favPlay.addEventListener('click', () => togglePlaylist(state.favorites));
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
  if (state.view === 'favorites' && state.favorites.trackIds.length) return playPlaylist(state.favorites);
  if (state.tracks.length) player.setQueue(state.tracks, 0, LIBRARY);
}

els.play.addEventListener('click', playPause);
els.prev.addEventListener('click', () => player.prev());
els.next.addEventListener('click', () => player.next());
els.shuffle.addEventListener('click', () => player.toggleLibraryShuffle());
els.loop.addEventListener('click', () => player.cycleLoop());
els.order.addEventListener('click', () => player.cycleOrder(repeatKeyForUI()));
els.repeat.addEventListener('click', () => player.toggleRepeat(repeatKeyForUI()));

for (const type of ['play', 'pause', 'trackchange', 'sourcechange', 'modechange']) {
  player.addEventListener(type, syncUI);
}
function syncTime() {
  const { currentTime, duration } = player.audio;
  const known = Number.isFinite(duration) && duration > 0;
  if (!player.current) {
    els.seek.value = 0;
    els.timeCurrent.textContent = '0:00';
    els.timeTotal.textContent = '0:00';
    return;
  }
  if (scrub.active) return; // the user's finger owns the scrubber and the elapsed time while dragging
  if (known) els.seek.value = (currentTime / duration) * 100;
  els.timeCurrent.textContent = formatTime(currentTime);
  els.timeTotal.textContent = formatTime(known ? duration : player.current.duration);
}
for (const type of ['timeupdate', 'loadedmetadata', 'durationchange', 'trackchange']) {
  player.addEventListener(type, syncTime);
}
// ---------- Scrubbing ----------
// Seeking on every pixel of a drag makes the audio stutter and screech. While dragging we:
//  - jump to the new position at most every SCRUB_SEEK_MS (using fastSeek where available),
//  - turn the volume down to SCRUB_VOLUME so you still hear roughly where you are,
// then make one exact seek and restore the volume when the scrubber is released.
// (iOS doesn't let web pages change the volume, so there only the fewer jumps apply.)
const SCRUB_SEEK_MS = 250;
const SCRUB_VOLUME = 0.25;
const scrub = { active: false, volume: 1, lastSeek: 0, timer: null, trackId: null };

const scrubTarget = () => {
  const d = player.audio.duration;
  return Number.isFinite(d) ? (els.seek.value / 100) * d : null;
};

function scrubSeek(exact) {
  // If the track changed mid-drag (e.g. it ended), don't drag the new track to this position.
  if (player.current?.id !== scrub.trackId) return;
  let t = scrubTarget();
  if (t == null) return;
  const a = player.audio;
  // While dragging, stop just short of the end so the track doesn't finish under your finger;
  // releasing at the very end still lets it finish and move on.
  if (!exact) t = Math.min(t, Math.max(0, a.duration - 0.5));
  if (!exact && typeof a.fastSeek === 'function') a.fastSeek(t);
  else player.seek(t);
  scrub.lastSeek = performance.now();
}

els.seek.addEventListener('input', () => {
  if (!player.current) return;
  if (!scrub.active) {
    scrub.active = true;
    scrub.trackId = player.current.id;
    scrub.volume = player.audio.volume;
    player.audio.volume = Math.min(scrub.volume, SCRUB_VOLUME);
  }
  const t = scrubTarget();
  if (t != null) els.timeCurrent.textContent = formatTime(t);

  clearTimeout(scrub.timer);
  const wait = SCRUB_SEEK_MS - (performance.now() - scrub.lastSeek);
  if (wait <= 0) scrubSeek(false);
  else scrub.timer = setTimeout(() => scrubSeek(false), wait); // trailing jump so a pause in the drag still lands
});

// 'change' fires on release (mouse, touch, or a keyboard step).
els.seek.addEventListener('change', () => {
  clearTimeout(scrub.timer);
  scrubSeek(true);
  if (scrub.active) player.audio.volume = scrub.volume;
  scrub.active = false;
  syncTime();
});

// Keyboard: space toggles play when not typing or inside a dialog
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'BUTTON', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  e.preventDefault();
  playPause();
});

// ---------- PWA: install prompt ----------

// iOS has no install prompt: Install opens a short "Add to Home Screen" guide instead.
// (iPadOS reports itself as a Mac, so also check for a touch screen.)
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
if (isIOS && !isStandalone) els.install.hidden = false;

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.install.hidden = false;
});
els.install.addEventListener('click', async () => {
  if (isIOS) return openDialog(els.iosInstall);
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
