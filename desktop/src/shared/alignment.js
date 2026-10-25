'use strict';

// Port of Textream's speech-to-script alignment (SpeechRecognizer.swift and
// SpeechTextAlignment.swift). Two strategies run on every transcript: a
// character-level fuzzy scan and a word-level scan. Their results are
// combined and gated so a single bad partial result cannot jump ahead.

const {
  isLetterOrNumber,
  splitTextIntoWords,
  annotationRanges,
  advancePastAnnotations,
  isAnnotationWord,
} = require('./text');

const keepAlnum = (s) => {
  let out = '';
  for (const ch of s) if (isLetterOrNumber(ch)) out += ch;
  return out;
};

function normalize(text) {
  let out = '';
  for (const ch of String(text).toLowerCase()) {
    if (isLetterOrNumber(ch) || /\s/u.test(ch)) out += ch;
  }
  return out;
}

function editDistance(a, b) {
  const A = Array.from(a);
  const B = Array.from(b);
  const dp = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= B.length; j++) {
      const temp = dp[j];
      dp[j] = A[i - 1] === B[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = temp;
    }
  }
  return dp[B.length];
}

function isFuzzyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const la = Array.from(a).length;
  const lb = Array.from(b).length;
  const shorter = Math.min(la, lb);
  // Prefix match only for words of 3+ chars, so "or" never matches "organization".
  if (shorter >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  if (shorter >= 3 && shared >= Math.max(3, Math.floor((shorter * 3) / 5))) return true;
  if (shorter <= 2) return false;
  const dist = editDistance(a, b);
  if (shorter <= 4) return dist <= 1;
  if (shorter <= 8) return dist <= 2;
  return dist <= Math.floor(Math.max(la, lb) / 3);
}

/// When the two strategies roughly agree, average them. When they disagree,
/// prefer the further match: the word scan advances in order, so trusting it
/// lets fast reading catch up.
function bestOffset(characterResult, wordResult, agreementTolerance = 20) {
  if (Math.abs(characterResult - wordResult) <= agreementTolerance) {
    return Math.floor((characterResult + wordResult) / 2);
  }
  return Math.max(characterResult, wordResult);
}

function shouldCommit({ characterResult, wordResult, current, rawCandidate, candidate, confirmed }) {
  const bothProgressed = Math.min(characterResult, wordResult) > 0;
  const skippedAnnotation = candidate > rawCandidate;
  const smallStep = candidate - current <= 15;
  return bothProgressed || skippedAnnotation || confirmed || smallStep;
}

class WordTracker {
  constructor() {
    this.setText('');
  }

  /// Load a page. Words are collapsed to single spaces so offsets match the
  /// prompter's word items.
  setText(text, preservingCharCount = 0) {
    this.sourceText = splitTextIntoWords(text).join(' ');
    this.ranges = annotationRanges(this.sourceText);
    const start = Math.min(Math.max(0, preservingCharCount), this.sourceText.length);
    this.recognizedCharCount = this.advance(start);
    this.matchStartOffset = this.recognizedCharCount;
    this.recentMatchPositions = [];
    this.spokenAnchorPrefix = '';
    this.lastSpokenText = '';
    this.lastJumpAt = 0;
  }

  get totalCharCount() {
    return this.sourceText.length;
  }

  advance(offset) {
    return advancePastAnnotations(this.sourceText, this.ranges, offset);
  }

  /// The recognizer finished a segment (an endpoint). Its next transcript
  /// starts fresh, so matching restarts from the confirmed position.
  segmentEnded() {
    this.matchStartOffset = this.recognizedCharCount;
    this.recentMatchPositions = [];
    this.spokenAnchorPrefix = '';
    this.lastSpokenText = '';
  }

  /// Jump to a char offset (a tapped word). Returns the distance moved so the
  /// caller can decide to reset the recognizer stream on far jumps.
  jumpTo(charOffset, now = Date.now()) {
    const clamped = Math.max(0, Math.min(charOffset, this.sourceText.length));
    const target = this.advance(clamped);
    const distance = Math.abs(target - this.recognizedCharCount);
    this.recognizedCharCount = target;
    this.matchStartOffset = target;
    this.recentMatchPositions = [];
    this.spokenAnchorPrefix = this.lastSpokenText;
    this.lastJumpAt = now;
    return distance;
  }

  /// Feed the current transcript of the active segment. Returns true when
  /// the highlight moved.
  accept(fullSpoken, now = Date.now()) {
    this.lastSpokenText = fullSpoken;
    // Results computed before a jump can arrive just after it.
    if (now - this.lastJumpAt <= 300) return false;

    let spoken = fullSpoken;
    if (this.spokenAnchorPrefix) {
      let common = 0;
      const a = this.spokenAnchorPrefix;
      while (common < a.length && common < fullSpoken.length && a[common] === fullSpoken[common]) common++;
      const trimLen = Math.min(fullSpoken.length, Math.max(common, a.length - 24));
      spoken = fullSpoken.slice(trimLen);
    }
    if (!spoken) return false;

    const characterResult = this.charLevelMatch(spoken);
    const wordResult = this.wordLevelMatch(spoken);
    const best = bestOffset(characterResult, wordResult);
    const rawCandidate = Math.min(this.matchStartOffset + best, this.sourceText.length);
    const candidate = this.advance(rawCandidate);
    if (candidate <= this.recognizedCharCount) return false;

    // Require 2 of the last 3 results to agree before trusting a big jump.
    this.recentMatchPositions.push(candidate);
    if (this.recentMatchPositions.length > 3) this.recentMatchPositions.shift();
    let confirmed = false;
    if (this.recentMatchPositions.length >= 2) {
      const agree = this.recentMatchPositions.filter((p) => Math.abs(p - candidate) <= 10).length;
      confirmed = agree >= 2;
    }

    if (shouldCommit({
      characterResult,
      wordResult,
      current: this.recognizedCharCount,
      rawCandidate,
      candidate,
      confirmed,
    })) {
      this.recognizedCharCount = candidate;
      return true;
    }
    return false;
  }

