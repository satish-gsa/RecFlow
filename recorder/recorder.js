/**
 * recorder.js — Core recording logic for RecFlow Chrome Extension.
 *
 * Supports modes: screen | camera | both | tab
 * Audio:          microphone | system | both | none
 * Features:       autosave (IndexedDB), crash recovery, canvas PIP mixing,
 *                 pause/resume, countdown, download
 */

// ======== State ========
const S = {
  mode: 'screen',
  audioMode: 'microphone',

  screenStream: null,
  cameraStream: null,
  micStream: null,
  recordStream: null,

  mediaRecorder: null,
  chunks: [],
  chunkSeq: 0,
  mimeType: '',

  sessionId: null,
  recordingName: '',
  startTime: null,
  totalPausedMs: 0,
  pauseStart: null,
  isPaused: false,
  isRecording: false,

  timerInterval: null,
  animFrameId: null,
  db: null,

  // PIP drag state
  pipDragging: false,
  pipDragOffset: { x: 0, y: 0 },

  // Countdown skip flag
  skipCountdown: false,
};

// ======== Init ========
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  S.mode = params.get('mode') || 'screen';
  S.audioMode = params.get('audio') || 'microphone';

  updateModeBadge();
  bindStaticEvents();

  S.db = new RecorderDB();
  await S.db.open();

  // Check for crash-recovered sessions
  await checkForRecovery();

  // Begin capture flow
  await startCapture();
});

// ======== UI helpers ========
function el(id) { return document.getElementById(id); }

function showOverlay(id) {
  ['overlay-countdown', 'overlay-status', 'overlay-save', 'overlay-discard'].forEach((o) => {
    el(o).classList.add('hidden');
  });
  if (id) el(id).classList.remove('hidden');
}

function hideAllOverlays() {
  ['overlay-countdown', 'overlay-status', 'overlay-save', 'overlay-discard'].forEach((o) =>
    el(o).classList.add('hidden')
  );
}

function setStatus(msg, showActions = false) {
  el('status-message').textContent = msg;
  el('status-spinner').style.display = showActions ? 'none' : 'block';
  el('status-actions').classList.toggle('hidden', !showActions);
  showOverlay('overlay-status');
}

function updateModeBadge() {
  const labels = { screen: 'SCREEN', camera: 'CAMERA', both: 'SCREEN+CAM', tab: 'TAB' };
  el('mode-badge').textContent = labels[S.mode] || S.mode.toUpperCase();
}

// ======== Static event bindings ========
// ======== Popup message listener ========
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'POPUP_PAUSE')   { if (S.isRecording) togglePause(); }
  if (msg.type === 'POPUP_RESUME')  { if (S.isRecording) togglePause(); }
  if (msg.type === 'POPUP_STOP')    { if (S.isRecording) handleStop(); }
  if (msg.type === 'POPUP_DISCARD') { if (S.isRecording) discardRecording(); }
});

function bindStaticEvents() {
  el('btn-pause').addEventListener('click', togglePause);
  el('btn-stop').addEventListener('click', handleStop);
  el('btn-discard').addEventListener('click', () => showOverlay('overlay-discard'));
  el('btn-confirm-discard').addEventListener('click', discardRecording);
  el('btn-cancel-discard').addEventListener('click', hideAllOverlays);
  el('btn-skip-countdown').addEventListener('click', () => { S.skipCountdown = true; });
  el('btn-retry').addEventListener('click', () => window.location.reload());
  el('btn-close-tab').addEventListener('click', () => window.close());
  el('btn-new-recording').addEventListener('click', () => window.location.reload());
  el('btn-view-recordings').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
    window.close();
  });
  el('btn-download').addEventListener('click', downloadCurrentRecording);

  // PIP drag
  setupPipDrag();
}

