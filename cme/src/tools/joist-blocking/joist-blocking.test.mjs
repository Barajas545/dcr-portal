import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../../core/document/project-document.js';
import { addBeam, createBeam } from '../beam/beam.js';
import { addJoist, createJoist } from '../joist-group/joist-group.js';
import { addManualBlockingRow, deriveJoistBlockingRows, describeJoistBlockingTakeoff, moveManualBlockingRow, removeManualBlockingRow, restoreAutomaticBlockingRows, setJoistBlockingMaterial, suppressAutomaticBlockingRow } from './joist-blocking.js';

function blockingDocument() {
  let document = createProjectDocument({ id: 'blocking-project' });
  document = addBeam(document, { ...createBeam({ start: { x: 0, y: 60 }, end: { x: 48, y: 60 } }, () => 'beam-1'), settings: { framingSystem: 'bottom' } });
  for (let index = 0; index < 4; index += 1) {
    const x = index * 16;
    document = addJoist(document, createJoist({
      start: { x, y: 0 }, end: { x, y: 180 }, size: '2×6 PT',
      layout: {
        fieldId: 'field-1', boundaryId: 'deck-1', spacingInches: 16,
        bays: [
          { start: { x, y: 0 }, end: { x, y: 60 }, lengthInches: 60, startSupportId: 'ledger', endSupportId: 'beam-1:0' },
          { start: { x, y: 60 }, end: { x, y: 180 }, lengthInches: 120, startSupportId: 'beam-1:0', endSupportId: 'rim' },
        ],
      },
    }, () => `joist-${index}`));
  }
  return document;
}

test('automatic blocking is fixed over Bottom Beams and centered in bays over eight feet', () => {
  const rows = deriveJoistBlockingRows(blockingDocument());
  const beam = rows.find((row) => row.kind === 'bottom-beam');
  const span = rows.find((row) => row.kind === 'span');
  assert.equal(beam.segments.length, 3);
  assert.equal(span.segments.length, 3);
  assert.ok(beam.segments.every((segment) => Math.abs((segment.start.y + segment.end.y) / 2 - 60) <= .75));
  assert.ok(span.segments.every((segment) => Math.abs((segment.start.y + segment.end.y) / 2 - 120) <= .75));
  assert.ok(beam.segments.every((segment) => segment.cutLengthInches === 14.5));
});

test('manual blocking rows can be added, moved, and removed without becoming loose lines', () => {
  const original = blockingDocument();
  const added = addManualBlockingRow(original, 'field-1', { x: 20, y: 30 }, () => 'manual-row');
  assert.equal(added.row.segments.length, 3);
  assert.equal(deriveJoistBlockingRows(added.document).filter((row) => row.kind === 'manual').length, 1);
  const moved = moveManualBlockingRow(added.document, 'manual-row', { x: 20, y: 45 });
  assert.ok(moved.row.segments.every((segment) => Math.abs((segment.start.y + segment.end.y) / 2 - 45) <= .75));
  assert.equal(deriveJoistBlockingRows(removeManualBlockingRow(moved.document, 'manual-row')).filter((row) => row.kind === 'manual').length, 0);
});

test('automatic rows may be suppressed and restored explicitly', () => {
  const document = blockingDocument();
  const row = deriveJoistBlockingRows(document).find((entry) => entry.kind === 'span');
  const suppressed = suppressAutomaticBlockingRow(document, row.id);
  assert.equal(deriveJoistBlockingRows(suppressed).some((entry) => entry.id === row.id), false);
  assert.equal(deriveJoistBlockingRows(suppressed, { includeSuppressed: true }).find((entry) => entry.id === row.id).suppressed, true);
  const restored = restoreAutomaticBlockingRows(suppressed, 'field-1');
  assert.equal(deriveJoistBlockingRows(restored).some((entry) => entry.id === row.id), true);
});

test('Takeoff packs blocking cuts into 16 foot joist material', () => {
  const line = describeJoistBlockingTakeoff(blockingDocument())[0];
  assert.equal(line.description, '2×6 PT joist blocking');
  assert.equal(line.stockLengthFeet, 16);
  assert.equal(line.quantity, 1);
  assert.match(line.specification, /6 blocks/);
});

test('blocking inherits one dominant Joist Field material and changes only through an explicit field override', () => {
  const document = blockingDocument();
  const mixed = {
    ...document,
    objects: document.objects.map((object) => object.id === 'joist-3' ? { ...object, size: '2×10 PT' } : object),
  };
  const inherited = describeJoistBlockingTakeoff(mixed);
  assert.equal(inherited.length, 1, 'one residual joist size cannot split Blocking Takeoff');
  assert.equal(inherited[0].description, '2×6 PT joist blocking');
  const overridden = setJoistBlockingMaterial(mixed, 'field-1', { size: '2×10 PT', material: { speciesGroup: 'douglas-fir-larch', treatment: 'PT' } });
  const explicit = describeJoistBlockingTakeoff(overridden);
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].description, '2×10 PT joist blocking');
});
