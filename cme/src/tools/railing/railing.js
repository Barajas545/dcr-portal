import { distance } from '../../core/geometry/vector.js';

export const RAILING_TYPE = 'railing-run';
export const RAILING_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_CLEAR_SPAN = 72;
export const DEFAULT_POST_WIDTH = 3.5;
const EPSILON = 1e-9;
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function computeRailingLayout(length, options = {}) {
  const maxClearSpan = options.maxClearSpan ?? DEFAULT_MAX_CLEAR_SPAN;
  const postWidth = options.postWidth ?? DEFAULT_POST_WIDTH;
  if (!Number.isFinite(length) || length <= 0) return { length: 0, sectionCount: 0, postCount: 0, posts: [], postsOverlap: false };
  const maxCenterSpacing = maxClearSpan + postWidth;
  const minimumSectionCount = Math.max(1, Math.ceil(length / maxCenterSpacing - EPSILON));
  const requestedSectionCount = Number.isFinite(options.sectionCountOverride) ? Math.floor(options.sectionCountOverride) : minimumSectionCount;
  const sectionCount = Math.max(minimumSectionCount, requestedSectionCount);
  const centerSpacing = length / sectionCount;
  const clearSpan = Math.max(0, centerSpacing - postWidth);
  return {
    length,
    sectionCount,
    minimumSectionCount,
    postCount: sectionCount + 1,
    centerSpacing,
    clearSpan,
    maxClearSpan,
    postWidth,
    withinRule: clearSpan <= maxClearSpan + EPSILON,
    postsOverlap: length < postWidth,
    posts: Array.from({ length: sectionCount + 1 }, (_, index) => ({ t: index / sectionCount })),
  };
}

export function projectPointToEdge(start, end, point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return { t: 0, point: { ...start } };
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return { t, point: { x: start.x + dx * t, y: start.y + dy * t } };
}

export function resolveRailingEndpointSnap(point, targets = {}, options = {}) {
  const tolerance = options.tolerance ?? 12;
  if (options.edges !== false) {
    const vertex = (targets.vertices ?? [])
      .map((target) => ({ target, distance: distance(point, target.point) }))
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance)[0]?.target;
    if (vertex) return { snapType: 'vertex', ...vertex, point: { ...vertex.point }, label: vertex.label ?? 'Corner snap' };
    const edge = (targets.edges ?? [])
      .map((target) => {
        const projection = projectPointToEdge(target.start, target.end, point);
        return { target, projection, distance: distance(point, projection.point) };
      })
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance)[0];
    if (edge) {
      const { start, end, ...reference } = edge.target;
      return { snapType: 'edge', ...reference, t: edge.projection.t, point: edge.projection.point, label: reference.label ?? 'Edge snap' };
    }
  }
  if (options.grid !== false) {
    const spacing = options.gridSpacing ?? .5;
    return {
      snapType: 'grid',
      point: { x: Math.round(point.x / spacing) * spacing, y: Math.round(point.y / spacing) * spacing },
      spacing,
      label: 'Grid snap',
    };
  }
  return null;
}

