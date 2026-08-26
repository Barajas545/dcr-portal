import { upsertObject } from '../../core/document/project-document.js';
import { getFramingLayer } from '../../core/annotations/framing-layer.js';
import { framingSystem } from '../beam/beam-geometry.js';
import { getBeams } from '../beam/beam.js';
import { getJoists, packJoistCuts } from '../joist-group/joist-group.js';

export const JOIST_BLOCKING_LAYOUT_TYPE = 'joist-blocking-layout';
export const JOIST_BLOCKING_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_UNBLOCKED_SPAN_INCHES = 96;
export const BLOCKING_STOCK_LENGTH_FEET = 16;
export const DEFAULT_JOIST_THICKNESS_INCHES = 1.5;

const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const dot = (point, axis) => point.x * axis.x + point.y * axis.y;
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function fieldAxes(joist) {
  const length = distance(joist.start, joist.end);
  if (!(length > 1e-6)) return null;
  const direction = { x: (joist.end.x - joist.start.x) / length, y: (joist.end.y - joist.start.y) / length };
  return { direction, lateral: { x: -direction.y, y: direction.x } };
}

function layoutId(fieldId) {
  return `joist-blocking-${fieldId}`;
}

export function getJoistBlockingLayout(document, fieldId) {
  const stored = document.objects.find((object) => object.type === JOIST_BLOCKING_LAYOUT_TYPE && object.fieldId === fieldId);
  return {
    type: JOIST_BLOCKING_LAYOUT_TYPE,
    schemaVersion: JOIST_BLOCKING_SCHEMA_VERSION,
    id: stored?.id ?? layoutId(fieldId),
    fieldId,
    automatic: stored?.automatic !== false,
    materialOverride: stored?.materialOverride ? structuredClone(stored.materialOverride) : null,
    manualRows: structuredClone(stored?.manualRows ?? []),
    suppressedAutomaticRowIds: [...new Set(stored?.suppressedAutomaticRowIds ?? [])],
  };
}

function resolveFieldBlockingMaterial(joists, layout) {
  if (layout.materialOverride?.size) return structuredClone(layout.materialOverride);
  const preferred = joists.filter((joist) => !joist.layout?.manualParallel);
  const candidates = preferred.length ? preferred : joists;
  const groups = new Map();
  candidates.forEach((joist) => {
    const size = joist.size ?? 'Size to match joists';
    const material = joist.material ?? { speciesGroup: 'unspecified', treatment: 'PT' };
    const key = `${size}:${material.speciesGroup ?? 'unspecified'}:${material.treatment ?? 'PT'}`;
    const group = groups.get(key) ?? { count: 0, size, material };
    group.count += 1;
    groups.set(key, group);
  });
  const selected = [...groups.values()].sort((a, b) => b.count - a.count)[0];
  return selected ? { size: selected.size, material: structuredClone(selected.material), source: 'joist-field' } : { size: 'Size to match joists', material: null, source: 'joist-field' };
}

function saveLayout(document, layout) {
  return upsertObject(document, { ...layout, schemaVersion: JOIST_BLOCKING_SCHEMA_VERSION });
}

function pointAtScalar(joist, direction, scalar) {
  const startScalar = dot(joist.start, direction);
  const endScalar = dot(joist.end, direction);
  const range = endScalar - startScalar;
  if (Math.abs(range) < 1e-6) return null;
  const t = (scalar - startScalar) / range;
  if (t < -1e-6 || t > 1 + 1e-6) return null;
  return { x: joist.start.x + (joist.end.x - joist.start.x) * t, y: joist.start.y + (joist.end.y - joist.start.y) * t };
}

function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-8) return null;
  const delta = { x: c.x - a.x, y: c.y - a.y };
  const t = (delta.x * s.y - delta.y * s.x) / denominator;
  const u = (delta.x * r.y - delta.y * r.x) / denominator;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function staggerSegment(start, end, direction, index) {
  const shift = (index % 2 === 0 ? -.5 : .5) * DEFAULT_JOIST_THICKNESS_INCHES;
  return {
    start: { x: start.x + direction.x * shift, y: start.y + direction.y * shift },
    end: { x: end.x + direction.x * shift, y: end.y + direction.y * shift },
  };
}

function blockingSegment(start, end, direction, index, sourceJoists, extra = {}) {
  const visual = staggerSegment(start, end, direction, index);
  return {
    ...visual,
    cutLengthInches: Math.max(0, distance(start, end) - DEFAULT_JOIST_THICKNESS_INCHES),
    sourceJoistIds: sourceJoists.map((joist) => joist.id),
    ...extra,
  };
}

function orderedFieldJoists(document, fieldId) {
  const joists = getJoists(document).filter((joist) => joist.layout?.fieldId === fieldId);
  const axes = fieldAxes(joists[0]);
  if (!axes) return { joists: [], axes: null };
  return {
    axes,
    joists: joists.sort((a, b) => dot(midpoint(a.start, a.end), axes.lateral) - dot(midpoint(b.start, b.end), axes.lateral)),
  };
}

