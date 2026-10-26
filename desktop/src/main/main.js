'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, shell,
  globalShortcut, powerSaveBlocker, systemPreferences, utilityProcess,
} = require('electron');
const QRCode = require('qrcode');

const { Settings, viewStyle } = require('./settings');
const { ModelStore } = require('./models');
const { SpeechEngine, FakeSpeechEngine } = require('./speech');
const { Session } = require('./session');
const { RemoteServer, DirectorServer, browserState, directorState } = require('./lan');
const { readDocument, writeDocument } = require('./documents');

const SRC = path.join(__dirname, '..');
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const TEST_MODE = process.env.TEXTREAM_TEST === '1';

if (process.env.TEXTREAM_USER_DATA) app.setPath('userData', process.env.TEXTREAM_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
}

const DEFAULT_TEXT = `Welcome to Textream! This is your personal teleprompter that sits right below your camera. [smile]

As you read aloud, the text will highlight in real-time, following your voice. The speech recognition runs on your computer, so your words stay private. [pause]

You can tap on any word to jump to that position. The overlay stays on top of your other apps, so you can read while you present, record, or stream.

Try it now. Press play, then read this text out loud and watch the words light up as you go. When you finish reading, the overlay will close by itself. [nod]

Happy presenting!`;

let settings;
let models;
let speech;
let session;
let editorWindow = null;
let overlayWindow = null;
let externalWindow = null;
let followTimer = null;
let keepAwakeId = null;
let remoteServer = null;
let directorServer = null;
let lanStatus = { remote: { running: false }, director: { running: false } };
let lastContent = null;
let lastTick = null;
let tickCount = 0;
let pendingOpen = [];

const doc = {
  pages: [DEFAULT_TEXT],
  currentPageIndex: 0,
  filePath: null,
  savedPages: [DEFAULT_TEXT],
};

// ---------------------------------------------------------------- helpers

function sendTo(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function prompterWindows() {
  return [overlayWindow, externalWindow].filter((w) => w && !w.isDestroyed());
}

function broadcastToViews(channel, payload) {
  for (const w of prompterWindows()) sendTo(w, channel, payload);
}

function docState() {
  return {
    pages: doc.pages,
    currentPageIndex: doc.currentPageIndex,
    fileName: doc.filePath ? path.basename(doc.filePath) : null,
    dirty: JSON.stringify(doc.pages) !== JSON.stringify(doc.savedPages),
  };
}

/// Send the document to the editor. Edits that came from the editor only
/// need the title and dirty flag back, so typing is never overwritten.
function pushDoc(metaOnly = false) {
  const state = docState();
  if (metaOnly) sendTo(editorWindow, 'docMeta', { fileName: state.fileName, dirty: state.dirty });
  else sendTo(editorWindow, 'doc', state);
  if (editorWindow && !editorWindow.isDestroyed()) {
    const name = doc.filePath ? path.basename(doc.filePath) : 'Untitled';
    editorWindow.setTitle(`${name}${state.dirty ? ' •' : ''} — Textream`);
    if (process.platform === 'darwin') editorWindow.setRepresentedFilename(doc.filePath || '');
  }
}

function displaysInfo() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})${d.id === primary.id ? ' — main' : ''}`,
    primary: d.id === primary.id,
  }));
}

function findDisplay(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || null;
}

function cursorDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function externalTarget() {
  const chosen = findDisplay(settings.get('externalScreenID'));
  if (chosen) return chosen;
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) || null;
}

// ---------------------------------------------------------------- windows

const COMPACT_BAR = 30;
const CONTROL_BAR = 40;

function prompterUrl(kind, capture) {
  return `app://textream/renderer/prompter/index.html?kind=${kind}${capture ? '&capture=1' : ''}`;
}

function basePrompterOptions(extra) {
  return {
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      backgroundThrottling: false,
      sandbox: true,
    },
    ...extra,
  };
}

function pinnedBounds(display) {
  const width = Math.round(settings.get('notchWidth'));
  const height = Math.round(COMPACT_BAR + settings.get('textAreaHeight') + CONTROL_BAR);
  const b = display.bounds;
  return { x: Math.round(b.x + (b.width - width) / 2), y: b.y, width, height };
}

function pinnedDisplay() {
  if (settings.get('notchDisplayMode') === 'fixedDisplay') {
    return findDisplay(settings.get('pinnedScreenID')) || screen.getPrimaryDisplay();
  }
  return cursorDisplay();
}

