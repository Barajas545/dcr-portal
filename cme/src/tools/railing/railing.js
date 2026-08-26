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

function normalizedDirection(vector) {
  const length = Math.hypot(vector.x, vector.y);
  return length > EPSILON ? { x: vector.x / length, y: vector.y / length } : { x: 0, y: 0 };
}

function cornerSettingIsDouble(setting) {
  return setting === 'double' || setting?.double === true;
}

export function deriveRailingPostLayout(geometries, cornerSettings = {}, tolerance = 0.6) {
  const valid = geometries.filter(Boolean);
  const endpointDirections = [];
  valid.forEach((geometry) => {
    endpointDirections.push(
      { point: geometry.start, endpointId: `${geometry.railing.id}:endpoint:start`, legacyMemberId: `${geometry.railing.id}:post:0`, vector: { x: geometry.end.x - geometry.start.x, y: geometry.end.y - geometry.start.y } },
      { point: geometry.end, endpointId: `${geometry.railing.id}:endpoint:end`, legacyMemberId: `${geometry.railing.id}:post:${geometry.posts.length - 1}`, vector: { x: geometry.start.x - geometry.end.x, y: geometry.start.y - geometry.end.y } },
    );
  });
  const cornerGroups = [];
  endpointDirections.forEach((endpoint) => {
    let group = cornerGroups.find((entry) => distance(entry.point, endpoint.point) <= tolerance);
    if (!group) { group = { point: endpoint.point, vectors: [], endpointIds: [], legacyMemberIds: [] }; cornerGroups.push(group); }
    group.vectors.push(endpoint.vector);
    group.endpointIds.push(endpoint.endpointId);
    group.legacyMemberIds.push(endpoint.legacyMemberId);
  });
  const corners = cornerGroups.filter((group) => group.vectors.length === 2).flatMap((group) => {
    const [a, b] = group.vectors;
    const dot = a.x * b.x + a.y * b.y;
    const magnitudes = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot / magnitudes))) * 180 / Math.PI;
    if (Math.abs(180 - angle) <= 1) return [];
    const id = `railing-corner:${[...group.endpointIds].sort().join('|')}`;
    const legacyId = `railing-corner:${[...group.legacyMemberIds].sort().join('|')}`;
    const legacyKey = `${group.point.x.toFixed(2)},${group.point.y.toFixed(2)}`;
    const doubled = cornerSettingIsDouble(cornerSettings[id] ?? cornerSettings[legacyId] ?? cornerSettings[legacyKey]);
    return [{ id, key: id, legacyId, legacyKey, x: group.point.x, y: group.point.y, angle, doubled, classification: doubled ? 'double' : 'single', vectors: group.vectors.map(normalizedDirection), endpointIds: group.endpointIds }];
  });

  const cornerForEndpoint = (endpointId) => corners.find((corner) => corner.endpointIds.includes(endpointId));
  const resolvedGeometries = valid.map((geometry) => {
    const originalLength = distance(geometry.start, geometry.end);
    const direction = normalizedDirection({ x: geometry.end.x - geometry.start.x, y: geometry.end.y - geometry.start.y });
    const postWidth = geometry.postWidth ?? geometry.railing.settings?.postWidth ?? DEFAULT_POST_WIDTH;
    const startEndpointId = `${geometry.railing.id}:endpoint:start`;
    const endEndpointId = `${geometry.railing.id}:endpoint:end`;
    const startInset = cornerForEndpoint(startEndpointId)?.doubled ? postWidth : 0;
    const endInset = cornerForEndpoint(endEndpointId)?.doubled ? postWidth : 0;
    const usableLength = Math.max(0, originalLength - startInset - endInset);
    const start = { x: geometry.start.x + direction.x * startInset, y: geometry.start.y + direction.y * startInset };
    const end = { x: geometry.end.x - direction.x * endInset, y: geometry.end.y - direction.y * endInset };
    const layout = computeRailingLayout(usableLength, geometry.railing.settings);
    return {
      ...geometry,
      sourceStart: geometry.start,
      sourceEnd: geometry.end,
      sourceLength: originalLength,
      start,
      end,
      ...layout,
      posts: layout.posts.map((post, index) => ({
        t: post.t,
        x: start.x + (end.x - start.x) * post.t,
        y: start.y + (end.y - start.y) * post.t,
        memberId: `${geometry.railing.id}:post:${index}`,
        endpointId: index === 0 ? startEndpointId : index === layout.posts.length - 1 ? endEndpointId : null,
      })),
    };
  });

  const clusters = [];
  resolvedGeometries.forEach((geometry) => geometry.posts.forEach((post) => {
    let cluster = clusters.find((entry) => distance(entry, post) <= tolerance);
    if (!cluster) { cluster = { x: post.x, y: post.y, count: 0, members: [], endpointIds: [], postWidth: geometry.postWidth ?? DEFAULT_POST_WIDTH }; clusters.push(cluster); }
    cluster.count += 1;
    cluster.members.push(post.memberId);
    if (post.endpointId) cluster.endpointIds.push(post.endpointId);
    cluster.postWidth = Math.max(cluster.postWidth, geometry.postWidth ?? DEFAULT_POST_WIDTH);
  }));

  const consumed = new Set();
  const posts = corners.filter((corner) => corner.doubled).map((corner) => {
    const cornerClusters = clusters.filter((cluster) => cluster.endpointIds.some((endpointId) => corner.endpointIds.includes(endpointId)));
    cornerClusters.forEach((cluster) => consumed.add(cluster));
    return {
      id: `railing-post:${corner.id}`,
      x: corner.x,
      y: corner.y,
      sourcePostIds: cornerClusters.flatMap((cluster) => cluster.members),
      shared: true,
      cornerId: corner.id,
      corner,
      doubled: true,
      markers: cornerClusters.map((cluster) => ({ x: cluster.x, y: cluster.y, size: cluster.postWidth })),
    };
  });
  clusters.filter((cluster) => !consumed.has(cluster)).forEach((cluster) => {
    const id = `railing-post:${[...cluster.members].sort().join('|')}`;
    const corner = corners.find((entry) => cluster.endpointIds.some((endpointId) => entry.endpointIds.includes(endpointId))) ?? null;
    posts.push({ id, x: cluster.x, y: cluster.y, sourcePostIds: [...cluster.members], shared: cluster.count > 1, cornerId: corner?.id ?? null, corner, doubled: false, markers: [{ x: cluster.x, y: cluster.y, size: cluster.postWidth }] });
  });
  const doubleCornerCount = corners.filter((corner) => corner.doubled).length;
  const physicalPostCount = posts.reduce((sum, post) => sum + post.markers.length, 0);
  return { posts, corners, geometries: resolvedGeometries, basePostCount: physicalPostCount - doubleCornerCount, doubleCornerCount, physicalPostCount };
}

export function setRailingCornerDouble(document, cornerId, doubled) {
  const settings = { ...(document.railingCornerSettings ?? {}) };
  if (doubled) settings[cornerId] = { double: true };
  else delete settings[cornerId];
  return { ...document, railingCornerSettings: settings, updatedAt: new Date().toISOString() };
}

export function analyzeRailingGeometries(geometries, cornerSettings = {}, tolerance = 0.6) {
  const valid = geometries.filter(Boolean);
  const layout = deriveRailingPostLayout(valid, cornerSettings, tolerance);
  return {
    totalLength: valid.reduce((sum, geometry) => sum + geometry.length, 0),
    sectionCount: layout.geometries.reduce((sum, geometry) => sum + geometry.sectionCount, 0),
    visiblePostCount: layout.physicalPostCount,
    basePostCount: layout.basePostCount,
    doubleCornerCount: layout.doubleCornerCount,
    exteriorCornerCount: layout.doubleCornerCount,
    estimatedPostCount: layout.physicalPostCount,
    corners: layout.corners,
    posts: layout.posts,
    geometries: layout.geometries,
  };
}
