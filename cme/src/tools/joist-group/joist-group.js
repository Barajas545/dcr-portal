import { distance } from '../../core/geometry/vector.js';
import { upsertObject } from '../../core/document/project-document.js';
import { validateJoistBays } from '../../core/standards/california-deck-joist-span.js';

export const JOIST_TYPE = 'joist';
export const JOIST_SCHEMA_VERSION = 1;
export const JOIST_STOCK_LENGTH_FEET = 16;
export const JOIST_STOCK_LENGTHS_FEET = Object.freeze([8, 10, 12, 16, 20]);
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

export function createJoist({ start, end, size, name, layout = null, material = null, reviewIgnored = false } = {}, idFactory = defaultId) {
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
    material: material ? structuredClone(material) : { speciesGroup: 'douglas-fir-larch', grade: 'No. 2', treatment: 'PT' },
    layout: layout ? structuredClone(layout) : null,
    reviewIgnored: Boolean(reviewIgnored),
    lifecycle: { phase: 'established', revision: 1 },
  });
}

export function planJoistStock(lengthInches, stockLengthsFeet = JOIST_STOCK_LENGTHS_FEET) {
  const requiredFeet = Number(lengthInches) / 12;
  if (!(requiredFeet > 0)) return null;
  const lengths = [...new Set(stockLengthsFeet.map(Number).filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
  const stockLengthFeet = lengths.find((value) => value + 1e-8 >= requiredFeet) ?? null;
  return {
    requiredFeet,
    stockLengthFeet,
    wasteFeet: stockLengthFeet === null ? null : stockLengthFeet - requiredFeet,
    needsReview: stockLengthFeet === null,
  };
}

export function analyzeJoist(joist) {
  const lengthInches = joistLength(joist);
  const bays = joist?.layout?.bays ?? [{ start: joist.start, end: joist.end, lengthInches }];
  return {
    lengthInches,
    stock: planJoistStock(lengthInches),
    spanValidation: validateJoistBays({
      bays,
      size: joist?.size,
      spacingInches: joist?.layout?.spacingInches ?? DEFAULT_SPACING_INCHES,
      speciesGroup: joist?.material?.speciesGroup ?? 'douglas-fir-larch',
    }),
  };
}

export function getJoists(document) {
  return document.objects.filter((object) => object.type === JOIST_TYPE);
}

export function consolidateJoistRuns(document) {
  const joists = getJoists(document);
  const grouped = new Map();
  joists.forEach((joist) => {
    const fieldId = joist.layout?.fieldId;
    if (!fieldId || joist.layout?.bays?.length) return;
    const length = distance(joist.start, joist.end);
    if (length < 1e-6) return;
    let unit = { x: (joist.end.x - joist.start.x) / length, y: (joist.end.y - joist.start.y) / length };
    if (unit.x < -1e-6 || (Math.abs(unit.x) <= 1e-6 && unit.y < 0)) unit = { x: -unit.x, y: -unit.y };
    const angleKey = Math.round(Math.atan2(unit.y, unit.x) * 10000);
    const offsetKey = Math.round((unit.x * joist.start.y - unit.y * joist.start.x) * 4);
    const key = `${fieldId}:${joist.layout?.boundaryId ?? ''}:${joist.size ?? ''}:${angleKey}:${offsetKey}`;
    const group = grouped.get(key) ?? { unit, entries: [] };
    group.entries.push(joist);
    grouped.set(key, group);
  });
  const replacements = new Map();
  const removed = new Set();
  grouped.forEach(({ unit, entries }) => {
    if (entries.length < 2) return;
    const projected = entries.map((joist) => {
      const a = joist.start.x * unit.x + joist.start.y * unit.y;
      const b = joist.end.x * unit.x + joist.end.y * unit.y;
      return { joist, from: Math.min(a, b), to: Math.max(a, b), start: a <= b ? joist.start : joist.end, end: a <= b ? joist.end : joist.start };
    }).sort((a, b) => a.from - b.from);
    const clusters = [];
    projected.forEach((entry) => {
      const cluster = clusters.at(-1);
      if (!cluster || entry.from > cluster.to + .5) clusters.push({ entries: [entry], from: entry.from, to: entry.to });
      else { cluster.entries.push(entry); cluster.to = Math.max(cluster.to, entry.to); }
    });
    clusters.filter((cluster) => cluster.entries.length > 1).forEach((cluster) => {
      const first = cluster.entries[0];
      const last = cluster.entries.at(-1);
      const bays = cluster.entries.map((entry) => ({
        start: entry.start, end: entry.end, lengthInches: distance(entry.start, entry.end),
        startSupportId: entry.joist.layout?.startSupportId ?? null,
        endSupportId: entry.joist.layout?.endSupportId ?? null,
      }));
      const merged = withComputedLength({
        ...first.joist,
        start: first.start,
        end: last.end,
        layout: {
          ...first.joist.layout,
          startSupportId: bays[0].startSupportId,
          endSupportId: bays.at(-1).endSupportId,
          bays,
          spanValidation: validateJoistBays({ bays, size: first.joist.size, spacingInches: first.joist.layout?.spacingInches ?? DEFAULT_SPACING_INCHES, speciesGroup: first.joist.material?.speciesGroup ?? 'douglas-fir-larch' }),
          consolidatedFrom: cluster.entries.map((entry) => entry.joist.id),
        },
      });
      replacements.set(first.joist.id, merged);
      cluster.entries.slice(1).forEach((entry) => removed.add(entry.joist.id));
    });
  });
  if (!replacements.size) return document;
  return {
    ...document,
    objects: document.objects.flatMap((object) => removed.has(object.id) ? [] : [replacements.get(object.id) ?? object]),
  };
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
    material: patch.material === undefined ? joist.material : structuredClone(patch.material),
    reviewIgnored: patch.reviewIgnored === undefined ? joist.reviewIgnored : Boolean(patch.reviewIgnored),
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
  /* `at` is in this list because posts, pillars, gates and count pins anchor
     themselves there rather than at start/end. Without it arraySpan found no
     points, arrayUnit returned null, and arrayObject bailed out returning the
     document unchanged — silently, so repeating a row of footings looked like
     a dead button. A single anchor gives a zero-length span, which falls
     through to the sideways direction below, matching how the old tool arrayed
     a post. */
  const chain = object.vertices ?? object.points
    ?? [object.start, object.end, object.anchor, object.at,
        object.computed?.start, object.computed?.end];
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

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

function pointInPolygon(candidate, polygon) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const a = polygon[current];
    const b = polygon[previous];
    const onEdge = Math.abs(cross({ x: candidate.x - a.x, y: candidate.y - a.y }, { x: b.x - a.x, y: b.y - a.y })) < 1e-6
      && candidate.x >= Math.min(a.x, b.x) - 1e-6 && candidate.x <= Math.max(a.x, b.x) + 1e-6
      && candidate.y >= Math.min(a.y, b.y) - 1e-6 && candidate.y <= Math.max(a.y, b.y) + 1e-6;
    if (onEdge) return true;
    const crosses = (a.y > candidate.y) !== (b.y > candidate.y)
      && candidate.x < ((b.x - a.x) * (candidate.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function segmentIntersectionT(start, end, edgeStart, edgeEnd) {
  const run = { x: end.x - start.x, y: end.y - start.y };
  const edge = { x: edgeEnd.x - edgeStart.x, y: edgeEnd.y - edgeStart.y };
  const denominator = cross(run, edge);
  if (Math.abs(denominator) < 1e-8) return null;
  const delta = { x: edgeStart.x - start.x, y: edgeStart.y - start.y };
  const t = cross(delta, edge) / denominator;
  const u = cross(delta, run) / denominator;
  return t >= -1e-8 && t <= 1 + 1e-8 && u >= -1e-8 && u <= 1 + 1e-8 ? Math.max(0, Math.min(1, t)) : null;
}

export function clipLinearMemberToPolygon(start, end, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [{ start: point(start), end: point(end) }];
  const values = [0, 1];
  polygon.forEach((edgeStart, index) => {
    const t = segmentIntersectionT(start, end, edgeStart, polygon[(index + 1) % polygon.length]);
    if (t !== null) values.push(t);
  });
  const sorted = [...new Set(values.map((value) => Number(value.toFixed(8))))].sort((a, b) => a - b);
  const intervals = [];
  const clean = (value) => {
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const interpolate = (t) => ({
    x: clean(start.x + (end.x - start.x) * t),
    y: clean(start.y + (end.y - start.y) * t),
  });
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index];
    const to = sorted[index + 1];
    if (to - from < 1e-8) continue;
    const midpoint = (from + to) / 2;
    const sample = { x: start.x + (end.x - start.x) * midpoint, y: start.y + (end.y - start.y) * midpoint };
    if (!pointInPolygon(sample, polygon)) continue;
    intervals.push({
      start: interpolate(from),
      end: interpolate(to),
    });
  }
  return intervals.filter((interval) => distance(interval.start, interval.end) >= 1e-6);
}

/**
 * Resolve Rim / Flush edges from every Deck Boundary that physically pass
 * through the selected DB. A neighboring deck may own the member, but the
 * same built object can support joists approaching from either side.
 * Geometry is clipped to the selected DB so it never expands that field's
 * modeling scope or creates framing outside its authoritative polygon.
 */
export function deriveSharedRimFlushSupports(boundaries = [], targetBoundary = null) {
  if (!targetBoundary?.id || !Array.isArray(targetBoundary.vertices) || targetBoundary.vertices.length < 3) return [];
  return boundaries.flatMap((sourceBoundary) => {
    const verticesById = new Map((sourceBoundary?.vertices ?? []).map((vertex) => [vertex.id, vertex]));
    return (sourceBoundary?.edges ?? []).flatMap((edge) => {
      const rimJoist = edge?.properties?.attachments?.rimJoist;
      if (!rimJoist || rimJoist.enabled === false) return [];
      const start = verticesById.get(edge.startVertexId);
      const end = verticesById.get(edge.endVertexId);
      if (!start || !end) return [];
      return clipLinearMemberToPolygon(start, end, targetBoundary.vertices).map((segment, index, segments) => ({
        id: segments.length === 1 ? edge.id : `${edge.id}:${targetBoundary.id}:${index}`,
        ownerId: edge.id,
        sourceBoundaryId: sourceBoundary.id,
        targetBoundaryId: targetBoundary.id,
        type: 'rim-flush',
        shared: sourceBoundary.id !== targetBoundary.id,
        plyCount: Number(rimJoist.plyCount) === 2 ? 2 : 1,
        start: segment.start,
        end: segment.end,
      }));
    });
  });
}

function closestIntervalToHost(intervals, hostPoint) {
  return intervals
    .map((interval) => {
      const reverse = distance(interval.end, hostPoint) < distance(interval.start, hostPoint);
      const oriented = reverse ? { start: interval.end, end: interval.start } : interval;
      return { ...oriented, hostDistance: distance(oriented.start, hostPoint) };
    })
    .sort((a, b) => a.hostDistance - b.hostDistance)[0] ?? null;
}

/**
 * Derive one live joist field from a structural host and a perpendicular drag.
 * The touched host point establishes the layout origin. Joists then populate in
 * both directions at the selected O.C. spacing and are clipped to the Deck
 * Boundary. The result is geometry only; callers decide when to establish it.
 */
export function deriveJoistField({ boundary, hostStart, hostEnd, origin, toward, spacingInches = DEFAULT_SPACING_INCHES, size = '2×6 PT', host = null, fillBoundary = false, supports = [] } = {}) {
  const polygon = boundary?.vertices;
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  if (![hostStart?.x, hostStart?.y, hostEnd?.x, hostEnd?.y, origin?.x, origin?.y, toward?.x, toward?.y].every(Number.isFinite)) return null;
  const hostLength = distance(hostStart, hostEnd);
  const spacing = Number(spacingInches);
  if (!(hostLength > 1e-6) || !(spacing > 0)) return null;
  const unit = { x: (hostEnd.x - hostStart.x) / hostLength, y: (hostEnd.y - hostStart.y) / hostLength };
  const originProjection = Math.max(0, Math.min(hostLength, (origin.x - hostStart.x) * unit.x + (origin.y - hostStart.y) * unit.y));
  const projectedOrigin = { x: hostStart.x + unit.x * originProjection, y: hostStart.y + unit.y * originProjection };
  const normalA = { x: -unit.y, y: unit.x };
  const dragProjection = (toward.x - projectedOrigin.x) * normalA.x + (toward.y - projectedOrigin.y) * normalA.y;
  const direction = dragProjection < 0 ? { x: -normalA.x, y: -normalA.y } : normalA;
  const runInches = Math.abs(dragProjection);
  if (fillBoundary) return deriveBoundaryJoistField({ boundary, lateral: unit, direction, origin: projectedOrigin, spacing, size, host, supports, runInches });
  if (runInches < 1) return { joists: [], origin: projectedOrigin, direction, runInches, spacingInches: spacing, needsReviewCount: 0 };

  const positions = [originProjection];
  for (let offset = spacing; originProjection + offset <= hostLength + 1e-6; offset += spacing) positions.push(originProjection + offset);
  for (let offset = spacing; originProjection - offset >= -1e-6; offset += spacing) positions.push(originProjection - offset);
  positions.sort((a, b) => a - b);

  const joists = positions.flatMap((position) => {
    const start = { x: hostStart.x + unit.x * position, y: hostStart.y + unit.y * position };
    const end = { x: start.x + direction.x * runInches, y: start.y + direction.y * runInches };
    const interval = closestIntervalToHost(clipLinearMemberToPolygon(start, end, polygon), start);
    if (!interval || interval.hostDistance > 1) return [];
    const lengthInches = distance(interval.start, interval.end);
    if (lengthInches < 1) return [];
    const stock = planJoistStock(lengthInches);
    return [{ start: interval.start, end: interval.end, size, stock, layout: { kind: 'joist-field', boundaryId: boundary.id, host, spacingInches: spacing } }];
  });
  return {
    joists,
    origin: projectedOrigin,
    direction,
    runInches,
    spacingInches: spacing,
    needsReviewCount: joists.filter((joist) => joist.stock.needsReview).length,
  };
}

function joistFieldAxes(joist) {
  const length = distance(joist?.start, joist?.end);
  if (!(length > 1e-6)) return null;
  const direction = {
    x: (joist.end.x - joist.start.x) / length,
    y: (joist.end.y - joist.start.y) / length,
  };
  return { direction, lateral: { x: -direction.y, y: direction.x } };
}

function joistMidpoint(joist) {
  return { x: (joist.start.x + joist.end.x) / 2, y: (joist.start.y + joist.end.y) / 2 };
}

function fieldScalar(joist, lateral) {
  const middle = joistMidpoint(joist);
  return middle.x * lateral.x + middle.y * lateral.y;
}

function establishedFieldJoist(spec, source, layout, idFactory) {
  const created = createJoist({
    start: spec.start,
    end: spec.end,
    size: source.size,
    name: source.name,
    material: source.material,
    reviewIgnored: source.reviewIgnored,
    layout: { ...spec.layout, ...layout },
  }, idFactory);
  return {
    ...created,
    lifecycle: {
      ...created.lifecycle,
      revision: (source.lifecycle?.revision ?? 1) + 1,
    },
  };
}

function supportedFieldAt({ boundary, source, origin, supports, spacingInches }) {
  const axes = joistFieldAxes(source);
  if (!axes) return null;
  return deriveBoundaryJoistField({
    boundary,
    lateral: axes.lateral,
    direction: axes.direction,
    origin,
    spacing: spacingInches,
    size: source.size,
    host: source.layout?.host ?? null,
    supports,
    runInches: 12,
  });
}

/**
 * Move the phase of one complete Joist Field. Standard members are regenerated
 * against the Deck Boundary and its current supports; manually inserted parallel
 * members retain their offset from the mesh and move by the same amount.
 */
export function moveJoistField(document, fieldId, { boundary, supports = [], offsetInches = 0 } = {}, idFactory = defaultId) {
  const field = getJoists(document).filter((joist) => joist.layout?.fieldId === fieldId);
  const source = field.find((joist) => !joist.layout?.manualParallel) ?? field[0];
  const axes = joistFieldAxes(source);
  const offset = Number(offsetInches);
  if (!source || !axes || !boundary || !Number.isFinite(offset)) return { document, joists: field, changed: false };
  const spacingInches = Number(source.layout?.spacingInches ?? DEFAULT_SPACING_INCHES);
  const regular = field.filter((joist) => !joist.layout?.manualParallel);
  const manual = field.filter((joist) => joist.layout?.manualParallel);
  const shiftedOrigin = joistMidpoint(source);
  shiftedOrigin.x += axes.lateral.x * offset;
  shiftedOrigin.y += axes.lateral.y * offset;
  const derived = supportedFieldAt({ boundary, source, origin: shiftedOrigin, supports, spacingInches });
  const regularSpecs = derived?.joists?.filter((joist) => joist.supported) ?? [];

  const unused = new Set(regular.map((joist) => joist.id));
  const expected = regular.map((joist) => ({ joist, scalar: fieldScalar(joist, axes.lateral) + offset }));
  const establishedRegular = regularSpecs.map((spec) => {
    const scalar = fieldScalar(spec, axes.lateral);
    const match = expected
      .filter((entry) => unused.has(entry.joist.id))
      .sort((a, b) => Math.abs(a.scalar - scalar) - Math.abs(b.scalar - scalar))[0];
    const reusable = match && Math.abs(match.scalar - scalar) <= spacingInches * .55 ? match.joist : null;
    if (reusable) unused.delete(reusable.id);
    const identity = reusable ?? source;
    return establishedFieldJoist(spec, identity, {
      fieldId,
      meshRole: 'regular',
      manualParallel: false,
      lockedToMesh: true,
    }, reusable ? () => reusable.id : idFactory);
  });

  const boundaryRange = Math.max(...boundary.vertices.map((vertex) => vertex.x), ...boundary.vertices.map((vertex) => vertex.y))
    - Math.min(...boundary.vertices.map((vertex) => vertex.x), ...boundary.vertices.map((vertex) => vertex.y));
  const manualSpacing = Math.max(1000, boundaryRange * 4);
  const establishedManual = manual.flatMap((joist) => {
    const origin = joistMidpoint(joist);
    origin.x += axes.lateral.x * offset;
    origin.y += axes.lateral.y * offset;
    const single = supportedFieldAt({ boundary, source: joist, origin, supports, spacingInches: manualSpacing })?.joists?.find((entry) => entry.supported);
    if (!single) return [];
    return [establishedFieldJoist(single, joist, {
      fieldId,
      spacingInches,
      meshRole: 'manual-parallel',
      manualParallel: true,
      lockedToMesh: true,
    }, () => joist.id)];
  });

  const fieldIds = new Set(field.map((joist) => joist.id));
  const combined = [...establishedRegular, ...establishedManual];
  const joists = combined.map((joist) => {
    if (!joist.layout?.manualParallel) return joist;
    const scalar = fieldScalar(joist, axes.lateral);
    const neighbors = combined.filter((entry) => entry.id !== joist.id)
      .map((entry) => ({ joist: entry, distance: Math.abs(fieldScalar(entry, axes.lateral) - scalar) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 2);
    return {
      ...joist,
      layout: {
        ...joist.layout,
        neighborJoistIds: neighbors.map((entry) => entry.joist.id),
        neighborDistancesInches: neighbors.map((entry) => Number(entry.distance.toFixed(3))),
      },
    };
  });
  return {
    document: {
      ...document,
      updatedAt: new Date().toISOString(),
      objects: [...document.objects.filter((object) => !fieldIds.has(object.id)), ...joists],
    },
    joists,
    changed: true,
  };
}

/**
 * Regenerate one complete Joist Field after an array-level material or spacing
 * change. No single member can silently diverge from the field specification.
 */
export function updateJoistField(document, fieldId, { boundary, supports = [], spacingInches, size, material } = {}, idFactory = defaultId) {
  const current = getJoists(document).filter((joist) => joist.layout?.fieldId === fieldId);
  const spacing = Number(spacingInches ?? current[0]?.layout?.spacingInches ?? DEFAULT_SPACING_INCHES);
  if (!current.length || !boundary || !Number.isFinite(spacing) || spacing < 1 || spacing > 48) {
    return { document, joists: current, changed: false, reason: 'Joist spacing must be between 1 and 48 inches.' };
  }
  const patchedIds = new Set(current.map((joist) => joist.id));
  const patched = {
    ...document,
    objects: document.objects.map((object) => patchedIds.has(object.id) ? {
      ...object,
      size: size ?? object.size,
      material: material ? structuredClone(material) : object.material,
      reviewIgnored: false,
      layout: { ...object.layout, spacingInches: spacing },
    } : object),
  };
  const result = moveJoistField(patched, fieldId, { boundary, supports, offsetInches: 0 }, idFactory);
  if (!result.changed || !result.joists.length) return { document, joists: current, changed: false, reason: 'The Joist Field could not be regenerated inside this Deck Boundary.' };
  const profile = String(size ?? '').match(/^2\s*[x×]\s*(6|8|10|12)\b/i);
  if (!profile) return { ...result, reason: null };

  const depthInches = Number(profile[1]);
  const syncedDocument = {
    ...result.document,
    objects: result.document.objects.map((object) => {
      if (object.type !== 'deck-boundary' || object.id !== boundary.id) return object;
      return {
        ...object,
        edges: object.edges.map((edge) => {
          const rimJoist = edge.properties?.attachments?.rimJoist;
          if (!rimJoist || rimJoist.enabled === false) return edge;
          return {
            ...edge,
            properties: {
              ...edge.properties,
              attachments: {
                ...edge.properties.attachments,
                rimJoist: {
                  ...rimJoist,
                  enabled: true,
                  preset: `2x${depthInches}`,
                  widthInches: 2,
                  depthInches,
                  treatment: 'PT',
                  customLabel: '',
                },
              },
            },
          };
        }),
      };
    }),
  };
  return { ...result, document: syncedDocument, reason: null };
}

/** Remove the complete array and its field-owned Blocking settings. */
export function removeJoistField(document, fieldId) {
  const belongsToField = (object) => (object.type === JOIST_TYPE && object.layout?.fieldId === fieldId)
    || (object.type === 'joist-blocking-layout' && object.fieldId === fieldId);
  const removed = document.objects.filter(belongsToField);
  if (!removed.length) return document;
  return {
    ...document,
    updatedAt: new Date().toISOString(),
    objects: document.objects.filter((object) => !belongsToField(object)),
  };
}

/** Add one supported, boundary-clipped member that remains locked to a field. */
export function addParallelJoistToField(document, fieldId, { boundary, supports = [], point: requestedPoint } = {}, idFactory = defaultId) {
  const field = getJoists(document).filter((joist) => joist.layout?.fieldId === fieldId);
  const source = field.find((joist) => !joist.layout?.manualParallel) ?? field[0];
  const axes = joistFieldAxes(source);
  if (!source || !axes || !boundary || !pointInPolygon(requestedPoint, boundary.vertices)) return { document, joist: null, reason: 'Point must be inside the selected Deck Boundary.' };
  const spacingInches = Number(source.layout?.spacingInches ?? DEFAULT_SPACING_INCHES);
  const boundaryRange = Math.max(...boundary.vertices.map((vertex) => vertex.x), ...boundary.vertices.map((vertex) => vertex.y))
    - Math.min(...boundary.vertices.map((vertex) => vertex.x), ...boundary.vertices.map((vertex) => vertex.y));
  const derived = supportedFieldAt({ boundary, source, origin: requestedPoint, supports, spacingInches: Math.max(1000, boundaryRange * 4) });
  const spec = derived?.joists?.find((entry) => entry.supported);
  if (!spec) return { document, joist: null, reason: 'No supported joist run crosses that point.' };
  const scalar = fieldScalar(spec, axes.lateral);
  const neighbors = field.map((joist) => ({ joist, distance: Math.abs(fieldScalar(joist, axes.lateral) - scalar) }))
    .sort((a, b) => a.distance - b.distance);
  if (neighbors[0]?.distance < .5) return { document, joist: null, reason: 'A joist already occupies that position.' };
  const joist = establishedFieldJoist(spec, source, {
    fieldId,
    spacingInches,
    meshRole: 'manual-parallel',
    manualParallel: true,
    lockedToMesh: true,
    neighborJoistIds: neighbors.slice(0, 2).map((entry) => entry.joist.id),
    neighborDistancesInches: neighbors.slice(0, 2).map((entry) => Number(entry.distance.toFixed(3))),
  }, idFactory);
  return { document: addJoist(document, joist), joist, reason: null };
}

function deriveBoundaryJoistField({ boundary, lateral, direction, origin, spacing, size, host, supports, runInches }) {
  if (runInches < 1) return { joists: [], origin, direction, runInches, spacingInches: spacing, needsReviewCount: 0, unsupportedCount: 0 };
  const dot = (pointValue, axis) => pointValue.x * axis.x + pointValue.y * axis.y;
  const lateralValues = boundary.vertices.map((vertex) => dot(vertex, lateral));
  const directionValues = boundary.vertices.map((vertex) => dot(vertex, direction));
  const minLateral = Math.min(...lateralValues);
  const maxLateral = Math.max(...lateralValues);
  const minDirection = Math.min(...directionValues) - 2;
  const maxDirection = Math.max(...directionValues) + 2;
  const originLateral = dot(origin, lateral);
  const positions = [originLateral];
  for (let offset = spacing; originLateral + offset <= maxLateral + 1e-6; offset += spacing) positions.push(originLateral + offset);
  for (let offset = spacing; originLateral - offset >= minLateral - 1e-6; offset += spacing) positions.push(originLateral - offset);
  positions.sort((a, b) => a - b);

  const joists = positions.flatMap((lateralPosition) => {
    const axisStart = {
      x: lateral.x * lateralPosition + direction.x * minDirection,
      y: lateral.y * lateralPosition + direction.y * minDirection,
    };
    const axisEnd = {
      x: lateral.x * lateralPosition + direction.x * maxDirection,
      y: lateral.y * lateralPosition + direction.y * maxDirection,
    };
    const intervals = clipLinearMemberToPolygon(axisStart, axisEnd, boundary.vertices);
    return intervals.flatMap((interval) => {
      const from = dot(interval.start, direction);
      const to = dot(interval.end, direction);
      const lower = Math.min(from, to) - 1e-5;
      const upper = Math.max(from, to) + 1e-5;
      const hits = supports.flatMap((support) => {
        const t = segmentIntersectionT(axisStart, axisEnd, support.start, support.end);
        if (t === null) return [];
        const pointValue = { x: axisStart.x + (axisEnd.x - axisStart.x) * t, y: axisStart.y + (axisEnd.y - axisStart.y) * t };
        const scalar = dot(pointValue, direction);
        return scalar >= lower && scalar <= upper ? [{ point: pointValue, scalar, support }] : [];
      }).sort((a, b) => a.scalar - b.scalar)
        .filter((hit, index, list) => index === 0 || Math.abs(hit.scalar - list[index - 1].scalar) > .25);
      if (hits.length < 2) {
        const lengthInches = distance(interval.start, interval.end);
        return lengthInches < 1 ? [] : [{ start: interval.start, end: interval.end, size, supported: false, stock: planJoistStock(lengthInches), layout: { kind: 'joist-field', boundaryId: boundary.id, host, spacingInches: spacing } }];
      }
      const bays = hits.slice(0, -1).flatMap((hit, index) => {
        const next = hits[index + 1];
        const lengthInches = distance(hit.point, next.point);
        if (lengthInches < 1) return [];
        return [{ start: hit.point, end: next.point, lengthInches, startSupportId: hit.support.id, endSupportId: next.support.id }];
      });
      if (!bays.length) return [];
      // A beam is an intermediate bearing, not an automatic cut. Preserve the
      // supported bays for span validation while drawing/buying one continuous
      // joist wherever commercial lumber can make the complete run.
      const runStart = bays[0].start;
      const runEnd = bays.at(-1).end;
      const lengthInches = distance(runStart, runEnd);
      const validation = validateJoistBays({ bays, size, spacingInches: spacing });
      return [{
        start: runStart,
        end: runEnd,
        size,
        supported: true,
        stock: planJoistStock(lengthInches),
        layout: {
          kind: 'joist-field', boundaryId: boundary.id, host, spacingInches: spacing,
          startSupportId: bays[0].startSupportId,
          endSupportId: bays.at(-1).endSupportId,
          bays,
          spanValidation: validation,
        },
      }];
    });
  });
  return {
    joists,
    origin,
    direction,
    runInches,
    spacingInches: spacing,
    needsReviewCount: joists.filter((joist) => joist.supported && (joist.stock.needsReview || joist.layout?.spanValidation?.valid !== true)).length,
    unsupportedCount: joists.filter((joist) => !joist.supported).length,
  };
}

function clippedCopies(source, unit, spacing, count, sign, polygon, idFactory) {
  const copies = [];
  for (let index = 0; index < Math.floor(count); index += 1) {
    const offset = spacing * (index + 1) * sign;
    const moved = arrayCopy(source, unit.x * offset, unit.y * offset, idFactory);
    if (!polygon || !moved.start || !moved.end) {
      copies.push(moved);
      continue;
    }
    clipLinearMemberToPolygon(moved.start, moved.end, polygon).forEach((segment, segmentIndex) => {
      copies.push(withComputedLength({
        ...moved,
        id: segmentIndex === 0 ? moved.id : idFactory(source.type ?? 'object'),
        start: segment.start,
        end: segment.end,
      }));
    });
  }
  return copies;
}

export function arrayObject(document, objectId, options = {}, idFactory = defaultId) {
  const source = document.objects.find((object) => object.id === objectId);
  const spacing = Number(options.spacingInches ?? DEFAULT_SPACING_INCHES);
  const count = Number(options.count ?? DEFAULT_COPIES);
  if (!source || !Number.isFinite(spacing) || spacing <= 0) return document;
  if (!Number.isFinite(count) || count < 1 || count > MAX_COPIES) return document;
  const unit = arrayUnit(source, options.direction ?? 'perpendicular');
  if (!unit) return document;
  const clipPolygon = Array.isArray(options.clipPolygon) && options.clipPolygon.length >= 3 ? options.clipPolygon : null;
  let copies;
  if (clipPolygon && source.start && source.end) {
    // Try both sides of the source member. The side that produces the most
    // usable framing inside the selected deck wins, so Repeat never sprays
    // joists into open space merely because the member was drawn backwards.
    const plus = clippedCopies(source, unit, spacing, count, 1, clipPolygon, idFactory);
    const minus = clippedCopies(source, unit, spacing, count, -1, clipPolygon, idFactory);
    const totalLength = (entries) => entries.reduce((sum, entry) => sum + distance(entry.start, entry.end), 0);
    copies = totalLength(minus) > totalLength(plus) ? minus : plus;
  } else {
    copies = clippedCopies(source, unit, spacing, count, 1, null, idFactory);
  }
  // One document for the whole run: the old tool took a single undo snapshot before the loop.
  return {
    ...document,
    updatedAt: options.now ?? new Date().toISOString(),
    objects: [
      ...document.objects,
      ...copies,
    ],
  };
}

export function describeTakeoff(document) {
  const joists = getJoists(document);
  if (!joists.length) return [];
  const sourceObjectIds = joists.map((joist) => joist.id);
  const groups = new Map();
  joists.forEach((joist) => {
    const lengthInches = joistLength(joist);
    const stock = planJoistStock(lengthInches);
    const size = joist.size || 'Size to span';
    const cutInches = Math.ceil(lengthInches * 4) / 4;
    const key = stock?.stockLengthFeet ? size : `${size}:review:${cutInches}`;
    const group = groups.get(key) ?? { size, review: !stock?.stockLengthFeet, cuts: [], maxCutInches: 0, sourceObjectIds: [] };
    group.cuts.push({ inches: cutInches, sourceObjectId: joist.id });
    group.maxCutInches = Math.max(group.maxCutInches, cutInches);
    group.sourceObjectIds.push(joist.id);
    groups.set(key, group);
  });
  const materials = [...groups.entries()].flatMap(([key, group]) => {
    if (group.review) return [{
      kind: 'count', id: `auto:framing:joist:${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, category: 'framing',
      description: `${group.size} joist`, specification: `${(group.maxCutInches / 12).toFixed(2)} ft continuous run · exceeds 20 ft commercial stock · REVIEW`,
      quantity: group.cuts.length, stockLengthFeet: null, sourceObjectIds: group.sourceObjectIds, confidence: 'review',
    }];
    const boards = packJoistCuts(group.cuts);
    const byLength = new Map();
    boards.forEach((board) => {
      const entry = byLength.get(board.lengthFeet) ?? { quantity: 0, cuts: [], sourceObjectIds: new Set() };
      entry.quantity += 1;
      entry.cuts.push(...board.cuts.map((cut) => cut.inches));
      board.cuts.forEach((cut) => entry.sourceObjectIds.add(cut.sourceObjectId));
      byLength.set(board.lengthFeet, entry);
    });
    return [...byLength.entries()].map(([lengthFeet, entry]) => ({
      kind: 'count', id: `auto:framing:joist:${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${lengthFeet}`, category: 'framing',
      description: `${group.size} joist`,
      specification: `${lengthFeet} ft stock · ${entry.cuts.length} continuous cut${entry.cuts.length === 1 ? '' : 's'} optimized from offcuts`,
      quantity: entry.quantity, stockLengthFeet: lengthFeet, sourceObjectIds: [...entry.sourceObjectIds], confidence: 'preliminary',
    }));
  });
  return [
    ...materials,
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

export function packJoistCuts(cuts, stockLengthsFeet = JOIST_STOCK_LENGTHS_FEET) {
  const stock = [...new Set(stockLengthsFeet.map(Number).filter((value) => value > 0))].sort((a, b) => a - b);
  const validCuts = cuts.map((cut) => typeof cut === 'number' ? { inches: cut } : cut)
    .filter((cut) => Number(cut.inches) > 0 && Number(cut.inches) <= (stock.at(-1) ?? 0) * 12 + 1e-6)
    .sort((a, b) => b.inches - a.inches);
  if (!validCuts.length || !stock.length) return [];
  // Try each commercial size as a temporary cutting-bin capacity. After cuts
  // are grouped, shrink every bin to the shortest real board that holds it.
  // Comparing the candidates avoids common greedy failures such as buying an
  // 8 ft board for a 6 ft cut and another for a 4 ft cut instead of one 10 ft.
  const candidates = stock.map((capacityFeet) => {
    const capacityInches = capacityFeet * 12;
    const bins = [];
    validCuts.forEach((cut) => {
      const existing = bins.filter((bin) => bin.usedInches + cut.inches <= capacityInches + 1e-6)
        .sort((a, b) => (capacityInches - a.usedInches - cut.inches) - (capacityInches - b.usedInches - cut.inches))[0];
      if (existing) { existing.cuts.push(cut); existing.usedInches += cut.inches; }
      else bins.push({ cuts: [cut], usedInches: cut.inches });
    });
    const boards = bins.map((bin) => {
      const lengthFeet = stock.find((feet) => feet * 12 + 1e-6 >= bin.usedInches);
      return { lengthFeet, cuts: bin.cuts, remainingInches: lengthFeet * 12 - bin.usedInches };
    });
    return {
      boards,
      purchasedFeet: boards.reduce((sum, board) => sum + board.lengthFeet, 0),
      wasteInches: boards.reduce((sum, board) => sum + board.remainingInches, 0),
    };
  });
  candidates.sort((a, b) => a.purchasedFeet - b.purchasedFeet || a.boards.length - b.boards.length || a.wasteInches - b.wasteInches);
  return candidates[0].boards;
}
