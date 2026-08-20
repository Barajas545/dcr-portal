import { getStairInterfaceEdge } from '../stairs/stair.js';
import { RAILING_TYPE, analyzeRailingGeometries, computeRailingLayout, deriveRailingLineGeometry } from './railing.js';
import { getGateOpenings } from '../symbols/symbols.js';

/* Material for the railing systems takeoff.js does not bill.

   takeoff.js writes every Wild Hog line itself - panel, track, handrail, panel
   support and post - straight off options.railingGeometries. So this module
   returns NOTHING for a wild-hog run: describing one here would put it on the
   estimate twice. It covers the two systems takeoff.js leaves out:

     stick-built   4x4 posts, 2x4 top and bottom rails, balusters
     trex          post assemblies and section kits, flagged for hand pricing

   Each run carries its own settings.system, so a project may mix all three and
   every run is read on its own.

   These are plain descriptors, not takeoff lines. takeoff.js turns them into
   lines; importing it from here would be circular.

   One thing to know when this gets wired up: takeoff.js bills its Wild Hog post
   line from options.railingPostCount, which app.js computes over EVERY run on
   the project, not just the wild-hog ones. On a project that mixes systems the
   stick or Trex posts below are therefore also inside that number. Fixing it
   belongs in takeoff.js, which this module is not allowed to touch. */

export const WILD_HOG_SYSTEM = 'wild-hog';
export const STICK_BUILT_SYSTEM = 'stick-built';
export const TREX_SYSTEM = 'trex';
// What railing.js stamps on a run whose system was never chosen.
export const DEFAULT_RAILING_SYSTEM = WILD_HOG_SYSTEM;
export const BALUSTER_PITCH_INCHES = 4.5;
export const RAIL_STOCK_LENGTH_FEET = 8;

const isPoint = (value) => Number.isFinite(value?.x) && Number.isFinite(value?.y);
const feet = (inches) => Math.round((inches / 12) * 10) / 10;
const pointAlong = (span, t) => ({ x: span.start.x + (span.end.x - span.start.x) * t, y: span.start.y + (span.end.y - span.start.y) * t });

export function railingSystem(railing) {
  return railing?.settings?.system ?? DEFAULT_RAILING_SYSTEM;
}

export function getRailingRuns(document, system) {
  const runs = (document?.objects ?? []).filter((object) => object.type === RAILING_TYPE);
  return system === undefined ? runs : runs.filter((railing) => railingSystem(railing) === system);
}

function edgeSpan(owner, edge) {
  const byId = new Map((owner.vertices ?? []).map((vertex) => [vertex.id, vertex]));
  const start = byId.get(edge.startVertexId);
  const end = byId.get(edge.endVertexId);
  return isPoint(start) && isPoint(end) ? { start, end } : null;
}

function locateEdge(document, edgeId) {
  if (!edgeId) return null;
  const objects = document?.objects ?? [];
  const boundaries = objects.filter((object) => object.type === 'deck-boundary');
  for (const boundary of boundaries) {
    const edge = (boundary.edges ?? []).find((entry) => entry.id === edgeId);
    const span = edge && edgeSpan(boundary, edge);
    if (span) return span;
  }
  /* A run can host on a stair opening, whose edge is stored on the stair while
     its vertices stay on the host boundary. Skipping that case measures the run
     at zero feet and drops it off the estimate without saying so. */
  for (const stair of objects.filter((object) => object.type === 'stair' && (object.interfaceEdge || object.anchors))) {
    const edge = getStairInterfaceEdge(stair);
    if (edge?.id !== edgeId) continue;
    const boundary = boundaries.find((entry) => entry.id === stair.host?.boundaryId);
    const span = boundary && edgeSpan(boundary, edge);
    if (span) return span;
  }
  return null;
}

/* Only reached when the caller passed no geometry for this run. The UI re-resolves
   both anchors on every render, so its geometry is the live one and always wins;
   this path exists so that calling describeTakeoff(document) on its own still bills
   the railing instead of quietly leaving it off the material list. A stored anchor
   point can be stale if the host edge has since moved, which is a slightly wrong
   length - better than no length at all. */
function deriveGeometry(document, railing) {
  const anchors = railing.anchors ?? {};
  if (isPoint(anchors.start?.point) && isPoint(anchors.end?.point)) {
    return deriveRailingLineGeometry(railing, anchors.start.point, anchors.end.point);
  }
  const span = locateEdge(document, railing.host?.edgeId);
  if (!span || !Number.isFinite(anchors.startT) || !Number.isFinite(anchors.endT)) return null;
  return deriveRailingLineGeometry(railing, pointAlong(span, anchors.startT), pointAlong(span, anchors.endT));
}

