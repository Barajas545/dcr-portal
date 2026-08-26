/* The seams of the CME merge.

   These pin the places where the Portal's own recipes meet the upstream
   engine — every one of them was silently dropped at some point during the
   integration and found by reading, not by a crash. They exist so the next
   merge cannot quietly lose them again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, upsertObject } from '../../core/document/project-document.js';
import { createDeckBoundary, setEdgeRole } from '../deck-boundary/deck-boundary.js';
import { createBeam, addBeam } from '../beam/beam.js';
import { createPost, addPost } from '../post-footing/post-footing.js';
import { createRailingLine, deriveRailingLineGeometry } from '../railing/railing.js';
import { getRailingRuns } from '../railing/railing-systems.js';
import { createCountMarker, createGate } from '../symbols/symbols.js';
import { deriveAutomaticTakeoff, getEffectiveTakeoffLines, setTakeoffNote, consolidateTakeoffLines } from './takeoff.js';

const ids = () => { let n = 0; return (p) => `${p}-${(n += 1)}`; };
const rect = (w, h) => createDeckBoundary([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
const deck = (w = 240, h = 144) => upsertObject(createProjectDocument({ id: 'p' }), rect(w, h));
const byId = (lines, id) => lines.find((line) => line.id === id);
const anchor = (x, y) => ({ snapType: 'grid', point: { x, y } });

test('a ledger brings its fasteners, not just its board', () => {
  /* The upstream ledger module plans the board and stops; the screws and
     flashing were the owner's spec and lived in the retired framing-standard.
     Between the two, an order came out with a ledger and nothing to hang it. */
  let boundary = rect(240, 144);
  boundary = setEdgeRole(boundary, boundary.edges[0].id, 'house');
  const lines = deriveAutomaticTakeoff(upsertObject(createProjectDocument({ id: 'p' }), boundary));

  const board = lines.find((line) => /ledger/i.test(line.id) && /ledger$/i.test(line.description));
  assert.ok(board, 'the ledger board is ordered');

  const screws = byId(lines, 'auto:hardware:ledger-sdws-5');
  assert.ok(screws, 'the SDWS screws are ordered');
  assert.equal(screws.unit, 'box', 'ordered in whole boxes');
  // 20 lf at 5 a foot is 100 screws; 50 to a box is 2 boxes
  assert.equal(screws.quantity, 2);
  assert.match(screws.specification, /100 needed/);

  const flashing = byId(lines, 'auto:protection:ledger-j-flashing');
  assert.ok(flashing, 'the J flashing is ordered');
  assert.equal(flashing.quantity, 2, '20 lf off 10 ft lengths');
});

test('ledger fasteners do not wait for a deck level to be set', () => {
  /* They used to be gated behind the DCR standard being switched on, so any
     drawing without a primary deck level ordered zero of them. */
  let boundary = rect(120, 96);
  boundary = setEdgeRole(boundary, boundary.edges[0].id, 'house');
  const document = upsertObject(createProjectDocument({ id: 'p' }), boundary);
  assert.equal(document.construction?.deckLevelInches ?? null, null, 'no level is set');
  assert.ok(byId(deriveAutomaticTakeoff(document), 'auto:hardware:ledger-sdws-5'), 'screws are still ordered');
});

test('a beam is counted once, not once by each planner', () => {
  /* Upstream moved stock planning into beam.js while the Portal still had it
     in framing-standard. Both ran, and a 24 ft run ordered four 12 ft boards. */
  const factory = ids();
  let document = deck(288, 168);
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 288, y: 0 } }, factory));
  const beamLines = deriveAutomaticTakeoff(document).filter((line) => /beam/i.test(line.id));
  assert.equal(beamLines.length, 1, 'exactly one beam line');
  assert.equal(beamLines[0].quantity, 2, 'two 12 ft boards for a 24 ft run');
});

test('a post drawn on a beam end is one post, not two', () => {
  const factory = ids();
  let document = deck(288, 168);
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 288, y: 0 } }, factory));
  const withoutExplicit = byId(deriveAutomaticTakeoff(document), 'auto:hardware:post-base').quantity;
  document = addPost(document, createPost({ at: { x: 0, y: 0 } }, factory));
  const withExplicit = byId(deriveAutomaticTakeoff(document), 'auto:hardware:post-base').quantity;
  assert.equal(withExplicit, withoutExplicit, 'the coincident post does not add a base');
});

