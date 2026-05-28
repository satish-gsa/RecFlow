document.addEventListener('DOMContentLoaded', async () => {
  popupDb = new RecorderDB();
  await popupDb.open();

  const isActive = await checkActiveRecording();
  if (!isActive) {
    await loadState();
  }
  bindEvents();
  loadRecordingsBadge();
});

// ---- Events ----

function bindEvents() {
  // Mode cards
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      persistPrefs();
    });
  });

  // Audio radios
  document.querySelectorAll('input[name="audio"]').forEach((radio) => {
    radio.addEventListener('change', persistPrefs);
  });

  // Recordings button — show recordings panel in popup
  document.getElementById('btn-recordings').addEventListener('click', () => {
    showView('recordings');
    renderPopupRecordings();
  });

  // Record button
  document.getElementById('btn-record').addEventListener('click', startRecording);

  // Recordings panel navigation
  document.getElementById('btn-back').addEventListener('click', () => {
    chrome.storage.local.get('activeRecording', (data) => {
      showView(data.activeRecording?.active ? 'recording' : 'normal');
    });
  });
  document.getElementById('btn-full-library').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
    window.close();
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', () => {
    showView('settings');
    renderSettings();
  });
  document.getElementById('btn-settings-back').addEventListener('click', () => {
    chrome.storage.local.get('activeRecording', (data) => {
      showView(data.activeRecording?.active ? 'recording' : 'normal');
    });
  });
  document.getElementById('opt-buttons').addEventListener('click', () => saveCardStyle('buttons'));
  document.getElementById('opt-ellipsis').addEventListener('click', () => saveCardStyle('ellipsis'));

  // Close ellipsis menu on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ellipsis-trigger') && !e.target.closest('#ellipsis-menu')) {
      closeEllipsisMenu();
    }
  });

  // Recording control buttons
  document.getElementById('popup-btn-pause').addEventListener('click', () => {
    chrome.storage.local.get('activeRecording', (data) => {
      const isPaused = data.activeRecording?.isPaused;
      sendToRecorderTab(isPaused ? 'POPUP_RESUME' : 'POPUP_PAUSE');
    });
  });
  document.getElementById('popup-btn-stop').addEventListener('click', () => {
    sendToRecorderTab('POPUP_STOP');
    // Switch back to normal UI and go to the recorder tab
    chrome.storage.local.get('activeRecording', (data) => {
      const tabId = data.activeRecording?.tabId;
      if (tabId) chrome.tabs.update(tabId, { active: true });
    });
    window.close();
  });
  document.getElementById('popup-btn-discard').addEventListener('click', () => {
    if (confirm('Discard this recording? This cannot be undone.')) {
      sendToRecorderTab('POPUP_DISCARD');
      window.close();
    }
  });
  document.getElementById('popup-btn-go-tab').addEventListener('click', () => {
    chrome.storage.local.get('activeRecording', (data) => {
      const tabId = data.activeRecording?.tabId;
      if (tabId) chrome.tabs.update(tabId, { active: true });
    });
    window.close();
  });
}

// ---- Load / persist prefs ----

async function loadState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['recordMode', 'audioMode'], (data) => {
      const mode = data.recordMode || 'screen';
      const audio = data.audioMode || 'microphone';

      document.querySelectorAll('.mode-card').forEach((c) =>
        c.classList.toggle('active', c.dataset.mode === mode)
      );

      const audioInput = document.querySelector(`input[name="audio"][value="${audio}"]`);
      if (audioInput) audioInput.checked = true;

      resolve();
    });
  });
}

function persistPrefs() {
  const mode = document.querySelector('.mode-card.active')?.dataset.mode ?? 'screen';
  const audio = document.querySelector('input[name="audio"]:checked')?.value ?? 'microphone';
  chrome.storage.local.set({ recordMode: mode, audioMode: audio });
}

// ---- Recordings badge ----

function loadRecordingsBadge() {
  chrome.storage.local.get('recordingsCount', (data) => {
    const count = data.recordingsCount ?? 0;
    const badge = document.getElementById('recordings-badge');
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    }
  });
}

// ---- View management ----

let popupDb = null;

function showView(view) {
  document.getElementById('recording-controls').classList.toggle('hidden', view !== 'recording');
  document.getElementById('normal-ui').classList.toggle('hidden', view !== 'normal');
  document.getElementById('recordings-panel').classList.toggle('hidden', view !== 'recordings');
  document.getElementById('settings-panel').classList.toggle('hidden', view !== 'settings');
  // Close any open ellipsis menu when switching views
  closeEllipsisMenu();
}

