import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeam } from './beam.js';
import { deriveBeamGeometry, framingSystem, DEFAULT_FRAMING_SYSTEM } from './beam-geometry.js';

const STANDARD = { beamMaxPostSpacingFeet: 6, footingSizeInches: 16 };
const ids = () => { let n = 0; return (p) => `${p}-${(n += 1)}`; };
const run = (feet, options) => createBeam({ start: { x: 0, y: 0 }, end: { x: feet * 12, y: 0 }, ...options }, ids());

test('a beam derives its posts rather than storing them', () => {
  const beam = run(24);
  // nothing about a post is on the object itself
  assert.equal(beam.posts, undefined);
  assert.equal(JSON.stringify(beam).includes('post'), false);

  const geometry = deriveBeamGeometry(beam, STANDARD);
  assert.equal(geometry.postCount, 5, '24 ft at 6 ft maximum');
  assert.equal(geometry.spans, 4);
  assert.deepEqual(geometry.posts.map((post) => post.x), [0, 72, 144, 216, 288]);
  assert.ok(geometry.posts.every((post) => post.y === 0));
});

test('moving a beam moves its posts, because they were never anywhere else', () => {
  const beam = run(24);
  const moved = { ...beam, start: { x: 100, y: 50 }, end: { x: 388, y: 50 } };
  const before = deriveBeamGeometry(beam, STANDARD);
  const after = deriveBeamGeometry(moved, STANDARD);
  assert.equal(after.postCount, before.postCount, 'same layout');
  assert.deepEqual(after.posts.map((post) => post.x), [100, 172, 244, 316, 388]);
  assert.ok(after.posts.every((post) => post.y === 50));
});

test('the estimator can add posts but never take the run below the standard', () => {
  const beam = run(24);
  const minimum = deriveBeamGeometry(beam, STANDARD).postCount;

  const more = deriveBeamGeometry({ ...beam, settings: { postCountOverride: 7 } }, STANDARD);
  assert.equal(more.postCount, 7, 'an added post is honoured');
  assert.equal(more.postCountAdjusted, true);
  assert.ok(more.spacingInches < 72, 'and the spacing tightens with it');

  const fewer = deriveBeamGeometry({ ...beam, settings: { postCountOverride: 2 } }, STANDARD);
  assert.equal(fewer.postCount, minimum, 'asking for fewer is clamped to the standard');
  assert.equal(fewer.postCountAdjusted, false);
});

test('every derived layout keeps its spans inside the standard', () => {
  for (let feet = 1; feet <= 60; feet += 1) {
    const geometry = deriveBeamGeometry(run(feet), STANDARD);
    assert.ok(geometry.spacingInches <= 72 + 1e-6, `${feet} ft spaced ${geometry.spacingInches}`);
    assert.equal(geometry.posts.length, geometry.postCount);
    assert.equal(Math.round(geometry.posts.at(-1).x), feet * 12, 'a post closes the run');
  }
});

test('the framing system is per beam, with a project default, so a deck can mix', () => {
  assert.equal(framingSystem(run(12)), DEFAULT_FRAMING_SYSTEM, 'unset falls back');
  assert.equal(framingSystem(run(12), 'flush'), 'flush', 'the project default applies');
  const flush = { ...run(12), settings: { framingSystem: 'flush' } };
  assert.equal(framingSystem(flush, 'bottom'), 'flush', 'the beam overrides the project');
  assert.equal(framingSystem({ settings: { framingSystem: 'nonsense' } }), DEFAULT_FRAMING_SYSTEM);

  // the mix: two beams on one deck, each framed its own way
  const dropped = deriveBeamGeometry(run(12), { ...STANDARD, framingSystem: 'bottom' });
  const hung = deriveBeamGeometry(flush, { ...STANDARD, framingSystem: 'bottom' });
  assert.equal(dropped.system, 'bottom');
  assert.equal(hung.system, 'flush');
});

test('nothing is derived from a beam that has no usable geometry', () => {
  assert.equal(deriveBeamGeometry(null, STANDARD), null);
  assert.equal(deriveBeamGeometry({ start: { x: 0, y: 0 } }, STANDARD), null);
  assert.equal(deriveBeamGeometry({ start: { x: 0, y: 0 }, end: { x: NaN, y: 0 } }, STANDARD), null);
});
