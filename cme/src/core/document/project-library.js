import { parseProject } from './project-document.js';

export const PROJECT_LIBRARY_SCHEMA = 'com.dcr.cme.project-library';
export const PROJECT_LIBRARY_VERSION = 1;

export function createProjectLibrary(project) {
  if (!project?.id) throw new Error('A project is required to create the CME project library.');
  return {
    schema: PROJECT_LIBRARY_SCHEMA,
    schemaVersion: PROJECT_LIBRARY_VERSION,
    activeProjectId: project.id,
    projects: [project],
  };
}

export function getActiveProject(library) {
  return library.projects.find((project) => project.id === library.activeProjectId) ?? library.projects[0] ?? null;
}

export function upsertLibraryProject(library, project) {
  const index = library.projects.findIndex((entry) => entry.id === project.id);
  const projects = [...library.projects];
  if (index >= 0) projects[index] = project;
  else projects.unshift(project);
  return { ...library, activeProjectId: project.id, projects };
}

export function activateLibraryProject(library, projectId) {
  if (!library.projects.some((project) => project.id === projectId)) throw new Error('CME project was not found.');
  return { ...library, activeProjectId: projectId };
}

export function removeLibraryProject(library, projectId) {
  const projects = library.projects.filter((project) => project.id !== projectId);
  const activeProjectId = library.activeProjectId === projectId ? projects[0]?.id ?? null : library.activeProjectId;
  return { ...library, activeProjectId, projects };
}

export function serializeProjectLibrary(library) {
  return JSON.stringify(library);
}

export function parseProjectLibrary(serialized) {
  const library = JSON.parse(serialized);
  if (library.schema !== PROJECT_LIBRARY_SCHEMA || library.schemaVersion !== PROJECT_LIBRARY_VERSION || !Array.isArray(library.projects)) {
    throw new Error('Unsupported CME project library.');
  }
  const projects = library.projects.map((project) => parseProject(JSON.stringify(project)));
  const activeProjectId = projects.some((project) => project.id === library.activeProjectId) ? library.activeProjectId : projects[0]?.id ?? null;
  return { ...library, activeProjectId, projects };
}
