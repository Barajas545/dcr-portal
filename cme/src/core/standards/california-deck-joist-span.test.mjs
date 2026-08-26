import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumJoistSpan, validateJoistBays } from './california-deck-joist-span.js';

test('CRC 2025 reference distinguishes size, layout and Central Coast lumber groups', () => {
  assert.equal(maximumJoistSpan({ size: '2×6 PT', spacingInches: 16 }).maximumInches, 100);
  assert.equal(maximumJoistSpan({ size: '2x10', spacingInches: 12 }).maximumInches, 188);
  assert.equal(maximumJoistSpan({ size: '2×8 Redwood', spacingInches: 16, speciesGroup: 'redwood' }).maximumInches, 127);
});

test('a continuous joist is validated bay by bay rather than by overall board length', () => {
  const result = validateJoistBays({
    size: '2×6 PT', spacingInches: 16,
    bays: [{ lengthInches: 72 }, { lengthInches: 72 }, { lengthInches: 72 }],
  });
  assert.equal(result.valid, true, 'an 18 ft continuous board may have three valid 6 ft supported bays');
  assert.equal(result.longestSpanInches, 72);
});

test('an over-span bay remains an explicit invalid result', () => {
  const result = validateJoistBays({ size: '2×6 PT', spacingInches: 16, bays: [{ lengthInches: 101 }] });
  assert.equal(result.valid, false);
  assert.equal(result.status, 'invalid');
});
