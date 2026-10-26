// Audio playback: queue, play order (in order / shuffle), loop, and OS media controls (Media Session).
//
// A queue always has a *source*:
//   { type: 'library' }               — All music. Uses loop: off | all | one.
//   { type: 'playlist', id }          — a playlist. Uses order: in order | shuffle; stops after the last track.
//   { type: 'detached' }              — the playlist it came from was deleted; behaves like library.
import { getTrack } from './db.js';

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];          // track metadata, in source order
    this.order = [];          // indices into queue, in play order
    this.pos = -1;            // position within `order`
    this.currentTrack = null;
    this.source = null;
    this.loop = 'off';        // library: 'off' | 'all' | 'one'
    this.shuffle = false;     // playlists: false = in order, true = shuffle
    this.objectUrl = null;

    this.audio.addEventListener('ended', () => this.next({ auto: true }));
    for (const type of ['play', 'pause', 'timeupdate', 'loadedmetadata']) {
      this.audio.addEventListener(type, () => this.#emit(type));
    }
    this.#setupMediaSession();
  }

  // ---- State ----

  get current() { return this.currentTrack; }
  get playing() { return !!this.currentTrack && !this.audio.paused; }
  /** 'playlist' when playing from a playlist, otherwise 'library'. */
  get mode() { return this.source?.type === 'playlist' ? 'playlist' : 'library'; }
  isSource(playlistId) { return this.source?.type === 'playlist' && this.source.id === playlistId; }

  get #shuffleActive() { return this.mode === 'playlist' && this.shuffle; }

  // ---- Queue ----

  /**
   * Start playing `tracks` from `source`.
   * startIndex: index into tracks to begin with, or null for "from the top"
   * (the first track in order, or a random one when shuffling).
   */
  setQueue(tracks, startIndex = 0, source = { type: 'library' }) {
    if (!tracks.length) return;
    this.queue = tracks;
    this.source = source;
    this.#buildOrder(startIndex);
    this.#emit('sourcechange');
    return this.#playPos(Math.max(this.pos, 0));
  }

  /** Swap in an updated track list for the same source (tracks added/removed) without interrupting playback. */
  replaceQueue(tracks) {
    this.queue = tracks;
    const i = this.currentTrack ? tracks.findIndex((t) => t.id === this.currentTrack.id) : -1;
    this.#buildOrder(i >= 0 ? i : null);
    if (i < 0) this.pos = -1; // current track is gone from the list; "next" starts from the top
  }

  /** The source playlist no longer exists; keep playing what's queued. */
  detach() {
    this.source = { type: 'detached' };
    this.audio.loop = this.loop === 'one';
    this.#emit('sourcechange');
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.currentTrack = null;
    this.pos = -1;
    this.#emit('pause');
    this.#emit('trackchange');
  }

  /** startIndex: queue index to put first, or null for "from the top". Sets order and pos. */
  #buildOrder(startIndex) {
    const all = this.queue.map((_, i) => i);
    if (this.#shuffleActive) {
      this.order = startIndex == null ? shuffled(all) : [startIndex, ...shuffled(all.filter((i) => i !== startIndex))];
      this.pos = 0;
    } else {
      this.order = all;
      this.pos = startIndex ?? 0;
    }
  }

  async #playPos(pos) {
    const track = this.queue[this.order[pos]];
    if (!track) return;
    this.pos = pos;
    const record = await getTrack(track.id);
    if (!record) return this.next({ auto: true });
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(record.blob);
    this.currentTrack = track;
    this.audio.src = this.objectUrl;
    this.audio.loop = this.mode === 'library' && this.loop === 'one';
    this.#emit('trackchange');
    await this.audio.play().catch(() => {});
    this.#updateMediaMetadata();
  }

  // ---- Transport ----

  /** Returns false when nothing is loaded, so the caller can decide what to start. */
  toggle() {
    if (!this.currentTrack) return false;
    if (this.audio.paused) this.audio.play();
    else this.audio.pause();
    return true;
  }

  next({ auto = false } = {}) {
    if (!this.queue.length) return;
    if (this.pos + 1 < this.order.length) return this.#playPos(this.pos + 1);
    if (this.mode === 'library' && this.loop === 'all') return this.#playPos(0);
    // End of the queue: when a track finishes on its own, rewind to the top, paused.
    if (auto) {
      this.audio.currentTime = 0;
      this.#emit('pause');
    }
  }

  prev() {
    if (this.audio.currentTime > 3 || !this.queue.length) { this.audio.currentTime = 0; return; }
    if (this.pos > 0) return this.#playPos(this.pos - 1);
    if (this.mode === 'library' && this.loop === 'all') return this.#playPos(this.order.length - 1);
    this.audio.currentTime = 0;
  }

  seek(seconds) {
    if (Number.isFinite(seconds)) this.audio.currentTime = seconds;
  }

  // ---- Modes ----

  cycleLoop() {
    this.loop = { off: 'all', all: 'one', one: 'off' }[this.loop];
    this.audio.loop = this.mode === 'library' && this.loop === 'one';
    this.#emit('modechange');
    return this.loop;
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.mode === 'playlist' && this.queue.length) {
      const i = this.currentTrack ? this.queue.findIndex((t) => t.id === this.currentTrack.id) : -1;
      this.#buildOrder(i >= 0 ? i : null);
      if (i < 0) this.pos = -1;
    }
    this.#emit('modechange');
    return this.shuffle;
  }

  #emit(type) {
    this.dispatchEvent(new Event(type));
  }

  #setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.audio.play());
    ms.setActionHandler('pause', () => this.audio.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    try {
      ms.setActionHandler('seekto', (d) => this.seek(d.seekTime));
    } catch { /* not supported everywhere */ }
  }

  #updateMediaMetadata() {
    if (!('mediaSession' in navigator) || !this.currentTrack) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.currentTrack.title,
      artist: '',
      album: this.source?.name ?? 'MusicDeck',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}
