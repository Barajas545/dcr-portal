import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import {
  DEFAULT_COPIES,
  DEFAULT_SPACING_INCHES,
  MAX_COPIES,
  ON_CENTRE_SPACINGS,
  addJoist,
  addParallelJoistToField,
  arrayObject,
  clipLinearMemberToPolygon,
  consolidateJoistRuns,
  createJoist,
  deriveJoistField,
  deriveSharedRimFlushSupports,
  describeTakeoff,
  getJoists,
  moveJoistField,
  planJoistStock,
  packJoistCuts,
  removeJoistField,
  removeJoist,
  updateJoist,
  updateJoistField,
} from './joist-group.js';

test('short joist cuts share commercial stock when that reduces purchased footage', () => {
  const boards = packJoistCuts([72, 48]);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].lengthFeet, 10);
  assert.equal(boards[0].cuts.length, 2);
});

test('cut optimizer compares layouts instead of trapping a long cut with the wrong offcut', () => {
  const boards = packJoistCuts([144, 72, 72]);
  assert.equal(boards.reduce((sum, board) => sum + board.lengthFeet, 0), 24);
  assert.deepEqual(boards.map((board) => board.lengthFeet).sort((a, b) => a - b), [12, 12]);
});

test('legacy field bays migrate into one continuous joist without losing support spans', () => {
  const fieldId = 'legacy-field';
  let document = emptyDocument();
  document = addJoist(document, createJoist({ start: { x: 0, y: 0 }, end: { x: 0, y: 72 }, size: '2×6 PT', layout: { fieldId, boundaryId: 'deck', spacingInches: 16, startSupportId: 'ledger', endSupportId: 'beam-1' } }));
  document = addJoist(document, createJoist({ start: { x: 0, y: 72 }, end: { x: 0, y: 144 }, size: '2×6 PT', layout: { fieldId, boundaryId: 'deck', spacingInches: 16, startSupportId: 'beam-1', endSupportId: 'rim' } }));
  const migrated = consolidateJoistRuns(document);
  assert.equal(getJoists(migrated).length, 1);
  assert.equal(getJoists(migrated)[0].computed.lengthInches, 144);
  assert.equal(getJoists(migrated)[0].layout.bays.length, 2);
  assert.equal(getJoists(migrated)[0].layout.spanValidation.valid, true);
});

const emptyDocument = () => createProjectDocument({ id: 'project', name: 'Test deck', now: '2026-01-01T00:00:00.000Z' });

function documentWithJoist(start = { x: 0, y: 0 }, end = { x: 120, y: 0 }) {
  const joist = createJoist({ start, end });
  return { document: addJoist(emptyDocument(), joist), joist };
}

test('a joist is a line that knows its own length in inches', () => {
  const joist = createJoist({ start: { x: 0, y: 0 }, end: { x: 36, y: 48 } });
  assert.equal(joist.type, 'joist');
  assert.equal(joist.computed.lengthInches, 60);
  assert.equal(joist.size, null);
  assert.equal(joist.lifecycle.revision, 1);
});

test('the size is a label the estimator picks, never something derived from the span', () => {
  const joist = createJoist({ start: { x: 0, y: 0 }, end: { x: 240, y: 0 }, size: '2x10x20', name: 'Rim joist' });
  assert.equal(joist.size, '2x10x20');
  assert.equal(joist.name, 'Rim joist');
  assert.equal(joist.computed.lengthInches, 240);
});

test('a joist needs two different points', () => {
  assert.throws(() => createJoist({ start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }), /different/);
  assert.throws(() => createJoist({ start: { x: 0, y: 0 } }), /valid points/);
});

test('the on-centre spacings are the four the old tool offered', () => {
  assert.deepEqual(ON_CENTRE_SPACINGS, [12, 16, 19.2, 24]);
  assert.equal(DEFAULT_SPACING_INCHES, 16);
  assert.equal(DEFAULT_COPIES, 8);
  assert.equal(MAX_COPIES, 200);
});

