import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import {
  DEFAULT_COPIES,
  DEFAULT_SPACING_INCHES,
  MAX_COPIES,
  ON_CENTRE_SPACINGS,
  addJoist,
  arrayObject,
  createJoist,
  describeTakeoff,
  getJoists,
  removeJoist,
  updateJoist,
} from './joist-group.js';

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
  const [joistLine, hangers] = describeTakeoff(document);

  assert.equal(joistLine.kind, 'count');
  assert.equal(joistLine.id, 'auto:framing:joist');
  assert.equal(joistLine.category, 'framing');
  assert.equal(joistLine.description, 'Joist (size to span)');
  assert.equal(joistLine.quantity, 2, 'two joists drawn is two joists ordered');
  assert.deepEqual(joistLine.sourceObjectIds, getJoists(document).map((joist) => joist.id));

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
  const [joistLine] = describeTakeoff(document);
  assert.equal(joistLine.quantity, 8, 'eight 12 ft joists need eight boards, not seven');
  assert.equal(joistLine.kind, 'count');
  assert.equal(joistLine.stockLengthFeet, undefined, 'no stock length is implied');
  assert.equal(joistLine.requiredLinearFeet, undefined, 'this is not a lineal-feet buy');
});

test('arrayed copies fall straight into the takeoff', () => {
  const source = createJoist({ start: { x: 0, y: 0 }, end: { x: 192, y: 0 } });
  const document = arrayObject(addJoist(emptyDocument(), source), source.id, { spacingInches: 16, count: 3 });
  const [joistLine, hangers] = describeTakeoff(document);
  assert.equal(joistLine.quantity, 4, 'the original plus three copies');
  assert.equal(hangers.quantity, 8, 'two hangers on each');
});

test('the sizes the estimator picked become the specification', () => {
  const document = addJoist(emptyDocument(), createJoist({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 }, size: '2x8x12' }));
  assert.equal(describeTakeoff(document)[0].specification, '2x8x12');
  const mixed = addJoist(document, createJoist({ start: { x: 0, y: 16 }, end: { x: 120, y: 16 }, size: '2x10x16' }));
  assert.equal(describeTakeoff(mixed)[0].specification, '2x8x12 · 2x10x16');
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
