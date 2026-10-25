'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const text = require('../../src/shared/text');

test('splits on whitespace and splits CJK into characters', () => {
  assert.deepEqual(text.splitTextIntoWords('Hello  world\nagain'), ['Hello', 'world', 'again']);
  assert.deepEqual(text.splitTextIntoWords('AB你好CD'), ['AB', '你', '好', 'CD']);
  assert.deepEqual(text.splitTextIntoWords('   '), []);
});

test('paragraph breaks collapse blank lines', () => {
  const breaks = text.paragraphBreakWordIndices('one two\n\n\nthree\nfour');
  assert.deepEqual([...breaks].sort(), [2, 3]);
});

test('annotation flags cover multi-word cues', () => {
  const words = ['Hi', '[look', 'at', 'camera]', 'now'];
  assert.deepEqual(text.annotationFlags(words), [false, true, true, true, false]);
  // An opening bracket with no closing bracket is not a cue.
  assert.deepEqual(text.annotationFlags(['[oops', 'go']), [false, false]);
});

test('emoji and punctuation-only words are annotations', () => {
  assert.equal(text.isAnnotationWord('🎬'), true);
  assert.equal(text.isAnnotationWord('—'), true);
  assert.equal(text.isAnnotationWord('[pause]'), true);
  assert.equal(text.isAnnotationWord('hello'), false);
});

test('advancePastAnnotations skips cues at and after the offset', () => {
  const s = 'Hello [pause] world';
  const ranges = text.annotationRanges(s);
  assert.deepEqual(ranges, [[6, 13]]);
  // Lands on the next spoken word, past the cue and its trailing space.
  assert.equal(text.advancePastAnnotations(s, ranges, 5), 14);
  assert.equal(text.advancePastAnnotations(s, ranges, 8), 14);
  assert.equal(text.advancePastAnnotations(s, ranges, 0), 0);
  const leading = '[smile] Hi';
  assert.equal(text.advancePastAnnotations(leading, text.annotationRanges(leading), 0), 8);
});

test('base direction ignores cues', () => {
  assert.equal(text.textBaseDirection('[pause] שלום'), 'rtl');
  assert.equal(text.textBaseDirection('[مرحبا] hello'), 'ltr');
  assert.equal(text.textBaseDirection('123 !!'), 'auto');
});

test('buildPage offsets match the collapsed text', () => {
  const page = text.buildPage('Hello  big\n\nworld [pause]');
  assert.equal(page.collapsed, 'Hello big world [pause]');
  assert.equal(page.totalCharCount, page.collapsed.length);
  for (const item of page.items) {
    assert.equal(page.collapsed.substr(item.charOffset, item.word.length), item.word);
  }
  assert.equal(page.items[2].paragraphBreak, true);
  assert.equal(page.items[3].isAnnotation, true);
});

test('word progress and char offsets round-trip', () => {
  const words = ['one', 'three', 'go'];
  const total = 'one three go'.length;
  assert.equal(text.charOffsetForWordProgress(words, 0, total), 0);
  assert.equal(text.charOffsetForWordProgress(words, 1, total), 4);
  assert.equal(text.charOffsetForWordProgress(words, 1.5, total), 6);
  assert.equal(text.charOffsetForWordProgress(words, 99, total), total);
  assert.equal(text.wordProgressForCharOffset(words, 4), 1);
  assert.equal(text.wordProgressForCharOffset(words, total + 5), 3);
});