function createOverlay() {
  const mode = settings.get('overlayMode');
  let win;
  if (mode === 'pinned') {
    const display = pinnedDisplay();
    win = new BrowserWindow(basePrompterOptions({ ...pinnedBounds(display), focusable: false }));
    win.setAlwaysOnTop(true, 'screen-saver');
    win.__displayId = display.id;
  } else if (mode === 'floating') {
    const display = cursorDisplay();
    const width = Math.round(settings.get('notchWidth'));
    const height = Math.round(COMPACT_BAR + settings.get('textAreaHeight') + CONTROL_BAR);
    const wa = display.workArea;
    const glass = settings.get('floatingGlassEffect');
    const follow = settings.get('followCursorWhenUndocked');
    const extra = {
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + 60),
      width,
      height,
      resizable: !follow,
      minWidth: 280,
      minHeight: 140,
      focusable: !follow,
    };
    if (glass && process.platform === 'darwin') Object.assign(extra, { vibrancy: 'hud', visualEffectState: 'active' });
    if (glass && process.platform === 'win32') Object.assign(extra, { backgroundMaterial: 'acrylic', transparent: false });
    win = new BrowserWindow(basePrompterOptions(extra));
    win.setAlwaysOnTop(true, 'floating');
    if (follow) win.setIgnoreMouseEvents(true);
  } else {
    const display = findDisplay(settings.get('fullscreenScreenID')) || cursorDisplay();
    win = new BrowserWindow(basePrompterOptions({
      ...display.bounds,
      transparent: false,
      backgroundColor: '#000000',
      fullscreenable: true,
      skipTaskbar: false,
    }));
    win.once('ready-to-show', () => win.setFullScreen(true));
  }
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(!!settings.get('hideFromScreenShare'));
  win.loadURL(prompterUrl(mode, true));
  win.once('ready-to-show', () => {
    if (mode === 'fullscreen') win.show();
    else win.showInactive();
  });
  win.on('closed', () => {
    if (overlayWindow === win) {
      overlayWindow = null;
      // Closing the overlay any way at all ends the session.
      if (session.active) session.stop();
    }
  });
  overlayWindow = win;
  startFollowing();
}

function createExternal() {
  const mode = settings.get('externalDisplayMode');
  if (mode === 'off') return;
  const display = externalTarget();
  if (!display) return;
  // Don't stack a second fullscreen view on the display the overlay already fills.
  if (settings.get('overlayMode') === 'fullscreen' && overlayWindow) {
    const overlayDisplay = screen.getDisplayMatching(overlayWindow.getBounds());
    if (overlayDisplay.id === display.id) return;
  }
  const win = new BrowserWindow(basePrompterOptions({
    ...display.bounds,
    transparent: false,
    backgroundColor: '#000000',
    fullscreenable: true,
    focusable: true,
  }));
  win.setContentProtection(!!settings.get('hideFromScreenShare'));
  win.loadURL(prompterUrl(mode === 'mirror' ? 'mirror' : 'external', false));
  win.once('ready-to-show', () => {
    win.setFullScreen(true);
    win.showInactive();
  });
  win.on('closed', () => {
    if (externalWindow === win) externalWindow = null;
  });
  externalWindow = win;
}

function startFollowing() {
  stopFollowing();
  const mode = settings.get('overlayMode');
  const followMouse = mode === 'pinned' && settings.get('notchDisplayMode') === 'followMouse';
  const followCursor = mode === 'floating' && settings.get('followCursorWhenUndocked');
  if (!followMouse && !followCursor) return;
  followTimer = setInterval(() => {
    const win = overlayWindow;
    if (!win || win.isDestroyed()) return;
    if (followMouse) {
      const d = cursorDisplay();
      if (d.id !== win.__displayId) {
        win.__displayId = d.id;
        win.setBounds(pinnedBounds(d));
      }
    } else {
      const p = screen.getCursorScreenPoint();
      const [w] = win.getSize();
      win.setPosition(Math.round(p.x - w / 2), Math.round(p.y + 24));
    }
  }, followCursor ? 33 : 300);
}

function stopFollowing() {
  clearInterval(followTimer);
  followTimer = null;
}

function closeViews() {
  stopFollowing();
  for (const w of prompterWindows()) w.destroy();
  overlayWindow = null;
  externalWindow = null;
}

