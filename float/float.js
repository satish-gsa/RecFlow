/**
 * float.js — Floating recording controls window for RecFlow.
 *
 * Polls chrome.storage.local for activeRecording state.
 * Sends control messages to the recorder tab.
 * Auto-closes when recording ends.
 */

let timerInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  bindButtons();
  pollState();
  timerInterval = setInterval(pollState, 500);
});

// ---- Poll recording state ----

function pollState() {
  chrome.storage.local.get('activeRecording', (data) => {
    const rec = data.activeRecording;

    if (!rec || !rec.active) {
      // Recording ended — close float window
      clearInterval(timerInterval);
      window.close();
      return;
    }

    // Update timer
    const paused = rec.isPaused ? (Date.now() - (rec.pauseStart || Date.now())) : 0;
    const elapsed = Math.max(0, Math.floor((Date.now() - rec.startTime - (rec.totalPausedMs || 0) - paused) / 1000));
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    document.getElementById('float-timer').textContent = `${mm}:${ss}`;

    // Update pause/resume icon
    const dot = document.getElementById('float-dot');
    const iconPause = document.getElementById('icon-pause');
    const iconResume = document.getElementById('icon-resume');

    if (rec.isPaused) {
      dot.classList.add('paused');
      iconPause.classList.add('hidden');
      iconResume.classList.remove('hidden');
      document.getElementById('float-pause').title = 'Resume';
    } else {
      dot.classList.remove('paused');
      iconPause.classList.remove('hidden');
      iconResume.classList.add('hidden');
      document.getElementById('float-pause').title = 'Pause';
    }
  });
}

// ---- Button bindings ----

function bindButtons() {
  document.getElementById('float-pause').addEventListener('click', () => {
    chrome.storage.local.get('activeRecording', (data) => {
      const tabId = data.activeRecording?.tabId;
      const type = data.activeRecording?.isPaused ? 'POPUP_RESUME' : 'POPUP_PAUSE';
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type }, () => { void chrome.runtime.lastError; });
      }
    });
  });

  document.getElementById('float-stop').addEventListener('click', () => {
    clearInterval(timerInterval);
    chrome.storage.local.get('activeRecording', (data) => {
      const tabId = data.activeRecording?.tabId;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'POPUP_STOP' }, () => {
          void chrome.runtime.lastError;
          // Bring recorder tab to focus then close float
          chrome.tabs.update(tabId, { active: true }, () => window.close());
        });
      } else {
        window.close();
      }
    });
  });

  document.getElementById('float-discard').addEventListener('click', () => {
    if (!confirm('Discard this recording? This cannot be undone.')) return;
    clearInterval(timerInterval);
    chrome.storage.local.get('activeRecording', (data) => {
      const tabId = data.activeRecording?.tabId;
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { type: 'POPUP_DISCARD' }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      } else {
        window.close();
      }
    });
  });
}

// (sendToRecorderTab removed — all sends are now inline with callbacks)
