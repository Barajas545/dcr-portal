import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, upsertObject } from '../../core/document/project-document.js';
import { createRailingLine, createRailingRun, deriveRailingLineGeometry, updateRailingSettings } from './railing.js';
import { STICK_BUILT_SYSTEM, TREX_SYSTEM, describeTakeoff, getRailingRuns, railingSystem } from './railing-systems.js';
import { createGate } from '../symbols/symbols.js';

const sequentialIds = () => {
  let count = 0;
  return (prefix) => `${prefix}-${(count += 1)}`;
};

const gridAnchor = (x, y) => ({ snapType: 'grid', point: { x, y } });

const run = (start, end, options, idFactory) => createRailingLine(gridAnchor(...start), gridAnchor(...end), options, idFactory);

const documentWith = (...objects) => objects.reduce(
  (document, object) => upsertObject(document, object, '2026-01-01T00:00:00.000Z'),
  createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' }),
);

const geometriesFor = (document) => getRailingRuns(document).map((railing) => deriveRailingLineGeometry(
  railing,
  railing.anchors.start.point,
  railing.anchors.end.point,
));

const lineById = (descriptors, id) => descriptors.find((descriptor) => descriptor.id === id);

test('wild hog is billed by takeoff.js and never described here', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    run([0, 0], [240, 0], { system: 'wild-hog' }, idFactory),
    // a run saved before the system existed defaults to wild-hog and must stay silent too
    run([0, 48], [240, 48], {}, idFactory),
  );
  assert.equal(railingSystem(document.objects[1]), 'wild-hog');
  assert.deepEqual(describeTakeoff(document, { railingGeometries: geometriesFor(document) }), []);
});

test('a straight stick-built run bills posts, rails and balusters', () => {
  const idFactory = sequentialIds();
  // 240 in of railing: 75.5 in maximum centres gives 4 equal bays at 60 in, 5 posts
  const document = documentWith(run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, idFactory));
  const descriptors = describeTakeoff(document, { railingGeometries: geometriesFor(document) });
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    'auto:railing:stick-post',
    'auto:railing:stick-rail',
    'auto:railing:stick-baluster',
  ]);
  // posts are bought as stock to cut from; rail and baluster are counted pieces
  assert.ok(descriptors.every((descriptor) => ['count', 'yield'].includes(descriptor.kind) && descriptor.category === 'railing'));
  assert.ok(descriptors.every((descriptor) => descriptor.sourceObjectIds.length === 1 && descriptor.sourceObjectIds[0] === 'railing-1'));

  const posts = lineById(descriptors, 'auto:railing:stick-post');
  assert.equal(posts.description, 'Rail post stock (4x4)');
  assert.equal(posts.piecesNeeded, 5, 'the layout posts, not floor(20 / 6) + 1 = 4');

  const rails = lineById(descriptors, 'auto:railing:stick-rail');
  assert.equal(rails.description, 'Rail (2x4)');
  assert.equal(rails.quantity, 8, 'two 2x4 rails per bay, top and bottom');
  assert.equal(rails.specification, '2×4×8 · top and bottom · 40 lf of rail', 'the old rule railLF * 2 is still on the line');
  assert.equal(rails.confidence, undefined, 'a 60 in bay is inside an 8 ft stick');

  const balusters = lineById(descriptors, 'auto:railing:stick-baluster');
  assert.equal(balusters.description, 'Baluster');
  assert.equal(balusters.quantity, 54, 'ceil(20 * 12 / 4.5), ported from cad-sketch.js:904');
});

test('rails are ordered as pieces, never as lineal feet off a stock length', () => {
  /* Sixteen 6 ft rails are 100 lf. Bought as 100 lf off 16 ft stock that is seven
     boards, and a 16 ft board yields two 6 ft rails, so the job is a board short -
     the offcut assumption that shorted the joists. Eight bays, two rails each. */
  const idFactory = sequentialIds();
  const document = documentWith(run([0, 0], [576, 0], { system: STICK_BUILT_SYSTEM }, idFactory));
  const rails = lineById(describeTakeoff(document, { railingGeometries: geometriesFor(document) }), 'auto:railing:stick-rail');
  assert.equal(rails.kind, 'count');
  assert.equal(rails.quantity, 16, 'eight bays, top and bottom');
  assert.equal(rails.requiredLinearFeet, undefined, 'this is not a lineal-feet buy');
  assert.equal(rails.stockLengthFeet, undefined, 'no divisor, so no offcut assumption');
});

