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

export const FRAMING_SYSTEMS = ['dropped', 'flush'];
export const DEFAULT_FRAMING_SYSTEM = 'dropped';

/* Which system a beam is framed to, per beam with a project default — the same
   shape railingSystem() uses, and the reason a deck can freely mix the two.
   'dropped' is the standard: joists bear ON TOP of the beam.
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
export function deriveBeamGeometry(beam, standard = {}) {
  const ends = beamEndpoints(beam);
  if (!ends) return null;
  const length = distance(ends.start, ends.end);
  const layout = postLayout(length, standard.beamMaxPostSpacingFeet ?? 6);
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
    // an added post is the estimator's call and is worth showing as such
    postCountAdjusted: postCount > layout.postCount,
  };
}

export function deriveAllBeamGeometries(document, standard = {}) {
  return (document?.objects ?? [])
    .filter((object) => object.type === 'beam')
    .map((beam) => deriveBeamGeometry(beam, standard))
    .filter(Boolean);
}