test('add, update and remove keep the document a plain list of objects', () => {
  const { document, joist } = documentWithJoist();
  assert.deepEqual(getJoists(document).map((entry) => entry.id), [joist.id]);

  const lengthened = updateJoist(document, joist.id, { end: { x: 144, y: 0 }, size: '2x8x12' });
  assert.equal(getJoists(lengthened)[0].computed.lengthInches, 144);
  assert.equal(getJoists(lengthened)[0].size, '2x8x12');
  assert.equal(getJoists(lengthened)[0].lifecycle.revision, 2);
  assert.equal(getJoists(lengthened).length, 1);

  assert.deepEqual(getJoists(removeJoist(lengthened, joist.id)), []);
  assert.throws(() => updateJoist(document, 'missing', { size: '2x8x12' }), /not found/);
});

test('arraying a joist repeats it perpendicular to its own run', () => {
  const { document, joist } = documentWithJoist();
  const arrayed = arrayObject(document, joist.id, { spacingInches: 16, count: 8 });
  const copies = getJoists(arrayed).slice(1);

  assert.equal(getJoists(arrayed).length, 9);
  assert.deepEqual(copies.map((copy) => copy.start.y), [16, 32, 48, 64, 80, 96, 112, 128]);
  assert.deepEqual(copies.map((copy) => copy.end.y), [16, 32, 48, 64, 80, 96, 112, 128]);
  assert.ok(copies.every((copy) => copy.start.x === 0 && copy.end.x === 120));
  assert.ok(copies.every((copy) => copy.computed.lengthInches === 120));
});

test('arraying along the line walks the copies down the run instead', () => {
  const { document, joist } = documentWithJoist();
  const copies = getJoists(arrayObject(document, joist.id, { spacingInches: 19.2, count: 3, direction: 'along' })).slice(1);
  // 19.2" o.c. is not exact in binary, so the run is checked to a thousandth of an inch.
  copies.forEach((copy, index) => assert.ok(Math.abs(copy.start.x - 19.2 * (index + 1)) < 1e-3));
  assert.ok(copies.every((copy) => copy.start.y === 0 && copy.end.y === 0));
});

test('a zero-length marker such as a post arrays sideways', () => {
  const post = { type: 'post', id: 'post-1', name: 'Post', anchor: { x: 10, y: 10 }, lifecycle: { phase: 'established', revision: 1 } };
  const document = { ...emptyDocument(), objects: [post] };
  const copies = arrayObject(document, post.id, { spacingInches: 24, count: 2 }).objects.slice(1);
  assert.deepEqual(copies.map((copy) => copy.anchor), [{ x: 34, y: 10 }, { x: 58, y: 10 }]);
});

test('every copy is a deep clone with a new id and no sequence number', () => {
  const { document, joist } = documentWithJoist();
  const numbered = { ...document, objects: [{ ...joist, seq: 3, sequence: 3 }] };
  const copies = getJoists(arrayObject(numbered, joist.id, { spacingInches: 16, count: 2 })).slice(1);

  assert.equal(new Set(copies.map((copy) => copy.id)).size, 2);
  assert.ok(copies.every((copy) => copy.id !== joist.id));
  assert.ok(copies.every((copy) => !('seq' in copy) && !('sequence' in copy)));
  assert.ok(copies.every((copy) => copy.start !== joist.start && copy.computed !== joist.computed));
  assert.equal(copies[0].name, joist.name);
});

test('the whole array is one new document, so it is one undo step', () => {
  const { document, joist } = documentWithJoist();
  const before = structuredClone(document);
  const arrayed = arrayObject(document, joist.id, { spacingInches: 16, count: 8 });

  assert.notEqual(arrayed, document);
  assert.deepEqual(document, before);
  assert.equal(document.objects.length, 1);
});

