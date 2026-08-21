import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, upsertObject } from '../../core/document/project-document.js';
import { createDeckBoundary } from '../deck-boundary/deck-boundary.js';
import { deriveAutomaticTakeoff, getTakeoffState, setTakeoffState } from './takeoff.js';
import { createBeam, addBeam } from '../beam/beam.js';
import { createJoist, addJoist, arrayObject } from '../joist-group/joist-group.js';
import { createPost, addPost } from '../post-footing/post-footing.js';

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
