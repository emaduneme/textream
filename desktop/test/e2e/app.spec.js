'use strict';

// End-to-end checks against the real Electron app. Speech recognition is
// replaced by a fake engine (no model download needed); everything else,
// including microphone capture from Chromium's fake device, is real.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { test, expect, _electron } = require('@playwright/test');
const WebSocket = require('ws');
const JSZip = require('jszip');

const APP = path.join(__dirname, '..', '..');
const SHOTS = path.join(APP, 'test-results', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let app;
let editor;

async function launch() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'textream-e2e-'));
  const args = [APP, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  app = await _electron.launch({
    args,
    env: { ...process.env, TEXTREAM_TEST: '1', TEXTREAM_FAKE_SPEECH: '1', TEXTREAM_USER_DATA: userData },
  });
  editor = await app.firstWindow();
  await editor.waitForSelector('#script');
  await editor.waitForFunction(() => document.getElementById('stats').textContent.length > 0);
  await expect.poll(() => app.evaluate(() => !!global.textream)).toBe(true);
}

async function overlay() {
  for (let i = 0; i < 50; i++) {
    const win = app.windows().find((w) => w.url().includes('/prompter/'));
    if (win) {
      await win.waitForSelector('#words .w');
      return win;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('No prompter window opened');
}

const main = (fn, arg) => app.evaluate(fn, arg);
const session = () => main(() => {
  const s = global.textream.session;
  return { active: s.active, mode: s.mode, charCount: s.charCount, total: s.page.totalCharCount, pageIndex: s.pageIndex, micOn: s.micOn, levels: s.levels.slice(-5) };
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function nextMessage(ws, predicate = () => true, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a WebSocket message')), timeout);
    const onMessage = (data) => {
      const msg = JSON.parse(String(data));
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
}

test.beforeEach(async () => {
  await launch();
});

test.afterEach(async () => {
  if (app) await app.close();
  app = null;
});

test('editor opens with the welcome script and stats', async () => {
  await expect(editor.locator('h1')).toHaveText('Textream');
  await expect(editor.locator('#stats')).toContainText('words');
  await expect(editor.locator('#tabs button')).toHaveCount(5);
  await editor.screenshot({ path: path.join(SHOTS, 'editor.png') });
  for (const tab of ['Overlay', 'Type', 'Displays', 'Remote']) {
    await editor.locator('#tabs button', { hasText: tab }).click();
    await expect(editor.locator('#panels .group').first()).toBeVisible();
  }
  await editor.locator('#tabs button', { hasText: 'Type' }).click();
  await editor.screenshot({ path: path.join(SHOTS, 'editor-type-tab.png') });
});

test('word tracking without a model offers a download or Classic', async () => {
  await editor.locator('#btn-start').click();
  await expect(editor.locator('#banner')).toBeVisible();
  await expect(editor.locator('#banner-secondary')).toHaveText('Use Classic');
  await editor.locator('#banner-secondary').click();
  const view = await overlay();
  await expect.poll(async () => (await session()).mode).toBe('classic');
  await view.screenshot({ path: path.join(SHOTS, 'overlay-classic.png') });
});

test('classic mode scrolls on its own and pauses', async () => {
  await main(() => global.textream.settings.set({ listeningMode: 'classic', scrollSpeed: 8 }));
  await main(() => global.textream.startReading(0));
  const view = await overlay();
  const first = (await session()).charCount;
  await expect.poll(async () => (await session()).charCount, { timeout: 5000 }).toBeGreaterThan(first + 20);
  await view.locator('#pause').click();
  const paused = (await session()).charCount;
  await new Promise((r) => setTimeout(r, 600));
  expect((await session()).charCount).toBe(paused);
  await view.locator('#stop').click();
  await expect.poll(async () => (await session()).active).toBe(false);
});

test('word tracking follows speech, highlights words, and taps jump', async () => {
  await main(() => global.textream.settings.set({ listeningMode: 'wordTracking', overlayMode: 'floating' }));
  await main(() => global.textream.startReading(0));
  const view = await overlay();
  // The fake microphone produces a tone, so audio levels arrive.
  await expect.poll(async () => (await session()).micOn, { timeout: 8000 }).toBe(true);

  const say = (text) => main((_, t) => global.textream.speech.say(t), text);
  const words = 'welcome to textream this is your personal teleprompter that sits right below your camera'.split(' ');
  for (let i = 1; i <= words.length; i++) {
    await say(words.slice(0, i).join(' '));
    await new Promise((r) => setTimeout(r, 60));
  }
  const s = await session();
  expect(s.charCount).toBeGreaterThan('Welcome to Textream! This is your personal teleprompter that sits right below your'.length - 2);
  await expect(view.locator('.w.cur')).toHaveCount(1);
  await view.screenshot({ path: path.join(SHOTS, 'overlay-word-tracking.png') });

  // Tap a later word: tracking jumps there.
  const target = view.locator('.w', { hasText: /^private\.? $/ }).first();
  await target.click();
  await expect.poll(async () => (await session()).charCount).toBeGreaterThan(s.charCount + 50);
  await main(() => global.textream.session.stop());
});

test('pages advance and the session reports the page', async () => {
  await main(() => {
    const t = global.textream;
    t.settings.set({ listeningMode: 'classic', scrollSpeed: 8, autoNextPage: true, autoNextPageDelay: 0 });
    t.doc.pages = ['one two three', 'four five six'];
  });
  await main(() => global.textream.startReading(0));
  await overlay();
  await expect.poll(async () => (await session()).pageIndex, { timeout: 8000 }).toBe(1);
  await main(() => global.textream.session.stop());
});

test('remote buttons pause, move by line, change speed, and work as a gamepad', async () => {
  await main(() => global.textream.settings.set({ listeningMode: 'classic', scrollSpeed: 3 }));
  await main(() => global.textream.startReading(0));
  const view = await overlay();
  const state = () => main(() => ({ paused: global.textream.session.paused, charCount: global.textream.session.charCount, speed: global.textream.settings.get('scrollSpeed') }));

  // Music mode: media keys arrive as remote commands.
  await main(() => global.textream.remoteCommand('toggle'));
  expect((await state()).paused).toBe(true);
  const before = (await state()).charCount;
  await main(() => global.textream.remoteCommand('forward'));
  await expect.poll(async () => (await state()).charCount).toBeGreaterThan(before + 10);
  await main(() => global.textream.remoteCommand('faster'));
  expect((await state()).speed).toBe(3.5);

  // Game mode: a fake gamepad. Press A to resume, push the stick down to slow.
  await view.evaluate(() => {
    const pad = { index: 0, connected: true, axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
    window.__pad = pad;
    navigator.getGamepads = () => [pad];
  });
  await view.evaluate(() => { window.__pad.buttons[0].pressed = true; });
  await expect.poll(async () => (await state()).paused).toBe(false);
  await view.evaluate(() => { window.__pad.buttons[0].pressed = false; window.__pad.axes = [0, 1]; });
  await expect.poll(async () => (await state()).speed).toBeLessThan(3.5);
  await view.evaluate(() => { window.__pad.axes = [0, 0]; });
  await main(() => global.textream.session.stop());
});

test('fullscreen mode fills the display', async () => {
  await main(() => global.textream.settings.set({ listeningMode: 'classic', overlayMode: 'fullscreen' }));
  await main(() => global.textream.startReading(0));
  const view = await overlay();
  await expect(view.locator('body')).toHaveClass(/big/);
  await new Promise((r) => setTimeout(r, 800));
  await view.screenshot({ path: path.join(SHOTS, 'fullscreen.png') });
  // Esc closes the window mid-keypress, so the press itself may report a closed target.
  await view.keyboard.press('Escape').catch(() => {});
  await expect.poll(async () => (await session()).active).toBe(false);
});

test('remote connection serves the viewer and streams state', async () => {
  await main(() => global.textream.settings.set({ listeningMode: 'classic', browserServerEnabled: true, browserServerPort: 17373 }));
  await expect.poll(async () => main(() => global.textream.lanStatus().remote.running)).toBe(true);
  const page = await get('http://127.0.0.1:17373/');
  expect(page.status).toBe(200);
  expect(page.body).toContain('const WSP=17374');
  const ws = new WebSocket('ws://127.0.0.1:17374');
  await new Promise((r) => ws.on('open', r));
  await main(() => global.textream.startReading(0));
  const state = await nextMessage(ws, (m) => m.isActive);
  expect(state.words[0]).toBe('Welcome');
  expect(state.highlightWords).toBe(false);
  ws.close();
  await editor.locator('#tabs button', { hasText: 'Remote' }).click();
  await expect(editor.locator('.qr img').first()).toBeVisible();
  await editor.screenshot({ path: path.join(SHOTS, 'editor-remote-tab.png') });

  // The real remote page renders the live prompter.
  await main(({ BrowserWindow }) => {
    const w = new BrowserWindow({ width: 900, height: 600 });
    w.loadURL('http://127.0.0.1:17373/?mirror=1');
  });
  let remoteView;
  await expect.poll(() => {
    remoteView = app.windows().find((w) => w.url().startsWith('http://127.0.0.1:17373'));
    return !!remoteView;
  }).toBe(true);
  await expect(remoteView.locator('#text-container span').first()).toHaveText('Welcome ');
  await expect(remoteView.locator('body')).toHaveClass(/mirrored/);
  await remoteView.screenshot({ path: path.join(SHOTS, 'remote-mirrored.png') });
  await remoteView.close();
  await main(() => global.textream.session.stop());
});

test('director mode drives the session over the documented protocol', async () => {
  await main(() => global.textream.settings.set({ directorModeEnabled: true, directorServerPort: 17575 }));
  await expect.poll(async () => main(() => global.textream.lanStatus().director.running)).toBe(true);
  await expect(editor.locator('#director-cover')).toBeVisible();
  const page = await get('http://127.0.0.1:17575/');
  const token = page.body.match(/AUTH_TOKEN='([0-9a-f]{64})'/)[1];

  // Unauthenticated sockets are closed.
  const bad = new WebSocket('ws://127.0.0.1:17576');
  await new Promise((r) => bad.on('open', r));
  bad.send(JSON.stringify({ type: 'setText', text: 'nope' }));
  await new Promise((r) => bad.on('close', r));
  expect((await session()).active).toBe(false);

  const ws = new WebSocket('ws://127.0.0.1:17576');
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'auth', text: token }));
  ws.send(JSON.stringify({ type: 'setText', text: 'Hello everyone, welcome to the show.' }));
  const state = await nextMessage(ws, (m) => m.isActive);
  expect(state.words).toEqual(['Hello', 'everyone,', 'welcome', 'to', 'the', 'show.']);
  await main(() => global.textream.speech.say('hello everyone'));
  const progressed = await nextMessage(ws, (m) => m.highlightedCharCount > 10);
  ws.send(JSON.stringify({ type: 'updateText', text: 'Hello everyone, and goodbye.', readCharCount: progressed.highlightedCharCount }));
  const updated = await nextMessage(ws, (m) => m.words.includes('goodbye.'));
  expect(updated.highlightedCharCount).toBe(progressed.highlightedCharCount);
  ws.send(JSON.stringify({ type: 'stop' }));
  await expect.poll(async () => (await session()).active).toBe(false);
  await editor.screenshot({ path: path.join(SHOTS, 'editor-director.png') });
  ws.close();
});

test('opens .textream files and imports PowerPoint notes in slide order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'textream-files-'));
  const scriptFile = path.join(dir, 'show.textream');
  fs.writeFileSync(scriptFile, JSON.stringify(['First page', 'Second page']));
  await editor.evaluate((p) => window.textream.openPath(p), scriptFile);
  await expect(editor.locator('#page-list li')).toHaveCount(2);
  await expect(editor.locator('#file-name')).toHaveText('show.textream');

  // Slide 1 uses notesSlide2 and slide 2 uses notesSlide1: order must follow the deck.
  const zip = new JSZip();
  const notes = (text) => `<?xml version="1.0"?><p:notes xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>`
    + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>`
    + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
    + `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>`
    + `</p:spTree></p:cSld></p:notes>`;
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide2.xml"/></Relationships>');
  zip.file('ppt/slides/_rels/slide2.xml.rels', '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>');
  zip.file('ppt/notesSlides/notesSlide1.xml', notes('Second slide notes &amp; more'));
  zip.file('ppt/notesSlides/notesSlide2.xml', notes('Opening notes'));
  const pptx = path.join(dir, 'deck.pptx');
  fs.writeFileSync(pptx, await zip.generateAsync({ type: 'nodebuffer' }));
  await editor.evaluate((p) => window.textream.openPath(p), pptx);
  await expect(editor.locator('#page-list li')).toHaveCount(2);
  await expect(editor.locator('#script')).toHaveValue('Opening notes');
  await editor.locator('#page-list li').nth(1).locator('button.page').click();
  await expect(editor.locator('#script')).toHaveValue('Second slide notes & more');
});
