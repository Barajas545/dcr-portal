import { createProjectDocument, parseProject, serializeProject, setProjectWorkflowStage, upsertObject } from '../core/document/project-document.js';
import { activateLibraryProject, createProjectLibrary, getActiveProject, parseProjectLibrary, removeLibraryProject, serializeProjectLibrary, upsertLibraryProject } from '../core/document/project-library.js';
import { createSalesHubStepOneMessage, createSalesHubStepOnePayload, parseSalesHubLaunchContext } from '../core/integrations/dcr-sales-hub.js';
import { deriveModelProgress } from '../core/construction-objects/progressive-model.js';
import { getBoundaryLevelDown, getDeckBoundaries, getProjectSurfaceArea, setBoundaryLevelDown, translateDeckAssembly } from '../core/construction-objects/multi-deck-project.js';
import { normalizeBoundaryEdge } from '../core/construction-objects/edge-properties.js';
import { getDimensionLayer, getDimensionLeaderOffset, getDimensionOffset, isDimensionReferenceVisible, setDimensionLayerVisibility, setDimensionLeaderOffset, setDimensionOffset, setDimensionReferenceVisibility } from '../core/annotations/dimension-layer.js';
import { getCatConstructionLayer, setCatConstructionLayerVisibility } from '../core/annotations/cat-construction-layer.js';
import { getCatDimensionLayer, setCatDimensionLayerVisibility } from '../core/annotations/cat-dimension-layer.js';
import { getDeckingLayer, setDeckingLayerVisibility } from '../core/annotations/decking-layer.js';
import { getGridLayer, setGridLayerVisibility } from '../core/annotations/grid-layer.js';
import { getRailingLayer, setRailingLayerVisibility } from '../core/annotations/railing-layer.js';
import { collectSnapTargets, resolveSnap } from '../core/geometry/snap-engine.js';
import { getSnapSettings, setSnapSettings } from '../core/geometry/snap-settings.js';
import { nearestPointOnSegment } from '../core/geometry/vector.js';
import { formatFeetInches, formatInches, formatSquareFeet } from '../core/units/length.js';
import { parseConstructionLength } from '../core/units/parse-length.js';
import { CommandStack, replaceDocument } from '../history/command-stack.js';
import { adaptiveGridSpacing, createViewport, fitViewport, panViewport, zoomViewport } from '../rendering/viewport-controller.js';
import { createBeam, addBeam, getBeams } from '../tools/beam/beam.js';
import { createJoist, addJoist, getJoists, arrayObject, ON_CENTRE_SPACINGS, DEFAULT_SPACING_INCHES, DEFAULT_COPIES, MAX_COPIES } from '../tools/joist-group/joist-group.js';
import { createPost, createPillar, addPost, getPosts, getPillars } from '../tools/post-footing/post-footing.js';
import { createGate, createCountMarker, nextSequence, getGates, getCountMarkers } from '../tools/symbols/symbols.js';
import { chamferVertex, clearEdgeOrientationConstraint, createDeckBoundary, findAdjacentMergeCandidate, getBoundaryCentroid, getBoundaryLifecycle, getEdgeOrientationConstraint, insertVertex, isEdgeLocked, isVertexLocked, markBoundaryEdited, mergeAdjacentVertices, moveVertexWithConstraints, offsetEdge, orthogonalizeBoundary, removeVertex, setEdgeLength, setEdgeLocked, setEdgeOrientationConstraint, setEdgeRole, setVertexLocked, splitEdgeIntoSegments, updateEdgeProperties, validateDeckBoundary } from '../tools/deck-boundary/deck-boundary.js';
import { deleteDeckAssembly } from '../tools/deck-boundary/delete-deck-assembly.js';
import { clearDeckBoardingDirection, deriveDeckBoardingSegments, getDeckBoarding, rotateDeckBoardingDirection, setDeckBoardingDirection } from '../tools/deck-boarding/deck-boarding.js';
import { deriveBeamGeometry, framingSystem } from '../tools/beam/beam-geometry.js';
import { getDeckLevelInches, setDeckLevelInches, standardApplies } from '../tools/framing-standard/framing-standard.js';
import { SECOND_FLOOR_LEVEL_INCHES, isSecondFloor } from '../core/standards/dcr-construction-standard.js';
import { CAT_LINE_TYPE, CAT_MEASUREMENT_TYPE, CAT_NOTE_TYPE, createCatLine, createCatMeasurement, createCatNote, deriveCatMeasurement, extendCatLine, getCatLines, getCatMeasurements, getCatNotes, getCatSnapObjects, resolveCatLineEndpoint, trimCatLine, updateCatNote } from '../tools/cat-cl/cat-cl.js';
import { createLevelDown, deriveLevelDownDepth, deriveLevelDownRegion, orthogonalizeLevelDown, setLevelDownRiserHeight, splitLevelDownSegment, updateLevelDownProperties } from '../tools/level-down/level-down.js';
import { attachStairToBoundary, deriveStairDragOptions, deriveStairOpeningSnap, deriveStairSideSegments, deriveStairTreads, detachStairFromBoundary, findStairBoundaryConnection, getStairInterfaceEdge, materializeStairSideJunction, mergeStairBoundaryConnection, removeStairSideJunction, resolveStairHostEdge, setStairSidePosition, setStairWidth, synchronizeConnectedStairLevels, updateStairDimensions, updateStairInterfaceEdgeProperties, validateStairPlacement } from '../tools/stairs/stair.js';
import { analyzeRailingGeometries, createRailingLine, deriveRailingGeometry, deriveRailingLineGeometry, resolveRailingEndpointSnap, updateRailingSettings } from '../tools/railing/railing.js';
import { TAKEOFF_CATEGORIES, addManualTakeoffLine, consolidateTakeoffLines, createTakeoffExport, getEffectiveTakeoffLines, getTakeoffState, removeManualTakeoffLine, resetTakeoffLine, setTakeoffNote, setTakeoffState, updateTakeoffLine } from '../tools/takeoff/takeoff.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/* Storage is scoped per estimate when the portal hosts this.

   The library key holds EVERY project on the device with an activeProjectId.
   On a shared tablet that means opening estimate B lists estimate A's customer
   by name in the switcher, and one wrong tap attaches the wrong deck to the
   wrong quote. Scoping the key keeps each estimate's drawing to itself.
   Standalone (no portal) keeps the original key, so existing local work is
   still found. */
const STORAGE_SCOPE = (typeof window !== 'undefined' && window.CME_STORAGE_SCOPE)
  ? String(window.CME_STORAGE_SCOPE) : '';
const SCOPE_SUFFIX = STORAGE_SCOPE && STORAGE_SCOPE !== 'standalone' ? '.' + STORAGE_SCOPE : '';
const IN_PORTAL = typeof window !== 'undefined' && Boolean(window.CME_PORTAL);
const STORAGE_KEY = 'cme.project.v1' + SCOPE_SUFFIX;
const PROJECT_LIBRARY_STORAGE_KEY = 'cme.project-library.v1' + SCOPE_SUFFIX;
const app = document.querySelector('#app');
let history = new CommandStack();
/* Declared before the library loads: loadProjectLibrary() runs on the next
   line and may need to park a boot notice, and `message` itself is declared
   further down. A let below the call site is a temporal-dead-zone crash - the
   boot error page caught exactly that during verification. */
let pendingBootNotice = null;
let projectLibrary = loadProjectLibrary();
let documentModel = getActiveProject(projectLibrary);

/* The portal bridge needs whatever is on screen right now. A closure over the
   `let` binding always reads the current one, so nothing has to be kept in
   sync and app.js needs no further portal awareness than this line. */
if (typeof window !== 'undefined') window.CME_CURRENT_DOCUMENT = () => documentModel;
/* The bridge must bill exactly what the on-screen takeoff bills. Wild Hog
   railing is derived from resolved geometries the caller supplies, so a bridge
   calling deriveAutomaticTakeoff with no options would silently drop every
   Wild Hog line from the saved drawing's table. */
if (typeof window !== 'undefined') window.CME_TAKEOFF_CONTEXT = () => takeoffContext();
const salesHubLaunch = parseSalesHubLaunchContext(window.location.search);
let mode = 'select';
let draft = [];
let pointerWorld = null;
let draggingVertexId = null;
let dragStartDocument = null;
let draggingEdgeId = null;
let edgeDragStart = null;
let mergeCandidateId = null;
let selected = { kind: null, id: null };
let message = pendingBootNotice ?? 'Ready';
let viewport = createViewport();
let panGesture = null;
let lastMiddleClick = 0;
let snapState = { type: 'grid', label: 'Grid', guides: [] };
let numericBuffer = '';
let lastLength = null;
let gridSetting = 'auto';
let viewportAnimation = 0;
const activeTouches = new Map();
let touchGesture = null;
let pendingTouch = null;
let stairDraft = null;
let stairGesture = null;
let stairSideGesture = null;
let dimensionDragStart = null;
let dimensionLeaderMode = null;
let dimensionLeaderGesture = null;
let chamferMode = null;
let chamferGesture = null;
let chamferDraft = null;
let railingDraft = null;
let railingGesture = null;
let levelDownDraft = [];
let levelDownPointer = null;
let activeBoundaryId = null;
let moveBoundaryMode = null;
let moveBoundaryGesture = null;
let boardingDirectionMode = null;
let pendingDeckDeleteId = null;
let utilityPanel = null;
let projectMenuOpen = false;
let exportMenuOpen = false;
let pendingProjectDeleteId = null;
let catTool = 'line';
let lastCountLabel = 'Count';
/* Framing is one rail button with a sub-palette rather than four more rail
   buttons: the rail is already nine deep and these four belong together. */
let framingTool = 'joist';
let framingDraft = null;
let framingSpacing = DEFAULT_SPACING_INCHES;
let framingCopies = DEFAULT_COPIES;
let catDraft = null;
let catPointer = null;
let catSnapState = { type: 'none', label: 'Free', guides: [] };
let catNoteDragStart = null;
let catAudioRecorder = null;
let catAudioChunks = [];
let takeoffOpen = false;
let takeoffExpanded = new Set(['decking', 'railing']);
let takeoffAddCategory = null;

/* The drawing saved on the estimate, handed over by the portal on open.

   Without this, the handoff was read off sessionStorage and then IGNORED - a
   drawing saved on one device reopened as an empty canvas on any other, and an
   estimator could never see the salesperson's sketch. It was masked in testing
   because the same browser still held a local copy under the same storage key.

   The local copy wins only when it is the same project with NEWER work - a rep
   who drew more after saving, then reopened. Handed-over work must never
   silently overwrite newer offline work; that is the vision's own guardrail. */
function incomingPortalProject() {
  const incoming = typeof window !== 'undefined' ? window.CME_PORTAL?.incoming : null;
  if (!incoming || typeof incoming !== 'object' || !incoming.id) return null;
  try {
    return parseProject(JSON.stringify(incoming));
  } catch (error) {
    console.warn('[CME] the handed-over drawing could not be read:', error);
    return null;
  }
}

function mergeIncoming(library, incoming) {
  if (!incoming) return library;
  const local = (library.projects ?? []).find((project) => project.id === incoming.id);
  /* >= not >: equal timestamps mean the same save-state, and the local copy
     is a strict superset - the handed-over one has its voice recordings
     stripped for transport. Preferring incoming on a tie deleted the local
     recordings the moment a saved drawing was reopened on the device that
     made it. */
  const localIsNewer = local && String(local.updatedAt ?? '') >= String(incoming.updatedAt ?? '');
  if (localIsNewer) {
    pendingBootNotice = 'This device has newer unsaved work on this drawing — showing that. Save to the estimate to keep it.';
    return activateLibraryProject(library, local.id);
  }
  return activateLibraryProject(upsertLibraryProject(library, incoming), incoming.id);
}

function loadProjectLibrary() {
  /* "New drawing" from the estimate means exactly that. Without this the
     estimate-scoped library reopened its previous active project, and saving
     produced a twin gallery entry of drawing #1 instead of a drawing #2. */
  if (typeof window !== 'undefined' && window.CME_PORTAL?.fresh) {
    const fresh = createProjectDocument({ name: window.CME_PORTAL?.clientName ? `${window.CME_PORTAL.clientName} deck` : 'New drawing' });
    const savedLibrary = localStorage.getItem(PROJECT_LIBRARY_STORAGE_KEY);
    if (savedLibrary) {
      try {
        return activateLibraryProject(upsertLibraryProject(parseProjectLibrary(savedLibrary), fresh), fresh.id);
      } catch { /* fall through to a clean library */ }
    }
    return createProjectLibrary(fresh);
  }
  const incoming = incomingPortalProject();
  const savedLibrary = localStorage.getItem(PROJECT_LIBRARY_STORAGE_KEY);
  if (savedLibrary) {
    try {
      const library = parseProjectLibrary(savedLibrary);
      if (getActiveProject(library)) return mergeIncoming(library, incoming);
    } catch { /* Migrate the last single-project save below. */ }
  }
  const savedProject = localStorage.getItem(STORAGE_KEY);
  if (savedProject) {
    try { return mergeIncoming(createProjectLibrary(parseProject(savedProject)), incoming); }
    catch { /* Recover with a new project below. */ }
  }
  if (incoming) return createProjectLibrary(incoming);
  return createProjectLibrary(createProjectDocument({ name: 'Backyard deck' }));
}

function boundaries() {
  return getDeckBoundaries(documentModel);
}

function boundary() {
  const decks = boundaries();
  const current = decks.find((entry) => entry.id === activeBoundaryId) ?? decks[0] ?? null;
  if (current) activeBoundaryId = current.id;
  return current;
}

function boundaryById(boundaryId) {
  return boundaries().find((entry) => entry.id === boundaryId) ?? null;
}

function boundaryForReference(referenceId) {
  if (!referenceId) return null;
  const direct = boundaries().find((entry) => entry.id === referenceId || `${entry.id}:area` === referenceId || entry.vertices.some((vertex) => vertex.id === referenceId) || entry.edges.some((edge) => edge.id === referenceId));
  if (direct) return direct;
  const stair = documentModel.objects.find((object) => object.type === 'stair' && (object.id === referenceId || getStairInterfaceEdge(object).id === referenceId));
  if (stair) return boundaryById(stair.host.boundaryId);
  const levelDown = documentModel.objects.find((object) => object.type === 'level-down' && (object.id === referenceId || `${object.id}:drop` === referenceId || object.segments?.some((segment) => segment.id === referenceId)));
  if (levelDown) return boundaryById(levelDown.host.boundaryId);
  const railing = documentModel.objects.find((object) => object.type === 'railing-run' && object.id === referenceId);
  const railingBoundaryId = railing?.host?.boundaryId ?? railing?.anchors?.start?.boundaryId ?? railing?.anchors?.end?.boundaryId;
  return boundaryById(railingBoundaryId);
}

function activateBoundary(boundaryId) {
  if (boundaryId && boundaryById(boundaryId)) activeBoundaryId = boundaryId;
}

function commit(next, label) {
  documentModel = history.execute(documentModel, replaceDocument(next, label));
  persist();
  render();
}

function commitBoundary(nextBoundary, label) {
  activeBoundaryId = nextBoundary.id;
  let next = upsertObject(documentModel, nextBoundary);
  /* Finishing the FIRST deck area sets the datum to the 4 ft standard, so the
     common job is laid out without anyone hunting for a setting. Strictly on
     creation and strictly when no level exists: a drawing made before the
     standard did must keep its numbers, and editing a boundary must never
     re-assert a level the user cleared on purpose. */
  const hadBoundary = documentModel.objects.some((entry) => entry.type === 'deck-boundary');
  if (!hadBoundary && getDeckLevelInches(documentModel) === null) {
    next = setDeckLevelInches(next, 48);
    message = 'Deck boundary created · primary deck level set to 4 ft';
  }
  commit(next, label);
}

/* Saving locally must never take the editor down with it.

   This used to be three unguarded statements. localStorage is 5-10 MB and a
   couple of projects with photos reach that, so a QuotaExceededError threw
   straight out of commit() BEFORE render() ran - the drawing froze mid-edit
   with nothing on screen explaining why, and the next click did nothing.

   Now a failed save is reported and the editor carries on: the change is still
   in memory and in the undo stack, and the next successful save writes it. The
   legacy single-project key is only written as a fallback, because nothing
   reads it once the library has loaded - writing it every commit doubled the
   storage cost for no benefit, which helped cause the quota error it then
   failed on. */
let lastPersistError = null;

