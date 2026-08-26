/* A beam's posts and footings are DERIVED, never stored.

   This mirrors the railing tool exactly, which is the pattern the owner asked
   for. deriveRailingLineGeometry computes its posts as {t, x, y} at read time
   and persists none of them, and that one decision removes a whole class of
   problem: move the run and the posts follow because they were never anywhere
   else; delete it and they cannot be left behind; nothing can drift out of
   step with what is drawn, because there is only one thing drawn.

   It also settles a question from earlier in this work. A stored parent-child
   model needed a rule for what happens to a hand-moved child when the parent
   changes. Derivation has no such case — the only editable things are the run
   and its settings, so there is nothing to reconcile.

   Human authority is kept the way railing keeps it: postCountOverride can only
   ADD posts, never take the layout below what the standard allows. */

import { distance } from '../../core/geometry/vector.js';
import { postLayout } from '../../core/standards/dcr-construction-standard.js';
import { maximumDeckBeamSpanFeet } from '../../core/standards/california-deck-beam-span.js';
import { normalizeBeamMaterial } from './beam.js';

export const FRAMING_SYSTEMS = ['bottom', 'flush'];
export const DEFAULT_FRAMING_SYSTEM = 'bottom';

/* Which system a beam is framed to, per beam with a project default — the same
   shape railingSystem() uses, and the reason a deck can freely mix the two.
   'bottom' is the standard: joists bear ON TOP of the beam.
   'flush'  : joists meet the beam in plane and hang off its face. */
export function framingSystem(beam, fallback = DEFAULT_FRAMING_SYSTEM) {
  const system = beam?.settings?.framingSystem;
  return FRAMING_SYSTEMS.includes(system) ? system : fallback;
}

export function beamEndpoints(beam) {
  const start = beam?.start;
  const end = beam?.end;
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return null;
  return { start, end };
}

/* Posts, evenly spaced along the run and never further apart than the standard
   allows, plus the footing that sits under each one. Returned as positions on
   the line, exactly as railing returns its posts. */
export function deriveBeamLoad(document, beam) {
  const ends = beamEndpoints(beam);
  if (!ends) return { joistSpanFeet: 6, loadedBothSides: false, source: 'default', reviewReason: 'Joist loading has not been established.' };
  const axis = { x: ends.end.x - ends.start.x, y: ends.end.y - ends.start.y };
  const sides = { positive: [], negative: [] };
  (document?.objects ?? []).filter((object) => object.type === 'joist').forEach((joist) => {
    (joist.layout?.bays ?? []).forEach((bay) => {
      const supportIds = [bay.startSupportId, bay.endSupportId].filter(Boolean);
      if (!supportIds.some((id) => id === beam.id || id.startsWith(`${beam.id}:`))) return;
      const midpoint = { x: (bay.start.x + bay.end.x) / 2, y: (bay.start.y + bay.end.y) / 2 };
      const relative = { x: midpoint.x - ends.start.x, y: midpoint.y - ends.start.y };
      const cross = axis.x * relative.y - axis.y * relative.x;
      const lengthInches = Number(bay.lengthInches) || distance(bay.start, bay.end);
      if (cross >= 0) sides.positive.push(lengthInches); else sides.negative.push(lengthInches);
    });
  });
  const positive = Math.max(0, ...sides.positive);
  const negative = Math.max(0, ...sides.negative);
  if (!positive && !negative) return { joistSpanFeet: 6, loadedBothSides: false, source: 'default', reviewReason: 'Joist loading has not been established.' };
  const loadedBothSides = positive > 0 && negative > 0;
  return {
    joistSpanFeet: (positive + negative) / 12,
    sideSpansFeet: { positive: positive / 12, negative: negative / 12 },
    loadedBothSides,
    source: 'joist-field',
    reviewReason: loadedBothSides ? 'Beam receives joists from both sides; post layout uses the combined tributary span.' : null,
  };
}

export function deriveBeamGeometry(beam, standard = {}, load = null) {
  const ends = beamEndpoints(beam);
  if (!ends) return null;
  const length = distance(ends.start, ends.end);
  const material = normalizeBeamMaterial(beam.material, beam.size);
  const beamLoad = load ?? { joistSpanFeet: Number(beam?.settings?.designJoistSpanFeet) || 6, loadedBothSides: false, source: 'default', reviewReason: 'Joist loading has not been established.' };
  const tablePreset = material.construction === 'solid' ? material.equivalentPreset : material.preset;
  const tableMaximum = maximumDeckBeamSpanFeet(tablePreset, beamLoad.joistSpanFeet);
  const maximumPostSpacingFeet = tableMaximum ?? (Number(standard.beamMaxPostSpacingFeet) || 6);
  const layout = postLayout(length, maximumPostSpacingFeet);
  if (!layout.postCount) return null;

  // the estimator may add posts; the standard sets the floor, never the ceiling
  const requested = Number(beam?.settings?.postCountOverride);
  const postCount = Number.isFinite(requested) ? Math.max(layout.postCount, Math.floor(requested)) : layout.postCount;
  const spans = postCount - 1;
  const spacingInches = spans > 0 ? length / spans : 0;

  const posts = Array.from({ length: postCount }, (_, index) => {
    const t = spans > 0 ? index / spans : 0;
    return {
      t,
      index,
      x: ends.start.x + (ends.end.x - ends.start.x) * t,
      y: ends.start.y + (ends.end.y - ends.start.y) * t,
    };
  });

  return {
    beam,
    start: ends.start,
    end: ends.end,
    length,
    system: framingSystem(beam, standard.framingSystem),
    spans,
    spacingInches,
    minimumPostCount: layout.postCount,
    postCount,
    posts,
    footingSizeInches: Number(standard.footingSizeInches) || 16,
    load: beamLoad,
    spanReference: {
      code: '2025 CRC R507.5(1)',
      tablePreset,
      maximumPostSpacingFeet,
      prescriptive: material.construction === 'built-up' && Boolean(tableMaximum) && !beamLoad.loadedBothSides && beamLoad.source === 'joist-field',
      engineeringReview: material.construction !== 'built-up' || !tableMaximum || beamLoad.loadedBothSides || beamLoad.source !== 'joist-field',
      reasons: [
        material.construction === 'solid' ? `${material.widthInches}×${material.depthInches} solid beam is laid out as equivalent to ${tablePreset}, pending engineering review.` : null,
        !tableMaximum ? 'Joist loading is outside the 6–18 ft prescriptive table.' : null,
        beamLoad.reviewReason,
      ].filter(Boolean),
    },
    // an added post is the estimator's call and is worth showing as such
    postCountAdjusted: postCount > layout.postCount,
  };
}

export function deriveAllBeamGeometries(document, standard = {}) {
  return (document?.objects ?? [])
    .filter((object) => object.type === 'beam')
    .map((beam) => deriveBeamGeometry(beam, standard, deriveBeamLoad(document, beam)))
    .filter(Boolean);
}