test('an impossible array is refused and the document comes back untouched', () => {
  const { document, joist } = documentWithJoist();
  for (const options of [
    { spacingInches: 16, count: MAX_COPIES + 1 },
    { spacingInches: 16, count: 200.5 },
    { spacingInches: 16, count: 0 },
    { spacingInches: 0, count: 8 },
    { spacingInches: -16, count: 8 },
    { spacingInches: Number.NaN, count: 8 },
    { spacingInches: 'sixteen', count: 8 },
  ]) assert.equal(arrayObject(document, joist.id, options), document);
  assert.equal(arrayObject(document, 'missing', { spacingInches: 16, count: 8 }), document);
  assert.equal(getJoists(arrayObject(document, joist.id, { spacingInches: 16, count: MAX_COPIES })).length, MAX_COPIES + 1);
});

test('the takeoff is one piece per joist drawn, plus two hangers each', () => {
  const document = addJoist(
    addJoist(emptyDocument(), createJoist({ start: { x: 0, y: 0 }, end: { x: 144, y: 0 } })),
    createJoist({ start: { x: 0, y: 16 }, end: { x: 120, y: 16 } }),
  );
  const lines = describeTakeoff(document);
  const joistLines = lines.filter((line) => line.category === 'framing');
  const hangers = lines.find((line) => line.id === 'auto:hardware:joist-hanger');

  assert.equal(joistLines.reduce((sum, line) => sum + line.quantity, 0), 2, 'two joists drawn is two joists ordered');
  assert.deepEqual(joistLines.flatMap((line) => line.sourceObjectIds).sort(), getJoists(document).map((joist) => joist.id).sort());

  assert.equal(hangers.kind, 'count');
  assert.equal(hangers.id, 'auto:hardware:joist-hanger');
  assert.equal(hangers.category, 'hardware');
  assert.equal(hangers.description, 'Joist hanger');
  assert.equal(hangers.quantity, 4, 'both ends of both joists');
});

test('joists are counted as pieces, never bought as lineal feet off a stock length', () => {
  /* The regression this guards.

     Buying Math.ceil(totalLF * waste / 16) sticks assumes the offcut from one
     joist becomes the next. It does not: a 16 ft board yields exactly one 12 ft
     joist and the 4 ft tail is scrap. Eight 12 ft joists priced that way came to
     seven boards, and the deck was one joist short. */
  let document = emptyDocument();
  for (let i = 0; i < 8; i += 1) {
    document = addJoist(document, createJoist({ start: { x: 0, y: i * 16 }, end: { x: 144, y: i * 16 } }));
  }
  const joistLine = describeTakeoff(document).find((line) => line.category === 'framing');
  assert.equal(joistLine.quantity, 8, 'eight 12 ft joists need eight boards, not seven');
  assert.equal(joistLine.kind, 'count');
  assert.equal(joistLine.stockLengthFeet, 12, 'each cut receives the shortest commercial board that can produce it');
  assert.equal(joistLine.requiredLinearFeet, undefined, 'this is not a lineal-feet buy');
});

test('arrayed copies fall straight into the takeoff', () => {
  const source = createJoist({ start: { x: 0, y: 0 }, end: { x: 192, y: 0 } });
  const document = arrayObject(addJoist(emptyDocument(), source), source.id, { spacingInches: 16, count: 3 });
  const lines = describeTakeoff(document);
  const joistLine = lines.find((line) => line.category === 'framing');
  const hangers = lines.find((line) => line.id === 'auto:hardware:joist-hanger');
  assert.equal(joistLine.quantity, 4, 'the original plus three copies');
  assert.equal(hangers.quantity, 8, 'two hangers on each');
});

