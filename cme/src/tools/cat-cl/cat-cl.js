export const CAT_LINE_TYPE = 'cat-construction-line';
export const CAT_MEASUREMENT_TYPE = 'cat-measurement';
export const CAT_NOTE_TYPE = 'cat-note';
export const CAT_OBJECT_SCHEMA_VERSION = 1;

const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const point = (value) => ({ x: Number(value.x), y: Number(value.y) });

function validatePoints(start, end) {
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) throw new Error('CAT geometry requires two valid points.');
  if (Math.hypot(end.x - start.x, end.y - start.y) < .5) throw new Error('CAT points must be different.');
}

export function createCatLine(start, end, options = {}, idFactory = defaultId) {
  validatePoints(start, end);
  const id = idFactory('cat-line');
  return {
    type: CAT_LINE_TYPE,
    schemaVersion: CAT_OBJECT_SCHEMA_VERSION,
    id,
    name: options.name ?? 'CAT construction line',
    vertices: [
      { id: `${id}:start`, ...point(start) },
      { id: `${id}:end`, ...point(end) },
    ],
    edges: [{ id: `${id}:edge`, role: 'cat-reference' }],
    lifecycle: { phase: 'reference', revision: 1 },
  };
}

export function createCatMeasurement(start, end, options = {}, idFactory = defaultId) {
  validatePoints(start, end);
  const id = idFactory('cat-measure');
  return {
    type: CAT_MEASUREMENT_TYPE,
    schemaVersion: CAT_OBJECT_SCHEMA_VERSION,
    id,
    name: options.name ?? 'CAT measuring tape',
    start: point(start),
    end: point(end),
    lifecycle: { phase: 'annotation', revision: 1 },
  };
}

export function createCatNote(anchor, text = '', options = {}, idFactory = defaultId) {
  if (![anchor?.x, anchor?.y].every(Number.isFinite)) throw new Error('CAT Note requires a valid arrow point.');
  const id = idFactory('cat-note');
  return {
    type: CAT_NOTE_TYPE,
    schemaVersion: CAT_OBJECT_SCHEMA_VERSION,
    id,
    name: options.name ?? 'CAT construction note',
    anchor: point(anchor),
    labelOffset: options.labelOffset ? point(options.labelOffset) : { x: 42, y: -34 },
    text: String(text).trim(),
    audioDataUrl: options.audioDataUrl ?? null,
    lifecycle: { phase: 'annotation', revision: 1 },
  };
}

export function updateCatNote(note, patch = {}) {
  if (note.type !== CAT_NOTE_TYPE) throw new Error('A CAT Note is required.');
  return {
    ...note,
    text: patch.text === undefined ? note.text : String(patch.text).trim(),
    audioDataUrl: patch.audioDataUrl === undefined ? note.audioDataUrl : patch.audioDataUrl,
    labelOffset: patch.labelOffset ? point(patch.labelOffset) : note.labelOffset,
    lifecycle: { ...note.lifecycle, revision: Number(note.lifecycle?.revision ?? 0) + 1 },
  };
}

export function deriveCatMeasurement(measurement) {
  const horizontal = measurement.end.x - measurement.start.x;
  const vertical = measurement.end.y - measurement.start.y;
  return {
    horizontal,
    vertical,
    horizontalDistance: Math.abs(horizontal),
    verticalDistance: Math.abs(vertical),
    pointToPointDistance: Math.hypot(horizontal, vertical),
    corner: { x: measurement.end.x, y: measurement.start.y },
    midpoint: { x: (measurement.start.x + measurement.end.x) / 2, y: (measurement.start.y + measurement.end.y) / 2 },
  };
}

export function resolveCatLineEndpoint(start, toward, length) {
  if (![start?.x, start?.y, toward?.x, toward?.y, length].every(Number.isFinite) || length <= 0) {
    throw new Error('CAT Line requires a valid direction and positive length.');
  }
  const dx = toward.x - start.x;
  const dy = toward.y - start.y;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < .0001) return { x: start.x + length, y: start.y };
  return { x: start.x + dx / magnitude * length, y: start.y + dy / magnitude * length };
}

