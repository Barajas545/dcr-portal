/* The DCR Construction Standard, applied to a drawing.

   The arithmetic lives in core/standards; this file is the part that knows
   about beams, boundaries and the takeoff. It is deliberately DORMANT until a
   primary deck level is set: a drawing made before the standard existed has no
   level, produces nothing here, and its quotes do not move. That is the
   guardrail the beam and joist READMEs asked for — "doing it by accident
   during a port would silently change quotes that are already out."

   Everything it produces is flagged 'preliminary', because it is a shop
   standard rather than a verified structural design. */

import { distance } from '../../core/geometry/vector.js';
import { beamBoards, isSecondFloor } from '../../core/standards/dcr-construction-standard.js';
import { getBeams } from '../beam/beam.js';
import { deriveBeamGeometry } from '../beam/beam-geometry.js';

const feet = (inches) => Math.round((inches / 12) * 10) / 10;

/* The datum. Null means nobody has set one, which is NOT the same as zero and
   must never be read as second floor. */
export function getDeckLevelInches(document) {
  const value = document?.construction?.deckLevelInches;
  // Number(null) is 0 and 0 is finite, so an unset level read as a deck at
  // grade and switched the whole standard on for every old drawing.
  if (value === null || value === undefined || value === '') return null;
  const level = Number(value);
  return Number.isFinite(level) ? level : null;
}

export function setDeckLevelInches(document, inches) {
  const value = inches === null || inches === '' ? null : Number(inches);
  return {
    ...document,
    construction: { ...(document.construction ?? {}), deckLevelInches: Number.isFinite(value) ? value : null },
    updatedAt: new Date().toISOString(),
  };
}

/* The standard drives the layout only for a deck at or near grade. At second
   floor the estimator picks spacing and sizes, so the tool derives nothing. */
export function standardApplies(document) {
  const level = getDeckLevelInches(document);
  return level !== null && !isSecondFloor(level);
}

// edges the user marked as running against the house — the ledger line
export function ledgerLengthInches(document) {
  return (document.objects ?? [])
    .filter((object) => object.type === 'deck-boundary')
    .reduce((total, boundary) => {
      const byId = new Map((boundary.vertices ?? []).map((vertex) => [vertex.id, vertex]));
      return total + (boundary.edges ?? []).reduce((sum, edge) => {
        if (edge.properties?.classification?.relationship !== 'house-attachment') return sum;
        const start = byId.get(edge.startVertexId);
        const end = byId.get(edge.endVertexId);
        return sum + (start && end ? distance(start, end) : 0);
      }, 0);
    }, 0);
}

/* One beam run resolved into what gets bought and what holds it up.

   The layout comes from deriveBeamGeometry — the SAME function the canvas
   draws from — so the posts on the drawing and the posts on the order can
   never disagree, and an estimator who added a post gets charged for it. */
export function planBeam(beam, settings) {
  const geometry = deriveBeamGeometry(beam, settings);
  if (!geometry) return null;
  const boards = beamBoards(geometry.length, geometry.spacingInches, settings.beamStockFeet);
  return { beam, geometry, length: geometry.length, layout: geometry, boards, system: geometry.system };
}