test('Wild Hog is bought as it is sold: track kits and run-planned handrail', () => {
  const factory = ids();
  let document = deck(240, 144);
  document = upsertObject(document, createRailingLine(anchor(0, 0), anchor(112, 0), { system: 'wild-hog' }, factory));
  const geometries = getRailingRuns(document).map((run) =>
    deriveRailingLineGeometry(run, run.anchors.start.point, run.anchors.end.point));
  const lines = deriveAutomaticTakeoff(document, { railingGeometries: geometries });

  const track = byId(lines, 'auto:railing:wild-hog-track');
  assert.match(track.description, /Hog Track Kit/, 'a kit, not aluminium by the foot');
  assert.equal(track.quantity, byId(lines, 'auto:railing:wild-hog-panel').quantity, 'one kit per panel');

  // 9'4" of run: one 10 ft handrail, not two 8-footers cut down
  const handrail = lines.filter((line) => line.id.startsWith('auto:railing:wild-hog-handrail'));
  assert.equal(handrail.length, 1);
  assert.equal(handrail[0].stockLengthFeet, 10);
  assert.equal(handrail[0].quantity, 1);
});

test('the Portal-only sources still reach the material list', () => {
  /* Upstream has no count pins, no gates and no railing system but Wild Hog.
     Adopting its takeoff dropped all of them until the wiring was put back. */
  const factory = ids();
  let document = deck(240, 144);
  document = upsertObject(document, createCountMarker({ at: { x: 40, y: 40 }, label: 'Post caps', seq: 1 }, factory));
  document = upsertObject(document, createGate({ at: { x: 60, y: 0 } }, factory));
  document = upsertObject(document, createRailingLine(anchor(0, 0), anchor(240, 0), { system: 'stick-built' }, factory));
  const geometries = getRailingRuns(document).map((run) =>
    deriveRailingLineGeometry(run, run.anchors.start.point, run.anchors.end.point));
  const lines = deriveAutomaticTakeoff(document, { railingGeometries: geometries });

  assert.ok(lines.some((line) => line.description === 'Post caps'), 'the count pin reaches the estimator verbatim');
  assert.ok(byId(lines, 'auto:railing:gate'), 'the gate is billed as a kit');
  assert.ok(lines.some((line) => line.id.startsWith('auto:railing:stick-')), 'stick-built railing is billed');
});

test('a note rides with its line, and the calculation explains itself', () => {
  const factory = ids();
  let document = deck(288, 168);
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 288, y: 0 } }, factory));
  const stock = byId(deriveAutomaticTakeoff(document), 'auto:framing:post-stock');
  assert.ok(stock, 'posts are planned from stock');

  document = setTakeoffNote(document, stock.id, 'Cut on site, keep the offcut.');
  const line = byId(getEffectiveTakeoffLines(document), stock.id);
  assert.equal(line.note, 'Cut on site, keep the offcut.');
  assert.match(line.calcNote, /cuts needed/, 'the arithmetic explains itself');
});

test('the purchasing view groups identical stock across construction roles', () => {
  const consolidated = consolidateTakeoffLines([
    { id: 'a', category: 'framing', description: '2×6 PT ledger', specification: '16 ft stock', quantity: 1, unit: 'ea', stockLengthFeet: 16, sourceObjectIds: [] },
    { id: 'b', category: 'framing', description: '2×6 PT joist blocking', specification: '16 ft stock', quantity: 2, unit: 'ea', stockLengthFeet: 16, sourceObjectIds: [] },
    { id: 'c', category: 'framing', description: '2×6 PT rim joist', specification: '16 ft stock', quantity: 3, unit: 'ea', stockLengthFeet: 16, sourceObjectIds: [] },
    { id: 'd', category: 'hardware', description: 'Joist hanger', specification: 'Both ends', quantity: 8, unit: 'ea', stockLengthFeet: null, sourceObjectIds: [] },
  ]);
  const lumber = consolidated.find((line) => /2×6 PT/.test(line.description));
  assert.equal(lumber.quantity, 6, 'one order line for six identical boards');
  assert.equal(lumber.origin, 'consolidated');
  assert.ok(consolidated.some((line) => line.description === 'Joist hanger'), 'non-lumber is left alone');
  assert.equal(consolidated.length, 2, 'three roles collapse to one purchase line, plus the hanger');
});
