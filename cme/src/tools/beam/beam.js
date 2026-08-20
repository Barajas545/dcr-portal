import { upsertObject } from '../../core/document/project-document.js';
import { distance } from '../../core/geometry/vector.js';

export const BEAM_TYPE = 'beam';
export const BEAM_SCHEMA_VERSION = 1;
export const BEAM_STOCK_LENGTH_FEET = 16;
const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const point = (value) => ({ x: Number(value?.x), y: Number(value?.y) });
/* Re-measure when the stored length is missing. A beam deserialised from an
   older save, or hand-built by a caller, has endpoints but no computed block;
   trusting computed alone made it contribute nothing and quietly vanish from
   the material list, which is the worst way to be wrong about lumber. */
const beamLength = (beam) => {
  const stored = Number(beam?.computed?.lengthInches);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const measured = distance(point(beam?.start), point(beam?.end));
  return Number.isFinite(measured) ? measured : 0;
};

function resolveEndpoints(start, end) {
  const first = point(start);
  const second = point(end);
  if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) throw new Error('A beam requires two valid points.');
  if (distance(first, second) < 1e-6) throw new Error('Beam endpoints must be different.');
  return { start: first, end: second };
}

export function createBeam({ start, end, size, name } = {}, idFactory = defaultId) {
  const endpoints = resolveEndpoints(start, end);
  return {
    type: BEAM_TYPE,
    schemaVersion: BEAM_SCHEMA_VERSION,
    id: idFactory('beam'),
    name: name ?? 'Beam',
    ...endpoints,
    // A label the estimator chooses on the drawing. CME never derives a beam size:
    // the tool this replaces had no span tables and the owner keeps it that way.
    size: String(size ?? '').trim(),
    computed: { lengthInches: distance(endpoints.start, endpoints.end) },
    lifecycle: { phase: 'established', revision: 1 },
  };
}

export function addBeam(document, beam) {
  if (beam?.type !== BEAM_TYPE) throw new Error('A beam construction object is required.');
  return upsertObject(document, beam);
}

export function updateBeam(document, beamId, patch = {}) {
  const beam = getBeams(document).find((object) => object.id === beamId);
  if (!beam) throw new Error('Beam was not found.');
  const endpoints = resolveEndpoints(patch.start ?? beam.start, patch.end ?? beam.end);
  return upsertObject(document, {
    ...beam,
    ...endpoints,
    // ?? not === undefined: a UI clearing a field sends null, and String(null)
    // wrote the literal text "null" onto the takeoff line as "2x10 · null"
    name: patch.name === undefined ? beam.name : String(patch.name ?? 'Beam'),
    size: patch.size === undefined ? beam.size : String(patch.size ?? '').trim(),
    computed: { ...beam.computed, lengthInches: distance(endpoints.start, endpoints.end) },
    lifecycle: { ...beam.lifecycle, revision: (beam.lifecycle?.revision ?? 1) + 1 },
  });
}

export function removeBeam(document, beamId) {
  return {
    ...document,
    updatedAt: new Date().toISOString(),
    objects: document.objects.filter((object) => !(object.type === BEAM_TYPE && object.id === beamId)),
  };
}

export function getBeams(document) {
  return document.objects.filter((object) => object.type === BEAM_TYPE);
}

/* One piece per beam drawn.

   This deliberately does NOT buy lineal feet off a stock length. Ordering
   Math.ceil(totalLF / 16) sticks assumes the offcut from one beam becomes the
   next beam, which is not how a beam is cut - three 8 ft beams need three
   boards, not two. The tool this replaces counted the beams on the drawing and
   left the size to the estimator, and that is the behaviour being preserved.
   Waste is deliberately absent for the same reason: the old tool applied it
   only to decking and fascia. */
export function describeTakeoff(document) {
  const beams = getBeams(document);
  if (!beams.length) return [];
  const lengthInches = beams.reduce((sum, beam) => sum + beamLength(beam), 0);
  // The sizes are the labels the user typed, echoed so the estimator sees the choice;
  // with nothing typed the stock length is all the drawing can honestly say.
  const sizes = [...new Set(beams.map((beam) => beam.size).filter(Boolean))];
  const totalFeet = Math.round((lengthInches / 12) * 10) / 10;
  return [{
    kind: 'count',
    id: 'auto:framing:beam',
    category: 'framing',
    description: 'Beam (size to span)',
    // the spans are what tells the estimator which size to pull
    specification: sizes.length ? sizes.join(' · ') : `${beams.length} drawn · ${totalFeet} lf total`,
    quantity: beams.length,
    sourceObjectIds: beams.map((beam) => beam.id),
    confidence: 'preliminary',
  }];
}
