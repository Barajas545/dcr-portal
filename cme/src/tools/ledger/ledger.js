import { distance } from '../../core/geometry/vector.js';
import { planBeamStock } from '../beam/beam.js';

export const DEFAULT_LEDGER_MATERIAL = Object.freeze({ size: '2×6 PT', treatment: 'PT' });

function isLedgerEdge(edge) {
  const relationship = edge.properties?.classification?.relationship;
  const houseAttachment = edge.role === 'house' || relationship === 'house-attachment';
  return houseAttachment && edge.properties?.attachments?.ledger !== false;
}

function dominantBoundaryJoistSize(document, boundaryId) {
  const counts = new Map();
  (document.objects ?? []).filter((object) => object.type === 'joist' && object.layout?.boundaryId === boundaryId).forEach((joist) => {
    const size = String(joist.size ?? '').trim();
    if (size) counts.set(size, (counts.get(size) ?? 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? DEFAULT_LEDGER_MATERIAL.size;
}

/**
 * Converts structural Ledger edges into purchasable framing stock. A Ledger
 * follows the dominant Joist Field size in its Deck Boundary unless a future
 * edge-level material override is present.
 */
export function describeLedgerTakeoff(document) {
  const groups = new Map();
  (document.objects ?? []).filter((object) => object.type === 'deck-boundary').forEach((boundary) => {
    const vertices = new Map(boundary.vertices.map((vertex) => [vertex.id, vertex]));
    const inheritedSize = dominantBoundaryJoistSize(document, boundary.id);
    boundary.edges.filter(isLedgerEdge).forEach((edge) => {
      const start = vertices.get(edge.startVertexId);
      const end = vertices.get(edge.endVertexId);
      if (!start || !end) return;
      const configured = String(edge.properties?.attachments?.ledgerMaterial?.size ?? '').trim();
      const size = configured || inheritedSize;
      planBeamStock(distance(start, end)).byLength.forEach(({ lengthFeet, quantity }) => {
        const key = `${size.toLowerCase()}:${lengthFeet}`;
        const group = groups.get(key) ?? { size, lengthFeet, quantity: 0, sourceObjectIds: [] };
        group.quantity += quantity;
        group.sourceObjectIds.push(edge.id);
        groups.set(key, group);
      });
    });
  });
  return [...groups.entries()].map(([key, group]) => ({
    kind: 'count',
    id: `auto:framing:ledger:${key.replace(/[^a-z0-9]+/g, '-')}`,
    category: 'framing',
    description: `${group.size} ledger`,
    specification: `${group.lengthFeet} ft stock · structural house attachment`,
    quantity: group.quantity,
    stockLengthFeet: group.lengthFeet,
    sourceObjectIds: [...new Set(group.sourceObjectIds)],
    confidence: 'preliminary',
  }));
}
