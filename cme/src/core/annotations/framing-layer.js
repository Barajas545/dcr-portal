export const FRAMING_LAYER_TYPE = 'framing-layer';
export const FRAMING_LAYER_ID = 'project-framing';

export const DEFAULT_FRAMING_SETTINGS = Object.freeze({
  defaultJoistSpacingInches: 16,
  beamMaxPostSpacingFeet: 6,
  footingSizeInches: 16,
  concreteBagsPerFooting: 3,
  postStockFeet: 10,
  postCutFeet: 5,
  framingSystem: 'bottom',
});

export function createFramingLayer(overrides = {}) {
  return {
    type: FRAMING_LAYER_TYPE,
    schemaVersion: 1,
    id: FRAMING_LAYER_ID,
    name: 'Framing',
    visible: overrides.visible ?? true,
    joistsVisible: overrides.joistsVisible ?? true,
    settings: { ...DEFAULT_FRAMING_SETTINGS, ...overrides.settings },
  };
}

export function getFramingLayer(document) {
  const stored = document?.objects?.find((object) => object.type === FRAMING_LAYER_TYPE);
  return createFramingLayer(stored ?? {});
}

function replaceFramingLayer(document, layer) {
  const objects = [...(document.objects ?? [])];
  const index = objects.findIndex((object) => object.type === FRAMING_LAYER_TYPE);
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}

export function setFramingLayerVisibility(document, visible) {
  return replaceFramingLayer(document, { ...getFramingLayer(document), visible: Boolean(visible) });
}

export function setJoistLayerVisibility(document, visible) {
  return replaceFramingLayer(document, { ...getFramingLayer(document), joistsVisible: Boolean(visible) });
}

export function updateFramingSettings(document, patch = {}) {
  const layer = getFramingLayer(document);
  return replaceFramingLayer(document, {
    ...layer,
    settings: { ...layer.settings, ...patch },
  });
}
