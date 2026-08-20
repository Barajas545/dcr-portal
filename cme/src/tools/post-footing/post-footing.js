import { upsertObject } from '../../core/document/project-document.js';
import { point } from '../../core/geometry/vector.js';

export const POST_TYPE = 'post';

/* A document handed in from a save, a test, or a half-built state may have
   no objects array at all. Reading through a helper keeps every getter from
   throwing a raw TypeError at a caller that only asked what was on the
   drawing. */
const objectsOf = (document) => (Array.isArray(document?.objects) ? document.objects : []);

export const PILLAR_TYPE = 'pillar';
export const POST_FOOTING_SCHEMA_VERSION = 1;
export const DEFAULT_POST_SIZE = '4x4x8';
export const DEFAULT_PILLAR_SIZE_INCHES = 6;
export const CONCRETE_BAGS_PER_POST = 3;
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function markerPoint(at, label) {
  if (![at?.x, at?.y].every(Number.isFinite)) throw new Error(`${label} must be placed at a valid point.`);
  return point(at.x, at.y);
}

export function createPost({ at, size = DEFAULT_POST_SIZE, name } = {}, idFactory = defaultId) {
  return {
    type: POST_TYPE,
    schemaVersion: POST_FOOTING_SCHEMA_VERSION,
    id: idFactory('post'),
    name: name ?? 'Post',
    at: markerPoint(at, 'Post'),
    // A size is a label the estimator picks off a list; nothing is derived from it.
    size: String(size),
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function createPillar({ at, sizeInches = DEFAULT_PILLAR_SIZE_INCHES, name } = {}, idFactory = defaultId) {
  const sideInches = Number(sizeInches);
  if (!Number.isFinite(sideInches) || sideInches <= 0) throw new Error('Pillar size must be a positive number of inches.');
  return {
    type: PILLAR_TYPE,
    schemaVersion: POST_FOOTING_SCHEMA_VERSION,
    id: idFactory('pillar'),
    name: name ?? 'Pillar',
    at: markerPoint(at, 'Pillar'),
    // Only the square footprint drawn on the plan; a pillar counts as one either way.
    dimensions: { sizeInches: sideInches },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

// Pillars ride the same add and remove path as posts because they are the same
// family of count-only marker, distinguished only by what gets counted.
export function addPost(document, post, now = new Date().toISOString()) {
  if (![POST_TYPE, PILLAR_TYPE].includes(post?.type)) throw new Error('Only a post or a pillar can be added here.');
  return upsertObject(document, post, now);
}

/* Scoped to posts and pillars on purpose. Filtering the whole document by id
   meant a caller passing the wrong id could delete a deck boundary or a stair
   through the post API and get no complaint about it. */
export function removePost(document, postId, now = new Date().toISOString()) {
  const target = document.objects.find((object) => object.id === postId);
  if (!target || (target.type !== POST_TYPE && target.type !== PILLAR_TYPE)) return document;
  return { ...document, updatedAt: now, objects: objectsOf(document).filter((object) => object.id !== postId) };
}

export function getPosts(document) {
  return objectsOf(document).filter((object) => object.type === POST_TYPE);
}

export function getPillars(document) {
  return objectsOf(document).filter((object) => object.type === PILLAR_TYPE);
}

export function describeTakeoff(document) {
  const posts = getPosts(document);
  const pillars = getPillars(document);
  const postIds = posts.map((post) => post.id);
  const descriptors = [];
  if (posts.length) {
    descriptors.push(
      { kind: 'count', id: 'auto:framing:post', category: 'framing', description: '4x4x8 post', specification: '4×4×8', quantity: posts.length, sourceObjectIds: postIds },
      { kind: 'count', id: 'auto:hardware:post-base', category: 'hardware', description: 'Post base / anchor', specification: 'One per post', quantity: posts.length, sourceObjectIds: postIds },
      // Three bags a post is the shop's flat allowance, not a footing volume, so
      // it is flagged preliminary rather than presented as a calculated figure.
      { kind: 'count', id: 'auto:framing:concrete-bag', category: 'framing', description: 'Concrete 60lb bag', specification: `${CONCRETE_BAGS_PER_POST} bags per post`, quantity: posts.length * CONCRETE_BAGS_PER_POST, sourceObjectIds: postIds, confidence: 'preliminary' },
    );
  }
  if (pillars.length) {
    descriptors.push({ kind: 'count', id: 'auto:framing:pillar', category: 'framing', description: '6x6 pillar', specification: '6×6', quantity: pillars.length, sourceObjectIds: pillars.map((pillar) => pillar.id) });
  }
  return descriptors;
}
