export const RAILING_LAYER_TYPE = 'railing-layer';
export const RAILING_LAYER_ID = 'project-railings';

export function createRailingLayer(overrides = {}) {
  return {
    type: RAILING_LAYER_TYPE,
    schemaVersion: 1,
    id: RAILING_LAYER_ID,
    name: 'Railing',
    ...overrides,
    visible: overrides.visible ?? true,
    snap: { edges: true, grid: true, ...overrides.snap },
  };
}

export function getRailingLayer(document) {
  const stored = document.objects.find((object) => object.type === RAILING_LAYER_TYPE);
  return createRailingLayer(stored ?? {});
}

function replaceRailingLayer(document, layer) {
  const index = document.objects.findIndex((object) => object.type === RAILING_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}

export function setRailingLayerVisibility(document, visible) {
  return replaceRailingLayer(document, { ...getRailingLayer(document), visible: Boolean(visible) });
}

export function setRailingSnapSettings(document, patch) {
  const layer = getRailingLayer(document);
  return replaceRailingLayer(document, { ...layer, snap: { ...layer.snap, ...patch } });
}