export function describeTakeoff(document, settings) {
  if (!standardApplies(document)) return [];
  const beams = getBeams(document);
  const plans = beams.map((beam) => planBeam(beam, settings)).filter(Boolean);
  const descriptors = [];

  /* Beams, grouped by the commercial length actually bought. A run is spliced
     end to end OVER A POST, so every board covers a whole number of bays. */
  const boardCounts = plans.reduce((map, plan) => {
    Object.entries(plan.boards.byLength).forEach(([lengthFeet, count]) => {
      map[lengthFeet] = (map[lengthFeet] ?? 0) + count;
    });
    return map;
  }, {});
  const beamIds = beams.map((beam) => beam.id);
  /* Where the joists MEET a beam is the whole difference between the systems,
     and it is hardware, not a drawing style: bottom-beam joists bear on top and get
     tied down, flush joists stop at the face and hang off it. That hardware
     cannot be counted until joists are modelled, so none is claimed here — but
     the beam line says which system it was framed to, because on a mixed deck
     that is the difference between two different orders. */
  const systems = [...new Set(plans.map((plan) => plan.system))];
  const systemLabel = systems.length > 1 ? 'mixed: ' + systems.join(' + ') : systems[0] ?? 'bottom';
  const totalOffcutInches = plans.reduce((sum, plan) => sum + plan.boards.leftoverInches, 0);
  const totalRunInches = plans.reduce((sum, plan) => sum + plan.length, 0);
  Object.entries(boardCounts)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([lengthFeet, count]) => {
      descriptors.push({
        kind: 'count',
        id: `auto:framing:dcrcs-beam-${lengthFeet}`,
        category: 'framing',
        description: `${settings.beamSize}x${lengthFeet} beam`,
        specification: `DCR standard · spliced over a post · ${systemLabel}`,
        quantity: count,
        sourceObjectIds: beamIds,
        confidence: 'preliminary',
        /* The offcut is REPORTED, never netted off the order: it is usable
           stock and the estimator wants to know it exists. It rides on the
           line so the calculation note can say where it came from. */
        beamPlan: {
          runs: plans.length,
          runFeet: feet(totalRunInches),
          offcutFeet: feet(totalOffcutInches),
          spacingFeet: feet(plans[0]?.layout.spacingInches ?? 0),
        },
      });
    });

  /* Posts, one at each end of every bay. Shared posts between touching runs are
     NOT deduplicated here: a beam is planned on its own, and two runs meeting
     at a corner is a drawing question the canvas answers when it places them. */
  const postCount = plans.reduce((sum, plan) => sum + plan.layout.postCount, 0);
  if (postCount > 0) {
    descriptors.push({
      kind: 'yield',
      standard: 'dcrcsPost',
      id: 'auto:framing:dcrcs-post',
      category: 'framing',
      description: `${settings.postSize}x${settings.dcrcsPostStockFeet} post stock`,
      piecesNeeded: postCount,
      sourceObjectIds: beamIds,
      confidence: 'preliminary',
    });
    descriptors.push({
      kind: 'count', id: 'auto:hardware:dcrcs-post-base', category: 'hardware',
      description: 'Post base / anchor', specification: 'One per footing',
      quantity: postCount, sourceObjectIds: beamIds, confidence: 'preliminary',
    });
    descriptors.push({
      kind: 'count', id: 'auto:hardware:dcrcs-post-beam-cap', category: 'hardware',
      description: 'Post-to-beam connector', specification: 'One per post · type to confirm',
      quantity: postCount, sourceObjectIds: beamIds, confidence: 'review',
    });
    descriptors.push({
      kind: 'count', id: 'auto:framing:dcrcs-concrete', category: 'framing',
      description: 'Concrete 60lb bag',
      specification: `${settings.concreteBagsPerFooting} per ${settings.footingSizeInches}″ footing`,
      quantity: postCount * Number(settings.concreteBagsPerFooting || 0),
      sourceObjectIds: beamIds, confidence: 'preliminary',
    });
  }

  /* The ledger, measured off the edges marked as running against the house. */
  const ledgerInches = ledgerLengthInches(document);
  if (ledgerInches > 0) {
    const ledgerFeet = ledgerInches / 12;
    descriptors.push({
      kind: 'count', id: 'auto:hardware:dcrcs-ledger-screw', category: 'hardware',
      description: 'Simpson SDWS 5″ timber screw',
      specification: `${settings.ledgerScrewsPerFoot} per foot · ${feet(ledgerInches)} lf of ledger`,
      quantity: Math.ceil(ledgerFeet * Number(settings.ledgerScrewsPerFoot || 0)),
      sourceObjectIds: [], confidence: 'preliminary',
    });
    descriptors.push({
      kind: 'purchase', id: 'auto:protection:dcrcs-j-flashing', category: 'protection',
      description: 'J flashing', specification: `${settings.ledgerFlashingStockFeet} ft length · full ledger run`,
      requiredLinearFeet: ledgerFeet, stockLengthFeet: settings.ledgerFlashingStockFeet,
      sourceObjectIds: [], confidence: 'preliminary', wastePercent: 0,
    });
  }

  return descriptors;
}