// ======== Capture flow ========
async function startCapture() {
  try {
    setStatus('Requesting permissions…');

    if (S.mode === 'screen' || S.mode === 'both' || S.mode === 'tab') {
      S.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: S.mode === 'tab' ? 'browser' : 'monitor',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: S.audioMode === 'system' || S.audioMode === 'both',
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });

      // User stopped sharing via browser chrome
      S.screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        if (S.isRecording) handleStop();
      });
    }

    if (S.mode === 'camera' || S.mode === 'both') {
      const camConstraints = {
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: S.audioMode === 'microphone' || S.audioMode === 'both',
      };
      S.cameraStream = await navigator.mediaDevices.getUserMedia(camConstraints);
    }

    // For mic-only audio when not capturing camera
    if (
      (S.mode === 'screen' || S.mode === 'tab') &&
      (S.audioMode === 'microphone' || S.audioMode === 'both')
    ) {
      S.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    setupPreview();
    await runCountdown(3);
    await beginRecording();
  } catch (err) {
    handleCaptureError(err);
  }
}

function setupPreview() {
  const mainVideo = el('preview-video');
  const cameraPip = el('camera-pip');
  const cameraVideo = el('camera-video');

  if (S.mode === 'screen' || S.mode === 'tab') {
    mainVideo.srcObject = S.screenStream;
  } else if (S.mode === 'camera') {
    mainVideo.srcObject = S.cameraStream;
  } else if (S.mode === 'both') {
    mainVideo.srcObject = S.screenStream;
    cameraVideo.srcObject = new MediaStream(S.cameraStream.getVideoTracks());
    cameraPip.style.display = 'block';
  }
}

// ======== Countdown ========
async function runCountdown(seconds) {
  S.skipCountdown = false;
  showOverlay('overlay-countdown');
  const numEl = el('countdown-number');

  for (let i = seconds; i > 0; i--) {
    if (S.skipCountdown) break;
    numEl.textContent = String(i);
    await sleep(1000);
  }
  hideAllOverlays();
}

// ======== Recording ========
async function beginRecording() {
  S.sessionId = crypto.randomUUID();
  S.recordingName = makeRecordingName();
  S.chunks = [];
  S.chunkSeq = 0;

  S.recordStream = await buildRecordStream();
  S.mimeType = getSupportedMimeType();

  S.mediaRecorder = new MediaRecorder(S.recordStream, {
    mimeType: S.mimeType,
    videoBitsPerSecond: 4_000_000,
    audioBitsPerSecond: 128_000,
  });

  S.mediaRecorder.ondataavailable = async (e) => {
    if (e.data?.size > 0) {
      S.chunks.push(e.data);
      // Autosave each chunk for crash recovery
      try {
        await S.db.saveChunk(S.sessionId, e.data, S.chunkSeq++);
      } catch (_) { /* non-fatal */ }
    }
  };

  S.mediaRecorder.onstop = finishRecording;

  // Persist recording metadata
  await S.db.createRecording({
    id: S.sessionId,
    name: S.recordingName,
    mode: S.mode,
    audioMode: S.audioMode,
    mimeType: S.mimeType,
    status: 'recording',
    timestamp: Date.now(),
    duration: 0,
    size: 0,
    thumbnail: null,
  });

  // Start with 5-second timeslice for autosave granularity
  S.mediaRecorder.start(5000);
  S.startTime = Date.now();
  S.totalPausedMs = 0;
  S.isRecording = true;

  // Show recording UI
  el('record-indicator').classList.remove('hidden');
  el('controls-bar').classList.remove('hidden');
  startTimer();

  // Store active state so popup can show controls
  const _recStart = Date.now();
  chrome.storage.local.set({ activeRecording: { active: true, isPaused: false, tabId: null, startTime: _recStart, totalPausedMs: 0, pauseStart: null } });
  chrome.tabs.getCurrent((tab) => {
    if (tab) chrome.storage.local.set({ activeRecording: { active: true, isPaused: false, tabId: tab.id, startTime: _recStart, totalPausedMs: 0, pauseStart: null } });
  });

  chrome.runtime.sendMessage({ type: 'RECORDING_STARTED', mode: S.mode });
}

// ---- Build record stream per mode ----

async function buildRecordStream() {
  if (S.mode === 'screen' || S.mode === 'tab') return buildScreenStream();
  if (S.mode === 'camera') return buildCameraStream();
  if (S.mode === 'both') return buildBothStream();
  throw new Error('Unknown mode: ' + S.mode);
}

