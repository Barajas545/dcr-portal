import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, upsertObject } from '../../core/document/project-document.js';
import { createDeckBoundary } from '../deck-boundary/deck-boundary.js';
import { deriveAutomaticTakeoff, getTakeoffState, setTakeoffState } from './takeoff.js';
import { createBeam, addBeam } from '../beam/beam.js';
import { createJoist, addJoist, arrayObject } from '../joist-group/joist-group.js';
import { createPost, addPost } from '../post-footing/post-footing.js';
import { createRailingLine, deriveRailingLineGeometry } from '../railing/railing.js';
import { getRailingRuns } from '../railing/railing-systems.js';

const lineById = (lines, id) => lines.find((line) => line.id === id);

test('framing reaches the material list as counted pieces', () => {
  let document = createProjectDocument({ id: 'p' });
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 216, y: 0 } }));
  const joist = createJoist({ start: { x: 0, y: 0 }, end: { x: 138, y: 0 } });
  document = addJoist(document, joist);
  document = arrayObject(document, joist.id, { spacingInches: 16, count: 7 });

  const lines = deriveAutomaticTakeoff(document);

  const beams = lineById(lines, 'auto:framing:beam');
  assert.equal(beams.quantity, 1, 'one beam drawn');
  assert.equal(beams.unit, 'ea');

  const joists = lineById(lines, 'auto:framing:joist');
  assert.equal(joists.quantity, 8, 'the original plus seven arrayed copies');
  assert.equal(joists.unit, 'ea');

  const hangers = lineById(lines, 'auto:hardware:joist-hanger');
  assert.equal(hangers.quantity, 16, 'both ends of eight joists');
});

test('a post brings its base and its three bags of concrete', () => {
  let document = createProjectDocument({ id: 'p' });
  document = addPost(document, createPost({ at: { x: 0, y: 0 } }));
  document = addPost(document, createPost({ at: { x: 96, y: 0 } }));

  const lines = deriveAutomaticTakeoff(document);
  assert.equal(lineById(lines, 'auto:framing:post').quantity, 2);
  assert.equal(lineById(lines, 'auto:hardware:post-base').quantity, 2, 'one per post');
  assert.equal(lineById(lines, 'auto:framing:concrete-bag').quantity, 6, 'three bags per post');
  assert.equal(lineById(lines, 'auto:hardware:post-base').description, 'Post base / anchor');
});

test('an empty drawing orders no framing at all', () => {
  const lines = deriveAutomaticTakeoff(createProjectDocument({ id: 'p' }));
  for (const id of ['auto:framing:beam', 'auto:framing:joist', 'auto:framing:post',
    'auto:hardware:joist-hanger', 'auto:hardware:post-base', 'auto:framing:concrete-bag']) {
    assert.equal(lineById(lines, id), undefined, `${id} should not appear`);
  }
});

test('deck screws come out at about a box per hundred square feet', () => {
  // 18 ft x 11.5 ft = 207 sq ft -> 3 boxes
  const boundary = createDeckBoundary([
    { x: 0, y: 0 }, { x: 216, y: 0 }, { x: 216, y: 138 }, { x: 0, y: 138 },
  ]);
  const document = upsertObject(createProjectDocument({ id: 'p' }), boundary);
  const lines = deriveAutomaticTakeoff(document);
  assert.equal(lineById(lines, 'auto:hardware:deck-screw').quantity, 3);
});

const gridAnchor = (x, y) => ({ snapType: 'grid', point: { x, y } });
const wildHogRun = (lengthInches, idFactory) =>
  createRailingLine(gridAnchor(0, 0), gridAnchor(lengthInches, 0), { system: 'wild-hog' }, idFactory);
const geometriesFor = (document) => getRailingRuns(document).map((railing) =>
  deriveRailingLineGeometry(railing, railing.anchors.start.point, railing.anchors.end.point));

// a real run, so the post count comes from the layout the app would compute
function deckWithRailing(lengthInches) {
  let n = 0;
  const ids = (prefix) => `${prefix}-${(n += 1)}`;
  const boundary = createDeckBoundary([
    { x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 120 }, { x: 0, y: 120 },
  ]);
  const document = upsertObject(
    upsertObject(createProjectDocument({ id: 'p' }), boundary),
    wildHogRun(lengthInches, ids));
  return { document, railingGeometries: geometriesFor(document) };
}

