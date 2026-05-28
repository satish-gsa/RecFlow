/**
 * recordings.js — Manage saved recordings (list, play, download, delete, rename).
 */

let db = null;
let allRecordings = [];
let pendingDeleteId = null;
let pendingDeleteBlob = null;

// ======== Init ========
document.addEventListener('DOMContentLoaded', async () => {
  db = new RecorderDB();
  await db.open();

  bindEvents();
  await loadRecordings();
});

// ======== Event bindings ========
function bindEvents() {
  el('btn-new').addEventListener('click', openNewRecording);
  el('btn-start-empty').addEventListener('click', openNewRecording);

  // Recovery banner
  el('btn-dismiss-recovery').addEventListener('click', () =>
    el('recovery-banner').classList.add('hidden')
  );

  // Play modal
  el('btn-close-modal').addEventListener('click', closePlayModal);
  el('modal-backdrop').addEventListener('click', closePlayModal);

  // Delete modal
  el('btn-confirm-delete').addEventListener('click', confirmDelete);
  el('btn-cancel-delete').addEventListener('click', closeDeleteModal);
  el('delete-backdrop').addEventListener('click', closeDeleteModal);

  // Download from play modal
  el('btn-modal-download').addEventListener('click', () => {
    if (pendingDeleteBlob) downloadBlob(pendingDeleteBlob, el('modal-title').textContent);
  });
}

function openNewRecording() {
  chrome.storage.local.get(['recordMode', 'audioMode'], (data) => {
    const mode = data.recordMode || 'screen';
    const audio = data.audioMode || 'microphone';
    const url = chrome.runtime.getURL(`recorder/recorder.html?mode=${mode}&audio=${audio}`);
    chrome.tabs.create({ url, active: true });
  });
}

// ======== Load recordings ========
async function loadRecordings() {
  showLoading(true);
  try {
    allRecordings = await db.getAllRecordings();
    // Sort newest first
    allRecordings.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const recovered = allRecordings.filter((r) => r.status === 'recovered');
    if (recovered.length > 0) showRecoveryBanner(recovered.length);

    renderGrid(allRecordings);
    updateCount(allRecordings.length);
  } catch (err) {
    console.error('Failed to load recordings:', err);
  } finally {
    showLoading(false);
  }
}

// ======== Render grid ========
function renderGrid(recordings) {
  const grid = el('recordings-grid');
  const empty = el('empty-state');

  grid.innerHTML = '';

  if (recordings.length === 0) {
    grid.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  grid.classList.remove('hidden');

  recordings.forEach((rec) => {
    const card = buildCard(rec);
    grid.appendChild(card);
  });
}

function buildCard(rec) {
  const card = document.createElement('article');
  card.className = 'recording-card';
  card.dataset.id = rec.id;

  const thumbnailHTML = rec.thumbnail
    ? `<img class="card-thumb" src="${rec.thumbnail}" alt="" loading="lazy" />`
    : `<div class="card-thumb-placeholder">
         <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="1.2">
           <polygon points="5 3 19 12 5 21 5 3"/>
         </svg>
       </div>`;

  const statusBadge = rec.status === 'recovered'
    ? '<span class="status-badge recovered">Recovered</span>'
    : '';

  const modeBadge = `<span class="mode-badge">${modeLabel(rec.mode)}</span>`;

  card.innerHTML = `
    <div class="card-thumbnail" data-play="${rec.id}">
      ${thumbnailHTML}
      <div class="card-play-btn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <div class="card-duration">${formatDuration(rec.duration || 0)}</div>
      ${statusBadge}
    </div>
    <div class="card-body">
      <div class="card-meta">
        ${modeBadge}
        <span class="card-date">${formatDate(rec.timestamp)}</span>
        <span class="card-size">${formatSize(rec.size || 0)}</span>
      </div>
      <p class="card-name" contenteditable="true" spellcheck="false"
         data-id="${rec.id}" title="Click to rename">${escapeHtml(rec.name || 'Recording')}</p>
      <div class="card-actions">
        <button class="action-btn" data-action="play" data-id="${rec.id}" title="Play">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Play
        </button>
        <button class="action-btn" data-action="download" data-id="${rec.id}" title="Download">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          Download
        </button>
        <button class="action-btn action-delete" data-action="delete" data-id="${rec.id}" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
          </svg>
          Delete
        </button>
      </div>
    </div>
  `;

  // Play on thumbnail click
  card.querySelector('[data-play]').addEventListener('click', () => playRecording(rec.id));

  // Action buttons
  card.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const action = e.currentTarget.dataset.action;
      const id = e.currentTarget.dataset.id;
      if (action === 'play') await playRecording(id);
      else if (action === 'download') await downloadRecording(id);
      else if (action === 'delete') promptDelete(id);
    });
  });

  // Rename on blur
  const nameEl = card.querySelector('.card-name');
  nameEl.addEventListener('blur', async () => {
    const newName = nameEl.textContent.trim();
    if (newName) {
      try {
        await db.updateRecording(rec.id, { name: newName });
        const local = allRecordings.find((r) => r.id === rec.id);
        if (local) local.name = newName;
      } catch (_) {
        nameEl.textContent = rec.name;
      }
    } else {
      nameEl.textContent = rec.name;
    }
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
  });

  return card;
}