function persist() {
  projectLibrary = upsertLibraryProject(projectLibrary, documentModel);
  try {
    localStorage.setItem(PROJECT_LIBRARY_STORAGE_KEY, serializeProjectLibrary(projectLibrary));
    if (lastPersistError) {
      lastPersistError = null;
      message = 'Saved on this device again.';
      updateStatusMessage();
    }
  } catch (error) {
    lastPersistError = error;
    const outOfRoom = error && (error.name === 'QuotaExceededError'
      || error.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error.code === 22);
    message = outOfRoom
      ? 'This device is out of storage room — your work is still open here. Save it to the estimate, or delete an old project, before closing this tab.'
      : 'Could not save on this device — your work is still open here. Save it to the estimate before closing this tab.';
    updateStatusMessage();
  }
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function screenToWorld(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function render() {
  const current = boundary();
  const validation = current ? validateDeckBoundary(current) : null;
  const progress = deriveModelProgress(documentModel);
  const dimensionLayer = getDimensionLayer(documentModel);
  const railingLayer = getRailingLayer(documentModel);
  const catConstructionLayer = getCatConstructionLayer(documentModel);
  const projectSurface = getProjectSurfaceArea(documentModel);
  const deckAreaCount = boundaries().length;
  const railingSummary = analyzeRailingGeometries(getAllRailingGeometries());
  const stairCount = documentModel.objects.filter((object) => object.type === 'stair').length;
  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand"><div class="brand-mark">CME</div><div class="brand-copy"><div class="brand-name">Construction Modeling Engine</div><div class="brand-subtitle">${progress.stage.label} · One evolving project</div></div></div>
        <div class="project-switcher">${IN_PORTAL
          ? `<div class="project-switcher-button" aria-hidden="true"><span class="saved-dot"></span><span>${escapeHtml(documentModel.name)}</span><small>${escapeHtml(window.CME_PORTAL?.clientName || 'Saved locally')}</small></div>`
          : `<button class="project-switcher-button ${projectMenuOpen ? 'active' : ''}" data-action="toggle-project-menu" aria-expanded="${projectMenuOpen}"><span class="saved-dot"></span><span>${escapeHtml(documentModel.name)}</span><small>Saved locally</small><b>⌄</b></button>${renderProjectMenu()}`
        }</div>
        <div class="project-summary" aria-label="Project totals"><div class="top-metric"><span>Project surface</span><strong>${formatSquareFeet(projectSurface)}</strong></div><div class="top-metric"><span>Deck areas</span><strong>${deckAreaCount}</strong></div></div>
        <div class="top-actions"><button class="button primary save-step-one" data-action="save-step-one">Save to Step 1</button><div class="export-control"><button class="button ghost export-toggle ${exportMenuOpen ? 'active-constraint' : ''}" data-action="toggle-export-menu" aria-expanded="${exportMenuOpen}"><span class="export-long">Export options</span><span class="export-short">Export</span> ⌄</button>${renderExportMenu()}</div></div>
      </header>
      ${renderTakeoffWorkspace()}
      <section class="workspace-shell">
        <nav class="toolrail" aria-label="Modeling tools">
          <button class="tool-button ${mode === 'select' ? 'active' : ''}" data-mode="select" title="Select and edit"><span class="tool-icon">↖</span><span class="tool-label">Select</span></button>
          <button class="tool-button ${mode === 'draw' ? 'active' : ''}" data-mode="draw" title="Draw a custom deck boundary"><span class="tool-icon">◇</span><span class="tool-label">Boundary</span></button>
          <button class="tool-button ${mode === 'stair' ? 'active' : ''}" data-mode="stair" title="Attach stairs to a boundary edge" ${!current ? 'disabled' : ''}><span class="tool-icon">▰</span><span class="tool-label">Stairs</span></button>
          <button class="tool-button ${mode === 'railing' ? 'active' : ''}" data-mode="railing" title="Add railing along a construction edge" ${!current ? 'disabled' : ''}><span class="tool-icon">╥</span><span class="tool-label">Railing</span></button>
          <button class="tool-button ${mode === 'cat' ? 'active' : ''}" data-mode="cat" title="Create CAT construction references and field measurements"><span class="tool-icon">⌁</span><span class="tool-label">CAT CL</span></button>
          <button class="tool-button ${mode === 'framing' ? 'active' : ''}" data-mode="framing" title="Beams, joists, posts and footings"><span class="tool-icon">▤</span><span class="tool-label">Framing</span></button>
          <div class="tool-spacer"></div>
          <button class="tool-button ${utilityPanel === 'visibility' ? 'active' : ''}" data-action="toggle-visibility-panel" title="Drawing layer visibility" aria-pressed="${utilityPanel === 'visibility'}"><span class="tool-icon">◉</span><span class="tool-label">Visibility</span></button>
          <button class="tool-button ${utilityPanel === 'snap' ? 'active' : ''}" data-action="toggle-snap-panel" title="Snap and precision controls" aria-pressed="${utilityPanel === 'snap'}"><span class="tool-icon">⌁</span><span class="tool-label">Snap</span></button>
          <button class="tool-button" data-action="toggle-inspector" title="Project details"><span class="tool-icon">☷</span><span class="tool-label">Details</span></button>
        </nav>
        <section class="canvas-panel">
          <div class="canvas-toolbar">
            <button class="button icon-button ghost" data-action="undo" aria-label="Undo" ${!history.canUndo ? 'disabled' : ''}>↶</button>
            <button class="button icon-button ghost" data-action="redo" aria-label="Redo" ${!history.canRedo ? 'disabled' : ''}>↷</button>
            <span class="divider"></span>
            <button class="button ${railingLayer.visible ? 'active-constraint' : 'ghost'}" data-action="toggle-railing-visibility" aria-pressed="${railingLayer.visible}" title="Show or hide all railing construction objects">${railingLayer.visible ? '◉' : '○'} Railing</button>
            <button class="button ${catConstructionLayer.visible ? 'active-constraint' : 'ghost'}" data-action="toggle-cat-construction-lines" aria-pressed="${catConstructionLayer.visible}" title="Show or hide future CAT construction lines">${catConstructionLayer.visible ? '◉' : '○'} CAT construction lines</button>
            <button class="button ${dimensionLayer.visible ? 'active-constraint' : 'ghost'}" data-action="toggle-dimensions" title="Show or hide the Dimensions layer">${dimensionLayer.visible ? '◉' : '○'} Dimensions</button>
            ${draft.length >= 3 ? '<button class="button primary" data-action="complete-draft">Close boundary</button>' : ''}
            ${mode === 'level-down' ? '<button class="button primary" data-action="cancel-level-down">Cancel Level Down</button>' : ''}
          </div>
          ${renderCatToolbar()}
          ${renderFramingToolbar()}
          <svg class="model-canvas ${mode === 'draw' || mode === 'level-down' || mode === 'cat' ? 'drawing' : ''} ${mode === 'cat' ? 'cat' : ''} ${boardingDirectionMode ? 'board-direction' : ''}" viewBox="${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}" aria-label="Deck boundary modeling workspace"></svg>
          <div class="cursor-hud" aria-live="polite"><div class="hud-row"><span>Length</span><strong data-hud-length>—</strong></div><div class="hud-row"><span>Angle</span><strong data-hud-angle>—</strong></div><div class="hud-row snap"><span data-hud-snap-dot></span><strong data-hud-snap>Grid</strong></div><div class="hud-input" data-hud-input>Type a length</div></div>
          <div class="stair-live-hud" aria-live="polite"><div class="stair-live-label">TOTAL RISE</div><strong data-stair-live-rise>0″</strong><div class="stair-live-grid"><span><b data-stair-live-risers>—</b> risers</span><span><b data-stair-live-treads>—</b> treads</span><span><b data-stair-live-riser>—</b> each rise</span><span><b data-stair-live-tread>—</b> each tread</span><span class="stair-live-run"><b data-stair-live-run>—</b> total run</span></div><small data-stair-live-status>Release to build · 5″–7.5″ risers · 10″–11″ treads</small></div>
          ${renderUtilityPopover()}
          <section class="print-title-block"><div><div class="eyebrow">CME Sketch Plan</div><h1>${escapeHtml(documentModel.name)}</h1></div><div class="print-metrics"><span><small>Decking</small><strong>${formatSquareFeet(projectSurface)}</strong></span><span><small>Railing</small><strong>${formatFeetInches(railingSummary.totalLength)}</strong></span><span><small>Stairs</small><strong>${stairCount}</strong></span></div></section>
          <div class="statusbar"><div class="status-pill">${escapeHtml(message)}</div><div class="status-pill"><strong>${gridSetting === 'auto' ? 'Adaptive' : `${gridSetting}″`} grid</strong> · Wheel zoom · Right-drag pan · Middle double-click fit</div></div>
        </section>
        <aside class="inspector open">${renderContextPanel(current)}${renderInspector(current, validation)}</aside>
      </section>
    </main>`;
  bindEvents();
  drawCanvas(app.querySelector('.model-canvas'), current, validation);
}

function renderProjectMenu() {
  if (!projectMenuOpen) return '';
  const projects = [...projectLibrary.projects].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const rows = projects.map((project) => {
    const active = project.id === documentModel.id;
    const confirming = pendingProjectDeleteId === project.id;
    const area = getProjectSurfaceArea(project);
    return `<article class="project-list-item ${active ? 'active' : ''}"><button class="project-open" data-action="open-project" data-project-id="${escapeHtml(project.id)}"><span><strong>${escapeHtml(project.name)}</strong><small>${formatSquareFeet(area)} · ${new Date(project.updatedAt).toLocaleDateString()}</small></span>${active ? '<b>OPEN</b>' : '<b>Open</b>'}</button>${confirming ? `<div class="project-delete-confirm"><span>Delete this local project?</span><button class="button danger" data-action="confirm-delete-project" data-project-id="${escapeHtml(project.id)}">Delete</button><button class="button ghost" data-action="cancel-delete-project">Cancel</button></div>` : `<button class="project-delete" data-action="request-delete-project" data-project-id="${escapeHtml(project.id)}" aria-label="Delete ${escapeHtml(project.name)}">×</button>`}</article>`;
  }).join('');
  return `<section class="project-menu" role="dialog" aria-label="Project options"><div class="project-menu-heading"><div><div class="eyebrow">Current project</div><strong>Project options</strong></div><button class="menu-close" data-action="close-project-menu" aria-label="Close project options">×</button></div><label class="project-name-editor"><span>Project name</span><div><input id="project-name-input" value="${escapeHtml(documentModel.name)}" maxlength="80"><button class="button" data-action="rename-project">Save</button></div></label><button class="button primary new-project-button" data-action="new-project">+ New project</button><div class="project-list-heading"><span>Projects on this device</span><small>${projects.length}</small></div><div class="project-list">${rows}</div><p class="project-storage-note">Projects autosave independently. Future SharePoint or OneDrive sync can replace this local library without changing the project format.</p></section>`;
}

function renderExportMenu() {
  if (!exportMenuOpen) return '';
  return `<section class="export-menu" role="menu"><button data-action="open-takeoff"><span><strong>Takeoff</strong><small>Editable materials, pricing, and supplier quote</small></span><b>NEW</b></button><button data-action="export-pdf"><span><strong>Export PDF</strong><small>Professional visual sketch and field quantities</small></span><b>PDF</b></button><button data-action="download-step-one-json"><span><strong>Download Step 1 JSON</strong><small>Portable fallback for DCR Sales Hub</small></span><b>JSON</b></button></section>`;
}

function takeoffContext() {
  const railingGeometries = getAllRailingGeometries();
  const railing = analyzeRailingGeometries(railingGeometries);
  return { railingGeometries, railingPostCount: railing.estimatedPostCount };
}

function renderTakeoffLine(line, editable = true) {
  /* A consolidated line is the SUM of several modeled lines, so its inputs are
     disabled rather than hidden: the estimator still reads the quantity and the
     price, but an edit here would have nowhere to write back to. */
  const ro = editable ? '' : ' disabled';
  const sourceLabel = line.origin === 'adjusted' ? 'ADJUSTED' : line.origin === 'manual' ? 'MANUAL' : 'AUTO';
  const price = line.unitPrice == null ? '' : line.unitPrice;
  const subtotal = line.unitPrice == null ? '—' : `$${(line.quantity * line.unitPrice).toFixed(2)}`;
  /* The tiers mean different things and the vision separates them on purpose:
     "preliminary" is a recipe that has not been through the shop, "review" is a
     line the tool KNOWS needs a human (a hand-priced Trex kit, an over-long
     bay). Collapsing both into REVIEW made the strong flag meaningless. */
  const confidenceFlag = line.confidence && line.confidence !== 'calculated'
    ? ` · ${line.confidence.toUpperCase()}` : '';
  const calculation = line.calculatedQuantity == null ? '' : `<small>Calculated ${line.calculatedQuantity}${line.requiredLinearFeet ? ` · ${line.requiredLinearFeet} LF net` : ''}${confidenceFlag}</small>`;
  const renamed = line.calculatedDescription && line.calculatedDescription !== line.description
    ? `<small>Named by the tool: ${escapeHtml(line.calculatedDescription)}</small>` : '';
  return `<div class="takeoff-line"><div class="takeoff-material"><span class="takeoff-origin ${line.origin}">${sourceLabel}</span><input class="takeoff-desc" value="${escapeHtml(line.description)}" data-takeoff-description="${escapeHtml(line.id)}" aria-label="Material description"${ro}><small>${escapeHtml(line.specification ?? '')}</small>${renamed}${calculation}</div><label><span>Qty</span><input type="number" min="0" step="1" value="${line.quantity}" data-takeoff-quantity="${escapeHtml(line.id)}"${ro}></label><label class="takeoff-price"><span>Unit price</span><input type="number" min="0" step="0.01" placeholder="—" value="${price}" data-takeoff-price="${escapeHtml(line.id)}"${ro}></label><div class="takeoff-subtotal"><span>Subtotal</span><strong>${subtotal}</strong></div>${!editable ? '' : `<button class="icon-button takeoff-note-btn${line.note ? ' has-note' : ''}" data-action="toggle-takeoff-note" data-line-id="${escapeHtml(line.id)}" aria-label="${line.note ? 'Edit the note on this material' : 'Add a note to this material'}" title="${line.note ? 'Note attached' : 'Add a note'}">${line.note ? '📝' : '🗒'}</button>`}<div class="takeoff-line-actions">${line.origin === 'manual' ? `<button class="icon-button danger" data-action="delete-takeoff-line" data-line-id="${escapeHtml(line.id)}" aria-label="Delete material">×</button>` : line.origin === 'adjusted' ? `<button class="button ghost" data-action="reset-takeoff-line" data-line-id="${escapeHtml(line.id)}">Reset</button>` : ''}</div>${takeoffNoteOpen === line.id ? renderTakeoffNote(line) : ''}</div>`;
}

/* Two notes, and they are never the same kind of thing.

   The calculation note is DERIVED on every read - change the stock length and
   it re-words itself - so it is shown plainly and cannot be edited. The
   estimator's note is authored: stored verbatim, keyed by the line id, and
   nothing regenerates it. Same bargain as the calculated quantity beside an
   adjusted one: the machine's version and the human's coexist. */
function renderTakeoffNote(line) {
  return `<div class="takeoff-note"><div class="takeoff-note-calc"><b>How this number was reached</b><span>${escapeHtml(line.calcNote ?? '')}</span></div>` +
    `<label class="takeoff-note-mine"><span>Your note${line.note ? '' : ' · optional'}</span>` +
    `<textarea rows="2" data-takeoff-note="${escapeHtml(line.id)}" placeholder="Cuts, who supplies it, what to confirm on site…">${escapeHtml(line.note ?? '')}</textarea></label>` +
    `<div class="takeoff-note-foot">Notes stay off the takeoff list. Tick <b>Include notes</b> when exporting to print them.</div></div>`;
}

let takeoffSettingsOpen = false;
let takeoffNoteOpen = null;
// what the standard commits to, in the words an estimator would use
const DCRCS_SUMMARY = 'posts every 6 ft under each beam, 16\u2033 footings, 3 bags a footing';
let takeoffExportNotes = false;
/* Two ways to read the same material. 'detailed' keeps the construction role -
   why and where each piece is used, and every quantity editable. 'consolidated'
   answers a different question: what do I order? Identical stock is summed
   across roles, which necessarily makes those lines read-only, because a sum
   has nowhere to write an edit back to. */
let takeoffViewMode = 'detailed';

/* The shop rules behind every AUTO line. One field per rule, saved with the
   project - a different contractor types their numbers once and every
   calculated quantity follows. */
const TAKEOFF_SETTING_FIELDS = [
  { key: 'wastePercent', label: 'Decking waste', hint: '% added to boards, fascia framing and rail stock', min: 0, max: 50, step: 1, unit: '%' },
  { key: 'fasciaWastePercent', label: 'Fascia waste', hint: '% added to fascia only - offcuts usually reusable', min: 0, max: 50, step: 1, unit: '%' },
  { key: 'fieldBoardWidthInches', label: 'Deck board width', hint: 'actual face width of the field board', min: 1, max: 12, step: 0.25, unit: 'in' },
  { key: 'fieldBoardGapInches', label: 'Board gap', hint: 'spacing between field boards', min: 0, max: 1, step: 0.0625, unit: 'in' },
  { key: 'fieldBoardStockFeet', label: 'Field stock length', hint: 'length the yard sells field boards in', min: 8, max: 24, step: 2, unit: 'ft' },
  { key: 'squareEdgeStockFeet', label: 'Square-edge stock', hint: 'stock length for square-edge / picture-frame boards', min: 8, max: 24, step: 2, unit: 'ft' },
  { key: 'fasciaStockFeet', label: 'Fascia stock length', hint: 'length the yard sells fascia in', min: 8, max: 24, step: 2, unit: 'ft' },
  { key: 'screwBoxCoverageSqFt', label: 'Screw box coverage', hint: 'square feet one 5lb box of deck screws covers', min: 25, max: 400, step: 25, unit: 'SF' },
  { key: 'stringersPerFlight', label: 'Stringers per flight', hint: 'stair stringers ordered per flight of stairs', min: 2, max: 6, step: 1, unit: 'ea' },
];

function renderTakeoffSettings() {
  const settings = getTakeoffState(documentModel).settings;
  const fields = TAKEOFF_SETTING_FIELDS.map((field) => `<label class="takeoff-setting"><span>${field.label} <small>· ${field.unit}</small></span><input type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${Number(settings[field.key])}" data-takeoff-setting="${field.key}"><small>${field.hint}</small></label>`).join('');
  return `<section class="takeoff-settings ${takeoffSettingsOpen ? 'expanded' : ''}"><button class="takeoff-category-heading" data-action="toggle-takeoff-settings" aria-expanded="${takeoffSettingsOpen}"><span><b>${takeoffSettingsOpen ? '−' : '+'}</b><strong>Calculation settings</strong></span><small>your shop's rules · saved with this project</small></button>${takeoffSettingsOpen ? `<div class="takeoff-settings-body">${fields}</div><p class="takeoff-settings-note">Changing a rule recalculates every AUTO quantity. Quantities you adjusted by hand stay exactly as you set them.</p>` : ''}</section>`;
}

function renderTakeoffWorkspace() {
  if (!takeoffOpen) return '';
  const detailedLines = getEffectiveTakeoffLines(documentModel, takeoffContext());
  const lines = takeoffViewMode === 'consolidated' ? consolidateTakeoffLines(detailedLines) : detailedLines;
  const editableTakeoff = takeoffViewMode === 'detailed';
  const knownTotal = lines.reduce((sum, line) => sum + (line.unitPrice == null ? 0 : line.quantity * line.unitPrice), 0);
  const unpriced = lines.filter((line) => line.unitPrice == null).length;
  const categories = TAKEOFF_CATEGORIES.map((category) => {
    const categoryLines = lines.filter((line) => line.category === category.id);
    const expanded = takeoffExpanded.has(category.id);
    const adding = takeoffAddCategory === category.id;
    return `<section class="takeoff-category ${expanded ? 'expanded' : ''}"><button class="takeoff-category-heading" data-action="toggle-takeoff-category" data-category="${category.id}" aria-expanded="${expanded}"><span><b>${expanded ? '−' : '+'}</b><strong>${category.label}</strong></span><small>${categoryLines.length} material${categoryLines.length === 1 ? '' : 's'}</small></button>${expanded ? `<div class="takeoff-category-body">${categoryLines.length ? categoryLines.map((line) => renderTakeoffLine(line, editableTakeoff)).join('') : '<div class="takeoff-empty">No calculated materials yet. Add a project material or keep modeling.</div>'}${adding ? `<div class="takeoff-add-form"><label><span>Material</span><input id="takeoff-new-description" placeholder="Example: Pressure treated joist"></label><label><span>Specification</span><input id="takeoff-new-specification" placeholder="Example: 2×8×16"></label><label><span>Quantity</span><input id="takeoff-new-quantity" type="number" min=".01" step="1" value="1"></label><label><span>Unit</span><select id="takeoff-new-unit"><option value="ea">pieces</option><option value="lf">LF</option><option value="sf">SF</option><option value="box">boxes</option><option value="bag">bags</option><option value="gal">gallons</option></select></label><label><span>Unit price · optional</span><input id="takeoff-new-price" type="number" min="0" step=".01" placeholder="—"></label><div class="takeoff-add-actions"><button class="button primary" data-action="save-takeoff-line" data-category="${category.id}">Add material</button><button class="button ghost" data-action="cancel-takeoff-line">Cancel</button></div></div>` : `<button class="button ghost takeoff-add" data-action="add-takeoff-line" data-category="${category.id}">+ Add material</button>`}</div>` : ''}</section>`;
  }).join('');
  return `<section class="takeoff-overlay" role="dialog" aria-modal="true" aria-label="Project material takeoff"><header class="takeoff-header"><div><div class="eyebrow">CME material intelligence</div><h1>Project Takeoff</h1><p>${escapeHtml(documentModel.name)} · calculated from the current construction model</p></div><button class="takeoff-close" data-action="close-takeoff" aria-label="Close takeoff">×</button></header><div class="takeoff-view-mode"><div><strong>List format</strong><small>${takeoffViewMode === 'consolidated'
        ? 'Groups identical material and stock length across construction roles \u2014 what to order.'
        : 'Keeps why and where every piece is used, and every quantity editable.'}</small></div>` +
      `<div class="segmented-control"><button class="button ${takeoffViewMode === 'detailed' ? 'active-constraint' : ''}" data-action="set-takeoff-view" data-view="detailed">Detailed by use</button>` +
      `<button class="button ${takeoffViewMode === 'consolidated' ? 'active-constraint' : ''}" data-action="set-takeoff-view" data-view="consolidated">Consolidated for purchase</button></div></div>` +
      `<div class="takeoff-summary"><span><small>Material lines</small><strong>${lines.length}</strong></span><span><small>Unpriced</small><strong>${unpriced}</strong></span><span class="takeoff-price"><small>Known material total</small><strong>$${knownTotal.toFixed(2)}</strong></span></div><div class="takeoff-actions"><button class="button primary" data-action="print-takeoff-quote">Export quote · no prices</button><button class="button" data-action="print-takeoff-priced">Export with prices</button><button class="button ghost" data-action="download-takeoff-json">Takeoff JSON</button><label class="takeoff-notes-toggle"><input type="checkbox" id="takeoff-export-notes"${takeoffExportNotes ? ' checked' : ''}> Include notes</label></div>${renderTakeoffSettings()}<div class="takeoff-list">${categories}</div><footer class="takeoff-footer">${takeoffViewMode === 'consolidated'
        ? `<span>Read-only purchase list \u2014 return to Detailed by use to adjust a modeled quantity.</span><strong>${detailedLines.length} detailed \u2192 ${lines.length} purchase lines</strong>`
        : `<span>PRELIMINARY = a shop recipe not yet confirmed · REVIEW = needs a human decision. Every quantity stays editable, and an edit keeps the calculated figure beside it.</span><strong>${lines.filter((line) => line.origin === 'adjusted').length} adjusted \u00b7 ${lines.filter((line) => line.origin === 'manual').length} manual</strong>`}</footer></section>`;
}

function renderContextPanel(current) {
  if (!selected.kind) return '';
  if (selected.kind === 'cat') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id && [CAT_LINE_TYPE, CAT_MEASUREMENT_TYPE, CAT_NOTE_TYPE].includes(entry.type));
    if (!object) return '';
    const measurement = object.type === CAT_MEASUREMENT_TYPE ? deriveCatMeasurement(object) : null;
    const note = object.type === CAT_NOTE_TYPE ? object : null;
    const title = note ? catNoteLabel(note) : measurement ? formatFeetInches(measurement.pointToPointDistance) : formatFeetInches(Math.hypot(object.vertices[1].x - object.vertices[0].x, object.vertices[1].y - object.vertices[0].y));
    const annotation = Boolean(note || measurement);
    return `<section class="context-object-panel cat-context"><div class="context-heading"><div><div class="eyebrow">${note ? 'CAT construction note' : measurement ? 'CAT measuring tape' : 'CAT construction line'}</div><h2>${title}</h2></div><button class="context-close" data-action="clear-selection" aria-label="Close object options">×</button></div>${note ? `<label class="context-select"><span>Estimator note</span><textarea id="cat-note-text" rows="4" maxlength="1000">${escapeHtml(note.text)}</textarea></label><button class="button primary context-full" data-action="apply-cat-note">Save note</button><div class="context-actions"><button class="button ${catAudioRecorder ? 'active-constraint' : ''}" data-action="${catAudioRecorder ? 'stop-cat-note-audio' : 'record-cat-note-audio'}">${catAudioRecorder ? '■ Stop recording' : '● Record voice'}</button><button class="button" data-action="remove-cat-note-audio" ${note.audioDataUrl ? '' : 'disabled'}>Delete audio</button></div>${note.audioDataUrl ? `<audio class="cat-note-audio" controls src="${note.audioDataUrl}"></audio>` : '<div class="context-note">Optional voice note · recording stops automatically after 30 seconds.</div>'}` : measurement ? `<div class="cat-measure-summary"><span><small>Horizontal</small><strong>${formatFeetInches(measurement.horizontalDistance)}</strong></span><span><small>Vertical</small><strong>${formatFeetInches(measurement.verticalDistance)}</strong></span><span><small>Point to point</small><strong>${formatFeetInches(measurement.pointToPointDistance)}</strong></span></div>` : '<div class="context-note">CAT reference geometry remains separate from authoritative construction objects and is available to Boundary snap.</div>'}<div class="context-actions"><button class="button" data-action="${annotation ? 'toggle-cat-dimensions' : 'toggle-cat-construction-lines'}">${annotation ? getCatDimensionLayer(documentModel).visible ? 'Hide CAT annotations' : 'Show CAT annotations' : getCatConstructionLayer(documentModel).visible ? 'Hide CAT CL' : 'Show CAT CL'}</button><button class="button danger" data-action="delete-cat-object">Delete</button></div></section>`;
  }
  if (!current) return '';
  const deckingVisible = getDeckingLayer(documentModel).visible;
  const close = '<button class="context-close" data-action="clear-selection" aria-label="Close object options">×</button>';
  if (selected.kind === 'railing') {
    const geometry = findRailingGeometry(selected.id);
    if (!geometry) return '';
    const system = geometry.railing.settings?.system ?? 'wild-hog';
    const canRemovePanel = geometry.sectionCount > geometry.minimumSectionCount;
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected railing</div><h2>${formatFeetInches(geometry.length)}</h2></div>${close}</div><div class="context-stat"><span>Panels</span><strong>${geometry.sectionCount}</strong><small>${geometry.postCount} posts</small></div><div class="context-stepper"><button class="button" data-action="remove-railing-panel" ${canRemovePanel ? '' : 'disabled'}>− Panel</button><button class="button" data-action="add-railing-panel">+ Panel</button></div><label class="context-select"><span>Railing type</span><select id="quick-railing-system"><option value="wild-hog" ${system === 'wild-hog' ? 'selected' : ''}>Wild Hog panel</option><option value="stick-built" ${system === 'stick-built' ? 'selected' : ''}>Stick-built (wood balusters)</option><option value="trex" ${system === 'trex' ? 'selected' : ''}>Trex railing</option></select></label><div class="context-actions"><button class="button" data-action="add-gate-on-railing">Add gate · 36″</button><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide all decking' : 'Show all decking'}</button></div><div class="context-actions"><button class="button danger" data-action="remove-railing">Delete railing</button></div><div class="context-note">A gate is an opening: its width comes OUT of this run's railing material. Panel changes preserve both endpoints and the 6 ft maximum clear span.</div></section>`;
  }
  if (selected.kind === 'edge') {
    const edge = current.edges.find((entry) => entry.id === selected.id);
    if (!edge) return '';
    const index = current.edges.findIndex((entry) => entry.id === edge.id);
    const length = Math.hypot(current.vertices[(index + 1) % current.vertices.length].x - current.vertices[index].x, current.vertices[(index + 1) % current.vertices.length].y - current.vertices[index].y);
    const properties = normalizeBoundaryEdge(edge).properties;
    const dimensionVisible = getDimensionLayer(documentModel).visible && isDimensionReferenceVisible(documentModel, edge.id);
    const breakDisabled = edgeHasRailingDependency(edge.id);
    const locked = isEdgeLocked(current, edge.id);
    const orientation = getEdgeOrientationConstraint(current, edge.id);
    const orientationStatus = describeOrientationConstraint(orientation);
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected construction edge</div><h2>${locked ? '⚓ ' : orientation?.type === 'fixed-angle' ? '⚓∠ ' : orientation?.type === 'horizontal' ? 'H · ' : orientation?.type === 'vertical' ? 'V · ' : ''}${formatFeetInches(length)}</h2></div>${close}</div><div class="context-actions"><button class="button ${locked ? 'active-constraint' : ''}" data-action="${locked ? 'unlock-edge' : 'lock-edge'}">${locked ? '✓ Edge locked' : 'Lock edge'}</button><button class="button ${dimensionLeaderMode?.referenceId === edge.id ? 'active-constraint' : ''}" data-action="reposition-dimension-arrow">Reposition arrow</button></div><div class="context-actions context-actions-3 orientation-toggle" role="group" aria-label="Edge orientation"><button class="button ${orientation?.type === 'vertical' ? 'active-constraint' : ''}" data-action="constraint-vertical" aria-pressed="${orientation?.type === 'vertical'}" ${locked ? 'disabled' : ''}>${orientation?.type === 'vertical' ? '✓ ' : ''}Vertical</button><button class="button ${orientation?.type === 'horizontal' ? 'active-constraint' : ''}" data-action="constraint-horizontal" aria-pressed="${orientation?.type === 'horizontal'}" ${locked ? 'disabled' : ''}>${orientation?.type === 'horizontal' ? '✓ ' : ''}Horizontal</button><button class="button ${orientation?.type === 'fixed-angle' ? 'active-constraint' : ''}" data-action="constraint-lock-angle" aria-pressed="${orientation?.type === 'fixed-angle'}" ${locked ? 'disabled' : ''}>${orientation?.type === 'fixed-angle' ? '✓ ' : ''}Lock angle</button></div><div class="constraint-status ${orientation ? 'active' : ''}"><span>${orientation ? '●' : '○'}</span>${locked ? 'Full edge lock active' : orientationStatus}</div><div class="context-actions context-actions-3"><button class="button ${dimensionVisible ? '' : 'primary'}" data-action="toggle-selected-dimension">${dimensionVisible ? 'Delete dimension' : 'Add dimension'}</button><button class="button" data-action="break-edge-2" ${breakDisabled || locked ? 'disabled' : ''}>Break ×2</button><button class="button" data-action="break-edge-3" ${breakDisabled || locked ? 'disabled' : ''}>Break ×3</button></div><div class="context-actions context-actions-3"><button class="button ${edge.role === 'house' ? 'house-relationship-active' : ''}" data-action="quick-house-attachment" aria-pressed="${edge.role === 'house'}">${edge.role === 'house' ? '✓ ' : ''}House attachment</button><button class="button ${properties.finishes.fascia ? 'active-constraint' : ''}" data-action="quick-fascia">Fascia</button><button class="button ${properties.finishes.pictureFrame ? 'active-constraint' : ''}" data-action="quick-picture-frame">Picture frame</button></div><button class="button context-full" data-action="toggle-decking">${deckingVisible ? 'Hide all decking' : 'Show all decking'}</button>${locked ? '<div class="context-note">This edge cannot move, change length, split, or accept geometry constraints until unlocked.</div>' : breakDisabled ? '<div class="context-note">Remove connected railing before dividing this edge.</div>' : ''}</section>`;
  }
  if (selected.kind === 'stair-edge') {
    const reference = findStairInterfaceByEdgeId(selected.id);
    if (!reference) return '';
    const properties = normalizeBoundaryEdge(reference.edge).properties;
    const dimensionVisible = getDimensionLayer(documentModel).visible && isDimensionReferenceVisible(documentModel, reference.edge.id);
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected stair interface</div><h2>Deck–Stair line</h2></div>${close}</div><div class="context-actions"><button class="button ${dimensionVisible ? '' : 'primary'}" data-action="toggle-selected-dimension">${dimensionVisible ? 'Delete dimension' : 'Add dimension'}</button><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide decking' : 'Show decking'}</button></div><div class="context-actions"><button class="button ${properties.finishes.fascia ? 'active-constraint' : ''}" data-action="quick-fascia">Fascia</button><button class="button ${properties.finishes.pictureFrame ? 'active-constraint' : ''}" data-action="quick-picture-frame">Picture frame</button></div></section>`;
  }
  if (selected.kind === 'stair-side') {
    const reference = findStairSide(selected.id);
    if (!reference) return '';
    const snapped = reference.side === 'start' ? reference.stair.dimensions.snappedStart : reference.stair.dimensions.snappedEnd;
    const boundaryAttached = Boolean(reference.stair.sideAttachments?.[reference.side]);
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected stair side</div><h2>${reference.side === 'start' ? 'Left' : 'Right'} side · ${formatFeetInches(reference.stair.dimensions.totalRun)}</h2></div>${close}</div><div class="constraint-status active"><span>●</span>${snapped ? 'Snapped to base node · drag away to detach' : boundaryAttached ? 'Shared boundary connection · drag away to detach' : 'Drag sideways to change stair width'}</div><div class="context-actions"><button class="button" data-action="select-stair-object">Stair properties</button><button class="button danger" data-action="delete-stair">Delete stairs</button></div></section>`;
  }
  if (selected.kind === 'vertex') {
    const locked = isVertexLocked(current, selected.id);
    const index = current.vertices.findIndex((vertex) => vertex.id === selected.id);
    const adjacentLocked = [current.edges[index], current.edges[(index - 1 + current.edges.length) % current.edges.length]].some((edge) => isEdgeLocked(current, edge.id));
    const referenced = isVertexReferencedByAttachment(selected.id);
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected corner</div><h2>${locked ? '⚓ Locked node' : 'Boundary node'}</h2></div>${close}</div><div class="context-actions"><button class="button primary" data-action="start-45-chamfer" ${locked || adjacentLocked || referenced ? 'disabled' : ''}>45° Chamfer</button><button class="button ${locked ? 'active-constraint' : ''}" data-action="${locked ? 'unlock-vertex' : 'lock-vertex'}">${locked ? 'Unlock' : 'Lock in place'}</button></div><div class="context-actions"><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide decking' : 'Show decking'}</button><button class="button danger" data-action="delete-vertex" ${current.vertices.length <= 3 || locked || adjacentLocked || referenced ? 'disabled' : ''}>Delete node</button></div><div class="context-note">${referenced ? 'This node anchors another construction object and cannot be replaced.' : '45° Chamfer: drag anywhere to set an equal setback on both connected edges with live dimensions.'}</div></section>`;
  }
  if (selected.kind === 'framing') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    if (object) {
      if (object.type === 'count-marker') {
        const tally = getCountMarkers(documentModel).filter((marker) => marker.label === object.label).length;
        return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Count pin</div><h2>${escapeHtml(object.label)} · ${object.seq}</h2></div>${close}</div><div class="context-stat"><span>Total for this label</span><strong>${tally}</strong><small>each label is its own takeoff line</small></div><label class="context-select"><span>What is being counted</span><div class="compound-field"><input id="count-label" value="${escapeHtml(object.label)}"><button class="button" data-action="apply-count-label">Apply</button></div></label><div class="context-actions"><button class="button danger" data-action="delete-framing">Delete pin</button></div><div class="context-note">The label reaches the estimate exactly as written. Change it before dropping the next pin to start a new tally.</div></section>`;
      }
      if (object.type === 'gate') {
        return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Gate</div><h2>${formatFeetInches(Number(object.dimensions?.widthInches) || 36)}</h2></div>${close}</div><label class="context-select"><span>Opening width</span><div class="compound-field"><input id="gate-width" value="${formatFeetInches(Number(object.dimensions?.widthInches) || 36)}"><button class="button" data-action="apply-gate-width">Apply</button></div></label><div class="context-actions"><button class="button danger" data-action="delete-framing">Delete gate</button></div><div class="context-note">This width comes OUT of the railing run it sits on — the balusters and rail are not billed across the opening.</div></section>`;
      }
      const lengthInches = Number(object.computed?.lengthInches) || 0;
      const kindLabel = object.type === 'joist' ? 'Joist' : object.type === 'beam' ? 'Beam' : object.type === 'pillar' ? 'Pillar' : 'Post';
      /* A beam carries the one decision that changes what happens wherever a
         joist crosses it. It lives per beam, not per deck, because a real deck
         often runs one flush beam (headroom, a door threshold) among bottom
         ones - the same shape railingSystem() already uses per run. */
      const beamExtras = object.type === 'beam' ? (() => {
        const system = framingSystem(object, getTakeoffState(documentModel).settings.framingSystem);
        const geometry = standardApplies(documentModel)
          ? deriveBeamGeometry(object, getTakeoffState(documentModel).settings) : null;
        const toggle = `<label class="context-select"><span>Framing system</span><div class="ed-toggle">` +
          ['bottom', 'flush'].map((option) => `<button class="framing-system-option${system === option ? ' on' : ''}" data-action="set-framing-system" data-system="${option}">` +
            (option === 'bottom' ? 'Bottom beam' : 'Flush beam') + '</button>').join('') +
          `</div><small>${system === 'flush'
            ? 'Joists stop at the beam face and hang off it.'
            : 'Joists bear on top of the beam and run over it.'}</small></label>`;
        const derived = geometry
          ? `<div class="context-stat"><span>Posts under this beam</span><strong>${geometry.postCount}</strong>` +
            `<small>every ${formatFeetInches(geometry.spacingInches)} \u00b7 ${geometry.footingSizeInches}\u2033 footings` +
            `${geometry.postCountAdjusted ? ' \u00b7 you added posts' : ''}</small></div>` +
            `<label class="context-select"><span>Posts \u00b7 the standard sets the minimum</span><div class="compound-field">` +
            `<input id="beam-post-count" type="number" min="${geometry.minimumPostCount}" value="${geometry.postCount}">` +
            `<button class="button" data-action="apply-beam-posts">Apply</button></div>` +
            `<small>You can add posts. Asking for fewer than ${geometry.minimumPostCount} is refused \u2014 that is the ${formatFeetInches((getTakeoffState(documentModel).settings.beamMaxPostSpacingFeet || 6) * 12)} limit.</small></label>`
          : '<div class="context-note">Set a primary deck level to lay out posts and footings under this beam.</div>';
        return toggle + derived;
      })() : '';
      return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">${kindLabel}</div><h2>${lengthInches > 0 ? formatFeetInches(lengthInches) : escapeHtml(object.name ?? kindLabel)}</h2></div>${close}</div>${beamExtras}<label class="context-select"><span>Size label \u00b7 picked, never derived</span><div class="compound-field"><input id="framing-size" value="${escapeHtml(object.size ?? '')}" placeholder="2x10, 4x4, 6x6\u2026"><button class="button" data-action="apply-framing-size">Apply</button></div></label><div class="context-actions"><button class="button danger" data-action="delete-framing">Delete ${kindLabel.toLowerCase()}</button></div><div class="context-note">The size goes on the material line so the estimator knows which board to pull. Nothing sizes itself from the span.</div></section>`;
    }
  }
  if (selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind === 'stair') return renderStairContextPanel(reference.stair, deckingVisible, close);
    if (reference?.kind === 'area') {
      const localBoundary = reference.boundary;
      const levelDown = getBoundaryLevelDown(localBoundary);
      const boarding = getDeckBoarding(localBoundary);
      const assemblyLocked = localBoundary.vertices.some((vertex) => vertex.locked) || localBoundary.edges.some((edge) => edge.properties?.custom?.locked);
      const deleting = pendingDeckDeleteId === localBoundary.id;
      const boardingActive = boardingDirectionMode?.boundaryId === localBoundary.id;
      /* The datum. It belongs to the PROJECT, not to this shape - a deck's
         height above grade is one fact, and every Down Level measures back
         from it - but it is edited here, on the first deck area, because that
         is the thing a user points at when they mean "the deck".
         Only the first area offers it; the rest get their height from Down
         Level, and the panel says so rather than showing a control that would
         quietly fight the first one. */
      const primaryBoundary = documentModel.objects.find((entry) => entry.type === 'deck-boundary');
      const isPrimary = primaryBoundary?.id === localBoundary.id;
      const deckLevel = getDeckLevelInches(documentModel);
      const secondFloor = isSecondFloor(deckLevel);
      const levelControl = isPrimary
        ? `<label class="context-select"><span>Primary deck level \u00b7 height above grade</span><div class="compound-field"><input id="primary-deck-level" value="${deckLevel === null ? '' : formatFeetInches(deckLevel)}" placeholder="not set"><button class="button" data-action="apply-deck-level">Apply</button></div></label>` +
          `<div class="context-actions context-actions-3"><button class="button ${deckLevel !== null && !secondFloor ? 'active-constraint' : ''}" data-action="deck-level-standard">4 ft standard</button>` +
          `<button class="button ${secondFloor ? 'active-constraint' : ''}" data-action="deck-level-second-floor">Second floor</button>` +
          `<button class="button" data-action="deck-level-clear" ${deckLevel === null ? 'disabled' : ''}>Clear</button></div>` +
          `<div class="context-note">${deckLevel === null
            ? 'No level set, so no framing is laid out. Set one and beams get their posts, footings and material automatically.'
            : secondFloor
              ? 'At second-floor height the DCR standard stands down: you choose the beam spacing and the sizes yourself.'
              : `DCR standard framing is in force: ${DCRCS_SUMMARY}.`}</div>`
        : `<div class="context-note">This area takes its height from the Down Level below, measured from the primary deck level${deckLevel === null ? '' : ` of ${formatFeetInches(deckLevel)}`}.</div>`;
      return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected deck area</div><h2>${formatSquareFeet(localBoundary.computed.areaSquareInches)}${levelDown > 0 ? ` \u00b7 \u2193 ${formatInches(levelDown)}` : ''}</h2></div>${close}</div>${levelControl}<label class="context-select"><span>Down level \u00b7 local deck</span><div class="compound-field"><input id="boundary-level-down" value="${formatInches(levelDown)}"><button class="button" data-action="apply-boundary-level">Apply</button></div></label><div class="context-actions"><button class="button primary ${moveBoundaryMode?.boundaryId === localBoundary.id ? 'active-constraint' : ''}" data-action="move-deck-area" ${assemblyLocked ? 'disabled' : ''}>Move deck area</button><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide all decking' : 'Show all decking'}</button></div><div class="context-actions"><button class="button" data-action="make-boundary-90">Make 90° corners</button><button class="button" data-action="start-level-down">Add level down</button></div><div class="context-actions"><button class="button ${localBoundary.metadata?.excludeFromDeckArea ? 'active-constraint' : ''}" data-action="toggle-bill-area" aria-pressed="${Boolean(localBoundary.metadata?.excludeFromDeckArea)}">${localBoundary.metadata?.excludeFromDeckArea ? '✗ Not billed' : '✓ Billed'}</button></div><div class="context-note">${localBoundary.metadata?.excludeFromDeckArea ? 'This area is drawn but kept OUT of the square footage the estimate prices. Use it for a shed pad, a roof outline, or anything you are not charging for.' : 'This area counts toward the square footage the estimate prices.'}</div><div class="context-actions context-actions-3"><button class="button ${boardingActive ? 'active-constraint' : ''}" data-action="set-board-direction">${boardingActive ? '✓ Select line' : boarding ? 'Change direction' : 'Board direction'}</button><button class="button" data-action="rotate-board-direction" ${boarding ? '' : 'disabled'}>Rotate 90°</button><button class="button" data-action="clear-board-direction" ${boarding ? '' : 'disabled'}>Clear boards</button></div><div class="context-actions"><button class="button ${dimensionLeaderMode?.referenceId === selected.id ? 'active-constraint' : ''}" data-action="reposition-dimension-arrow">Reposition arrow</button><button class="button" data-action="reset-dimension-arrow">Reset arrow</button></div><div class="context-actions"><button class="button danger" data-action="toggle-selected-dimension">Delete dimension</button><button class="button" data-action="reset-dimension-position">Reset area position</button></div>${deleting ? '<div class="delete-confirmation"><strong>Delete this complete deck area?</strong><span>Attached stairs, railings, Level Down objects, and local dimensions will also be removed.</span><div class="context-actions"><button class="button danger" data-action="confirm-delete-deck">Confirm delete</button><button class="button" data-action="cancel-delete-deck">Cancel</button></div></div>' : '<button class="button danger context-full" data-action="request-delete-deck">Delete deck area</button>'}<div class="context-note">${assemblyLocked ? 'Unlock local nodes and edges before moving this deck.' : boarding ? `Boarding follows a ${formatInches(boarding.boardWidth)} board with a ${formatInches(boarding.gap)} gap.` : 'Select Board direction, then touch any construction line. Deck objects remain above the subtle board pattern.'}</div></section>`;
    }
    if (reference?.kind === 'level-down-area') return renderLevelDownContext(reference.levelDown, reference.region, deckingVisible, close, true);
    return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected annotation</div><h2>Dimension</h2></div>${close}</div><div class="context-actions"><button class="button primary" data-action="edit-dimension">Edit object</button><button class="button" data-action="reset-dimension-position">Reset position</button></div><div class="context-actions"><button class="button ${dimensionLeaderMode?.referenceId === selected.id ? 'active-constraint' : ''}" data-action="reposition-dimension-arrow">Reposition arrow</button><button class="button" data-action="reset-dimension-arrow">Reset arrow</button></div><button class="button danger context-full" data-action="toggle-selected-dimension">Delete dimension</button></section>`;
  }
  if (selected.kind === 'level-down') {
    const reference = findLevelDownSegment(selected.id);
    if (!reference) return '';
    return renderLevelDownContext(reference.levelDown, deriveLevelDownRegion(reference.levelDown, current), deckingVisible, close, false, reference.length);
  }
  if (selected.kind === 'stair') {
    const stair = documentModel.objects.find((object) => object.type === 'stair' && object.id === selected.id);
    return stair ? renderStairContextPanel(stair, deckingVisible, close) : '';
  }
  return '';
}

function renderStairContextPanel(stair, deckingVisible, close) {
  const invalid = stair.lifecycle?.needsReview;
  const riserCount = stair.dimensions.riserCount ?? stair.dimensions.stepCount;
  const treadCount = stair.dimensions.treadCount ?? riserCount - 1;
  return `<section class="context-object-panel stair-context ${invalid ? 'invalid-stair' : ''}"><div class="context-heading"><div><div class="eyebrow">${invalid ? 'Stair needs review' : 'Selected staircase'}</div><h2>${escapeHtml(stair.name)}</h2></div>${close}</div>${invalid ? `<div class="validation error"><span class="validation-dot"></span><span>${escapeHtml(stair.lifecycle.reviewReason ?? 'No valid stair layout remains.')}</span></div>` : ''}<div class="context-stat"><span>Total run</span><strong>${formatFeetInches(stair.dimensions.totalRun, .25)}</strong><small>${riserCount}R · ${treadCount}T</small></div><div class="field-grid stair-edit-grid"><div class="field"><label for="stair-total-rise">Total rise</label><input id="stair-total-rise" value="${formatInches(stair.dimensions.totalRise)}" ${stair.destination ? 'disabled' : ''}></div><div class="field"><label for="stair-riser-height">Riser</label><input id="stair-riser-height" value="${formatInches(stair.dimensions.riserHeight)}"></div><div class="field full"><label for="stair-tread-depth">Tread</label><div class="compound-field"><input id="stair-tread-depth" value="${formatInches(stair.dimensions.treadDepth)}"><button class="button" data-action="apply-stair-dimensions">Apply</button></div></div></div><div class="context-actions"><button class="button" data-action="select-stair-interface">Select deck interface</button><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide decking' : 'Show decking'}</button></div><button class="button danger context-full" data-action="delete-stair">Delete stairs</button><div class="context-note">${stair.destination ? 'Total rise follows the connected deck levels. CME recalculates first and marks the stair red only when no valid landing remains.' : 'Risers stay between 5″ and 7.5″; treads stay between 10″ and 11″.'}</div></section>`;
}

function refreshContextPanel() {
  const inspector = app.querySelector('.inspector');
  if (!inspector) return;
  inspector.querySelector(':scope > .context-object-panel')?.remove();
  const markup = renderContextPanel(boundary());
  if (!markup) return;
  inspector.insertAdjacentHTML('afterbegin', markup);
  const panel = inspector.querySelector(':scope > .context-object-panel');
  panel?.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
}

