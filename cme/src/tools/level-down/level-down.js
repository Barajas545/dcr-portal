import { distance } from '../../core/geometry/vector.js';

export const LEVEL_DOWN_TYPE = 'level-down';
export const LEVEL_DOWN_SCHEMA_VERSION = 1;
export const DEFAULT_RISER_HEIGHT = 7.5;
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function createLevelDown(points, options = {}, idFactory = defaultId) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('Level Down requires at least two points.');
  const firstAnchor = points[0].anchor;
  const lastAnchor = points.at(-1).anchor;
  const isBoundaryAnchor = (anchor) => ['edge', 'vertex'].includes(anchor?.snapType) && anchor.edgeKind !== 'stair-interface-edge';
  if (!isBoundaryAnchor(firstAnchor) || !isBoundaryAnchor(lastAnchor)) {
    throw new Error('Level Down must begin and end on Deck Boundary construction geometry.');
  }
  const vertices = points.map((point, order) => ({ id: idFactory('level-vertex'), x: Number(point.x), y: Number(point.y), order, anchor: point.anchor ?? null }));
  if (vertices.some((vertex, index) => index && distance(vertices[index - 1], vertex) < 1e-6)) throw new Error('Level Down contains a zero-length segment.');
  const levelDownId = idFactory('level-down');
  return {
    type: LEVEL_DOWN_TYPE,
    schemaVersion: LEVEL_DOWN_SCHEMA_VERSION,
    id: levelDownId,
    name: options.name ?? 'Level down',
    host: { boundaryId: options.boundaryId },
    vertices,
    segments: vertices.slice(0, -1).map((vertex, index) => ({ id: idFactory('level-segment'), startVertexId: vertex.id, endVertexId: vertices[index + 1].id, ownerId: levelDownId })),
    dimensions: { riserHeight: options.riserHeight ?? DEFAULT_RISER_HEIGHT },
    properties: { finishes: { fascia: false, pictureFrame: false }, regionSide: 'smaller' },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function setLevelDownRiserHeight(levelDown, riserHeight) {
  const value = Number(riserHeight);
  if (!Number.isFinite(value) || value < .5 || value > 12) throw new Error('Level Down riser must be between 0.5 and 12 inches.');
  return { ...levelDown, dimensions: { ...levelDown.dimensions, riserHeight: value }, lifecycle: { ...levelDown.lifecycle, revision: (levelDown.lifecycle?.revision ?? 1) + 1 } };
}

export function splitLevelDownSegment(levelDown, segmentId, segmentCount, idFactory = defaultId) {
  if (![2, 3].includes(segmentCount)) throw new Error('A Level Down segment can be divided into two or three segments.');
  const segmentIndex = levelDown.segments.findIndex((segment) => segment.id === segmentId);
  if (segmentIndex < 0) throw new Error('Level Down segment was not found.');
  const start = levelDown.vertices[segmentIndex];
  const end = levelDown.vertices[segmentIndex + 1];
  const inserted = Array.from({ length: segmentCount - 1 }, (_, index) => {
    const t = (index + 1) / segmentCount;
    return { id: idFactory('level-vertex'), x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, anchor: null };
  });
  const vertices = [...levelDown.vertices];
  vertices.splice(segmentIndex + 1, 0, ...inserted);
  const chain = [start, ...inserted, end];
  const source = levelDown.segments[segmentIndex];
  const replacements = Array.from({ length: segmentCount }, (_, index) => ({
    id: index === 0 ? source.id : idFactory('level-segment'),
    startVertexId: chain[index].id,
    endVertexId: chain[index + 1].id,
    ownerId: levelDown.id,
  }));
  const segments = [...levelDown.segments];
  segments.splice(segmentIndex, 1, ...replacements);
  return { ...levelDown, vertices: vertices.map((vertex, order) => ({ ...vertex, order })), segments, lifecycle: { ...levelDown.lifecycle, revision: (levelDown.lifecycle?.revision ?? 1) + 1 } };
}

export function updateLevelDownProperties(levelDown, patch) {
  return {
    ...levelDown,
    properties: {
      ...levelDown.properties,
      ...patch,
      finishes: { ...levelDown.properties?.finishes, ...patch.finishes },
    },
    lifecycle: { ...levelDown.lifecycle, revision: (levelDown.lifecycle?.revision ?? 1) + 1 },
  };
}

export function orthogonalizeLevelDown(levelDown, idFactory = defaultId) {
  const vertices = [];
  const segments = [];
  levelDown.segments.forEach((source, index) => {
    const start = levelDown.vertices[index];
    const end = levelDown.vertices[index + 1];
    if (!vertices.length) vertices.push({ ...start });
    const diagonal = Math.abs(end.x - start.x) > 1e-8 && Math.abs(end.y - start.y) > 1e-8;
    if (diagonal) {
      const elbow = { id: idFactory('level-vertex'), x: end.x, y: start.y, anchor: null };
      vertices.push(elbow);
      segments.push({ ...source, startVertexId: vertices.at(-2).id, endVertexId: elbow.id });
      segments.push({ id: idFactory('level-segment'), startVertexId: elbow.id, endVertexId: end.id, ownerId: levelDown.id });
    } else segments.push({ ...source, startVertexId: vertices.at(-1).id, endVertexId: end.id });
    vertices.push({ ...end });
  });
  return { ...levelDown, vertices: vertices.map((vertex, order) => ({ ...vertex, order })), segments, lifecycle: { ...levelDown.lifecycle, revision: (levelDown.lifecycle?.revision ?? 1) + 1 } };
}

export function deriveLevelDownRegion(levelDown, boundary) {
  if (!boundary || levelDown.vertices.length < 2) return null;
  const endpoints = [levelDown.vertices[0], levelDown.vertices.at(-1)];
  const locations = endpoints.map((point) => locateOnBoundary(point, boundary));
  if (locations.some((location) => !location)) return null;
  const insertions = new Map();
  locations.forEach((location, endpointIndex) => {
    const values = insertions.get(location.edgeIndex) ?? [];
    values.push({ ...location, point: { x: endpoints[endpointIndex].x, y: endpoints[endpointIndex].y }, endpointIndex });
    insertions.set(location.edgeIndex, values);
  });
  const ring = [];
  const endpointRingIndices = [];
  boundary.vertices.forEach((vertex, edgeIndex) => {
    const entries = [{ point: { x: vertex.x, y: vertex.y }, t: 0, endpointIndex: null }, ...(insertions.get(edgeIndex) ?? [])]
      .sort((a, b) => a.t - b.t);
    entries.forEach((entry) => {
      const previous = ring.at(-1);
      if (previous && distance(previous, entry.point) < 1e-7) {
        if (entry.endpointIndex !== null) endpointRingIndices[entry.endpointIndex] = ring.length - 1;
      } else {
        ring.push(entry.point);
        if (entry.endpointIndex !== null) endpointRingIndices[entry.endpointIndex] = ring.length - 1;
      }
    });
  });
  const [startIndex, endIndex] = endpointRingIndices;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex === endIndex) return null;
  const path = (from, to) => {
    const result = [];
    let index = from;
    while (true) {
      result.push(ring[index]);
      if (index === to) return result;
      index = (index + 1) % ring.length;
    }
  };
  const line = levelDown.vertices.map(({ x, y }) => ({ x, y }));
  const candidates = [path(endIndex, startIndex), path(startIndex, endIndex).reverse()].map((boundaryPath) => [...line, ...boundaryPath.slice(1, -1)]);
  const areas = candidates.map(polygonArea);
  const smallerIndex = areas[0] <= areas[1] ? 0 : 1;
  const selectedIndex = levelDown.properties?.regionSide === 'larger' ? 1 - smallerIndex : smallerIndex;
  return { points: candidates[selectedIndex], areaSquareInches: areas[selectedIndex], centroid: polygonCentroid(candidates[selectedIndex]) };
}

