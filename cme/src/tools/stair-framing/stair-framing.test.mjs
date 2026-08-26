import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStairFraming, describeStairFramingTakeoff } from './stair-framing.js';

const stair = (overrides = {}) => ({
  id: overrides.id ?? 'stair-1',
  type: 'stair',
  dimensions: { width: 36, totalRise: 24, totalRun: 31.5, riserCount: 4, treadCount: 3, ...overrides.dimensions },
});

test('stair framing places two side stringers plus internal 2x12 PT stringers at 12 inches maximum', () => {
  const framing = deriveStairFraming(stair());
  assert.equal(framing.stringerCount, 4);
  assert.equal(framing.sideStringerCount, 2);
  assert.equal(framing.internalStringerCount, 2);
  assert.equal(framing.actualSpacingInches, 12);
  assert.equal(framing.material, '2×12 PT');
  assert.equal(framing.stringerStockLengthFeet, 8);
  assert.deepEqual(framing.ledgerStockPieces, [8]);
});

test('nonmodular stair widths tighten the layout instead of exceeding 12 inches', () => {
  const framing = deriveStairFraming(stair({ dimensions: { width: 49 } }));
  assert.equal(framing.stringerCount, 6);
  assert.equal(framing.internalStringerCount, 4);
  assert.equal(framing.actualSpacingInches, 9.8);
  assert.ok(framing.actualSpacingInches <= 12);
});

test('takeoff counts continuous stringer stock and one measured stair ledger/header', () => {
  const lines = describeStairFramingTakeoff({ objects: [stair()] });
  const stringers = lines.find((line) => line.id === 'auto:stairs:stringer:8');
  const ledger = lines.find((line) => line.id === 'auto:stairs:ledger:8');
  assert.equal(stringers.quantity, 4);
  assert.equal(stringers.description, '2×12 PT stair stringer');
  assert.equal(ledger.quantity, 1);
  assert.equal(ledger.description, '2×12 PT stair ledger / header');
});

test('a stringer longer than commercial stock remains visible as a review item', () => {
  const long = stair({ dimensions: { width: 36, totalRise: 144, totalRun: 240 } });
  const framing = deriveStairFraming(long);
  assert.equal(framing.stringerStockLengthFeet, null);
  assert.equal(framing.needsReview, true);
  const [line] = describeStairFramingTakeoff({ objects: [long] }).filter((entry) => entry.id.includes(':review:'));
  assert.equal(line.quantity, 4);
  assert.equal(line.confidence, 'review');
});
