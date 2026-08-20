import { distance, nearestPointOnSegment } from './vector.js';

const priority = { endpoint: 0, 'node-intersection': 1, 'node-inference': 2, midpoint: 3, alignment: 4, angle: 5, edge: 6, grid: 7, none: 99 };
const INFERENCE_ANGLES = Array.from({ length: 8 }, (_, index) => index * Math.PI / 8);
const EPSILON = 1e-8;

export function collectSnapTargets(objects = []) {
  const targets = [];
  objects.forEach((object) => {
    const sourcePriority = Number(object.snapPriority ?? 0);
    const prefix = object.snapSource === 'cat' ? 'CAT ' : '';
    object.vertices?.forEach((vertex) => targets.push({ type: 'endpoint', point: vertex, referenceId: vertex.id, sourcePriority, label: `${prefix}node` }));
    object.edges?.forEach((edge, index) => {
      const start = object.vertices[index];
      const end = object.vertices[(index + 1) % object.vertices.length];
      if (!start || !end) return;
      targets.push({ type: 'midpoint', point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, referenceId: edge.id, sourcePriority, label: `${prefix}midpoint` });
      targets.push({ type: 'edge', start, end, referenceId: edge.id, sourcePriority, label: `${prefix}edge` });
    });
  });
  return targets;
}

export function resolveSnap(candidate, context = {}) {
  const anchor = context.anchor ?? null;
  const tolerance = context.tolerance ?? 4;
  const grid = context.grid ?? .5;
  const candidates = [];
  for (const target of context.targets ?? []) {
    if (context.edgesEnabled === false) continue;
    if (target.type === 'edge') {
      const projected = nearestPointOnSegment(candidate, target.start, target.end);
      if (projected.distance <= tolerance) candidates.push({ ...target, point: projected.point, distance: projected.distance });
    } else {
      const targetDistance = distance(candidate, target.point);
      if (targetDistance <= tolerance) candidates.push({ ...target, distance: targetDistance });
    }
  }
  if (anchor) {
    const dx = candidate.x - anchor.x;
    const dy = candidate.y - anchor.y;
    const length = Math.hypot(dx, dy);
    if (Math.abs(dy) <= tolerance) candidates.push({ type: 'alignment', relation: 'Horizontal', point: { x: candidate.x, y: anchor.y }, distance: Math.abs(dy), guides: ['horizontal'] });
    if (Math.abs(dx) <= tolerance) candidates.push({ type: 'alignment', relation: 'Vertical', point: { x: anchor.x, y: candidate.y }, distance: Math.abs(dx), guides: ['vertical'] });
    if (length > 0) {
      const angle = Math.atan2(dy, dx);
      const increment = context.angleIncrementRadians ?? Math.PI / 4;
      const lockedAngle = Math.round(angle / increment) * increment;
      const angularOffset = Math.abs(Math.atan2(Math.sin(angle - lockedAngle), Math.cos(angle - lockedAngle)));
      if (angularOffset <= 4 * Math.PI / 180) candidates.push({ type: 'angle', relation: preciseAngleLabel(lockedAngle), point: { x: anchor.x + Math.cos(lockedAngle) * length, y: anchor.y + Math.sin(lockedAngle) * length }, distance: angularOffset * length, guides: ['angle'] });
      if (context.nodeInference !== false) {
        addNodeInferenceCandidates(candidates, candidate, anchor, lockedAngle, angularOffset, context);
      }
    }
  }
  if (context.gridEnabled !== false) candidates.push({ type: 'grid', point: { x: Math.round(candidate.x / grid) * grid, y: Math.round(candidate.y / grid) * grid }, distance: 0 });
  else candidates.push({ type: 'none', point: { ...candidate }, distance: 0 });
  candidates.sort((a, b) => priority[a.type] - priority[b.type] || (a.sourcePriority ?? 0) - (b.sourcePriority ?? 0) || a.distance - b.distance);
  const result = candidates[0];
  return { point: result.point, type: result.type, label: result.relation ?? result.label ?? snapLabel(result.type), guides: result.guides ?? [], referenceId: result.referenceId ?? null, inference: result.inference ?? null };
}

