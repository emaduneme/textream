'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WordTracker, isFuzzyMatch, bestOffset } = require('../../src/shared/alignment');
const { VoiceActivityDetector } = require('../../src/shared/vad');

const SCRIPT = 'Hi, and welcome back. Today I want to walk you through three things I wish I had known.';

// Simulates a streaming recognizer: each partial grows by one word.
function speak(tracker, phrase, start = 10_000) {
  const words = phrase.split(' ');
  let t = start;
  for (let i = 1; i <= words.length; i++) {
    t += 200;
    tracker.accept(words.slice(0, i).join(' '), t);
  }
  return t;
}

test('fuzzy matching follows Textream thresholds', () => {
  assert.equal(isFuzzyMatch('welcome', 'welcom'), true);
  assert.equal(isFuzzyMatch('or', 'organization'), false);
  assert.equal(isFuzzyMatch('to', 'too'), false);
  assert.equal(isFuzzyMatch('things', 'thinks'), true);
  assert.equal(isFuzzyMatch('camera', 'banana'), false);
});

test('bestOffset averages agreement and prefers the further match', () => {
  assert.equal(bestOffset(30, 40), 35);
  assert.equal(bestOffset(10, 80), 80);
});

test('tracks words as they are spoken', () => {
  const t = new WordTracker();
  t.setText(SCRIPT);
  speak(t, 'hi and welcome back');
  assert.ok(t.recognizedCharCount >= 'Hi, and welcome back.'.length - 1, `got ${t.recognizedCharCount}`);
  assert.ok(t.recognizedCharCount <= 'Hi, and welcome back. '.length);
});

test('survives recognizer substitutions', () => {
  const t = new WordTracker();
  t.setText(SCRIPT);
  speak(t, 'hi and welcome back today i want to walk you thru three thinks');
  const target = SCRIPT.indexOf('things');
  assert.ok(t.recognizedCharCount >= target, `got ${t.recognizedCharCount}, want >= ${target}`);
});

test('off-script talk drifts at most a sentence, as on the Mac', () => {
  const t = new WordTracker();
  t.setText(SCRIPT);
  speak(t, 'sorry let me grab some water real quick');
  assert.ok(t.recognizedCharCount <= SCRIPT.indexOf('Today'), `got ${t.recognizedCharCount}`);
});

test('segments continue from the confirmed position', () => {
  const t = new WordTracker();
  t.setText(SCRIPT);
  let now = speak(t, 'hi and welcome back');
  t.segmentEnded();
  speak(t, 'today i want to walk', now + 1000);
  assert.ok(t.recognizedCharCount >= SCRIPT.indexOf('walk'), `got ${t.recognizedCharCount}`);
});

test('skips cues automatically', () => {
  const t = new WordTracker();
  t.setText('Hello there [pause] my friend');
  speak(t, 'hello there');
  assert.ok(t.recognizedCharCount >= 'Hello there [pause]'.length, `got ${t.recognizedCharCount}`);
});

test('a leading cue is skipped before reading starts', () => {
  const t = new WordTracker();
  t.setText('[smile] Hello');
  assert.equal(t.recognizedCharCount, '[smile] '.length);
  assert.equal(t.sourceText.slice(t.recognizedCharCount), 'Hello');
});

test('jumps anchor matching past the pre-jump transcript', () => {
  const t = new WordTracker();
  t.setText(SCRIPT);
  const now = speak(t, 'hi and welcome back');
  const target = SCRIPT.indexOf('three');
  t.jumpTo(target, now);
  // The same transcript keeps growing: only the new words count.
  t.accept('hi and welcome back three things', now + 500);
  t.accept('hi and welcome back three things i wish', now + 700);
  assert.ok(t.recognizedCharCount >= SCRIPT.indexOf('wish'), `got ${t.recognizedCharCount}`);
});

test('preserving char count keeps director edits stable', () => {
  const t = new WordTracker();
  t.setText('one two three four', 8);
  assert.equal(t.recognizedCharCount, 8);
  assert.equal(t.matchStartOffset, 8);
});

test('voice activity needs two quiet-level frames or one loud frame', () => {
  const vad = new VoiceActivityDetector();
  vad.process(0.02, 0);
  assert.equal(vad.isActive(1), false);
  vad.process(0.02, 50);
  assert.equal(vad.isActive(60), true);
  assert.equal(vad.isActive(900), false);
  vad.process(0.5, 1000);
  assert.equal(vad.isActive(1001), true);
  vad.process(0, 1100);
  assert.equal(vad.isActive(1700), true);
  assert.equal(vad.isActive(1800), false);
});
