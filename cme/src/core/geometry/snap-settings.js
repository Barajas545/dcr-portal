export const SNAP_SETTINGS_TYPE = 'snap-settings';
export const SNAP_SETTINGS_ID = 'project-snap-settings';

export function createSnapSettings(overrides = {}) {
  return {
    type: SNAP_SETTINGS_TYPE,
    schemaVersion: 1,
    id: SNAP_SETTINGS_ID,
    name: 'Precision snaps',
    edges: overrides.edges ?? true,
    grid: overrides.grid ?? true,
    nodeInference: overrides.nodeInference ?? true,
    diagonalInference: overrides.diagonalInference ?? true,
  };
}

export function getSnapSettings(document) {
  const stored = document.objects.find((object) => object.type === SNAP_SETTINGS_TYPE);
  if (stored) return createSnapSettings(stored);
  const legacy = document.objects.find((object) => object.type === 'railing-layer')?.snap ?? {};
  return createSnapSettings({ edges: legacy.edges, grid: legacy.grid });
}

export function setSnapSettings(document, patch) {
  const settings = createSnapSettings({ ...getSnapSettings(document), ...patch });
  const index = document.objects.findIndex((object) => object.type === SNAP_SETTINGS_TYPE);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = settings;
  else objects.push(settings);
  return { ...document, updatedAt: new Date().toISOString(), objects };
}