function renderLevelDownContext(levelDown, region, deckingVisible, close, selectedByDimension, segmentLength = null) {
  const finishes = levelDown.properties?.finishes ?? {};
  const totalDepth = getLevelDownDepth(levelDown);
  return `<section class="context-object-panel"><div class="context-heading"><div><div class="eyebrow">Selected lowered area</div><h2>${region ? formatSquareFeet(region.areaSquareInches) : formatFeetInches(segmentLength ?? 0)}</h2></div>${close}</div><div class="context-stat"><span>Below main deck</span><strong>${formatInches(totalDepth)}</strong><small>Includes overlapping level changes</small></div><label class="context-select"><span>This step drop · entire polyline</span><div class="compound-field"><input id="quick-level-down-riser" value="${formatInches(levelDown.dimensions.riserHeight)}"><button class="button" data-action="apply-level-down-riser">Apply</button></div></label><div class="context-actions context-actions-3"><button class="button" data-action="make-level-down-90">Make 90°</button><button class="button ${finishes.pictureFrame ? 'active-constraint' : ''}" data-action="quick-level-picture-frame">Picture frame</button><button class="button ${finishes.fascia ? 'active-constraint' : ''}" data-action="quick-level-fascia">Fascia</button></div><div class="context-actions"><button class="button" data-action="flip-level-down-side">Flip lowered side</button><button class="button" data-action="toggle-decking">${deckingVisible ? 'Hide all decking' : 'Show all decking'}</button></div>${selectedByDimension ? `<div class="context-actions"><button class="button danger" data-action="toggle-selected-dimension">Delete dimension</button><button class="button" data-action="reset-dimension-position">Reset position</button></div><div class="context-actions"><button class="button ${dimensionLeaderMode?.referenceId === selected.id ? 'active-constraint' : ''}" data-action="reposition-dimension-arrow">Reposition arrow</button><button class="button" data-action="reset-dimension-arrow">Reset arrow</button></div>` : '<div class="context-actions"><button class="button" data-action="break-level-down-2">Break ×2</button><button class="button" data-action="break-level-down-3">Break ×3</button></div>'}<button class="button danger context-full" data-action="delete-level-down">Delete lowered area</button><div class="context-note">The arrow dimension owns this lowered area. Moving it draws a live leader back to the region.</div></section>`;
}

function renderUtilityPopover() {
  if (!utilityPanel) return '';
  const content = utilityPanel === 'visibility' ? renderVisibilityControls() : renderSnapControls();
  return `<div class="utility-popover ${utilityPanel}" role="dialog" aria-label="${utilityPanel === 'visibility' ? 'Drawing layer visibility' : 'Snap controls'}"><button class="utility-close" data-action="close-utility-panel" aria-label="Close panel">×</button><div class="utility-popover-body">${content}</div></div>`;
}

function renderFramingToolbar() {
  if (mode !== 'framing') return '';
  const hint = framingDraft
    ? 'Choose the far end'
    : framingTool === 'post' || framingTool === 'pillar'
      ? 'Tap to place'
      : 'Tap each end of the run';
  const chips = ON_CENTRE_SPACINGS.map((value) => `<button class="button ${framingSpacing === value ? 'primary' : 'ghost'}" data-action="framing-spacing-${value}" aria-pressed="${framingSpacing === value}">${value}″</button>`).join('');
  const selectedFraming = selected.kind === 'framing' ? selected.id : null;
  return `<div class="cat-toolbar" role="toolbar" aria-label="Framing tools"><div class="cat-toolbar-title"><strong>Framing</strong><small>${hint}</small></div>`
    + `<button class="button ${framingTool === 'joist' ? 'primary' : 'ghost'}" data-action="framing-tool-joist" aria-pressed="${framingTool === 'joist'}">Joist</button>`
    + `<button class="button ${framingTool === 'beam' ? 'primary' : 'ghost'}" data-action="framing-tool-beam" aria-pressed="${framingTool === 'beam'}">Beam</button>`
    + `<button class="button ${framingTool === 'post' ? 'primary' : 'ghost'}" data-action="framing-tool-post" aria-pressed="${framingTool === 'post'}">Post</button>`
    + `<button class="button ${framingTool === 'pillar' ? 'primary' : 'ghost'}" data-action="framing-tool-pillar" aria-pressed="${framingTool === 'pillar'}">Pillar</button>`
    + `<span class="cat-toolbar-title"><small>On centre</small></span>${chips}`
    + `<button class="button ghost" data-action="framing-copies-less" title="Fewer copies">−</button>`
    + `<button class="button ${selectedFraming ? '' : 'ghost'}" data-action="framing-array" ${selectedFraming ? '' : 'disabled'} title="Repeat the selected member on centre">⧉ Repeat ×${framingCopies}</button>`
    + `<button class="button ghost" data-action="framing-copies-more" title="More copies">+</button>`
    + `<button class="button ghost" data-action="close-framing-tool">Done</button></div>`;
}

function renderCatToolbar() {
  if (mode !== 'cat') return '';
  const dimensionsVisible = getCatDimensionLayer(documentModel).visible;
  return `<div class="cat-toolbar" role="toolbar" aria-label="CAT construction tools"><div class="cat-toolbar-title"><strong>CAT CL</strong><small>${catDraft ? 'Choose the second point' : catTool === 'trim' || catTool === 'extend' ? 'Choose a CAT line' : catTool === 'note' ? 'Choose arrow point' : catTool === 'count' ? 'Tap to drop a numbered pin' : 'Reference geometry'}</small></div><button class="button ${catTool === 'line' ? 'primary' : 'ghost'}" data-action="cat-tool-line" aria-pressed="${catTool === 'line'}"><span>╱</span> Line</button><button class="button ${catTool === 'measure' ? 'primary' : 'ghost'}" data-action="cat-tool-measure" aria-pressed="${catTool === 'measure'}"><span>↔</span> Tape</button><button class="button ${catTool === 'trim' ? 'primary' : 'ghost'}" data-action="cat-tool-trim" aria-pressed="${catTool === 'trim'}">⌫ Trim</button><button class="button ${catTool === 'extend' ? 'primary' : 'ghost'}" data-action="cat-tool-extend" aria-pressed="${catTool === 'extend'}">⇥ Extend</button><button class="button ${catTool === 'note' ? 'primary' : 'ghost'}" data-action="cat-tool-note" aria-pressed="${catTool === 'note'}">↗ Note</button><button class="button ${catTool === 'count' ? 'primary' : 'ghost'}" data-action="cat-tool-count" aria-pressed="${catTool === 'count'}">◎ Count</button><button class="button ${dimensionsVisible ? 'active-constraint' : 'ghost'}" data-action="toggle-cat-dimensions" aria-pressed="${dimensionsVisible}">${dimensionsVisible ? '◉' : '○'} CAT dimensions</button><button class="button ghost" data-action="close-cat-tool">Done</button></div>`;
}

function renderVisibilityControls() {
  const dimensionsVisible = getDimensionLayer(documentModel).visible;
  const railingLayer = getRailingLayer(documentModel);
  const catConstructionLayer = getCatConstructionLayer(documentModel);
  const catDimensionLayer = getCatDimensionLayer(documentModel);
  const deckingLayer = getDeckingLayer(documentModel);
  const gridLayer = getGridLayer(documentModel);
  return `<section class="inspector-section layer-panel"><div class="eyebrow">Drawing layers</div><h2>Visibility</h2><p class="section-copy">Hide model or annotation layers to reach construction lines underneath.</p><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${deckingLayer.visible ? '◉' : '○'}</span><span><strong>Decking</strong><small>Walkable surface fill and board pattern</small></span><input id="decking-visible" type="checkbox" ${deckingLayer.visible ? 'checked' : ''}></label><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${railingLayer.visible ? '◉' : '○'}</span><span><strong>Railing</strong><small>Construction runs and posts</small></span><input id="railing-visible" type="checkbox" ${railingLayer.visible ? 'checked' : ''}></label><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${catConstructionLayer.visible ? '◉' : '○'}</span><span><strong>CAT construction lines</strong><small>Yellow reference geometry for future construction</small></span><input id="cat-construction-visible" type="checkbox" ${catConstructionLayer.visible ? 'checked' : ''}></label><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${catDimensionLayer.visible ? '◉' : '○'}</span><span><strong>CAT dimensions</strong><small>Secondary horizontal, vertical, and direct measurements</small></span><input id="cat-dimensions-visible" type="checkbox" ${catDimensionLayer.visible ? 'checked' : ''}></label><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${dimensionsVisible ? '◉' : '○'}</span><span><strong>Dimensions</strong><small>Drag labels · double-click to edit</small></span><input id="dimensions-visible" type="checkbox" ${dimensionsVisible ? 'checked' : ''}></label><label class="layer-row"><span class="layer-grip">⋮⋮</span><span class="layer-eye">${gridLayer.visible ? '◉' : '○'}</span><span><strong>Construction grid</strong><small>Visual guide · snap remains independent</small></span><input id="grid-visible" type="checkbox" ${gridLayer.visible ? 'checked' : ''}></label></section>`;
}

function renderSnapControls() {
  const snapSettings = getSnapSettings(documentModel);
  return `<section class="inspector-section snap-panel"><div class="eyebrow">Precision</div><h2>Snap controls</h2><p class="section-copy">Inference guides align new geometry to nearby nodes without creating permanent constraints.</p><label class="snap-option"><input id="snap-edges" type="checkbox" ${snapSettings.edges ? 'checked' : ''}><span><strong>Edges & corners</strong><small>Connect endpoints to project geometry and CAT CL</small></span><kbd>E</kbd></label><label class="snap-option"><input id="snap-grid" type="checkbox" ${snapSettings.grid ? 'checked' : ''}><span><strong>Construction grid</strong><small>Place endpoints at field increments</small></span><kbd>G</kbd></label><label class="snap-option"><input id="snap-node-inference" type="checkbox" ${snapSettings.nodeInference ? 'checked' : ''}><span><strong>Node inference</strong><small>Horizontal and vertical references</small></span><kbd>N</kbd></label><label class="snap-option"><input id="snap-diagonal-inference" type="checkbox" ${snapSettings.diagonalInference ? 'checked' : ''} ${snapSettings.nodeInference ? '' : 'disabled'}><span><strong>Angled inference</strong><small>22.5° and 45° references from nearby nodes</small></span><kbd>22.5°</kbd></label><div class="field-grid"><div class="field full"><label for="grid-spacing">Grid snap increment</label><select id="grid-spacing"><option value="auto" ${gridSetting === 'auto' ? 'selected' : ''}>Adaptive view · ½″ precision</option>${[.5, 1, 2, 6, 12, 24].map((value) => `<option value="${value}" ${String(value) === String(gridSetting) ? 'selected' : ''}>${value} inch${value === 1 ? '' : 'es'}</option>`).join('')}</select></div></div><div class="action-stack"><button class="button" data-action="fit-project">Fit project to view</button></div></section>`;
}

function renderInspector(current, validation) {
  if (!current) return `
    <section class="inspector-section empty-panel"><div class="eyebrow">First construction object</div><div class="empty-symbol">◇</div><h2>Define the deck surface</h2><p class="section-copy">Start from field dimensions or draw a custom outline. The finished boundary becomes part of the project model.</p></section>
    <section class="inspector-section"><div class="eyebrow">Fast start</div><h2>Rectangle deck</h2><p class="section-copy">Enter the outside dimensions of the walkable surface.</p><div class="field-grid"><div class="field"><label for="width">Width (ft)</label><input id="width" type="number" min="1" step="0.5" value="16"></div><div class="field"><label for="depth">Depth (ft)</label><input id="depth" type="number" min="1" step="0.5" value="12"></div></div><div class="action-stack"><button class="button primary" data-action="create-rectangle">Create deck boundary</button><button class="button" data-mode="draw">Draw a custom outline</button></div><div class="hint-card">Measure the outside edge of the finished walking surface. Structural framing will connect to this boundary in future tools.</div></section>`;
  const selectedEdge = selected.kind === 'edge' ? current.edges.find((edge) => edge.id === selected.id) : null;
  const selectedVertex = selected.kind === 'vertex' ? current.vertices.find((vertex) => vertex.id === selected.id) : null;
  const selectedStair = selected.kind === 'stair' ? documentModel.objects.find((object) => object.type === 'stair' && object.id === selected.id) : null;
  const selectedStairEdge = selected.kind === 'stair-edge' ? findStairInterfaceByEdgeId(selected.id) : null;
  const selectedRailing = selected.kind === 'railing' ? findRailingGeometry(selected.id) : null;
  const firstIssue = validation.issues[0];
  return `
    ${validation.valid ? '' : `<section class="inspector-section"><div class="validation error"><span class="validation-dot"></span><span>${escapeHtml(firstIssue?.message ?? 'Boundary needs attention.')}</span></div></section>`}
    ${selectedEdge ? renderEdgeInspector(current, selectedEdge) : ''}
    ${stairDraft && selectedEdge ? renderStairInspector(current, selectedEdge) : ''}
    ${selectedStair ? renderStairObjectInspector(selectedStair) : ''}
    ${selectedStairEdge ? renderStairInterfaceInspector(current, selectedStairEdge.stair, selectedStairEdge.edge) : ''}
    ${selectedRailing ? renderRailingInspector(selectedRailing) : ''}
    ${selectedVertex ? `<section class="inspector-section"><div class="eyebrow">Selected corner</div><h2>Geometry corner</h2><p class="section-copy">Drag freely, or place this corner over a neighboring corner to merge them and remove the redundant edge.</p><div class="vertex-guidance"><span class="merge-symbol"></span><span>Neighboring corners glow when a valid merge is available.</span></div><div class="action-stack"><button class="button danger" data-action="delete-vertex" ${current.vertices.length <= 3 ? 'disabled' : ''}>Remove corner</button></div></section>` : ''}`;
}

function renderRailingInspector(geometry) {
  const project = analyzeRailingGeometries(getAllRailingGeometries());
  return `<section class="inspector-section railing-panel"><div class="object-status"><div><div class="eyebrow">Railing construction object</div><h2>${escapeHtml(geometry.railing.name)}</h2></div><span class="object-badge established">Snap anchored</span></div><p class="section-copy">This run may cross inside or outside the deck. Each endpoint retains its edge, corner, or grid snap reference.</p><div class="metric-grid"><div class="metric"><div class="metric-label">Run length</div><div class="metric-value">${formatFeetInches(geometry.length)}</div></div><div class="metric"><div class="metric-label">Sections</div><div class="metric-value">${geometry.sectionCount}</div></div><div class="metric"><div class="metric-label">Clear span</div><div class="metric-value">${formatFeetInches(geometry.clearSpan)}</div></div><div class="metric"><div class="metric-label">Run posts</div><div class="metric-value">${geometry.postCount}</div></div></div><div class="validation"><span class="validation-dot"></span><span>Equal sections keep every clear span at or below 6 ft. Exterior corners are the project default.</span></div><div class="hint-card">Project railing: ${formatFeetInches(project.totalLength)} · ${project.sectionCount} sections · ${project.estimatedPostCount} estimated posts.</div><div class="action-stack"><button class="button danger" data-action="remove-railing">Remove railing run</button></div></section>`;
}

function renderStairInterfaceInspector(current, stair, edge) {
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  const start = byId.get(edge.startVertexId);
  const end = byId.get(edge.endVertexId);
  const length = start && end ? Math.hypot(end.x - start.x, end.y - start.y) : stair.dimensions.width;
  const properties = normalizeBoundaryEdge(edge).properties;
  const nodeControlled = stair.dimensions.snappedStart || stair.dimensions.snappedEnd;
  return `<section class="inspector-section edge-inspector stair-interface-panel"><div class="object-status"><div><div class="eyebrow">Deck–Stair interface</div><h2>${formatFeetInches(length)}</h2></div><span class="object-badge established">${nodeControlled ? 'Node snapped' : 'Selectable edge'}</span></div><p class="section-copy">${nodeControlled ? 'The stair side is attached to an adjacent construction node. Move that shared node to change the opening while preserving the snap.' : 'This is the construction line where the staircase meets the deck. Assign finishes here without creating overlapping geometry.'}</p><div class="field-grid"><div class="field full"><label for="stair-interface-width">Exact opening width</label><div class="compound-field"><input id="stair-interface-width" value="${formatFeetInches(length)}" ${nodeControlled ? 'disabled' : ''}><button class="button" data-action="apply-stair-width" ${nodeControlled ? 'disabled' : ''}>Apply</button></div></div></div><div class="property-list"><label><input type="checkbox" data-edge-property="fascia" ${properties.finishes.fascia ? 'checked' : ''}><span><strong>Fascia</strong><small>Finish board at stair interface</small></span></label><label><input type="checkbox" data-edge-property="pictureFrame" ${properties.finishes.pictureFrame ? 'checked' : ''}><span><strong>Picture frame</strong><small>Decking board along opening</small></span></label><label><input type="checkbox" data-edge-property="demolition" ${properties.existingConditions.demolition ? 'checked' : ''}><span><strong>Demolition</strong><small>Existing interface to remove</small></span></label></div><div class="continuity-note">Owned by ${escapeHtml(stair.name)}</div></section>`;
}

function findStairInterfaceByEdgeId(edgeId) {
  for (const stair of documentModel.objects.filter((object) => object.type === 'stair')) {
    const edge = getStairInterfaceEdge(stair);
    if (edge.id === edgeId) return { stair, edge };
  }
  return null;
}

function stairSideId(stair, side) {
  return `${stair.id}:side:${side}`;
}

function findStairSide(referenceId) {
  for (const stair of documentModel.objects.filter((object) => object.type === 'stair')) {
    for (const side of ['start', 'end']) if (stairSideId(stair, side) === referenceId) return { stair, side };
  }
  return null;
}

function resolveRailingHostByEdgeId(edgeId, edgeKind = null) {
  const current = boundaryForReference(edgeId) ?? boundary();
  if (!current) return null;
  if (edgeKind !== 'stair-interface-edge') {
    const edge = current.edges.find((entry) => entry.id === edgeId);
    if (edge) {
      const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
      return {
        host: { boundaryId: current.id, edgeId: edge.id, edgeKind: 'boundary-edge' },
        edge,
        start: byId.get(edge.startVertexId),
        end: byId.get(edge.endVertexId),
      };
    }
  }
  const reference = findStairInterfaceByEdgeId(edgeId);
  if (!reference) return null;
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  return {
    host: { boundaryId: current.id, edgeId: reference.edge.id, edgeKind: 'stair-interface-edge', ownerId: reference.stair.id },
    edge: reference.edge,
    stair: reference.stair,
    start: byId.get(reference.edge.startVertexId),
    end: byId.get(reference.edge.endVertexId),
  };
}

function findRailingGeometry(railingId) {
  const railing = documentModel.objects.find((object) => object.type === 'railing-run' && object.id === railingId);
  if (!railing) return null;
  if (railing.anchors?.start && railing.anchors?.end) {
    const start = resolveRailingAnchor(railing.anchors.start);
    const end = resolveRailingAnchor(railing.anchors.end);
    return start && end ? deriveRailingLineGeometry(railing, start, end) : null;
  }
  const reference = resolveRailingHostByEdgeId(railing.host.edgeId, railing.host.edgeKind);
  return reference?.start && reference?.end ? deriveRailingGeometry(railing, reference.start, reference.end) : null;
}

function resolveRailingAnchor(anchor) {
  const current = boundaryById(anchor.boundaryId) ?? boundaryForReference(anchor.vertexId ?? anchor.edgeId) ?? boundary();
  if (!current) return anchor.point ?? null;
  if (anchor.snapType === 'vertex') return current.vertices.find((vertex) => vertex.id === anchor.vertexId) ?? anchor.point;
  if (anchor.snapType === 'edge') {
    const reference = resolveRailingHostByEdgeId(anchor.edgeId, anchor.edgeKind);
    if (reference?.start && reference?.end) {
      return {
        x: reference.start.x + (reference.end.x - reference.start.x) * anchor.t,
        y: reference.start.y + (reference.end.y - reference.start.y) * anchor.t,
      };
    }
  }
  return anchor.point ?? null;
}

function getAllRailingGeometries() {
  return documentModel.objects.filter((object) => object.type === 'railing-run').map((railing) => findRailingGeometry(railing.id)).filter(Boolean);
}

function areaDimensionId(current = boundary()) {
  return current ? `${current.id}:area` : null;
}

function stairDimensionId(stair) {
  return `${stair.id}:label`;
}

function findStairByDimensionId(referenceId) {
  return documentModel.objects.find((object) => object.type === 'stair' && stairDimensionId(object) === referenceId) ?? null;
}

function levelDownDimensionId(levelDown) {
  return `${levelDown.id}:drop`;
}

function findLevelDownByDimensionId(referenceId) {
  return documentModel.objects.find((object) => object.type === 'level-down' && levelDownDimensionId(object) === referenceId) ?? null;
}

function getLevelDownDepth(levelDown, current = boundary()) {
  return deriveLevelDownDepth(levelDown, documentModel.objects.filter((object) => object.type === 'level-down' && object.host.boundaryId === current?.id), current);
}

function findLevelDownSegment(segmentId) {
  for (const levelDown of documentModel.objects.filter((object) => object.type === 'level-down')) {
    const index = levelDown.segments.findIndex((segment) => segment.id === segmentId);
    if (index < 0) continue;
    const start = levelDown.vertices[index];
    const end = levelDown.vertices[index + 1];
    return { levelDown, segment: levelDown.segments[index], index, start, end, length: Math.hypot(end.x - start.x, end.y - start.y) };
  }
  return null;
}

function resolveBoardingReference({ edgeId, stairEdgeId, stairSideReferenceId, levelDownSegmentId, railingId }) {
  if (edgeId || stairEdgeId) {
    const reference = resolveRailingHostByEdgeId(edgeId ?? stairEdgeId, stairEdgeId ? 'stair-interface-edge' : null);
    if (reference?.start && reference?.end) return {
      start: reference.start,
      end: reference.end,
      reference: { kind: reference.stair ? 'stair-interface' : 'boundary-edge', id: reference.edge.id, ownerId: reference.stair?.id ?? reference.host.boundaryId },
    };
  }
  if (stairSideReferenceId) {
    const reference = findStairSide(stairSideReferenceId);
    const current = reference ? boundaryById(reference.stair.host.boundaryId) : null;
    if (reference && current) {
      const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
      const start = byId.get(reference.side === 'start' ? reference.stair.anchors.openingStartVertexId : reference.stair.anchors.openingEndVertexId);
      const end = byId.get(reference.side === 'start' ? reference.stair.anchors.outerStartVertexId : reference.stair.anchors.outerEndVertexId);
      if (start && end) return { start, end, reference: { kind: 'stair-side', id: stairSideReferenceId, ownerId: reference.stair.id } };
    }
  }
  if (levelDownSegmentId) {
    const reference = findLevelDownSegment(levelDownSegmentId);
    if (reference) return { start: reference.start, end: reference.end, reference: { kind: 'level-down-segment', id: reference.segment.id, ownerId: reference.levelDown.id } };
  }
  if (railingId) {
    const geometry = findRailingGeometry(railingId);
    if (geometry) return { start: geometry.start, end: geometry.end, reference: { kind: 'railing-run', id: railingId, ownerId: railingId } };
  }
  return null;
}

function selectedLevelDown() {
  if (selected.kind === 'level-down') return findLevelDownSegment(selected.id)?.levelDown ?? null;
  if (selected.kind === 'dimension') return findLevelDownByDimensionId(selected.id);
  return null;
}

function resolveDimensionReference(referenceId) {
  const current = boundaryForReference(referenceId) ?? boundary();
  if (current && referenceId === areaDimensionId(current)) return { kind: 'area', boundary: current, label: `${formatSquareFeet(current.computed.areaSquareInches)} deck area` };
  const stairLabel = findStairByDimensionId(referenceId);
  if (stairLabel) return { kind: 'stair', stair: stairLabel, boundary: boundaryById(stairLabel.host.boundaryId), label: stairLabel.name };
  const levelDown = findLevelDownByDimensionId(referenceId);
  if (current && levelDown) return { kind: 'level-down-area', levelDown, region: deriveLevelDownRegion(levelDown, current), label: `${formatInches(getLevelDownDepth(levelDown, current))} below main deck` };
  const railingGeometry = findRailingGeometry(referenceId);
  if (railingGeometry) return { kind: 'railing', railing: railingGeometry.railing, geometry: railingGeometry, label: `${formatFeetInches(railingGeometry.length)} railing run` };
  const edgeIndex = current?.edges.findIndex((edge) => edge.id === referenceId) ?? -1;
  if (edgeIndex >= 0) {
    const edge = current.edges[edgeIndex];
    const start = current.vertices[edgeIndex];
    const end = current.vertices[(edgeIndex + 1) % current.vertices.length];
    const stair = edge.properties?.attachments?.stairId
      ? documentModel.objects.find((object) => object.type === 'stair' && object.id === edge.properties.attachments.stairId)
      : null;
    return { kind: 'boundary-edge', edge, stair, label: `${formatFeetInches(Math.hypot(end.x - start.x, end.y - start.y))} dimension` };
  }
  const interfaceReference = findStairInterfaceByEdgeId(referenceId);
  if (!interfaceReference || !current) return null;
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  const start = byId.get(interfaceReference.edge.startVertexId);
  const end = byId.get(interfaceReference.edge.endVertexId);
  return { kind: 'stair-interface', ...interfaceReference, label: `${formatFeetInches(Math.hypot(end.x - start.x, end.y - start.y))} stair opening` };
}

function getDimensionObjectAnchor(referenceId) {
  const reference = resolveDimensionReference(referenceId);
  const current = reference?.boundary ?? boundaryForReference(referenceId) ?? boundary();
  if (!reference || !current) return null;
  if (reference.kind === 'area') return getBoundaryCentroid(current);
  if (reference.kind === 'level-down-area') return reference.region?.centroid ?? null;
  if (reference.kind === 'railing') return { x: (reference.geometry.start.x + reference.geometry.end.x) / 2, y: (reference.geometry.start.y + reference.geometry.end.y) / 2 };
  if (reference.kind === 'stair') {
    const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
    const points = Object.values(reference.stair.anchors).map((id) => byId.get(id)).filter(Boolean);
    return points.length ? { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length } : null;
  }
  if (reference.kind === 'stair-interface') {
    const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
    const start = byId.get(reference.edge.startVertexId);
    const end = byId.get(reference.edge.endVertexId);
    return start && end ? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } : null;
  }
  const edgeIndex = current.edges.findIndex((edge) => edge.id === reference.edge?.id);
  if (edgeIndex < 0) return null;
  const start = current.vertices[edgeIndex];
  const end = current.vertices[(edgeIndex + 1) % current.vertices.length];
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function renderStairObjectInspector(stair) {
  const riserCount = stair.dimensions.riserCount ?? stair.dimensions.stepCount;
  const treadCount = stair.dimensions.treadCount ?? Math.max(1, riserCount - 1);
  return `<section class="inspector-section stair-panel"><div class="object-status"><div><div class="eyebrow">Stair construction object</div><h2>${escapeHtml(stair.name)}</h2></div><span class="object-badge ${stair.lifecycle?.needsReview ? 'review' : 'established'}">${stair.lifecycle?.needsReview ? 'Needs review' : stair.destination ? 'Deck connected' : 'Attached'}</span></div><p class="section-copy">${stair.destination ? 'This staircase connects its upper Deck Boundary to a referenced lower deck landing.' : 'Generated from the authoritative Deck Boundary. The deck surface is the upper landing, so the final transition from the last tread counts as a riser.'}</p><div class="metric-grid"><div class="metric"><div class="metric-label">Total rise</div><div class="metric-value">${formatFeetInches(stair.dimensions.totalRise)}</div></div><div class="metric"><div class="metric-label">Total run</div><div class="metric-value">${formatFeetInches(stair.dimensions.totalRun)}</div></div><div class="metric"><div class="metric-label">Risers</div><div class="metric-value">${riserCount} × ${formatFeetInches(stair.dimensions.riserHeight)}</div></div><div class="metric"><div class="metric-label">Treads</div><div class="metric-value">${treadCount} × ${formatFeetInches(stair.dimensions.treadDepth)}</div></div></div><div class="validation ${stair.lifecycle?.needsReview ? 'error' : ''}"><span class="validation-dot"></span><span>${stair.lifecycle?.needsReview ? 'The destination deck must remain below the stair host. Reconnect this staircase after changing levels.' : 'Each riser is 7.5″ or less and each tread is 11″ or less.'}</span></div></section>`;
}

function renderEdgeInspector(current, edge) {
  const normalized = normalizeBoundaryEdge(edge);
  const index = current.edges.findIndex((entry) => entry.id === edge.id);
  const start = current.vertices[index];
  const end = current.vertices[(index + 1) % current.vertices.length];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const properties = normalized.properties;
  const orientation = getEdgeOrientationConstraint(current, edge.id);
  const locked = isEdgeLocked(current, edge.id);
  return `<section class="inspector-section edge-inspector"><div class="object-status"><div><div class="eyebrow">Construction edge</div><h2>${formatFeetInches(length)}</h2></div><span class="object-badge established">Independent</span></div><p class="section-copy">Drag the edge to move it, or refine it with exact construction dimensions.</p><div class="field-grid"><div class="field full"><label for="edge-length">Exact edge length</label><div class="compound-field"><input id="edge-length" value="${formatFeetInches(length)}"><button class="button" data-action="apply-edge-length">Apply</button></div></div><div class="field full"><label for="edge-offset">Move perpendicular</label><div class="compound-field"><input id="edge-offset" placeholder="6 in"><button class="button" data-action="apply-edge-offset">Move</button></div></div></div><div class="constraint-row constraint-row-3" role="group" aria-label="Edge orientation"><button class="button ${orientation?.type === 'horizontal' ? 'active-constraint' : ''}" data-action="constraint-horizontal" ${locked ? 'disabled' : ''}>${orientation?.type === 'horizontal' ? '✓ ' : ''}Horizontal</button><button class="button ${orientation?.type === 'vertical' ? 'active-constraint' : ''}" data-action="constraint-vertical" ${locked ? 'disabled' : ''}>${orientation?.type === 'vertical' ? '✓ ' : ''}Vertical</button><button class="button ${orientation?.type === 'fixed-angle' ? 'active-constraint' : ''}" data-action="constraint-lock-angle" ${locked ? 'disabled' : ''}>${orientation?.type === 'fixed-angle' ? '✓ ' : ''}Lock angle</button></div><div class="constraint-status ${orientation ? 'active' : ''}"><span>${orientation ? '●' : '○'}</span>${locked ? 'Full edge lock active' : describeOrientationConstraint(orientation)}</div><div class="property-list"><label><input type="checkbox" data-edge-property="fascia" ${properties.finishes.fascia ? 'checked' : ''}><span><strong>Fascia</strong><small>Exterior finish board</small></span></label><label><input type="checkbox" data-edge-property="pictureFrame" ${properties.finishes.pictureFrame ? 'checked' : ''}><span><strong>Picture frame</strong><small>Decking board along edge</small></span></label><label><input type="checkbox" data-edge-property="demolition" ${properties.existingConditions.demolition ? 'checked' : ''}><span><strong>Demolition</strong><small>Existing edge to remove</small></span></label></div><div class="field-grid"><div class="field full"><label for="edge-role">Construction relationship</label><select id="edge-role"><option value="open" ${edge.role === 'open' ? 'selected' : ''}>Unassigned</option><option value="house" ${edge.role === 'house' ? 'selected' : ''}>House attachment</option><option value="free-edge" ${edge.role === 'free-edge' ? 'selected' : ''}>Open deck edge</option></select></div><div class="field full"><label for="edge-railing">Railing intent</label><select id="edge-railing"><option value="unassigned" ${properties.safety.railing === 'unassigned' ? 'selected' : ''}>Unassigned</option><option value="required" ${properties.safety.railing === 'required' ? 'selected' : ''}>Railing required</option><option value="existing" ${properties.safety.railing === 'existing' ? 'selected' : ''}>Existing railing</option></select></div></div><div class="action-stack"><button class="button" data-action="insert-midpoint">Insert corner at midpoint</button><button class="button primary" data-action="start-stair">Attach staircase</button></div></section>`;
}

function describeOrientationConstraint(constraint) {
  if (!constraint) return 'Angle is free';
  if (constraint.type === 'horizontal') return 'Active constraint: Horizontal';
  if (constraint.type === 'vertical') return 'Active constraint: Vertical';
  let degrees = constraint.angleRadians * 180 / Math.PI;
  degrees = ((degrees % 180) + 180) % 180;
  if (Math.abs(degrees - 180) < .05) degrees = 0;
  return `Active constraint: Angle locked · ${degrees.toFixed(1)}°`;
}

function renderStairInspector(current, edge) {
  return `<section class="inspector-section stair-panel"><div class="eyebrow">Live stair placement</div><h2>Press and drag outward</h2><p class="section-copy">The drag controls total rise first. CME chooses equal risers, then snaps the run to equal construction treads. A lower deck connects only when the complete landing line fits inside its surface.</p><div class="stair-limit-list"><span><strong>5″–7.5″</strong> equal risers</span><span><strong>10″–11″</strong> equal treads</span><span><strong>Deck</strong> is the upper landing</span></div><div class="action-stack"><button class="button" data-action="cancel-stair">Cancel stair tool</button></div></section>`;
}