test('an L-shaped deck shares its corner post once and adds a corner post', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    run([0, 0], [120, 0], { system: STICK_BUILT_SYSTEM }, idFactory),
    run([120, 0], [120, 120], { system: STICK_BUILT_SYSTEM }, idFactory),
  );
  const descriptors = describeTakeoff(document, { railingGeometries: geometriesFor(document) });
  const posts = lineById(descriptors, 'auto:railing:stick-post');
  /* Six posts: three per run, the post they share at (120, 0) counted once, plus
     one for the exterior corner. The old floor(railLF / 6) + 1 said four for the
     same 20 ft - it could not see either the joint or the corner. */
  assert.equal(posts.piecesNeeded, 6);
  assert.deepEqual(posts.sourceObjectIds, ['railing-1', 'railing-2']);
  assert.equal(lineById(descriptors, 'auto:railing:stick-rail').quantity, 8, 'two bays per run, two rails per bay');
  assert.equal(lineById(descriptors, 'auto:railing:stick-baluster').quantity, 54, 'the run total, ceil once');
});

test('a bay wider than a stick is flagged instead of billed as an 8 ft rail', () => {
  const idFactory = sequentialIds();
  // a hand-widened clear span: 123.5 in centres puts a 10 ft bay between posts
  const document = documentWith(run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM, maxClearSpan: 120 }, idFactory));
  const rails = lineById(describeTakeoff(document, { railingGeometries: geometriesFor(document) }), 'auto:railing:stick-rail');
  assert.equal(rails.quantity, 4);
  assert.equal(rails.confidence, 'review');
  assert.match(rails.specification, /10 ft, longer than the 8 ft stick/);
});

test('trex bills real quantities flagged for hand pricing, never a silent zero', () => {
  const idFactory = sequentialIds();
  const document = documentWith(run([0, 0], [240, 0], { system: TREX_SYSTEM }, idFactory));
  const descriptors = describeTakeoff(document, { railingGeometries: geometriesFor(document) });
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), ['auto:railing:trex-post', 'auto:railing:trex-section']);
  assert.equal(lineById(descriptors, 'auto:railing:trex-post').quantity, 5);
  assert.equal(lineById(descriptors, 'auto:railing:trex-section').quantity, 4, 'one kit per bay');
  assert.ok(descriptors.every((descriptor) => descriptor.confidence === 'review'), 'the catalogue choice is not this tool to make');
  assert.ok(descriptors.every((descriptor) => /price by hand/.test(descriptor.description)));
  // no lumber footage: a Trex rail is a kit sized to the bay, not 2x4 by the foot
  assert.ok(descriptors.every((descriptor) => descriptor.kind === 'count' && descriptor.requiredLinearFeet === undefined));
});

test('systems are read per run so a project can mix all three', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, idFactory),
    run([0, 48], [240, 48], { system: TREX_SYSTEM }, idFactory),
    run([0, 96], [240, 96], { system: 'wild-hog' }, idFactory),
  );
  const descriptors = describeTakeoff(document, { railingGeometries: geometriesFor(document) });
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    'auto:railing:stick-post',
    'auto:railing:stick-rail',
    'auto:railing:stick-baluster',
    'auto:railing:trex-post',
    'auto:railing:trex-section',
  ]);
  descriptors.forEach((descriptor) => {
    const expected = descriptor.id.includes('stick') ? 'railing-1' : 'railing-2';
    assert.deepEqual(descriptor.sourceObjectIds, [expected], `${descriptor.id} bills only its own run`);
  });
  assert.equal(lineById(descriptors, 'auto:railing:stick-baluster').quantity, 54, 'the trex run is not in the stick footage');
});

test('changing a run to another system moves its material', () => {
  const idFactory = sequentialIds();
  const document = documentWith(run([0, 0], [240, 0], { system: 'wild-hog' }, idFactory));
  const switched = upsertObject(document, updateRailingSettings(document.objects[0], { system: STICK_BUILT_SYSTEM }));
  assert.deepEqual(describeTakeoff(document, { railingGeometries: geometriesFor(document) }), []);
  assert.equal(describeTakeoff(switched, { railingGeometries: geometriesFor(switched) }).length, 3);
});

test('a run reaches the material list even when the caller resolved no geometry', () => {
  const idFactory = sequentialIds();
  const document = documentWith(run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, idFactory));
  const descriptors = describeTakeoff(document);
  assert.equal(lineById(descriptors, 'auto:railing:stick-post').piecesNeeded, 5, 'measured from its stored anchor points');
  assert.equal(lineById(descriptors, 'auto:railing:stick-baluster').quantity, 54);
});

test('an edge-hosted run is measured off the boundary it hosts on', () => {
  const idFactory = sequentialIds();
  const boundary = {
    type: 'deck-boundary',
    id: 'boundary-1',
    vertices: [{ id: 'v1', x: 0, y: 0 }, { id: 'v2', x: 240, y: 0 }],
    edges: [{ id: 'edge-1', startVertexId: 'v1', endVertexId: 'v2' }],
  };
  const hosted = updateRailingSettings(
    createRailingRun({ boundaryId: 'boundary-1', edgeId: 'edge-1' }, 0, 1, {}, idFactory),
    { system: STICK_BUILT_SYSTEM },
  );
  const descriptors = describeTakeoff(documentWith(boundary, hosted));
  assert.equal(lineById(descriptors, 'auto:railing:stick-rail').quantity, 8);
  assert.equal(lineById(descriptors, 'auto:railing:stick-baluster').quantity, 54);
});

