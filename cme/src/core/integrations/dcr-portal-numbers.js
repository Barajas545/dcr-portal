import { distance } from '../geometry/vector.js';
import { getStairInterfaceEdge } from '../../tools/stairs/stair.js';

/* The estimate multiplies deckSF by a historical dollar-per-square-foot rate, so
   these four numbers are the quote. Both exports read one measurement pass: the
   working the UI shows and the footage the customer is charged for can never
   drift apart. */

const roundTenth = (value) => Math.round(Math.max(0, Number(value) || 0) * 10) / 10;
const toSquareFeet = (squareInches) => (Number(squareInches) || 0) / 144;
const toLinearFeet = (inches) => (Number(inches) || 0) / 12;
const objectsOfType = (document, type) => (document?.objects ?? []).filter((object) => object.type === type);
const vertexIndex = (owner) => new Map((owner.vertices ?? []).map((vertex) => [vertex.id, vertex]));

function spanLength(byId, startVertexId, endVertexId) {
  const start = byId.get(startVertexId);
  const end = byId.get(endVertexId);
  return start && end ? distance(start, end) : 0;
}

function pointAlong(span, t) {
  return { x: span.start.x + (span.end.x - span.start.x) * t, y: span.start.y + (span.end.y - span.start.y) * t };
}

function findVertex(document, vertexId) {
  for (const boundary of objectsOfType(document, 'deck-boundary')) {
    const vertex = boundary.vertices.find((entry) => entry.id === vertexId);
    if (vertex) return vertex;
  }
  return null;
}

function locateEdge(document, edgeId) {
  if (!edgeId) return null;
  const boundaries = objectsOfType(document, 'deck-boundary');
  for (const boundary of boundaries) {
    const edge = (boundary.edges ?? []).find((entry) => entry.id === edgeId);
    if (!edge) continue;
    const byId = vertexIndex(boundary);
    const start = byId.get(edge.startVertexId);
    const end = byId.get(edge.endVertexId);
    if (start && end) return { start, end };
  }
  /* A run can host on a stair opening, whose edge is stored on the stair while
     its nodes stay on the host boundary. Skipping that case bills the run at
     zero feet instead of failing loudly. */
  for (const stair of objectsOfType(document, 'stair')) {
    /* Through the resolver, not the raw field. A stair saved before the
       interface edge existed has no stair.interfaceEdge at all, and reading it
       raw made its railing measure zero - the run was on the drawing and
       missing from the quote. */
    const edge = getStairInterfaceEdge(stair);
    if (edge?.id !== edgeId) continue;
    const boundary = boundaries.find((entry) => entry.id === stair.host?.boundaryId);
    if (!boundary) continue;
    const byId = vertexIndex(boundary);
    const start = byId.get(edge.startVertexId);
    const end = byId.get(edge.endVertexId);
    if (start && end) return { start, end };
  }
  return null;
}

/* Anchors are re-resolved through their snap references rather than trusting the
   stored point, which goes stale the moment the host edge is moved or resized. */
function resolveAnchorPoint(document, anchor) {
  if (anchor.snapType === 'vertex') {
    const vertex = findVertex(document, anchor.vertexId);
    if (vertex) return vertex;
  }
  if (anchor.snapType === 'edge' && Number.isFinite(anchor.t)) {
    const span = locateEdge(document, anchor.edgeId);
    if (span) return pointAlong(span, anchor.t);
  }
  return anchor.point ?? null;
}

function railingLengthInches(document, railing) {
  const anchors = railing.anchors ?? {};
  if (anchors.start && anchors.end) {
    const start = resolveAnchorPoint(document, anchors.start);
    const end = resolveAnchorPoint(document, anchors.end);
    return start && end ? distance(start, end) : 0;
  }
  const span = locateEdge(document, railing.host?.edgeId);
  if (!span || !Number.isFinite(anchors.startT) || !Number.isFinite(anchors.endT)) return 0;
  return distance(pointAlong(span, anchors.startT), pointAlong(span, anchors.endT));
}

function openingWidthInches(opening) {
  return Math.max(0, Number(opening?.widthInches ?? opening?.width) || 0);
}