function drawCanvas(svg, current, validation) {
  svg.setAttribute('viewBox', `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  const visibleGrid = gridSetting === 'auto' ? adaptiveGridSpacing(viewport.width, svg.clientWidth || 1000) : Number(gridSetting);
  const majorGrid = visibleGrid * 4;
  const defs = svgElement('defs');
  const minor = svgElement('pattern', { id: 'minorGrid', width: visibleGrid, height: visibleGrid, patternUnits: 'userSpaceOnUse' });
  minor.append(svgElement('path', { d: `M ${visibleGrid} 0 L 0 0 0 ${visibleGrid}`, class: 'grid-minor', fill: 'none' }));
  const major = svgElement('pattern', { id: 'majorGrid', width: majorGrid, height: majorGrid, patternUnits: 'userSpaceOnUse' });
  major.append(svgElement('rect', { width: majorGrid, height: majorGrid, fill: 'url(#minorGrid)' }), svgElement('path', { d: `M ${majorGrid} 0 L 0 0 0 ${majorGrid}`, class: 'grid-major', fill: 'none' }));
  defs.append(minor, major);
  svg.append(defs, svgElement('rect', { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height, fill: getGridLayer(documentModel).visible ? 'url(#majorGrid)' : '#0d1114' }));
  svg.append(svgElement('line', { x1: viewport.x, y1: '0', x2: viewport.x + viewport.width, y2: '0', class: 'axis-line' }), svgElement('line', { x1: '0', y1: viewport.y, x2: '0', y2: viewport.y + viewport.height, class: 'axis-line' }));
  if (current) {
    boundaries().forEach((deck) => {
      const visibleBoundary = chamferDraft?.boundary?.id === deck.id ? chamferDraft.boundary : deck;
      renderBoundarySvg(svg, visibleBoundary, validateDeckBoundary(visibleBoundary));
      renderLevelDownGraphics(svg, visibleBoundary);
    });
    // Construction objects must remain above every deck surface. Rendering a
    // lower deck after its host stair would otherwise cover the completed stair
    // even though the object was successfully stored in the project model.
    boundaries().forEach((deck) => {
      const visibleBoundary = chamferDraft?.boundary?.id === deck.id ? chamferDraft.boundary : deck;
      renderStairGraphics(svg, visibleBoundary);
    });
    renderStairPreview(svg, current);
    renderRailingGraphics(svg);
    if (getDimensionLayer(documentModel).visible) {
      boundaries().forEach((deck) => {
        const visibleBoundary = chamferDraft?.boundary?.id === deck.id ? chamferDraft.boundary : deck;
        renderBoundaryDimensions(svg, visibleBoundary);
        renderLevelDownDimensions(svg, visibleBoundary);
        renderStairDimensions(svg, visibleBoundary);
      });
      if (chamferDraft) renderChamferDimension(svg, chamferDraft);
    }
  }
  renderFramingGraphics(svg);
  renderCatGraphics(svg);
  if (draft.length) renderDraft(svg);
}

/* Framing draws above the deck surface and below the dimensions, in the trade
   colours the old tool used: beams green, joists a dashed amber, posts and
   pillars solid squares. */
function renderFramingGraphics(svg) {
  const pick = (id) => (selected.kind === 'framing' && selected.id === id ? ' selected' : '');

  getBeams(documentModel).forEach((beam) => {
    svg.append(svgElement('line', {
      x1: beam.start.x, y1: beam.start.y, x2: beam.end.x, y2: beam.end.y,
      class: 'framing-beam' + pick(beam.id), 'data-framing-id': beam.id,
    }));
    svg.append(svgElement('line', {
      x1: beam.start.x, y1: beam.start.y, x2: beam.end.x, y2: beam.end.y,
      class: 'framing-hit', 'data-framing-id': beam.id,
    }));
    // only when the standard is in force — an unset deck level derives nothing
    if (standardApplies(documentModel)) {
      const geometry = deriveBeamGeometry(beam, getTakeoffState(documentModel).settings);
      if (geometry) renderBeamGeometry(svg, geometry, false);
    }
  });

  getJoists(documentModel).forEach((joist) => {
    svg.append(svgElement('line', {
      x1: joist.start.x, y1: joist.start.y, x2: joist.end.x, y2: joist.end.y,
      class: 'framing-joist' + pick(joist.id), 'data-framing-id': joist.id,
    }));
    svg.append(svgElement('line', {
      x1: joist.start.x, y1: joist.start.y, x2: joist.end.x, y2: joist.end.y,
      class: 'framing-hit', 'data-framing-id': joist.id,
    }));
  });

  getPosts(documentModel).forEach((post) => {
    const half = 1.75;   // a 4x4 is 3.5 inches
    svg.append(svgElement('rect', {
      x: post.at.x - half, y: post.at.y - half, width: half * 2, height: half * 2,
      class: 'framing-post' + pick(post.id), 'data-framing-id': post.id,
    }));
  });

  getPillars(documentModel).forEach((pillar) => {
    const half = (Number(pillar.dimensions?.sizeInches) || 6) / 2;
    svg.append(svgElement('rect', {
      x: pillar.at.x - half, y: pillar.at.y - half, width: half * 2, height: half * 2,
      class: 'framing-pillar' + pick(pillar.id), 'data-framing-id': pillar.id,
    }));
  });

  getGates(documentModel).forEach((gate) => {
    const half = (Number(gate.dimensions?.widthInches) || 36) / 2;
    const angle = Number(gate.angle) || 0;
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    /* Drawn as the opening it is: a cleared span with end ticks and a swing
       arc, the way a plan reads a gate. */
    const group = svgElement('g', { class: 'symbol-gate' + pick(gate.id), 'data-framing-id': gate.id });
    group.append(
      svgElement('line', { x1: gate.at.x - dx, y1: gate.at.y - dy, x2: gate.at.x + dx, y2: gate.at.y + dy, class: 'gate-span' }),
      svgElement('line', { x1: gate.at.x - dx, y1: gate.at.y - dy, x2: gate.at.x - dx - dy * 0.35, y2: gate.at.y - dy + dx * 0.35, class: 'gate-tick' }),
      svgElement('line', { x1: gate.at.x + dx, y1: gate.at.y + dy, x2: gate.at.x + dx - dy * 0.35, y2: gate.at.y + dy + dx * 0.35, class: 'gate-tick' }),
      svgElement('path', { d: `M ${gate.at.x - dx} ${gate.at.y - dy} A ${half * 2} ${half * 2} 0 0 1 ${gate.at.x + dx - dy * 0.9} ${gate.at.y + dy + dx * 0.9}`, class: 'gate-swing' }),
      svgElement('line', { x1: gate.at.x - dx, y1: gate.at.y - dy, x2: gate.at.x + dx, y2: gate.at.y + dy, class: 'framing-hit', 'data-framing-id': gate.id }),
    );
    svg.append(group);
  });

  getCountMarkers(documentModel).forEach((marker) => {
    const group = svgElement('g', { class: 'symbol-count' + pick(marker.id), 'data-framing-id': marker.id });
    group.append(
      svgElement('circle', { cx: marker.at.x, cy: marker.at.y, r: 7, class: 'count-pin' }),
      svgElement('text', { x: marker.at.x, y: marker.at.y + 2.6, class: 'count-seq', 'text-anchor': 'middle' }),
      svgElement('circle', { cx: marker.at.x, cy: marker.at.y, r: 13, class: 'framing-hit', fill: 'transparent', 'data-framing-id': marker.id }),
    );
    group.querySelector('.count-seq').textContent = String(marker.seq ?? '');
    group.querySelector('.count-seq').append();
    svg.append(group);
  });

  if (framingDraft && pointerWorld) {
    svg.append(svgElement('line', {
      x1: framingDraft.start.x, y1: framingDraft.start.y,
      x2: pointerWorld.x, y2: pointerWorld.y, class: 'framing-draft',
    }));
    /* Posts, footings and the span limit appear WHILE the run is being drawn,
       so the layout is a decision made with the answer in view rather than one
       discovered after committing. Same derivation as the placed run. */
    if (framingTool === 'beam' && standardApplies(documentModel)) {
      const settings = getTakeoffState(documentModel).settings;
      renderBeamSpanGuide(svg, framingDraft.start, pointerWorld, settings.beamMaxPostSpacingFeet);
      const preview = deriveBeamGeometry(
        { id: 'preview', start: framingDraft.start, end: pointerWorld }, settings);
      if (preview) renderBeamGeometry(svg, preview, true);
    }
  }
}

function renderCatGraphics(svg) {
  if (getCatConstructionLayer(documentModel).visible) {
    getCatLines(documentModel).forEach((line) => {
      const [start, end] = line.vertices;
      const selectedClass = selected.kind === 'cat' && selected.id === line.id ? 'selected' : '';
      svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `cat-line ${selectedClass}` }));
      svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'cat-line-hit', 'data-cat-object-id': line.id }));
      [start, end].forEach((point) => svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: Math.max(1.7, viewport.width / 360), class: `cat-node ${selectedClass}` })));
    });
  }
  if (getCatDimensionLayer(documentModel).visible) getCatMeasurements(documentModel).forEach((measurement) => renderCatMeasurement(svg, measurement, false));
  if (getCatDimensionLayer(documentModel).visible) getCatNotes(documentModel).forEach((note) => renderCatNote(svg, note));
  if (mode === 'cat' && catDraft?.start && catPointer) {
    if (catSnapState.guides.includes('vertical')) svg.append(svgElement('line', { x1: catPointer.x, y1: viewport.y, x2: catPointer.x, y2: viewport.y + viewport.height, class: 'cat-guide-line' }));
    if (catSnapState.guides.includes('horizontal')) svg.append(svgElement('line', { x1: viewport.x, y1: catPointer.y, x2: viewport.x + viewport.width, y2: catPointer.y, class: 'cat-guide-line' }));
    if (catSnapState.inference) renderNodeInferenceGuide(svg, catSnapState.inference, catPointer, Math.max(2.8, viewport.width / 150));
    if (catTool === 'measure') renderCatMeasurement(svg, { id: 'cat-preview', start: catDraft.start, end: catPointer }, true);
    else {
      svg.append(svgElement('line', { x1: catDraft.start.x, y1: catDraft.start.y, x2: catPointer.x, y2: catPointer.y, class: 'cat-line preview' }));
      svg.append(svgElement('circle', { cx: catPointer.x, cy: catPointer.y, r: Math.max(2.2, viewport.width / 280), class: 'cat-snap-marker' }));
    }
  }
}

function catNoteLabel(note) {
  const index = getCatNotes(documentModel).findIndex((entry) => entry.id === note.id);
  return `NOTE ${Math.max(1, index + 1)}`;
}

function renderCatNote(svg, note) {
  const labelPoint = { x: note.anchor.x + note.labelOffset.x, y: note.anchor.y + note.labelOffset.y };
  const label = catNoteLabel(note);
  const selectedClass = selected.kind === 'cat' && selected.id === note.id ? 'selected' : '';
  const dx = note.anchor.x - labelPoint.x;
  const dy = note.anchor.y - labelPoint.y;
  const length = Math.hypot(dx, dy) || 1;
  svg.append(svgElement('line', { x1: labelPoint.x, y1: labelPoint.y, x2: note.anchor.x, y2: note.anchor.y, class: `cat-note-leader ${selectedClass}` }));
  const direction = { x: dx / length, y: dy / length };
  const normal = { x: -direction.y, y: direction.x };
  const arrow = [
    note.anchor,
    { x: note.anchor.x - direction.x * 7 + normal.x * 3, y: note.anchor.y - direction.y * 7 + normal.y * 3 },
    { x: note.anchor.x - direction.x * 7 - normal.x * 3, y: note.anchor.y - direction.y * 7 - normal.y * 3 },
  ];
  svg.append(svgElement('polygon', { points: arrow.map((point) => `${point.x},${point.y}`).join(' '), class: `cat-note-arrow ${selectedClass}` }));
  const width = Math.max(34, label.length * 4.1);
  const group = svgElement('g', { class: `cat-note-label ${selectedClass}` });
  group.append(svgElement('rect', { x: labelPoint.x - width / 2 - 4, y: labelPoint.y - 8, width: width + 8, height: 16, rx: 4, class: 'cat-note-hit', 'data-cat-object-id': note.id, 'data-cat-note-id': note.id }));
  group.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 6, width, height: 12, rx: 3, class: 'cat-note-bg', 'data-cat-object-id': note.id, 'data-cat-note-id': note.id }));
  const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + 1, class: 'cat-note-text' });
  text.textContent = `${note.audioDataUrl ? '● ' : ''}${label}`;
  group.append(text);
  svg.append(group);
}

function renderCatMeasurement(svg, measurement, preview) {
  const derived = deriveCatMeasurement(measurement);
  const { start, end } = measurement;
  const selectedClass = !preview && selected.kind === 'cat' && selected.id === measurement.id ? 'selected' : '';
  const shared = `${preview ? 'preview' : ''} ${selectedClass}`;
  svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: derived.corner.x, y2: derived.corner.y, class: `cat-measure-leg ${shared}` }));
  svg.append(svgElement('line', { x1: derived.corner.x, y1: derived.corner.y, x2: end.x, y2: end.y, class: `cat-measure-leg ${shared}` }));
  svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `cat-measure-direct ${shared}` }));
  if (!preview) svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'cat-measure-line-hit', 'data-cat-object-id': measurement.id }));
  const horizontalPoint = { x: (start.x + derived.corner.x) / 2, y: start.y - 5 };
  const verticalPoint = { x: end.x + 7, y: (derived.corner.y + end.y) / 2 };
  const length = derived.pointToPointDistance || 1;
  const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
  const directPoint = { x: derived.midpoint.x + normal.x * 11, y: derived.midpoint.y + normal.y * 11 };
  renderCatMeasurementLabel(svg, horizontalPoint, `H ${formatFeetInches(derived.horizontalDistance)}`, measurement.id, shared);
  renderCatMeasurementLabel(svg, verticalPoint, `V ${formatFeetInches(derived.verticalDistance)}`, measurement.id, shared);
  renderCatMeasurementLabel(svg, directPoint, `↗ ${formatFeetInches(derived.pointToPointDistance)}`, measurement.id, shared);
  [start, end].forEach((point) => svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: Math.max(1.8, viewport.width / 350), class: `cat-measure-node ${shared}` })));
}

function renderCatMeasurementLabel(svg, point, label, referenceId, className) {
  const width = Math.max(28, label.length * 3.2);
  const group = svgElement('g', { class: `cat-measure-label ${className}` });
  group.append(svgElement('rect', { x: point.x - width / 2 - 3, y: point.y - 7, width: width + 6, height: 14, rx: 4, class: 'cat-measure-hit', 'data-cat-object-id': referenceId }));
  group.append(svgElement('rect', { x: point.x - width / 2, y: point.y - 5.5, width, height: 11, rx: 3, class: 'cat-measure-bg', 'data-cat-object-id': referenceId }));
  const text = svgElement('text', { x: point.x, y: point.y + 1, class: 'cat-measure-text' });
  text.textContent = label;
  group.append(text);
  svg.append(group);
}

function renderStairGraphics(svg, current) {
  documentModel.objects.filter((object) => object.type === 'stair' && object.host.boundaryId === current.id).forEach((stair) => renderStairShape(svg, current, stair, false));
}

function renderStairDimensions(svg, current) {
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  documentModel.objects.filter((object) => object.type === 'stair' && object.host.boundaryId === current.id).forEach((stair) => {
    const points = [stair.anchors.openingStartVertexId, stair.anchors.outerStartVertexId, stair.anchors.outerEndVertexId, stair.anchors.openingEndVertexId]
      .map((id) => byId.get(id)).filter(Boolean);
    if (points.length !== 4) return;
    renderStairDimension(svg, current, stair, points);
    const edge = getStairInterfaceEdge(stair);
    const start = byId.get(edge.startVertexId);
    const end = byId.get(edge.endVertexId);
    if (start && end) addDimension(svg, start, end, edge.id);
  });
}

function renderStairPreview(svg, current) {
  if (!stairDraft || !selected.id || !stairDraft.totalRise) return;
  const options = { ...stairDraft };
  if (!validateStairPlacement(current, selected.id, options).valid) return;
  let count = 0;
  try {
    const preview = attachStairToBoundary(current, selected.id, options, (prefix) => `preview-${prefix}-${++count}`);
    renderStairShape(svg, preview.boundary, preview.stair, true);
    if (stairDraft.destination && stairDraft.landing) {
      svg.append(svgElement('line', { x1: stairDraft.landing.start.x, y1: stairDraft.landing.start.y, x2: stairDraft.landing.end.x, y2: stairDraft.landing.end.y, class: 'stair-landing-snap' }));
    }
    if (stairDraft.snappedStart || stairDraft.snappedEnd) {
      const byId = new Map(preview.boundary.vertices.map((vertex) => [vertex.id, vertex]));
      const snapIds = [stairDraft.snappedStart ? preview.stair.anchors.openingStartVertexId : null, stairDraft.snappedEnd ? preview.stair.anchors.openingEndVertexId : null];
      snapIds.filter(Boolean).map((id) => byId.get(id)).filter(Boolean).forEach((point) => {
        svg.append(svgElement('circle', { cx: point.x, cy: point.y, r: Math.max(5, viewport.width / 140), class: 'stair-snap-node' }));
      });
    }
  } catch { /* Inspector communicates invalid planning dimensions. */ }
}

function renderStairShape(svg, current, stair, preview) {
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  const ids = stair.anchors;
  const polygonPoints = [ids.openingStartVertexId, ids.outerStartVertexId, ids.outerEndVertexId, ids.openingEndVertexId]
    .map((id) => byId.get(id)).filter(Boolean);
  if (polygonPoints.length !== 4) return;
  const invalidClass = stair.lifecycle?.needsReview ? 'invalid' : '';
  const selectedClass = selected.kind === 'stair' && selected.id === stair.id ? 'selected' : '';
  svg.append(svgElement('polygon', { points: polygonPoints.map((point) => `${point.x},${point.y}`).join(' '), class: `${preview ? 'stair-preview-fill' : 'stair-construction-fill'} ${invalidClass} ${selectedClass}` }));
  deriveStairTreads(current, stair).forEach((tread, index) => {
    svg.append(svgElement('line', { x1: tread.start.x, y1: tread.start.y, x2: tread.end.x, y2: tread.end.y, class: `${preview ? 'stair-preview-tread' : 'stair-tread'} ${invalidClass}`, 'data-step': index + 1 }));
  });
  if (!preview) {
    renderStairSide(svg, current, stair, 'start', polygonPoints[0], polygonPoints[1]);
    renderStairSide(svg, current, stair, 'end', polygonPoints[3], polygonPoints[2]);
    renderStairInterfaceEdge(svg, current, stair, byId);
  }
}

function renderStairSide(svg, current, stair, side, start, end) {
  const referenceId = stairSideId(stair, side);
  const selectedClass = selected.kind === 'stair-side' && selected.id === referenceId ? 'selected' : '';
  const invalidClass = stair.lifecycle?.needsReview ? 'invalid' : '';
  svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `stair-side-visible ${selectedClass} ${invalidClass}` }));
  deriveStairSideSegments(current, stair, side, boundaries()).forEach((segment) => {
    const attributes = segment.role === 'shared-boundary'
      ? { 'data-edge-id': segment.boundaryEdgeId, 'data-boundary-id': segment.boundaryId }
      : { 'data-stair-side-id': referenceId, 'data-boundary-id': stair.host.boundaryId };
    svg.append(svgElement('line', { x1: segment.start.x, y1: segment.start.y, x2: segment.end.x, y2: segment.end.y, class: `stair-side-hit ${segment.role}`, ...attributes }));
  });
  const stairEditing = (selected.kind === 'stair' && selected.id === stair.id)
    || (selected.kind === 'dimension' && selected.id === stairDimensionId(stair))
    || (selected.kind === 'stair-side' && selected.id === referenceId);
  if (stairEditing) {
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'stair-side-edit-hit', 'data-stair-side-id': referenceId, 'data-boundary-id': stair.host.boundaryId }));
    svg.append(svgElement('circle', { cx: midpoint.x, cy: midpoint.y, r: Math.max(3.2, viewport.width / 190), class: 'stair-side-edit-handle' }));
  }
}

function renderStairDimension(svg, current, stair, points) {
  const referenceId = stairDimensionId(stair);
  if (!isDimensionReferenceVisible(documentModel, referenceId)) return;
  const source = { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length };
  const offset = getDimensionOffset(documentModel, referenceId);
  const leaderOffset = getDimensionLeaderOffset(documentModel, referenceId);
  const labelPoint = { x: source.x + offset.x, y: source.y + offset.y };
  const tip = { x: source.x + leaderOffset.x, y: source.y + leaderOffset.y };
  if (Math.hypot(offset.x, offset.y) > 3) renderDimensionLeader(svg, labelPoint, tip, referenceId);
  const stairs = documentModel.objects.filter((object) => object.type === 'stair');
  const number = Math.max(1, stairs.findIndex((object) => object.id === stair.id) + 1);
  const label = `STAIRS ${number} · ${stair.dimensions.riserCount}R · ${stair.dimensions.treadCount}T`;
  const width = Math.max(54, label.length * 3.4);
  const selectedClass = (selected.kind === 'dimension' && selected.id === referenceId) || (selected.kind === 'stair' && selected.id === stair.id) ? 'selected' : '';
  const invalidClass = stair.lifecycle?.needsReview ? 'invalid' : '';
  const group = svgElement('g', { class: 'dimension-annotation stair-dimension' });
  group.append(svgElement('rect', { x: labelPoint.x - width / 2 - 3, y: labelPoint.y - 8, width: width + 6, height: 16, rx: 4, class: 'dimension-hit', 'data-dimension-id': referenceId, 'data-boundary-id': current.id }));
  group.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 6, width, height: 12, rx: 3, class: `dimension-bg stair ${selectedClass} ${invalidClass}`, 'data-dimension-id': referenceId, 'data-boundary-id': current.id }));
  const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + 1, class: `dimension-text stair ${invalidClass}` });
  text.textContent = label;
  group.append(text);
  svg.append(group);
}

function renderStairInterfaceEdge(svg, current, stair, byId) {
  const edge = getStairInterfaceEdge(stair);
  const start = byId.get(edge.startVertexId);
  const end = byId.get(edge.endVertexId);
  if (!start || !end) return;
  renderEdgeConstructionGraphics(svg, current, start, end, edge.properties);
  const selectedClass = selected.kind === 'stair-edge' && selected.id === edge.id ? 'selected' : '';
  svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `stair-interface-visible ${selectedClass}` }));
  svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'stair-interface-hit', 'data-stair-edge-id': edge.id }));
}

function renderRailingGraphics(svg) {
  if (!getRailingLayer(documentModel).visible && !railingDraft) return;
  getAllRailingGeometries().forEach((geometry) => renderRailingGeometry(svg, geometry, false));
  if (railingDraft?.geometry) renderRailingGeometry(svg, railingDraft.geometry, true);
  [railingDraft?.startAnchor, railingDraft?.endAnchor].filter(Boolean).forEach((anchor, index) => {
    const size = Math.max(7, viewport.width / 95);
    svg.append(svgElement('rect', {
      x: anchor.point.x - size / 2,
      y: anchor.point.y - size / 2,
      width: size,
      height: size,
      rx: size * .18,
      class: `railing-snap-marker ${anchor.snapType} ${index === 0 ? 'start' : 'end'}`,
      transform: `rotate(45 ${anchor.point.x} ${anchor.point.y})`,
    }));
  });
}

/* A beam's posts and footings, drawn from the SAME derivation the takeoff
   orders from. Nothing here is stored: this is a picture of what the standard
   makes of the run, and it redraws itself the instant the run changes.
   Deliberately shaped like renderRailingGeometry, because it is the same idea. */
function renderBeamGeometry(svg, geometry, preview) {
  const selectedClass = !preview && selected.kind === 'framing' && selected.id === geometry.beam.id ? 'selected' : '';
  const footing = geometry.footingSizeInches;
  geometry.posts.forEach((post) => {
    // the footing pad first, so the post reads on top of it
    svg.append(svgElement('rect', {
      x: post.x - footing / 2, y: post.y - footing / 2, width: footing, height: footing,
      class: `framing-footing ${preview ? 'preview' : ''} ${selectedClass}`,
    }));
    const size = preview ? 4 : 4.5;
    svg.append(svgElement('rect', {
      x: post.x - size / 2, y: post.y - size / 2, width: size, height: size, rx: .5,
      class: `framing-derived-post ${preview ? 'preview' : ''} ${selectedClass}`,
    }));
  });
}

/* The standard's limit, shown while a run is being drawn so the estimator can
   see where the next post is going to land before committing to the length. */
function renderBeamSpanGuide(svg, start, toward, maxSpacingFeet) {
  const span = (Number(maxSpacingFeet) || 6) * 12;
  const dx = toward.x - start.x;
  const dy = toward.y - start.y;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 1e-6) return;
  const ux = dx / magnitude;
  const uy = dy / magnitude;
  for (let mark = span; mark <= Math.max(magnitude, span); mark += span) {
    const x = start.x + ux * mark;
    const y = start.y + uy * mark;
    svg.append(svgElement('line', {
      x1: x - uy * 7, y1: y + ux * 7, x2: x + uy * 7, y2: y - ux * 7,
      class: 'framing-span-guide',
    }));
  }
}

function renderRailingGeometry(svg, geometry, preview) {
  const selectedClass = !preview && selected.kind === 'railing' && selected.id === geometry.railing.id ? 'selected' : '';
  svg.append(svgElement('line', { x1: geometry.start.x, y1: geometry.start.y, x2: geometry.end.x, y2: geometry.end.y, class: `railing-run-visible ${preview ? 'preview' : ''} ${selectedClass}` }));
  geometry.posts.forEach((post) => {
    const size = preview ? 4 : 4.5;
    svg.append(svgElement('rect', { x: post.x - size / 2, y: post.y - size / 2, width: size, height: size, rx: .5, class: `railing-run-post ${preview ? 'preview' : ''} ${selectedClass}` }));
  });
  if (!preview) {
    svg.append(svgElement('line', { x1: geometry.start.x, y1: geometry.start.y, x2: geometry.end.x, y2: geometry.end.y, class: 'railing-run-hit', 'data-railing-id': geometry.railing.id }));
  }
}

function renderBoundarySvg(svg, current, validation) {
  const points = current.vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' ');
  const depthFactor = getBoundaryLevelDown(current) / 7.5;
  const shade = Math.max(5, 28 - depthFactor * 3);
  if (getDeckingLayer(documentModel).visible) {
    svg.append(svgElement('polygon', { points, class: `boundary-fill ${validation.valid ? '' : 'invalid'} ${current.id === activeBoundaryId ? 'active-deck' : ''}`, style: `fill: rgb(${shade} ${shade + 28} ${shade + 27} / 82%)`, 'data-boundary-id': current.id }));
    renderDeckBoarding(svg, current);
  }
  current.edges.forEach((edge, index) => {
    const start = current.vertices[index];
    const end = current.vertices[(index + 1) % current.vertices.length];
    renderEdgeConstructionGraphics(svg, current, start, end, normalizeBoundaryEdge(edge).properties);
    const selectedClass = selected.kind === 'edge' && selected.id === edge.id ? 'selected' : '';
    svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `boundary-edge-visible ${edge.role} ${selectedClass}` }));
    const hit = svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'boundary-edge', 'data-edge-id': edge.id, 'data-boundary-id': current.id });
    svg.append(hit);
  });
  const markerSize = Math.max(2.8, viewport.width / 150);
  const hitSize = viewport.width / Math.max(svg.clientWidth || 1000, 1) * 34;
  const stairOnlyVertices = new Set(documentModel.objects
    .filter((object) => object.type === 'stair' && object.host.boundaryId === current.id)
    .flatMap((stair) => [stair.anchors.outerStartVertexId, stair.anchors.outerEndVertexId]));
  current.vertices.forEach((vertex) => {
    if (stairOnlyVertices.has(vertex.id)) return;
    svg.append(svgElement('rect', { x: vertex.x - hitSize / 2, y: vertex.y - hitSize / 2, width: hitSize, height: hitSize, class: 'vertex-hit', 'data-vertex-id': vertex.id, 'data-boundary-id': current.id }));
    svg.append(svgElement('rect', { x: vertex.x - markerSize / 2, y: vertex.y - markerSize / 2, width: markerSize, height: markerSize, rx: markerSize * .12, class: `vertex ${selected.kind === 'vertex' && selected.id === vertex.id ? 'selected' : ''} ${mergeCandidateId === vertex.id ? 'merge-ready' : ''}`, transform: `rotate(45 ${vertex.x} ${vertex.y})` }));
    if (vertex.locked) {
      const lock = svgElement('text', { x: vertex.x + markerSize * 1.15, y: vertex.y - markerSize * .9, class: 'constraint-anchor vertex-anchor' });
      lock.textContent = '⚓';
      svg.append(lock);
    }
  });
}

function renderDeckBoarding(svg, current) {
  if (!getDeckBoarding(current)) return;
  const byId = new Map(current.vertices.map((vertex) => [vertex.id, vertex]));
  const stairExclusions = documentModel.objects
    .filter((object) => object.type === 'stair' && object.host?.boundaryId === current.id)
    .map((stair) => [stair.anchors.openingStartVertexId, stair.anchors.outerStartVertexId, stair.anchors.outerEndVertexId, stair.anchors.openingEndVertexId]
      .map((id) => byId.get(id)).filter(Boolean))
    .filter((polygon) => polygon.length === 4);
  deriveDeckBoardingSegments(current, stairExclusions).forEach((segment) => {
    svg.append(svgElement('line', {
      x1: segment.start.x,
      y1: segment.start.y,
      x2: segment.end.x,
      y2: segment.end.y,
      class: 'deck-boarding-line',
    }));
  });
}

function renderBoundaryDimensions(svg, current) {
  current.edges.forEach((edge, index) => {
    const temporaryChamferDimension = chamferDraft?.boundary?.id === current.id && chamferDraft.chamferEdgeId === edge.id;
    const stairGeneratedDimension = Boolean(edge.properties?.attachments?.stairId);
    if (temporaryChamferDimension || stairGeneratedDimension) return;
    addDimension(svg, current.vertices[index], current.vertices[(index + 1) % current.vertices.length], edge.id);
  });
  renderAreaDimension(svg, current);
}

function renderAreaDimension(svg, current) {
  const referenceId = areaDimensionId(current);
  if (!isDimensionReferenceVisible(documentModel, referenceId)) return;
  const center = getBoundaryCentroid(current);
  const offset = getDimensionOffset(documentModel, referenceId);
  const leaderOffset = getDimensionLeaderOffset(documentModel, referenceId);
  const labelPoint = { x: center.x + offset.x, y: center.y - 24 + offset.y };
  const tip = { x: center.x + leaderOffset.x, y: center.y + leaderOffset.y };
  const label = `AREA · ${formatSquareFeet(current.computed.areaSquareInches)}`;
  const levelDown = getBoundaryLevelDown(current);
  const width = Math.max(46, label.length * 3.5);
  const selectedClass = selected.kind === 'dimension' && selected.id === referenceId ? 'selected' : '';
  renderDimensionLeader(svg, labelPoint, tip, referenceId);
  const group = svgElement('g', { class: 'dimension-annotation area-dimension' });
  group.append(svgElement('rect', { x: labelPoint.x - width / 2 - 3, y: labelPoint.y - 8, width: width + 6, height: 16, rx: 4, class: 'dimension-hit', 'data-dimension-id': referenceId, 'data-boundary-id': current.id }));
  group.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 6, width, height: 12, rx: 3, class: `dimension-bg area ${selectedClass}`, 'data-dimension-id': referenceId, 'data-boundary-id': current.id }));
  const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + 1, class: 'dimension-text area' });
  text.textContent = label;
  group.append(text);
  if (levelDown > 0) {
    const levelLabel = `↓ ${formatInches(levelDown)}`;
    const levelWidth = Math.max(24, levelLabel.length * 3.5);
    group.append(svgElement('rect', { x: labelPoint.x - levelWidth / 2, y: labelPoint.y + 8, width: levelWidth, height: 10, rx: 2.5, class: `dimension-bg deck-level ${selectedClass}`, 'data-dimension-id': referenceId, 'data-boundary-id': current.id }));
    const levelText = svgElement('text', { x: labelPoint.x, y: labelPoint.y + 13.5, class: 'dimension-text deck-level' });
    levelText.textContent = levelLabel;
    group.append(levelText);
  }
  svg.append(group);
}

function renderLevelDownGraphics(svg, current) {
  documentModel.objects.filter((object) => object.type === 'level-down' && object.host.boundaryId === current.id).forEach((levelDown) => {
    const region = deriveLevelDownRegion(levelDown, current);
    if (region) {
      const depthFactor = Math.max(1, getLevelDownDepth(levelDown, current) / 7.5);
      svg.append(svgElement('polygon', {
        points: region.points.map((point) => `${point.x},${point.y}`).join(' '),
        class: 'level-down-region',
        'fill-opacity': Math.min(.16 + depthFactor * .08, .58),
      }));
    }
    levelDown.segments.forEach((segment, index) => {
      const start = levelDown.vertices[index];
      const end = levelDown.vertices[index + 1];
      const segmentLength = Math.hypot(end.x - start.x, end.y - start.y) || 1;
      const normal = { x: -(end.y - start.y) / segmentLength, y: (end.x - start.x) / segmentLength };
      const selectedClass = selected.kind === 'level-down' && selected.id === segment.id ? 'selected' : '';
      svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: `level-down-line ${selectedClass}` }));
      if (levelDown.properties?.finishes?.pictureFrame) svg.append(svgElement('line', { x1: start.x + normal.x * 3, y1: start.y + normal.y * 3, x2: end.x + normal.x * 3, y2: end.y + normal.y * 3, class: 'level-down-picture-frame' }));
      if (levelDown.properties?.finishes?.fascia) svg.append(svgElement('line', { x1: start.x - normal.x * 2, y1: start.y - normal.y * 2, x2: end.x - normal.x * 2, y2: end.y - normal.y * 2, class: 'level-down-fascia' }));
      svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'level-down-hit', 'data-level-down-segment-id': segment.id }));
    });
  });
  if (levelDownDraft.length) {
    const points = [...levelDownDraft.map((entry) => entry.point), ...(levelDownPointer ? [levelDownPointer.point] : [])];
    svg.append(svgElement('polyline', { points: points.map((entry) => `${entry.x},${entry.y}`).join(' '), class: 'level-down-preview', fill: 'none' }));
    points.forEach((point) => svg.append(svgElement('rect', { x: point.x - 2.5, y: point.y - 2.5, width: 5, height: 5, class: 'level-down-marker', transform: `rotate(45 ${point.x} ${point.y})` })));
  }
}

function renderLevelDownDimensions(svg, current) {
  documentModel.objects.filter((object) => object.type === 'level-down' && object.host.boundaryId === current.id).forEach((levelDown) => {
    const region = deriveLevelDownRegion(levelDown, current);
    if (region) renderLevelDownDimension(svg, levelDown, region, getLevelDownDepth(levelDown, current));
  });
}

function renderLevelDownDimension(svg, levelDown, region, totalDepth) {
  const referenceId = levelDownDimensionId(levelDown);
  if (!isDimensionReferenceVisible(documentModel, referenceId)) return;
  const source = region.centroid;
  const offset = getDimensionOffset(documentModel, referenceId);
  const leaderOffset = getDimensionLeaderOffset(documentModel, referenceId);
  const labelPoint = { x: source.x + offset.x, y: source.y - 20 + offset.y };
  const tip = { x: source.x + leaderOffset.x, y: source.y + leaderOffset.y };
  renderDimensionLeader(svg, labelPoint, tip, referenceId);
  const label = `↓ ${formatInches(totalDepth)}`;
  const width = Math.max(30, label.length * 4);
  const selectedClass = selected.kind === 'dimension' && selected.id === referenceId ? 'selected' : '';
  const group = svgElement('g', { class: 'dimension-annotation level-down-dimension' });
  group.append(svgElement('rect', { x: labelPoint.x - width / 2 - 3, y: labelPoint.y - 8, width: width + 6, height: 16, rx: 4, class: 'dimension-hit', 'data-dimension-id': referenceId }));
  group.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 6, width, height: 12, rx: 3, class: `dimension-bg level-down ${selectedClass}`, 'data-dimension-id': referenceId }));
  const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + 1, class: 'dimension-text level-down' });
  text.textContent = label;
  group.append(text);
  svg.append(group);
}

function renderEdgeConstructionGraphics(svg, current, start, end, properties) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return;
  const signedArea = current.vertices.reduce((sum, vertex, index) => {
    const next = current.vertices[(index + 1) % current.vertices.length];
    return sum + vertex.x * next.y - next.x * vertex.y;
  }, 0);
  const interiorSign = signedArea >= 0 ? 1 : -1;
  const interior = { x: -dy / length * interiorSign, y: dx / length * interiorSign };
  if (properties.finishes.pictureFrame) {
    svg.append(svgElement('line', { x1: start.x + interior.x * 3, y1: start.y + interior.y * 3, x2: end.x + interior.x * 3, y2: end.y + interior.y * 3, class: 'picture-frame-board' }));
  }
  if (properties.finishes.fascia) {
    svg.append(svgElement('line', { x1: start.x - interior.x * 1.5, y1: start.y - interior.y * 1.5, x2: end.x - interior.x * 1.5, y2: end.y - interior.y * 1.5, class: 'fascia-board' }));
  }
  if (properties.existingConditions.demolition) {
    svg.append(svgElement('line', { x1: start.x, y1: start.y, x2: end.x, y2: end.y, class: 'demolition-edge' }));
  }
  if (getRailingLayer(documentModel).visible && (properties.safety.railing === 'required' || properties.safety.railing === 'existing')) {
    const postCount = Math.max(2, Math.ceil(length / 48) + 1);
    for (let index = 0; index < postCount; index += 1) {
      const t = index / (postCount - 1);
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      svg.append(svgElement('rect', { x: x - 2, y: y - 2, width: 4, height: 4, class: `railing-post ${properties.safety.railing}` }));
    }
  }
}

function addDimension(svg, start, end, referenceId) {
  if (!isDimensionReferenceVisible(documentModel, referenceId)) return;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 12) return;
  const offsetX = (-dy / length) * 8;
  const offsetY = (dx / length) * 8;
  const dimensionBoundary = boundaryForReference(referenceId);
  const locked = dimensionBoundary?.edges.some((edge) => edge.id === referenceId) && isEdgeLocked(dimensionBoundary, referenceId);
  const orientation = dimensionBoundary ? getEdgeOrientationConstraint(dimensionBoundary, referenceId) : null;
  const constraintMark = locked ? '⚓ ' : orientation?.type === 'fixed-angle' ? '⚓∠ ' : orientation?.type === 'horizontal' ? 'H · ' : orientation?.type === 'vertical' ? 'V · ' : '';
  const label = `${constraintMark}${formatFeetInches(length)}`;
  const width = Math.max(25, label.length * 3.3);
  const annotationOffset = getDimensionOffset(documentModel, referenceId);
  const leaderOffset = getDimensionLeaderOffset(documentModel, referenceId);
  const labelPoint = { x: midX + offsetX + annotationOffset.x, y: midY + offsetY + annotationOffset.y };
  const tip = { x: midX + leaderOffset.x, y: midY + leaderOffset.y };
  renderDimensionLeader(svg, labelPoint, tip, referenceId);
  const group = svgElement('g', { class: 'dimension-annotation' });
  const selectedClass = selected.kind === 'dimension' && selected.id === referenceId ? 'selected' : '';
  group.append(svgElement('rect', { x: labelPoint.x - width / 2 - 2, y: labelPoint.y - 6, width: width + 4, height: 12, rx: 3, class: 'dimension-hit', 'data-dimension-id': referenceId }));
  group.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 4, width, height: 8, rx: 2, class: `dimension-bg ${selectedClass}`, 'data-dimension-id': referenceId }));
  const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + .3, class: 'dimension-text' });
  text.textContent = label;
  group.append(text);
  svg.append(group);
}

function renderChamferDimension(svg, draft) {
  const edge = draft.boundary.edges.find((entry) => entry.id === draft.chamferEdgeId);
  if (!edge) return;
  const byId = new Map(draft.boundary.vertices.map((vertex) => [vertex.id, vertex]));
  const start = byId.get(edge.startVertexId);
  const end = byId.get(edge.endVertexId);
  const corner = draft.originalCorner;
  if (!start || !end || !corner) return;
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const worldPerPixel = viewport.width / Math.max(svg.clientWidth || 1000, 1);
  const markerSize = Math.max(3.5, worldPerPixel * 9);
  const triangleCenter = { x: (corner.x + start.x + end.x) / 3, y: (corner.y + start.y + end.y) / 3 };
  const guideLabelOffset = Math.max(5, worldPerPixel * 13);

  [start, end].forEach((endpoint) => {
    svg.append(svgElement('line', { x1: corner.x, y1: corner.y, x2: endpoint.x, y2: endpoint.y, class: 'chamfer-construction-guide' }));
    const guideMidpoint = { x: (corner.x + endpoint.x) / 2, y: (corner.y + endpoint.y) / 2 };
    const away = { x: guideMidpoint.x - triangleCenter.x, y: guideMidpoint.y - triangleCenter.y };
    const magnitude = Math.hypot(away.x, away.y) || 1;
    const labelPoint = { x: guideMidpoint.x + away.x / magnitude * guideLabelOffset, y: guideMidpoint.y + away.y / magnitude * guideLabelOffset };
    const label = formatInches(draft.setback);
    const width = Math.max(24, label.length * 3.5);
    svg.append(svgElement('rect', { x: labelPoint.x - width / 2, y: labelPoint.y - 5, width, height: 10, rx: 2.5, class: 'chamfer-setback-bg' }));
    const text = svgElement('text', { x: labelPoint.x, y: labelPoint.y + .5, class: 'chamfer-setback-text' });
    text.textContent = label;
    svg.append(text);
  });

  svg.append(svgElement('rect', { x: corner.x - markerSize / 2, y: corner.y - markerSize / 2, width: markerSize, height: markerSize, rx: markerSize * .12, class: 'chamfer-original-node', transform: `rotate(45 ${corner.x} ${corner.y})` }));

  const anglePoint = { x: corner.x + (midpoint.x - corner.x) * .34, y: corner.y + (midpoint.y - corner.y) * .34 };
  const angle = svgElement('text', { x: anglePoint.x, y: anglePoint.y + 1, class: 'chamfer-angle-text' });
  angle.textContent = '45°';
  svg.append(angle);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const diagonalLength = Math.hypot(dx, dy);
  const diagonalOffset = Math.max(8, worldPerPixel * 15);
  const labelPoint = { x: midpoint.x - dy / diagonalLength * diagonalOffset, y: midpoint.y + dx / diagonalLength * diagonalOffset };
  const diagonalLabel = formatFeetInches(diagonalLength);
  const diagonalWidth = Math.max(27, diagonalLabel.length * 3.4);
  svg.append(svgElement('rect', { x: labelPoint.x - diagonalWidth / 2, y: labelPoint.y - 5, width: diagonalWidth, height: 10, rx: 2.5, class: 'chamfer-diagonal-bg' }));
  const diagonalText = svgElement('text', { x: labelPoint.x, y: labelPoint.y + .5, class: 'chamfer-diagonal-text' });
  diagonalText.textContent = diagonalLabel;
  svg.append(diagonalText);
}

function renderDimensionLeader(svg, labelPoint, tip, referenceId) {
  const active = dimensionLeaderMode?.referenceId === referenceId;
  const dx = tip.x - labelPoint.x;
  const dy = tip.y - labelPoint.y;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    svg.append(svgElement('line', { x1: labelPoint.x, y1: labelPoint.y, x2: tip.x, y2: tip.y, class: `dimension-leader ${active ? 'repositioning' : ''}` }));
    const angle = Math.atan2(dy, dx);
    const size = Math.max(4, viewport.width / 175);
    const arrow = [tip, { x: tip.x - Math.cos(angle - .55) * size, y: tip.y - Math.sin(angle - .55) * size }, { x: tip.x - Math.cos(angle + .55) * size, y: tip.y - Math.sin(angle + .55) * size }];
    svg.append(svgElement('polygon', { points: arrow.map((point) => `${point.x},${point.y}`).join(' '), class: `dimension-leader-arrow ${active ? 'repositioning' : ''}` }));
  }
  if (active) {
    const pulse = Math.max(5, viewport.width / 135);
    svg.append(svgElement('circle', { cx: tip.x, cy: tip.y, r: pulse, class: 'dimension-arrow-pulse' }));
  }
}

function renderDraft(svg) {
  const points = [...draft, ...(pointerWorld ? [pointerWorld] : [])];
  svg.append(svgElement('polyline', { points: points.map((entry) => `${entry.x},${entry.y}`).join(' '), fill: 'none', class: 'preview-line' }));
  const markerSize = Math.max(2.8, viewport.width / 150);
  draft.forEach((vertex, index) => svg.append(svgElement('rect', { x: vertex.x - markerSize / 2, y: vertex.y - markerSize / 2, width: markerSize, height: markerSize, class: `vertex ${index === 0 ? 'start' : ''}`, transform: `rotate(45 ${vertex.x} ${vertex.y})`, 'data-draft-index': index })));
  if (pointerWorld && draft.length) {
    const anchor = draft[draft.length - 1];
    if (snapState.guides.includes('vertical')) svg.append(svgElement('line', { x1: pointerWorld.x, y1: viewport.y, x2: pointerWorld.x, y2: viewport.y + viewport.height, class: 'guide-line' }));
    if (snapState.guides.includes('horizontal')) svg.append(svgElement('line', { x1: viewport.x, y1: pointerWorld.y, x2: viewport.x + viewport.width, y2: pointerWorld.y, class: 'guide-line' }));
    if (snapState.inference) renderNodeInferenceGuide(svg, snapState.inference, pointerWorld, markerSize);
  }
}

function renderNodeInferenceGuide(svg, inference, snappedPoint, markerSize) {
  const reference = inference.referencePoint;
  const direction = { x: Math.cos(inference.guideAngle), y: Math.sin(inference.guideAngle) };
  const projection = (snappedPoint.x - reference.x) * direction.x + (snappedPoint.y - reference.y) * direction.y;
  const projectedPoint = { x: reference.x + direction.x * projection, y: reference.y + direction.y * projection };
  const extension = Math.max(18, viewport.width / 24);
  const lineStart = { x: reference.x - direction.x * extension, y: reference.y - direction.y * extension };
  const lineEnd = { x: projectedPoint.x + direction.x * extension, y: projectedPoint.y + direction.y * extension };
  svg.append(svgElement('line', { x1: lineStart.x, y1: lineStart.y, x2: lineEnd.x, y2: lineEnd.y, class: 'node-inference-guide' }));
  svg.append(svgElement('circle', { cx: reference.x, cy: reference.y, r: markerSize * 1.7, class: 'node-inference-reference-halo' }));
  svg.append(svgElement('rect', { x: reference.x - markerSize / 2, y: reference.y - markerSize / 2, width: markerSize, height: markerSize, class: 'node-inference-reference', transform: `rotate(45 ${reference.x} ${reference.y})` }));
  svg.append(svgElement('circle', { cx: snappedPoint.x, cy: snappedPoint.y, r: markerSize * .7, class: 'node-inference-intersection' }));
}

function bindEvents() {
  app.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
  app.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => handleAction(button.dataset.action, button)));
  app.querySelectorAll('[data-takeoff-quantity]').forEach((input) => input.addEventListener('change', () => {
    const quantity = Number(input.value);
    if (!Number.isFinite(quantity) || quantity < 0) { message = 'Enter a valid material quantity'; render(); return; }
    message = 'Takeoff quantity adjusted';
    commit(updateTakeoffLine(documentModel, input.dataset.takeoffQuantity, { quantity }), 'Adjust takeoff material quantity');
  }));
  app.querySelectorAll('[data-takeoff-setting]').forEach((input) => input.addEventListener('change', () => {
    const key = input.dataset.takeoffSetting;
    const field = TAKEOFF_SETTING_FIELDS.find((entry) => entry.key === key);
    const value = Number(input.value);
    if (!field || !Number.isFinite(value) || value < field.min || value > field.max) {
      message = field ? `${field.label} must be between ${field.min} and ${field.max}` : 'Unknown setting';
      render(); return;
    }
    const state = getTakeoffState(documentModel);
    message = `${field.label} updated - quantities recalculated`;
    commit(setTakeoffState(documentModel, { ...state, settings: { ...state.settings, [key]: value } }), `Change ${field.label.toLowerCase()}`);
  }));
  const notesToggle = app.querySelector('#takeoff-export-notes');
  if (notesToggle) notesToggle.addEventListener('change', () => {
    takeoffExportNotes = notesToggle.checked;
    message = takeoffExportNotes ? 'Notes will be included in the export' : 'Notes stay off the export';
    render();
  });
  app.querySelectorAll('[data-takeoff-note]').forEach((area) => area.addEventListener('change', () => {
    const text = String(area.value ?? '');
    message = text.trim() ? 'Note saved with this material' : 'Note cleared';
    commit(setTakeoffNote(documentModel, area.dataset.takeoffNote, text), 'Note a takeoff material');
  }));
  app.querySelectorAll('[data-takeoff-description]').forEach((input) => input.addEventListener('change', () => {
    const description = String(input.value ?? '').trim();
    if (!description) { message = 'A material needs a description'; render(); return; }
    message = 'Material description updated';
    commit(updateTakeoffLine(documentModel, input.dataset.takeoffDescription, { description }), 'Rename takeoff material');
  }));
  app.querySelectorAll('[data-takeoff-price]').forEach((input) => input.addEventListener('change', () => {
    const unitPrice = input.value === '' ? null : Number(input.value);
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) { message = 'Enter a valid unit price'; render(); return; }
    message = unitPrice === null ? 'Material price cleared' : 'Material price updated';
    commit(updateTakeoffLine(documentModel, input.dataset.takeoffPrice, { unitPrice }), 'Update takeoff material price');
  }));
  const projectNameInput = app.querySelector('#project-name-input');
  if (projectNameInput) projectNameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleAction('rename-project'); }
  });
  const role = app.querySelector('#edge-role');
  if (role) role.addEventListener('change', () => commitBoundary(markBoundaryEdited(setEdgeRole(boundary(), selected.id, role.value)), 'Set edge relationship'));
  const railing = app.querySelector('#edge-railing');
  if (railing) railing.addEventListener('change', () => { message = 'Railing intent updated'; commitBoundary(markBoundaryEdited(updateEdgeProperties(boundary(), selected.id, { safety: { railing: railing.value } })), 'Update edge railing intent'); });
  app.querySelectorAll('[data-edge-property]').forEach((input) => input.addEventListener('change', () => {
    const key = input.dataset.edgeProperty;
    const patch = key === 'demolition' ? { existingConditions: { demolition: input.checked } } : { finishes: { [key]: input.checked } };
    message = `${key} property updated`;
    commitSelectedEdgeProperties(patch, 'Update edge construction properties');
  }));
  const gridSpacing = app.querySelector('#grid-spacing');
  if (gridSpacing) gridSpacing.addEventListener('change', () => { gridSetting = gridSpacing.value; render(); });
  const gridVisibility = app.querySelector('#grid-visible');
  if (gridVisibility) gridVisibility.addEventListener('change', () => {
    message = `Construction grid layer ${gridVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setGridLayerVisibility(documentModel, gridVisibility.checked), 'Toggle Construction grid layer');
  });
  const dimensionVisibility = app.querySelector('#dimensions-visible');
  if (dimensionVisibility) dimensionVisibility.addEventListener('change', () => {
    message = `Dimensions layer ${dimensionVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setDimensionLayerVisibility(documentModel, dimensionVisibility.checked), 'Toggle Dimensions layer');
  });
  const railingVisibility = app.querySelector('#railing-visible');
  if (railingVisibility) railingVisibility.addEventListener('change', () => {
    message = `Railing layer ${railingVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setRailingLayerVisibility(documentModel, railingVisibility.checked), 'Toggle Railing layer');
  });
  const catConstructionVisibility = app.querySelector('#cat-construction-visible');
  if (catConstructionVisibility) catConstructionVisibility.addEventListener('change', () => {
    message = `CAT construction lines ${catConstructionVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setCatConstructionLayerVisibility(documentModel, catConstructionVisibility.checked), 'Toggle CAT construction lines');
  });
  const catDimensionsVisibility = app.querySelector('#cat-dimensions-visible');
  if (catDimensionsVisibility) catDimensionsVisibility.addEventListener('change', () => {
    message = `CAT dimensions ${catDimensionsVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setCatDimensionLayerVisibility(documentModel, catDimensionsVisibility.checked), 'Toggle CAT dimensions');
  });
  const deckingVisibility = app.querySelector('#decking-visible');
  if (deckingVisibility) deckingVisibility.addEventListener('change', () => {
    message = `Decking layer ${deckingVisibility.checked ? 'shown' : 'hidden'}`;
    commit(setDeckingLayerVisibility(documentModel, deckingVisibility.checked), 'Toggle Decking layer');
  });
  const edgeSnap = app.querySelector('#snap-edges');
  if (edgeSnap) edgeSnap.addEventListener('change', () => {
    message = `Edge and corner snap ${edgeSnap.checked ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { edges: edgeSnap.checked }), 'Update edge snap settings');
  });
  const gridSnap = app.querySelector('#snap-grid');
  if (gridSnap) gridSnap.addEventListener('change', () => {
    message = `Grid snap ${gridSnap.checked ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { grid: gridSnap.checked }), 'Update grid snap settings');
  });
  const nodeInference = app.querySelector('#snap-node-inference');
  if (nodeInference) nodeInference.addEventListener('change', () => {
    message = `Node inference ${nodeInference.checked ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { nodeInference: nodeInference.checked }), 'Update node inference settings');
  });
  const diagonalInference = app.querySelector('#snap-diagonal-inference');
  if (diagonalInference) diagonalInference.addEventListener('change', () => {
    message = `22.5° and 45° node inference ${diagonalInference.checked ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { diagonalInference: diagonalInference.checked }), 'Update diagonal inference settings');
  });
  const railingSystem = app.querySelector('#quick-railing-system');
  if (railingSystem) railingSystem.addEventListener('change', () => {
    const railing = documentModel.objects.find((object) => object.type === 'railing-run' && object.id === selected.id);
    if (!railing) return;
    message = `${railingSystem.options[railingSystem.selectedIndex].text} assigned`;
    commit(upsertObject(documentModel, updateRailingSettings(railing, { system: railingSystem.value })), 'Set railing system');
  });
  const svg = app.querySelector('.model-canvas');
  svg.addEventListener('pointerdown', (event) => canvasPointerDown(svg, event));
  svg.addEventListener('pointermove', (event) => canvasPointerMove(svg, event));
  svg.addEventListener('pointerup', (event) => finishPointerGesture(svg, event));
  svg.addEventListener('pointercancel', (event) => finishPointerGesture(svg, event));
  svg.addEventListener('wheel', (event) => zoomAtPointer(svg, event), { passive: false });
  svg.addEventListener('contextmenu', (event) => event.preventDefault());
  svg.addEventListener('dblclick', (event) => canvasDoubleClick(svg, event));
}

