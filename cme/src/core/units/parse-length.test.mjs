import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConstructionLength } from './parse-length.js';
import { formatFeetInches, formatFeetInchesFraction } from './length.js';

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`);

test('the bug that blocked the field: what the UI prints, the UI must accept', () => {
  // formatFeetInches emits typographic primes; the old parser took only ASCII,
  // so every pre-filled Apply field was rejected until it was retyped.
  for (const inches of [0, 6, 12, 18.5, 137.25, 240]) {
    const shown = formatFeetInches(inches, 0.0625);
    const readBack = parseConstructionLength(shown);
    assert.notEqual(readBack, null, `could not read back "${shown}"`);
    near(readBack, inches, 0.07);
  }
});

test('fraction formatting round-trips too', () => {
  for (const inches of [6.5, 18.75, 137.0625, 99.9375]) {
    const shown = formatFeetInchesFraction(inches);
    const readBack = parseConstructionLength(shown);
    assert.notEqual(readBack, null, `could not read back "${shown}"`);
    near(readBack, inches, 0.0626);
  }
});

test('feet and inches, however they are written', () => {
  const expected = 12 * 12 + 6;
  for (const form of [
    "12' 6\"", '12′ 6″', "12'6\"", "12' 6", '12 ft 6 in', '12ft 6in',
    "12'-6\"", '12-6', '12 feet 6 inches',
  ]) near(parseConstructionLength(form), expected, 1e-9);
});

test('fractions, the way a framer writes them', () => {
  near(parseConstructionLength('6 1/2"'), 6.5);
  near(parseConstructionLength('6-1/2"'), 6.5);
  near(parseConstructionLength('6½"'), 6.5);
  near(parseConstructionLength('1/2"'), 0.5);
  near(parseConstructionLength('12\' 6 1/2"'), 150.5);
  near(parseConstructionLength('12′ 6 1/2″'), 150.5);
  near(parseConstructionLength('6-1/2'), 6.5);        // fraction => inches
  near(parseConstructionLength('⅜"'), 0.375);
});

test('a bare number is feet, which is the long-standing convention', () => {
  near(parseConstructionLength('12'), 144);
  near(parseConstructionLength('12.5'), 150);
});

test('inches only', () => {
  near(parseConstructionLength('6"'), 6);
  near(parseConstructionLength('6 in'), 6);
  near(parseConstructionLength('6in'), 6);
  near(parseConstructionLength('6″'), 6);
});

test('metric still works', () => {
  near(parseConstructionLength('25.4mm'), 1, 1e-9);
  near(parseConstructionLength('1m'), 1000 / 25.4, 1e-9);
  near(parseConstructionLength('100cm'), 1000 / 25.4, 1e-9);
});

test('negatives, including the Unicode minus the formatter emits', () => {
  near(parseConstructionLength('-6"'), -6);
  near(parseConstructionLength('−6″'), -6);          // U+2212
  near(parseConstructionLength("-12' 6\""), -150);
});

test('rubbish is rejected rather than guessed at', () => {
  for (const bad of ['', '   ', 'abc', '12 34 56', "12' 6' 3'", 'ft', '1/0"', null, undefined]) {
    assert.equal(parseConstructionLength(bad), null, `should have rejected ${JSON.stringify(bad)}`);
  }
});

test('stray whitespace and thousands separators survive', () => {
  near(parseConstructionLength('  1,200  '), 14400);
  near(parseConstructionLength(' 12 ft '), 144);
});
