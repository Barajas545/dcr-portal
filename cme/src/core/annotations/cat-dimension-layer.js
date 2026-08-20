export const CAT_DIMENSION_LAYER_TYPE = 'cat-dimension-layer';
export const CAT_DIMENSION_LAYER_ID = 'project-cat-dimensions';

export function createCatDimensionLayer(overrides = {}) {
  return {
    type: CAT_DIMENSION_LAYER_TYPE,
    schemaVersion: 1,
    id: CAT_DIMENSION_LAYER_ID,
    name: 'CAT dimensions',
    visible: true,
    ...overrides,
  };
}

export function getCatDimensionLayer(document) {
  return createCatDimensionLayer(document.objects.find((object) => object.type === CAT_DIMENSION_LAYER_TYPE) ?? {});
}

export function setCatDimensionLayerVisibility(document, visible) {
  const layer = { ...getCatDimensionLayer(document), visible: Boolean(visible) };
  const index = document.objects.findIndex((object) => object.type === CAT_DIMENSION_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}
