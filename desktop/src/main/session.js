'use strict';

// The reading session: what TextreamService, SpeechRecognizer and the
// overlay's timer state do together on the Mac. Views (overlay, external
// display, remote browsers, director) only render what this emits.

const { EventEmitter } = require('events');
const { buildPage, charOffsetForWordProgress, wordProgressForCharOffset } = require('../shared/text');
const { WordTracker } = require('../shared/alignment');
const { VoiceActivityDetector } = require('../shared/vad');

const TICK_MS = 50;
const LEVEL_SLOTS = 30;
const FAR_JUMP = 500;

class Session extends EventEmitter {
  constructor({ settings, speech }) {
    super();
    this.settings = settings;
    this.speech = speech;
    this.tracker = new WordTracker();
    this.vad = new VoiceActivityDetector();
    this.timer = null;
    this.reset();

    speech.on('partial', (text) => this.onTranscript(text));
    speech.on('endpoint', () => this.tracker.segmentEnded());
    speech.on('ready', () => {
      this.speechReady = true;
      this.error = null;
    });
    speech.on('error', (message) => {
      this.speechReady = false;
      if (this.active && this.mode === 'wordTracking') this.error = message;
    });
  }

  reset() {
    this.active = false;
    this.pages = [];
    this.pageIndex = 0;
    this.page = buildPage('');
    this.mode = this.settings.get('listeningMode');
    this.wordProgress = 0;
    this.paused = false;
    this.userScrollingUntil = 0;
    this.muted = false;
    this.micOn = false;
    this.speechReady = false;
    this.levels = new Array(LEVEL_SLOTS).fill(0);
    this.error = null;
    this.startedAt = 0;
    this.countdown = 0;
    this.countdownTimer = null;
    this.doneHandled = false;
    this.dismissTimer = null;
    this.directorMode = false;
  }

  get needsMicrophone() {
    return this.mode !== 'classic';
  }

  /// A floating window that follows the pointer can't be clicked, so its
  /// pages always advance by themselves, like the Mac app.
  get followsCursor() {
    return this.settings.get('overlayMode') === 'floating' && this.settings.get('followCursorWhenUndocked');
  }

  get hasNextPage() {
    return this.nextPageIndex() >= 0;
  }

  nextPageIndex() {
    for (let i = this.pageIndex + 1; i < this.pages.length; i++) {
      if (this.pages[i].trim()) return i;
    }
    return -1;
  }

  /// Start reading. `pages` is the whole document; reading begins at
  /// `startIndex`, or the first page with text.
  start(pages, startIndex = 0, { directorMode = false } = {}) {
    const list = (pages || []).map((p) => String(p || ''));
    let index = Math.max(0, Math.min(startIndex, list.length - 1));
    if (!list[index] || !list[index].trim()) {
      index = list.findIndex((p) => p.trim());
    }
    if (index < 0) return false;

    const wasActive = this.active;
    this.stopTimers();
    this.reset();
    this.directorMode = directorMode;
    this.pages = list;
    this.active = true;
    this.mode = this.settings.get('listeningMode');
    if (directorMode) this.mode = 'wordTracking';
    this.startedAt = Date.now();
    this.loadPage(index);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (this.mode === 'wordTracking') this.speech.start(this.settings.get('speechModel'));
    this.emit(wasActive ? 'restart' : 'open');
    this.emitContent();
    return true;
  }

  loadPage(index, preservingCharCount = 0) {
    this.pageIndex = index;
    this.page = buildPage(this.pages[index]);
    this.tracker.setText(this.pages[index], preservingCharCount);
    this.wordProgress = 0;
    this.doneHandled = false;
    this.cancelCountdown();
    if (this.mode === 'wordTracking') this.speech.resetStream();
  }

  stop() {
    if (!this.active) return;
    this.stopTimers();
    this.speech.stop();
    this.active = false;
    this.emit('close');
    this.reset();
    this.emitContent();
  }

