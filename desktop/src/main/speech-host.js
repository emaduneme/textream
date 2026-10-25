'use strict';

// Runs in an Electron utility process so model loading and decoding never
// block the UI. Receives 16 kHz mono Float32 audio and reports the current
// segment's transcript, plus an endpoint when the speaker pauses.

const SAMPLE_RATE = 16000;

let sherpa = null;
let recognizer = null;
let recognizerKey = '';
let stream = null;
let lastText = '';

function post(msg) {
  process.parentPort.postMessage(msg);
}

async function load(files) {
  if (!sherpa) sherpa = require('sherpa-onnx-node');
  const key = JSON.stringify(files);
  if (recognizer && recognizerKey === key) return;
  // sherpa-onnx aborts the process on a damaged model instead of throwing,
  // so tell the parent which stage we reached, and let the message leave
  // before parsing starts.
  post({ type: 'loading' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: true,
    // Short segments keep matching tight: a pause ends the segment and the
    // next one starts from the confirmed position.
    rule1MinTrailingSilence: 2.0,
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 15,
  });
  recognizerKey = key;
}

function newStream() {
  stream = recognizer ? recognizer.createStream() : null;
  lastText = '';
}

function onAudio(samples) {
  if (!recognizer || !stream) return;
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text.trim();
  if (text && text !== lastText) {
    lastText = text;
    post({ type: 'partial', text });
  }
  if (recognizer.isEndpoint(stream)) {
    recognizer.reset(stream);
    if (lastText) post({ type: 'endpoint' });
    lastText = '';
  }
}

async function handle(msg) {
  try {
    switch (msg.type) {
      case 'start':
        await load(msg.files);
        newStream();
        post({ type: 'ready' });
        break;
      case 'audio':
        onAudio(msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples));
        break;
      case 'reset':
        newStream();
        break;
      default:
        break;
    }
  } catch (error) {
    post({ type: 'error', message: String((error && error.message) || error) });
  }
}

// Handle messages strictly in order: audio that arrives while a model loads
// waits for it.
let queue = Promise.resolve();
process.parentPort.on('message', (event) => {
  const msg = event.data || {};
  queue = queue.then(() => handle(msg));
});