function setMode(nextMode) {
  mode = nextMode;
  framingDraft = null;
  utilityPanel = null;
  projectMenuOpen = false;
  exportMenuOpen = false;
  boardingDirectionMode = null;
  pendingDeckDeleteId = null;
  moveBoundaryMode = null;
  moveBoundaryGesture = null;
  dimensionLeaderMode = null;
  dimensionLeaderGesture = null;
  chamferMode = null;
  chamferGesture = null;
  chamferDraft = null;
  numericBuffer = '';
  stairGesture = null;
  stairSideGesture = null;
  railingGesture = null;
  railingDraft = null;
  if (nextMode !== 'cat') { catDraft = null; catPointer = null; }
  if (nextMode !== 'level-down') { levelDownDraft = []; levelDownPointer = null; }
  if (mode !== 'stair') stairDraft = null;
  if (mode !== 'draw') { draft = []; pointerWorld = null; message = 'Ready'; }
  if (mode === 'draw') message = 'Click the first corner of the deck';
  if (mode === 'stair') message = 'Press a boundary edge and drag outward to build stairs';
  if (mode === 'railing') {
    if (!getRailingLayer(documentModel).visible) {
      documentModel = setRailingLayerVisibility(documentModel, true);
      persist();
    }
    message = 'Press an edge, corner, or grid point and drag to another snap target';
  }
  if (mode === 'cat') {
    let next = documentModel;
    if (!getCatConstructionLayer(next).visible) next = setCatConstructionLayerVisibility(next, true);
    if (!getCatDimensionLayer(next).visible) next = setCatDimensionLayerVisibility(next, true);
    if (next !== documentModel) { documentModel = next; persist(); }
    catDraft = null;
    catPointer = null;
    message = ({
      measure: 'Measuring tape · choose the first point',
      trim: 'Trim · touch the CAT Line segment to remove',
      extend: 'Extend · touch near the CAT Line endpoint to extend',
      note: 'CAT Note · choose the arrow point',
    })[catTool] ?? 'CAT Line · choose the first point';
  }
  if (mode === 'level-down') message = 'Click a boundary edge or corner to start Level Down';
  render();
}

function canvasPointerDown(svg, event) {
  const vertexId = event.target.dataset.vertexId;
  const edgeId = event.target.dataset.edgeId;
  const stairEdgeId = event.target.dataset.stairEdgeId;
  const stairSideReferenceId = event.target.dataset.stairSideId;
  const dimensionId = event.target.dataset.dimensionId;
  const railingId = event.target.dataset.railingId;
  const levelDownSegmentId = event.target.dataset.levelDownSegmentId;
  const catObjectId = event.target.dataset.catObjectId;
  const framingId = event.target.dataset.framingId;
  const catNoteId = event.target.dataset.catNoteId;
  const targetBoundaryId = event.target.dataset.boundaryId ?? boundaryForReference(vertexId ?? edgeId ?? dimensionId ?? levelDownSegmentId)?.id;
  if (moveBoundaryMode && event.button === 0) {
    event.preventDefault();
    const point = screenToWorld(svg, event);
    moveBoundaryGesture = { pointerId: event.pointerId, document: documentModel, boundaryId: moveBoundaryMode.boundaryId, start: point };
    svg.setPointerCapture(event.pointerId);
    message = 'Move the complete deck area · release to place';
    updateStatusMessage();
    return;
  }
  activateBoundary(targetBoundaryId);
  if (framingId && event.button === 0 && mode === 'select') {
    event.preventDefault();
    selected = { kind: 'framing', id: framingId };
    message = 'Framing member selected · switch to Framing to repeat it on centre';
    render();
    return;
  }
  if (mode === 'framing' && event.button === 0) {
    /* A second finger means pan/zoom, not a placement - without this a pinch
       mid-mode dropped bogus points. (The first finger of a very fast pinch can
       still start a draft; Escape or the next tap clears it, the same known
       trade-off the CAT tools accept.) */
    if (event.pointerType === 'touch' && activeTouches.size > 0) return;
    event.preventDefault();
    placeFramingPoint(screenToWorld(svg, event), event.pointerType);
    return;
  }
  if (mode === 'cat' && event.button === 0) {
    event.preventDefault();
    placeCatPoint(screenToWorld(svg, event), event.pointerType, event, catObjectId);
    return;
  }
  if (boardingDirectionMode && event.button === 0) {
    event.preventDefault();
    const line = resolveBoardingReference({ edgeId, stairEdgeId, stairSideReferenceId, levelDownSegmentId, railingId });
    const target = boundaryById(boardingDirectionMode.boundaryId);
    if (!line || !target) {
      message = 'Touch a boundary, Stair, Level Down, or Railing line to set board direction';
      updateStatusMessage();
      return;
    }
    const updated = markBoundaryEdited(setDeckBoardingDirection(target, line.start, line.end, line.reference));
    boardingDirectionMode = null;
    pendingDeckDeleteId = null;
    activeBoundaryId = target.id;
    selected = { kind: 'dimension', id: areaDimensionId(target) };
    message = 'Deck boards aligned to the selected construction line';
    commit(upsertObject(documentModel, updated), 'Set deck board direction');
    return;
  }
  if (chamferMode && event.button === 0) {
    event.preventDefault();
    chamferGesture = { pointerId: event.pointerId, document: documentModel, vertexId: chamferMode.vertexId };
    updateChamferDraft(screenToWorld(svg, event));
    svg.setPointerCapture(event.pointerId);
    return;
  }
  if (dimensionLeaderMode && event.button === 0) {
    event.preventDefault();
    const anchor = getDimensionObjectAnchor(dimensionLeaderMode.referenceId);
    if (!anchor) { dimensionLeaderMode = null; message = 'Dimension object is no longer available'; render(); return; }
    const point = screenToWorld(svg, event);
    dimensionLeaderGesture = { pointerId: event.pointerId, document: documentModel, referenceId: dimensionLeaderMode.referenceId, anchor };
    documentModel = setDimensionLeaderOffset(documentModel, dimensionLeaderMode.referenceId, { x: point.x - anchor.x, y: point.y - anchor.y });
    persist();
    svg.setPointerCapture(event.pointerId);
    drawCanvasRefresh();
    return;
  }
  if (event.pointerType === 'touch' && !['railing', 'level-down', 'cat'].includes(mode) && !((mode === 'select' && (vertexId || edgeId || stairEdgeId || stairSideReferenceId || dimensionId || railingId || levelDownSegmentId || catObjectId)) || (mode === 'stair' && edgeId))) {
    event.preventDefault();
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    svg.setPointerCapture(event.pointerId);
    if (activeTouches.size === 2) {
      pendingTouch = null;
      panGesture = null;
      const [first, second] = [...activeTouches.values()];
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      touchGesture = { viewport: { ...viewport }, center, worldAnchor: screenToWorld(svg, { clientX: center.x, clientY: center.y }), distance: Math.hypot(second.x - first.x, second.y - first.y) };
      return;
    }
    if (mode === 'draw') pendingTouch = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    else {
      panGesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewport: { ...viewport }, touch: true };
      svg.classList.add('panning');
    }
    return;
  }
  if (event.button === 2) {
    event.preventDefault();
    panGesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewport: { ...viewport } };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('panning');
    hideHud();
    return;
  }
  if (event.button === 1) {
    event.preventDefault();
    const now = performance.now();
    if (now - lastMiddleClick < 350) fitProject(svg);
    lastMiddleClick = now;
    return;
  }
  if (mode === 'select' && dimensionId) {
    selected = { kind: 'dimension', id: dimensionId };
    dimensionDragStart = { pointerId: event.pointerId, document: documentModel, point: screenToWorld(svg, event), offset: getDimensionOffset(documentModel, dimensionId), moved: false };
    svg.setPointerCapture(event.pointerId);
    return;
  }
  if (mode === 'select' && catNoteId) {
    const note = getCatNotes(documentModel).find((entry) => entry.id === catNoteId);
    if (!note) return;
    selected = { kind: 'cat', id: catNoteId };
    catNoteDragStart = { pointerId: event.pointerId, document: documentModel, point: screenToWorld(svg, event), offset: note.labelOffset, moved: false };
    svg.setPointerCapture(event.pointerId);
    refreshContextPanel();
    drawCanvasRefresh();
    return;
  }
  if (mode === 'select' && catObjectId) {
    selected = { kind: 'cat', id: catObjectId };
    message = 'CAT reference selected';
    render();
    return;
  }
  if (mode === 'select' && railingId) {
    selected = { kind: 'railing', id: railingId };
    message = 'Railing run selected · hosted by construction geometry';
    render();
    return;
  }
  if (mode === 'select' && levelDownSegmentId) {
    selected = { kind: 'level-down', id: levelDownSegmentId };
    message = 'Level Down section selected · riser applies to the entire polyline';
    render();
    return;
  }
  if (mode === 'select' && stairEdgeId) {
    selected = { kind: 'stair-edge', id: stairEdgeId };
    message = 'Deck–Stair interface selected · assign construction properties';
    render();
    return;
  }
  if (mode === 'select' && stairSideReferenceId) {
    const reference = findStairSide(stairSideReferenceId);
    if (!reference) return;
    activateBoundary(reference.stair.host.boundaryId);
    selected = { kind: 'stair-side', id: stairSideReferenceId };
    const snapped = reference.side === 'start' ? reference.stair.dimensions.snappedStart : reference.stair.dimensions.snappedEnd;
    const originalDocument = documentModel;
    let editDocument = documentModel;
    const attachment = reference.stair.sideAttachments?.[reference.side];
    if (attachment?.junction) {
      const targetBoundary = boundaryById(attachment.boundaryId);
      if (targetBoundary) {
        const removed = removeStairSideJunction(targetBoundary, reference.stair, reference.side);
        const editableAttachment = {
          boundaryId: attachment.boundaryId,
          edgeId: attachment.junction.originalEdge.id,
          relationship: 'shared-boundary',
        };
        const editableStair = {
          ...removed.stair,
          sideAttachments: { ...removed.stair.sideAttachments, [reference.side]: editableAttachment },
        };
        editDocument = upsertObject(upsertObject(editDocument, removed.boundary), editableStair);
      }
    }
    stairSideGesture = { pointerId: event.pointerId, document: originalDocument, editDocument, stairId: reference.stair.id, side: reference.side, moved: false };
    svg.setPointerCapture(event.pointerId);
    message = snapped ? 'Drag sideways to detach this stair side from the node' : 'Drag sideways to change stair width · snaps within 6 inches';
    refreshContextPanel();
    drawCanvasRefresh();
    updateStatusMessage();
    return;
  }
  if (mode === 'select' && vertexId) {
    selected = { kind: 'vertex', id: vertexId };
    if (isVertexLocked(boundary(), vertexId)) { message = 'Node is locked in place'; render(); return; }
    const selectedVertex = boundary().vertices.find((vertex) => vertex.id === vertexId);
    if (selectedVertex?.junction?.type === 'stair-side') { message = 'This junction follows the connected stair side · drag the stair side to detach it'; render(); return; }
    const vertexIndex = boundary().vertices.findIndex((vertex) => vertex.id === vertexId);
    if ([boundary().edges[vertexIndex], boundary().edges[(vertexIndex - 1 + boundary().edges.length) % boundary().edges.length]].some((edge) => isEdgeLocked(boundary(), edge.id))) { message = 'A connected construction edge is locked'; render(); return; }
    draggingVertexId = vertexId;
    dragStartDocument = documentModel;
    mergeCandidateId = null;
    svg.setPointerCapture(event.pointerId);
    refreshContextPanel();
    drawCanvasRefresh();
    updateStatusMessage();
    return;
  }
  if (mode === 'select' && edgeId) {
    selected = { kind: 'edge', id: edgeId };
    if (isEdgeLocked(boundary(), edgeId)) { message = 'Construction edge is locked'; render(); return; }
    const edgeIndex = boundary().edges.findIndex((edge) => edge.id === edgeId);
    const endpointLocked = [boundary().vertices[edgeIndex], boundary().vertices[(edgeIndex + 1) % boundary().vertices.length]].some((vertex) => vertex?.locked);
    const neighborLocked = [boundary().edges[(edgeIndex - 1 + boundary().edges.length) % boundary().edges.length], boundary().edges[(edgeIndex + 1) % boundary().edges.length]].some((edge) => isEdgeLocked(boundary(), edge.id));
    if (endpointLocked || neighborLocked) { message = 'Unlock connected nodes and edges before moving this construction edge'; render(); return; }
    draggingEdgeId = edgeId;
    edgeDragStart = { document: documentModel, boundary: boundary(), point: screenToWorld(svg, event), moved: false };
    svg.setPointerCapture(event.pointerId);
    refreshContextPanel();
    drawCanvasRefresh();
    updateStatusMessage();
    return;
  }
  if (mode === 'stair' && edgeId) {
    const pointer = screenToWorld(svg, event);
    const clicked = boundary();
    const worldPerPixel = viewport.width / Math.max(svg.clientWidth, 1);
    const host = resolveStairHostEdge(clicked, edgeId, boundaries(), pointer, Math.max(1, worldPerPixel * 8));
    const current = host?.boundary ?? clicked;
    const hostEdgeId = host?.edgeId ?? edgeId;
    activateBoundary(current.id);
    if (isEdgeLocked(current, hostEdgeId)) { message = 'Unlock this construction edge before attaching a staircase'; updateStatusMessage(); return; }
    const edgeIndex = current.edges.findIndex((edge) => edge.id === hostEdgeId);
    const edgeLength = Math.hypot(
      current.vertices[(edgeIndex + 1) % current.vertices.length].x - current.vertices[edgeIndex].x,
      current.vertices[(edgeIndex + 1) % current.vertices.length].y - current.vertices[edgeIndex].y,
    );
    const opening = deriveStairOpeningSnap(current, hostEdgeId, pointer, Math.min(36, edgeLength));
    if (!opening) { message = 'Select a construction edge at least 24 inches long'; updateStatusMessage(); return; }
    selected = { kind: 'edge', id: hostEdgeId };
    stairGesture = { pointerId: event.pointerId, boundaryId: current.id, edgeId: hostEdgeId, ...opening };
    stairDraft = { edgeId: hostEdgeId, ...opening, totalRise: 0, totalRun: 0, treadDepth: 0, riserCount: 0, treadCount: 0, dragging: true };
    const stairSnapLabel = opening.snappedStart && opening.snappedEnd ? 'Both stair sides snapped to adjacent nodes' : opening.snappedStart || opening.snappedEnd ? 'One stair side snapped to an adjacent node' : 'Stair opening placed';
    const levelMessage = host && host.boundary.id !== clicked.id ? 'Upper shared edge selected automatically' : stairSnapLabel;
    message = `${levelMessage} · drag toward the lower deck`;
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('stairing');
    updateStairLiveHud();
    drawCanvasRefresh();
    return;
  }
  if (mode === 'railing') {
    const startAnchor = resolveRailingSnap(screenToWorld(svg, event));
    if (!startAnchor) {
      message = 'Enable Edge or Grid snap, then begin on an active snap target';
      updateStatusMessage();
      return;
    }
    railingGesture = { pointerId: event.pointerId, startAnchor };
    railingDraft = { startAnchor, endAnchor: null, geometry: null };
    message = `${startAnchor.label} locked · drag to another snap target`;
    svg.setPointerCapture(event.pointerId);
    svg.classList.add('railing');
    drawCanvasRefresh();
    return;
  }
  if (mode === 'level-down') {
    placeLevelDownPoint(screenToWorld(svg, event));
    return;
  }
  if (mode !== 'draw') { selected = { kind: null, id: null }; render(); return; }
  placeDraftPoint(screenToWorld(svg, event), event.pointerType);
}