export function deriveLevelDownDepth(levelDown, levelDowns, boundary) {
  const region = deriveLevelDownRegion(levelDown, boundary);
  if (!region) return levelDown.dimensions.riserHeight;
  return levelDowns.reduce((total, candidate) => {
    const candidateRegion = deriveLevelDownRegion(candidate, boundary);
    const containsRegion = candidate.id === levelDown.id || (candidateRegion
      && candidateRegion.areaSquareInches > region.areaSquareInches
      && pointInPolygon(region.centroid, candidateRegion.points));
    return total + (containsRegion ? candidate.dimensions.riserHeight : 0);
  }, 0);
}

function locateOnBoundary(point, boundary) {
  let best = null;
  boundary.edges.forEach((edge, edgeIndex) => {
    const start = boundary.vertices[edgeIndex];
    const end = boundary.vertices[(edgeIndex + 1) % boundary.vertices.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0;
    const projected = { x: start.x + dx * t, y: start.y + dy * t };
    const error = distance(point, projected);
    if (!best || error < best.error) best = { edgeIndex, t, error };
  });
  return best?.error < 1e-4 ? best : null;
}

function polygonArea(points) {
  return Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function polygonCentroid(points) {
  const signed = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(signed) < 1e-9) return points.reduce((center, point) => ({ x: center.x + point.x / points.length, y: center.y + point.y / points.length }), { x: 0, y: 0 });
  const weighted = points.reduce((center, point, index) => {
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    return { x: center.x + (point.x + next.x) * cross, y: center.y + (point.y + next.y) * cross };
  }, { x: 0, y: 0 });
  return { x: weighted.x / (3 * signed), y: weighted.y / (3 * signed) };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
