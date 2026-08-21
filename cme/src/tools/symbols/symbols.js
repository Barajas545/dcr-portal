import { distance, point } from '../../core/geometry/vector.js';
import { upsertObject } from '../../core/document/project-document.js';

export const TEXT_LABEL_TYPE = 'text-label';

/* A document handed in from a save, a test, or a half-built state may have
   no objects array at all. Reading through a helper keeps every getter from
   throwing a raw TypeError at a caller that only asked what was on the
   drawing. */
const objectsOf = (document) => (Array.isArray(document?.objects) ? document.objects : []);

export const COUNT_MARKER_TYPE = 'count-marker';
export const GATE_TYPE = 'gate';
export const DOOR_TYPE = 'door';
export const WINDOW_TYPE = 'window';
export const SYMBOL_SCHEMA_VERSION = 1;
export const DEFAULT_COUNT_LABEL = 'Count';
export const DEFAULT_GATE_WIDTH_INCHES = 36;
export const DEFAULT_DOOR_WIDTH_INCHES = 36;
export const DEFAULT_WINDOW_WIDTH_INCHES = 48;
/* The old tool drew notes at a fixed 14px on screen, so there is no world height
   to port. Six inches keeps a note readable beside a 5.5 in deck board without
   burying it. */
export const DEFAULT_TEXT_SIZE_INCHES = 6;

export const OPENING_TYPES = [GATE_TYPE, DOOR_TYPE, WINDOW_TYPE];
export const SYMBOL_TYPES = [TEXT_LABEL_TYPE, COUNT_MARKER_TYPE, ...OPENING_TYPES];

const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function symbolPoint(at, what) {
  if (![at?.x, at?.y].every(Number.isFinite)) throw new Error(`${what} must be placed at a valid point.`);
  return point(at.x, at.y);
}

/* The old tool wrote "Count" whenever the rep left the prompt empty
   (cad-sketch.js:1384). The pin numbering and the takeoff both go through here
   so they agree on that: a blank label must tally with the "Count" pins sitting
   right next to it, not open a second row of its own. */
const resolveLabel = (label) => String(label ?? '').trim() || DEFAULT_COUNT_LABEL;

export function createTextLabel({ at, text, sizeInches, name } = {}, idFactory = defaultId) {
  const anchor = symbolPoint(at, 'Text label');
  const body = String(text ?? '').trim();
  // The old tool dropped nothing when the prompt came back empty; an invisible
  // note object that can still be selected and dragged is only ever a nuisance.
  if (!body) throw new Error('A text label needs some text.');
  const height = Number(sizeInches ?? DEFAULT_TEXT_SIZE_INCHES);
  if (!Number.isFinite(height) || height <= 0) throw new Error('Text size must be a positive number of inches.');
  return {
    type: TEXT_LABEL_TYPE,
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    id: idFactory('text-label'),
    name: name ?? 'Text label',
    at: anchor,
    text: body,
    sizeInches: height,
    lifecycle: { phase: 'annotation', revision: 1 },
  };
}

/* seq is the number painted in the pin, nothing more. The tally counts marker
   objects, never the highest seq, so a pin that arrives without a number - the
   old tool stripped seq on copy (cad-sketch.js:1330) - or two pins that end up
   sharing one is a cosmetic problem and can never move a quantity. */
export function createCountMarker({ at, label, seq, name } = {}, idFactory = defaultId) {
  const anchor = symbolPoint(at, 'Count marker');
  const tally = resolveLabel(label);
  const numbered = Math.round(Number(seq));
  return {
    type: COUNT_MARKER_TYPE,
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    id: idFactory('count-marker'),
    // named for what it counts, which is how the old tool listed them
    name: name ?? tally,
    at: anchor,
    label: tally,
    seq: Number.isFinite(numbered) && numbered > 0 ? numbered : 1,
    lifecycle: { phase: 'annotation', revision: 1 },
  };
}

/* The seq the next pin of this label should carry: the old tool counted the pins
   already wearing that label and added one (cad-sketch.js:1385), so every label
   runs its own 1, 2, 3 and dropping a "Lights" pin never renumbers the gates. */
export function nextSequence(document, label) {
  const wanted = resolveLabel(label);
  return getCountMarkers(document).filter((marker) => resolveLabel(marker.label) === wanted).length + 1;
}

/* The parameter is `angle` because that is what the drawing tool hands over; it
   is stored as angleRadians because everything in core/geometry is radians and
   an unlabelled angle is how degrees get in by mistake. No wall to align to
   means flat, which is the fallback direction the old tool used
   (cad-sketch.js:290). */
function openingAngle(angle) {
  if (angle === undefined || angle === null) return 0;
  const radians = Number(angle);
  if (!Number.isFinite(radians)) throw new Error('A symbol angle must be a number of radians.');
  return radians;
}

