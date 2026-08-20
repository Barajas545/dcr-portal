export const CAT_CONSTRUCTION_LAYER_TYPE = 'cat-construction-layer';
export const CAT_CONSTRUCTION_LAYER_ID = 'project-cat-construction-lines';

export function createCatConstructionLayer(overrides = {}) {
  return {
    type: CAT_CONSTRUCTION_LAYER_TYPE,
    schemaVersion: 1,
    id: CAT_CONSTRUCTION_LAYER_ID,
    name: 'CAT construction lines',
    visible: true,
    ...overrides,
  };
}

export function getCatConstructionLayer(document) {
  return createCatConstructionLayer(document.objects.find((object) => object.type === CAT_CONSTRUCTION_LAYER_TYPE) ?? {});
}

export function setCatConstructionLayerVisibility(document, visible) {
  const layer = { ...getCatConstructionLayer(document), visible: Boolean(visible) };
  const index = document.objects.findIndex((object) => object.type === CAT_CONSTRUCTION_LAYER_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = layer;
  else objects.push(layer);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}
