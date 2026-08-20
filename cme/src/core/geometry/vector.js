export const EPSILON = 1e-6;

export function point(x, y) {
  return { x: Number(x), y: Number(y) };
}

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polygonArea(vertices) {
  if (vertices.length < 3) return 0;
  const signedTwiceArea = vertices.reduce((sum, vertex, index) => {
    const next = vertices[(index + 1) % vertices.length];
    return sum + vertex.x * next.y - next.x * vertex.y;
  }, 0);
  return Math.abs(signedTwiceArea) / 2;
}

export function polygonPerimeter(vertices, closed = true) {
  if (vertices.length < 2) return 0;
  let total = 0;
  const edgeCount = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < edgeCount; index += 1) {
    total += distance(vertices[index], vertices[(index + 1) % vertices.length]);
  }
  return total;
}

export function orientation(a, b, c) {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < EPSILON) return 0;
  return value > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return b.x <= Math.max(a.x, c.x) + EPSILON && b.x + EPSILON >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) + EPSILON && b.y + EPSILON >= Math.min(a.y, c.y);
}

export function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, c, b))
    || (o2 === 0 && onSegment(a, d, b))
    || (o3 === 0 && onSegment(c, a, d))
    || (o4 === 0 && onSegment(c, b, d));
}

export function findSelfIntersections(vertices) {
  const intersections = [];
  if (vertices.length < 4) return intersections;
  for (let first = 0; first < vertices.length; first += 1) {
    const firstNext = (first + 1) % vertices.length;
    for (let second = first + 1; second < vertices.length; second += 1) {
      const secondNext = (second + 1) % vertices.length;
      const adjacent = first === second || firstNext === second || secondNext === first;
      if (!adjacent && segmentsIntersect(vertices[first], vertices[firstNext], vertices[second], vertices[secondNext])) {
        intersections.push([first, second]);
      }
    }
  }
  return intersections;
}

export function nearestPointOnSegment(target, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < EPSILON) return { point: { ...start }, t: 0, distance: distance(target, start) };
  const t = Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / lengthSquared));
  const projected = { x: start.x + t * dx, y: start.y + t * dy };
  return { point: projected, t, distance: distance(target, projected) };
}

export function snapPoint(candidate, anchor, options = {}) {
  const grid = options.grid ?? 6;
  const axisThreshold = options.axisThreshold ?? 4;
  let snapped = {
    x: Math.round(candidate.x / grid) * grid,
    y: Math.round(candidate.y / grid) * grid,
  };
  const guides = [];
  if (anchor) {
    if (Math.abs(candidate.x - anchor.x) <= axisThreshold) {
      snapped.x = anchor.x;
      guides.push('vertical');
    }
    if (Math.abs(candidate.y - anchor.y) <= axisThreshold) {
      snapped.y = anchor.y;
      guides.push('horizontal');
    }
  }
  return { point: snapped, guides };
}
