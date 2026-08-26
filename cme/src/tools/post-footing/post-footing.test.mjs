import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import {
  CONCRETE_BAGS_PER_POST,
  DEFAULT_MANUAL_FOOTING_SIZE_INCHES,
  DEFAULT_PILLAR_SIZE_INCHES,
  DEFAULT_POST_SIZE,
  PILLAR_TYPE,
  POST_TYPE,
  addPost,
  createPillar,
  createPost,
  describeTakeoff,
  getPillars,
  getPosts,
  removePost,
} from './post-footing.js';

let sequence = 0;
const testId = (prefix) => `${prefix}-${sequence += 1}`;
const byId = (descriptors) => new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));

function documentWith(counts) {
  const posts = Array.from({ length: counts.posts ?? 0 }, (_, index) => createPost({ at: { x: index * 96, y: 0 } }, testId));
  const pillars = Array.from({ length: counts.pillars ?? 0 }, (_, index) => createPillar({ at: { x: index * 96, y: 120 } }, testId));
  return [...posts, ...pillars].reduce((document, object) => addPost(document, object), createProjectDocument({ id: 'test-project', now: '2026-01-01T00:00:00.000Z' }));
}

test('four posts and two pillars produce the four lines the old tool produced', () => {
  const lines = byId(describeTakeoff(documentWith({ posts: 4, pillars: 2 })));
  assert.equal(lines.size, 4);
  assert.equal(lines.get('auto:framing:post').quantity, 4);
  assert.equal(lines.get('auto:hardware:post-base').quantity, 4);
  assert.equal(lines.get('auto:framing:concrete-bag').quantity, 12);
  assert.equal(lines.get('auto:framing:pillar').quantity, 2);
});

test('descriptions and categories match the ported list verbatim', () => {
  const lines = byId(describeTakeoff(documentWith({ posts: 1, pillars: 1 })));
  assert.deepEqual(
    [...lines.values()].map((line) => [line.kind, line.category, line.description]),
    [
      ['count', 'framing', '4x4x8 post'],
      ['count', 'hardware', 'Simpson Strong-Tie ABW Post Base'],
      ['count', 'framing', 'Concrete 60lb bag'],
      ['count', 'framing', '6x6 pillar'],
    ],
  );
});

test('three bags per post and nothing else — no footing line is invented', () => {
  const document = documentWith({ posts: 7 });
  const lines = describeTakeoff(document);
  assert.equal(lines.length, 3);
  assert.equal(lines.find((line) => line.id === 'auto:framing:concrete-bag').quantity, 7 * CONCRETE_BAGS_PER_POST);
  assert.equal(lines.some((line) => /footing|tube|diameter|depth/i.test(line.description)), false);
});

test('each line points back at the objects that produced it', () => {
  const document = documentWith({ posts: 2, pillars: 1 });
  const postIds = getPosts(document).map((post) => post.id);
  const pillarIds = getPillars(document).map((pillar) => pillar.id);
  const lines = byId(describeTakeoff(document));
  for (const id of ['auto:framing:post', 'auto:hardware:post-base', 'auto:framing:concrete-bag']) {
    assert.deepEqual(lines.get(id).sourceObjectIds, postIds);
  }
  assert.deepEqual(lines.get('auto:framing:pillar').sourceObjectIds, pillarIds);
});

test('a category with nothing drawn contributes no line', () => {
  assert.deepEqual(describeTakeoff(createProjectDocument({ id: 'empty', now: '2026-01-01T00:00:00.000Z' })), []);
  assert.deepEqual(describeTakeoff(documentWith({ pillars: 3 })).map((line) => line.id), ['auto:framing:pillar']);
  assert.deepEqual(
    describeTakeoff(documentWith({ posts: 1 })).map((line) => line.id),
    ['auto:framing:post', 'auto:hardware:post-base', 'auto:framing:concrete-bag'],
  );
});

test('markers carry the defaults the old tool used', () => {
  const post = createPost({ at: { x: 12, y: 24 } }, testId);
  const pillar = createPillar({ at: { x: 12, y: 24 } }, testId);
  assert.equal(post.type, POST_TYPE);
  assert.equal(post.size, DEFAULT_POST_SIZE);
  assert.deepEqual(post.footing, { sizeInches: DEFAULT_MANUAL_FOOTING_SIZE_INCHES, concreteBags: CONCRETE_BAGS_PER_POST });
  assert.deepEqual(post.at, { x: 12, y: 24 });
  assert.equal(pillar.type, PILLAR_TYPE);
  assert.equal(pillar.dimensions.sizeInches, DEFAULT_PILLAR_SIZE_INCHES);
  assert.equal(DEFAULT_PILLAR_SIZE_INCHES, 6);
});

test('a manually placed post owns its footing and concrete allowance', () => {
  const post = createPost({ at: { x: 48, y: 72 }, footing: { sizeInches: 20, concreteBags: 4 } }, testId);
  const document = addPost(createProjectDocument({ id: 'manual-post-footing' }), post);
  assert.deepEqual(post.footing, { sizeInches: 20, concreteBags: 4 });
  assert.equal(describeTakeoff(document).find((line) => line.id === 'auto:framing:concrete-bag').quantity, 4);
  assert.throws(() => createPost({ at: { x: 0, y: 0 }, footing: { sizeInches: 0 } }, testId), /must be positive/);
});

test('a size is a label, so an odd one still counts as one post', () => {
  const document = addPost(createProjectDocument({ id: 'labels' }), createPost({ at: { x: 0, y: 0 }, size: '6x6x12', name: 'Corner post' }, testId));
  const lines = byId(describeTakeoff(document));
  assert.equal(lines.get('auto:framing:post').quantity, 1);
  assert.equal(lines.get('auto:framing:post').description, '4x4x8 post');
});

test('bad placements are rejected instead of being counted', () => {
  assert.throws(() => createPost({ at: { x: 0 } }, testId), /valid point/);
  assert.throws(() => createPillar({ at: null }, testId), /valid point/);
  assert.throws(() => createPillar({ at: { x: 0, y: 0 }, sizeInches: 0 }, testId), /positive number/);
  assert.throws(() => addPost(createProjectDocument({ id: 'guard' }), { type: 'deck-boundary', id: 'b1' }), /post or a pillar/);
});

test('nothing an argument owns is mutated', () => {
  const at = { x: 5, y: 9 };
  const post = createPost({ at }, testId);
  post.at.x = 999;
  assert.deepEqual(at, { x: 5, y: 9 });

  const document = documentWith({ posts: 2, pillars: 1 });
  const before = JSON.stringify(document);
  describeTakeoff(document);
  assert.equal(JSON.stringify(document), before);

  const added = addPost(document, createPost({ at: { x: 300, y: 0 } }, testId));
  assert.equal(JSON.stringify(document), before);
  assert.equal(added.objects.length, document.objects.length + 1);
  assert.notEqual(added.objects, document.objects);

  const removed = removePost(document, getPosts(document)[0].id);
  assert.equal(JSON.stringify(document), before);
  assert.equal(getPosts(removed).length, 1);
  assert.equal(describeTakeoff(removed).find((line) => line.id === 'auto:framing:concrete-bag').quantity, 3);
});