function placeDraftPoint(raw, pointerType = 'mouse') {
  const snapped = snapForPointer(raw, draft[draft.length - 1], [], new Set(), pointerType);
  if (draft.length >= 3 && Math.hypot(snapped.point.x - draft[0].x, snapped.point.y - draft[0].y) < 5) { completeDraft(); return; }
  draft.push(snapped.point);
  numericBuffer = '';
  message = draft.length < 3 ? 'Continue to the next corner' : 'Click the first corner or press Enter to close';
  render();
}

function catCuttingSegments(excludedLineId = null) {
  const boundarySegments = boundaries().flatMap((deck) => deck.edges.map((edge, index) => ({
    id: edge.id,
    start: deck.vertices[index],
    end: deck.vertices[(index + 1) % deck.vertices.length],
  })));
  const catSegments = getCatLines(documentModel).filter((line) => line.id !== excludedLineId).map((line) => ({ id: line.id, start: line.vertices[0], end: line.vertices[1] }));
  return [...boundarySegments, ...catSegments];
}

/* Beams and joists are two taps; posts and pillars are one. Snapping runs
   through the same engine every other tool uses, so a joist lands on the beam
   it sits on rather than near it. */
function placeFramingPoint(raw, pointerType = 'mouse', exact = false) {
  /* A typed length is a stated fact, so it is used verbatim. Re-snapping it
     nudged the far end onto the nearest grid node and turned an exact 16' into
     16'-0 1/8" - which defeats the entire point of typing it. */
  const snapped = exact ? { point: raw } : snapForPointer(raw, framingDraft?.start ?? null, [], new Set(), pointerType);
  const point = snapped.point;

  if (framingTool === 'post' || framingTool === 'pillar') {
    const object = framingTool === 'post' ? createPost({ at: point }) : createPillar({ at: point });
    selected = { kind: 'framing', id: object.id };
    message = framingTool === 'post'
      ? 'Post placed · it carries a base and three bags of concrete'
      : 'Pillar placed';
    commit(addPost(documentModel, object), framingTool === 'post' ? 'Place post' : 'Place pillar');
    return;
  }

  if (!framingDraft) {
    framingDraft = { start: point };
    message = 'Choose the far end';
    render();
    return;
  }

  const start = framingDraft.start;
  framingDraft = null;
  if (Math.hypot(point.x - start.x, point.y - start.y) < 1) {
    message = 'That run is too short to keep';
    render();
    return;
  }
  try {
    if (framingTool === 'beam') {
      const beam = createBeam({ start, end: point });
      selected = { kind: 'framing', id: beam.id };
      message = 'Beam placed';
      commit(addBeam(documentModel, beam), 'Place beam');
    } else {
      const joist = createJoist({ start, end: point });
      selected = { kind: 'framing', id: joist.id };
      message = `Joist placed · use Repeat to run them at ${framingSpacing}″ on centre`;
      commit(addJoist(documentModel, joist), 'Place joist');
    }
  } catch (error) {
    message = error.message;
    render();
  }
}

function placeCatPoint(raw, pointerType = 'mouse', pointerEvent = null, targetCatObjectId = null) {
  if (catTool === 'trim' || catTool === 'extend') {
    const line = getCatLines(documentModel).find((entry) => entry.id === targetCatObjectId);
    if (!line) { message = `Choose a CAT Line to ${catTool}`; updateStatusMessage(); return; }
    try {
      const updated = catTool === 'trim'
        ? trimCatLine(line, raw, catCuttingSegments(line.id))
        : extendCatLine(line, raw, catCuttingSegments(line.id));
      selected = { kind: 'cat', id: line.id };
      message = catTool === 'trim' ? 'CAT Line trimmed to the nearest crossing' : 'Nearest endpoint extended to the first crossing';
      commit(upsertObject(documentModel, updated), catTool === 'trim' ? 'Trim CAT construction line' : 'Extend CAT construction line');
    } catch (error) { message = error.message; render(); }
    return;
  }
  if (catTool === 'count') {
    /* Numbered tally pins: how a rep counts anything the tool has no idea
       about. Each label numbers independently, so "Light" pins run 1,2,3 while
       "Hanger" pins run their own 1,2,3, and each label becomes its own line on
       the takeoff with the label spelled exactly as typed. */
    const label = lastCountLabel;
    const marker = createCountMarker({ at: raw, label, seq: nextSequence(documentModel, label) });
    selected = { kind: 'framing', id: marker.id };
    message = `${label} ${marker.seq} placed · rename it in the panel to start a new tally`;
    commit(upsertObject(documentModel, marker), 'Place count marker');
    return;
  }
  if (catTool === 'note') {
    const note = createCatNote(raw, '');
    mode = 'select';
    selected = { kind: 'cat', id: note.id };
    message = 'Arrow point placed · write the note in Object properties';
    commit(upsertObject(documentModel, note), 'Add CAT construction note');
    requestAnimationFrame(() => app.querySelector('#cat-note-text')?.focus());
    return;
  }
  const snapped = snapForPointer(raw, catDraft?.start ?? null, [], new Set(), pointerType);
  catSnapState = snapped;
  if (!catDraft?.start) {
    catDraft = { start: snapped.point };
    catPointer = snapped.point;
    numericBuffer = '';
    message = `${snapped.label} · choose the second point`;
    render();
    if (pointerEvent && catTool === 'line') requestAnimationFrame(() => updateHud(pointerEvent));
    return;
  }
  try {
    const object = catTool === 'measure'
      ? createCatMeasurement(catDraft.start, snapped.point)
      : createCatLine(catDraft.start, snapped.point);
    message = catTool === 'measure'
      ? `${formatFeetInches(deriveCatMeasurement(object).pointToPointDistance)} point-to-point measurement added`
      : `${formatFeetInches(Math.hypot(snapped.point.x - catDraft.start.x, snapped.point.y - catDraft.start.y))} CAT line added · continue or press Escape`;
    catDraft = catTool === 'line' ? { start: snapped.point } : null;
    catPointer = catTool === 'line' ? snapped.point : null;
    numericBuffer = '';
    commit(upsertObject(documentModel, object), catTool === 'measure' ? 'Add CAT measuring tape' : 'Add CAT construction line');
    if (pointerEvent && catTool === 'line') requestAnimationFrame(() => updateHud(pointerEvent));
  } catch (error) {
    message = error.message;
    render();
  }
}

function updateChamferDraft(raw) {
  const source = chamferGesture?.document.objects.find((object) => object.type === 'deck-boundary');
  const corner = source?.vertices.find((vertex) => vertex.id === chamferGesture?.vertexId);
  if (!source || !corner) return;
  const index = source.vertices.findIndex((vertex) => vertex.id === corner.id);
  const previous = source.vertices[(index - 1 + source.vertices.length) % source.vertices.length];
  const next = source.vertices[(index + 1) % source.vertices.length];
  const maximum = Math.min(Math.hypot(previous.x - corner.x, previous.y - corner.y), Math.hypot(next.x - corner.x, next.y - corner.y)) - 6;
  const requested = Math.hypot(raw.x - corner.x, raw.y - corner.y);
  const setback = Math.max(6, Math.min(maximum, Math.round(requested * 2) / 2));
  if (maximum < 6) { message = 'Connected edges are too short for a chamfer'; updateStatusMessage(); return; }
  try {
    chamferDraft = { ...chamferVertex(source, corner.id, setback), originalCorner: { x: corner.x, y: corner.y } };
    message = `45° chamfer · ${formatInches(setback)} setback · release to apply`;
    drawCanvasRefresh();
    updateStatusMessage();
  } catch (error) { chamferDraft = null; message = error.message; updateStatusMessage(); }
}

function placeLevelDownPoint(raw) {
  const anchor = resolveRailingSnap(raw);
  if (!anchor) { message = 'Choose an enabled edge, corner, or grid snap'; updateStatusMessage(); return; }
  const boundaryAnchor = ['edge', 'vertex'].includes(anchor.snapType) && anchor.edgeKind !== 'stair-interface-edge';
  if (!levelDownDraft.length && !boundaryAnchor) {
    message = 'Level Down must begin on the Deck Boundary'; updateStatusMessage(); return;
  }
  if (!levelDownDraft.length && anchor.boundaryId) activateBoundary(anchor.boundaryId);
  if (levelDownDraft.length && boundaryAnchor && anchor.boundaryId !== levelDownDraft[0].anchor?.boundaryId) {
    message = 'Finish Level Down on the same Deck Boundary where it started'; updateStatusMessage(); return;
  }
  const previous = levelDownDraft.at(-1)?.point;
  if (previous && Math.hypot(anchor.point.x - previous.x, anchor.point.y - previous.y) < 1) return;
  if (levelDownDraft.length && boundaryAnchor) {
    const points = [...levelDownDraft, anchor].map((entry) => ({ x: entry.point.x, y: entry.point.y, anchor: entry }));
    try {
      const levelDown = createLevelDown(points, { boundaryId: boundary().id });
      selected = { kind: 'level-down', id: levelDown.segments[0].id };
      levelDownDraft = [];
      levelDownPointer = null;
      mode = 'select';
      message = `${levelDown.segments.length} Level Down section${levelDown.segments.length === 1 ? '' : 's'} added · 7½″ riser`;
      commit(upsertObject(documentModel, levelDown), 'Add Level Down construction polyline');
    } catch (error) { message = error.message; render(); }
    return;
  }
  levelDownDraft.push(anchor);
  levelDownPointer = anchor;
  message = levelDownDraft.length === 1 ? 'Start locked · add intermediate points or finish on another boundary edge' : 'Polyline point added · finish on a boundary edge';
  drawCanvasRefresh();
  updateStatusMessage();
}

function canvasPointerMove(svg, event) {
  if (event.pointerType === 'touch' && activeTouches.has(event.pointerId)) {
    activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pendingTouch?.pointerId === event.pointerId) {
      pendingTouch.x = event.clientX;
      pendingTouch.y = event.clientY;
      pendingTouch.moved ||= Math.hypot(event.clientX - pendingTouch.startX, event.clientY - pendingTouch.startY) > 8;
    }
    if (touchGesture && activeTouches.size >= 2) {
      const [first, second] = [...activeTouches.values()];
      const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const currentDistance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const zoomed = zoomViewport(touchGesture.viewport, touchGesture.worldAnchor, touchGesture.distance / currentDistance);
      viewport = panViewport(zoomed, {
        x: -(center.x - touchGesture.center.x) * zoomed.width / svg.clientWidth,
        y: -(center.y - touchGesture.center.y) * zoomed.height / svg.clientHeight,
      });
      drawCanvasRefresh();
      return;
    }
  }
  if (panGesture?.pointerId === event.pointerId) {
    const dx = -(event.clientX - panGesture.startX) * panGesture.viewport.width / svg.clientWidth;
    const dy = -(event.clientY - panGesture.startY) * panGesture.viewport.height / svg.clientHeight;
    viewport = panViewport(panGesture.viewport, { x: dx, y: dy });
    drawCanvasRefresh();
    return;
  }
  const raw = screenToWorld(svg, event);
  if (catNoteDragStart?.pointerId === event.pointerId) {
    const note = catNoteDragStart.document.objects.find((object) => object.type === CAT_NOTE_TYPE && object.id === selected.id);
    if (!note) return;
    const dx = raw.x - catNoteDragStart.point.x;
    const dy = raw.y - catNoteDragStart.point.y;
    catNoteDragStart.moved ||= Math.hypot(dx, dy) > viewport.width / Math.max(svg.clientWidth, 1) * 2;
    const updated = updateCatNote(note, { labelOffset: { x: catNoteDragStart.offset.x + dx, y: catNoteDragStart.offset.y + dy } });
    documentModel = upsertObject(catNoteDragStart.document, updated);
    persist();
    drawCanvasRefresh();
    return;
  }
  if (mode === 'cat' && catDraft?.start) {
    catSnapState = snapForPointer(raw, catDraft.start, [], new Set(), event.pointerType);
    catPointer = catSnapState.point;
    message = `${catSnapState.label} · ${catTool === 'measure' ? 'horizontal, vertical, and point-to-point preview' : 'click to place CAT line'}`;
    drawCanvasRefresh();
    if (catTool === 'line') updateHud(event);
    else hideHud();
    updateStatusMessage();
    return;
  }
  if (moveBoundaryGesture?.pointerId === event.pointerId) {
    try {
      documentModel = translateDeckAssembly(moveBoundaryGesture.document, moveBoundaryGesture.boundaryId, { x: raw.x - moveBoundaryGesture.start.x, y: raw.y - moveBoundaryGesture.start.y });
      persist();
      drawCanvasRefresh();
    } catch (error) { message = error.message; updateStatusMessage(); }
    return;
  }
  if (chamferGesture?.pointerId === event.pointerId) {
    updateChamferDraft(raw);
    return;
  }
  if (dimensionLeaderGesture?.pointerId === event.pointerId) {
    documentModel = setDimensionLeaderOffset(dimensionLeaderGesture.document, dimensionLeaderGesture.referenceId, { x: raw.x - dimensionLeaderGesture.anchor.x, y: raw.y - dimensionLeaderGesture.anchor.y });
    persist();
    drawCanvasRefresh();
    return;
  }
  if (mode === 'level-down') {
    levelDownPointer = resolveRailingSnap(raw);
    message = levelDownPointer ? `${levelDownPointer.label}${levelDownDraft.length ? ' · click to add or finish' : ' · click to start'}` : 'Move to an enabled snap target';
    drawCanvasRefresh();
    updateStatusMessage();
    return;
  }
  if (dimensionDragStart?.pointerId === event.pointerId) {
    const dx = raw.x - dimensionDragStart.point.x;
    const dy = raw.y - dimensionDragStart.point.y;
    const moved = Math.hypot(dx, dy) > viewport.width / Math.max(svg.clientWidth, 1) * 2;
    dimensionDragStart.moved ||= moved;
    documentModel = setDimensionOffset(dimensionDragStart.document, selected.id, { x: dimensionDragStart.offset.x + dx, y: dimensionDragStart.offset.y + dy });
    persist();
    drawCanvasRefresh();
    return;
  }
  if (railingGesture?.pointerId === event.pointerId) {
    const endAnchor = resolveRailingSnap(raw);
    if (!endAnchor) {
      railingDraft = { startAnchor: railingGesture.startAnchor, endAnchor: null, geometry: null };
      message = 'Move to an enabled edge, corner, or grid snap';
      drawCanvasRefresh();
      updateStatusMessage();
      return;
    }
    const temporary = {
      type: 'railing-run',
      id: 'railing-preview',
      name: 'Railing preview',
      anchors: { start: railingGesture.startAnchor, end: endAnchor },
      settings: { maxClearSpan: 72, postWidth: 3.5 },
    };
    const geometry = deriveRailingLineGeometry(temporary, railingGesture.startAnchor.point, endAnchor.point);
    railingDraft = { startAnchor: railingGesture.startAnchor, endAnchor, geometry };
    message = `${formatFeetInches(geometry.length)} · ${geometry.sectionCount} sections · ${endAnchor.label}`;
    drawCanvasRefresh();
    updateStatusMessage();
    return;
  }
  if (stairGesture?.pointerId === event.pointerId) {
    const current = boundaryById(stairGesture.boundaryId) ?? boundary();
    let options = deriveStairDragOptions(current, stairGesture.edgeId, raw, stairGesture.width, stairGesture.startOffset);
    const connection = options ? findStairBoundaryConnection(current, stairGesture.edgeId, stairGesture, boundaries(), raw, viewport.width / Math.max(svg.clientWidth, 1) * 20) : null;
    options = mergeStairBoundaryConnection(options, connection, stairGesture.edgeId);
    stairDraft = options
      ? { edgeId: stairGesture.edgeId, ...stairGesture, ...options, dragging: true }
      : { edgeId: stairGesture.edgeId, ...stairGesture, totalRise: 0, totalRun: 0, treadDepth: 0, riserCount: 0, treadCount: 0, dragging: true };
    const stairSnapLabel = stairGesture.snappedStart && stairGesture.snappedEnd ? 'both sides snapped' : stairGesture.snappedStart || stairGesture.snappedEnd ? 'one side snapped' : 'free opening';
    message = options ? connection ? `${formatFeetInches(options.totalRise, .25)} rise · valid landing inside lower deck · release to build` : `${formatFeetInches(options.totalRise, .25)} total rise · ${stairSnapLabel} · release to build` : 'Drag outward from the deck edge';
    drawCanvasRefresh();
    updateStairLiveHud(event);
    updateStatusMessage();
    return;
  }
  if (stairSideGesture?.pointerId === event.pointerId) {
    const gesture = stairSideGesture;
    const sourceBoundary = gesture.editDocument.objects.find((object) => object.type === 'deck-boundary' && object.id === activeBoundaryId);
    const sourceStair = gesture.editDocument.objects.find((object) => object.type === 'stair' && object.id === gesture.stairId);
    if (!sourceBoundary || !sourceStair) return;
    try {
      const snapBoundaries = gesture.editDocument.objects.filter((object) => object.type === 'deck-boundary');
      const resized = setStairSidePosition(sourceBoundary, sourceStair, gesture.side, raw, snapBoundaries);
      let next = upsertObject(gesture.editDocument, markBoundaryEdited(resized.boundary));
      next = upsertObject(next, resized.stair);
      documentModel = next;
      gesture.moved = true;
      const snapLabel = resized.detachedFromNode
        ? ' · side detached from node'
        : resized.detachedFromBoundary
          ? ' · side detached from boundary'
          : resized.snap?.type === 'edge'
            ? ' · side snapped to boundary edge'
            : resized.snap?.type === 'node'
              ? ' · side snapped to node'
              : '';
      message = `${formatFeetInches(resized.stair.dimensions.width)} stair width${snapLabel}`;
      persist();
      drawCanvasRefresh();
      refreshContextPanel();
      updateStatusMessage();
    } catch (error) {
      message = error.message;
      updateStatusMessage();
    }
    return;
  }
  if (draggingEdgeId && edgeDragStart) {
    const original = edgeDragStart.boundary;
    const edgeIndex = original.edges.findIndex((edge) => edge.id === draggingEdgeId);
    const start = original.vertices[edgeIndex];
    const end = original.vertices[(edgeIndex + 1) % original.vertices.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const normal = { x: -(end.y - start.y) / length, y: (end.x - start.x) / length };
    const offset = (raw.x - edgeDragStart.point.x) * normal.x + (raw.y - edgeDragStart.point.y) * normal.y;
    if (Math.abs(offset) > viewport.width / svg.clientWidth * 3) edgeDragStart.moved = true;
    try {
      const moved = offsetEdge(original, draggingEdgeId, offset);
      documentModel = upsertObject(edgeDragStart.document, moved);
      persist();
      drawCanvasRefresh();
    } catch (error) {
      message = error.message;
      updateStatusMessage();
    }
    return;
  }
  if (draggingVertexId && boundary()) {
    const current = boundary();
    const index = current.vertices.findIndex((vertex) => vertex.id === draggingVertexId);
    const anchor = current.vertices[(index - 1 + current.vertices.length) % current.vertices.length];
    const adjacentIds = new Set([draggingVertexId, current.edges[index]?.id, current.edges[(index - 1 + current.edges.length) % current.edges.length]?.id]);
    const snapped = snapForPointer(raw, anchor, [], adjacentIds, event.pointerType);
    const constrainedBoundary = moveVertexWithConstraints(current, draggingVertexId, snapped.point);
    const constrainedPoint = constrainedBoundary.vertices[index];
    const tolerance = viewport.width / Math.max(svg.clientWidth, 1) * 14;
    mergeCandidateId = findAdjacentMergeCandidate(current, draggingVertexId, constrainedPoint, tolerance)?.id ?? null;
    if (mergeCandidateId) message = 'Release to merge neighboring corners';
    documentModel = upsertObject(documentModel, constrainedBoundary);
    persist();
    drawCanvasRefresh();
    return;
  }
  if (mode === 'draw') {
    snapState = snapForPointer(raw, draft[draft.length - 1], [], new Set(), event.pointerType);
    pointerWorld = snapState.point;
    drawCanvasRefresh();
    updateHud(event);
  } else if (mode === 'framing' && framingDraft) {
    /* Without this the rubber-band from the first tap never drew - pointerWorld
       only moved in boundary-draw mode, so the preview condition was never
       true and the second tap landed blind. */
    const snapped = snapForPointer(raw, framingDraft.start, [], new Set(), event.pointerType);
    /* The snap was already being applied - it just was not being SHOWN. Ortho
       and endpoint locks were happening silently, so a run looked freehand
       while the engine was squaring it, and there was no way to tell which. */
    snapState = snapped;
    pointerWorld = snapped.point;
    updateHud(event);
    drawCanvasRefresh();
  } else {
    hideHud();
  }
}

function drawCanvasRefresh() {
  const svg = app.querySelector('.model-canvas');
  svg.innerHTML = '';
  const current = boundary();
  drawCanvas(svg, current, current ? validateDeckBoundary(current) : null);
}

function finishPointerGesture(svg, event) {
  if (event.pointerType === 'touch') {
    const shouldPlace = pendingTouch?.pointerId === event.pointerId && !pendingTouch.moved && !touchGesture;
    const placement = pendingTouch ? { clientX: pendingTouch.x, clientY: pendingTouch.y } : null;
    activeTouches.delete(event.pointerId);
    if (pendingTouch?.pointerId === event.pointerId) pendingTouch = null;
    if (activeTouches.size < 2) touchGesture = null;
    if (shouldPlace && placement) placeDraftPoint(screenToWorld(svg, placement), 'touch');
  }
  if (panGesture) {
    panGesture = null;
    app.querySelector('.model-canvas')?.classList.remove('panning');
  }
  if (catNoteDragStart?.pointerId === event.pointerId) {
    const gesture = catNoteDragStart;
    const finalDocument = documentModel;
    catNoteDragStart = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel') { message = 'CAT Note move canceled'; persist(); render(); }
    else if (gesture.moved) { message = 'CAT Note label repositioned'; commit(finalDocument, 'Move CAT Note label'); }
    else { documentModel = finalDocument; persist(); render(); }
    return;
  }
  if (moveBoundaryGesture?.pointerId === event.pointerId) {
    const gesture = moveBoundaryGesture;
    const finalDocument = documentModel;
    moveBoundaryGesture = null;
    moveBoundaryMode = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel') { message = 'Deck area move canceled'; persist(); render(); }
    else { message = 'Deck area and attached construction moved together'; commit(finalDocument, 'Move complete Deck Boundary assembly'); }
    return;
  }
  if (dimensionLeaderGesture?.pointerId === event.pointerId) {
    const gesture = dimensionLeaderGesture;
    const finalDocument = documentModel;
    dimensionLeaderGesture = null;
    dimensionLeaderMode = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel') {
      message = 'Arrow reposition canceled';
      persist();
      render();
    } else {
      message = 'Dimension arrow repositioned · object relationship preserved';
      commit(finalDocument, 'Reposition dimension arrow');
    }
    return;
  }
  if (chamferGesture?.pointerId === event.pointerId) {
    const gesture = chamferGesture;
    const preview = chamferDraft;
    chamferGesture = null;
    chamferMode = null;
    chamferDraft = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel' || !preview) {
      message = event.type === 'pointercancel' ? 'Chamfer canceled' : 'Drag farther to create a chamfer';
      persist();
      render();
    } else {
      selected = { kind: 'edge', id: preview.chamferEdgeId };
      message = `45° chamfer created · ${formatInches(preview.setback)} setback`;
      commit(upsertObject(documentModel, markBoundaryEdited(preview.boundary)), 'Create 45-degree boundary chamfer');
    }
    return;
  }
  if (dimensionDragStart?.pointerId === event.pointerId) {
    const gesture = dimensionDragStart;
    const finalDocument = documentModel;
    dimensionDragStart = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel') {
      message = 'Dimension move canceled';
      persist();
      render();
    } else if (gesture.moved) {
      message = 'Dimension label repositioned';
      commit(finalDocument, 'Move dimension annotation');
    } else render();
    return;
  }
  if (railingGesture?.pointerId === event.pointerId) {
    const gesture = railingGesture;
    const draftRun = railingDraft;
    railingGesture = null;
    railingDraft = null;
    app.querySelector('.model-canvas')?.classList.remove('railing');
    if (event.type === 'pointercancel' || !draftRun?.geometry || draftRun.geometry.length < 12) {
      message = event.type === 'pointercancel' ? 'Railing placement canceled' : 'Drag at least 12 inches along the edge';
      render();
      return;
    }
    try {
      const railing = createRailingLine(draftRun.startAnchor, draftRun.endAnchor);
      let next = upsertObject(documentModel, railing);
      selected = { kind: 'railing', id: railing.id };
      mode = 'select';
      message = `${formatFeetInches(draftRun.geometry.length)} railing · ${draftRun.geometry.sectionCount} sections added`;
      commit(next, 'Add edge-hosted railing run');
    } catch (error) {
      message = error.message;
      render();
    }
    return;
  }
  if (stairSideGesture?.pointerId === event.pointerId) {
    const gesture = stairSideGesture;
    let finalDocument = documentModel;
    stairSideGesture = null;
    documentModel = gesture.document;
    if (event.type === 'pointercancel' || !gesture.moved) {
      message = event.type === 'pointercancel' ? 'Stair width edit canceled' : 'Stair side selected';
      persist();
      render();
    } else {
      const finalStair = finalDocument.objects.find((object) => object.type === 'stair' && object.id === gesture.stairId);
      const hostBoundary = finalStair ? finalDocument.objects.find((object) => object.type === 'deck-boundary' && object.id === finalStair.host.boundaryId) : null;
      const attachment = finalStair?.sideAttachments?.[gesture.side];
      const targetBoundary = attachment ? finalDocument.objects.find((object) => object.type === 'deck-boundary' && object.id === attachment.boundaryId) : null;
      if (finalStair && hostBoundary && targetBoundary) {
        const connected = materializeStairSideJunction(hostBoundary, targetBoundary, finalStair, gesture.side);
        finalDocument = upsertObject(upsertObject(finalDocument, markBoundaryEdited(connected.boundary)), connected.stair);
      }
      message = attachment ? 'Stair side connected · boundary split into selectable construction segments' : 'Stair width updated · parallel sides preserved';
      commit(finalDocument, 'Resize staircase from side');
    }
    return;
  }
  if (stairGesture?.pointerId === event.pointerId) {
    const gesture = stairGesture;
    const options = stairDraft;
    stairGesture = null;
    app.querySelector('.model-canvas')?.classList.remove('stairing');
    if (event.type === 'pointercancel' || !options?.totalRise || options.totalRun < 10) {
      stairDraft = null;
      message = event.type === 'pointercancel' ? 'Stair placement canceled' : 'Drag to at least 10 inches of total rise';
      render();
      return;
    }
    try {
      const hostBoundary = boundaryById(gesture.boundaryId ?? options.boundaryId) ?? boundary();
      const attached = attachStairToBoundary(hostBoundary, gesture.edgeId, { ...options, edgeId: gesture.edgeId });
      let next = upsertObject(documentModel, markBoundaryEdited(attached.boundary));
      next = upsertObject(next, attached.stair);
      selected = { kind: 'stair', id: attached.stair.id };
      stairDraft = null;
      mode = 'select';
      message = `${attached.stair.dimensions.riserCount} risers · ${attached.stair.dimensions.treadCount} treads · staircase added`;
      commit(next, 'Drag staircase from Deck Boundary');
    } catch (error) {
      stairDraft = null;
      message = error.message;
      render();
    }
    return;
  }
  if (draggingVertexId && dragStartDocument && dragStartDocument !== documentModel) {
    if (mergeCandidateId) {
      if (isVertexReferencedByAttachment(draggingVertexId)) {
        documentModel = dragStartDocument;
        message = 'This corner anchors an attached construction object and cannot merge yet';
        mergeCandidateId = null;
        render();
      } else {
        try {
          const merge = mergeAdjacentVertices(boundary(), draggingVertexId, mergeCandidateId);
          let finalDocument = upsertObject(documentModel, markBoundaryEdited(merge.boundary));
          finalDocument = remapEdgeReferences(finalDocument, merge.removedEdgeId, merge.survivingEdgeId);
          documentModel = dragStartDocument;
          selected = { kind: 'vertex', id: merge.targetVertexId };
          message = 'Corners merged · redundant edge removed · properties preserved';
          mergeCandidateId = null;
          commit(finalDocument, 'Merge boundary corners');
        } catch (error) {
          documentModel = dragStartDocument;
          message = error.message;
          mergeCandidateId = null;
          render();
        }
      }
    } else {
      const editedBoundary = markBoundaryEdited(boundary());
      const finalDocument = upsertObject(documentModel, editedBoundary);
      documentModel = dragStartDocument;
      message = 'Boundary corner moved';
      commit(finalDocument, 'Move boundary corner');
    }
  }
  if (draggingEdgeId && edgeDragStart) {
    if (edgeDragStart.moved) {
      const finalDocument = upsertObject(documentModel, markBoundaryEdited(boundary()));
      documentModel = edgeDragStart.document;
      message = 'Construction edge moved';
      commit(finalDocument, 'Move boundary edge');
    } else render();
  }
  draggingVertexId = null;
  dragStartDocument = null;
  draggingEdgeId = null;
  edgeDragStart = null;
  mergeCandidateId = null;
}

function isVertexReferencedByAttachment(vertexId) {
  if (documentModel.objects.some((object) => object.type === 'stair' && Object.values(object.anchors ?? {}).includes(vertexId))) return true;
  if (documentModel.objects.some((object) => object.type === 'railing-run' && [object.anchors?.start?.vertexId, object.anchors?.end?.vertexId].includes(vertexId))) return true;
  if (documentModel.objects.some((object) => object.type === 'level-down' && object.vertices?.some((vertex) => vertex.anchor?.vertexId === vertexId))) return true;
  const current = boundary();
  const vertexIndex = current?.vertices.findIndex((vertex) => vertex.id === vertexId) ?? -1;
  if (vertexIndex < 0) return false;
  if (current.vertices[vertexIndex]?.junction) return true;
  const adjacentEdgeIds = new Set([current.edges[vertexIndex]?.id, current.edges[(vertexIndex - 1 + current.edges.length) % current.edges.length]?.id]);
  return documentModel.objects.some((object) => object.type === 'railing-run' && [object.host?.edgeId, object.anchors?.start?.edgeId, object.anchors?.end?.edgeId].some((edgeId) => adjacentEdgeIds.has(edgeId)));
}

function remapEdgeReferences(document, removedEdgeId, survivingEdgeId) {
  return {
    ...document,
    objects: document.objects.map((object) => {
      if (object.type !== 'stair') return object;
      return {
        ...object,
        host: object.host.sourceEdgeId === removedEdgeId ? { ...object.host, sourceEdgeId: survivingEdgeId } : object.host,
        generatedEdgeIds: object.generatedEdgeIds?.map((id) => id === removedEdgeId ? survivingEdgeId : id),
      };
    }),
  };
}