function createOpening(type, what, widthInches, { at, angle, name } = {}, idFactory = defaultId) {
  const centre = symbolPoint(at, what);
  const width = Number(widthInches);
  if (!Number.isFinite(width) || width <= 0) throw new Error(`${what} width must be a positive number of inches.`);
  const angleRadians = openingAngle(angle);
  const half = width / 2;
  const run = point(Math.cos(angleRadians) * half, Math.sin(angleRadians) * half);
  return {
    type,
    schemaVersion: SYMBOL_SCHEMA_VERSION,
    id: idFactory(type),
    name: name ?? what,
    at: centre,
    dimensions: { widthInches: width },
    angleRadians,
    /* Both ends are stored because an opening is drawn and hit-tested as a span
       across the wall, the way the old tool kept its two pts. They are plain x/y
       pairs so the shared move path carries them along with the symbol. */
    computed: { start: point(centre.x - run.x, centre.y - run.y), end: point(centre.x + run.x, centre.y + run.y) },
    lifecycle: { phase: 'annotation', revision: 1 },
  };
}

// ?? and not a destructuring default: a UI clearing the width field sends null,
// and the old tool always had its stock width to fall back on.
export function createGate({ at, widthInches, angle, name } = {}, idFactory = defaultId) {
  return createOpening(GATE_TYPE, 'Gate', widthInches ?? DEFAULT_GATE_WIDTH_INCHES, { at, angle, name }, idFactory);
}

export function createDoor({ at, widthInches, angle, name } = {}, idFactory = defaultId) {
  return createOpening(DOOR_TYPE, 'Door', widthInches ?? DEFAULT_DOOR_WIDTH_INCHES, { at, angle, name }, idFactory);
}

export function createWindow({ at, widthInches, angle, name } = {}, idFactory = defaultId) {
  return createOpening(WINDOW_TYPE, 'Window', widthInches ?? DEFAULT_WINDOW_WIDTH_INCHES, { at, angle, name }, idFactory);
}

// All five ride one add and remove path: they are the same family of placed
// annotation, differing only in what gets drawn.
export function addSymbol(document, symbol, now = new Date().toISOString()) {
  if (!SYMBOL_TYPES.includes(symbol?.type)) throw new Error('Only a symbol object can be added here.');
  return upsertObject(document, symbol, now);
}

/* Scoped to symbols on purpose, the way removePost is: a caller passing the
   wrong id could otherwise delete a deck boundary or a stair through the symbol
   API and never hear about it. */
export function removeSymbol(document, symbolId, now = new Date().toISOString()) {
  const target = document.objects.find((object) => object.id === symbolId);
  if (!target || !SYMBOL_TYPES.includes(target.type)) return document;
  return { ...document, updatedAt: now, objects: objectsOf(document).filter((object) => object.id !== symbolId) };
}

export function getSymbols(document) {
  return objectsOf(document).filter((object) => SYMBOL_TYPES.includes(object.type));
}

export function getTextLabels(document) {
  return objectsOf(document).filter((object) => object.type === TEXT_LABEL_TYPE);
}

export function getCountMarkers(document) {
  return objectsOf(document).filter((object) => object.type === COUNT_MARKER_TYPE);
}

export function getGates(document) {
  return objectsOf(document).filter((object) => object.type === GATE_TYPE);
}

export function getDoors(document) {
  return objectsOf(document).filter((object) => object.type === DOOR_TYPE);
}

export function getWindows(document) {
  return objectsOf(document).filter((object) => object.type === WINDOW_TYPE);
}

/* Re-measure when the stored width is missing. An opening deserialised from an
   older save, or hand-built by a caller, has its two ends but no dimensions
   block, and trusting dimensions alone dropped it out of the railing subtraction
   with nothing said. */
function openingWidth(opening) {
  const stored = Number(opening?.dimensions?.widthInches);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const { start, end } = opening?.computed ?? {};
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return 0;
  return distance(start, end);
}

/* A gate is not billed - it is a hole in the railing. This is what the railing
   run subtracts (cad-sketch.js:1018), handed over as plain numbers so nothing
   there has to know what a symbol object looks like. */
export function getGateOpenings(document) {
  return getGates(document)
    /* The raw values are tested BEFORE point() coerces them. Number(null) is 0,
       so a gate deserialised with at:{x:null,y:null} used to arrive as a real
       gate standing at the drawing origin: its width came off whichever railing
       happened to be nearest 0,0 and the run it actually belongs to stayed full
       length. One run short, one run long, and nothing said so. */
    .filter((gate) => [gate.at?.x, gate.at?.y].every(Number.isFinite))
    .map((gate) => ({ id: gate.id, widthInches: openingWidth(gate), at: point(gate.at?.x, gate.at?.y) }))
    /* A gate with no usable width or position is left out entirely rather than
       passed on: railing length minus NaN is NaN, and a railing run that quietly
       goes blank is far worse than one gate's worth of rail ordered over. */
    .filter((opening) => opening.widthInches > 0 && Number.isFinite(opening.at.x) && Number.isFinite(opening.at.y));
}