test('a railing post is ordered as whole boards, never as a cut length', () => {
  /* DCR construction standard: a cut length is not a purchase length. A railing
     post is a 5 ft cut, but no yard sells a 5 ft 4x4 — you buy a 4x4x10 and get
     two posts out of it. "7 posts" is not orderable and 3.5 boards is not a
     thing, so the takeoff resolves the need into whole boards. */
  const { document, railingGeometries } = deckWithRailing(240);
  const lines = deriveAutomaticTakeoff(document, { railingGeometries });
  const posts = lineById(lines, 'auto:railing:wild-hog-post');

  assert.equal(posts.description, '4x4x10 railing post stock', 'the line names what is bought');
  assert.equal(posts.cutPlan.piecesPerStock, 2, 'a 10 ft board yields two 5 ft posts');
  assert.equal(posts.unit, 'ea');
  // whatever the layout needs, the order is whole boards covering it
  assert.equal(posts.quantity, Math.ceil(posts.cutPlan.piecesNeeded / 2));
  assert.equal(Number.isInteger(posts.quantity), true, 'never half a board');
  assert.equal(posts.cutPlan.leftoverCuts, posts.quantity * 2 - posts.cutPlan.piecesNeeded);
  assert.ok(posts.cutPlan.leftoverCuts >= 0 && posts.cutPlan.leftoverCuts < 2);
});

test('an odd post count never orders a fraction of a board', () => {
  // the arithmetic itself, across the awkward cases
  const perStock = 2;
  for (const [needed, boards, leftover] of [[1, 1, 1], [2, 1, 0], [3, 2, 1], [7, 4, 1], [8, 4, 0]]) {
    assert.equal(Math.ceil(needed / perStock), boards, `${needed} posts should buy ${boards} boards`);
    assert.equal(boards * perStock - needed, leftover);
  }
  // and through the real path: every run length, always a whole board that covers the need
  for (const inches of [96, 144, 240, 360, 480]) {
    const { document, railingGeometries } = deckWithRailing(inches);
    const posts = lineById(deriveAutomaticTakeoff(document, { railingGeometries }), 'auto:railing:wild-hog-post');
    assert.equal(Number.isInteger(posts.quantity), true);
    assert.ok(posts.quantity * posts.cutPlan.piecesPerStock >= posts.cutPlan.piecesNeeded,
      `${inches} in: ${posts.quantity} boards must cover ${posts.cutPlan.piecesNeeded} posts`);
    assert.ok((posts.quantity - 1) * posts.cutPlan.piecesPerStock < posts.cutPlan.piecesNeeded,
      `${inches} in: never orders a board more than needed`);
  }
});

test('changing the stock length changes what gets ordered', () => {
  const { document, railingGeometries } = deckWithRailing(240);
  const at16 = setTakeoffState(document, { ...getTakeoffState(document),
    settings: { ...getTakeoffState(document).settings, railingPostStockFeet: 16 } });
  const posts = lineById(deriveAutomaticTakeoff(at16, { railingGeometries }), 'auto:railing:wild-hog-post');
  assert.equal(posts.cutPlan.piecesPerStock, 3, '16 ft yields three 5 ft cuts');
  assert.equal(posts.description, '4x4x16 railing post stock', 'the description follows the standard');
  assert.equal(posts.quantity, Math.ceil(posts.cutPlan.piecesNeeded / 3));
});

test('the shop rules live in settings, so another contractor can change them', () => {
  /* The recipes shipped hardcoded (a box per 100 SF, three stringers a flight,
     5% fascia waste). They are one shop's rules, and the product is for any
     contractor - so they moved into takeoff settings, saved per project. This
     pins that the settings actually steer the math. */
  const boundary = createDeckBoundary([
    { x: 0, y: 0 }, { x: 216, y: 0 }, { x: 216, y: 138 }, { x: 0, y: 138 },
  ]);
  const base = upsertObject(createProjectDocument({ id: 'p' }), boundary);
  const document = setTakeoffState(base, {
    ...getTakeoffState(base),
    settings: { ...getTakeoffState(base).settings, screwBoxCoverageSqFt: 50 },
  });
  const lines = deriveAutomaticTakeoff(document);
  // 207 sq ft at a box per 50 sq ft -> 5 boxes instead of 3
  const screws = lineById(lines, 'auto:hardware:deck-screw');
  assert.equal(screws.quantity, 5);
  assert.match(screws.specification, /50 sq ft/, 'the spec text tells the reader the rule in force');
});
