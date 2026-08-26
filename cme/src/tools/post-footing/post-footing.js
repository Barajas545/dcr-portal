import { upsertObject } from '../../core/document/project-document.js';
import { point } from '../../core/geometry/vector.js';
import { DCR_DEFAULT_POST_BASE } from '../../core/standards/dcr-construction-standard.js';

export const POST_TYPE = 'post';

/* A document handed in from a save, a test, or a half-built state may have
   no objects array at all. Reading through a helper keeps every getter from
   throwing a raw TypeError at a caller that only asked what was on the
   drawing. */
const objectsOf = (document) => (Array.isArray(document?.objects) ? document.objects : []);

export const PILLAR_TYPE = 'pillar';
export const POST_FOOTING_SCHEMA_VERSION = 1;
export const DEFAULT_POST_SIZE = '4x4x8';
export const DEFAULT_MANUAL_FOOTING_SIZE_INCHES = 16;
export const DEFAULT_PILLAR_SIZE_INCHES = 6;
export const CONCRETE_BAGS_PER_POST = 3;
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function markerPoint(at, label) {
  if (![at?.x, at?.y].every(Number.isFinite)) throw new Error(`${label} must be placed at a valid point.`);
  return point(at.x, at.y);
}

export function createPost({ at, size = DEFAULT_POST_SIZE, name, footing = null } = {}, idFactory = defaultId) {
  const footingSizeInches = Number(footing?.sizeInches ?? DEFAULT_MANUAL_FOOTING_SIZE_INCHES);
  const concreteBags = Number(footing?.concreteBags ?? CONCRETE_BAGS_PER_POST);
  if (!(footingSizeInches > 0) || !(concreteBags > 0)) throw new Error('Post footing dimensions and concrete allowance must be positive.');
  return {
    type: POST_TYPE,
    schemaVersion: POST_FOOTING_SCHEMA_VERSION,
    id: idFactory('post'),
    name: name ?? 'Post',
    at: markerPoint(at, 'Post'),
    // A size is a label the estimator picks off a list; nothing is derived from it.
    size: String(size),
    footing: { sizeInches: footingSizeInches, concreteBags },
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
      /* The line name stays the old tool's, so an estimator reads down the same
         rows - but the SPEC only claims a size somebody actually chose.
         "Preliminary quantities must not appear more precise than the model
         supports" is the vision's own guardrail. */
      (() => {
        const sizes = [...new Set(posts.map((post) => post.size).filter(Boolean))];
        return { kind: 'count', id: 'auto:framing:post', category: 'framing', description: '4x4x8 post',
          specification: sizes.length ? sizes.join(' · ') : 'size to confirm',
          quantity: posts.length, sourceObjectIds: postIds,
          ...(sizes.length ? {} : { confidence: 'preliminary' }) };
      })(),
      { kind: 'count', id: 'auto:hardware:post-base', category: 'hardware', description: DCR_DEFAULT_POST_BASE.description, specification: 'One per post · model/size to match post', quantity: posts.length, sourceObjectIds: postIds, confidence: 'preliminary' },
      // Three bags a post is the shop's flat allowance, not a footing volume, so
      // it is flagged preliminary rather than presented as a calculated figure.
      { kind: 'count', id: 'auto:framing:concrete-bag', category: 'framing', description: 'Concrete 60lb bag', specification: 'Modeled footing allowance', quantity: posts.reduce((sum, post) => sum + (Number(post.footing?.concreteBags) || CONCRETE_BAGS_PER_POST), 0), sourceObjectIds: postIds, confidence: 'preliminary' },
    );
  }
  if (pillars.length) {
    // the drawn footprint is real; echo it rather than asserting a catalogue size
    const pillarSizes = [...new Set(pillars.map((pillar) => Number(pillar.dimensions?.sizeInches) || 6))];
    descriptors.push({ kind: 'count', id: 'auto:framing:pillar', category: 'framing', description: '6x6 pillar',
      specification: pillarSizes.map((size) => `${size}″ square`).join(' · '),
      quantity: pillars.length, sourceObjectIds: pillars.map((pillar) => pillar.id) });
  }
  return descriptors;
}
