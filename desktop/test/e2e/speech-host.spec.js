'use strict';

// The real speech engine, not the fake. No model can be downloaded in CI,
// so this plants damaged model files: the native addon must load inside
// Electron's utility process, reach the model-loading stage, and the app
// must turn sherpa-onnx's abort into a readable error instead of crashing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect, _electron } = require('@playwright/test');

const APP = path.join(__dirname, '..', '..');

test('native speech host loads and reports a damaged model', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'textream-speech-'));
  const dir = path.join(userData, 'models', 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt']) {
    fs.writeFileSync(path.join(dir, f), 'not a model');
  }
  const args = [APP, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const app = await _electron.launch({ args, env: { ...process.env, TEXTREAM_TEST: '1', TEXTREAM_USER_DATA: userData } });
  try {
    await app.firstWindow();
    await expect.poll(() => app.evaluate(() => !!global.textream)).toBe(true);
    await app.evaluate(() => global.textream.settings.set({ listeningMode: 'wordTracking' }));
    await app.evaluate(() => global.textream.startReading(0));
    await expect.poll(() => app.evaluate(() => global.textream.session.error), { timeout: 15000 })
      .toContain('Could not load the speech model');
    // The app itself is still alive and can stop the session.
    await app.evaluate(() => global.textream.session.stop());
    expect(await app.evaluate(() => global.textream.session.active)).toBe(false);
  } finally {
    await app.close();
  }
});
