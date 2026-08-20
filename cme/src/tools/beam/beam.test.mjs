import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import { BEAM_TYPE, addBeam, createBeam, describeTakeoff, getBeams, removeBeam, updateBeam } from './beam.js';

const sequentialIds = () => {
  let count = 0;
  return (prefix) => `${prefix}-${(count += 1)}`;
};

const documentWith = (...beams) => beams.reduce((document, beam) => addBeam(document, beam), createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' }));

test('a beam is a straight run measured in inches', () => {
  const beam = createBeam({ start: { x: 0, y: 0 }, end: { x: 36, y: 48 }, size: '2x10' }, sequentialIds());
  assert.equal(beam.type, BEAM_TYPE);
  assert.equal(beam.id, 'beam-1');
  assert.equal(beam.name, 'Beam');
  assert.equal(beam.computed.lengthInches, 60);
  assert.equal(beam.size, '2x10');
  assert.deepEqual(beam.lifecycle, { phase: 'established', revision: 1 });
});

test('size is a free-text label, never derived from the span', () => {
  const long = createBeam({ start: { x: 0, y: 0 }, end: { x: 240, y: 0 }, size: '2x6' });
  const short = createBeam({ start: { x: 0, y: 0 }, end: { x: 12, y: 0 }, size: '3-1/2x11-7/8 LVL' });
  assert.equal(long.size, '2x6');
  assert.equal(short.size, '3-1/2x11-7/8 LVL');
});

test('the takeoff is one piece per beam drawn', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }, idFactory),
    createBeam({ start: { x: 0, y: 24 }, end: { x: 0, y: 96 } }, idFactory),
  );
  const [line] = describeTakeoff(document);
  assert.equal(line.kind, 'count');
  assert.equal(line.id, 'auto:framing:beam');
  assert.equal(line.category, 'framing');
  assert.equal(line.description, 'Beam (size to span)');
  assert.equal(line.quantity, 2, 'two beams drawn is two beams ordered');
  assert.deepEqual(line.sourceObjectIds, ['beam-1', 'beam-2']);
  assert.equal(line.specification, '2 drawn · 16 lf total', 'the spans tell the estimator which size to pull');
});

test('beams are counted as pieces, never bought as lineal feet off a stock length', () => {
  /* Three 8 ft beams need three boards. Priced as lineal feet off 16 ft stock
     they came to two, because that model assumes one beam's offcut becomes the
     next beam - which is not how a beam is cut. */
  const idFactory = sequentialIds();
  const document = documentWith(
    createBeam({ start: { x: 0, y: 0 }, end: { x: 96, y: 0 } }, idFactory),
    createBeam({ start: { x: 0, y: 12 }, end: { x: 96, y: 12 } }, idFactory),
    createBeam({ start: { x: 0, y: 24 }, end: { x: 96, y: 24 } }, idFactory),
  );
  const [line] = describeTakeoff(document);
  assert.equal(line.quantity, 3);
  assert.equal(line.requiredLinearFeet, undefined, 'this is not a lineal-feet buy');
  assert.equal(line.stockLengthFeet, undefined, 'no stock length is implied');
});

test('the chosen size labels reach the takeoff line', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createBeam({ start: { x: 0, y: 0 }, end: { x: 96, y: 0 }, size: '2x10' }, idFactory),
    createBeam({ start: { x: 0, y: 12 }, end: { x: 96, y: 12 }, size: '2x10' }, idFactory),
    createBeam({ start: { x: 0, y: 24 }, end: { x: 96, y: 24 }, size: '6x6' }, idFactory),
  );
  const [line] = describeTakeoff(document);
  assert.equal(line.specification, '2x10 · 6x6');
  assert.equal(line.quantity, 3);
});

test('a beam with no stored length is re-measured rather than silently dropped', () => {
  // deserialised from an older save: endpoints, but no computed block
  const document = documentWith({
    id: 'beam-legacy', type: 'beam', name: 'Beam',
    start: { x: 0, y: 0 }, end: { x: 120, y: 0 },
  });
  const [line] = describeTakeoff(document);
  assert.equal(line.quantity, 1, 'it still reaches the material list');
  assert.equal(line.specification, '1 drawn · 10 lf total', 're-measured from its endpoints');
});

test('an empty document produces no beam material', () => {
  const document = createProjectDocument({ id: 'project' });
  assert.deepEqual(getBeams(document), []);
  assert.deepEqual(describeTakeoff(document), []);
});

test('beams live in the document and leave it when removed', () => {
  const idFactory = sequentialIds();
  const document = documentWith(createBeam({ start: { x: 0, y: 0 }, end: { x: 144, y: 0 } }, idFactory));
  const emptied = removeBeam(document, 'beam-1');
  assert.equal(getBeams(document).length, 1);
  assert.deepEqual(getBeams(emptied), []);
  assert.deepEqual(describeTakeoff(emptied), []);
});

test('updating endpoints re-measures the run and bumps the revision', () => {
  const idFactory = sequentialIds();
  const document = documentWith(createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, size: '2x10' }, idFactory));
  const updated = updateBeam(document, 'beam-1', { end: { x: 192, y: 0 }, size: '2x12' });
  const [beam] = getBeams(updated);
  assert.equal(beam.computed.lengthInches, 192);
  assert.equal(beam.size, '2x12');
  assert.equal(beam.lifecycle.revision, 2);
  const [line] = describeTakeoff(updated);
  assert.equal(line.quantity, 1, 'still one beam, however long it got');
  assert.equal(line.specification, '2x12', 'a named size wins over the span summary');
});

test('nothing handed in is ever mutated', () => {
  const idFactory = sequentialIds();
  const start = { x: 0, y: 0 };
  const end = { x: 120, y: 0 };
  const beam = createBeam({ start, end, size: '2x10' }, idFactory);
  const beamSnapshot = structuredClone(beam);
  const document = createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' });
  const documentSnapshot = structuredClone(document);

  const added = addBeam(document, beam);
  const addedSnapshot = structuredClone(added);
  updateBeam(added, 'beam-1', { end: { x: 240, y: 0 }, size: '2x12' });
  removeBeam(added, 'beam-1');
  describeTakeoff(added);

  assert.deepEqual(start, { x: 0, y: 0 });
  assert.deepEqual(end, { x: 120, y: 0 });
  assert.deepEqual(beam, beamSnapshot);
  assert.deepEqual(document, documentSnapshot);
  assert.deepEqual(added, addedSnapshot);
  assert.notEqual(added.objects, document.objects);
});

test('a beam needs two distinct, real points', () => {
  assert.throws(() => createBeam({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }), /different/);
  assert.throws(() => createBeam({ start: { x: 0, y: 0 } }), /valid points/);
  assert.throws(() => addBeam(createProjectDocument({ id: 'project' }), { type: 'stair', id: 'stair-1' }), /beam construction object/);
  assert.throws(() => updateBeam(createProjectDocument({ id: 'project' }), 'beam-1', {}), /not found/);
});
