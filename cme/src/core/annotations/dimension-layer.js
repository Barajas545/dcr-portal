export const DIMENSION_LAYER_TYPE = 'dimension-layer';
export const DIMENSION_LAYER_ID = 'project-dimensions';

export function createDimensionLayer(overrides = {}) {
  return {
    type: DIMENSION_LAYER_TYPE,
    schemaVersion: 1,
    id: DIMENSION_LAYER_ID,
    name: 'Dimensions',
    visible: true,
    offsets: {},
    leaderOffsets: {},
    hiddenReferenceIds: [],
    ...overrides,
  };
}

export function getDimensionLayer(document) {
  const stored = document.objects.find((object) => object.type === DIMENSION_LAYER_TYPE);
  return createDimensionLayer(stored ?? {});
}

function replaceDimensionLayer(document, layer) {
  const index = document.objects.findIndex((object) => object.type === DIMENSION_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}

export function setDimensionLayerVisibility(document, visible) {
  return replaceDimensionLayer(document, { ...getDimensionLayer(document), visible: Boolean(visible) });
}

export function setDimensionOffset(document, referenceId, offset) {
  const layer = getDimensionLayer(document);
  return replaceDimensionLayer(document, {
    ...layer,
    offsets: {
      ...layer.offsets,
      [referenceId]: { x: Number(offset.x) || 0, y: Number(offset.y) || 0 },
    },
  });
}

export function getDimensionOffset(document, referenceId) {
  return getDimensionLayer(document).offsets[referenceId] ?? { x: 0, y: 0 };
}

export function setDimensionLeaderOffset(document, referenceId, offset) {
  const layer = getDimensionLayer(document);
  return replaceDimensionLayer(document, {
    ...layer,
    leaderOffsets: {
      ...layer.leaderOffsets,
      [referenceId]: { x: Number(offset.x) || 0, y: Number(offset.y) || 0 },
    },
  });
}

export function getDimensionLeaderOffset(document, referenceId) {
  return getDimensionLayer(document).leaderOffsets?.[referenceId] ?? { x: 0, y: 0 };
}

export function isDimensionReferenceVisible(document, referenceId) {
  return !getDimensionLayer(document).hiddenReferenceIds.includes(referenceId);
}

export function setDimensionReferenceVisibility(document, referenceId, visible) {
  const layer = getDimensionLayer(document);
  const hidden = new Set(layer.hiddenReferenceIds);
  if (visible) hidden.delete(referenceId);
  else hidden.add(referenceId);
  return replaceDimensionLayer(document, { ...layer, hiddenReferenceIds: [...hidden] });
}
