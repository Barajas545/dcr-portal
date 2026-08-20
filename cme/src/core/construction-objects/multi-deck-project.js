import { upsertObject } from '../document/project-document.js';
import { withComputedProperties } from '../../tools/deck-boundary/deck-boundary.js';

export function getDeckBoundaries(document) {
  return document.objects.filter((object) => object.type === 'deck-boundary');
}

export function getProjectSurfaceArea(document) {
  return getDeckBoundaries(document).reduce((total, boundary) => total + (boundary.computed?.areaSquareInches ?? 0), 0);
}

export function getBoundaryLevelDown(boundary) {
  return Math.max(0, Number(boundary.metadata?.levelDownInches ?? 0));
}

export function setBoundaryLevelDown(boundary, inches) {
  const levelDownInches = Number(inches);
  if (!Number.isFinite(levelDownInches) || levelDownInches < 0) throw new Error('Deck level must be zero or a positive number of inches down.');
  return {
    ...boundary,
    vertices: boundary.vertices.map((vertex) => ({ ...vertex, elevation: -levelDownInches })),
    metadata: { ...boundary.metadata, levelDownInches },
  };
}

export function translateDeckAssembly(document, boundaryId, delta) {
  const dx = Number(delta?.x);
  const dy = Number(delta?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Deck movement requires a valid offset.');
  const boundary = getDeckBoundaries(document).find((entry) => entry.id === boundaryId);
  if (!boundary) throw new Error('Deck Boundary was not found.');
  if (boundary.vertices.some((vertex) => vertex.locked) || boundary.edges.some((edge) => edge.properties?.custom?.locked)) throw new Error('Unlock this Deck Boundary before moving the complete area.');
  const crossDeckStair = document.objects.find((object) => object.type === 'stair' && object.destination && ((object.host?.boundaryId === boundaryId && object.destination.boundaryId !== boundaryId) || (object.destination.boundaryId === boundaryId && object.host?.boundaryId !== boundaryId)));
  if (crossDeckStair) throw new Error('A connected staircase constrains this deck to another level. Remove or reconnect that staircase before moving either deck.');
  const translated = withComputedProperties({
    ...boundary,
    vertices: boundary.vertices.map((vertex) => ({ ...vertex, x: vertex.x + dx, y: vertex.y + dy })),
  });
  let next = upsertObject(document, translated);
  next = {
    ...next,
    objects: next.objects.map((object) => {
      if (object.type === 'level-down' && object.host?.boundaryId === boundaryId) {
        return { ...object, vertices: object.vertices.map((vertex) => ({ ...vertex, x: vertex.x + dx, y: vertex.y + dy })) };
      }
      if (object.type !== 'railing-run') return object;
      const anchors = Object.fromEntries(Object.entries(object.anchors ?? {}).map(([key, anchor]) => {
        if (anchor.boundaryId !== boundaryId) return [key, anchor];
        return [key, { ...anchor, point: anchor.point ? { x: anchor.point.x + dx, y: anchor.point.y + dy } : anchor.point }];
      }));
      return { ...object, anchors };
    }),
  };
  return next;
}
