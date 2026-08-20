export const PROJECT_SCHEMA = 'com.dcr.cme.project';
export const PROJECT_SCHEMA_VERSION = 2;

export function createProjectDocument(options = {}) {
  const now = options.now ?? new Date().toISOString();
  return {
    schema: PROJECT_SCHEMA,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: options.id ?? crypto.randomUUID(),
    name: options.name ?? 'Untitled deck',
    units: 'imperial',
    workflow: {
      stage: 'field-capture',
      detailLevel: 1,
      stageChangedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    objects: [],
  };
}

export function upsertObject(document, object, now = new Date().toISOString()) {
  const index = document.objects.findIndex((entry) => entry.id === object.id);
  const objects = [...document.objects];
  if (index >= 0) objects[index] = object;
  else objects.push(object);
  return { ...document, updatedAt: now, objects };
}

export function serializeProject(document) {
  return JSON.stringify(document, null, 2);
}

export function parseProject(serialized) {
  const document = JSON.parse(serialized);
  if (document.schema !== PROJECT_SCHEMA || ![1, PROJECT_SCHEMA_VERSION].includes(document.schemaVersion) || !Array.isArray(document.objects)) {
    throw new Error('Unsupported CME project document.');
  }
  if (document.schemaVersion === 1) {
    return {
      ...document,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      workflow: { stage: 'field-capture', detailLevel: 1, stageChangedAt: document.updatedAt },
    };
  }
  return document;
}

export function setProjectWorkflowStage(document, stage, now = new Date().toISOString()) {
  const stages = { 'field-capture': 1, 'estimate-ready': 2, 'detailed-modeling': 3, 'construction-ready': 4 };
  if (!stages[stage]) throw new Error(`Unsupported project workflow stage: ${stage}`);
  return {
    ...document,
    updatedAt: now,
    workflow: { ...document.workflow, stage, detailLevel: stages[stage], stageChangedAt: now },
  };
}
