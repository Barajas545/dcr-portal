import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDrawingBreakdown, deriveDrawingNumbers } from './dcr-portal-numbers.js';
import { createProjectDocument, upsertObject } from '../document/project-document.js';
import { createDeckBoundary, updateEdgeProperties } from '../../tools/deck-boundary/deck-boundary.js';
import { attachStairToBoundary } from '../../tools/stairs/stair.js';
import { createRailingLine, createRailingRun } from '../../tools/railing/railing.js';
import { createLevelDown, updateLevelDownProperties } from '../../tools/level-down/level-down.js';

const sequentialIds = () => {
  let counter = 0;
  return (prefix) => `${prefix}-${(counter += 1)}`;
};

const emptyDocument = () => createProjectDocument({ id: 'project-1', name: 'Test deck', now: '2026-01-01T00:00:00.000Z' });

// 18 ft x 11.5 ft in inches: the drawing is always inches, feet appear only here.
const rectangle = (widthInches, heightInches, options) => createDeckBoundary([
  { x: 0, y: 0 },
  { x: widthInches, y: 0 },
  { x: widthInches, y: heightInches },
  { x: 0, y: heightInches },
], options);

const withObjects = (...objects) => objects.reduce((document, object) => upsertObject(document, object, '2026-01-01T00:00:00.000Z'), emptyDocument());

test('an empty drawing quotes nothing, and still returns exactly the four keys the estimate form reads', () => {
  assert.deepEqual(deriveDrawingNumbers(emptyDocument()), { deckSF: 0, railLF: 0, fasciaLF: 0, stairs: 0 });
  assert.deepEqual(deriveDrawingBreakdown(emptyDocument()), { areas: [], railingByType: [], fasciaEdges: [], stairCount: 0 });
});

test('18 ft x 11.5 ft is exactly 207 square feet', () => {
  const boundary = rectangle(216, 138, { id: 'boundary-1', idFactory: sequentialIds() });
  assert.equal(deriveDrawingNumbers(withObjects(boundary)).deckSF, 207);
});

test('a boundary flagged excludeFromDeckArea is drawn but never billed', () => {
  const ids = sequentialIds();
  const billed = rectangle(216, 138, { id: 'boundary-1', name: 'Main deck', idFactory: ids });
  const excluded = rectangle(144, 144, { id: 'boundary-2', name: 'Existing slab', idFactory: ids, metadata: { excludeFromDeckArea: true } });
  const document = withObjects(billed, excluded);

  assert.equal(deriveDrawingNumbers(document).deckSF, 207);
  assert.deepEqual(deriveDrawingBreakdown(document).areas, [
    { id: 'boundary-1', name: 'Main deck', squareFeet: 207, excluded: false },
    { id: 'boundary-2', name: 'Existing slab', squareFeet: 144, excluded: true },
  ]);
});

test('only an explicit true excludes an area, so a stray falsy flag cannot drop it from the quote', () => {
  const boundary = rectangle(216, 138, { id: 'boundary-1', idFactory: sequentialIds(), metadata: { excludeFromDeckArea: 'false' } });
  assert.equal(deriveDrawingNumbers(withObjects(boundary)).deckSF, 207);
});

test('deckSF is gross: the stair footprint is billed, not netted out', () => {
  const ids = sequentialIds();
  const attached = attachStairToBoundary(rectangle(216, 138, { id: 'boundary-1', idFactory: ids }), 'edge-5', { width: 36, totalRise: 36, treadDepth: 10.5 }, ids);
  const document = withObjects(attached.boundary, attached.stair);
  // 36" wide x 42" of run added outside the rectangle: 1512 sq in, 10.5 sq ft.
  const footprintSquareFeet = attached.stair.dimensions.width * attached.stair.dimensions.totalRun / 144;
  assert.equal(footprintSquareFeet, 10.5);

  const numbers = deriveDrawingNumbers(document);
  assert.equal(numbers.deckSF, 217.5);
  assert.notEqual(numbers.deckSF, 207, 'netting the stair footprint out would reprice every job against the historical $/sq ft');
  assert.equal(numbers.stairs, 1);
  assert.equal(deriveDrawingBreakdown(document).stairCount, 1);
});

test('railing runs count their drawn length, hosted on an edge or drawn free', () => {
  const ids = sequentialIds();
  const boundary = rectangle(216, 138, { id: 'boundary-1', idFactory: ids });
  const hosted = createRailingRun({ boundaryId: boundary.id, edgeId: 'edge-5' }, 0, .5, {}, ids);
  const free = createRailingLine(
    { snapType: 'grid', point: { x: 0, y: 300 } },
    { snapType: 'grid', point: { x: 120, y: 300 } },
    {},
    ids,
  );

  // Half of a 216" edge is 9 ft; the free run is a flat 10 ft.
  assert.equal(deriveDrawingNumbers(withObjects(boundary, hosted)).railLF, 9);
  assert.equal(deriveDrawingNumbers(withObjects(boundary, free)).railLF, 10);
  assert.equal(deriveDrawingNumbers(withObjects(boundary, hosted, free)).railLF, 19);
});

test('a run hosted on a stair opening still bills, though that edge lives on the stair', () => {
  const ids = sequentialIds();
  const attached = attachStairToBoundary(rectangle(216, 138, { id: 'boundary-1', idFactory: ids }), 'edge-5', { width: 36, totalRise: 36, treadDepth: 10.5 }, ids);
  const railing = createRailingRun({ boundaryId: attached.boundary.id, edgeId: attached.stair.interfaceEdge.id, edgeKind: 'stair-interface-edge' }, 0, 1, {}, ids);
  // The full 36" stair opening is 3 ft of rail.
  assert.equal(deriveDrawingNumbers(withObjects(attached.boundary, attached.stair, railing)).railLF, 3);
});

