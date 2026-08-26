export const EDGE_PROPERTY_SCHEMA_VERSION = 2;

export function createEdgeProperties(overrides = {}) {
  return {
    classification: {
      relationship: 'unassigned',
      exterior: true,
      ...overrides.classification,
    },
    finishes: {
      fascia: false,
      pictureFrame: false,
      ...overrides.finishes,
    },
    safety: {
      railing: 'unassigned',
      ...overrides.safety,
    },
    existingConditions: {
      demolition: false,
      ...overrides.existingConditions,
    },
    attachments: {
      // null preserves legacy House Attachment edges: until explicitly changed,
      // they continue to behave as the ledger relationship CME historically implied.
      ledger: null,
      rimJoist: null,
      ...overrides.attachments,
    },
    custom: { ...overrides.custom },
  };
}

export function mergeEdgeProperties(current = {}, patch = {}) {
  const base = createEdgeProperties(current);
  return Object.fromEntries(Object.keys(base).map((group) => [group, { ...base[group], ...(patch[group] ?? {}) }]));
}

export function combineEdgeProperties(primary = {}, secondary = {}, removedEdgeId = null) {
  const first = createEdgeProperties(primary);
  const second = createEdgeProperties(secondary);
  return createEdgeProperties({
    classification: {
      ...first.classification,
      relationship: first.classification.relationship === 'unassigned' ? second.classification.relationship : first.classification.relationship,
      exterior: first.classification.exterior || second.classification.exterior,
    },
    finishes: {
      fascia: first.finishes.fascia || second.finishes.fascia,
      pictureFrame: first.finishes.pictureFrame || second.finishes.pictureFrame,
    },
    safety: {
      railing: first.safety.railing === 'unassigned' ? second.safety.railing : first.safety.railing,
    },
    existingConditions: {
      demolition: first.existingConditions.demolition || second.existingConditions.demolition,
    },
    attachments: { ...second.attachments, ...first.attachments },
    custom: {
      ...second.custom,
      ...first.custom,
      mergedFromEdgeIds: [...new Set([...(first.custom.mergedFromEdgeIds ?? []), ...(second.custom.mergedFromEdgeIds ?? []), removedEdgeId].filter(Boolean))],
    },
  });
}

export function normalizeBoundaryEdge(edge) {
  return {
    type: 'boundary-edge',
    schemaVersion: EDGE_PROPERTY_SCHEMA_VERSION,
    ...edge,
    properties: createEdgeProperties(edge.properties),
    metadata: { ...edge.metadata },
  };
}
