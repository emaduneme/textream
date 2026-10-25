# Textream Desktop (Electron)

Textream for **Windows**, **Linux** and **macOS**, built with Electron. It ports the Mac app's behavior, so scripts, the remote viewer and the Director Mode protocol all work the same way.

## What's in it

| Mac app feature | Electron version |
|---|---|
| Word Tracking | Offline speech recognition with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), plus the same two-strategy word matcher, ported line by line from `SpeechRecognizer.swift`. You download the model once from Settings → Guidance. |
| Classic, Voice-Activated | Same speeds (0.5–8 words/s) and the same voice detector thresholds. |
| Pinned to Notch | A Dynamic Island–style bar at the top centre of the screen, under the webcam. Follow mouse or fixed display. |
| Floating Window | Always on top, draggable, resizable. Glass effect uses Acrylic on Windows 11 and vibrancy on macOS. Follow-cursor mode. |
| Fullscreen | On any display, with big type, a reading-line marker and an auto-hiding control bar. Esc to stop. |
| External display and mirror | Fullscreen teleprompter or a mirrored output (horizontal, vertical, both) on a second display. |
| Hide from screen share | `setContentProtection`, which works on Windows 10 2004+ and macOS. |
| Remote Connection | Same page, port 7373 and WebSocket 7374. QR codes for a normal view and a mirrored view (`?mirror=1`). |
| Director Mode | Same page, port 7575 and WebSocket 7576, same auth token and `setText` / `updateText` / `stop` protocol. |
| Files | `.textream` (same JSON format), `.txt`, `.md`, and PowerPoint presenter notes. Notes follow the deck's slide order. |
| Pages | Multi-page scripts, auto-advance with a 0/1/3/5 s countdown, and previous/next buttons in the overlay. |
| `textream://read?text=…` | Registered on install. |

## Run it

```bash
cd desktop
npm install
npm start
```

On Linux as root (containers), add `-- --no-sandbox`.

## Controls while reading

| Action | Keys |
|---|---|
| Pause (Classic) or mute (voice modes) | Ctrl+Shift+Space, from any app |
| Stop | Ctrl+Shift+. (period), from any app; Esc in fullscreen |
| Next or previous page | Ctrl+Shift+→ / ←, from any app |
| Speed up or slow down | ↑ / ↓ in a focused prompter window |
| Skip a line | → / ← or Page Down / Page Up in a focused prompter window |
| Jump to a word | Click it |
| Catch up or go back | Scroll the mouse wheel over the text |

On macOS, Ctrl is Cmd.

## Tests

```bash
npm test          # unit tests: matcher, text helpers, VAD, model download
npm run test:e2e  # Electron end-to-end tests (Linux needs xvfb-run)
```

The end-to-end suite drives the real app: overlay modes, classic scrolling, word tracking (with a fake speech engine fed transcripts), page advance, fullscreen, the remote viewer, the director protocol, and file import. A separate test loads the native sherpa-onnx addon in Electron's utility process to prove it works without a model download.

## Build installers

```bash
npm run dist:win    # NSIS installer (.exe)
npm run dist:mac    # .dmg
npm run dist:linux  # AppImage
```

The `Desktop (Electron)` GitHub workflow runs the tests and builds unsigned installers for all three platforms on every push that touches `desktop/`. Download them from the run's artifacts.

Unsigned builds show a warning on first launch: on Windows, SmartScreen ("More info" → "Run anyway"); on macOS, Gatekeeper (right-click → Open).

## Layout

```
desktop/
├── src/main/        main process: windows, session, speech, LAN servers, files, settings
├── src/shared/      text helpers, word matcher, voice detector (unit tested)
├── src/preload/     the bridge renderers use
├── src/renderer/    editor window and prompter views
├── src/web/         remote and director pages (taken unchanged from the Swift sources)
└── test/            unit and end-to-end tests
```