test('a gate opening comes off its own run, and a run without openings is left alone', () => {
  const ids = sequentialIds();
  const gated = createRailingLine(
    { snapType: 'grid', point: { x: 0, y: 0 } },
    { snapType: 'grid', point: { x: 120, y: 0 } },
    {},
    ids,
  );
  const plain = createRailingLine(
    { snapType: 'grid', point: { x: 0, y: 60 } },
    { snapType: 'grid', point: { x: 60, y: 60 } },
    {},
    ids,
  );
  const document = withObjects({ ...gated, openings: [{ id: 'gate-1', widthInches: 36 }] }, plain);

  // 120" less a 36" gate is 84" (7 ft), plus an untouched 60" run (5 ft).
  assert.equal(deriveDrawingNumbers(document).railLF, 12);
  assert.deepEqual(deriveDrawingBreakdown(document).railingByType, [{ type: 'wild-hog', linearFeet: 12 }]);
});

test('a gate drawn wider than its run cannot eat another run\'s footage', () => {
  const ids = sequentialIds();
  const short = createRailingLine({ snapType: 'grid', point: { x: 0, y: 0 } }, { snapType: 'grid', point: { x: 24, y: 0 } }, {}, ids);
  const other = createRailingLine({ snapType: 'grid', point: { x: 0, y: 60 } }, { snapType: 'grid', point: { x: 120, y: 60 } }, {}, ids);
  const document = withObjects({ ...short, openings: [{ widthInches: 240 }] }, other);
  assert.equal(deriveDrawingNumbers(document).railLF, 10);
});

test('fascia bills flagged boundary edges plus flagged level down segments', () => {
  const ids = sequentialIds();
  const plain = rectangle(216, 138, { id: 'boundary-1', idFactory: ids });
  const boundary = updateEdgeProperties(plain, 'edge-5', { finishes: { fascia: true } });
  const levelDown = updateLevelDownProperties(createLevelDown([
    { x: 0, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-8', t: .29 } },
    { x: 60, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-6', t: .71 } },
  ], { boundaryId: boundary.id }, ids), { finishes: { fascia: true } });
  const document = withObjects(boundary, levelDown);

  // One 216" edge (18 ft) plus one 60" level down segment (5 ft).
  assert.equal(deriveDrawingNumbers(document).fasciaLF, 23);
  assert.deepEqual(deriveDrawingBreakdown(document).fasciaEdges, [
    { id: 'edge-5', ownerId: 'boundary-1', kind: 'boundary-edge', linearFeet: 18 },
    { id: levelDown.segments[0].id, ownerId: levelDown.id, kind: 'level-down-segment', linearFeet: 5 },
  ]);
});

test('an unflagged level down is drawn but adds no fascia', () => {
  const ids = sequentialIds();
  const boundary = rectangle(216, 138, { id: 'boundary-1', idFactory: ids });
  const levelDown = createLevelDown([
    { x: 0, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-8', t: .29 } },
    { x: 60, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-6', t: .71 } },
  ], { boundaryId: boundary.id }, ids);
  assert.equal(deriveDrawingNumbers(withObjects(boundary, levelDown)).fasciaLF, 0);
});

test('every number is clamped at zero and rounded to a tenth', () => {
  const boundary = rectangle(100, 100, { id: 'boundary-1', idFactory: sequentialIds() });
  // 10000 sq in is 69.444... sq ft.
  assert.equal(deriveDrawingNumbers(withObjects(boundary)).deckSF, 69.4);

  const broken = { ...boundary, computed: { ...boundary.computed, areaSquareInches: -5000 } };
  assert.equal(deriveDrawingNumbers(withObjects(broken)).deckSF, 0);
});

test('resolved railing geometry from the caller wins, and the breakdown shows the same footage', () => {
  const ids = sequentialIds();
  const boundary = rectangle(216, 138, { id: 'boundary-1', idFactory: ids });
  const railing = createRailingRun({ boundaryId: boundary.id, edgeId: 'missing-edge' }, 0, 1, {}, ids);
  const document = withObjects(boundary, railing);
  const options = { railingGeometries: [{ railing, length: 96 }] };

  assert.equal(deriveDrawingNumbers(document).railLF, 0, 'an unresolvable host bills nothing rather than guessing');
  assert.equal(deriveDrawingNumbers(document, options).railLF, 8);
  assert.deepEqual(deriveDrawingBreakdown(document, options).railingByType, [{ type: 'unassigned', linearFeet: 8 }]);
});

test('neither export touches the document it was handed', () => {
  const ids = sequentialIds();
  const attached = attachStairToBoundary(rectangle(216, 138, { id: 'boundary-1', idFactory: ids }), 'edge-5', { width: 36, totalRise: 36, treadDepth: 10.5 }, ids);
  const boundary = updateEdgeProperties(attached.boundary, 'edge-6', { finishes: { fascia: true } });
  const railing = createRailingLine({ snapType: 'grid', point: { x: 0, y: 300 } }, { snapType: 'grid', point: { x: 120, y: 300 } }, {}, ids);
  const levelDown = updateLevelDownProperties(createLevelDown([
    { x: 0, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-8', t: .29 } },
    { x: 60, y: 40, anchor: { snapType: 'edge', edgeId: 'edge-6', t: .71 } },
  ], { boundaryId: boundary.id }, ids), { finishes: { fascia: true } });
  const document = withObjects(boundary, attached.stair, { ...railing, openings: [{ widthInches: 36 }] }, levelDown);
  const before = structuredClone(document);

  deriveDrawingNumbers(document);
  deriveDrawingNumbers(document, { railingGeometries: [{ railing, length: 999 }] });
  deriveDrawingBreakdown(document);

  assert.deepEqual(document, before);
});
