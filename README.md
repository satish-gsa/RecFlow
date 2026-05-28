# RecFlow — Chrome Screen Recorder

A free, no-watermark, no-signup Chrome extension to record your screen, camera, or both.

> **No Chrome Web Store account needed.** Download the latest zip from [Releases](https://github.com/satish-gsa/RecFlow/releases/latest) and load it directly in Chrome.

## ⚡ Quick Install (for Everyone)

1. Go to the [**Releases page**](https://github.com/satish-gsa/RecFlow/releases/latest) and download `recflow-vX.X.X.zip`
2. Unzip the file anywhere on your computer
3. Open Chrome → `chrome://extensions/`
4. Turn on **Developer mode** (toggle, top-right)
5. Click **Load unpacked** → select the unzipped folder
6. The RecFlow icon appears in your toolbar — click to record!

> **Supported browsers**: Chrome 88+, Edge 88+, Brave, or any Chromium-based browser.

---

## Features

- **Record Screen** — Full desktop, specific window, or browser tab
- **Record Camera** — Webcam with microphone audio
- **Screen + Camera (PIP)** — Camera overlaid on screen recording (picture-in-picture, burned into the video)
- **Audio Options** — Microphone, system audio, both, or none
- **Autosave / Crash Recovery** — Recordings are chunked to IndexedDB every 5 seconds; recovered automatically after a crash
- **Pause & Resume** — Full pause/resume support during recording
- **Download** — Save as `.webm` (VP9/Opus, no watermarks)
- **Recordings Library** — Browse, rename, play, and delete all saved recordings
- **Countdown** — 3-second countdown before recording begins
- **No signup required · Free · Unlimited recordings**

## Installation

### For end users (easiest)

Download the latest `.zip` from the [Releases page](https://github.com/satish-gsa/RecFlow/releases/latest), unzip it, then follow the Quick Install steps above.

### For developers (from source)

#### 1. Generate icons

```bash
node setup.js
```

This creates `icons/icon16.png`, `icons/icon48.png`, and `icons/icon128.png` using only Node.js built-ins — no npm dependencies needed.

#### 2. Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this directory

The extension icon appears in your toolbar.

## Usage

### Start a Recording

1. Click the extension icon
2. Choose **Recording Mode**:
   - **Screen** — Select a monitor or window via Chrome's media picker
   - **Camera** — Records your webcam
   - **Screen + Cam** — Screen with camera PIP (camera is composited onto the recording)
   - **Browser Tab** — Suggests picking a browser tab in the media picker
3. Choose **Audio Source** (Microphone / System Audio / Both / None)
4. Click **Start Recording**
5. Pick your source in Chrome's media picker
6. 3-second countdown, then recording begins

### During Recording

| Button | Action |
|--------|--------|
| ⏸ Pause | Pause the recording (timer freezes) |
| ▶ Resume | Continue recording |
| ⏹ Stop | Stop and show save screen |
| 🗑 Discard | Cancel and delete (confirms before discarding) |

### After Recording

- **Preview** — Watch your recording immediately
- **Rename** — Click the title to rename
- **Download** — Save `.webm` to your Downloads folder
- **My Recordings** — Open the recordings library

### Recordings Library

- Click the monitor icon in the popup header, or click **My Recordings** after stopping
- **Play** recordings in a modal player
- **Download** any recording
- **Rename** by clicking the title on a card
- **Delete** with a confirmation prompt

## File Structure

```
screen-recorder-extension/
├── manifest.json               # MV3 manifest
├── setup.js                    # Icon generator (node setup.js)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   └── service-worker.js       # Badge management, tab routing
├── popup/
│   ├── popup.html              # Extension popup UI
│   ├── popup.js                # Popup logic
│   └── popup.css               # Popup styles
├── recorder/
│   ├── recorder.html           # Full-screen recorder page
│   ├── recorder.js             # Recording engine (streams, canvas, IndexedDB)
│   └── recorder.css            # Recorder styles
├── recordings/
│   ├── recordings.html         # Recordings library page
│   ├── recordings.js           # Library logic
│   └── recordings.css          # Library styles
└── utils/
    └── db.js                   # IndexedDB wrapper (RecorderDB class)
```

## Technical Details

### Recording Engine

- **Screen capture**: `navigator.mediaDevices.getDisplayMedia()` — Chrome's native picker
- **Camera capture**: `navigator.mediaDevices.getUserMedia()`
- **Screen + Camera mixing**: HTML5 Canvas `captureStream(30fps)` with `requestAnimationFrame` draw loop
- **Audio mixing**: Web Audio API `AudioContext` destination node
- **Format**: WebM (VP9 + Opus preferred; falls back to VP8 or generic WebM)
- **Bitrate**: 4 Mbps video, 128 kbps audio

### Autosave / Recovery

MediaRecorder is started with a `5000ms` timeslice. Every 5 seconds, `ondataavailable` fires and the chunk blob is saved to IndexedDB. If the browser tab is closed or crashes mid-recording, chunks are reassembled the next time the recordings page opens.

### Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Save preferences (mode, audio) and recordings count badge |
| `tabs` | Open recorder and recordings pages as new tabs |

No `<all_urls>` host permission is required. Screen/camera access is granted via browser's built-in media prompts.

## Browser Compatibility

- **Chrome 88+** (Manifest V3, `getDisplayMedia`, `MediaRecorder`)
- **Edge 88+** (Chromium-based)

## Known Limitations

- System audio capture depends on the user enabling it in Chrome's media picker (not all platforms support it)
- The recordings library can only play/download recordings that still have chunks in IndexedDB. If you download a recording and clear IndexedDB manually, the metadata card remains but the video is unavailable
- Safari is not supported (no `MediaRecorder` with WebM)

## Development Notes

- All scripts use vanilla ES2020+ (no build step required)
- No external npm dependencies for the extension itself
- `setup.js` uses only Node.js built-in modules (`zlib`, `fs`, `path`)
