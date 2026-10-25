'use strict';

// Offline speech models for word tracking. These are sherpa-onnx streaming
// transducer models from the project's GitHub releases. Each archive holds
// one folder named after the model.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';

const CATALOG = [
  { id: 'en-20M', name: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17', label: 'English (fast, small download)', lang: 'en' },
  { id: 'en', name: 'sherpa-onnx-streaming-zipformer-en-2023-06-26', label: 'English (more accurate, larger download)', lang: 'en' },
  { id: 'es', name: 'sherpa-onnx-streaming-zipformer-es-kroko-2025-08-06', label: 'Spanish', lang: 'es' },
  { id: 'fr', name: 'sherpa-onnx-streaming-zipformer-fr-kroko-2025-08-06', label: 'French', lang: 'fr' },
  { id: 'de', name: 'sherpa-onnx-streaming-zipformer-de-kroko-2025-08-06', label: 'German', lang: 'de' },
  { id: 'zh-en', name: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20', label: 'Chinese + English', lang: 'zh' },
  { id: 'ko', name: 'sherpa-onnx-streaming-zipformer-korean-2024-06-16', label: 'Korean', lang: 'ko' },
  { id: 'ru', name: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-2025-08-16', label: 'Russian', lang: 'ru' },
];

function pick(files, pattern, preferInt8) {
  const matches = files.filter((f) => pattern.test(f)).sort();
  if (!matches.length) return null;
  const int8 = matches.filter((f) => f.includes('int8'));
  const full = matches.filter((f) => !f.includes('int8'));
  const preferred = preferInt8 ? (int8.length ? int8 : full) : (full.length ? full : int8);
  return preferred[0];
}

/// Find the transducer files in a model folder. Releases name them a little
/// differently, so match by role instead of exact names.
function resolveModelFiles(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    return null;
  }
  const encoder = pick(files, /encoder.*\.onnx$/, true);
  const decoder = pick(files, /decoder.*\.onnx$/, false);
  const joiner = pick(files, /joiner.*\.onnx$/, true);
  const tokens = files.includes('tokens.txt') ? 'tokens.txt' : null;
  if (!encoder || !decoder || !joiner || !tokens) return null;
  return {
    encoder: path.join(dir, encoder),
    decoder: path.join(dir, decoder),
    joiner: path.join(dir, joiner),
    tokens: path.join(dir, tokens),
  };
}

class ModelStore {
  constructor(root, fetchImpl) {
    this.root = root;
    this.fetch = fetchImpl;
    this.downloads = new Map();
  }

  entry(id) {
    return CATALOG.find((m) => m.id === id) || null;
  }

  dir(id) {
    const entry = this.entry(id);
    return entry ? path.join(this.root, entry.name) : null;
  }

  files(id) {
    const dir = this.dir(id);
    return dir ? resolveModelFiles(dir) : null;
  }

  list() {
    return CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      lang: m.lang,
      installed: !!this.files(m.id),
      downloading: this.downloads.has(m.id) ? this.downloads.get(m.id).progress : null,
    }));
  }

  /// Download and unpack a model. `onProgress(fraction)` reports 0...1.
  async download(id, onProgress = () => {}) {
    const entry = this.entry(id);
    if (!entry) throw new Error(`Unknown model ${id}`);
    if (this.downloads.has(id)) return this.downloads.get(id).promise;
    const state = { progress: 0 };
    const promise = this.fetchAndExtract(entry, (p) => {
      state.progress = p;
      onProgress(p);
    }).finally(() => this.downloads.delete(id));
    state.promise = promise;
    this.downloads.set(id, state);
    return promise;
  }

  async fetchAndExtract(entry, onProgress) {
    fs.mkdirSync(this.root, { recursive: true });
    const archive = path.join(this.root, `${entry.name}.tar.bz2.part`);
    const response = await this.fetch(`${RELEASES}${entry.name}.tar.bz2`);
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
    const total = Number(response.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(archive);
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (total) onProgress(Math.min(0.99, received / total));
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    onProgress(0.99);
    await extract(archive, this.root);
    fs.rmSync(archive, { force: true });
    if (!this.files(entry.id)) throw new Error('The downloaded model is missing files.');
    onProgress(1);
  }

  remove(id) {
    const dir = this.dir(id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/// Unpack with the system tar. Windows 10 and later, macOS and Linux all
/// ship a tar that reads .tar.bz2.
function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    const tar = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const child = spawn(tar, ['-xjf', archive, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack the model: ${err.trim() || code}`))));
  });
}

module.exports = { ModelStore, CATALOG, resolveModelFiles };
