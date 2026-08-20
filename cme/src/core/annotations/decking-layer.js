export const DECKING_LAYER_TYPE = 'decking-layer';
export const DECKING_LAYER_ID = 'project-decking';

export function createDeckingLayer(overrides = {}) {
  return { type: DECKING_LAYER_TYPE, schemaVersion: 1, id: DECKING_LAYER_ID, name: 'Decking', visible: true, ...overrides };
}

export function getDeckingLayer(document) {
  return createDeckingLayer(document.objects.find((object) => object.type === DECKING_LAYER_TYPE) ?? {});
}

export function setDeckingLayerVisibility(document, visible) {
  const layer = { ...getDeckingLayer(document), visible: Boolean(visible) };
  const index = document.objects.findIndex((object) => object.type === DECKING_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}