function beamRows(document, fieldId, joists, axes) {
  const settings = getFramingLayer(document).settings;
  return getBeams(document).filter((beam) => framingSystem(beam, settings.framingSystem) === 'bottom').flatMap((beam) => {
    const segments = joists.slice(0, -1).flatMap((left, index) => {
      const right = joists[index + 1];
      const first = segmentIntersection(left.start, left.end, beam.start, beam.end);
      const second = segmentIntersection(right.start, right.end, beam.start, beam.end);
      return first && second ? [blockingSegment(first, second, axes.direction, index, [left, right], { sourceBeamId: beam.id })] : [];
    });
    return segments.length ? [{ id: `blocking:${fieldId}:beam:${beam.id}`, fieldId, kind: 'bottom-beam', automatic: true, label: 'Fixed blocking · Bottom Beam', segments }] : [];
  });
}

function bayKey(bay) {
  const ids = [bay.startSupportId ?? '', bay.endSupportId ?? ''].sort();
  return `${ids[0]}::${ids[1]}`;
}

function orientedBayPoint(bay, fraction, referenceBay) {
  const sameDirection = bay.startSupportId === referenceBay.startSupportId || bay.endSupportId === referenceBay.endSupportId;
  const t = sameDirection ? fraction : 1 - fraction;
  return { x: bay.start.x + (bay.end.x - bay.start.x) * t, y: bay.start.y + (bay.end.y - bay.start.y) * t };
}

function spanRows(fieldId, joists, axes, maximum = DEFAULT_MAX_UNBLOCKED_SPAN_INCHES) {
  const rows = new Map();
  joists.slice(0, -1).forEach((left, pairIndex) => {
    const right = joists[pairIndex + 1];
    (left.layout?.bays ?? []).forEach((leftBay) => {
      const rightBay = (right.layout?.bays ?? []).find((bay) => bayKey(bay) === bayKey(leftBay));
      if (!rightBay) return;
      const span = Math.max(Number(leftBay.lengthInches) || distance(leftBay.start, leftBay.end), Number(rightBay.lengthInches) || distance(rightBay.start, rightBay.end));
      const rowCount = Math.max(0, Math.ceil(span / maximum) - 1);
      for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
        const fraction = rowIndex / (rowCount + 1);
        const key = `blocking:${fieldId}:span:${bayKey(leftBay)}:${rowIndex}of${rowCount}`;
        const row = rows.get(key) ?? { id: key, fieldId, kind: 'span', automatic: true, label: 'Span blocking', segments: [] };
        const start = orientedBayPoint(leftBay, fraction, leftBay);
        const end = orientedBayPoint(rightBay, fraction, leftBay);
        row.segments.push(blockingSegment(start, end, axes.direction, pairIndex, [left, right], { supportIds: [leftBay.startSupportId, leftBay.endSupportId] }));
        rows.set(key, row);
      }
    });
  });
  return [...rows.values()];
}

function manualRow(row, fieldId, joists, axes) {
  const segments = joists.slice(0, -1).flatMap((left, index) => {
    const right = joists[index + 1];
    const start = pointAtScalar(left, axes.direction, row.positionInches);
    const end = pointAtScalar(right, axes.direction, row.positionInches);
    return start && end ? [blockingSegment(start, end, axes.direction, index, [left, right])] : [];
  });
  return { id: row.id, fieldId, kind: 'manual', automatic: false, label: 'Manual blocking row', positionInches: row.positionInches, segments };
}

export function deriveJoistBlockingRows(document, options = {}) {
  const fieldIds = [...new Set(getJoists(document).map((joist) => joist.layout?.fieldId).filter(Boolean))];
  return fieldIds.flatMap((fieldId) => {
    const { joists, axes } = orderedFieldJoists(document, fieldId);
    if (!axes || joists.length < 2) return [];
    const layout = getJoistBlockingLayout(document, fieldId);
    const blockingMaterial = resolveFieldBlockingMaterial(joists, layout);
    const automatic = layout.automatic ? [...beamRows(document, fieldId, joists, axes), ...spanRows(fieldId, joists, axes)] : [];
    const suppressed = new Set(layout.suppressedAutomaticRowIds);
    const rows = [
      ...automatic.map((row) => ({ ...row, suppressed: suppressed.has(row.id), blockingMaterial })),
      ...layout.manualRows.map((row) => ({ ...manualRow(row, fieldId, joists, axes), blockingMaterial })),
    ].filter((row) => row.segments.length);
    return options.includeSuppressed ? rows : rows.filter((row) => !row.suppressed);
  });
}