function buildScreenStream() {
  const tracks = [...S.screenStream.getVideoTracks()];

  if (S.audioMode === 'system') {
    tracks.push(...S.screenStream.getAudioTracks());
  } else if (S.audioMode === 'microphone' && S.micStream) {
    tracks.push(...S.micStream.getAudioTracks());
  } else if (S.audioMode === 'both') {
    // Mixed audio handled separately; both audio tracks will be in S.micStream (mixed) or screen
    if (S.micStream) tracks.push(...S.micStream.getAudioTracks());
    tracks.push(...S.screenStream.getAudioTracks());
  }

  return new MediaStream(tracks);
}

function buildCameraStream() {
  const tracks = [...S.cameraStream.getVideoTracks()];
  if (S.audioMode !== 'none') tracks.push(...S.cameraStream.getAudioTracks());
  return new MediaStream(tracks);
}

async function buildBothStream() {
  // Canvas for PIP compositing
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const screenSettings = S.screenStream.getVideoTracks()[0].getSettings();
  canvas.width = screenSettings.width || 1280;
  canvas.height = screenSettings.height || 720;

  // Hidden video elements for drawing
  const screenVid = makeHiddenVideo(S.screenStream);
  const camVid = makeHiddenVideo(new MediaStream(S.cameraStream.getVideoTracks()));
  await Promise.all([screenVid.play(), camVid.play()]);

  // PIP in bottom-right corner (20% width)
  const pipW = Math.round(canvas.width * 0.2);
  const pipH = Math.round(pipW * (9 / 16));
  const pipX = canvas.width - pipW - 20;
  const pipY = canvas.height - pipH - 20;
  const pipRadius = 8;

  function drawFrame() {
    // Full-screen
    ctx.drawImage(screenVid, 0, 0, canvas.width, canvas.height);

    // Camera PIP with rounded corners
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pipX + pipRadius, pipY);
    ctx.lineTo(pipX + pipW - pipRadius, pipY);
    ctx.quadraticCurveTo(pipX + pipW, pipY, pipX + pipW, pipY + pipRadius);
    ctx.lineTo(pipX + pipW, pipY + pipH - pipRadius);
    ctx.quadraticCurveTo(pipX + pipW, pipY + pipH, pipX + pipW - pipRadius, pipY + pipH);
    ctx.lineTo(pipX + pipRadius, pipY + pipH);
    ctx.quadraticCurveTo(pipX, pipY + pipH, pipX, pipY + pipH - pipRadius);
    ctx.lineTo(pipX, pipY + pipRadius);
    ctx.quadraticCurveTo(pipX, pipY, pipX + pipRadius, pipY);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(camVid, pipX, pipY, pipW, pipH);
    ctx.restore();

    S.animFrameId = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  const canvasStream = canvas.captureStream(30);
  const tracks = [...canvasStream.getVideoTracks()];

  // Audio mixing
  if (S.audioMode !== 'none') {
    const audioStream = await mixAudio();
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
  }

  return new MediaStream(tracks);
}

async function mixAudio() {
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();

  const connect = (stream) => {
    if (!stream) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length > 0) {
      audioCtx.createMediaStreamSource(new MediaStream(audioTracks)).connect(dest);
    }
  };

  if (S.audioMode === 'microphone' || S.audioMode === 'both') {
    connect(S.cameraStream); // getUserMedia result has mic audio
    if (S.micStream) connect(S.micStream);
  }
  if (S.audioMode === 'system' || S.audioMode === 'both') {
    connect(S.screenStream);
  }

  return dest.stream;
}

function makeHiddenVideo(stream) {
  const v = document.createElement('video');
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  v.style.position = 'absolute';
  v.style.visibility = 'hidden';
  v.style.pointerEvents = 'none';
  document.body.appendChild(v);
  return v;
}