function commitSelectedEdgeProperties(patch, label) {
  if (selected.kind === 'edge') {
    commitBoundary(markBoundaryEdited(updateEdgeProperties(boundary(), selected.id, patch)), label);
    return;
  }
  if (selected.kind === 'stair-edge') {
    const reference = findStairInterfaceByEdgeId(selected.id);
    if (reference) commit(upsertObject(documentModel, updateStairInterfaceEdgeProperties(reference.stair, patch)), label);
  }
}

function updateRailingHostAttachment(document, railing, attach) {
  const host = railing.host;
  if (!host) return document;
  if (host.edgeKind === 'stair-interface-edge') {
    const stair = document.objects.find((object) => object.type === 'stair' && object.id === host.ownerId);
    if (!stair) return document;
    const edge = getStairInterfaceEdge(stair);
    const currentIds = edge.properties.attachments.railingIds ?? [];
    const railingIds = attach ? [...new Set([...currentIds, railing.id])] : currentIds.filter((id) => id !== railing.id);
    return upsertObject(document, updateStairInterfaceEdgeProperties(stair, { attachments: { railingIds } }));
  }
  const current = document.objects.find((object) => object.type === 'deck-boundary' && object.id === host.boundaryId);
  const edge = current?.edges.find((entry) => entry.id === host.edgeId);
  if (!current || !edge) return document;
  const currentIds = normalizeBoundaryEdge(edge).properties.attachments.railingIds ?? [];
  const railingIds = attach ? [...new Set([...currentIds, railing.id])] : currentIds.filter((id) => id !== railing.id);
  return upsertObject(document, markBoundaryEdited(updateEdgeProperties(current, host.edgeId, { attachments: { railingIds } })));
}

function edgeHasRailingDependency(edgeId) {
  return documentModel.objects.some((object) => object.type === 'railing-run'
    && [object.host?.edgeId, object.anchors?.start?.edgeId, object.anchors?.end?.edgeId].includes(edgeId));
}

function removeSelectedRailing() {
  const railing = documentModel.objects.find((object) => object.type === 'railing-run' && object.id === selected.id);
  if (!railing) return;
  let next = updateRailingHostAttachment(documentModel, railing, false);
  next = { ...next, objects: next.objects.filter((object) => object.id !== railing.id) };
  selected = { kind: null, id: null };
  message = 'Railing run removed';
  commit(next, 'Remove railing run');
}

function selectedStairObject() {
  if (selected.kind === 'stair') return documentModel.objects.find((object) => object.type === 'stair' && object.id === selected.id) ?? null;
  if (selected.kind === 'dimension') return findStairByDimensionId(selected.id);
  if (selected.kind === 'stair-side') return findStairSide(selected.id)?.stair ?? null;
  return null;
}

function removeSelectedStair() {
  let stair = selectedStairObject();
  if (!stair) return;
  try {
    let next = documentModel;
    for (const side of ['start', 'end']) {
      const attachment = stair.sideAttachments?.[side];
      const target = attachment ? next.objects.find((object) => object.type === 'deck-boundary' && object.id === attachment.boundaryId) : null;
      if (!target || !attachment?.junction) continue;
      const disconnected = removeStairSideJunction(target, stair, side);
      stair = disconnected.stair;
      next = upsertObject(upsertObject(next, markBoundaryEdited(disconnected.boundary)), stair);
    }
    const host = next.objects.find((object) => object.type === 'deck-boundary' && object.id === stair.host.boundaryId);
    if (!host) { message = 'Stair host Deck Boundary was not found'; render(); return; }
    const restored = markBoundaryEdited(detachStairFromBoundary(host, stair));
    const interfaceId = getStairInterfaceEdge(stair).id;
    next = upsertObject(next, restored);
    next = {
      ...next,
      objects: next.objects.filter((object) => object.id !== stair.id && !(object.type === 'railing-run' && (object.host?.ownerId === stair.id || [object.host?.edgeId, object.anchors?.start?.edgeId, object.anchors?.end?.edgeId].includes(interfaceId)))),
    };
    selected = { kind: null, id: null };
    message = 'Stair removed · Deck Boundary restored';
    commit(next, 'Delete staircase');
  } catch (error) { message = error.message; render(); }
}

function adjustSelectedRailingPanels(delta) {
  const geometry = findRailingGeometry(selected.id);
  if (!geometry) return;
  const nextCount = Math.max(geometry.minimumSectionCount, geometry.sectionCount + delta);
  if (nextCount === geometry.sectionCount) {
    message = 'This railing is already at the minimum safe panel count';
    render();
    return;
  }
  const updated = updateRailingSettings(geometry.railing, { sectionCountOverride: nextCount });
  message = `${nextCount} panels · ${nextCount + 1} posts`;
  commit(upsertObject(documentModel, updated), delta > 0 ? 'Add railing panel' : 'Remove railing panel');
}

function toggleSelectedDimension() {
  const referenceId = selected.id;
  if (!referenceId) return;
  const visible = getDimensionLayer(documentModel).visible && isDimensionReferenceVisible(documentModel, referenceId);
  message = `Dimension ${visible ? 'removed' : 'added'}`;
  let next = setDimensionReferenceVisibility(documentModel, referenceId, !visible);
  if (!visible && !getDimensionLayer(next).visible) next = setDimensionLayerVisibility(next, true);
  if (selected.kind === 'dimension' && visible) selected = { kind: null, id: null };
  commit(next, visible ? 'Hide selected dimension' : 'Show selected dimension');
}

function breakSelectedEdge(segmentCount) {
  if (selected.kind !== 'edge' || edgeHasRailingDependency(selected.id) || isEdgeLocked(boundary(), selected.id)) return;
  const divided = markBoundaryEdited(splitEdgeIntoSegments(boundary(), selected.id, segmentCount));
  message = `Construction edge divided into ${segmentCount} equal segments`;
  commitBoundary(divided, `Divide construction edge into ${segmentCount} segments`);
}

function breakSelectedLevelDown(segmentCount) {
  if (selected.kind !== 'level-down') return;
  const reference = findLevelDownSegment(selected.id);
  if (!reference) return;
  const divided = splitLevelDownSegment(reference.levelDown, selected.id, segmentCount);
  message = `Level Down section divided into ${segmentCount} equal sections`;
  commit(upsertObject(documentModel, divided), `Divide Level Down section into ${segmentCount}`);
}

function resolveRailingSnap(raw) {
  const settings = getSnapSettings(documentModel);
  const tolerance = viewport.width / Math.max(app.querySelector('.model-canvas')?.clientWidth ?? 1000, 1) * 16;
  const targets = { vertices: [], edges: [] };
  boundaries().forEach((current) => {
    targets.vertices.push(...current.vertices.map((vertex) => ({ boundaryId: current.id, vertexId: vertex.id, point: { x: vertex.x, y: vertex.y } })));
    targets.edges.push(...current.edges.map((edge, index) => ({ boundaryId: current.id, edgeId: edge.id, edgeKind: 'boundary-edge', start: current.vertices[index], end: current.vertices[(index + 1) % current.vertices.length] })));
    documentModel.objects.filter((object) => object.type === 'stair' && object.host.boundaryId === current.id).forEach((stair) => {
      const edge = getStairInterfaceEdge(stair);
      const reference = resolveRailingHostByEdgeId(edge.id, 'stair-interface-edge');
      if (reference?.start && reference?.end) targets.edges.push({ boundaryId: current.id, edgeId: edge.id, edgeKind: 'stair-interface-edge', ownerId: stair.id, start: reference.start, end: reference.end, label: 'Stair interface snap' });
    });
  });
  return resolveRailingEndpointSnap(raw, targets, {
    tolerance,
    edges: settings.edges,
    grid: settings.grid,
    gridSpacing: gridSetting === 'auto' ? .5 : Number(gridSetting),
  });
}

function snapForPointer(raw, anchor, extraVertices = [], excludedIds = new Set(), pointerType = 'mouse') {
  const catSnapObjects = getCatConstructionLayer(documentModel).visible ? getCatSnapObjects(documentModel) : [];
  const objects = [...boundaries(), ...catSnapObjects];
  const settings = getSnapSettings(documentModel);
  const draftObject = { vertices: [...draft, ...extraVertices], edges: [] };
  const worldPerPixel = viewport.width / Math.max(app.querySelector('.model-canvas')?.clientWidth ?? 1000, 1);
  const isTouch = pointerType === 'touch';
  const tolerance = worldPerPixel * (isTouch ? 18 : 10);
  return resolveSnap(raw, {
    anchor,
    tolerance,
    inferenceTolerance: worldPerPixel * (isTouch ? 20 : 12),
    inferenceReleaseMultiplier: 1.45,
    maxInferenceReferenceDistance: Math.hypot(viewport.width, viewport.height) * .8,
    angleToleranceRadians: (isTouch ? 5 : 4) * Math.PI / 180,
    angleIncrementRadians: Math.PI / 8,
    grid: gridSetting === 'auto' ? .5 : Number(gridSetting),
    gridEnabled: settings.grid,
    edgesEnabled: settings.edges,
    nodeInference: settings.nodeInference,
    diagonalInference: settings.diagonalInference,
    anchorReferenceId: anchor?.id ?? null,
    preferredReferenceId: snapState?.referenceId ?? null,
    targets: collectSnapTargets([...objects, draftObject]).filter((target) => !excludedIds.has(target.referenceId)),
  });
}

function zoomAtPointer(svg, event) {
  event.preventDefault();
  const anchor = screenToWorld(svg, event);
  const target = zoomViewport(viewport, anchor, Math.exp(event.deltaY * .0012));
  animateViewport(target);
  hideHud();
}

function animateViewport(target) {
  const animationId = ++viewportAnimation;
  const start = { ...viewport };
  const startedAt = performance.now();
  const duration = 130;
  const frame = (now) => {
    if (animationId !== viewportAnimation) return;
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    viewport = Object.fromEntries(Object.keys(start).map((key) => [key, start[key] + (target[key] - start[key]) * eased]));
    drawCanvasRefresh();
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function fitProject(svg = app.querySelector('.model-canvas')) {
  const catPoints = [
    ...getCatLines(documentModel).flatMap((line) => line.vertices),
    ...getCatMeasurements(documentModel).flatMap((measurement) => [measurement.start, measurement.end]),
    ...getCatNotes(documentModel).flatMap((note) => [note.anchor, { x: note.anchor.x + note.labelOffset.x, y: note.anchor.y + note.labelOffset.y }]),
  ];
  const points = [...boundaries().flatMap((entry) => entry.vertices), ...catPoints, ...draft];
  const aspect = (svg?.clientWidth || 1000) / (svg?.clientHeight || 700);
  animateViewport(fitViewport(points, aspect));
  message = points.length ? 'Project fitted to workspace' : 'Workspace reset';
}

function canvasDoubleClick(svg, event) {
  const dimensionId = event.target.dataset.dimensionId;
  if (dimensionId) {
    event.preventDefault();
    editDimensionReference(dimensionId);
    return;
  }
  edgeDoubleClick(svg, event);
}

function editDimensionReference(referenceId) {
  const reference = resolveDimensionReference(referenceId);
  if (!reference) return;
  activateBoundary(reference.boundary?.id ?? boundaryForReference(referenceId)?.id);
  if (reference.kind === 'area') {
    selected = { kind: 'dimension', id: referenceId };
    message = 'Deck area selected · choose a construction action';
    render();
    return;
  }
  if (reference.kind === 'level-down-area') {
    selected = { kind: 'dimension', id: referenceId };
    message = 'Lowered area selected · edit its construction properties';
    render();
    return;
  }
  if (reference.kind === 'railing') {
    selected = { kind: 'railing', id: reference.railing.id };
    message = 'Railing measurement selected · drag a new run to change its extents';
    render();
    return;
  }
  if (reference.kind === 'stair') {
    selected = { kind: 'stair', id: reference.stair.id };
    message = 'Stair selected · edit rise, risers, treads, or width';
    render();
    return;
  }
  if (reference.kind === 'stair-interface') {
    selected = { kind: 'stair-edge', id: reference.edge.id };
    message = 'Edit the exact stair opening width';
    render();
    requestAnimationFrame(() => app.querySelector('#stair-interface-width')?.select());
    return;
  }
  if (reference.stair) {
    selected = { kind: 'stair', id: reference.stair.id };
    message = 'This dimension belongs to generated Stair geometry';
    render();
    return;
  }
  selected = { kind: 'edge', id: reference.edge.id };
  message = 'Edit the exact construction dimension';
  render();
  requestAnimationFrame(() => app.querySelector('#edge-length')?.select());
}

function edgeDoubleClick(svg, event) {
  if (mode !== 'select' || !event.target.dataset.edgeId) return;
  const current = boundary();
  const edgeId = event.target.dataset.edgeId;
  if (isEdgeLocked(current, edgeId)) { message = 'Unlock this construction edge before adding a node'; render(); return; }
  if (edgeHasRailingDependency(edgeId)) {
    message = 'Remove the hosted railing before splitting this construction edge';
    render();
    return;
  }
  const edgeIndex = current.edges.findIndex((edge) => edge.id === edgeId);
  const raw = screenToWorld(svg, event);
  const projected = nearestPointOnSegment(raw, current.vertices[edgeIndex], current.vertices[(edgeIndex + 1) % current.vertices.length]);
  commitBoundary(markBoundaryEdited(insertVertex(current, edgeId, projected.point)), 'Add boundary corner');
  message = 'Corner added';
}

function completeDraft() {
  if (draft.length < 3) return;
  const nextBoundary = createDeckBoundary(draft);
  const validation = validateDeckBoundary(nextBoundary);
  if (!validation.valid) { message = validation.issues[0].message; render(); return; }
  commitBoundary(nextBoundary, 'Create deck boundary');
  selected = { kind: 'dimension', id: areaDimensionId(nextBoundary) };
  draft = [];
  pointerWorld = null;
  numericBuffer = '';
  mode = 'select';
  message = 'Deck boundary created';
  render();
}

function toggleSelectedEdgeOrientation(type) {
  if (selected.kind !== 'edge') return;
  const current = boundary();
  const active = getEdgeOrientationConstraint(current, selected.id);
  try {
    if (active?.type === type) {
      message = 'Angle constraint removed · edge is free';
      commitBoundary(markBoundaryEdited(clearEdgeOrientationConstraint(current, selected.id)), 'Remove edge orientation constraint');
      return;
    }
    const next = setEdgeOrientationConstraint(current, selected.id, type);
    const applied = getEdgeOrientationConstraint(next, selected.id);
    message = describeOrientationConstraint(applied);
    commitBoundary(markBoundaryEdited(next), type === 'fixed-angle' ? 'Lock edge angle' : `Constrain edge ${type}`);
  } catch (error) {
    message = error.message;
    render();
  }
}

function handleAction(action, source = null) {
  if (action === 'toggle-project-menu') { projectMenuOpen = !projectMenuOpen; exportMenuOpen = false; pendingProjectDeleteId = null; render(); return; }
  if (action === 'close-project-menu') { projectMenuOpen = false; pendingProjectDeleteId = null; render(); return; }
  if (action === 'toggle-export-menu') { exportMenuOpen = !exportMenuOpen; projectMenuOpen = false; pendingProjectDeleteId = null; render(); return; }
  if (action === 'open-takeoff') { takeoffOpen = true; exportMenuOpen = false; projectMenuOpen = false; takeoffAddCategory = null; message = 'Editable project takeoff generated'; render(); return; }
  if (action === 'set-takeoff-view') {
    takeoffViewMode = source?.dataset.view === 'consolidated' ? 'consolidated' : 'detailed';
    takeoffNoteOpen = null;   // a note belongs to a modeled line, not to a sum
    message = takeoffViewMode === 'consolidated'
      ? 'Purchase list consolidated by material and stock size'
      : 'Detailed construction takeoff restored';
    render();
    return;
  }
  if (action === 'toggle-takeoff-note') {
    const id = source?.dataset.lineId;
    takeoffNoteOpen = takeoffNoteOpen === id ? null : id;
    render();
    return;
  }
  if (action === 'toggle-takeoff-settings') { takeoffSettingsOpen = !takeoffSettingsOpen; render(); return; }
  if (action === 'close-takeoff') { takeoffOpen = false; takeoffAddCategory = null; takeoffSettingsOpen = false; message = 'Takeoff saved with this project'; render(); return; }
  if (action === 'toggle-takeoff-category') {
    const category = source?.dataset.category;
    if (!category) return;
    if (takeoffExpanded.has(category)) takeoffExpanded.delete(category); else takeoffExpanded.add(category);
    render(); return;
  }
  if (action === 'add-takeoff-line') { takeoffAddCategory = source?.dataset.category ?? 'custom'; takeoffExpanded.add(takeoffAddCategory); render(); requestAnimationFrame(() => app.querySelector('#takeoff-new-description')?.focus()); return; }
  if (action === 'cancel-takeoff-line') { takeoffAddCategory = null; render(); return; }
  if (action === 'save-takeoff-line') {
    try {
      const next = addManualTakeoffLine(documentModel, {
        category: source?.dataset.category,
        description: app.querySelector('#takeoff-new-description')?.value,
        specification: app.querySelector('#takeoff-new-specification')?.value,
        quantity: app.querySelector('#takeoff-new-quantity')?.value,
        unit: app.querySelector('#takeoff-new-unit')?.value,
        unitPrice: app.querySelector('#takeoff-new-price')?.value,
      });
      takeoffAddCategory = null;
      message = 'Manual material added to Takeoff';
      commit(next, 'Add manual takeoff material');
    } catch (error) { message = error.message; render(); }
    return;
  }
  if (action === 'delete-takeoff-line') { message = 'Manual material removed'; commit(removeManualTakeoffLine(documentModel, source?.dataset.lineId), 'Remove manual takeoff material'); return; }
  if (action === 'reset-takeoff-line') { message = 'Calculated material quantity restored'; commit(resetTakeoffLine(documentModel, source?.dataset.lineId), 'Reset takeoff material calculation'); return; }
  if (action === 'download-takeoff-json') { downloadJson(createTakeoffExport(documentModel, { ...takeoffContext(), includePrices: true, includeNotes: takeoffExportNotes }), 'takeoff'); message = 'Editable Takeoff JSON downloaded'; render(); return; }
  if (action === 'print-takeoff-quote') { printTakeoff(false); return; }
  if (action === 'print-takeoff-priced') { printTakeoff(true); return; }
  if (action === 'rename-project') {
    const name = app.querySelector('#project-name-input')?.value.trim();
    if (!name) { message = 'Enter a project name'; render(); return; }
    documentModel = { ...documentModel, name, updatedAt: new Date().toISOString() };
    persist();
    projectMenuOpen = true;
    message = 'Project name updated';
    render();
    return;
  }
  if (action === 'new-project') {
    persist();
    const next = createProjectDocument({ name: `Deck project ${projectLibrary.projects.length + 1}` });
    projectLibrary = upsertLibraryProject(projectLibrary, next);
    documentModel = next;
    history = new CommandStack();
    resetProjectWorkspaceState();
    projectMenuOpen = true;
    persist();
    message = 'New independent project created';
    render();
    return;
  }
  if (action === 'open-project') {
    const projectId = source?.dataset.projectId;
    if (!projectId || projectId === documentModel.id) return;
    persist();
    projectLibrary = activateLibraryProject(projectLibrary, projectId);
    documentModel = getActiveProject(projectLibrary);
    history = new CommandStack();
    resetProjectWorkspaceState();
    projectMenuOpen = false;
    persist();
    message = `${documentModel.name} opened`;
    render();
    return;
  }
  if (action === 'request-delete-project') { pendingProjectDeleteId = source?.dataset.projectId ?? null; projectMenuOpen = true; render(); return; }
  if (action === 'cancel-delete-project') { pendingProjectDeleteId = null; projectMenuOpen = true; render(); return; }
  if (action === 'confirm-delete-project') {
    const projectId = source?.dataset.projectId;
    if (!projectId) return;
    projectLibrary = removeLibraryProject(projectLibrary, projectId);
    if (!projectLibrary.projects.length) projectLibrary = createProjectLibrary(createProjectDocument({ name: 'New deck project' }));
    documentModel = getActiveProject(projectLibrary);
    history = new CommandStack();
    resetProjectWorkspaceState();
    projectMenuOpen = true;
    pendingProjectDeleteId = null;
    persist();
    message = 'Local project deleted';
    render();
    return;
  }
  if (action.startsWith('framing-tool-')) {
    framingTool = action.slice('framing-tool-'.length);
    framingDraft = null;
    render();
    return;
  }
  if (action.startsWith('framing-spacing-')) {
    framingSpacing = Number(action.slice('framing-spacing-'.length)) || DEFAULT_SPACING_INCHES;
    render();
    return;
  }
  if (action === 'close-framing-tool') { framingDraft = null; setMode('select'); return; }
  if (action === 'cat-tool-count') { catTool = 'count'; catDraft = null; render(); return; }
  if (action === 'apply-count-label') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    const input = app.querySelector('#count-label');
    if (!object || !input) return;
    const label = String(input.value ?? '').trim() || 'Count';
    lastCountLabel = label;
    message = `Counting "${label}" now`;
    commit(upsertObject(documentModel, { ...object, label, name: label }), 'Rename count pin');
    return;
  }
  if (action === 'apply-gate-width') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    const input = app.querySelector('#gate-width');
    if (!object || !input) return;
    const width = parseConstructionLength(input.value);
    if (!Number.isFinite(width) || width <= 0) { message = 'Enter a valid opening width'; render(); return; }
    message = 'Gate width updated';
    commit(upsertObject(documentModel, { ...object, dimensions: { ...object.dimensions, widthInches: width } }), 'Resize gate');
    return;
  }
  if (action === 'apply-deck-level' || action === 'deck-level-standard'
      || action === 'deck-level-second-floor' || action === 'deck-level-clear') {
    if (action === 'deck-level-clear') {
      message = 'Deck level cleared \u2014 no framing is laid out';
      commit(setDeckLevelInches(documentModel, null), 'Clear primary deck level');
      return;
    }
    const inches = action === 'deck-level-standard' ? 48
      : action === 'deck-level-second-floor' ? SECOND_FLOOR_LEVEL_INCHES
      : parseConstructionLength(app.querySelector('#primary-deck-level')?.value);
    if (!Number.isFinite(inches) || inches <= 0) {
      message = 'Enter a height such as 4\', 48 in, or 1220 mm';
      render();
      return;
    }
    message = isSecondFloor(inches)
      ? `Primary deck level ${formatFeetInches(inches)} \u2014 second floor, so you set the framing`
      : `Primary deck level ${formatFeetInches(inches)} \u2014 DCR standard framing is in force`;
    commit(setDeckLevelInches(documentModel, inches), 'Set primary deck level');
    return;
  }
  if (action === 'set-framing-system') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    if (!object) return;
    const system = source?.dataset.system === 'flush' ? 'flush' : 'bottom';
    message = system === 'flush' ? 'Joists will hang off this beam' : 'Joists will bear on top of this beam';
    commit(upsertObject(documentModel, { ...object, settings: { ...object.settings, framingSystem: system } }), 'Set framing system');
    return;
  }
  if (action === 'apply-beam-posts') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    const input = app.querySelector('#beam-post-count');
    if (!object || !input) return;
    const wanted = Math.floor(Number(input.value));
    if (!Number.isFinite(wanted) || wanted < 2) { message = 'A beam needs at least two posts'; render(); return; }
    const next = upsertObject(documentModel, { ...object, settings: { ...object.settings, postCountOverride: wanted } });
    // the derivation clamps to the standard, so report what actually happened
    const applied = deriveBeamGeometry(next.objects.find((entry) => entry.id === object.id),
      getTakeoffState(documentModel).settings);
    message = applied && applied.postCount > wanted
      ? `Kept at ${applied.postCount} posts \u2014 fewer would exceed the span limit`
      : `Beam laid out with ${applied ? applied.postCount : wanted} posts`;
    commit(next, 'Set beam post count');
    return;
  }
  if (action === 'apply-framing-size') {
    const object = documentModel.objects.find((entry) => entry.id === selected.id);
    const input = app.querySelector('#framing-size');
    if (!object || !input) return;
    message = 'Size label updated';
    commit(upsertObject(documentModel, { ...object, size: String(input.value ?? '').trim() }), 'Set framing size');
    return;
  }
  if (action === 'add-gate-on-railing') {
    /* Placed at the midpoint of the selected run: always ON the run, so the
       width nets out of the right railing without asking for a second tap.
       Field-adjust the width in the panel afterwards if 36 inches is wrong. */
    const geometry = selected.kind === 'railing' ? findRailingGeometry(selected.id) : null;
    if (!geometry?.start || !geometry?.end) return;
    const gate = createGate({
      at: { x: (geometry.start.x + geometry.end.x) / 2, y: (geometry.start.y + geometry.end.y) / 2 },
      angle: Math.atan2(geometry.end.y - geometry.start.y, geometry.end.x - geometry.start.x),
    });
    selected = { kind: 'framing', id: gate.id };
    message = 'Gate placed mid-run · its 36″ comes out of this railing';
    commit(upsertObject(documentModel, gate), 'Add gate');
    return;
  }
  if (action === 'delete-framing') {
    if (selected.kind !== 'framing') return;
    const target = documentModel.objects.find((object) => object.id === selected.id);
    if (!target) return;
    const label = target.type === 'joist' ? 'joist' : target.type === 'beam' ? 'beam'
      : target.type === 'pillar' ? 'pillar' : target.type === 'post' ? 'post'
      : target.type === 'gate' ? 'gate' : target.type === 'count-marker' ? 'count pin' : 'member';
    selected = { kind: null, id: null };
    message = `The ${label} was removed`;
    commit({ ...documentModel, objects: documentModel.objects.filter((object) => object.id !== target.id) },
      `Delete ${label}`);
    return;
  }
  if (action === 'framing-copies-less' || action === 'framing-copies-more') {
    const step = action === 'framing-copies-more' ? 1 : -1;
    framingCopies = Math.max(1, Math.min(MAX_COPIES, framingCopies + step));
    render();
    return;
  }
  if (action === 'framing-array') {
    if (selected.kind !== 'framing') return;
    const before = documentModel.objects.length;
    const next = arrayObject(documentModel, selected.id, {
      spacingInches: framingSpacing, count: framingCopies, direction: 'perpendicular',
    });
    if (next.objects.length === before) {
      message = 'That repeat was refused — check the spacing and the count';
      render();
      return;
    }
    message = `Repeated ${framingCopies}× at ${framingSpacing}″ on centre`;
    // one commit for the whole array, so undo takes the whole array back
    commit(next, `Repeat at ${framingSpacing}\u2033 on centre`);
    return;
  }
  if (action === 'toggle-bill-area') {
    /* The old tool decided what to bill from a shape's LABEL - tag it "Landing"
       and it counted, tag it "Roof" and it dropped out. That was the rep's only
       control over the price. CME counts every boundary, so without this switch
       the control disappears silently. */
    const target = boundary();
    if (!target) return;
    const excluded = !target.metadata?.excludeFromDeckArea;
    message = excluded ? 'This area is no longer billed' : 'This area is billed again';
    commit(upsertObject(documentModel, {
      ...target,
      metadata: { ...target.metadata, excludeFromDeckArea: excluded },
    }), excluded ? 'Exclude area from billing' : 'Include area in billing');
    return;
  }
  if (action === 'save-step-one') { saveToStepOne(); return; }
  if (action === 'download-step-one-json') { downloadStepOneJson(); return; }
  if (action === 'export-pdf') { exportProjectPdf(); return; }
  if (action === 'clear-selection') { selected = { kind: null, id: null }; dimensionLeaderMode = null; dimensionLeaderGesture = null; chamferMode = null; chamferGesture = null; chamferDraft = null; moveBoundaryMode = null; moveBoundaryGesture = null; boardingDirectionMode = null; pendingDeckDeleteId = null; message = 'Ready'; render(); }
  if (action === 'add-deck-boundary') {
    mode = 'draw'; draft = []; pointerWorld = null; selected = { kind: null, id: null };
    message = 'Draw the first corner of the new Deck Boundary';
    render();
  }
  if (action === 'apply-boundary-level' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    const level = parseConstructionLength(app.querySelector('#boundary-level-down')?.value);
    if (reference?.kind !== 'area' || level === null) { message = 'Enter a valid down level such as 18 in'; render(); }
    else {
      message = `Local deck set ${formatInches(level)} below the project datum`;
      const leveled = markBoundaryEdited(setBoundaryLevelDown(reference.boundary, level));
      commit(synchronizeConnectedStairLevels(upsertObject(documentModel, leveled)), 'Set Deck Boundary down level');
    }
  }
  if (action === 'move-deck-area' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind !== 'area') return;
    moveBoundaryMode = { boundaryId: reference.boundary.id };
    message = 'Move Deck Area active · drag anywhere to reposition the complete assembly';
    render();
  }
  if (action === 'set-board-direction' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind !== 'area') return;
    boardingDirectionMode = { boundaryId: reference.boundary.id };
    moveBoundaryMode = null;
    pendingDeckDeleteId = null;
    message = 'Board direction active · touch any construction line';
    render();
  }
  if (action === 'rotate-board-direction' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind !== 'area' || !getDeckBoarding(reference.boundary)) return;
    message = 'Deck board direction rotated 90 degrees';
    commit(upsertObject(documentModel, markBoundaryEdited(rotateDeckBoardingDirection(reference.boundary))), 'Rotate deck board direction');
  }
  if (action === 'clear-board-direction' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind !== 'area') return;
    boardingDirectionMode = null;
    message = 'Deck board pattern removed';
    commit(upsertObject(documentModel, markBoundaryEdited(clearDeckBoardingDirection(reference.boundary))), 'Clear deck board direction');
  }
  if (action === 'request-delete-deck' && selected.kind === 'dimension') {
    const reference = resolveDimensionReference(selected.id);
    if (reference?.kind !== 'area') return;
    pendingDeckDeleteId = reference.boundary.id;
    boardingDirectionMode = null;
    message = 'Review the complete deck deletion before confirming';
    render();
  }
  if (action === 'cancel-delete-deck') {
    pendingDeckDeleteId = null;
    message = 'Deck area kept';
    render();
  }
  if (action === 'confirm-delete-deck' && pendingDeckDeleteId) {
    try {
      const deletedBoundaryId = pendingDeckDeleteId;
      const result = deleteDeckAssembly(documentModel, deletedBoundaryId);
      const remaining = result.document.objects.filter((object) => object.type === 'deck-boundary');
      pendingDeckDeleteId = null;
      boardingDirectionMode = null;
      activeBoundaryId = remaining[0]?.id ?? null;
      selected = { kind: null, id: null };
      mode = remaining.length ? 'select' : 'draw';
      const removedObjects = result.removed.stairCount + result.removed.railingCount + result.removed.levelDownCount;
      message = remaining.length ? `Deck area deleted${removedObjects ? ` with ${removedObjects} attached object${removedObjects === 1 ? '' : 's'}` : ''}` : 'Deck area deleted · draw a new boundary when ready';
      commit(result.document, 'Delete complete Deck Boundary assembly');
    } catch (error) {
      pendingDeckDeleteId = null;
      message = error.message;
      render();
    }
  }
  if (action === 'lock-edge' && selected.kind === 'edge') {
    message = 'Construction edge locked · position and length protected';
    commitBoundary(markBoundaryEdited(setEdgeLocked(boundary(), selected.id, true)), 'Lock construction edge');
  }
  if (action === 'unlock-edge' && selected.kind === 'edge') {
    message = 'Construction edge unlocked';
    commitBoundary(markBoundaryEdited(setEdgeLocked(boundary(), selected.id, false)), 'Unlock construction edge');
  }
  if (action === 'lock-vertex' && selected.kind === 'vertex') {
    message = 'Boundary node locked in place';
    commitBoundary(markBoundaryEdited(setVertexLocked(boundary(), selected.id, true)), 'Lock boundary node');
  }
  if (action === 'unlock-vertex' && selected.kind === 'vertex') {
    message = 'Boundary node unlocked';
    commitBoundary(markBoundaryEdited(setVertexLocked(boundary(), selected.id, false)), 'Unlock boundary node');
  }
  if (action === 'start-45-chamfer' && selected.kind === 'vertex') {
    if (isVertexReferencedByAttachment(selected.id)) { message = 'This node anchors another construction object and cannot be chamfered'; render(); return; }
    chamferMode = { vertexId: selected.id };
    chamferGesture = null;
    chamferDraft = null;
    message = '45° Chamfer active · drag anywhere to set the setback';
    render();
  }
  if (action === 'add-railing-panel' && selected.kind === 'railing') adjustSelectedRailingPanels(1);
  if (action === 'remove-railing-panel' && selected.kind === 'railing') adjustSelectedRailingPanels(-1);
  if (action === 'toggle-decking') {
    const visible = !getDeckingLayer(documentModel).visible;
    message = `Decking layer ${visible ? 'shown' : 'hidden'}`;
    commit(setDeckingLayerVisibility(documentModel, visible), 'Toggle Decking layer');
  }
  if (action === 'toggle-selected-dimension' && ['edge', 'stair-edge', 'dimension'].includes(selected.kind)) toggleSelectedDimension();
  if (action === 'reposition-dimension-arrow' && ['edge', 'stair-edge', 'dimension'].includes(selected.kind)) {
    const referenceId = selected.id;
    let next = setDimensionReferenceVisibility(documentModel, referenceId, true);
    if (!getDimensionLayer(next).visible) next = setDimensionLayerVisibility(next, true);
    documentModel = next;
    persist();
    dimensionLeaderMode = { referenceId };
    message = 'Arrow tip is active · touch or drag anywhere to reposition it';
    render();
  }
  if (action === 'reset-dimension-arrow' && selected.kind === 'dimension') {
    dimensionLeaderMode = null;
    message = 'Dimension arrow returned to its object';
    commit(setDimensionLeaderOffset(documentModel, selected.id, { x: 0, y: 0 }), 'Reset dimension arrow');
  }
  if (action === 'break-edge-2') breakSelectedEdge(2);
  if (action === 'break-edge-3') breakSelectedEdge(3);
  if (action === 'quick-house-attachment' && selected.kind === 'edge') {
    const edge = boundary().edges.find((entry) => entry.id === selected.id);
    if (edge) {
      const role = edge.role === 'house' ? 'open' : 'house';
      message = role === 'house' ? 'House attachment assigned' : 'House attachment removed';
      commitBoundary(markBoundaryEdited(setEdgeRole(boundary(), selected.id, role)), 'Toggle House Attachment relationship');
    }
  }
  if (action === 'quick-fascia' && ['edge', 'stair-edge'].includes(selected.kind)) {
    const edge = selected.kind === 'edge' ? boundary().edges.find((entry) => entry.id === selected.id) : findStairInterfaceByEdgeId(selected.id)?.edge;
    if (edge) { message = 'Fascia property updated'; commitSelectedEdgeProperties({ finishes: { fascia: !normalizeBoundaryEdge(edge).properties.finishes.fascia } }, 'Toggle edge fascia'); }
  }
  if (action === 'quick-picture-frame' && ['edge', 'stair-edge'].includes(selected.kind)) {
    const edge = selected.kind === 'edge' ? boundary().edges.find((entry) => entry.id === selected.id) : findStairInterfaceByEdgeId(selected.id)?.edge;
    if (edge) { message = 'Picture frame property updated'; commitSelectedEdgeProperties({ finishes: { pictureFrame: !normalizeBoundaryEdge(edge).properties.finishes.pictureFrame } }, 'Toggle edge picture frame'); }
  }
  if (action === 'select-stair-interface' && selectedStairObject()) {
    const stair = selectedStairObject();
    if (stair) { selected = { kind: 'stair-edge', id: getStairInterfaceEdge(stair).id }; message = 'Deck–Stair interface selected'; render(); }
  }
  if (action === 'select-stair-object' && selected.kind === 'stair-side') {
    const stair = findStairSide(selected.id)?.stair;
    if (stair) { selected = { kind: 'stair', id: stair.id }; message = 'Stair selected'; render(); }
  }
  if (action === 'apply-stair-dimensions' && selectedStairObject()) {
    const stair = selectedStairObject();
    const host = boundaryById(stair.host.boundaryId);
    const totalRise = stair.destination ? stair.dimensions.totalRise : parseConstructionLength(app.querySelector('#stair-total-rise')?.value);
    const riserHeight = parseConstructionLength(app.querySelector('#stair-riser-height')?.value);
    const treadDepth = parseConstructionLength(app.querySelector('#stair-tread-depth')?.value);
    if (!host || totalRise === null || riserHeight === null || treadDepth === null) { message = 'Enter valid Stair dimensions'; render(); }
    else {
      try {
        const regenerated = updateStairDimensions(host, stair, { totalRise, riserHeight, treadDepth });
        let next = upsertObject(documentModel, markBoundaryEdited(regenerated.boundary));
        next = upsertObject(next, regenerated.stair);
        selected = { kind: 'stair', id: stair.id };
        message = `${regenerated.stair.dimensions.riserCount} equal risers · ${regenerated.stair.dimensions.treadCount} equal treads`;
        commit(next, 'Edit staircase dimensions');
      } catch (error) { message = error.message; render(); }
    }
  }
  if (action === 'delete-stair' && selectedStairObject()) removeSelectedStair();
  if (action === 'create-rectangle') {
    const width = Number(app.querySelector('#width').value) * 12;
    const depth = Number(app.querySelector('#depth').value) * 12;
    if (width <= 0 || depth <= 0) return;
    const next = createDeckBoundary([{ x: 36, y: 36 }, { x: 36 + width, y: 36 }, { x: 36 + width, y: 36 + depth }, { x: 36, y: 36 + depth }]);
    commitBoundary(next, 'Create rectangular deck boundary');
    message = 'Deck boundary created from field dimensions';
  }
  if (action === 'complete-draft') completeDraft();
  if (action === 'apply-edge-length' && selected.kind === 'edge') {
    const length = parseConstructionLength(app.querySelector('#edge-length')?.value);
    if (!length) { message = 'Enter a valid construction length'; render(); }
    else { try { message = 'Edge length updated precisely'; commitBoundary(markBoundaryEdited(setEdgeLength(boundary(), selected.id, length)), 'Set boundary edge length'); } catch (error) { message = error.message; render(); } }
  }
  if (action === 'apply-edge-offset' && selected.kind === 'edge') {
    const offset = parseConstructionLength(app.querySelector('#edge-offset')?.value);
    if (offset === null) { message = 'Enter an offset such as 6 in or -1 ft'; render(); }
    else { try { message = 'Construction edge moved'; commitBoundary(markBoundaryEdited(offsetEdge(boundary(), selected.id, offset)), 'Offset boundary edge'); } catch (error) { message = error.message; render(); } }
  }
  if (action === 'apply-stair-width' && selected.kind === 'stair-edge') {
    const width = parseConstructionLength(app.querySelector('#stair-interface-width')?.value);
    const reference = findStairInterfaceByEdgeId(selected.id);
    if (!width || !reference) { message = 'Enter a valid stair opening width'; render(); }
    else {
      try {
        const resized = setStairWidth(boundary(), reference.stair, width);
        let next = upsertObject(documentModel, markBoundaryEdited(resized.boundary));
        next = upsertObject(next, resized.stair);
        message = 'Deck–Stair interface width updated';
        commit(next, 'Set stair opening width');
      } catch (error) { message = error.message; render(); }
    }
  }
  if (action === 'constraint-horizontal') toggleSelectedEdgeOrientation('horizontal');
  if (action === 'constraint-vertical') toggleSelectedEdgeOrientation('vertical');
  if (action === 'constraint-lock-angle') toggleSelectedEdgeOrientation('fixed-angle');
  if (action === 'insert-midpoint' && selected.kind === 'edge') {
    const current = boundary();
    const edgeIndex = current.edges.findIndex((edge) => edge.id === selected.id);
    if (edgeHasRailingDependency(selected.id)) {
      message = 'Remove the hosted railing before splitting this construction edge';
      render();
      return;
    }
    if (isEdgeLocked(current, selected.id)) { message = 'Unlock this construction edge before inserting a node'; render(); return; }
    const start = current.vertices[edgeIndex];
    const end = current.vertices[(edgeIndex + 1) % current.vertices.length];
    const existingVertexIds = new Set(current.vertices.map((vertex) => vertex.id));
    const inserted = markBoundaryEdited(insertVertex(current, selected.id, { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }));
    const newVertex = inserted.vertices.find((vertex) => !existingVertexIds.has(vertex.id));
    selected = { kind: 'vertex', id: newVertex?.id ?? null };
    message = 'Corner inserted at the edge midpoint';
    commitBoundary(inserted, 'Insert boundary corner');
  }
  if (action === 'start-stair' && selected.kind === 'edge') {
    if (isEdgeLocked(boundary(), selected.id)) { message = 'Unlock this construction edge before attaching a staircase'; render(); return; }
    mode = 'stair';
    stairDraft = { edgeId: selected.id, width: 36, totalRise: 0, totalRun: 0, treadDepth: 0, riserCount: 0, treadCount: 0 };
    message = 'Press this edge and drag outward · release at the required total rise';
    render();
  }
  if (action === 'cancel-stair') { stairGesture = null; stairDraft = null; mode = 'select'; message = 'Stair placement canceled'; render(); }
  if (action === 'make-boundary-90') {
    try {
      message = 'Boundary aligned to horizontal and vertical construction planes';
      commitBoundary(markBoundaryEdited(orthogonalizeBoundary(boundary())), 'Make Deck Boundary corners 90 degrees');
    } catch (error) { message = error.message; render(); }
  }
  if (action === 'start-level-down') {
    mode = 'level-down'; levelDownDraft = []; levelDownPointer = null;
    message = 'Click a boundary edge or corner to start Level Down';
    render();
  }
  if (action === 'cancel-level-down') {
    mode = 'select'; levelDownDraft = []; levelDownPointer = null;
    message = 'Level Down canceled';
    render();
  }
  if (action === 'apply-level-down-riser' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    const height = parseConstructionLength(app.querySelector('#quick-level-down-riser')?.value);
    if (!levelDown || height === null) { message = 'Enter a valid drop height'; render(); }
    else {
      try {
        message = `${formatInches(height)} drop applied to the entire lowered area`;
        commit(upsertObject(documentModel, setLevelDownRiserHeight(levelDown, height)), 'Set lowered-area drop height');
      } catch (error) { message = error.message; render(); }
    }
  }
  if (action === 'make-level-down-90' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    message = 'Lowered-area line converted to 90° construction segments';
    commit(upsertObject(documentModel, orthogonalizeLevelDown(levelDown)), 'Make lowered-area line 90 degrees');
  }
  if (action === 'quick-level-picture-frame' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    const active = levelDown.properties?.finishes?.pictureFrame ?? false;
    message = `Lowered-area picture frame ${active ? 'removed' : 'assigned'}`;
    commit(upsertObject(documentModel, updateLevelDownProperties(levelDown, { finishes: { pictureFrame: !active } })), 'Toggle lowered-area picture frame');
  }
  if (action === 'quick-level-fascia' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    const active = levelDown.properties?.finishes?.fascia ?? false;
    message = `Lowered-area fascia ${active ? 'removed' : 'assigned'}`;
    commit(upsertObject(documentModel, updateLevelDownProperties(levelDown, { finishes: { fascia: !active } })), 'Toggle lowered-area fascia');
  }
  if (action === 'flip-level-down-side' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    const side = levelDown.properties?.regionSide === 'larger' ? 'smaller' : 'larger';
    message = 'Lowered side flipped';
    commit(upsertObject(documentModel, updateLevelDownProperties(levelDown, { regionSide: side })), 'Flip lowered-area side');
  }
  if (action === 'break-level-down-2') breakSelectedLevelDown(2);
  if (action === 'break-level-down-3') breakSelectedLevelDown(3);
  if (action === 'delete-level-down' && selectedLevelDown()) {
    const levelDown = selectedLevelDown();
    if (levelDown) {
      const next = { ...documentModel, objects: documentModel.objects.filter((object) => object.id !== levelDown.id) };
      selected = { kind: null, id: null };
      message = 'Level Down removed · Railing remains unchanged';
      commit(next, 'Remove Level Down construction polyline');
    }
  }
  if (action === 'toggle-dimensions') {
    const visible = !getDimensionLayer(documentModel).visible;
    message = `Dimensions layer ${visible ? 'shown' : 'hidden'}`;
    commit(setDimensionLayerVisibility(documentModel, visible), 'Toggle Dimensions layer');
  }
  if (action === 'toggle-railing-visibility') {
    const visible = !getRailingLayer(documentModel).visible;
    message = `Railing layer ${visible ? 'shown' : 'hidden'}`;
    commit(setRailingLayerVisibility(documentModel, visible), 'Toggle Railing layer');
  }
  if (action === 'cat-tool-line') {
    catTool = 'line';
    catDraft = null;
    catPointer = null;
    setMode('cat');
    return;
  }
  if (action === 'cat-tool-measure') {
    catTool = 'measure';
    catDraft = null;
    catPointer = null;
    setMode('cat');
    return;
  }
  if (['cat-tool-trim', 'cat-tool-extend', 'cat-tool-note'].includes(action)) {
    catTool = action.replace('cat-tool-', '');
    catDraft = null;
    catPointer = null;
    numericBuffer = '';
    setMode('cat');
    return;
  }
  if (action === 'apply-cat-note' && selected.kind === 'cat') {
    const note = getCatNotes(documentModel).find((entry) => entry.id === selected.id);
    if (!note) return;
    const text = app.querySelector('#cat-note-text')?.value ?? '';
    message = 'CAT Note updated';
    commit(upsertObject(documentModel, updateCatNote(note, { text })), 'Edit CAT construction note');
  }
  if (action === 'record-cat-note-audio' && selected.kind === 'cat') { startCatNoteRecording(selected.id); return; }
  if (action === 'stop-cat-note-audio') { stopCatNoteRecording(); return; }
  if (action === 'remove-cat-note-audio' && selected.kind === 'cat') {
    const note = getCatNotes(documentModel).find((entry) => entry.id === selected.id);
    if (!note) return;
    message = 'Voice note removed';
    commit(upsertObject(documentModel, updateCatNote(note, { audioDataUrl: null })), 'Remove CAT voice note');
  }
  if (action === 'toggle-cat-dimensions') {
    const visible = !getCatDimensionLayer(documentModel).visible;
    message = `CAT dimensions ${visible ? 'shown' : 'hidden'}`;
    commit(setCatDimensionLayerVisibility(documentModel, visible), 'Toggle CAT dimensions');
  }
  if (action === 'close-cat-tool') {
    catDraft = null;
    catPointer = null;
    mode = 'select';
    message = 'CAT CL closed · reference geometry remains available for snap';
    render();
    return;
  }
  if (action === 'delete-cat-object' && selected.kind === 'cat') {
    const removed = documentModel.objects.find((object) => object.id === selected.id);
    if (!removed) return;
    const next = { ...documentModel, objects: documentModel.objects.filter((object) => object.id !== selected.id) };
    selected = { kind: null, id: null };
    message = removed.type === CAT_NOTE_TYPE ? 'CAT Note removed' : removed.type === CAT_MEASUREMENT_TYPE ? 'CAT measurement removed' : 'CAT construction line removed';
    commit(next, 'Delete CAT object');
  }
  if (action === 'toggle-cat-construction-lines') {
    const visible = !getCatConstructionLayer(documentModel).visible;
    message = `CAT construction lines ${visible ? 'shown' : 'hidden'}`;
    commit(setCatConstructionLayerVisibility(documentModel, visible), 'Toggle CAT construction lines');
  }
  if (action === 'edit-dimension' && selected.kind === 'dimension') editDimensionReference(selected.id);
  if (action === 'reset-dimension-position' && selected.kind === 'dimension') {
    message = 'Dimension label returned to its default position';
    commit(setDimensionOffset(documentModel, selected.id, { x: 0, y: 0 }), 'Reset dimension annotation');
  }
  if (action === 'remove-railing' && selected.kind === 'railing') removeSelectedRailing();
  if (action === 'undo') { documentModel = history.undo(documentModel); persist(); selected = { kind: null, id: null }; message = 'Undid last change'; render(); }
  if (action === 'redo') { documentModel = history.redo(documentModel); persist(); selected = { kind: null, id: null }; message = 'Redid change'; render(); }
  if (action === 'delete-vertex' && selected.kind === 'vertex') {
    if (isVertexReferencedByAttachment(selected.id)) { message = 'This corner anchors an attached construction object and cannot be removed yet'; render(); }
    else { try { commitBoundary(markBoundaryEdited(removeVertex(boundary(), selected.id)), 'Remove boundary corner'); selected = { kind: null, id: null }; message = 'Corner removed'; } catch (error) { message = error.message; render(); } }
  }
  if (action === 'new-boundary') {
    const next = { ...documentModel, objects: documentModel.objects.filter((object) => !['deck-boundary', 'stair', 'railing-run', 'level-down'].includes(object.type)) };
    commit(next, 'Remove deck boundary'); selected = { kind: null, id: null }; mode = 'select'; message = 'Ready for a new boundary';
  }
  if (action === 'advance-stage') {
    const progress = deriveModelProgress(documentModel);
    if (progress.nextStage.id !== progress.stage.id) {
      message = `Project advanced to ${progress.nextStage.label}`;
      commit(setProjectWorkflowStage(documentModel, progress.nextStage.id), `Advance project to ${progress.nextStage.label}`);
    }
  }
  if (action === 'fit-project') fitProject();
  if (action === 'toggle-visibility-panel') { utilityPanel = utilityPanel === 'visibility' ? null : 'visibility'; render(); }
  if (action === 'toggle-snap-panel') { utilityPanel = utilityPanel === 'snap' ? null : 'snap'; render(); }
  if (action === 'close-utility-panel') { utilityPanel = null; render(); }
  if (action === 'toggle-inspector') {
    utilityPanel = null;
    app.querySelector('.utility-popover')?.remove();
    app.querySelectorAll('[data-action="toggle-visibility-panel"], [data-action="toggle-snap-panel"]').forEach((button) => button.classList.remove('active'));
    app.querySelector('.inspector')?.classList.toggle('open');
  }
}

