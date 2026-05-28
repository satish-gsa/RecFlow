// ======== Recording state ========
const state = {
  isRecording: false,
  mode: null,
  recorderTabId: null,
  floatWindowId: null,
};

// ======== Message handler ========
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'RECORDING_STARTED':
      state.isRecording = true;
      state.mode = message.mode;
      state.recorderTabId = sender.tab?.id ?? null;
      setBadge(true);
      // Open floating control bar
      openFloatWindow();
      sendResponse({ ok: true });
      break;

    case 'RECORDING_STOPPED':
      state.isRecording = false;
      state.recorderTabId = null;
      setBadge(false);
      // Close floating control bar
      closeFloatWindow();
      sendResponse({ ok: true });
      break;

    case 'GET_RECORDING_STATE':
      sendResponse({ ...state });
      break;

    case 'OPEN_RECORDER': {
      const url =
        `chrome-extension://${chrome.runtime.id}/recorder/recorder.html` +
        `?mode=${encodeURIComponent(message.mode)}&audio=${encodeURIComponent(message.audio)}`;
      chrome.tabs.create({ url, active: true }, () => sendResponse({ ok: true }));
      break;
    }

    case 'OPEN_RECORDINGS': {
      const url = `chrome-extension://${chrome.runtime.id}/recordings/recordings.html`;
      chrome.tabs.query({ url }, (tabs) => {
        if (tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true }, () => sendResponse({ ok: true }));
        } else {
          chrome.tabs.create({ url, active: true }, () => sendResponse({ ok: true }));
        }
      });
      break;
    }

    default:
      sendResponse({ ok: false, error: 'Unknown message type' });
  }

  return true; // keep channel open for async sendResponse
});

// ======== Float window helpers ========
function openFloatWindow() {
  // Close any stale float window first
  closeFloatWindow();

  chrome.windows.create({
    url: chrome.runtime.getURL('float/float.html'),
    type: 'popup',
    width: 240,
    height: 58,
    top: 40,
    focused: false,
  }, (win) => {
    state.floatWindowId = win?.id ?? null;
  });
}

function closeFloatWindow() {
  if (state.floatWindowId !== null) {
    chrome.windows.remove(state.floatWindowId, () => {
      void chrome.runtime.lastError; // suppress "no such window" errors
    });
    state.floatWindowId = null;
  }
}

// Keep floatWindowId in sync if the user manually closes the float
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === state.floatWindowId) {
    state.floatWindowId = null;
  }
});

// ======== Badge helpers ========
function setBadge(recording) {
  chrome.action.setBadgeText({ text: recording ? '●' : '' });
  chrome.action.setBadgeBackgroundColor({ color: recording ? '#e84040' : '#666' });
}

// ======== Startup ========
chrome.runtime.onStartup.addListener(() => {
  setBadge(false);
  state.isRecording = false;
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge(false);
  // Init recordings count
  chrome.storage.local.get('recordingsCount', (data) => {
    if (data.recordingsCount === undefined) {
      chrome.storage.local.set({ recordingsCount: 0 });
    }
  });
});