  stopTimers() {
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.dismissTimer);
    this.cancelCountdown();
  }

  // ---- progress ----

  get charCount() {
    if (this.mode === 'wordTracking') return this.tracker.recognizedCharCount;
    return charOffsetForWordProgress(this.page.words, this.wordProgress, this.page.totalCharCount);
  }

  get isListening() {
    if (!this.active || this.muted) return false;
    if (this.mode === 'classic') return !this.paused;
    if (this.mode === 'wordTracking') return this.micOn && this.speechReady;
    return this.micOn;
  }

  get isSpeaking() {
    return this.vad.isActive(Date.now());
  }

  get rawDone() {
    return this.page.totalCharCount > 0 && this.charCount >= this.page.totalCharCount;
  }

  /// What the views show as "Done". In classic and voice-activated modes the
  /// last page stays on screen, since the speaker may still be talking.
  get isDone() {
    return this.rawDone && (this.mode === 'wordTracking' || this.hasNextPage);
  }

  /// Whether the timer-driven scroll is moving right now.
  get advancing() {
    if (!this.active || this.rawDone || Date.now() < this.userScrollingUntil) return false;
    if (this.mode === 'classic') return !this.paused;
    if (this.mode === 'silencePaused') return !this.paused && this.isListening && this.isSpeaking;
    return false;
  }

  tick() {
    if (!this.active) return;
    if (this.advancing) {
      this.wordProgress = Math.min(this.page.words.length, this.wordProgress + this.settings.get('scrollSpeed') * (TICK_MS / 1000));
    }
    this.checkDone();
    this.emit('tick', this.snapshot());
  }

  checkDone() {
    const done = this.rawDone;
    if (done && !this.doneHandled) {
      this.doneHandled = true;
      if (this.mode === 'wordTracking') this.speech.pause();
      if (!this.hasNextPage) {
        // Auto-dismiss only in word tracking, like the Mac app.
        if (this.mode === 'wordTracking' && !this.directorMode) {
          this.dismissTimer = setTimeout(() => this.stop(), 1000);
        }
      } else if (this.settings.get('autoNextPage') || this.followsCursor) {
        this.startCountdown();
      }
    } else if (!done && this.doneHandled) {
      this.doneHandled = false;
      clearTimeout(this.dismissTimer);
      this.cancelCountdown();
      if (this.mode === 'wordTracking') this.speech.resume();
    }
  }

  startCountdown() {
    this.cancelCountdown();
    this.countdown = this.settings.get('autoNextPageDelay');
    if (this.countdown <= 0) {
      this.nextPage();
      return;
    }
    this.countdownTimer = setInterval(() => {
      this.countdown -= 1;
      if (this.countdown <= 0) {
        this.cancelCountdown();
        this.nextPage();
      }
    }, 1000);
  }

  cancelCountdown() {
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdown = 0;
  }

  // ---- audio and speech ----

  /// Called by the capture view at ~20 Hz with a 0...1 level, and 16 kHz
  /// mono samples when word tracking needs them.
  onAudio(level, samples) {
    if (!this.active) return;
    this.micOn = true;
    const value = this.muted ? 0 : level;
    this.levels.push(value);
    if (this.levels.length > LEVEL_SLOTS) this.levels.shift();
    this.vad.process(value, Date.now());
    if (!this.muted && samples && this.mode === 'wordTracking') this.speech.feed(samples);
  }

  onMicError(message) {
    this.micOn = false;
    if (this.active && this.needsMicrophone) this.error = message;
  }

  onTranscript(text) {
    if (!this.active || this.mode !== 'wordTracking' || this.muted) return;
    this.tracker.accept(text);
  }

  // ---- controls ----

  togglePause() {
    if (!this.active) return;
    if (this.mode === 'classic') {
      this.paused = !this.paused;
    } else {
      this.muted = !this.muted;
      if (this.mode === 'wordTracking') {
        if (this.muted) this.speech.pause();
        else this.speech.resume();
      }
      if (this.muted) this.vad.reset();
    }
    this.emit('tick', this.snapshot());
  }

  /// Tap a word.
  jumpTo(charOffset) {
    if (!this.active) return;
    if (this.mode === 'wordTracking') {
      const distance = this.tracker.jumpTo(charOffset);
      if (distance > FAR_JUMP) this.speech.resetStream();
    } else {
      this.wordProgress = wordProgressForCharOffset(this.page.words, charOffset);
    }
  }

  /// Mouse wheel or drag in timer modes. The timer holds while scrolling.
  scrollBy(deltaWords) {
    if (!this.active) return;
    if (this.mode === 'wordTracking') {
      const words = this.page.words;
      const current = wordProgressForCharOffset(words, this.tracker.recognizedCharCount);
      const target = Math.max(0, Math.min(words.length, Math.round(current + deltaWords)));
      this.jumpTo(charOffsetForWordProgress(words, target, this.page.totalCharCount));
      return;
    }
    this.wordProgress = Math.max(0, Math.min(this.page.words.length, this.wordProgress + deltaWords));
    this.userScrollingUntil = Date.now() + 600;
  }

  restartPage() {
    if (!this.active) return;
    this.loadPage(this.pageIndex);
    if (this.mode === 'wordTracking') this.speech.resume();
    this.emitContent();
  }

  nextPage() {
    const next = this.nextPageIndex();
    if (next < 0) return;
    this.goToPage(next);
  }

  previousPage() {
    for (let i = this.pageIndex - 1; i >= 0; i--) {
      if (this.pages[i].trim()) return this.goToPage(i);
    }
  }

  goToPage(index) {
    if (!this.active || index < 0 || index >= this.pages.length || !this.pages[index].trim()) return;
    clearTimeout(this.dismissTimer);
    this.loadPage(index);
    if (this.mode === 'wordTracking') this.speech.resume();
    this.emitContent();
  }

  changeSpeed(delta) {
    const next = Math.round((this.settings.get('scrollSpeed') + delta) * 2) / 2;
    this.settings.set({ scrollSpeed: next });
  }

  // ---- director ----

  setTextFromDirector(text) {
    if (!String(text || '').trim()) return;
    this.start([text], 0, { directorMode: true });
  }

  updateTextFromDirector(text, readCharCount) {
    if (!this.active || !this.directorMode) {
      this.setTextFromDirector(text);
      return;
    }
    const keep = Math.min(Math.max(0, readCharCount | 0), this.tracker.recognizedCharCount);
    this.pages = [text];
    this.page = buildPage(text);
    this.tracker.setText(text, keep);
    this.doneHandled = false;
    this.emitContent();
  }

  // ---- output ----

  content() {
    return {
      active: this.active,
      mode: this.mode,
      highlightWords: this.mode === 'wordTracking',
      pageIndex: this.pageIndex,
      pageCount: this.pages.length,
      hasNextPage: this.active && this.hasNextPage,
      hasPreviousPage: this.active && this.pages.slice(0, this.pageIndex).some((p) => p.trim()),
      items: this.page.items,
      words: this.page.words,
      totalCharCount: this.page.totalCharCount,
      direction: this.page.direction,
      directorMode: this.directorMode,
      needsMicrophone: this.active && this.needsMicrophone,
      wantsSamples: this.active && this.mode === 'wordTracking',
    };
  }

  snapshot() {
    return {
      active: this.active,
      charCount: Math.min(this.charCount, this.page.totalCharCount),
      totalCharCount: this.page.totalCharCount,
      wordProgress: this.mode === 'wordTracking'
        ? wordProgressForCharOffset(this.page.words, this.tracker.recognizedCharCount)
        : this.wordProgress,
      advancing: this.advancing,
      wordsPerSecond: this.settings.get('scrollSpeed'),
      at: Date.now(),
      isListening: this.isListening,
      muted: this.muted,
      paused: this.paused,
      levels: this.levels.slice(),
      lastSpokenText: this.mode === 'wordTracking' ? this.tracker.lastSpokenText : '',
      isDone: this.isDone,
      hasNextPage: this.active && this.hasNextPage,
      countdown: this.countdown,
      startedAt: this.startedAt,
      error: this.error,
      speechLoading: this.mode === 'wordTracking' && this.active && !this.speechReady && !this.error,
    };
  }

  emitContent() {
    this.emit('content', this.content());
    this.emit('tick', this.snapshot());
  }
}

module.exports = { Session };