test('the sizes the estimator picked become the specification', () => {
  const document = addJoist(emptyDocument(), createJoist({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, size: '2x8x12' }));
  assert.equal(describeTakeoff(document)[0].description, '2x8x12 joist');
  const mixed = addJoist(document, createJoist({ start: { x: 0, y: 16 }, end: { x: 120, y: 16 }, size: '2x10x16' }));
  assert.deepEqual(describeTakeoff(mixed).filter((line) => line.category === 'framing').map((line) => line.description), ['2x8x12 joist', '2x10x16 joist']);
});

test('commercial joist stock never implies an unsupported splice', () => {
  assert.equal(planJoistStock(121).stockLengthFeet, 12);
  assert.equal(planJoistStock(241).stockLengthFeet, null);
  assert.equal(planJoistStock(241).needsReview, true);
});

test('a Ledger drag fills the Deck Boundary perpendicular to its host in real time', () => {
  const boundary = { id: 'deck-1', vertices: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 144 }, { x: 0, y: 144 }] };
  const field = deriveJoistField({
    boundary,
    hostStart: { x: 0, y: 0 },
    hostEnd: { x: 240, y: 0 },
    origin: { x: 120, y: 0 },
    toward: { x: 120, y: 300 },
    spacingInches: 16,
    host: { type: 'ledger-edge', id: 'edge-1' },
  });
  assert.equal(field.joists.length, 15);
  assert.ok(field.joists.every((joist) => joist.start.y === 0 && joist.end.y === 144));
  assert.ok(field.joists.every((joist) => joist.size === '2×6 PT'));
  assert.ok(field.joists.every((joist) => joist.stock.stockLengthFeet === 12));
});

test('stopping over a beam creates a shorter supported bay instead of filling past it', () => {
  const boundary = { id: 'deck-1', vertices: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 180 }, { x: 0, y: 180 }] };
  const field = deriveJoistField({ boundary, hostStart: { x: 0, y: 0 }, hostEnd: { x: 240, y: 0 }, origin: { x: 120, y: 0 }, toward: { x: 120, y: 72 }, spacingInches: 16 });
  assert.ok(field.joists.every((joist) => joist.computed === undefined && joist.end.y === 72));
  assert.ok(field.joists.every((joist) => joist.stock.stockLengthFeet === 8));
});

test('a full-DB Joist Field continues beyond the Ledger and uses diagonal Rim and Beam supports', () => {
  const boundary = { id: 'deck-1', vertices: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 240, y: 120 }, { x: 0, y: 120 }] };
  const supports = [
    { id: 'ledger', start: { x: 0, y: 0 }, end: { x: 120, y: 0 } },
    { id: 'diagonal-rim', start: { x: 120, y: 0 }, end: { x: 240, y: 120 } },
    { id: 'beam', start: { x: 0, y: 60 }, end: { x: 180, y: 60 } },
    { id: 'bottom-rim', start: { x: 0, y: 120 }, end: { x: 240, y: 120 } },
  ];
  const field = deriveJoistField({
    boundary,
    hostStart: { x: 0, y: 0 },
    hostEnd: { x: 120, y: 0 },
    origin: { x: 60, y: 0 },
    toward: { x: 60, y: 80 },
    spacingInches: 30,
    fillBoundary: true,
    supports,
  });
  const supported = field.joists.filter((joist) => joist.supported);
  assert.ok(supported.some((joist) => joist.start.x > 120 || joist.end.x > 120), 'the joist lattice must continue into the DB beyond the Ledger endpoint');
  assert.ok(supported.some((joist) => joist.layout.startSupportId === 'diagonal-rim' || joist.layout.endSupportId === 'diagonal-rim'));
  assert.ok(supported.every((joist) => joist.layout.startSupportId && joist.layout.endSupportId));
  assert.ok(supported.some((joist) => joist.layout.bays.length === 2), 'intermediate Beam bearings remain bays inside one continuous joist run');
});

