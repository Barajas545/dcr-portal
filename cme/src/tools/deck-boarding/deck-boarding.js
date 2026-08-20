export const DECK_BOARDING_SCHEMA_VERSION = 1;
export const DEFAULT_BOARD_WIDTH = 5.5;
export const DEFAULT_BOARD_GAP = 3 / 16;

const EPSILON = 1e-7;

function normalizeAngle(angle) {
  const fullTurn = Math.PI * 2;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

export function getDeckBoarding(boundary) {
  return boundary?.metadata?.deckBoarding ?? null;
}

export function setDeckBoardingDirection(boundary, start, end, reference = {}, options = {}) {
  const dx = Number(end?.x) - Number(start?.x);
  const dy = Number(end?.y) - Number(start?.y);
  if (!boundary || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < EPSILON) {
    throw new Error('Choose a construction line with a measurable direction.');
  }
  const current = getDeckBoarding(boundary);
  const deckBoarding = {
    schemaVersion: DECK_BOARDING_SCHEMA_VERSION,
    reference: {
      kind: reference.kind ?? 'construction-line',
      id: reference.id ?? null,
      ownerId: reference.ownerId ?? null,
    },
    angleRadians: normalizeAngle(Math.atan2(dy, dx)),
    origin: { x: Number(start.x), y: Number(start.y) },
    boardWidth: Number(options.boardWidth ?? current?.boardWidth ?? DEFAULT_BOARD_WIDTH),
    gap: Number(options.gap ?? current?.gap ?? DEFAULT_BOARD_GAP),
  };
  return { ...boundary, metadata: { ...boundary.metadata, deckBoarding } };
}

export function rotateDeckBoardingDirection(boundary) {
  const current = getDeckBoarding(boundary);
  if (!current) return boundary;
  return {
    ...boundary,
    metadata: {
      ...boundary.metadata,
      deckBoarding: { ...current, angleRadians: normalizeAngle(current.angleRadians + Math.PI / 2) },
    },
  };
}

export function clearDeckBoardingDirection(boundary) {
  if (!getDeckBoarding(boundary)) return boundary;
  const metadata = { ...boundary.metadata };
  delete metadata.deckBoarding;
  return { ...boundary, metadata };
}

function lineIntervalsAtOffset(points, origin, direction, normal, offset) {
  const transformed = points.map((point) => ({
    u: (point.x - origin.x) * direction.x + (point.y - origin.y) * direction.y,
    v: (point.x - origin.x) * normal.x + (point.y - origin.y) * normal.y,
  }));
  const intersections = [];
  transformed.forEach((first, index) => {
    const second = transformed[(index + 1) % transformed.length];
    if (!((first.v <= offset && second.v > offset) || (second.v <= offset && first.v > offset))) return;
    const t = (offset - first.v) / (second.v - first.v);
    intersections.push(first.u + (second.u - first.u) * t);
  });
  intersections.sort((a, b) => a - b);
  const intervals = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    if (intersections[index + 1] - intersections[index] > EPSILON) intervals.push([intersections[index], intersections[index + 1]]);
  }
  return intervals;
}

function subtractInterval(source, cut) {
  const [start, end] = source;
  const [cutStart, cutEnd] = cut;
  if (cutEnd <= start + EPSILON || cutStart >= end - EPSILON) return [source];
  const result = [];
  if (cutStart > start + EPSILON) result.push([start, Math.min(end, cutStart)]);
  if (cutEnd < end - EPSILON) result.push([Math.max(start, cutEnd), end]);
  return result;
}

export function deriveDeckBoardingSegments(boundary, exclusionPolygons = [], options = {}) {
  const boarding = getDeckBoarding(boundary);
  if (!boarding || !Array.isArray(boundary?.vertices) || boundary.vertices.length < 3) return [];
  const pitch = Number(options.pitch ?? boarding.boardWidth + boarding.gap);
  if (!Number.isFinite(pitch) || pitch <= EPSILON) return [];
  const origin = boarding.origin;
  const direction = { x: Math.cos(boarding.angleRadians), y: Math.sin(boarding.angleRadians) };
  const normal = { x: -direction.y, y: direction.x };
  const offsets = boundary.vertices.map((point) => (point.x - origin.x) * normal.x + (point.y - origin.y) * normal.y);
  const firstIndex = Math.ceil((Math.min(...offsets) + EPSILON) / pitch);
  const lastIndex = Math.floor((Math.max(...offsets) - EPSILON) / pitch);
  const maxLines = Math.max(1, Number(options.maxLines ?? 2000));
  const segments = [];
  for (let index = firstIndex; index <= lastIndex && index - firstIndex < maxLines; index += 1) {
    const offset = index * pitch;
    let intervals = lineIntervalsAtOffset(boundary.vertices, origin, direction, normal, offset);
    for (const polygon of exclusionPolygons.filter((points) => Array.isArray(points) && points.length >= 3)) {
      for (const cut of lineIntervalsAtOffset(polygon, origin, direction, normal, offset)) {
        intervals = intervals.flatMap((interval) => subtractInterval(interval, cut));
      }
    }
    intervals.forEach(([start, end]) => segments.push({
      start: { x: origin.x + direction.x * start + normal.x * offset, y: origin.y + direction.y * start + normal.y * offset },
      end: { x: origin.x + direction.x * end + normal.x * offset, y: origin.y + direction.y * end + normal.y * offset },
    }));
  }
  return segments;
}
