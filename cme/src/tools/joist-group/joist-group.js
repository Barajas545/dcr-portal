import { distance } from '../../core/geometry/vector.js';
import { upsertObject } from '../../core/document/project-document.js';

export const JOIST_TYPE = 'joist';
export const JOIST_SCHEMA_VERSION = 1;
export const JOIST_STOCK_LENGTH_FEET = 16;
export const ON_CENTRE_SPACINGS = [12, 16, 19.2, 24];
export const DEFAULT_SPACING_INCHES = 16;
export const DEFAULT_COPIES = 8;
export const MAX_COPIES = 200;

const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const point = (value) => ({ x: Number(value.x), y: Number(value.y) });
const joistLength = (joist) => Number(joist.computed?.lengthInches ?? distance(joist.start, joist.end));

function withComputedLength(joist) {
  return { ...joist, computed: { lengthInches: distance(joist.start, joist.end) } };
}

export function createJoist({ start, end, size, name } = {}, idFactory = defaultId) {
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) throw new Error('A joist requires two valid points.');
  if (distance(start, end) < 1e-6) throw new Error('Joist endpoints must be different.');
  return withComputedLength({
    type: JOIST_TYPE,
    schemaVersion: JOIST_SCHEMA_VERSION,
    id: idFactory('joist'),
    name: name ?? 'Joist',
    start: point(start),
    end: point(end),
    // The estimator picks a size off the lumber list; nothing here reads a span table.
    size: size ?? null,
    lifecycle: { phase: 'established', revision: 1 },
  });
}

export function getJoists(document) {
  return document.objects.filter((object) => object.type === JOIST_TYPE);
}

/* Endpoints are re-validated on every write path, not just on create.

   `NaN < 1e-6` is false, so a non-finite coordinate sailed straight through the
   length guard below and stored a joist whose length was NaN. That NaN reached
   the takeoff as a blank quantity, and because JSON.stringify writes NaN as
   null it survived a save and never tripped again. */
function assertFinitePoints(joist) {
  const ok = [joist?.start?.x, joist?.start?.y, joist?.end?.x, joist?.end?.y].every(Number.isFinite);
  if (!ok) throw new Error('A joist requires two valid points.');
}

export function addJoist(document, joist, now = new Date().toISOString()) {
  if (joist?.type !== JOIST_TYPE) throw new Error('A joist is required.');
  // copy the points so a caller editing its own object later cannot reach back
  // into an undo snapshot and change history
  const safe = { ...joist, start: point(joist.start), end: point(joist.end) };
  assertFinitePoints(safe);
  return upsertObject(document, withComputedLength(safe), now);
}

export function updateJoist(document, joistId, patch = {}, now = new Date().toISOString()) {
  const joist = getJoists(document).find((entry) => entry.id === joistId);
  if (!joist) throw new Error('Joist was not found.');
  const updated = withComputedLength({
    ...joist,
    name: patch.name ?? joist.name,
    size: patch.size === undefined ? joist.size : patch.size,
    start: patch.start ? point(patch.start) : joist.start,
    end: patch.end ? point(patch.end) : joist.end,
    lifecycle: { ...joist.lifecycle, revision: (joist.lifecycle?.revision ?? 1) + 1 },
  });
  assertFinitePoints(updated);
  if (!(updated.computed.lengthInches >= 1e-6)) throw new Error('Joist endpoints must be different.');
  return upsertObject(document, updated, now);
}

export function removeJoist(document, joistId, now = new Date().toISOString()) {
  return {
    ...document,
    updatedAt: now,
    objects: document.objects.filter((object) => !(object.type === JOIST_TYPE && object.id === joistId)),
  };
}

function arraySpan(object) {
  const chain = object.vertices ?? object.points ?? [object.start, object.end, object.anchor];
  const points = chain.filter((entry) => Number.isFinite(entry?.x) && Number.isFinite(entry?.y));
  // The old tool ran the direction from the first drawn point to the last one, whatever the item was.
  return points.length ? { start: points[0], end: points.at(-1) } : null;
}

function arrayUnit(object, direction) {
  const span = arraySpan(object);
  if (!span) return null;
  const length = distance(span.start, span.end);
  if (length < 1e-6) return { x: 1, y: 0 };
  const unit = { x: (span.end.x - span.start.x) / length, y: (span.end.y - span.start.y) / length };
  return direction === 'along' ? unit : { x: -unit.y, y: unit.x };
}

function translatePoints(value, dx, dy) {
  if (Array.isArray(value)) return value.map((entry) => translatePoints(entry, dx, dy));
  if (!value || typeof value !== 'object') return value;
  const moved = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translatePoints(entry, dx, dy)]));
  // Every x/y pair in a construction object is a position in the drawing, so the copy moves as one piece.
  return Number.isFinite(value.x) && Number.isFinite(value.y) ? { ...moved, x: value.x + dx, y: value.y + dy } : moved;
}

function arrayCopy(source, dx, dy, idFactory) {
  const { seq, sequence, ...rest } = source;
  return { ...translatePoints(rest, dx, dy), id: idFactory(source.type ?? 'object') };
}

export function arrayObject(document, objectId, options = {}, idFactory = defaultId) {
  const source = document.objects.find((object) => object.id === objectId);
  const spacing = Number(options.spacingInches ?? DEFAULT_SPACING_INCHES);
  const count = Number(options.count ?? DEFAULT_COPIES);
  if (!source || !Number.isFinite(spacing) || spacing <= 0) return document;
  if (!Number.isFinite(count) || count < 1 || count > MAX_COPIES) return document;
  const unit = arrayUnit(source, options.direction ?? 'perpendicular');
  if (!unit) return document;
  // One document for the whole run: the old tool took a single undo snapshot before the loop.
  return {
    ...document,
    updatedAt: options.now ?? new Date().toISOString(),
    objects: [
      ...document.objects,
      ...Array.from({ length: Math.floor(count) }, (_, index) =>
        arrayCopy(source, unit.x * spacing * (index + 1), unit.y * spacing * (index + 1), idFactory)),
    ],
  };
}

export function describeTakeoff(document) {
  const joists = getJoists(document);
  if (!joists.length) return [];
  const sourceObjectIds = joists.map((joist) => joist.id);
  const sizes = [...new Set(joists.map((joist) => joist.size).filter(Boolean))];
  return [
    /* One piece per joist drawn.

       Not a lineal-feet buy off 16 ft stock: that assumes the offcut from one
       joist becomes the next, so eight 12 ft joists would order seven boards
       and the deck would be a joist short. A 16 ft board yields exactly one
       12 ft joist. The tool this replaces counted pieces, and so does this.

       Only what is drawn or arrayed counts - there is no deck-area-divided-by-
       spacing derivation anywhere in the old tool, and adding one would silently
       change every historical estimate. */
    {
      kind: 'count',
      id: 'auto:framing:joist',
      category: 'framing',
      description: 'Joist (size to span)',
      specification: sizes.join(' · ')
        || `${joists.length} drawn · ${Math.round((joists.reduce((sum, joist) => sum + joistLength(joist), 0) / 12) * 10) / 10} lf total`,
      quantity: joists.length,
      sourceObjectIds,
      confidence: 'preliminary',
    },
    {
      kind: 'count',
      id: 'auto:hardware:joist-hanger',
      category: 'hardware',
      description: 'Joist hanger',
      specification: 'Both ends',
      quantity: joists.length * 2,
      sourceObjectIds,
    },
  ];
}
