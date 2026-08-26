import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import { BEAM_TYPE, addBeam, beamMaterialLabel, createBeam, describeTakeoff, getBeams, normalizeBeamMaterial, planBeamStock, removeBeam, updateBeam } from './beam.js';

const sequentialIds = () => { let count = 0; return (prefix) => `${prefix}-${(count += 1)}`; };
const documentWith = (...beams) => beams.reduce((document, beam) => addBeam(document, beam), createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' }));

test('a new Beam is a measured 4x6 PT construction object', () => {
  const beam = createBeam({ start: { x: 0, y: 0 }, end: { x: 36, y: 48 } }, sequentialIds());
  assert.equal(beam.type, BEAM_TYPE);
  assert.equal(beam.computed.lengthInches, 60);
  assert.equal(beamMaterialLabel(beam.material), '4×6 PT');
  assert.equal(beam.schemaVersion, 3);
});

test('Beam material supports standard presets and a custom estimator selection', () => {
  assert.equal(beamMaterialLabel(normalizeBeamMaterial({ widthInches: 4, depthInches: 10, treatment: 'PT' })), '4×10 PT');
  assert.equal(beamMaterialLabel(normalizeBeamMaterial({ preset: 'custom', customLabel: '6×12 DF #1' })), '6×12 DF #1');
  assert.equal(beamMaterialLabel(normalizeBeamMaterial({}, '3-1/2×11-7/8 LVL')), '3-1/2×11-7/8 LVL');
  assert.equal(beamMaterialLabel(normalizeBeamMaterial({ preset: '2-2x8' })), '(2) 2×8 PT');
});

test('a 20 ft 3 in Beam buys one 10 ft and one 12 ft stock piece', () => {
  const plan = planBeamStock(20 * 12 + 3);
  assert.deepEqual(plan.pieces, [10, 12]);
  assert.deepEqual(plan.byLength, [{ lengthFeet: 10, quantity: 1 }, { lengthFeet: 12, quantity: 1 }]);
  assert.equal(plan.purchasedFeet, 22);
  assert.equal(plan.wasteFeet, 1.75);
});

test('stock planning minimizes purchase length, piece count, then unbalanced cuts', () => {
  assert.deepEqual(planBeamStock(19 * 12).pieces, [20]);
  assert.deepEqual(planBeamStock(24 * 12).pieces, [12, 12]);
  assert.deepEqual(planBeamStock(8 * 12).pieces, [8]);
});

test('Takeoff aggregates Beam material by nominal size and commercial length', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createBeam({ start: { x: 0, y: 0 }, end: { x: 243, y: 0 } }, idFactory),
    createBeam({ start: { x: 0, y: 24 }, end: { x: 96, y: 24 } }, idFactory),
  );
  const lines = describeTakeoff(document);
  assert.deepEqual(lines.map((line) => [line.specification, line.quantity]).sort(), [['10 ft stock', 1], ['12 ft stock', 1], ['8 ft stock', 1]].sort());
  assert.ok(lines.every((line) => line.description === '4×6 PT beam'));
  assert.ok(lines.every((line) => line.confidence === 'review'));
});

test('built-up Beam takeoff buys each individual ply and carries the CRC table reference', () => {
  const document = documentWith(createBeam({ start: { x: 0, y: 0 }, end: { x: 96, y: 0 }, material: { preset: '2-2x8' } }, () => 'beam-built-up'));
  const [line] = describeTakeoff(document);
  assert.equal(line.description, '(2) 2×8 PT beam');
  assert.equal(line.quantity, 2);
  assert.equal(line.specification, '8 ft stock · individual plies');
  assert.equal(line.confidence, 'calculated');
});

test('each drawn Beam receives its own stock plan instead of silently sharing offcuts', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createBeam({ start: { x: 0, y: 0 }, end: { x: 96, y: 0 } }, idFactory),
    createBeam({ start: { x: 0, y: 12 }, end: { x: 96, y: 12 } }, idFactory),
    createBeam({ start: { x: 0, y: 24 }, end: { x: 96, y: 24 } }, idFactory),
  );
  assert.equal(describeTakeoff(document).find((line) => line.stockLengthFeet === 8).quantity, 3);
});

test('updating an endpoint and material remeasures the Beam and bumps its revision', () => {
  const document = documentWith(createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }, () => 'beam-1'));
  const updated = updateBeam(document, 'beam-1', { end: { x: 243, y: 0 }, material: { widthInches: 4, depthInches: 12, treatment: 'PT' } });
  const [beam] = getBeams(updated);
  assert.equal(beam.computed.lengthInches, 243);
  assert.equal(beamMaterialLabel(beam.material), '4×12 PT');
  assert.equal(beam.lifecycle.revision, 2);
  assert.deepEqual(describeTakeoff(updated).map((line) => line.specification), ['10 ft stock', '12 ft stock']);
});

test('legacy Beam geometry is remeasured and receives the default material', () => {
  const [line] = describeTakeoff(documentWith({ id: 'beam-legacy', type: 'beam', name: 'Beam', start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }));
  assert.equal(line.description, '4×6 PT beam');
  assert.equal(line.specification, '10 ft stock');
});

test('Beam document helpers preserve inputs and reject invalid geometry', () => {
  const beam = createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }, () => 'beam-1');
  const document = createProjectDocument({ id: 'project' });
  const snapshot = structuredClone(document);
  const added = addBeam(document, beam);
  assert.deepEqual(document, snapshot);
  assert.equal(getBeams(added).length, 1);
  assert.deepEqual(getBeams(removeBeam(added, beam.id)), []);
  assert.throws(() => createBeam({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }), /different/);
  assert.throws(() => updateBeam(document, 'missing', {}), /not found/);
});

test('an empty document produces no Beam material', () => {
  assert.deepEqual(describeTakeoff(createProjectDocument({ id: 'project' })), []);
});