// ---- Active recording detection ----

function checkActiveRecording() {
  return new Promise((resolve) => {
    chrome.storage.local.get('activeRecording', (data) => {
      const rec = data.activeRecording;
      if (rec && rec.active) {
        showView('recording');
        showRecordingControls(rec);
        startPopupTimer();
        resolve(true);
      } else {
        showView('normal');
        resolve(false);
      }
    });
  });
}

function showRecordingControls(rec) {
  showView('recording');
  setPopupPausedState(rec.isPaused);
}

function setPopupPausedState(isPaused) {
  document.getElementById('popup-icon-pause').style.display = isPaused ? 'none' : '';
  document.getElementById('popup-icon-resume').style.display = isPaused ? '' : 'none';
  document.getElementById('popup-pause-label').textContent = isPaused ? 'Resume' : 'Pause';
  document.getElementById('popup-rec-dot').classList.toggle('paused', isPaused);
  document.getElementById('popup-rec-status').textContent = isPaused ? 'Paused' : 'Recording…';
}

let popupTimerInterval = null;
function startPopupTimer() {
  function tick() {
    chrome.storage.local.get('activeRecording', (data) => {
      const rec = data.activeRecording;
      if (!rec || !rec.active) {
        clearInterval(popupTimerInterval);
        showView('normal');
        return;
      }
      setPopupPausedState(rec.isPaused);

      // Compute elapsed time
      const paused = rec.isPaused ? (Date.now() - (rec.pauseStart || Date.now())) : 0;
      const elapsed = Math.floor((Date.now() - rec.startTime - (rec.totalPausedMs || 0) - paused) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      document.getElementById('popup-rec-timer').textContent = `${mm}:${ss}`;
    });
  }
  tick();
  popupTimerInterval = setInterval(tick, 1000);
}

function sendToRecorderTab(type) {
  chrome.storage.local.get('activeRecording', (data) => {
    const tabId = data.activeRecording?.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type });
    }
  });
}

// ---- Start recording ----

function startRecording() {
  const mode = document.querySelector('.mode-card.active')?.dataset.mode ?? 'screen';
  const audio = document.querySelector('input[name="audio"]:checked')?.value ?? 'microphone';
  const url = chrome.runtime.getURL(`recorder/recorder.html?mode=${mode}&audio=${audio}`);
  chrome.tabs.create({ url, active: true });
  window.close();
}

// ---- Settings ----

function renderSettings() {
  chrome.storage.local.get('cardStyle', (data) => {
    const style = data.cardStyle || 'buttons';
    document.getElementById('radio-buttons').classList.toggle('selected', style === 'buttons');
    document.getElementById('radio-ellipsis').classList.toggle('selected', style === 'ellipsis');
    document.getElementById('opt-buttons').classList.toggle('active-opt', style === 'buttons');
    document.getElementById('opt-ellipsis').classList.toggle('active-opt', style === 'ellipsis');
  });
}

function saveCardStyle(style) {
  chrome.storage.local.set({ cardStyle: style }, () => renderSettings());
}

// ---- Ellipsis menu ----

let ellipsisTarget = null;

function openEllipsisMenu(btn, rec) {
  const menu = document.getElementById('ellipsis-menu');
  ellipsisTarget = rec;

  // Position below the button
  const rect = btn.getBoundingClientRect();
  const containerRect = document.querySelector('.container').getBoundingClientRect();
  menu.style.right = (containerRect.right - rect.right) + 'px';
  menu.style.top = (rect.bottom - containerRect.top + 4) + 'px';
  menu.classList.remove('hidden');

  document.getElementById('em-play').onclick = () => {
    closeEllipsisMenu();
    chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
    window.close();
  };
  document.getElementById('em-dl').onclick = async () => {
    closeEllipsisMenu();
    await popupDownload(rec);
  };
  document.getElementById('em-del').onclick = async () => {
    closeEllipsisMenu();
    if (!confirm(`Delete "${rec.name}"?`)) return;
    await popupDb.deleteRecording(rec.id);
    const card = document.querySelector(`.popup-rec-card[data-id="${rec.id}"]`);
    if (card) card.remove();
    chrome.storage.local.get('recordingsCount', (data) => {
      chrome.storage.local.set({ recordingsCount: Math.max(0, (data.recordingsCount || 1) - 1) });
    });
    if (!document.querySelector('.popup-rec-card')) {
      document.getElementById('popup-recs-empty').classList.remove('hidden');
    }
  };
}