function applyLiveSettings(changed) {
  const style = viewStyle(settings.all());
  broadcastToViews('style', style);
  if (!session.active) return;
  if (changed.includes('remoteControl')) registerSessionShortcuts();
  if (changed.includes('hideFromScreenShare')) {
    for (const w of prompterWindows()) w.setContentProtection(!!settings.get('hideFromScreenShare'));
  }
  const reopen = ['overlayMode', 'floatingGlassEffect', 'followCursorWhenUndocked', 'fullscreenScreenID'];
  if (changed.some((k) => reopen.includes(k))) {
    reopenViews();
    return;
  }
  if (changed.some((k) => ['externalDisplayMode', 'externalScreenID'].includes(k))) {
    if (externalWindow) externalWindow.destroy();
    externalWindow = null;
    createExternal();
  }
  if (changed.some((k) => ['notchWidth', 'textAreaHeight', 'notchDisplayMode', 'pinnedScreenID'].includes(k)) && overlayWindow) {
    if (settings.get('overlayMode') === 'pinned') {
      const d = pinnedDisplay();
      overlayWindow.__displayId = d.id;
      overlayWindow.setBounds(pinnedBounds(d));
      startFollowing();
    } else if (settings.get('overlayMode') === 'floating') {
      const height = Math.round(COMPACT_BAR + settings.get('textAreaHeight') + CONTROL_BAR);
      overlayWindow.setSize(Math.round(settings.get('notchWidth')), height);
    }
  }
}

function reopenViews() {
  const keep = overlayWindow;
  overlayWindow = null; // so 'closed' doesn't end the session
  if (keep) keep.destroy();
  if (externalWindow) externalWindow.destroy();
  externalWindow = null;
  createOverlay();
  createExternal();
}

function createEditor() {
  editorWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#0e1115',
    title: 'Textream',
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
    },
  });
  editorWindow.loadURL('app://textream/renderer/editor/index.html');
  editorWindow.once('ready-to-show', () => editorWindow.show());
  editorWindow.on('close', (e) => {
    if (!confirmDiscard()) e.preventDefault();
  });
  editorWindow.on('closed', () => {
    editorWindow = null;
    if (process.platform !== 'darwin') app.quit();
  });
}

// ---------------------------------------------------------------- session

async function startReading(index = doc.currentPageIndex) {
  if (settings.get('listeningMode') !== 'classic' && process.platform === 'darwin') {
    const ok = await systemPreferences.askForMediaAccess('microphone');
    if (!ok) {
      dialog.showMessageBox(editorWindow, {
        type: 'warning',
        message: 'Textream needs microphone access',
        detail: 'Allow Textream in System Settings → Privacy & Security → Microphone, or switch to Classic mode.',
      });
      return false;
    }
  }
  return session.start(doc.pages, index);
}

function onSessionOpen() {
  closeViews();
  createOverlay();
  createExternal();
  registerSessionShortcuts();
  if (settings.get('keepScreenAwake') && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  }
}

function onSessionClose() {
  closeViews();
  globalShortcut.unregisterAll();
  if (keepAwakeId !== null) {
    powerSaveBlocker.stop(keepAwakeId);
    keepAwakeId = null;
  }
}

function registerSessionShortcuts() {
  globalShortcut.unregisterAll();
  const add = (accel, fn) => {
    try {
      globalShortcut.register(accel, fn);
    } catch (e) {
      // Another app may own it; the on-screen controls still work.
    }
  };
  add('CommandOrControl+Shift+Space', () => session.togglePause());
  add('CommandOrControl+Shift+.', () => session.stop());
  add('CommandOrControl+Shift+Right', () => session.nextPage());
  add('CommandOrControl+Shift+Left', () => session.previousPage());
  if (settings.get('remoteControl')) {
    // Bluetooth remotes in music mode (and keyboard media keys) send these.
    add('MediaPlayPause', () => remoteCommand('toggle'));
    add('MediaNextTrack', () => remoteCommand('forward'));
    add('MediaPreviousTrack', () => remoteCommand('back'));
    // Volume becomes speed only where speed matters, so word tracking
    // leaves the system volume alone.
    if (session.mode !== 'wordTracking') {
      add('VolumeUp', () => remoteCommand('faster'));
      add('VolumeDown', () => remoteCommand('slower'));
    }
  }
}

/// One entry point for remote buttons: media keys, gamepads, clickers.
/// Line moves need the overlay's layout, so the overlay turns them into
/// word counts.
function remoteCommand(cmd) {
  if (!session.active) return;
  if (cmd === 'toggle') session.togglePause();
  else if (cmd === 'faster') session.changeSpeed(0.5);
  else if (cmd === 'slower') session.changeSpeed(-0.5);
  else if (cmd === 'nextPage') session.nextPage();
  else if (cmd === 'previousPage') session.previousPage();
  else if (cmd === 'forward' || cmd === 'back') sendTo(overlayWindow, 'remote', cmd);
}