test('resolved geometry from the caller wins over the stored anchor points', () => {
  const idFactory = sequentialIds();
  // the host edge was stretched after the run was drawn: 120 in stored, 240 in live
  const document = documentWith(run([0, 0], [120, 0], { system: STICK_BUILT_SYSTEM }, idFactory));
  const live = deriveRailingLineGeometry(document.objects[0], { x: 0, y: 0 }, { x: 240, y: 0 });
  assert.equal(lineById(describeTakeoff(document), 'auto:railing:stick-baluster').quantity, 27, 'stored length is the fallback');
  assert.equal(lineById(describeTakeoff(document, { railingGeometries: [live] }), 'auto:railing:stick-baluster').quantity, 54);
});

test('a run the drawing cannot measure bills nothing rather than a zero-length line', () => {
  const idFactory = sequentialIds();
  // hosted on an edge no boundary in this document owns
  const orphan = updateRailingSettings(
    createRailingRun({ boundaryId: 'boundary-missing', edgeId: 'edge-missing' }, 0, 1, {}, idFactory),
    { system: STICK_BUILT_SYSTEM },
  );
  assert.deepEqual(describeTakeoff(documentWith(orphan)), []);
});

test('an empty document produces no railing material', () => {
  assert.deepEqual(describeTakeoff(createProjectDocument({ id: 'project' })), []);
  assert.deepEqual(describeTakeoff(createProjectDocument({ id: 'project' }), { railingGeometries: [] }), []);
  assert.deepEqual(describeTakeoff({}), [], 'a document with no objects is not a crash');
});

test('nothing handed in is ever mutated', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    run([0, 0], [120, 0], { system: STICK_BUILT_SYSTEM }, idFactory),
    run([120, 0], [120, 120], { system: TREX_SYSTEM }, idFactory),
  );
  const geometries = geometriesFor(document);
  const options = { railingGeometries: geometries, railingPostCount: 6 };
  const documentSnapshot = structuredClone(document);
  const optionsSnapshot = structuredClone(options);

  describeTakeoff(document, options);
  describeTakeoff(document);

  assert.deepEqual(document, documentSnapshot);
  assert.deepEqual(options, optionsSnapshot);
});

test('a gate is a hole in the railing, so it comes out of the footage', () => {
  /* The reason drawing a gate is worth doing. Without this the balusters and
     rail are billed straight across the opening. */
  const ids = sequentialIds();
  const railing = run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, ids);
  const withoutGate = describeTakeoff(documentWith(railing));
  const balustersWithout = withoutGate.find((line) => line.id === 'auto:railing:stick-baluster').quantity;

  const gate = createGate({ at: { x: 120, y: 0 }, widthInches: 36 }, ids);
  const withGate = describeTakeoff(documentWith(railing, gate));
  const balustersWith = withGate.find((line) => line.id === 'auto:railing:stick-baluster').quantity;

  assert.ok(balustersWith < balustersWithout,
    `a 36in gate should reduce the baluster count (${balustersWithout} -> ${balustersWith})`);
  // 240in run less a 36in gate = 204in => ceil(204 / 4.5)
  assert.equal(balustersWith, Math.ceil(204 / 4.5));
});

test('a gate dropped away from any railing is ignored rather than charged to the nearest run', () => {
  const ids = sequentialIds();
  const railing = run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, ids);
  const strayGate = createGate({ at: { x: 120, y: 400 }, widthInches: 36 }, ids);
  const lines = describeTakeoff(documentWith(railing, strayGate));
  assert.equal(lines.find((line) => line.id === 'auto:railing:stick-baluster').quantity,
    Math.ceil(240 / 4.5), 'the run keeps its full length');
});

test('a gate with unusable coordinates never lands on a run', () => {
  const ids = sequentialIds();
  const railing = run([0, 0], [240, 0], { system: STICK_BUILT_SYSTEM }, ids);
  // Number(null) is 0, which used to put this phantom gate at the origin and
  // take 36in off whichever railing was nearest it.
  const broken = { ...createGate({ at: { x: 0, y: 0 }, widthInches: 36 }, ids), at: { x: null, y: null } };
  const lines = describeTakeoff(documentWith(railing, broken));
  assert.equal(lines.find((line) => line.id === 'auto:railing:stick-baluster').quantity,
    Math.ceil(240 / 4.5), 'the run is untouched');
});