// ======== Pause / Resume ========
function togglePause() {
  if (!S.isRecording || !S.mediaRecorder) return;

  if (S.isPaused) {
    S.mediaRecorder.resume();
    S.totalPausedMs += Date.now() - S.pauseStart;
    S.pauseStart = null;
    S.isPaused = false;
    el('icon-pause').style.display = '';
    el('icon-resume').style.display = 'none';
    el('pause-label').textContent = 'Pause';
    el('rec-dot').classList.remove('paused');
    chrome.storage.local.get('activeRecording', (d) => {
      if (d.activeRecording) {
        const extra = d.activeRecording.pauseStart ? (Date.now() - d.activeRecording.pauseStart) : 0;
        chrome.storage.local.set({ activeRecording: { ...d.activeRecording, isPaused: false, totalPausedMs: (d.activeRecording.totalPausedMs || 0) + extra, pauseStart: null } });
      }
    });
  } else {
    S.mediaRecorder.pause();
    S.pauseStart = Date.now();
    S.isPaused = true;
    el('icon-pause').style.display = 'none';
    el('icon-resume').style.display = '';
    el('pause-label').textContent = 'Resume';
    el('rec-dot').classList.add('paused');
    chrome.storage.local.get('activeRecording', (d) => {
      if (d.activeRecording) chrome.storage.local.set({ activeRecording: { ...d.activeRecording, isPaused: true, pauseStart: Date.now() } });
    });
  }
}

// ======== Stop / Discard ========
function handleStop() {
  if (!S.isRecording) return;
  doStop();
}

function doStop() {
  S.isRecording = false;
  stopTimer();
  cancelAnimationFrame(S.animFrameId);
  S.mediaRecorder.stop();
  stopAllStreams();
  chrome.storage.local.set({ activeRecording: { active: false, isPaused: false, tabId: null } });
  chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED' });
  setStatus('Processing recording…');
}

function stopAllStreams() {
  [S.screenStream, S.cameraStream, S.micStream].forEach((s) => {
    if (s) s.getTracks().forEach((t) => t.stop());
  });
}

async function discardRecording() {
  hideAllOverlays();
  if (S.isRecording) doStop();

  // Remove from DB
  if (S.sessionId) {
    try { await S.db.deleteRecording(S.sessionId); } catch (_) {}
  }
  window.close();
}

// ======== Finish & save ========
async function finishRecording() {
  const duration = Date.now() - S.startTime - S.totalPausedMs;
  const blob = new Blob(S.chunks, { type: S.mimeType });

  // Generate thumbnail
  let thumbnail = null;
  try { thumbnail = await generateThumbnail(blob); } catch (_) {}

  // Update DB: replace many autosave chunks with one final consolidated blob
  try {
    await S.db.deleteChunksForRecording(S.sessionId);
    await S.db.saveChunk(S.sessionId, blob, 0); // single chunk = full recording
    await S.db.updateRecording(S.sessionId, {
      status: 'complete',
      duration,
      size: blob.size,
      thumbnail,
      name: S.recordingName,
    });
  } catch (_) {}

  // Update badge count
  chrome.storage.local.get('recordingsCount', (data) => {
    chrome.storage.local.set({ recordingsCount: (data.recordingsCount || 0) + 1 });
  });

  showSaveOverlay(blob, duration);
}

function showSaveOverlay(blob, duration) {
  const url = URL.createObjectURL(blob);
  el('save-preview').src = url;
  el('save-title').textContent = S.recordingName;
  el('save-duration').textContent = formatDuration(duration);
  el('save-size').textContent = formatSize(blob.size);
  showOverlay('overlay-save');

  // Stash for download
  window._currentBlob = blob;
  window._currentMime = S.mimeType;
}

function downloadCurrentRecording() {
  if (!window._currentBlob) return;
  const ext = window._currentMime?.includes('mp4') ? 'mp4' : 'webm';
  const name = el('save-title')?.textContent?.trim() || S.recordingName;
  downloadBlob(window._currentBlob, `${name}.${ext}`);
}