// Post deduplication needs real coordinates; a caller may hand over a run measured
// only as { railing, length }, which is enough to bill feet but not to cluster posts.
const hasPostCoordinates = (geometry) => isPoint(geometry?.start) && isPoint(geometry?.end)
  && Array.isArray(geometry?.posts) && geometry.posts.length > 0 && geometry.posts.every(isPoint);

function measureRuns(document, runs, supplied) {
  return runs.map((railing) => {
    const geometry = supplied.get(railing.id) ?? deriveGeometry(document, railing);
    const lengthInches = Number(geometry?.length) || 0;
    if (!(lengthInches > 0)) return null;
    const layout = Number.isFinite(geometry.sectionCount) && Number.isFinite(geometry.centerSpacing)
      ? geometry
      : computeRailingLayout(lengthInches, railing.settings);
    return {
      railing,
      geometry,
      lengthInches,
      sectionCount: Number(layout.sectionCount) || 0,
      centerSpacing: Number(layout.centerSpacing) || 0,
      postCount: Number(layout.postCount) || 0,
    };
  }).filter(Boolean);
}

/* The old rule was floor(railLF / 6) + 1 - one post roughly every 6 ft of run.
   The layout railing.js already computes is used instead, because it dedupes the
   post two runs share where they meet and adds one per exterior corner, neither of
   which the divisor could see. On an L-shaped deck this lands a post or two above
   the old number, and that difference is the correction, not an error.

   Only this system's runs are analysed, so the posts billed here are the ones this
   system owns. A run whose coordinates could not be resolved still contributes its
   own layout posts; it just misses the shared-post dedupe. */
function estimatedPostCount(measured) {
  const laidOut = measured.filter((entry) => hasPostCoordinates(entry.geometry));
  const loose = measured.filter((entry) => !hasPostCoordinates(entry.geometry));
  return analyzeRailingGeometries(laidOut.map((entry) => entry.geometry)).estimatedPostCount
    + loose.reduce((sum, entry) => sum + entry.postCount, 0);
}

function describeStickBuilt(measured) {
  if (!measured.length) return [];
  const sourceObjectIds = measured.map((entry) => entry.railing.id);
  const railFeet = measured.reduce((sum, entry) => sum + entry.lengthInches, 0) / 12;
  const sectionCount = measured.reduce((sum, entry) => sum + entry.sectionCount, 0);
  const longestBayInches = measured.reduce((longest, entry) => Math.max(longest, entry.centerSpacing), 0);
  // A bay wider than a stick means the 2x4x8 on the line is the wrong piece, so the
  // estimator is told rather than handed a board that cannot reach the next post.
  const bayFitsStock = longestBayInches <= RAIL_STOCK_LENGTH_FEET * 12;
  const railFootage = `${Math.round(railFeet * 2 * 10) / 10} lf of rail`;
  return [
    {
      kind: 'count',
      id: 'auto:railing:stick-post',
      category: 'railing',
      // The old tool's own line names, kept word for word so an estimator can hold
      // this list against a historical one and read down the same rows.
      description: 'Rail post (4x4)',
      specification: '4×4 · from the run layout · corner posts included',
      quantity: estimatedPostCount(measured),
      sourceObjectIds,
    },
    /* Rail and baluster are the rules of the tool being replaced
       (cad-sketch.js:902-904):

         rail (2x4) = railLF * 2            top and bottom
         baluster   = ceil(railLF * 12 / 4.5)

       The baluster is ported exactly. The rail footage is ported exactly too and
       is printed on the line, but it is ORDERED as pieces, two per bay, not as
       lineal feet divided by a stock length. A stick rail is cut to fit between
       posts, so one 8 ft stick makes one rail for a 6 ft bay and the drop is
       scrap: sixteen 6 ft rails are 100 lf, and 100 lf off 16 ft stock buys seven
       boards where the job needs eight. That is the same offcut assumption that
       shorted the joists. Wild Hog bills its identical 2x4 top-and-bottom member
       the same way (takeoff.js 'Panel support', 2×4×8, two per panel), so a
       project mixing the two systems orders the same part the same way. */
    {
      kind: 'count',
      id: 'auto:railing:stick-rail',
      category: 'railing',
      description: 'Rail (2x4)',
      specification: bayFitsStock
        ? `2×4×${RAIL_STOCK_LENGTH_FEET} · top and bottom · ${railFootage}`
        : `2×4 · top and bottom · ${railFootage} · bays run to ${feet(longestBayInches)} ft, longer than the ${RAIL_STOCK_LENGTH_FEET} ft stick`,
      quantity: sectionCount * 2,
      sourceObjectIds,
      ...(bayFitsStock ? {} : { confidence: 'review' }),
    },
    {
      kind: 'count',
      id: 'auto:railing:stick-baluster',
      category: 'railing',
      description: 'Baluster',
      specification: `${BALUSTER_PITCH_INCHES} in centres · 4 in maximum gap`,
      // written as the old rule reads, feet back to inches and all
      quantity: Math.ceil(railFeet * 12 / BALUSTER_PITCH_INCHES),
      sourceObjectIds,
    },
  ];
}

