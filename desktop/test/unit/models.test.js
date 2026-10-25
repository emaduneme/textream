'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ModelStore, CATALOG, resolveModelFiles } = require('../../src/main/models');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'textream-models-'));

test('picks int8 encoder and joiner with the full decoder', () => {
  const dir = tmp();
  for (const f of [
    'encoder-epoch-99-avg-1.onnx', 'encoder-epoch-99-avg-1.int8.onnx',
    'decoder-epoch-99-avg-1.onnx', 'decoder-epoch-99-avg-1.int8.onnx',
    'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt', 'README.md',
  ]) fs.writeFileSync(path.join(dir, f), 'x');
  const files = resolveModelFiles(dir);
  assert.equal(path.basename(files.encoder), 'encoder-epoch-99-avg-1.int8.onnx');
  assert.equal(path.basename(files.decoder), 'decoder-epoch-99-avg-1.onnx');
  assert.equal(path.basename(files.joiner), 'joiner-epoch-99-avg-1.int8.onnx');
});

test('a folder missing tokens is not a model', () => {
  const dir = tmp();
  for (const f of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.equal(resolveModelFiles(dir), null);
});

test('downloads, reports progress, unpacks and removes a model', async () => {
  const entry = CATALOG[0];
  // Build a real .tar.bz2 shaped like a sherpa-onnx release.
  const src = tmp();
  const inner = path.join(src, entry.name);
  fs.mkdirSync(inner);
  for (const f of ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt']) {
    fs.writeFileSync(path.join(inner, f), crypto.randomBytes(64 * 1024));
  }
  const archive = path.join(src, 'model.tar.bz2');
  execFileSync('tar', ['-cjf', archive, '-C', src, entry.name]);
  const body = fs.readFileSync(archive);

  const requested = [];
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    res.writeHead(200, { 'Content-Length': body.length });
    // Send in pieces so progress has steps.
    let i = 0;
    const pump = () => {
      if (i >= body.length) return res.end();
      res.write(body.subarray(i, i + 4096));
      i += 4096;
      setImmediate(pump);
    };
    pump();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const fetchVia = (url) => fetch(`http://127.0.0.1:${port}/${url.split('/').pop()}`);

  const root = tmp();
  const store = new ModelStore(root, fetchVia);
  assert.equal(store.list()[0].installed, false);
  const progress = [];
  await store.download(entry.id, (p) => progress.push(p));
  server.close();

  assert.deepEqual(requested, [`/${entry.name}.tar.bz2`]);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.some((p) => p > 0 && p < 0.99), 'reports partial progress');
  assert.equal(store.list()[0].installed, true);
  assert.ok(store.files(entry.id));
  assert.equal(fs.readdirSync(root).some((f) => f.endsWith('.part')), false);
  store.remove(entry.id);
  assert.equal(store.list()[0].installed, false);
});

test('a failed download leaves nothing installed', async () => {
  const store = new ModelStore(tmp(), async () => ({ ok: false, status: 404 }));
  await assert.rejects(store.download(CATALOG[0].id), /HTTP 404/);
  assert.equal(store.list()[0].installed, false);
  assert.equal(store.list()[0].downloading, null);
});