function resetProjectWorkspaceState() {
  selected = { kind: null, id: null };
  activeBoundaryId = null;
  mode = 'select';
  draft = [];
  stairDraft = null;
  railingDraft = null;
  levelDownDraft = [];
  catDraft = null;
  catPointer = null;
  catNoteDragStart = null;
  catSnapState = { type: 'none', label: 'Free', guides: [] };
  utilityPanel = null;
  exportMenuOpen = false;
  takeoffOpen = false;
  takeoffAddCategory = null;
  pendingDeckDeleteId = null;
  viewport = createViewport();
}

function stepOnePayload() {
  const railingRuns = getAllRailingGeometries().map((geometry) => ({
    id: geometry.railing.id,
    system: geometry.railing.settings?.system ?? 'unassigned',
    lengthInches: geometry.length,
  }));
  return createSalesHubStepOnePayload(documentModel, {
    opportunityId: salesHubLaunch.opportunityId,
    railingRuns,
  });
}

function downloadJson(payload, suffix) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${documentModel.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suffix}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function saveToStepOne() {
  const payload = stepOnePayload();
  const target = window.opener ?? (window.parent !== window ? window.parent : null);
  if (salesHubLaunch.connected && target) {
    target.postMessage(createSalesHubStepOneMessage(payload), salesHubLaunch.targetOrigin);
    message = 'Decking, railing, stairs, and sketch reference sent to Step 1';
  } else {
    downloadJson(payload, 'step-1');
    message = 'Step 1 JSON downloaded · direct Sales Hub connection is ready for a future launch context';
  }
  exportMenuOpen = false;
  render();
}

function downloadStepOneJson() {
  downloadJson(stepOnePayload(), 'step-1');
  exportMenuOpen = false;
  message = 'Step 1 JSON downloaded';
  render();
}

function exportProjectPdf() {
  exportMenuOpen = false;
  projectMenuOpen = false;
  fitProject();
  message = 'PDF layout ready';
  window.setTimeout(() => window.print(), 80);
  render();
}

function printTakeoff(includePrices) {
  takeoffExpanded = new Set(TAKEOFF_CATEGORIES.map((category) => category.id));
  render();
  document.body.classList.add('print-takeoff');
  document.body.classList.toggle('takeoff-no-prices', !includePrices);
  message = includePrices ? 'Priced Takeoff ready for PDF' : 'Supplier quote ready without prices';
  window.setTimeout(() => window.print(), 80);
}

window.addEventListener('afterprint', () => document.body.classList.remove('print-takeoff', 'takeoff-no-prices'));

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[character]);
}

function updateHud(event) {
  const hud = app.querySelector('.cursor-hud');
  const drawingBoundary = mode === 'draw' && draft.length && pointerWorld;
  const drawingCatLine = mode === 'cat' && catTool === 'line' && catDraft?.start && catPointer;
  // a framing run reads the same way: length, angle, what it snapped to
  const drawingFraming = mode === 'framing' && framingDraft?.start && pointerWorld;
  if (!hud || (!drawingBoundary && !drawingCatLine && !drawingFraming)) { hideHud(); return; }
  const panel = app.querySelector('.canvas-panel').getBoundingClientRect();
  hud.style.left = `${Math.min(panel.width - 180, event.clientX - panel.left + 18)}px`;
  hud.style.top = `${Math.min(panel.height - 120, event.clientY - panel.top + 18)}px`;
  hud.classList.add('visible');
  const anchor = drawingCatLine ? catDraft.start : drawingFraming ? framingDraft.start : draft[draft.length - 1];
  const activePoint = drawingCatLine ? catPointer : pointerWorld;
  const activeSnap = drawingCatLine ? catSnapState : snapState;
  const dx = activePoint.x - anchor.x;
  const dy = activePoint.y - anchor.y;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  hud.querySelector('[data-hud-length]').textContent = formatFeetInches(Math.hypot(dx, dy));
  hud.querySelector('[data-hud-angle]').textContent = `${Math.round(angle)}°`;
  hud.querySelector('[data-hud-snap]').textContent = activeSnap.label;
  const input = hud.querySelector('[data-hud-input]');
  input.textContent = numericBuffer || 'Type a length · Enter';
  input.classList.toggle('active', Boolean(numericBuffer));
}

function hideHud() {
  app.querySelector('.cursor-hud')?.classList.remove('visible');
}

function updateStairLiveHud(event = null) {
  const hud = app.querySelector('.stair-live-hud');
  if (!hud) return;
  hud.classList.toggle('visible', Boolean(stairGesture));
  if (!stairGesture) return;
  if (event) {
    const panel = app.querySelector('.canvas-panel').getBoundingClientRect();
    hud.style.left = `${Math.max(14, Math.min(panel.width - 230, event.clientX - panel.left + 22))}px`;
    hud.style.top = `${Math.max(70, Math.min(panel.height - 190, event.clientY - panel.top - 72))}px`;
  }
  const options = stairDraft;
  hud.querySelector('[data-stair-live-rise]').textContent = options?.totalRise ? formatFeetInches(options.totalRise, .25) : '0″';
  hud.querySelector('[data-stair-live-risers]').textContent = options?.riserCount || '—';
  hud.querySelector('[data-stair-live-treads]').textContent = options?.treadCount || '—';
  hud.querySelector('[data-stair-live-riser]').textContent = options?.riserHeight ? formatInches(options.riserHeight) : '—';
  hud.querySelector('[data-stair-live-tread]').textContent = options?.treadDepth ? formatInches(options.treadDepth) : '—';
  hud.querySelector('[data-stair-live-run]').textContent = options?.totalRun ? formatFeetInches(options.totalRun, .25) : '—';
  hud.querySelector('[data-stair-live-status]').textContent = options?.destination
    ? 'VALID LANDING · LOWER DECK'
    : options?.usesExtendedRiserRange
      ? 'EXTENDED 5″–6″ RISER RANGE · REVIEW'
      : 'Release to build · 5″–7.5″ risers · 10″–11″ treads';
}

function updateStatusMessage() {
  const status = app.querySelector('.status-pill');
  if (status) status.textContent = message;
}

function audioBlobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function startCatNoteRecording(noteId) {
  const note = getCatNotes(documentModel).find((entry) => entry.id === noteId);
  if (!note || catAudioRecorder) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    message = 'Voice recording is not available in this browser';
    render();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const recorder = new MediaRecorder(stream, { ...(preferredType ? { mimeType: preferredType } : {}), audioBitsPerSecond: 32000 });
    recorder.noteId = noteId;
    recorder.stream = stream;
    catAudioChunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) catAudioChunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      window.clearTimeout(recorder.stopTimer);
      recorder.stream.getTracks().forEach((track) => track.stop());
      const current = getCatNotes(documentModel).find((entry) => entry.id === recorder.noteId);
      const blob = new Blob(catAudioChunks, { type: recorder.mimeType || 'audio/webm' });
      catAudioRecorder = null;
      catAudioChunks = [];
      if (!current || !blob.size) { message = 'Voice recording canceled'; render(); return; }
      try {
        const audioDataUrl = await audioBlobToDataUrl(blob);
        message = 'Voice note saved';
        commit(upsertObject(documentModel, updateCatNote(current, { audioDataUrl })), 'Record CAT voice note');
      } catch { message = 'Voice note could not be saved'; render(); }
    });
    catAudioRecorder = recorder;
    recorder.start();
    recorder.stopTimer = window.setTimeout(() => stopCatNoteRecording(), 30000);
    message = 'Recording voice note · press Stop when finished';
    render();
  } catch {
    catAudioRecorder = null;
    message = 'Microphone access was not granted';
    render();
  }
}

function stopCatNoteRecording() {
  if (catAudioRecorder?.state === 'recording') catAudioRecorder.stop();
}

function acceptNumericLength() {
  const catLineActive = mode === 'cat' && catTool === 'line' && catDraft?.start;
  const framingActive = mode === 'framing' && framingDraft?.start;
  if ((!draft.length && !catLineActive && !framingActive) || !numericBuffer) return false;
  const length = parseConstructionLength(numericBuffer);
  if (!length || length <= 0) { message = 'Use a length such as 12\', 144 in, or 3658 mm'; render(); return true; }
  /* A framing run takes its direction from wherever the pointer is - which the
     snap engine has already squared - and its length from the keyboard. Same
     bargain the boundary and CAT line already offer. */
  if (framingActive) {
    const from = framingDraft.start;
    const aim = pointerWorld ?? { x: from.x + 1, y: from.y };
    const exact = resolveCatLineEndpoint(from, aim, length);
    numericBuffer = '';
    lastLength = length;
    placeFramingPoint(exact, 'keyboard', true);
    return true;
  }
  const anchor = catLineActive ? catDraft.start : draft[draft.length - 1];
  const toward = catLineActive ? catPointer : pointerWorld;
  const exactPoint = resolveCatLineEndpoint(anchor, toward ?? { x: anchor.x + 1, y: anchor.y }, length);
  if (catLineActive) {
    const object = createCatLine(anchor, exactPoint);
    catDraft = { start: exactPoint };
    catPointer = exactPoint;
    catSnapState = { type: 'angle', label: 'Exact length', guides: [] };
    lastLength = length;
    numericBuffer = '';
    message = `${formatFeetInches(length)} CAT Line placed · continue drawing`;
    commit(upsertObject(documentModel, object), 'Add exact-length CAT construction line');
    return true;
  }
  draft.push(exactPoint);
  pointerWorld = exactPoint;
  lastLength = length;
  numericBuffer = '';
  message = `${formatFeetInches(length)} segment placed · continue drawing`;
  render();
  return true;
}

function repeatLastSegment() {
  if (!lastLength || !draft.length) return;
  const anchor = draft.at(-1);
  const previous = draft.at(-2);
  const dx = previous ? anchor.x - previous.x : 1;
  const dy = previous ? anchor.y - previous.y : 0;
  const magnitude = Math.hypot(dx, dy) || 1;
  draft.push({ x: anchor.x + dx / magnitude * lastLength, y: anchor.y + dy / magnitude * lastLength });
  message = `${formatFeetInches(lastLength)} segment repeated`;
  render();
}

function repeatLastCatSegment() {
  if (!lastLength || !catDraft?.start) return;
  const anchor = catDraft.start;
  const toward = catPointer ?? { x: anchor.x + 1, y: anchor.y };
  const endpoint = resolveCatLineEndpoint(anchor, toward, lastLength);
  const object = createCatLine(anchor, endpoint);
  catDraft = { start: endpoint };
  catPointer = endpoint;
  message = `${formatFeetInches(lastLength)} CAT Line repeated`;
  commit(upsertObject(documentModel, object), 'Repeat CAT construction line');
}

window.addEventListener('keydown', (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  const editingField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  const numericLineMode = mode === 'draw'
    || (mode === 'cat' && catTool === 'line' && Boolean(catDraft?.start))
    || (mode === 'framing' && Boolean(framingDraft?.start));
  if (event.key === 'Escape' && framingDraft) {
    event.preventDefault();
    framingDraft = null;
    pointerWorld = null;
    message = 'Run cancelled';
    render();
    return;
  }
  if (event.key === 'Escape' && takeoffOpen) {
    event.preventDefault();
    takeoffOpen = false;
    takeoffAddCategory = null;
    message = 'Takeoff saved with this project';
    render();
    return;
  }
  if (event.key === 'Escape' && (projectMenuOpen || exportMenuOpen)) {
    event.preventDefault();
    projectMenuOpen = false;
    exportMenuOpen = false;
    pendingProjectDeleteId = null;
    render();
    return;
  }
  if (event.key === 'Escape' && utilityPanel) {
    event.preventDefault();
    utilityPanel = null;
    render();
    return;
  }
  if (event.key === 'Escape' && boardingDirectionMode) {
    event.preventDefault();
    boardingDirectionMode = null;
    message = 'Board direction selection canceled';
    render();
    return;
  }
  if (event.key === 'Escape' && moveBoundaryMode) {
    event.preventDefault();
    if (moveBoundaryGesture) documentModel = moveBoundaryGesture.document;
    moveBoundaryMode = null; moveBoundaryGesture = null;
    message = 'Deck area move canceled';
    persist(); render();
    return;
  }
  if (event.key === 'Escape' && chamferMode) {
    event.preventDefault();
    chamferMode = null; chamferGesture = null; chamferDraft = null;
    message = 'Chamfer canceled';
    render();
    return;
  }
  if (event.key === 'Escape' && dimensionLeaderMode) {
    event.preventDefault();
    dimensionLeaderMode = null;
    dimensionLeaderGesture = null;
    message = 'Arrow reposition canceled';
    render();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); handleAction(event.shiftKey ? 'redo' : 'undo'); }
  if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); handleAction('redo'); }
  if (!modifier && !editingField && !numericLineMode && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    const enabled = !getSnapSettings(documentModel).edges;
    message = `Edge and corner snap ${enabled ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { edges: enabled }), 'Toggle edge snap');
    return;
  }
  if (!modifier && !editingField && !numericLineMode && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    const enabled = !getSnapSettings(documentModel).grid;
    message = `Grid snap ${enabled ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { grid: enabled }), 'Toggle grid snap');
    return;
  }
  if (!modifier && !editingField && !numericLineMode && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    const enabled = !getSnapSettings(documentModel).nodeInference;
    message = `Node inference ${enabled ? 'enabled' : 'disabled'}`;
    commit(setSnapSettings(documentModel, { nodeInference: enabled }), 'Toggle node inference');
    return;
  }
  if (numericLineMode && !modifier && !editingField && /^[0-9a-z.'"\-]$/i.test(event.key)) {
    if (event.key.toLowerCase() === 'r' && !numericBuffer) { event.preventDefault(); mode === 'cat' ? repeatLastCatSegment() : repeatLastSegment(); return; }
    event.preventDefault(); numericBuffer += event.key; message = 'Enter an exact segment length'; updateHudFromKeyboard(); return;
  }
  if (numericLineMode && event.key === 'Backspace' && numericBuffer) { event.preventDefault(); numericBuffer = numericBuffer.slice(0, -1); updateHudFromKeyboard(); return; }
  if (event.key === 'Enter' && numericLineMode) { event.preventDefault(); if (!acceptNumericLength() && mode === 'draw') completeDraft(); }
  if (event.key === ' ' && numericLineMode) { event.preventDefault(); if (numericBuffer) { numericBuffer += ' '; updateHudFromKeyboard(); } else mode === 'cat' ? repeatLastCatSegment() : repeatLastSegment(); }
  if (event.key === 'Tab' && numericLineMode) { event.preventDefault(); message = numericBuffer ? 'Press Enter to accept length' : 'Type a dimension in feet, inches, millimeters, or meters'; updateHudFromKeyboard(); }
  if (event.key === 'Escape' && mode === 'draw') {
    event.preventDefault();
    if (numericBuffer) numericBuffer = '';
    else if (draft.length) draft.pop();
    else mode = 'select';
    pointerWorld = draft.at(-1) ?? null;
    message = mode === 'draw' ? 'Last sketch step canceled' : 'Drawing canceled'; render();
  }
  if (event.key === 'Escape' && mode === 'cat') {
    event.preventDefault();
    if (numericBuffer) {
      numericBuffer = '';
      message = 'Exact CAT length entry cleared';
    } else if (catDraft?.start) {
      catDraft = null;
      catPointer = null;
      message = `${catTool === 'measure' ? 'Measuring tape' : 'CAT Line'} · choose the first point`;
    } else {
      mode = 'select';
      message = 'CAT CL closed';
    }
    render();
    return;
  }
  if (event.key === 'Escape' && mode === 'level-down') {
    event.preventDefault();
    if (levelDownDraft.length) levelDownDraft.pop();
    else mode = 'select';
    levelDownPointer = levelDownDraft.at(-1) ?? null;
    message = mode === 'level-down' ? 'Last Level Down point canceled' : 'Level Down canceled';
    render();
  }
  if (event.key === 'Backspace' && mode === 'level-down' && !editingField) {
    event.preventDefault();
    levelDownDraft.pop(); levelDownPointer = levelDownDraft.at(-1) ?? null;
    message = levelDownDraft.length ? 'Last Level Down point removed' : 'Choose a boundary edge to restart';
    render();
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.kind === 'vertex') handleAction('delete-vertex');
  /* A member you can place, you must be able to remove. Guarded on editingField
     so backspacing in a text box never deletes the beam behind it. */
  if ((event.key === 'Delete' || event.key === 'Backspace') && selected.kind === 'framing' && !editingField) {
    event.preventDefault();
    handleAction('delete-framing');
  }
});

function updateHudFromKeyboard() {
  const hud = app.querySelector('.cursor-hud');
  if (!hud) return;
  const input = hud.querySelector('[data-hud-input]');
  input.textContent = numericBuffer || 'Type a length · Enter';
  input.classList.toggle('active', Boolean(numericBuffer));
}

render();