/* Trex was billing nothing at all: a run drawn on the plan, priced at zero, with
   nothing on the estimate to show it had been missed.

   These are counts of the two things a Trex order is actually made of - a post
   assembly per post and a section kit per bay - both flagged for review, because
   the series, colour, rail height and section length are catalogue choices this
   tool has no table for. What is deliberately NOT here is a top and bottom rail
   billed at railLF of lumber. Trex rail is bought as a kit cut to the bay with the
   balusters in the box; footage of 2x4 would look priced while matching no SKU,
   and it would bury the choice the estimator still has to make. Quantities the
   drawing does know are worth more than a single "price this by hand" line, and
   both of these are quantities the drawing knows. */
function describeTrex(measured) {
  if (!measured.length) return [];
  const sourceObjectIds = measured.map((entry) => entry.railing.id);
  const lengthInches = measured.reduce((sum, entry) => sum + entry.lengthInches, 0);
  const sectionCount = measured.reduce((sum, entry) => sum + entry.sectionCount, 0);
  return [
    {
      kind: 'count',
      id: 'auto:railing:trex-post',
      category: 'railing',
      description: 'Trex post assembly (price by hand)',
      specification: 'Post, sleeve, cap and skirt · series, colour and height to be selected',
      quantity: estimatedPostCount(measured),
      sourceObjectIds,
      confidence: 'review',
    },
    {
      kind: 'count',
      id: 'auto:railing:trex-section',
      category: 'railing',
      description: 'Trex rail section kit (price by hand)',
      specification: `One kit per bay · balusters included · ${feet(lengthInches)} lf of railing · section length, series and colour to be selected`,
      quantity: sectionCount,
      sourceObjectIds,
      confidence: 'review',
    },
  ];
}

/* How far a point sits from a run, so a gate can be matched to the railing it
   is cut into. Plain point-to-segment distance; a gate dropped on the deck well
   away from any railing belongs to none of them and is ignored. */
function distanceToRun(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return Math.hypot(point.x - start.x, point.y - start.y);
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

const GATE_ON_RUN_TOLERANCE_INCHES = 12;

/* A gate is an opening, not a material. Its width comes OUT of the run it sits
   in, so the balusters and rail are not billed across a hole. This is the whole
   reason the old tool subtracted every gate width from railing footage
   (cad-sketch.js railing numbers) and the reason drawing a gate is worth doing.

   A run is never taken below zero: two gates mistakenly dropped on a short run
   should read as no railing left, not as negative footage quietly cancelling
   another run's material. */
function netGateOpenings(measured, openings) {
  if (!openings.length) return measured;
  const remaining = openings.slice();
  return measured.map((entry) => {
    const start = entry.geometry?.start;
    const end = entry.geometry?.end;
    if (!start || !end) return entry;
    let taken = 0;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const opening = remaining[index];
      if (distanceToRun(opening.at, start, end) <= GATE_ON_RUN_TOLERANCE_INCHES) {
        taken += Number(opening.widthInches) || 0;
        remaining.splice(index, 1);   // a gate belongs to one run only
      }
    }
    if (!taken) return entry;
    return { ...entry, lengthInches: Math.max(0, entry.lengthInches - taken), gateInches: taken };
  }).filter((entry) => entry.lengthInches > 0);
}

export function describeTakeoff(document, options = {}) {
  const supplied = new Map((options.railingGeometries ?? [])
    .filter((geometry) => geometry?.railing?.id)
    .map((geometry) => [geometry.railing.id, geometry]));
  /* Runs come from the document rather than from the supplied geometries: the
     document is where settings.system lives, and a run the caller forgot to
     resolve still gets measured instead of disappearing. */
  const openings = getGateOpenings(document);
  const measured = (system) => netGateOpenings(
    measureRuns(document, getRailingRuns(document, system), supplied), openings);
  return [
    ...describeStickBuilt(measured(STICK_BUILT_SYSTEM)),
    ...describeTrex(measured(TREX_SYSTEM)),
  ];
}
