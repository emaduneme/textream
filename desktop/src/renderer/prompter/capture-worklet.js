// Microphone tap. Downmixes to mono, resamples to 16 kHz for the speech
// engine and posts one chunk every 50 ms with its level (RMS x 5, clamped
// to 1, the same scale as the Mac app).

const TARGET_RATE = 16000;
const CHUNK = 800; // 50 ms at 16 kHz

class TextreamCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.prev = 0;
    // One-pole low-pass near 7 kHz so downsampling doesn't fold hiss into
    // the speech band.
    this.alpha = this.step > 1 ? 1 - Math.exp((-2 * Math.PI * 7000) / sampleRate) : 1;
    this.lp = 0;
    this.out = new Float32Array(CHUNK);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0]) return true;
    const frames = input[0].length;
    const channels = input.length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      s /= channels;
      this.lp += this.alpha * (s - this.lp);
      s = this.lp;
      // Linear interpolation between the previous and current input sample.
      while (this.pos <= 1) {
        this.out[this.fill++] = this.prev + (s - this.prev) * this.pos;
        this.pos += this.step;
        if (this.fill === CHUNK) this.flush();
      }
      this.pos -= 1;
      this.prev = s;
    }
    return true;
  }

  flush() {
    let sum = 0;
    for (let i = 0; i < CHUNK; i++) sum += this.out[i] * this.out[i];
    const level = Math.min(1, Math.sqrt(sum / CHUNK) * 5);
    const samples = this.out;
    this.port.postMessage({ level, samples }, [samples.buffer]);
    this.out = new Float32Array(CHUNK);
    this.fill = 0;
  }
}

registerProcessor('textream-capture', TextreamCapture);
