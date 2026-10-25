'use strict';

// Port of Textream's word splitting and annotation helpers
// (MarqueeTextView.swift, SpeechTextAlignment.swift, TextDirection.swift).
// Offsets are UTF-16 code units so they match String.length in every
// renderer and in the browser remote pages.

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;

function isLetterOrNumber(ch) {
  return LETTER_OR_NUMBER.test(ch);
}

function isCJKCodePoint(v) {
  return (v >= 0x4e00 && v <= 0x9fff) ||   // CJK Unified Ideographs
    (v >= 0x3400 && v <= 0x4dbf) ||        // CJK Extension A
    (v >= 0x20000 && v <= 0x2a6df) ||      // CJK Extension B
    (v >= 0xf900 && v <= 0xfaff) ||        // CJK Compatibility Ideographs
    (v >= 0x3040 && v <= 0x309f) ||        // Hiragana
    (v >= 0x30a0 && v <= 0x30ff) ||        // Katakana
    (v >= 0xac00 && v <= 0xd7af);          // Hangul Syllables
}

/// Splits text into display-ready words. CJK characters are split into
/// individual characters so the flow layout can wrap them; consecutive
/// non-CJK characters stay grouped.
function splitTextIntoWords(text) {
  const tokens = String(text || '').replace(/\n/g, ' ').split(/\s+/u).filter(Boolean);
  const result = [];
  for (const token of tokens) {
    let hasCJK = false;
    for (const ch of token) {
      if (isCJKCodePoint(ch.codePointAt(0))) { hasCJK = true; break; }
    }
    if (!hasCJK) {
      result.push(token);
      continue;
    }
    let buffer = '';
    for (const ch of token) {
      if (isCJKCodePoint(ch.codePointAt(0))) {
        if (buffer) { result.push(buffer); buffer = ''; }
        result.push(ch);
      } else {
        buffer += ch;
      }
    }
    if (buffer) result.push(buffer);
  }
  return result;
}

/// Word indices that begin a new paragraph. Consecutive and whitespace-only
/// lines collapse into a single visual separator.
function paragraphBreakWordIndices(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result = new Set();
  let wordCount = 0;
  let hasContent = false;
  let hasPendingBreak = false;
  lines.forEach((line, index) => {
    const lineWords = splitTextIntoWords(line);
    if (lineWords.length) {
      if (hasContent && hasPendingBreak) result.add(wordCount);
      wordCount += lineWords.length;
      hasContent = true;
      hasPendingBreak = false;
    }
    if (index < lines.length - 1 && hasContent) hasPendingBreak = true;
  });
  return result;
}

function annotationFlags(words) {
  const closingAtOrAfter = new Array(words.length).fill(false);
  let hasClosing = false;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].includes(']')) hasClosing = true;
    closingAtOrAfter[i] = hasClosing;
  }
  const flags = [];
  let inside = false;
  words.forEach((word, i) => {
    const begins = word.startsWith('[') && closingAtOrAfter[i];
    flags.push(inside || begins);
    if (begins) inside = true;
    if (inside && word.includes(']')) inside = false;
  });
  return flags;
}

/// Words inside square brackets like [smile], or words with no letters or
/// numbers at all (emoji, dashes).
function isAnnotationWord(word) {
  if (word.startsWith('[') && word.endsWith(']')) return true;
  for (const ch of word) if (isLetterOrNumber(ch)) return false;
  return true;
}

function annotationRanges(text) {
  const ranges = [];
  let opening = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[' && opening < 0) {
      opening = i;
    } else if (ch === ']' && opening >= 0) {
      ranges.push([opening, i + 1]);
      opening = -1;
    }
  }
  return ranges;
}

function advancePastAnnotations(text, ranges, offset) {
  let current = Math.max(0, Math.min(offset, text.length));
  let skipped = false;
  const containing = (pos) => ranges.find(([lo, hi]) => pos >= lo && pos < hi);
  while (current < text.length) {
    const inside = containing(current);
    if (inside) {
      current = inside[1];
      skipped = true;
      continue;
    }
    let next = current;
    while (next < text.length && WHITESPACE.test(text[next])) next++;
    const starting = ranges.find(([lo]) => lo === next);
    if (starting) {
      current = starting[1];
      skipped = true;
      continue;
    }
    return skipped ? next : current;
  }
  return current;
}

function isRightToLeftCodePoint(v) {
  return (v >= 0x0590 && v <= 0x08ff) ||
    (v >= 0xfb50 && v <= 0xfdff) ||
    (v >= 0xfe70 && v <= 0xfeff) ||
    (v >= 0x1e800 && v <= 0x1e95f) ||
    (v >= 0x1ee00 && v <= 0x1eeff);
}

/// Base direction from the first strong alphabetic character, ignoring
/// bracketed cues such as [pause].
function textBaseDirection(text) {
  let inside = false;
  for (const ch of String(text || '')) {
    if (ch === '[') { inside = true; continue; }
    if (ch === ']' && inside) { inside = false; continue; }
    if (inside || !/\p{Alphabetic}/u.test(ch)) continue;
    return isRightToLeftCodePoint(ch.codePointAt(0)) ? 'rtl' : 'ltr';
  }
  return 'auto';
}

/// Everything a prompter view needs to draw one page.
function buildPage(text) {
  const words = splitTextIntoWords(text);
  const flags = annotationFlags(words);
  const breaks = paragraphBreakWordIndices(text);
  const items = [];
  let offset = 0;
  words.forEach((word, i) => {
    items.push({
      word,
      charOffset: offset,
      isAnnotation: flags[i] || isAnnotationWord(word),
      paragraphBreak: breaks.has(i),
    });
    offset += word.length + 1;
  });
  const collapsed = words.join(' ');
  return {
    words,
    items,
    collapsed,
    totalCharCount: collapsed.length,
    direction: textBaseDirection(text),
  };
}

/// Fractional word index to char offset, using real word lengths.
function charOffsetForWordProgress(words, progress, totalCharCount) {
  const whole = Math.floor(progress);
  const frac = progress - whole;
  let offset = 0;
  for (let i = 0; i < Math.min(whole, words.length); i++) offset += words[i].length + 1;
  if (whole >= 0 && whole < words.length) offset += Math.floor(words[whole].length * frac);
  return Math.min(offset, totalCharCount);
}

/// Char offset back to fractional word index (for taps and scroll).
function wordProgressForCharOffset(words, charOffset) {
  let offset = 0;
  for (let i = 0; i < words.length; i++) {
    const end = offset + words[i].length;
    if (charOffset <= end) {
      return i + (charOffset - offset) / Math.max(1, words[i].length);
    }
    offset = end + 1;
  }
  return words.length;
}

module.exports = {
  isLetterOrNumber,
  isCJKCodePoint,
  splitTextIntoWords,
  paragraphBreakWordIndices,
  annotationFlags,
  isAnnotationWord,
  annotationRanges,
  advancePastAnnotations,
  textBaseDirection,
  buildPage,
  charOffsetForWordProgress,
  wordProgressForCharOffset,
};