test('a neighboring DB Rim / Flush supports the selected DB without changing field ownership', () => {
  const target = {
    id: 'left-deck',
    vertices: [
      { id: 'left-1', x: 0, y: 0 }, { id: 'left-2', x: 240, y: 0 },
      { id: 'left-3', x: 240, y: 120 }, { id: 'left-4', x: 0, y: 120 },
    ],
    edges: [],
  };
  const neighbor = {
    id: 'right-deck',
    vertices: [{ id: 'right-1', x: 120, y: 0 }, { id: 'right-2', x: 240, y: 120 }, { id: 'right-3', x: 300, y: 0 }],
    edges: [{
      id: 'shared-double-rim', startVertexId: 'right-1', endVertexId: 'right-2',
      properties: { attachments: { rimJoist: { enabled: true, plyCount: 2 } } },
    }],
  };
  const shared = deriveSharedRimFlushSupports([target, neighbor], target);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].sourceBoundaryId, neighbor.id);
  assert.equal(shared[0].targetBoundaryId, target.id);
  assert.equal(shared[0].shared, true);
  assert.equal(shared[0].plyCount, 2);

  const supports = [
    { id: 'left-ledger', type: 'ledger', start: { x: 0, y: 0 }, end: { x: 0, y: 120 } },
    ...shared,
  ];
  const field = deriveJoistField({
    boundary: target,
    hostStart: supports[0].start,
    hostEnd: supports[0].end,
    origin: { x: 0, y: 30 },
    toward: { x: 220, y: 30 },
    spacingInches: 30,
    fillBoundary: true,
    supports,
  });
  const supported = field.joists.filter((joist) => joist.supported);
  assert.ok(supported.length > 0, 'the neighboring structural edge closes supported runs in the selected DB');
  assert.ok(supported.every((joist) => joist.layout.boundaryId === target.id), 'the Joist Field never changes DB ownership');
  assert.ok(supported.some((joist) => joist.layout.endSupportId === 'shared-double-rim'));
  assert.ok(supported.every((joist) => [joist.start, joist.end].every((point) => point.x >= 0 && point.x <= 240 && point.y >= 0 && point.y <= 120)));
});

function establishedEditableField() {
  const boundary = { id: 'deck-field', vertices: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 120 }, { x: 0, y: 120 }] };
  const supports = [
    { id: 'ledger', start: { x: 0, y: 0 }, end: { x: 240, y: 0 } },
    { id: 'beam', start: { x: 0, y: 60 }, end: { x: 240, y: 60 } },
    { id: 'rim', start: { x: 0, y: 120 }, end: { x: 240, y: 120 } },
  ];
  const field = deriveJoistField({
    boundary,
    hostStart: supports[0].start,
    hostEnd: supports[0].end,
    origin: { x: 24, y: 0 },
    toward: { x: 24, y: 100 },
    spacingInches: 16,
    fillBoundary: true,
    supports,
  });
  let document = createProjectDocument({ name: 'Editable joist field' });
  field.joists.filter((joist) => joist.supported).forEach((spec, index) => {
    document = addJoist(document, createJoist({
      start: spec.start,
      end: spec.end,
      size: spec.size,
      layout: { ...spec.layout, fieldId: 'field-1' },
    }, () => `field-joist-${index}`));
  });
  return { document, boundary, supports };
}

test('one click adds a supported parallel joist and locks it to its Joist Field', () => {
  const setup = establishedEditableField();
  const result = addParallelJoistToField(setup.document, 'field-1', {
    boundary: setup.boundary,
    supports: setup.supports,
    point: { x: 37, y: 44 },
  }, () => 'manual-joist');
  assert.equal(result.joist.id, 'manual-joist');
  assert.equal(result.joist.layout.manualParallel, true);
  assert.equal(result.joist.layout.lockedToMesh, true);
  assert.equal(result.joist.layout.boundaryId, setup.boundary.id);
  assert.deepEqual(result.joist.layout.bays.map((bay) => bay.lengthInches), [60, 60]);
  assert.equal(getJoists(result.document).length, getJoists(setup.document).length + 1);
});

