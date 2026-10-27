// Audio playback: queue, play order (in order / shuffle), loop, and OS media controls (Media Session).
//
// A queue always has a *source*:
//   { type: 'library' }               — All music. Uses loop: off | all | one, plus shuffle.
//   { type: 'playlist', id }          — a playlist. Uses order: in order | shuffle, plus a repeat toggle that
//                                       replays from the top after the last track (on by default for Favorites).
//   { type: 'detached' }              — the playlist it came from was deleted; behaves like library.
import { getTrack, FAVORITES_ID } from './db.js';

const PREFETCH_AHEAD = 10;

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
    this.libraryShuffle = false;                            // All music: shuffle on/off
    // Playlists and Favorites each keep their own settings:
    //   order:  'order' | 'shuffle' | 'one' ('one' = one track at a time; Favorites only)
    //   repeat: replay from the top after the last track — or, in 'one', replay the same track
    this.orderBy = { playlist: 'order', favorites: 'order' };
    this.repeatBy = { playlist: false, favorites: true };
    this.objectUrl = null;
    this.prefetched = new Map(); // id → blob for the next few tracks, so track changes don't wait on storage
    this.playToken = 0;       // increments per track request; stale async results are ignored
    this.failedInRow = 0;     // consecutive tracks that failed to start, to avoid skipping forever
    this.finished = false;    // true once a non-repeating queue has played through to the end

    this.audio.addEventListener('ended', () => this.next({ auto: true }));
    this.audio.addEventListener('playing', () => { this.failedInRow = 0; });
    // A file that can't be decoded never fires 'ended': skip it instead of sitting there.
    this.audio.addEventListener('error', () => {
      if (!this.currentTrack || !this.audio.getAttribute('src')) return;
      console.warn('MusicDeck: could not play', this.currentTrack.title, this.audio.error);
      this.#skipAfterFailure();
    });
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

  isLibraryShuffled() { return this.libraryShuffle; }
  orderOf(key = this.repeatKey()) { return this.orderBy[key]; }
  get #shuffleActive() {
    return this.mode === 'library' ? this.libraryShuffle : this.orderBy[this.repeatKey()] === 'shuffle';
  }
  /** Playlist/Favorites in "one track" mode: each track either repeats or playback stops after it. */
  get #oneAtATime() { return this.mode === 'playlist' && this.orderBy[this.repeatKey()] === 'one'; }
  /** Let the audio element itself repeat the current track (gapless, and works while the phone is locked). */
  #applyTrackLoop() {
    this.audio.loop = this.mode === 'library'
      ? this.loop === 'one'
      : this.#oneAtATime && this.repeatBy[this.repeatKey()];
  }
  /** Which repeat setting applies to a playlist source: Favorites has its own, other playlists share one. */
  repeatKey(source = this.source) { return source?.id === FAVORITES_ID ? 'favorites' : 'playlist'; }
  isRepeating(key = this.repeatKey()) { return this.repeatBy[key]; }
  /** Does playback go back to the start after the last track? */
  get #wraps() {
    if (this.mode === 'library') return this.loop === 'all';
    return this.repeatBy[this.repeatKey()];
  }

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

  /**
   * Swap in an updated track list for the same source (tracks added/removed/reordered) without
   * interrupting playback. The existing play order is kept — a shuffle is NOT reshuffled — so
   * tracks don't repeat or get skipped just because the list was refreshed.
   */
  replaceQueue(tracks) {
    const oldIds = this.order.map((i) => this.queue[i]?.id);
    const oldPos = this.pos;
    const curId = this.currentTrack?.id;
    const indexOf = new Map(tracks.map((t, i) => [t.id, i]));
    this.queue = tracks;

    if (this.#shuffleActive) {
      // Keep the surviving tracks in their shuffled order; scatter new ones among the upcoming tracks.
      const order = oldIds.filter((id) => indexOf.has(id)).map((id) => indexOf.get(id));
      const known = new Set(oldIds);
      const fresh = tracks.map((t, i) => (known.has(t.id) ? -1 : i)).filter((i) => i >= 0);
      const curAt = curId && indexOf.has(curId) ? order.indexOf(indexOf.get(curId)) : -1;
      for (const i of fresh) {
        const from = curAt + 1;
        order.splice(from + Math.floor(Math.random() * (order.length - from + 1)), 0, i);
      }
      this.order = order;
    } else {
      this.order = tracks.map((_, i) => i);
    }

    if (curId && indexOf.has(curId)) {
      this.pos = this.order.indexOf(indexOf.get(curId));
    } else {
      // The playing track was removed: carry on with whichever upcoming track survived.
      const nextId = oldIds.slice(oldPos + 1).find((id) => indexOf.has(id));
      this.pos = nextId ? this.order.indexOf(indexOf.get(nextId)) - 1 : this.order.length - 1;
    }
    this.#prefetchNext();
  }

  /** The source playlist no longer exists; keep playing what's queued. */
  detach() {
    this.source = { type: 'detached' };
    this.#applyTrackLoop();
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

  #playPos(pos) {
    const track = this.queue[this.order[pos]];
    if (!track) return;
    const token = ++this.playToken;
    this.finished = false;
    // Position and current track change together, so a list refresh mid-load can't desync them.
    this.pos = pos;
    this.currentTrack = track;

    // Fast path: the upcoming track was fetched ahead of time, so we can start it right away,
    // inside the 'ended' event — no storage access, which iOS may suspend while locked.
    if (this.prefetched.has(track.id)) return this.#start(track, this.prefetched.get(track.id));

    this.#emit('trackchange');
    return getTrack(track.id)
      .then((record) => {
        if (token !== this.playToken) return; // a newer request took over
        if (!record) return this.#skipAfterFailure();
        return this.#start(track, record.blob);
      })
      .catch((err) => {
        console.warn('MusicDeck: loading track failed', err);
        if (token === this.playToken) this.#skipAfterFailure();
      });
  }

  #start(track, blob) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    this.#applyTrackLoop();
    this.#emit('trackchange');
    const started = this.audio.play().catch(() => {});
    this.#updateMediaMetadata();
    this.#prefetchNext();
    return started;
  }

  /** The next `count` tracks that will play after the current one. */
  #upcoming(count = PREFETCH_AHEAD) {
    const out = [];
    const wrap = this.#wraps;
    for (let k = 1; k <= count && out.length < this.order.length; k++) {
      let p = this.pos + k;
      if (p >= this.order.length) {
        if (!wrap) break;
        p %= this.order.length;
      }
      const t = this.queue[this.order[p]];
      if (t) out.push(t);
    }
    return out;
  }

  /**
   * Hold the next few tracks' files ready. These are references to the stored files rather than
   * copies, so it's cheap — and it means playback can carry on for a while even if the browser
   * suspends storage (iOS can, while the phone is locked).
   */
  #prefetchNext() {
    const wanted = new Set(this.#upcoming().map((t) => t.id));
    for (const id of this.prefetched.keys()) {
      if (!wanted.has(id) && id !== this.currentTrack?.id) this.prefetched.delete(id);
    }
    for (const id of wanted) {
      if (this.prefetched.has(id)) continue;
      getTrack(id)
        .then((record) => { if (record) this.prefetched.set(id, record.blob); })
        .catch(() => {});
    }
  }

  #skipAfterFailure() {
    this.failedInRow++;
    if (this.failedInRow > this.queue.length) { // nothing in the queue will play
      this.failedInRow = 0;
      this.audio.pause();
      return;
    }
    this.next({ auto: true });
  }

  // ---- Transport ----

  /** Returns false when nothing is loaded, so the caller can decide what to start. */
  toggle() {
    if (!this.currentTrack) return false;
    if (this.finished) {
      // The queue played through and stopped: Play starts it again from the top (freshly shuffled if shuffling).
      this.#buildOrder(null);
      this.#playPos(0);
      return true;
    }
    if (this.audio.paused) this.audio.play();
    else this.audio.pause();
    return true;
  }

  next({ auto = false } = {}) {
    if (!this.queue.length) return;
    // One track at a time with repeat off: stop when it finishes (with repeat on it loops by itself).
    // Next/previous buttons still move through the list.
    if (auto && this.#oneAtATime) {
      this.audio.currentTime = 0;
      this.#emit('pause');
      return;
    }
    if (this.pos + 1 < this.order.length) return this.#playPos(this.pos + 1);
    if (this.#wraps) {
      // Looping while shuffled: reshuffle for the next pass, without repeating the track that just played.
      if (this.#shuffleActive && this.order.length > 1) {
        const last = this.order[this.pos];
        this.order = shuffled(this.order);
        if (this.order[0] === last) [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
      }
      return this.#playPos(0);
    }
    // End of the queue: when the last track finishes on its own, stop there.
    if (auto) {
      this.finished = true;
      this.audio.currentTime = 0;
      this.#emit('pause');
    }
  }

  prev() {
    if (this.audio.currentTime > 3 || !this.queue.length) { this.audio.currentTime = 0; return; }
    if (this.pos > 0) return this.#playPos(this.pos - 1);
    if (this.#wraps) return this.#playPos(this.order.length - 1);
    this.audio.currentTime = 0;
  }

  seek(seconds) {
    if (Number.isFinite(seconds)) this.audio.currentTime = seconds;
  }

  // ---- Modes ----

  cycleLoop() {
    this.loop = { off: 'all', all: 'one', one: 'off' }[this.loop];
    this.#applyTrackLoop();
    this.#prefetchNext(); // loop all changes what comes after the last track
    this.#emit('modechange');
    return this.loop;
  }

  /** Toggle repeat for 'playlist' or 'favorites'. */
  toggleRepeat(key = this.repeatKey()) {
    this.repeatBy[key] = !this.repeatBy[key];
    this.#applyTrackLoop();
    this.#prefetchNext(); // what comes after the last track just changed
    this.#emit('modechange');
    return this.repeatBy[key];
  }

  /** All music: shuffle on/off. */
  toggleLibraryShuffle() {
    this.libraryShuffle = !this.libraryShuffle;
    if (this.mode === 'library') this.#reorderAroundCurrent();
    this.#emit('modechange');
    return this.libraryShuffle;
  }

  /** Playlists: in order ⇄ shuffle. Favorites: in order → shuffle → one track → in order. */
  cycleOrder(key = this.repeatKey()) {
    const steps = key === 'favorites' ? ['order', 'shuffle', 'one'] : ['order', 'shuffle'];
    const now = this.orderBy[key];
    this.orderBy[key] = steps[(steps.indexOf(now) + 1) % steps.length];
    if (this.mode === 'playlist' && this.repeatKey() === key) {
      this.#reorderAroundCurrent();
      this.#applyTrackLoop();
    }
    this.#emit('modechange');
    return this.orderBy[key];
  }

  /** Rebuild the play order for the current setting, keeping the playing track where it is. */
  #reorderAroundCurrent() {
    if (!this.queue.length) return;
    const i = this.currentTrack ? this.queue.findIndex((t) => t.id === this.currentTrack.id) : -1;
    this.#buildOrder(i >= 0 ? i : null);
    if (i < 0) this.pos = -1;
    this.#prefetchNext();
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