  charLevelMatch(spoken) {
    const src = this.sourceText.slice(this.matchStartOffset).toLowerCase();
    const spk = normalize(spoken);
    let si = 0;
    let ri = 0;
    let lastGood = 0;

    while (si < src.length && ri < spk.length) {
      const sc = src[si];
      const rc = spk[ri];
      if (sc === '[') {
        const close = src.indexOf(']', si);
        if (close >= 0) {
          si = close + 1;
          lastGood = si;
          continue;
        }
      }
      if (!isLetterOrNumber(sc)) { si++; continue; }
      if (!isLetterOrNumber(rc)) { ri++; continue; }

      if (sc === rc) {
        si++;
        ri++;
        lastGood = si;
        continue;
      }

      // Re-sync: skip up to 5 chars in the transcript, then in the source.
      let found = false;
      const maxSkipR = Math.min(5, spk.length - ri - 1);
      for (let skip = 1; skip <= maxSkipR; skip++) {
        if (spk[ri + skip] === sc) { ri += skip; found = true; break; }
      }
      if (found) continue;
      const maxSkipS = Math.min(5, src.length - si - 1);
      for (let skip = 1; skip <= maxSkipS; skip++) {
        if (src[si + skip] === rc) { si += skip; found = true; break; }
      }
      if (found) continue;
      // A genuine mismatch: advance the transcript only.
      ri++;
    }

    while (si < src.length) {
      if (src[si] === '[' && src.indexOf(']', si) >= 0) {
        si = src.indexOf(']', si) + 1;
        lastGood = si;
      } else if (!isLetterOrNumber(src[si])) {
        si++;
        lastGood = si;
      } else {
        break;
      }
    }
    return lastGood;
  }

  wordLevelMatch(spoken) {
    const remaining = this.sourceText.slice(this.matchStartOffset);
    const sourceWords = remaining.split(' ').filter((w) => w.length);
    const spokenWords = splitTextIntoWords(spoken.toLowerCase());
    let si = 0;
    let ri = 0;
    let matched = 0;
    let inside = false;

    const beginsAnnotationAt = (i) =>
      sourceWords[i].startsWith('[') && sourceWords.slice(i).some((w) => w.includes(']'));
    const skipSourceWord = () => {
      matched += sourceWords[si].length;
      if (si < sourceWords.length - 1) matched += 1;
      si++;
    };

    while (si < sourceWords.length && ri < spokenWords.length) {
      const begins = beginsAnnotationAt(si);
      if (inside || begins || isAnnotationWord(sourceWords[si])) {
        if (begins) inside = true;
        if (sourceWords[si].includes(']')) inside = false;
        skipSourceWord();
        continue;
      }

      const srcWord = keepAlnum(sourceWords[si].toLowerCase());
      const spkWord = keepAlnum(spokenWords[ri]);

      if (srcWord === spkWord || isFuzzyMatch(srcWord, spkWord)) {
        matched += sourceWords[si].length;
        si++;
        ri++;
        if (si < sourceWords.length) matched += 1;
        continue;
      }

      // Skip up to 5 transcript words (the recognizer inserted words).
      let foundSpk = false;
      const maxSpkSkip = Math.min(5, spokenWords.length - ri - 1);
      for (let skip = 1; skip <= maxSpkSkip; skip++) {
        const next = keepAlnum(spokenWords[ri + skip]);
        if (srcWord === next || isFuzzyMatch(srcWord, next)) {
          ri += skip;
          foundSpk = true;
          break;
        }
      }
      if (foundSpk) continue;

      // Skip up to 5 source words (fast reading, recognizer missed words).
      let foundSrc = false;
      const maxSrcSkip = Math.min(5, sourceWords.length - si - 1);
      for (let skip = 1; skip <= maxSrcSkip; skip++) {
        const next = keepAlnum(sourceWords[si + skip].toLowerCase());
        if (next === spkWord || isFuzzyMatch(next, spkWord)) {
          for (let s = 0; s < skip; s++) matched += sourceWords[si + s].length + 1;
          si += skip;
          foundSrc = true;
          break;
        }
      }
      if (foundSrc) continue;

      if (!srcWord) {
        skipSourceWord();
        continue;
      }
      ri++;
    }

    // Skip trailing annotations at the end of the source.
    while (si < sourceWords.length) {
      const begins = beginsAnnotationAt(si);
      if (!(inside || begins || isAnnotationWord(sourceWords[si]))) break;
      if (begins) inside = true;
      if (sourceWords[si].includes(']')) inside = false;
      skipSourceWord();
    }
    return matched;
  }
}

module.exports = { WordTracker, isFuzzyMatch, editDistance, bestOffset, shouldCommit, normalize };
