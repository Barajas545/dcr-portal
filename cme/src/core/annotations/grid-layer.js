export const GRID_LAYER_TYPE = 'grid-layer';
export const GRID_LAYER_ID = 'project-grid';

export function createGridLayer(overrides = {}) {
  return {
    type: GRID_LAYER_TYPE,
    schemaVersion: 1,
    id: GRID_LAYER_ID,
    name: 'Construction grid',
    visible: true,
    ...overrides,
  };
}

export function getGridLayer(document) {
  return createGridLayer(document.objects.find((object) => object.type === GRID_LAYER_TYPE) ?? {});
}

export function setGridLayerVisibility(document, visible) {
  const layer = { ...getGridLayer(document), visible: Boolean(visible) };
  const index = document.objects.findIndex((object) => object.type === GRID_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}