function lineIntersection(start, end, cutter) {
  const rx = end.x - start.x;
  const ry = end.y - start.y;
  const sx = cutter.end.x - cutter.start.x;
  const sy = cutter.end.y - cutter.start.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-8) return null;
  const qx = cutter.start.x - start.x;
  const qy = cutter.start.y - start.y;
  const lineT = (qx * sy - qy * sx) / denominator;
  const cutterT = (qx * ry - qy * rx) / denominator;
  if (cutterT < -1e-8 || cutterT > 1 + 1e-8) return null;
  return { lineT, point: { x: start.x + rx * lineT, y: start.y + ry * lineT } };
}

function projectParameter(start, end, candidate) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy || 1;
  return ((candidate.x - start.x) * dx + (candidate.y - start.y) * dy) / lengthSquared;
}

export function trimCatLine(line, clickPoint, cutters = []) {
  if (line.type !== CAT_LINE_TYPE) throw new Error('Trim requires a CAT Line.');
  const [start, end] = line.vertices;
  const intersections = cutters.map((cutter) => lineIntersection(start, end, cutter))
    .filter((entry) => entry && entry.lineT > 1e-6 && entry.lineT < 1 - 1e-6);
  if (!intersections.length) throw new Error('No crossing line was found inside this CAT Line.');
  const clickT = projectParameter(start, end, clickPoint);
  const intersection = intersections.sort((a, b) => Math.abs(a.lineT - clickT) - Math.abs(b.lineT - clickT))[0];
  const trimStart = clickT <= intersection.lineT;
  return {
    ...line,
    vertices: trimStart
      ? [{ ...start, ...intersection.point }, end]
      : [start, { ...end, ...intersection.point }],
    lifecycle: { ...line.lifecycle, revision: Number(line.lifecycle?.revision ?? 0) + 1 },
  };
}

export function extendCatLine(line, clickPoint, cutters = []) {
  if (line.type !== CAT_LINE_TYPE) throw new Error('Extend requires a CAT Line.');
  const [start, end] = line.vertices;
  const extendStart = Math.hypot(clickPoint.x - start.x, clickPoint.y - start.y) <= Math.hypot(clickPoint.x - end.x, clickPoint.y - end.y);
  const intersections = cutters.map((cutter) => lineIntersection(start, end, cutter)).filter(Boolean);
  const candidates = extendStart
    ? intersections.filter((entry) => entry.lineT < -1e-6).sort((a, b) => b.lineT - a.lineT)
    : intersections.filter((entry) => entry.lineT > 1 + 1e-6).sort((a, b) => a.lineT - b.lineT);
  if (!candidates.length) throw new Error(`No line was found beyond the ${extendStart ? 'start' : 'end'} of this CAT Line.`);
  const intersection = candidates[0];
  return {
    ...line,
    vertices: extendStart
      ? [{ ...start, ...intersection.point }, end]
      : [start, { ...end, ...intersection.point }],
    lifecycle: { ...line.lifecycle, revision: Number(line.lifecycle?.revision ?? 0) + 1 },
  };
}

export function getCatLines(document) {
  return document.objects.filter((object) => object.type === CAT_LINE_TYPE);
}

export function getCatMeasurements(document) {
  return document.objects.filter((object) => object.type === CAT_MEASUREMENT_TYPE);
}

export function getCatNotes(document) {
  return document.objects.filter((object) => object.type === CAT_NOTE_TYPE);
}

export function getCatSnapObjects(document) {
  const lines = getCatLines(document).map((line) => ({ ...line, snapSource: 'cat', snapPriority: 1 }));
  const measurements = getCatMeasurements(document).map((measurement) => ({
    type: CAT_MEASUREMENT_TYPE,
    id: measurement.id,
    snapSource: 'cat',
    snapPriority: 2,
    vertices: [
      { id: `${measurement.id}:start`, ...measurement.start },
      { id: `${measurement.id}:end`, ...measurement.end },
    ],
    edges: [],
  }));
  return [...lines, ...measurements];
}
