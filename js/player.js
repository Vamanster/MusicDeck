// Audio playback: queue, prev/next, loop, and OS media controls (Media Session).
import { getTrack } from './db.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];      // array of track metadata
    this.index = -1;
    this.loop = 'off';    // 'off' | 'all' | 'one'
    this.objectUrl = null;

    this.audio.addEventListener('ended', () => this.#onEnded());
    for (const type of ['play', 'pause', 'timeupdate', 'loadedmetadata']) {
      this.audio.addEventListener(type, () => this.#emit(type));
    }
    this.#setupMediaSession();
  }

  get current() { return this.queue[this.index] ?? null; }
  get playing() { return !this.audio.paused; }

  setQueue(tracks, startIndex = 0) {
    this.queue = tracks;
    return this.playAt(startIndex);
  }

  async playAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    const record = await getTrack(this.queue[i].id);
    if (!record) return;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(record.blob);
    this.audio.src = this.objectUrl;
    this.audio.loop = this.loop === 'one';
    await this.audio.play().catch(() => {});
    this.#updateMediaMetadata();
    this.#emit('trackchange');
  }

  toggle() {
    if (!this.current) return this.queue.length && this.playAt(0);
    return this.audio.paused ? this.audio.play() : this.audio.pause();
  }

  next() {
    if (!this.queue.length) return;
    const n = this.index + 1;
    if (n < this.queue.length) return this.playAt(n);
    if (this.loop === 'all') return this.playAt(0);
  }

  prev() {
    if (this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
    if (this.index > 0) return this.playAt(this.index - 1);
    if (this.loop === 'all') return this.playAt(this.queue.length - 1);
  }

  seek(seconds) {
    if (Number.isFinite(seconds)) this.audio.currentTime = seconds;
  }

  cycleLoop() {
    this.loop = { off: 'all', all: 'one', one: 'off' }[this.loop];
    this.audio.loop = this.loop === 'one';
    this.#emit('loopchange');
    return this.loop;
  }

  #onEnded() {
    // loop === 'one' is handled natively by audio.loop
    this.next();
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
    if (!('mediaSession' in navigator) || !this.current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.current.title,
      artist: '',
      album: 'MusicDeck',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
}