/* NFKD splits an accented letter into the plain one plus its mark, so dropping
   everything outside printable ASCII folds the accent instead of turning it into
   a dash: a label of "Balaustres" with accents still slugs to balaustres. Only
   the id is flattened - the label itself reaches the estimator untouched. */
const slugify = (label) => label.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* Two labels can slug to the same text - "Post caps" and "post caps!" both give
   post-caps - and takeoff.js keys its quantity overrides by line id, so a
   duplicate would let an edit on one row silently rewrite the other. The suffix
   comes off the sorted label list and never off drawing order, so the id a label
   holds does not move when a pin elsewhere is dropped. */
/* A takeoff line's id is what a user's quantity override is keyed by, so the
   id a label holds must depend on NOTHING but that label. Two earlier schemes
   failed this: positional -2/-3 suffixes re-issued the bare slug to a surviving
   label when a colliding sibling was deleted, and a collision-conditional hash
   changed the id the moment a colliding label appeared. Either way a human
   adjustment silently landed on a differently-described material.

   So the short hash of the verbatim label is ALWAYS part of the id - a pure
   function of the label, stable whatever else is on the drawing, identical on
   every machine. Renaming a label changes its id, which is correct: a renamed
   tally is a different material, and its overrides should not follow. */
function labelHash(label) {
  let hash = 5381;
  for (let index = 0; index < label.length; index += 1) {
    hash = ((hash << 5) + hash + label.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36).slice(0, 6);
}

function takeoffIds(labels) {
  return new Map(labels.map((label) => {
    const slug = slugify(label) || 'count';
    return [label, `auto:custom:count:${slug}-${labelHash(label)}`];
  }));
}

/* Count markers, plus one count row each for gates, doors and windows.

   Text labels are notes and produce nothing. Openings DO bill a count - the
   old tool listed Gates, Doors and Windows next to Posts and Pillars, and a
   gate is a real kit to buy. A gate's width-out-of-the-railing behaviour is
   separate and stays in getGateOpenings.

   Every other line in the takeoff is a material this tool knows something about.
   These are the opposite - they are how a rep counts whatever the tool has never
   heard of, lights or joist hangers or balusters - so the label goes through to
   the description verbatim and no quantity is derived from anything but the
   number of pins dropped. */
export function describeTakeoff(document) {
  const markers = getCountMarkers(document);
  /* Gates, doors and windows each get a count row - the tool this replaced
     listed those tallies next to Posts and Pillars, and a gate is a real thing
     to buy (a kit: hinges, latch, frame), so a silent zero understates the
     order. Their width-out-of-the-railing behaviour is separate and stays in
     getGateOpenings. These come FIRST so they cannot be skipped when there are
     openings but no count pins. */
  const openingRows = [
    { type: GATE_TYPE, id: 'auto:railing:gate', category: 'railing', description: 'Gate', spec: 'kit · priced by hand', confidence: 'review' },
    { type: DOOR_TYPE, id: 'auto:custom:door', category: 'custom', description: 'Door', spec: 'count only' },
    { type: WINDOW_TYPE, id: 'auto:custom:window', category: 'custom', description: 'Window', spec: 'count only' },
  ].map((row) => {
    const found = objectsOf(document).filter((object) => object.type === row.type);
    if (!found.length) return null;
    return {
      kind: 'count', id: row.id, category: row.category, description: row.description,
      specification: row.spec, quantity: found.length,
      sourceObjectIds: found.map((object) => object.id),
      ...(row.confidence ? { confidence: row.confidence } : {}),
    };
  }).filter(Boolean);

  if (!markers.length) return openingRows;
  const groups = new Map();
  markers.forEach((marker) => {
    const label = resolveLabel(marker.label);
    const group = groups.get(label);
    if (group) group.push(marker.id);
    else groups.set(label, [marker.id]);
  });
  // Alphabetical with a FIXED locale: the order the old tool listed count rows
  // in, and one that is the same on every machine. The runtime's default locale
  // could order case-variant labels differently on two devices, which mattered
  // when ids were positional; the ids no longer depend on order, but a stable
  // listing is still the professional behaviour.
  const labels = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const ids = takeoffIds(labels);
  return openingRows.concat(labels.map((label) => ({
    kind: 'count',
    id: ids.get(label),
    category: 'custom',
    description: label,
    specification: 'Counted on the drawing',
    quantity: groups.get(label).length,
    sourceObjectIds: groups.get(label),
  })));
}
