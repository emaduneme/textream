'use strict';

// Port of VoiceActivityDetector.swift. Levels are 0...1 (RMS x 5, clamped).

class VoiceActivityDetector {
  constructor({
    activationLevel = 0.012,
    immediateActivationLevel = 0.04,
    requiredActiveFrames = 2,
    hangoverMs = 750,
  } = {}) {
    this.activationLevel = activationLevel;
    this.immediateActivationLevel = immediateActivationLevel;
    this.requiredActiveFrames = requiredActiveFrames;
    this.hangoverMs = hangoverMs;
    this.reset();
  }

  process(level, now = Date.now()) {
    if (level >= this.immediateActivationLevel) {
      this.consecutiveActiveFrames = this.requiredActiveFrames;
      this.extend(now);
    } else if (level >= this.activationLevel) {
      this.consecutiveActiveFrames += 1;
      if (this.consecutiveActiveFrames >= this.requiredActiveFrames) this.extend(now);
    } else {
      this.consecutiveActiveFrames = 0;
    }
  }

  isActive(now = Date.now()) {
    return now < this.activeUntil;
  }

  reset() {
    this.consecutiveActiveFrames = 0;
    this.activeUntil = -Infinity;
  }

  extend(now) {
    this.activeUntil = Math.max(this.activeUntil, now + this.hangoverMs);
  }
}

module.exports = { VoiceActivityDetector };