// ======== Play recording ========
async function playRecording(id) {
  const rec = await db.getRecording(id);
  if (!rec) return;

  const chunks = await db.getChunksForRecording(id);
  let blob;

  if (chunks.length === 0) {
    showToast('Recording data not found in storage.');
    return;
  }

  blob = new Blob(chunks.map((c) => c.data), { type: rec.mimeType || 'video/webm' });

  pendingDeleteBlob = blob;
  const url = URL.createObjectURL(blob);
  el('modal-video').src = url;
  el('modal-title').textContent = rec.name || 'Recording';
  el('modal-play').classList.remove('hidden');
  el('modal-video').play().catch(() => {});
}

function closePlayModal() {
  const vid = el('modal-video');
  vid.pause();
  const src = vid.src;
  vid.src = '';
  if (src) URL.revokeObjectURL(src);
  pendingDeleteBlob = null;
  el('modal-play').classList.add('hidden');
}

// ======== Download recording ========
async function downloadRecording(id) {
  const rec = await db.getRecording(id);
  if (!rec) return;

  const chunks = await db.getChunksForRecording(id);
  if (chunks.length === 0) {
    showToast('Recording data not found in storage.');
    return;
  }

  const blob = new Blob(chunks.map((c) => c.data), { type: rec.mimeType || 'video/webm' });
  const ext = (rec.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(blob, `${rec.name || 'Recording'}.${ext}`);
  showToast('Download started!');
}

// ======== Delete recording ========
function promptDelete(id) {
  pendingDeleteId = id;
  const rec = allRecordings.find((r) => r.id === id);
  el('delete-name').textContent = rec?.name || 'this recording';
  el('modal-delete').classList.remove('hidden');
}

async function confirmDelete() {
  if (!pendingDeleteId) return;
  const idToDelete = pendingDeleteId; // capture before closeDeleteModal nulls it
  closeDeleteModal();

  try {
    await db.deleteRecording(idToDelete);
    allRecordings = allRecordings.filter((r) => r.id !== idToDelete);

    // Update badge count
    chrome.storage.local.get('recordingsCount', (data) => {
      const count = Math.max(0, (data.recordingsCount || 1) - 1);
      chrome.storage.local.set({ recordingsCount: count });
    });

    renderGrid(allRecordings);
    updateCount(allRecordings.length);
  } catch (err) {
    console.error('Failed to delete recording:', err);
  }
}

function closeDeleteModal() {
  pendingDeleteId = null;
  el('modal-delete').classList.add('hidden');
}

// ======== Recovery banner ========
function showRecoveryBanner(count) {
  el('recovery-text').textContent =
    `${count} recording${count > 1 ? 's were' : ' was'} recovered after an unexpected crash.`;
  el('recovery-banner').classList.remove('hidden');
}

// ======== Helpers ========
function updateCount(n) {
  const el_ = el('recording-count');
  el_.textContent = n > 0 ? `${n} recording${n !== 1 ? 's' : ''}` : '';
}

function showLoading(show) {
  el('loading-state').style.display = show ? 'flex' : 'none';
}

function modeLabel(mode) {
  const labels = { screen: 'Screen', camera: 'Camera', both: 'Screen+Cam', tab: 'Tab' };
  return labels[mode] || (mode || 'Screen');
}

function formatDuration(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  if (!bytes || bytes < 1024) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(id) { return document.getElementById(id); }

function showToast(msg, duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}