// ======== Thumbnail ========
function generateThumbnail(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const vid = document.createElement('video');
    vid.src = url;
    vid.preload = 'metadata';
    vid.muted = true;

    const timeout = setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('timeout')); }, 8000);

    vid.onloadeddata = () => { vid.currentTime = Math.min(1.0, (vid.duration || 0) * 0.1); };
    vid.onseeked = () => {
      clearTimeout(timeout);
      const c = document.createElement('canvas');
      c.width = 320;
      c.height = Math.round(320 * (vid.videoHeight / (vid.videoWidth || 1))) || 180;
      c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    vid.onerror = () => { clearTimeout(timeout); URL.revokeObjectURL(url); reject(new Error('video error')); };
  });
}

// ======== Timer ========
function startTimer() {
  const timerEl = el('timer');
  S.timerInterval = setInterval(() => {
    const elapsed = Date.now() - S.startTime - S.totalPausedMs;
    timerEl.textContent = formatDuration(elapsed);
  }, 200);
}

function stopTimer() {
  clearInterval(S.timerInterval);
  S.timerInterval = null;
}

// ======== PIP Drag ========
function setupPipDrag() {
  const pip = el('camera-pip');
  if (!pip) return;

  pip.addEventListener('mousedown', (e) => {
    S.pipDragging = true;
    const rect = pip.getBoundingClientRect();
    S.pipDragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!S.pipDragging) return;
    const x = Math.max(0, Math.min(window.innerWidth - pip.offsetWidth, e.clientX - S.pipDragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - pip.offsetHeight, e.clientY - S.pipDragOffset.y));
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
    pip.style.left = `${x}px`;
    pip.style.top = `${y}px`;
  });

  document.addEventListener('mouseup', () => { S.pipDragging = false; });
}

// ======== Crash Recovery ========
async function checkForRecovery() {
  try {
    const incomplete = await S.db.getRecordingsByStatus('recording');
    if (incomplete.length === 0) return;

    // Attempt to assemble and mark as recovered
    for (const rec of incomplete) {
      const chunks = await S.db.getChunksForRecording(rec.id);
      if (chunks.length === 0) {
        await S.db.deleteRecording(rec.id);
        continue;
      }
      const blob = new Blob(chunks.map((c) => c.data), { type: rec.mimeType || 'video/webm' });
      let thumbnail = null;
      try { thumbnail = await generateThumbnail(blob); } catch (_) {}

      await S.db.updateRecording(rec.id, {
        status: 'recovered',
        size: blob.size,
        thumbnail,
        name: rec.name + ' (Recovered)',
      });
      await S.db.deleteChunksForRecording(rec.id);

      chrome.storage.local.get('recordingsCount', (data) => {
        chrome.storage.local.set({ recordingsCount: (data.recordingsCount || 0) + 1 });
      });
    }

    showRecoveryBanner(incomplete.length);
  } catch (_) {}
}

function showRecoveryBanner(count) {
  const banner = document.createElement('div');
  banner.className = 'recovery-banner';
  banner.innerHTML = `
    <span>⚠️ ${count} recording${count > 1 ? 's' : ''} recovered after a crash</span>
    <button onclick="openRecordingsPage()">View</button>
    <button class="close-btn" onclick="this.parentElement.remove()">✕</button>
  `;
  document.body.appendChild(banner);
}

window.openRecordingsPage = function () {
  chrome.tabs.create({ url: chrome.runtime.getURL('recordings/recordings.html'), active: true });
};

// ======== Error handling ========
function handleCaptureError(err) {
  // User cancelled the picker — close silently, nothing to report
  const isCancelled =
    err.name === 'AbortError' ||
    err.name === 'NotAllowedError' ||
    err.message?.toLowerCase().includes('cancel');

  if (isCancelled) {
    window.close();
    return;
  }

  console.error('Capture error:', err.name, err.message);

  const messages = {
    NotFoundError: 'Camera or microphone not found.',
    NotReadableError: 'Screen or camera is already in use by another application.',
    OverconstrainedError: 'Camera does not support the requested settings.',
  };

  setStatus(messages[err.name] || `Error: ${err.message}`, true);
}

// ======== MIME type ========
function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

// ======== Helpers ========
function formatDuration(ms) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function makeRecordingName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
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

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