function wireSession() {
  session.on('open', onSessionOpen);
  session.on('restart', () => {
    if (!overlayWindow) onSessionOpen();
  });
  session.on('close', onSessionClose);
  session.on('content', (content) => {
    lastContent = content;
    broadcastToViews('content', content);
    sendTo(editorWindow, 'session', { active: content.active, pageIndex: content.pageIndex, directorMode: content.directorMode });
    if (content.active && !content.directorMode && doc.currentPageIndex !== content.pageIndex) {
      doc.currentPageIndex = content.pageIndex;
      pushDoc();
    }
  });
  session.on('tick', (tick) => {
    lastTick = tick;
    broadcastToViews('tick', tick);
    tickCount += 1;
    if (tickCount % 2 === 0 && lastContent) {
      const style = viewStyle(settings.all());
      if (remoteServer) remoteServer.broadcast(browserState(lastContent, tick, style));
      if (directorServer) directorServer.broadcast(directorState(lastContent, tick, style));
    }
  });
}

// ---------------------------------------------------------------- LAN

async function qr(url) {
  try {
    return await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } });
  } catch (e) {
    return null;
  }
}

async function updateServers() {
  const remoteWanted = settings.get('browserServerEnabled');
  const remotePort = settings.get('browserServerPort');
  if (remoteServer && (!remoteWanted || remoteServer.port !== remotePort)) {
    remoteServer.stop();
    remoteServer = null;
  }
  if (remoteWanted && !remoteServer) {
    const server = new RemoteServer(remotePort);
    try {
      await server.start();
      remoteServer = server;
      const url = server.url();
      lanStatus.remote = { running: true, url, mirrorUrl: `${url}/?mirror=1`, qr: await qr(url), mirrorQr: await qr(`${url}/?mirror=1`) };
    } catch (e) {
      lanStatus.remote = { running: false, error: e.message };
    }
  } else if (!remoteWanted) {
    lanStatus.remote = { running: false };
  }

  const directorWanted = settings.get('directorModeEnabled');
  const directorPort = settings.get('directorServerPort');
  if (directorServer && (!directorWanted || directorServer.port !== directorPort)) {
    directorServer.stop();
    directorServer = null;
    if (session.directorMode) session.stop();
  }
  if (directorWanted && !directorServer) {
    const server = new DirectorServer(directorPort, {
      setText: (text) => session.setTextFromDirector(text),
      updateText: (text, read) => session.updateTextFromDirector(text, read),
      stop: () => session.stop(),
    });
    try {
      await server.start();
      directorServer = server;
      const url = server.url();
      lanStatus.director = { running: true, url, qr: await qr(url) };
    } catch (e) {
      lanStatus.director = { running: false, error: e.message };
    }
  } else if (!directorWanted) {
    lanStatus.director = { running: false };
  }
  sendTo(editorWindow, 'lan', lanStatus);
}

// ---------------------------------------------------------------- files