export function createRailingRun(host, startT, endT, options = {}, idFactory = defaultId) {
  if (!host?.edgeId || !host?.boundaryId) throw new Error('Railing requires a construction edge host.');
  const first = Math.max(0, Math.min(1, Number(startT)));
  const second = Math.max(0, Math.min(1, Number(endT)));
  if (!Number.isFinite(first) || !Number.isFinite(second) || Math.abs(first - second) < 1e-6) throw new Error('Drag along the construction edge to create a railing.');
  return {
    type: RAILING_TYPE,
    schemaVersion: RAILING_SCHEMA_VERSION,
    id: idFactory('railing'),
    name: options.name ?? 'Railing run',
    host: { ...host },
    anchors: { startT: first, endT: second },
    settings: {
      maxClearSpan: options.maxClearSpan ?? DEFAULT_MAX_CLEAR_SPAN,
      postWidth: options.postWidth ?? DEFAULT_POST_WIDTH,
    },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function createRailingLine(startAnchor, endAnchor, options = {}, idFactory = defaultId) {
  if (!startAnchor?.point || !endAnchor?.point) throw new Error('Railing endpoints require active snap references.');
  if (distance(startAnchor.point, endAnchor.point) < 1e-6) throw new Error('Railing endpoints must be different.');
  return {
    type: RAILING_TYPE,
    schemaVersion: RAILING_SCHEMA_VERSION,
    id: idFactory('railing'),
    name: options.name ?? 'Railing run',
    anchors: { start: startAnchor, end: endAnchor },
    settings: {
      maxClearSpan: options.maxClearSpan ?? DEFAULT_MAX_CLEAR_SPAN,
      postWidth: options.postWidth ?? DEFAULT_POST_WIDTH,
      system: options.system ?? 'wild-hog',
      sectionCountOverride: options.sectionCountOverride ?? null,
    },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function updateRailingSettings(railing, patch) {
  return {
    ...railing,
    settings: { ...railing.settings, ...patch },
    lifecycle: { ...railing.lifecycle, revision: (railing.lifecycle?.revision ?? 1) + 1 },
  };
}

export function deriveRailingLineGeometry(railing, start, end) {
  if (!start || !end) return null;
  const layout = computeRailingLayout(distance(start, end), railing.settings);
  return {
    railing,
    start,
    end,
    ...layout,
    posts: layout.posts.map((post) => ({
      t: post.t,
      x: start.x + (end.x - start.x) * post.t,
      y: start.y + (end.y - start.y) * post.t,
    })),
  };
}

export function deriveRailingGeometry(railing, edgeStart, edgeEnd) {
  if (!edgeStart || !edgeEnd) return null;
  const pointAt = (t) => ({ x: edgeStart.x + (edgeEnd.x - edgeStart.x) * t, y: edgeStart.y + (edgeEnd.y - edgeStart.y) * t });
  const start = pointAt(railing.anchors.startT);
  const end = pointAt(railing.anchors.endT);
  const layout = computeRailingLayout(distance(start, end), railing.settings);
  return {
    railing,
    start,
    end,
    ...layout,
    posts: layout.posts.map((post) => ({
      t: post.t,
      x: start.x + (end.x - start.x) * post.t,
      y: start.y + (end.y - start.y) * post.t,
    })),
  };
}

export function analyzeRailingGeometries(geometries, cornerClassifications = {}, tolerance = 0.6) {
  const valid = geometries.filter(Boolean);
  const clusters = [];
  const endpointDirections = [];
  valid.forEach((geometry) => {
    geometry.posts.forEach((post) => {
      let cluster = clusters.find((entry) => distance(entry, post) <= tolerance);
      if (!cluster) { cluster = { x: post.x, y: post.y, count: 0 }; clusters.push(cluster); }
      cluster.count += 1;
    });
    endpointDirections.push(
      { point: geometry.start, vector: { x: geometry.end.x - geometry.start.x, y: geometry.end.y - geometry.start.y } },
      { point: geometry.end, vector: { x: geometry.start.x - geometry.end.x, y: geometry.start.y - geometry.end.y } },
    );
  });
  const cornerGroups = [];
  endpointDirections.forEach((endpoint) => {
    let group = cornerGroups.find((entry) => distance(entry.point, endpoint.point) <= tolerance);
    if (!group) { group = { point: endpoint.point, vectors: [] }; cornerGroups.push(group); }
    group.vectors.push(endpoint.vector);
  });
  const corners = cornerGroups.filter((group) => group.vectors.length === 2).flatMap((group) => {
    const [a, b] = group.vectors;
    const dot = a.x * b.x + a.y * b.y;
    const magnitudes = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot / magnitudes))) * 180 / Math.PI;
    if (Math.abs(180 - angle) <= 1) return [];
    const key = `${group.point.x.toFixed(2)},${group.point.y.toFixed(2)}`;
    return [{ key, x: group.point.x, y: group.point.y, angle, classification: cornerClassifications[key] ?? 'exterior' }];
  });
  const exteriorCornerCount = corners.filter((corner) => corner.classification === 'exterior').length;
  return {
    totalLength: valid.reduce((sum, geometry) => sum + geometry.length, 0),
    sectionCount: valid.reduce((sum, geometry) => sum + geometry.sectionCount, 0),
    visiblePostCount: clusters.length,
    exteriorCornerCount,
    estimatedPostCount: clusters.length + exteriorCornerCount,
    corners,
  };
}
