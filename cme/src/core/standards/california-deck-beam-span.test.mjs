import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrescriptiveDeckBeamPreset, maximumDeckBeamSpanFeet } from './california-deck-beam-span.js';

test('CRC beam table returns zero-cantilever spans for supported built-up profiles', () => {
  assert.equal(maximumDeckBeamSpanFeet('2-2x6', 6), 6.5);
  assert.equal(maximumDeckBeamSpanFeet('2-2x8', 8), 8 + 2 / 12);
  assert.equal(maximumDeckBeamSpanFeet('3-2x12', 18), 10 + 3 / 12);
  assert.equal(isPrescriptiveDeckBeamPreset('2-2x10'), true);
  assert.equal(isPrescriptiveDeckBeamPreset('4x10'), false);
});

test('intermediate tributary spans interpolate conservatively and out-of-table loads return null', () => {
  const interpolated = maximumDeckBeamSpanFeet('2-2x6', 7);
  assert.equal(interpolated, (6.5 + (6 + 1 / 12)) / 2);
  assert.equal(maximumDeckBeamSpanFeet('2-2x6', 19), null);
  assert.equal(maximumDeckBeamSpanFeet('unknown', 8), null);
});
