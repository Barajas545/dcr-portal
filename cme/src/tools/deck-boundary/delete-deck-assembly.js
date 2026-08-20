import { upsertObject } from '../../core/document/project-document.js';
import { getDimensionLayer } from '../../core/annotations/dimension-layer.js';
import { markBoundaryEdited } from './deck-boundary.js';
import { detachStairFromBoundary, getStairInterfaceEdge, removeStairSideJunction } from '../stairs/stair.js';

function railingReferencesAny(railing, boundaryId, edgeIds, stairIds, stairInterfaceIds) {
  if (railing.host?.boundaryId === boundaryId || railing.host?.ownerId && stairIds.has(railing.host.ownerId)) return true;
  if (railing.anchors?.start?.boundaryId === boundaryId || railing.anchors?.end?.boundaryId === boundaryId) return true;
  return [railing.host?.edgeId, railing.anchors?.start?.edgeId, railing.anchors?.end?.edgeId]
    .some((id) => edgeIds.has(id) || stairInterfaceIds.has(id));
}

function cleanDimensionLayer(document, removedReferenceIds) {
  const layer = document.objects.find((object) => object.type === 'dimension-layer');
  if (!layer) return document;
  const keepEntries = (entries = {}) => Object.fromEntries(Object.entries(entries).filter(([id]) => !removedReferenceIds.has(id)));
  const cleaned = {
    ...getDimensionLayer(document),
    offsets: keepEntries(layer.offsets),
    leaderOffsets: keepEntries(layer.leaderOffsets),
    hiddenReferenceIds: (layer.hiddenReferenceIds ?? []).filter((id) => !removedReferenceIds.has(id)),
  };
  return { ...document, objects: document.objects.map((object) => object.id === cleaned.id ? cleaned : object) };
}

export function deleteDeckAssembly(document, boundaryId) {
  const target = document.objects.find((object) => object.type === 'deck-boundary' && object.id === boundaryId);
  if (!target) throw new Error('Deck area was not found.');
  const targetEdgeIds = new Set(target.edges.map((edge) => edge.id));
  const affectedStairs = document.objects.filter((object) => object.type === 'stair'
    && (object.host?.boundaryId === boundaryId || object.destination?.boundaryId === boundaryId));
  const stairIds = new Set(affectedStairs.map((stair) => stair.id));
  const stairInterfaceIds = new Set(affectedStairs.map((stair) => getStairInterfaceEdge(stair).id));
  let next = document;

  for (const originalStair of affectedStairs) {
    let stair = next.objects.find((object) => object.type === 'stair' && object.id === originalStair.id) ?? originalStair;
    for (const side of ['start', 'end']) {
      const attachment = stair.sideAttachments?.[side];
      if (!attachment?.junction || attachment.boundaryId === boundaryId) continue;
      const receivingBoundary = next.objects.find((object) => object.type === 'deck-boundary' && object.id === attachment.boundaryId);
      if (!receivingBoundary) continue;
      const disconnected = removeStairSideJunction(receivingBoundary, stair, side);
      stair = disconnected.stair;
      next = upsertObject(upsertObject(next, markBoundaryEdited(disconnected.boundary)), stair);
    }
    if (stair.host?.boundaryId !== boundaryId) {
      const host = next.objects.find((object) => object.type === 'deck-boundary' && object.id === stair.host.boundaryId);
      if (host) next = upsertObject(next, markBoundaryEdited(detachStairFromBoundary(host, stair)));
    }
  }

  const levelDowns = next.objects.filter((object) => object.type === 'level-down' && object.host?.boundaryId === boundaryId);
  const removedReferenceIds = new Set([
    boundaryId,
    `${boundaryId}:area`,
    ...target.vertices.map((vertex) => vertex.id),
    ...target.edges.map((edge) => edge.id),
    ...affectedStairs.flatMap((stair) => [stair.id, `${stair.id}:label`, getStairInterfaceEdge(stair).id]),
    ...levelDowns.flatMap((levelDown) => [levelDown.id, `${levelDown.id}:drop`, ...levelDown.segments.map((segment) => segment.id)]),
  ]);
  const removedRailingIds = new Set(next.objects
    .filter((object) => object.type === 'railing-run' && railingReferencesAny(object, boundaryId, targetEdgeIds, stairIds, stairInterfaceIds))
    .map((railing) => railing.id));
  removedRailingIds.forEach((id) => removedReferenceIds.add(id));
  const removedLevelDownIds = new Set(levelDowns.map((levelDown) => levelDown.id));

  next = {
    ...next,
    updatedAt: new Date().toISOString(),
    objects: next.objects.filter((object) => object.id !== boundaryId
      && !stairIds.has(object.id)
      && !removedLevelDownIds.has(object.id)
      && !removedRailingIds.has(object.id)),
  };
  next = cleanDimensionLayer(next, removedReferenceIds);
  return {
    document: next,
    removed: {
      boundaryCount: 1,
      stairCount: stairIds.size,
      railingCount: removedRailingIds.size,
      levelDownCount: removedLevelDownIds.size,
    },
  };
}