function addNodeInferenceCandidates(candidates, candidate, anchor, lockedAngle, angularOffset, context) {
  const tolerance = context.inferenceTolerance ?? context.tolerance ?? 4;
  const releaseMultiplier = context.inferenceReleaseMultiplier ?? 1.45;
  const referenceLimit = context.maxInferenceReferenceDistance ?? Infinity;
  const diagonalEnabled = context.diagonalInference !== false;
  const endpoints = (context.targets ?? []).filter((target) => target.type === 'endpoint' && target.referenceId && target.referenceId !== context.anchorReferenceId);
  const activeDirection = { x: Math.cos(lockedAngle), y: Math.sin(lockedAngle) };
  const activeAngleValid = angularOffset <= (context.angleToleranceRadians ?? 4 * Math.PI / 180);
  for (const target of endpoints) {
    if (distance(candidate, target.point) > referenceLimit) continue;
    const targetTolerance = target.referenceId === context.preferredReferenceId ? tolerance * releaseMultiplier : tolerance;
    for (const guideAngle of INFERENCE_ANGLES) {
      if (!diagonalEnabled && guideAngle !== 0 && guideAngle !== Math.PI / 2) continue;
      const guideDirection = { x: Math.cos(guideAngle), y: Math.sin(guideAngle) };
      const projection = projectToInfiniteLine(candidate, target.point, guideDirection);
      if (projection.distance <= targetTolerance) {
        candidates.push({
          type: 'node-inference',
          relation: `${guideLabel(guideAngle)} from node`,
          point: projection.point,
          distance: projection.distance,
          referenceId: target.referenceId,
          inference: { referencePoint: target.point, guideAngle, combined: false },
        });
      }
      if (!activeAngleValid) continue;
      const intersection = intersectInfiniteLines(anchor, activeDirection, target.point, guideDirection);
      if (!intersection || distance(candidate, intersection) > targetTolerance) continue;
      candidates.push({
        type: 'node-intersection',
        relation: `${angleLabel(lockedAngle)} · ${guideLabel(guideAngle)} to node`,
        point: intersection,
        distance: distance(candidate, intersection),
        referenceId: target.referenceId,
        guides: axisGuides(lockedAngle),
        inference: { referencePoint: target.point, guideAngle, sourceAngle: lockedAngle, combined: true },
      });
    }
  }
}

function projectToInfiniteLine(point, linePoint, direction) {
  const along = (point.x - linePoint.x) * direction.x + (point.y - linePoint.y) * direction.y;
  const projected = { x: linePoint.x + direction.x * along, y: linePoint.y + direction.y * along };
  return { point: projected, distance: distance(point, projected) };
}

function intersectInfiniteLines(firstPoint, firstDirection, secondPoint, secondDirection) {
  const denominator = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
  if (Math.abs(denominator) < EPSILON) return null;
  const dx = secondPoint.x - firstPoint.x;
  const dy = secondPoint.y - firstPoint.y;
  const firstT = (dx * secondDirection.y - dy * secondDirection.x) / denominator;
  return { x: firstPoint.x + firstDirection.x * firstT, y: firstPoint.y + firstDirection.y * firstT };
}

function normalizedDegrees(angle) {
  const degrees = Math.round(angle * 180 / Math.PI);
  return ((degrees % 360) + 360) % 360;
}

function preciseAngleLabel(angle) {
  const degrees = angle * 180 / Math.PI;
  const rounded = Math.round(degrees * 2) / 2;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}°`;
}

function guideLabel(angle) {
  const degrees = ((angle * 180 / Math.PI) % 180 + 180) % 180;
  if (Math.abs(degrees) < EPSILON) return 'Horizontal';
  if (Math.abs(degrees - 90) < EPSILON) return 'Vertical';
  const rounded = Math.round(degrees * 2) / 2;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}°`;
}

function angleLabel(angle) {
  const degrees = normalizedDegrees(angle);
  if (degrees === 0 || degrees === 180) return 'Horizontal';
  if (degrees === 90 || degrees === 270) return 'Vertical';
  return `${degrees}°`;
}

function axisGuides(angle) {
  const degrees = normalizedDegrees(angle);
  if (degrees === 0 || degrees === 180) return ['horizontal'];
  if (degrees === 90 || degrees === 270) return ['vertical'];
  return ['angle'];
}

function snapLabel(type) {
  return ({ endpoint: 'Endpoint', midpoint: 'Midpoint', edge: 'On edge', grid: 'Grid', alignment: 'Aligned', angle: 'Angle', 'node-inference': 'Node inference', 'node-intersection': 'Node intersection' })[type] ?? 'Free';
}
