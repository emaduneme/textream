'use strict';

// Word-tracking speech engine. Owns the utility process that runs
// sherpa-onnx and keeps the API the session needs: start, feed, pause,
// resume, resetStream, stop. Emits 'ready', 'partial', 'endpoint', 'error'.

const path = require('path');
const { EventEmitter } = require('events');

class SpeechEngine extends EventEmitter {
  constructor({ models, utilityProcess }) {
    super();
    this.models = models;
    this.utilityProcess = utilityProcess;
    this.child = null;
    this.running = false;
    this.paused = false;
  }

  ensureChild() {
    if (this.child) return this.child;
    const child = this.utilityProcess.fork(path.join(__dirname, 'speech-host.js'), [], {
      serviceName: 'Textream Speech',
      stdio: 'inherit',
    });
    child.on('message', (msg) => this.onMessage(msg));
    child.on('exit', (code) => {
      this.child = null;
      const wasLoading = this.stage === 'loading';
      this.stage = null;
      if (this.running) {
        this.running = false;
        this.emit('error', wasLoading
          ? 'Could not load the speech model. It may be damaged: remove it in Settings → Guidance and download it again.'
          : `Speech engine stopped unexpectedly (code ${code}).`);
      }
    });
    this.child = child;
    return child;
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'loading' || msg.type === 'ready') this.stage = msg.type;
    if (!this.running) return;
    if (msg.type === 'partial' && !this.paused) this.emit('partial', msg.text);
    else if (msg.type === 'endpoint') this.emit('endpoint');
    else if (msg.type === 'ready') this.emit('ready');
    else if (msg.type === 'error') this.emit('error', `Speech engine error: ${msg.message}`);
  }

  start(modelId) {
    this.running = true;
    this.paused = false;
    const files = this.models.files(modelId);
    if (!files) {
      // Let the session finish starting before it hears about the problem.
      setImmediate(() => this.emit('error', 'Word tracking needs a speech model. Download one in Settings → Speech, or switch to Classic.'));
      return;
    }
    this.ensureChild().postMessage({ type: 'start', files });
  }

  feed(samples) {
    if (!this.running || this.paused || !this.child) return;
    this.child.postMessage({ type: 'audio', samples });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.resetStream();
  }

  /// Drop the current segment. The next transcript starts from scratch.
  resetStream() {
    if (this.child && this.running) this.child.postMessage({ type: 'reset' });
    this.emit('endpoint');
  }

  stop() {
    this.running = false;
    this.paused = false;
  }

  dispose() {
    this.running = false;
    if (this.child) this.child.kill();
    this.child = null;
  }
}

/// Test double: no model or microphone. Tests push transcripts with say().
class FakeSpeechEngine extends EventEmitter {
  start() { this.running = true; setImmediate(() => this.emit('ready')); }
  feed() {}
  pause() { this.paused = true; }
  resume() { this.paused = false; this.emit('endpoint'); }
  resetStream() { this.emit('endpoint'); }
  stop() { this.running = false; }
  dispose() {}
  say(text) { if (this.running && !this.paused) this.emit('partial', text); }
  pauseSpeaking() { this.emit('endpoint'); }
}

module.exports = { SpeechEngine, FakeSpeechEngine };
