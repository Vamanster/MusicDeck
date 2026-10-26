// MusicDeck entry point: wires the UI to storage and playback, and registers the service worker.
import { addTrack, listTracks, deleteTrack, requestPersistentStorage } from './db.js';
import { Player } from './player.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  fileInput: $('#file-input'),
  list: $('#track-list'),
  empty: $('#empty-state'),
  title: $('#np-title'),
  play: $('#play-btn'),
  prev: $('#prev-btn'),
  next: $('#next-btn'),
  loop: $('#loop-btn'),
  seek: $('#seek'),
  install: $('#install-btn'),
  toast: $('#update-toast'),
  updateBtn: $('#update-btn'),
};

const player = new Player();
let tracks = [];

// ---------- Library ----------

async function refreshLibrary() {
  tracks = await listTracks();
  els.empty.hidden = tracks.length > 0;
  els.list.replaceChildren(
    ...tracks.map((t, i) => {
      const li = document.createElement('li');
      li.className = 'track';
      li.dataset.index = i;
      if (player.current?.id === t.id) li.classList.add('is-current');

      const btn = document.createElement('button');
      btn.className = 'track-play';
      btn.textContent = t.title;
      btn.addEventListener('click', () => player.setQueue(tracks, i));

      const del = document.createElement('button');
      del.className = 'icon-btn track-delete';
      del.setAttribute('aria-label', `Remove ${t.title}`);
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        await deleteTrack(t.id);
        refreshLibrary();
      });

      li.append(btn, del);
      return li;
    })
  );
}

async function importFiles(files) {
  const audio = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(f.name));
  for (const file of audio) await addTrack(file);
  if (audio.length) {
    requestPersistentStorage();
    refreshLibrary();
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

els.play.addEventListener('click', () => player.toggle());
els.prev.addEventListener('click', () => player.prev());
els.next.addEventListener('click', () => player.next());
els.loop.addEventListener('click', () => player.cycleLoop());
els.seek.addEventListener('input', () => {
  const d = player.audio.duration;
  if (d) player.seek((els.seek.value / 100) * d);
});

player.addEventListener('play', () => { els.play.textContent = '⏸'; els.play.setAttribute('aria-label', 'Pause'); });
player.addEventListener('pause', () => { els.play.textContent = '▶'; els.play.setAttribute('aria-label', 'Play'); });
player.addEventListener('timeupdate', () => {
  const { currentTime, duration } = player.audio;
  if (duration) els.seek.value = (currentTime / duration) * 100;
});
player.addEventListener('trackchange', () => {
  els.title.textContent = player.current?.title ?? 'Nothing playing';
  document.querySelectorAll('.track').forEach((li) =>
    li.classList.toggle('is-current', Number(li.dataset.index) === player.index)
  );
});
player.addEventListener('loopchange', () => {
  const labels = { off: 'Loop: off', all: 'Loop: all', one: 'Loop: one' };
  els.loop.setAttribute('aria-pressed', String(player.loop !== 'off'));
  els.loop.setAttribute('aria-label', labels[player.loop]);
  els.loop.dataset.mode = player.loop;
});

// Keyboard: space toggles play when not typing
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'BUTTON'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    player.toggle();
  }
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

      const showUpdate = (worker) => {
        els.toast.hidden = false;
        els.updateBtn.onclick = () => worker.postMessage('SKIP_WAITING');
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
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    } catch (err) {
      console.error('Service worker registration failed:', err);
    }
  });
}

refreshLibrary();