test('moving a Joist Field regenerates regular runs inside the DB and carries manual joists with it', () => {
  const setup = establishedEditableField();
  const added = addParallelJoistToField(setup.document, 'field-1', {
    boundary: setup.boundary,
    supports: setup.supports,
    point: { x: 37, y: 44 },
  }, () => 'manual-joist');
  const before = added.joist.start.x;
  const neighborDistances = added.joist.layout.neighborDistancesInches;
  const moved = moveJoistField(added.document, 'field-1', {
    boundary: setup.boundary,
    supports: setup.supports,
    offsetInches: -5,
  });
  const manual = moved.joists.find((joist) => joist.id === 'manual-joist');
  assert.equal(manual.start.x, before + 5, 'manual member follows the field phase exactly');
  assert.deepEqual(manual.layout.neighborDistancesInches, neighborDistances, 'its lock distances to neighboring joists remain stable');
  assert.ok(moved.joists.every((joist) => joist.start.x >= 0 && joist.start.x <= 240));
  assert.ok(moved.joists.every((joist) => joist.end.x >= 0 && joist.end.x <= 240));
  assert.ok(moved.joists.every((joist) => joist.layout.fieldId === 'field-1'));
  assert.equal(getJoists(moved.document).length, moved.joists.length);
});

test('profile and O.C. spacing regenerate the complete Joist Field instead of one selected member', () => {
  const setup = establishedEditableField();
  const added = addParallelJoistToField(setup.document, 'field-1', {
    boundary: setup.boundary,
    supports: setup.supports,
    point: { x: 37, y: 44 },
  }, () => 'manual-joist');
  const result = updateJoistField(added.document, 'field-1', {
    boundary: setup.boundary,
    supports: setup.supports,
    spacingInches: 24,
    size: '2×8 PT',
    material: { speciesGroup: 'redwood', grade: 'No. 2', treatment: 'PT' },
  });
  assert.equal(result.changed, true);
  assert.ok(result.joists.length > 1);
  assert.ok(result.joists.every((joist) => joist.size === '2×8 PT'));
  assert.ok(result.joists.every((joist) => joist.layout.spacingInches === 24));
  assert.ok(result.joists.every((joist) => joist.material.speciesGroup === 'redwood'));
  assert.equal(result.joists.filter((joist) => joist.layout.manualParallel).length, 1);
});

test('a Joist Field profile change synchronizes Rim and Flush edges without losing double-joist ply count', () => {
  const setup = establishedEditableField();
  const modeledBoundary = {
    ...setup.boundary,
    type: 'deck-boundary',
    edges: [
      { id: 'double-rim', properties: { attachments: { rimJoist: { enabled: true, preset: '2x6', widthInches: 2, depthInches: 6, treatment: 'PT', plyCount: 2 } } } },
      { id: 'ordinary-boundary', properties: { attachments: { rimJoist: null } } },
    ],
  };
  const document = { ...setup.document, objects: [...setup.document.objects, modeledBoundary] };
  const result = updateJoistField(document, 'field-1', {
    boundary: modeledBoundary,
    supports: setup.supports,
    size: '2×10 PT',
  });
  const updatedBoundary = result.document.objects.find((object) => object.id === modeledBoundary.id);
  const rim = updatedBoundary.edges[0].properties.attachments.rimJoist;
  assert.equal(rim.preset, '2x10');
  assert.equal(rim.depthInches, 10);
  assert.equal(rim.plyCount, 2);
  assert.equal(updatedBoundary.edges[1].properties.attachments.rimJoist, null);
});

test('deleting a Joist Field removes every member and its Blocking settings together', () => {
  const setup = establishedEditableField();
  const document = { ...setup.document, objects: [...setup.document.objects, { type: 'joist-blocking-layout', id: 'blocking-layout', fieldId: 'field-1' }] };
  const removed = removeJoistField(document, 'field-1');
  assert.equal(getJoists(removed).some((joist) => joist.layout?.fieldId === 'field-1'), false);
  assert.equal(removed.objects.some((object) => object.id === 'blocking-layout'), false);
});