export function setJoistBlockingMaterial(document, fieldId, override = null) {
  const layout = getJoistBlockingLayout(document, fieldId);
  const materialOverride = override?.size
    ? { size: String(override.size), material: structuredClone(override.material ?? null), source: 'override' }
    : null;
  return saveLayout(document, { ...layout, materialOverride });
}

export function addManualBlockingRow(document, fieldId, point, idFactory = defaultId) {
  const { joists, axes } = orderedFieldJoists(document, fieldId);
  if (!axes || joists.length < 2 || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return { document, row: null, reason: 'Select a valid location inside this Joist Field.' };
  const row = { id: idFactory('blocking-row'), positionInches: dot(point, axes.direction) };
  const derived = manualRow(row, fieldId, joists, axes);
  if (!derived.segments.length) return { document, row: null, reason: 'The blocking row must cross at least two adjacent joists.' };
  const layout = getJoistBlockingLayout(document, fieldId);
  return { document: saveLayout(document, { ...layout, manualRows: [...layout.manualRows, row] }), row: derived, reason: null };
}

export function moveManualBlockingRow(document, rowId, point) {
  const layouts = document.objects.filter((object) => object.type === JOIST_BLOCKING_LAYOUT_TYPE);
  const owner = layouts.find((layout) => layout.manualRows?.some((row) => row.id === rowId));
  if (!owner) return { document, row: null, reason: 'Manual blocking row was not found.' };
  const { joists, axes } = orderedFieldJoists(document, owner.fieldId);
  const candidate = { id: rowId, positionInches: dot(point, axes.direction) };
  const derived = manualRow(candidate, owner.fieldId, joists, axes);
  if (!derived.segments.length) return { document, row: null, reason: 'Keep the blocking row inside the Joist Field.' };
  const layout = getJoistBlockingLayout(document, owner.fieldId);
  return { document: saveLayout(document, { ...layout, manualRows: layout.manualRows.map((row) => row.id === rowId ? candidate : row) }), row: derived, reason: null };
}

export function removeManualBlockingRow(document, rowId) {
  const owner = document.objects.find((object) => object.type === JOIST_BLOCKING_LAYOUT_TYPE && object.manualRows?.some((row) => row.id === rowId));
  if (!owner) return document;
  const layout = getJoistBlockingLayout(document, owner.fieldId);
  return saveLayout(document, { ...layout, manualRows: layout.manualRows.filter((row) => row.id !== rowId) });
}

export function suppressAutomaticBlockingRow(document, rowId, suppressed = true) {
  const row = deriveJoistBlockingRows(document, { includeSuppressed: true }).find((entry) => entry.id === rowId && entry.automatic);
  if (!row) return document;
  const layout = getJoistBlockingLayout(document, row.fieldId);
  const ids = new Set(layout.suppressedAutomaticRowIds);
  if (suppressed) ids.add(rowId); else ids.delete(rowId);
  return saveLayout(document, { ...layout, suppressedAutomaticRowIds: [...ids] });
}

export function restoreAutomaticBlockingRows(document, fieldId) {
  const layout = getJoistBlockingLayout(document, fieldId);
  return saveLayout(document, { ...layout, automatic: true, suppressedAutomaticRowIds: [] });
}

export function describeJoistBlockingTakeoff(document) {
  const rows = deriveJoistBlockingRows(document);
  const groups = new Map();
  rows.forEach((row) => row.segments.forEach((segment) => {
    const size = row.blockingMaterial?.size ?? 'Size to match joists';
    const material = row.blockingMaterial?.material;
    const materialKey = `${size}:${material?.speciesGroup ?? 'unspecified'}:${material?.treatment ?? 'PT'}`;
    const group = groups.get(materialKey) ?? { size, cuts: [], sourceObjectIds: new Set() };
    group.cuts.push({ inches: Math.ceil(segment.cutLengthInches * 4) / 4, sourceObjectId: segment.sourceJoistIds[0] });
    segment.sourceJoistIds.forEach((id) => group.sourceObjectIds.add(id));
    if (segment.sourceBeamId) group.sourceObjectIds.add(segment.sourceBeamId);
    groups.set(materialKey, group);
  }));
  return [...groups.entries()].map(([key, group]) => {
    const boards = packJoistCuts(group.cuts, [BLOCKING_STOCK_LENGTH_FEET]);
    const totalCutInches = group.cuts.reduce((sum, cut) => sum + cut.inches, 0);
    return {
      kind: 'count',
      id: `auto:framing:joist-blocking:${key.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      category: 'framing',
      description: `${group.size} joist blocking`,
      specification: `${BLOCKING_STOCK_LENGTH_FEET} ft stock · ${group.cuts.length} blocks · ${(totalCutInches / 12).toFixed(2)} LF net · optimized cuts`,
      quantity: boards.length,
      stockLengthFeet: BLOCKING_STOCK_LENGTH_FEET,
      sourceObjectIds: [...group.sourceObjectIds],
      confidence: 'preliminary',
    };
  });
}