function measureRailingRuns(document, options) {
  const resolved = new Map((options.railingGeometries ?? [])
    .filter((geometry) => geometry?.railing?.id)
    .map((geometry) => [geometry.railing.id, Number(geometry.length) || 0]));
  return objectsOfType(document, 'railing-run').map((railing) => {
    const lengthInches = resolved.get(railing.id) ?? railingLengthInches(document, railing);
    const openingInches = (railing.openings ?? []).reduce((total, opening) => total + openingWidthInches(opening), 0);
    return {
      id: railing.id,
      name: railing.name ?? 'Railing run',
      type: railing.settings?.system ?? 'unassigned',
      lengthInches,
      openingInches,
      /* Clamped per run: an opening drawn wider than its own run must not eat
         into the footage of the other runs on the job. */
      billedInches: Math.max(0, lengthInches - openingInches),
    };
  });
}

function measureFasciaEdges(document) {
  const boundaryEdges = objectsOfType(document, 'deck-boundary').flatMap((boundary) => {
    const byId = vertexIndex(boundary);
    return (boundary.edges ?? [])
      .filter((edge) => edge.properties?.finishes?.fascia)
      .map((edge) => ({
        id: edge.id,
        ownerId: boundary.id,
        kind: 'boundary-edge',
        lengthInches: spanLength(byId, edge.startVertexId, edge.endVertexId),
      }));
  });
  /* A Level Down carries one fascia flag for the whole polyline, but the riser it
     draws is finished segment by segment, so every segment is billed. */
  const levelDownSegments = objectsOfType(document, 'level-down')
    .filter((levelDown) => levelDown.properties?.finishes?.fascia)
    .flatMap((levelDown) => {
      const byId = vertexIndex(levelDown);
      return (levelDown.segments ?? []).map((segment) => ({
        id: segment.id,
        ownerId: levelDown.id,
        kind: 'level-down-segment',
        lengthInches: spanLength(byId, segment.startVertexId, segment.endVertexId),
      }));
    });
  return [...boundaryEdges, ...levelDownSegments];
}

function measureDrawing(document, options) {
  return {
    areas: objectsOfType(document, 'deck-boundary').map((boundary) => ({
      id: boundary.id,
      name: boundary.name ?? 'Deck area',
      squareFeet: toSquareFeet(boundary.computed?.areaSquareInches),
      /* Only an explicit flag may take billable area off a quote. */
      excluded: boundary.metadata?.excludeFromDeckArea === true,
    })),
    railingRuns: measureRailingRuns(document, options),
    fasciaEdges: measureFasciaEdges(document),
    stairCount: objectsOfType(document, 'stair').length,
  };
}

export function deriveDrawingNumbers(document, options = {}) {
  const measured = measureDrawing(document, options);
  return {
    /* Gross drawn area, stair footprints included. The dollar-per-square-foot
       rate was calibrated against gross areas, so netting stairs out here would
       silently reprice every job. The decking material line nets them out
       instead, which is a different number for a different purpose. */
    deckSF: roundTenth(measured.areas
      .filter((area) => !area.excluded)
      .reduce((total, area) => total + area.squareFeet, 0)),
    railLF: roundTenth(toLinearFeet(measured.railingRuns.reduce((total, run) => total + run.billedInches, 0))),
    fasciaLF: roundTenth(toLinearFeet(measured.fasciaEdges.reduce((total, edge) => total + edge.lengthInches, 0))),
    stairs: roundTenth(measured.stairCount),
  };
}

export function deriveDrawingBreakdown(document, options = {}) {
  const measured = measureDrawing(document, options);
  const railingTotals = measured.railingRuns.reduce((totals, run) => {
    totals[run.type] = (totals[run.type] ?? 0) + run.billedInches;
    return totals;
  }, {});
  return {
    areas: measured.areas.map((area) => ({ ...area, squareFeet: roundTenth(area.squareFeet) })),
    railingByType: Object.entries(railingTotals).map(([type, inches]) => ({ type, linearFeet: roundTenth(toLinearFeet(inches)) })),
    fasciaEdges: measured.fasciaEdges.map((edge) => ({
      id: edge.id,
      ownerId: edge.ownerId,
      kind: edge.kind,
      linearFeet: roundTenth(toLinearFeet(edge.lengthInches)),
    })),
    stairCount: measured.stairCount,
  };
}