test('an empty document takes off nothing at all', () => {
  assert.deepEqual(describeTakeoff(emptyDocument()), []);
  assert.deepEqual(getJoists(emptyDocument()), []);
});

test('deck area never invents joists — only what was drawn or arrayed counts', () => {
  const deck = {
    type: 'deck-boundary',
    id: 'deck-1',
    vertices: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 144 }, { x: 0, y: 144 }],
    edges: [],
    computed: { areaSquareInches: 34560 },
  };
  assert.deepEqual(describeTakeoff({ ...emptyDocument(), objects: [deck] }), []);
});

test('nothing mutates the document or the objects handed in', () => {
  const { document, joist } = documentWithJoist();
  const documentBefore = structuredClone(document);
  const joistBefore = structuredClone(joist);

  arrayObject(document, joist.id, { spacingInches: 16, count: 4 });
  updateJoist(document, joist.id, { end: { x: 300, y: 0 }, size: '2x12x20' });
  removeJoist(document, joist.id);
  addJoist(document, createJoist({ start: { x: 0, y: 32 }, end: { x: 120, y: 32 } }));
  describeTakeoff(document);

  assert.deepEqual(document, documentBefore);
  assert.deepEqual(joist, joistBefore);
});

test('an anchored object such as a post or a count pin can be repeated too', () => {
  /* These carry their position in `at`, not start/end. arraySpan used to miss
     them entirely and arrayObject returned the document untouched, so the
     Repeat button looked dead for a row of footings. */
  const post = { id: 'post-1', type: 'post', name: 'Post', at: { x: 0, y: 0 }, lifecycle: { revision: 1 } };
  const base = { ...emptyDocument() };
  const document = { ...base, objects: [...base.objects, post] };

  const arrayed = arrayObject(document, 'post-1', { spacingInches: 24, count: 3 });
  assert.equal(arrayed.objects.length, 4, 'the original plus three copies');
  const xs = arrayed.objects.filter((o) => o.type === 'post').map((o) => o.at.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 24, 48, 72], 'a lone anchor walks sideways, the way the old tool did it');
  assert.equal(new Set(arrayed.objects.map((o) => o.id)).size, 4, 'every copy gets its own id');
});

test('repeat chooses the deck side and clips every joist to the boundary', () => {
  const { document, joist } = documentWithJoist({ x: 16, y: 0 }, { x: 16, y: 120 });
  const polygon = [{ x: 0, y: 0 }, { x: 144, y: 0 }, { x: 144, y: 120 }, { x: 0, y: 120 }];
  const arrayed = arrayObject(document, joist.id, { spacingInches: 16, count: 20, clipPolygon: polygon }, (prefix) => `${prefix}-${crypto.randomUUID()}`);
  const copies = arrayed.objects.filter((object) => object.id !== joist.id);
  assert.equal(copies.length, 8);
  assert.ok(copies.every((copy) => [copy.start.x, copy.end.x].every((x) => x >= 0 && x <= 144)));
  assert.ok(copies.every((copy) => [copy.start.y, copy.end.y].every((y) => y >= 0 && y <= 120)));
});

test('a linear member is split into valid pieces when a concave deck interrupts it', () => {
  const polygon = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 40, y: 40 }, { x: 40, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 120 }, { x: 0, y: 120 }];
  const pieces = clipLinearMemberToPolygon({ x: 80, y: -10 }, { x: 80, y: 130 }, polygon);
  assert.deepEqual(pieces, [
    { start: { x: 80, y: 0 }, end: { x: 80, y: 40 } },
    { start: { x: 80, y: 80 }, end: { x: 80, y: 120 } },
  ]);
});