function closeEllipsisMenu() {
  document.getElementById('ellipsis-menu')?.classList.add('hidden');
  ellipsisTarget = null;
}

// ---- Popup recordings panel ----

async function renderPopupRecordings() {
  const list = document.getElementById('popup-recs-list');
  const empty = document.getElementById('popup-recs-empty');
  const loading = document.getElementById('popup-recs-loading');

  list.innerHTML = '';
  empty.classList.add('hidden');
  loading.classList.remove('hidden');

  const [all, styleData] = await Promise.all([
    popupDb.getAllRecordings(),
    new Promise((r) => chrome.storage.local.get('cardStyle', r)),
  ]);
  const cardStyle = styleData.cardStyle || 'buttons';

  const complete = all
    .filter((r) => r.status === 'complete')
    .sort((a, b) => b.timestamp - a.timestamp);

  loading.classList.add('hidden');

  if (complete.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  for (const rec of complete) {
    list.appendChild(buildPopupRecCard(rec, cardStyle));
  }
}

function buildPopupRecCard(rec, cardStyle) {
  const div = document.createElement('div');
  div.className = 'popup-rec-card';
  div.dataset.id = rec.id;

  const dur = formatDur(rec.duration);
  const size = rec.size ? formatSize(rec.size) : '';
  const ago = timeAgo(rec.timestamp);
  const metaParts = [dur, size, ago].filter(Boolean);

  const thumbHtml = rec.thumbnail
    ? `<div class="popup-rec-thumb-wrap">
         <img src="${rec.thumbnail}" class="popup-rec-thumb" alt="">
         <div class="popup-rec-play-overlay"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg></div>
       </div>`
    : `<div class="popup-rec-thumb-wrap popup-rec-thumb-blank">
         <div class="popup-rec-play-overlay"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21"/></svg></div>
       </div>`;

  const actionsHtml = cardStyle === 'ellipsis'
    ? `<button class="prec-ellipsis ellipsis-trigger" title="More actions">
         <svg width="4" height="16" viewBox="0 0 4 16" fill="currentColor">
           <circle cx="2" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/>
         </svg>
       </button>`
    : `<div class="popup-rec-actions">
         <button class="prec-btn" data-act="play" title="Open in library"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg></button>
         <button class="prec-btn" data-act="dl" title="Download"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 3v13M6 11l6 6 6-6"/><path d="M3 20h18"/></svg></button>
         <button class="prec-btn danger" data-act="del" title="Delete"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg></button>
       </div>`;

  div.innerHTML = `
    ${thumbHtml}
    <div class="popup-rec-info">
      <div class="popup-rec-name" title="${escHtml(rec.name)}">${escHtml(rec.name)}</div>
      <div class="popup-rec-meta">${metaParts.join(' &bull; ')}</div>
    </div>
    ${actionsHtml}
  `;

  // Thumbnail click = open in library
  div.querySelector('.popup-rec-thumb-wrap').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
    window.close();
  });

  if (cardStyle === 'ellipsis') {
    div.querySelector('.prec-ellipsis').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('ellipsis-menu');
      const isOpen = !menu.classList.contains('hidden') && ellipsisTarget?.id === rec.id;
      closeEllipsisMenu();
      if (!isOpen) openEllipsisMenu(e.currentTarget, rec);
    });
  } else {
    div.querySelector('[data-act="play"]').addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
      window.close();
    });
    div.querySelector('[data-act="dl"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.textContent = '…';
      try { await popupDownload(rec); } finally {
        btn.disabled = false;
        btn.innerHTML = orig;
      }
    });
    div.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${rec.name}"?`)) return;
      await popupDb.deleteRecording(rec.id);
      div.remove();
      chrome.storage.local.get('recordingsCount', (data) => {
        chrome.storage.local.set({ recordingsCount: Math.max(0, (data.recordingsCount || 1) - 1) });
      });
      if (!document.querySelector('.popup-rec-card')) {
        document.getElementById('popup-recs-empty').classList.remove('hidden');
      }
    });
  }

  return div;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function popupDownload(rec) {
  const chunks = await popupDb.getChunksForRecording(rec.id);
  if (!chunks.length) return;
  const sorted = chunks.sort((a, b) => a.seq - b.seq);
  const blob = new Blob(sorted.map((c) => c.data), { type: rec.mimeType || 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${rec.name}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function formatDur(ms) {
  if (!ms) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