function confirmDiscard() {
  if (!docState().dirty || TEST_MODE) return true;
  const choice = dialog.showMessageBoxSync(editorWindow, {
    type: 'warning',
    buttons: ['Save', 'Don\'t Save', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Save changes to your script?',
    detail: 'Your changes will be lost if you don\'t save them.',
  });
  if (choice === 0) return saveDocument(false);
  return choice === 1;
}

function rememberDirectory(file) {
  settings.set({ lastDocumentDirectory: path.dirname(file) });
  app.addRecentDocument(file);
}

async function openPath(file) {
  try {
    const { pages, imported } = await readDocument(file);
    doc.pages = pages;
    doc.currentPageIndex = 0;
    doc.filePath = imported ? null : file;
    doc.savedPages = imported ? [] : pages.slice();
    rememberDirectory(file);
    pushDoc();
    return true;
  } catch (e) {
    dialog.showMessageBox(editorWindow, { type: 'error', message: 'Could not open the file', detail: e.message });
    return false;
  }
}

async function openDialog() {
  if (!confirmDiscard()) return;
  const result = await dialog.showOpenDialog(editorWindow, {
    defaultPath: settings.get('lastDocumentDirectory') || undefined,
    properties: ['openFile'],
    filters: [
      { name: 'Scripts', extensions: ['textream', 'txt', 'md', 'pptx'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (!result.canceled && result.filePaths[0]) await openPath(result.filePaths[0]);
}

function saveDocument(saveAs) {
  let file = doc.filePath;
  if (saveAs || !file) {
    const choice = dialog.showSaveDialogSync(editorWindow, {
      defaultPath: path.join(settings.get('lastDocumentDirectory') || app.getPath('documents'), doc.filePath ? path.basename(doc.filePath) : 'Untitled.textream'),
      filters: [{ name: 'Textream script', extensions: ['textream'] }],
    });
    if (!choice) return false;
    file = choice.endsWith('.textream') ? choice : `${choice}.textream`;
  }
  try {
    writeDocument(file, doc.pages);
    doc.filePath = file;
    doc.savedPages = doc.pages.slice();
    rememberDirectory(file);
    pushDoc();
    return true;
  } catch (e) {
    dialog.showMessageBox(editorWindow, { type: 'error', message: 'Failed to save file', detail: e.message });
    return false;
  }
}

function newDocument() {
  if (!confirmDiscard()) return;
  doc.pages = [''];
  doc.currentPageIndex = 0;
  doc.filePath = null;
  doc.savedPages = [''];
  pushDoc();
}

/// textream://read?text=..., a .textream file, or a script file from the
/// command line or Finder/Explorer.
async function handleOpenTarget(target) {
  if (!target) return;
  if (target.startsWith('textream://')) {
    let url;
    try {
      url = new URL(target);
    } catch (e) {
      return;
    }
    const text = url.searchParams.get('text');
    if ((url.hostname === 'read' || url.pathname.replace(/\//g, '') === 'read') && text && text.trim()) {
      session.start([text], 0);
    }
    return;
  }
  if (fs.existsSync(target) && /\.(textream|txt|md|pptx)$/i.test(target)) {
    if (confirmDiscard()) await openPath(target);
  }
}

function targetsFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => a.startsWith('textream://') || /\.(textream|txt|md|pptx)$/i.test(a));
}

// ---------------------------------------------------------------- IPC

function editorState() {
  return {
    settings: settings.all(),
    doc: docState(),
    models: models.list(),
    displays: displaysInfo(),
    lan: lanStatus,
    session: lastContent ? { active: lastContent.active, pageIndex: lastContent.pageIndex, directorMode: lastContent.directorMode } : { active: false },
    platform: process.platform,
    version: app.getVersion(),
  };
}

function wireIpc() {
  ipcMain.handle('editor:state', () => editorState());
  ipcMain.on('doc:update', (e, patch) => {
    if (patch && Array.isArray(patch.pages) && patch.pages.every((p) => typeof p === 'string')) {
      doc.pages = patch.pages.length ? patch.pages : [''];
    }
    if (patch && Number.isInteger(patch.currentPageIndex)) {
      doc.currentPageIndex = Math.max(0, Math.min(patch.currentPageIndex, doc.pages.length - 1));
    }
    pushDoc(true);
  });
  ipcMain.handle('session:start', (e, index) => startReading(Number.isInteger(index) ? index : doc.currentPageIndex));
  ipcMain.on('session:stop', () => session.stop());
  ipcMain.handle('settings:set', (e, patch) => {
    settings.set(patch);
    return settings.all();
  });
  ipcMain.handle('file:open', () => openDialog());
  ipcMain.handle('file:save', () => saveDocument(false));
  ipcMain.handle('file:saveAs', () => saveDocument(true));
  ipcMain.handle('file:new', () => newDocument());
  ipcMain.handle('file:openPath', (e, file) => (typeof file === 'string' ? openPath(file) : false));
  ipcMain.handle('models:download', async (e, id) => {
    const push = () => sendTo(editorWindow, 'models', models.list());
    try {
      const p = models.download(id, push);
      push();
      await p;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      push();
    }
  });
  ipcMain.handle('models:remove', (e, id) => {
    models.remove(id);
    sendTo(editorWindow, 'models', models.list());
  });
  ipcMain.on('open-external', (e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  // Prompter views
  ipcMain.handle('prompter:init', () => ({
    content: lastContent || session.content(),
    tick: lastTick || session.snapshot(),
    style: viewStyle(settings.all()),
    settings: { selectedMicId: settings.get('selectedMicId'), remoteControl: settings.get('remoteControl') },
    platform: process.platform,
  }));
  ipcMain.on('prompter:control', (e, cmd, arg) => {
    switch (cmd) {
      case 'togglePause': session.togglePause(); break;
      case 'jumpTo': if (Number.isFinite(arg)) session.jumpTo(arg); break;
      case 'scrollBy': if (Number.isFinite(arg)) session.scrollBy(arg); break;
      case 'nextPage': session.nextPage(); break;
      case 'previousPage': session.previousPage(); break;
      case 'restartPage': session.restartPage(); break;
      case 'speed': if (Number.isFinite(arg)) session.changeSpeed(arg); break;
      case 'stop': session.stop(); break;
      case 'remote': if (typeof arg === 'string') remoteCommand(arg); break;
      default: break;
    }
  });
  ipcMain.on('prompter:audio', (e, level, samples) => {
    if (!overlayWindow || e.sender !== overlayWindow.webContents) return;
    session.onAudio(Number(level) || 0, samples instanceof Float32Array ? samples : null);
  });
  ipcMain.on('prompter:micError', (e, message) => session.onMicError(String(message || 'Microphone unavailable.')));
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => newDocument() },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => saveDocument(false) },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => saveDocument(true) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Reading',
      submenu: [
        { label: 'Start Reading', accelerator: 'CmdOrCtrl+Enter', click: () => startReading() },
        { label: 'Read All Pages', accelerator: 'CmdOrCtrl+Shift+Enter', click: () => startReading(0) },
        { label: 'Play / Pause', accelerator: 'CmdOrCtrl+Shift+Space', click: () => session.togglePause(), registerAccelerator: false },
        { label: 'Stop', accelerator: 'CmdOrCtrl+Shift+.', click: () => session.stop(), registerAccelerator: false },
      ],
    },
    { role: 'viewMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Textream on GitHub', click: () => shell.openExternal('https://github.com/f/textream') },
        { label: 'Privacy', click: () => shell.openExternal('https://textream.net/privacy.html') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- app

function serveApp() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let base = SRC;
    if (rel.startsWith('assets/')) {
      base = ASSETS;
      rel = rel.slice('assets/'.length);
    }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function allowMicrophone() {
  const { session: ses } = require('electron');
  const isApp = (url) => typeof url === 'string' && url.startsWith('app://textream/');
  ses.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'audio'));
    callback(audioOnly && isApp(details.requestingUrl || wc.getURL()));
  });
  ses.defaultSession.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && isApp(`${origin}/`));
}

app.on('second-instance', (e, argv) => {
  for (const t of targetsFromArgv(argv)) handleOpenTarget(t);
  if (editorWindow) {
    if (editorWindow.isMinimized()) editorWindow.restore();
    editorWindow.focus();
  }
});

app.on('open-file', (e, file) => {
  e.preventDefault();
  if (app.isReady()) handleOpenTarget(file);
  else pendingOpen.push(file);
});

app.on('open-url', (e, url) => {
  e.preventDefault();
  if (app.isReady()) handleOpenTarget(url);
  else pendingOpen.push(url);
});

app.whenReady().then(async () => {
  if (!TEST_MODE) {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('textream', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('textream');
    }
  }
  settings = new Settings(app.getPath('userData'));
  models = new ModelStore(path.join(app.getPath('userData'), 'models'), (url) => net.fetch(url));
  speech = process.env.TEXTREAM_FAKE_SPEECH === '1'
    ? new FakeSpeechEngine()
    : new SpeechEngine({ models, utilityProcess });
  session = new Session({ settings, speech });

  serveApp();
  allowMicrophone();
  wireSession();
  wireIpc();
  buildMenu();
  createEditor();

  settings.on('change', (changed) => {
    sendTo(editorWindow, 'settings', settings.all());
    applyLiveSettings(changed);
    if (changed.some((k) => /^(browserServer|directorMode|directorServer)/.test(k))) updateServers();
  });
  screen.on('display-added', () => sendTo(editorWindow, 'displays', displaysInfo()));
  screen.on('display-removed', () => sendTo(editorWindow, 'displays', displaysInfo()));
  await updateServers();

  for (const t of [...targetsFromArgv(process.argv), ...pendingOpen]) await handleOpenTarget(t);
  pendingOpen = [];

  if (TEST_MODE) global.textream = { session, speech, settings, doc, startReading, remoteCommand, lanStatus: () => lanStatus };
});

app.on('activate', () => {
  if (!editorWindow) createEditor();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (remoteServer) remoteServer.stop();
  if (directorServer) directorServer.stop();
  if (speech) speech.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
