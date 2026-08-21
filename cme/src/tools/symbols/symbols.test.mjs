import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument } from '../../core/document/project-document.js';
import {
  COUNT_MARKER_TYPE,
  DEFAULT_DOOR_WIDTH_INCHES,
  DEFAULT_GATE_WIDTH_INCHES,
  DEFAULT_WINDOW_WIDTH_INCHES,
  GATE_TYPE,
  TEXT_LABEL_TYPE,
  addSymbol,
  createCountMarker,
  createDoor,
  createGate,
  createTextLabel,
  createWindow,
  describeTakeoff,
  getCountMarkers,
  getDoors,
  getGateOpenings,
  getGates,
  getSymbols,
  getTextLabels,
  getWindows,
  nextSequence,
  removeSymbol,
} from './symbols.js';

const sequentialIds = () => {
  let count = 0;
  return (prefix) => `${prefix}-${(count += 1)}`;
};

const documentWith = (...symbols) => symbols.reduce((document, symbol) => addSymbol(document, symbol), createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' }));

const near = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected} ${message}`);

test('a text label is a note placed at a point, in inches', () => {
  const label = createTextLabel({ at: { x: 24, y: 36 }, text: '  verify header height on site  ' }, sequentialIds());
  assert.equal(label.type, TEXT_LABEL_TYPE);
  assert.equal(label.id, 'text-label-1');
  assert.equal(label.name, 'Text label');
  assert.deepEqual(label.at, { x: 24, y: 36 });
  assert.equal(label.text, 'verify header height on site');
  assert.equal(label.sizeInches, 6);
  assert.deepEqual(label.lifecycle, { phase: 'annotation', revision: 1 });
  assert.equal(createTextLabel({ at: { x: 0, y: 0 }, text: 'note', sizeInches: 12 }).sizeInches, 12);
});

test('the old tool widths are the defaults: a 3 ft gate, a 3 ft door, a 4 ft window', () => {
  assert.equal(DEFAULT_GATE_WIDTH_INCHES, 36);
  assert.equal(DEFAULT_DOOR_WIDTH_INCHES, 36);
  assert.equal(DEFAULT_WINDOW_WIDTH_INCHES, 48);
  assert.equal(createGate({ at: { x: 0, y: 0 } }).dimensions.widthInches, 36);
  assert.equal(createDoor({ at: { x: 0, y: 0 } }).dimensions.widthInches, 36);
  assert.equal(createWindow({ at: { x: 0, y: 0 } }).dimensions.widthInches, 48);
  // a UI clearing the width field sends null, and the old tool kept its stock width
  assert.equal(createGate({ at: { x: 0, y: 0 }, widthInches: null }).dimensions.widthInches, 36);
});

test('an opening spans its width across the wall, centred on where it was tapped', () => {
  const gate = createGate({ at: { x: 100, y: 50 } }, sequentialIds());
  assert.equal(gate.type, GATE_TYPE);
  assert.equal(gate.id, 'gate-1');
  assert.equal(gate.name, 'Gate');
  assert.equal(gate.angleRadians, 0);
  assert.deepEqual(gate.at, { x: 100, y: 50 });
  assert.deepEqual(gate.computed.start, { x: 82, y: 50 }, 'half the 36 in width back along the wall');
  assert.deepEqual(gate.computed.end, { x: 118, y: 50 });
  assert.deepEqual(gate.lifecycle, { phase: 'annotation', revision: 1 });

  const window = createWindow({ at: { x: 10, y: 10 }, angle: Math.PI / 2 });
  near(window.computed.start.x, 10);
  near(window.computed.start.y, -14);
  near(window.computed.end.y, 34, 'a quarter turn puts the 48 in span on the y axis');
});

test('each count label runs its own 1, 2, 3', () => {
  const idFactory = sequentialIds();
  const empty = createProjectDocument({ id: 'project' });
  assert.equal(nextSequence(empty, 'Lights'), 1);

  const withLights = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: 'Lights', seq: nextSequence(empty, 'Lights') }, idFactory),
  );
  assert.equal(nextSequence(withLights, 'Lights'), 2);
  assert.equal(nextSequence(withLights, 'Joist hangers'), 1, 'a new label starts over at one');

  const mixed = addSymbol(withLights, createCountMarker({ at: { x: 12, y: 0 }, label: 'Joist hangers', seq: 1 }, idFactory));
  assert.equal(nextSequence(mixed, 'Lights'), 2, 'a hanger pin does not renumber the lights');
  assert.equal(nextSequence(mixed, 'Joist hangers'), 2);
});

test('a blank label tallies with the Count pins beside it, the way the old tool named them', () => {
  const marker = createCountMarker({ at: { x: 0, y: 0 } }, sequentialIds());
  assert.equal(marker.type, COUNT_MARKER_TYPE);
  assert.equal(marker.label, 'Count');
  assert.equal(marker.name, 'Count', 'the object is named for what it counts');
  assert.equal(marker.seq, 1);

  const document = documentWith(marker, createCountMarker({ at: { x: 6, y: 0 }, label: '   ', seq: 2 }));
  assert.equal(nextSequence(document, ''), 3);
  const [line] = describeTakeoff(document);
  assert.equal(line.description, 'Count');
  assert.equal(line.quantity, 2, 'one row, not a blank row beside a Count row');
});

test('count markers bill one line per label, quantity being the pins dropped', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: 'Lights', seq: 1 }, idFactory),
    createCountMarker({ at: { x: 12, y: 0 }, label: 'Joist hangers', seq: 1 }, idFactory),
    createCountMarker({ at: { x: 24, y: 0 }, label: 'Lights', seq: 2 }, idFactory),
    createCountMarker({ at: { x: 36, y: 0 }, label: 'Lights', seq: 3 }, idFactory),
  );
  const lines = describeTakeoff(document);
  assert.equal(lines.length, 2);

  const [hangers, lights] = lines;
  assert.equal(hangers.description, 'Joist hangers', 'listed alphabetically, as the old tool listed its counts');
  assert.equal(hangers.quantity, 1);
  assert.deepEqual(hangers.sourceObjectIds, ['count-marker-2']);

  assert.equal(lights.kind, 'count');
  // slug plus a stable hash of the verbatim label - never dependent on what
  // else is on the drawing
  assert.match(lights.id, /^auto:custom:count:lights-[a-z0-9]+$/);
  assert.equal(lights.category, 'custom');
  assert.equal(lights.description, 'Lights');
  assert.equal(lights.specification, 'Counted on the drawing');
  assert.equal(lights.quantity, 3, 'three pins is three lights');
  assert.deepEqual(lights.sourceObjectIds, ['count-marker-1', 'count-marker-3', 'count-marker-4']);
  assert.equal(lights.requiredLinearFeet, undefined, 'a tally is never a lineal-feet buy');
  assert.equal(lights.stockLengthFeet, undefined);
});

test('the label reaches the estimator exactly as it was typed', () => {
  /* This is how a rep counts what the tool has never heard of, so the words are
     the whole content of the line - flattening them would lose the order. */
  const document = documentWith(createCountMarker({ at: { x: 0, y: 0 }, label: 'Simpson LUS28 hangers (2x8)', seq: 1 }, sequentialIds()));
  const [line] = describeTakeoff(document);
  assert.equal(line.description, 'Simpson LUS28 hangers (2x8)');
  assert.match(line.id, /^auto:custom:count:simpson-lus28-hangers-2x8-[a-z0-9]+$/);
});

test('two labels that flatten to the same id still get one line each', () => {
  // takeoff.js keys quantity overrides by line id: a duplicate id would let an
  // edit on one row silently rewrite the other.
  const idFactory = sequentialIds();
  const document = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: 'Post caps', seq: 1 }, idFactory),
    createCountMarker({ at: { x: 12, y: 0 }, label: 'post caps!', seq: 1 }, idFactory),
  );
  const lines = describeTakeoff(document);
  assert.equal(lines.length, 2);
  assert.deepEqual([...new Set(lines.map((line) => line.description))].sort(), ['Post caps', 'post caps!']);
  assert.equal(new Set(lines.map((line) => line.id)).size, 2, 'the ids must not collide');
  assert.ok(lines.every((line) => line.id.startsWith('auto:custom:count:post-caps')));
  assert.equal(new Set(lines.map((line) => line.id)).size, lines.length, 'every colliding label keeps a distinct id');
});

test('a label with nothing sluggable in it still gets a usable id', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: '???', seq: 1 }, idFactory),
    createCountMarker({ at: { x: 12, y: 0 }, label: 'Count', seq: 1 }, idFactory),
  );
  const lines = describeTakeoff(document);
  assert.equal(lines.length, 2);
  assert.equal(new Set(lines.map((line) => line.id)).size, 2);
  assert.ok(lines.every((line) => line.id.startsWith('auto:custom:count:count')));
});

test('a pin that lost its number is still counted', () => {
  // the old tool stripped seq on copy and drew the pasted pin as "1"
  const document = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: 'Lights', seq: 1 }, sequentialIds()),
    { id: 'count-marker-pasted', type: COUNT_MARKER_TYPE, name: 'Lights', at: { x: 12, y: 0 }, label: 'Lights' },
  );
  const [line] = describeTakeoff(document);
  assert.equal(line.quantity, 2, 'the tally counts pins, never the highest number written on one');
  assert.equal(createCountMarker({ at: { x: 0, y: 0 }, label: 'Lights' }).seq, 1);
});

test('text labels are notes and produce no material', () => {
  const document = documentWith(
    createTextLabel({ at: { x: 0, y: 0 }, text: 'client wants the gate on the north side' }, sequentialIds()),
  );
  assert.equal(getTextLabels(document).length, 1);
  assert.deepEqual(describeTakeoff(document), []);
});

test('gates, doors and windows each get a count row, the way the old tool listed them', () => {
  /* The first cut skipped these on the belief the old tool never billed them.
     It did - cad-sketch.js put door, window and gate in the takeoff counts bag
     next to Posts and Pillars - and a gate is a real thing to buy: a kit of
     hinges, latch and frame. */
  const idFactory = sequentialIds();
  const document = documentWith(
    createGate({ at: { x: 0, y: 0 } }, idFactory),
    createDoor({ at: { x: 60, y: 0 } }, idFactory),
    createWindow({ at: { x: 120, y: 0 } }, idFactory),
  );
  const lines = describeTakeoff(document);
  const byId = new Map(lines.map((line) => [line.id, line]));
  assert.equal(byId.get('auto:railing:gate').quantity, 1);
  assert.equal(byId.get('auto:railing:gate').confidence, 'review', 'a gate kit is priced by hand');
  assert.equal(byId.get('auto:custom:door').quantity, 1);
  assert.equal(byId.get('auto:custom:window').quantity, 1);
});

test('the gate openings are handed over for the railing to subtract', () => {
  const idFactory = sequentialIds();
  const gate = createGate({ at: { x: 100, y: 50 } }, idFactory);
  const document = documentWith(
    gate,
    createGate({ at: { x: 300, y: 50 }, widthInches: 48 }, idFactory),
    createDoor({ at: { x: 200, y: 50 } }, idFactory),
    createWindow({ at: { x: 250, y: 50 } }, idFactory),
  );
  const openings = getGateOpenings(document);
  assert.deepEqual(openings, [
    { id: 'gate-1', widthInches: 36, at: { x: 100, y: 50 } },
    { id: 'gate-2', widthInches: 48, at: { x: 300, y: 50 } },
  ], 'doors and windows are not holes in a railing');
  assert.notEqual(openings[0].at, gate.at, 'the caller gets a copy, not the stored point');
});

test('a gate deserialised without its dimensions is re-measured from its ends', () => {
  const document = documentWith({
    id: 'gate-legacy', type: GATE_TYPE, name: 'Gate', at: { x: 100, y: 50 },
    computed: { start: { x: 82, y: 50 }, end: { x: 118, y: 50 } },
  });
  assert.deepEqual(getGateOpenings(document), [{ id: 'gate-legacy', widthInches: 36, at: { x: 100, y: 50 } }]);
});

test('a gate with no usable width or position never reaches the railing', () => {
  /* Railing length minus NaN is NaN, and a railing run that quietly goes blank
     is far worse than one gate's worth of rail ordered over. */
  const document = documentWith(
    { id: 'gate-empty', type: GATE_TYPE, name: 'Gate' },
    { id: 'gate-no-width', type: GATE_TYPE, name: 'Gate', at: { x: 10, y: 10 } },
    { id: 'gate-no-point', type: GATE_TYPE, name: 'Gate', dimensions: { widthInches: 36 } },
  );
  assert.deepEqual(getGateOpenings(document), []);
});

test('an empty document produces no symbols and no material', () => {
  const document = createProjectDocument({ id: 'project' });
  assert.deepEqual(getSymbols(document), []);
  assert.deepEqual(getCountMarkers(document), []);
  assert.deepEqual(getGateOpenings(document), []);
  assert.deepEqual(describeTakeoff(document), []);
  assert.equal(nextSequence(document, 'Lights'), 1);
});

test('symbols live in the document and leave it when removed', () => {
  const idFactory = sequentialIds();
  const document = documentWith(
    createTextLabel({ at: { x: 0, y: 0 }, text: 'note' }, idFactory),
    createCountMarker({ at: { x: 12, y: 0 }, label: 'Lights', seq: 1 }, idFactory),
    createGate({ at: { x: 24, y: 0 } }, idFactory),
  );
  assert.equal(getSymbols(document).length, 3);

  const emptied = removeSymbol(document, 'count-marker-2');
  assert.equal(getCountMarkers(document).length, 1, 'the original document is untouched');
  assert.deepEqual(getCountMarkers(emptied), []);
  // the gate still bills its kit row; only the count pin's line is gone
  assert.deepEqual(describeTakeoff(emptied).map((line) => line.id), ['auto:railing:gate']);
});

test('a count line id never moves when a colliding label is deleted', () => {
  /* The id is what a user's quantity override is keyed by. The positional
     -2/-3 suffix scheme re-issued the bare slug to the surviving label when a
     colliding sibling's pins were deleted - and an override typed on the
     deleted row silently landed on a differently-described material. Ids are
     now a function of their own label alone. */
  const idFactory = sequentialIds();
  const both = documentWith(
    createCountMarker({ at: { x: 0, y: 0 }, label: 'Post caps', seq: 1 }, idFactory),
    createCountMarker({ at: { x: 12, y: 0 }, label: 'post caps!', seq: 1 }, idFactory),
  );
  const bothIds = new Map(describeTakeoff(both).map((line) => [line.description, line.id]));
  assert.notEqual(bothIds.get('Post caps'), bothIds.get('post caps!'), 'colliding labels get distinct ids');

  const survivorOnly = documentWith(
    createCountMarker({ at: { x: 12, y: 0 }, label: 'post caps!', seq: 1 }, sequentialIds()),
  );
  const aloneId = describeTakeoff(survivorOnly).find((line) => line.description === 'post caps!').id;
  assert.equal(aloneId, bothIds.get('post caps!'),
    'the survivor keeps ITS OWN id rather than inheriting the deleted label\'s - and its overrides');
});

test('remove only ever touches symbols', () => {
  // a caller passing the wrong id could otherwise delete a stair and hear nothing
  const document = addSymbol(
    { ...createProjectDocument({ id: 'project' }), objects: [{ id: 'stair-1', type: 'stair' }] },
    createGate({ at: { x: 0, y: 0 } }, sequentialIds()),
  );
  const unchanged = removeSymbol(document, 'stair-1');
  assert.equal(unchanged, document, 'the document is handed straight back');
  assert.equal(unchanged.objects.length, 2);
});

test('nothing handed in is ever mutated', () => {
  const idFactory = sequentialIds();
  const at = { x: 100, y: 50 };
  const gate = createGate({ at, widthInches: 36 }, idFactory);
  const marker = createCountMarker({ at: { x: 0, y: 0 }, label: 'Lights', seq: 1 }, idFactory);
  const gateSnapshot = structuredClone(gate);
  const markerSnapshot = structuredClone(marker);
  const document = createProjectDocument({ id: 'project', now: '2026-01-01T00:00:00.000Z' });
  const documentSnapshot = structuredClone(document);

  const added = addSymbol(addSymbol(document, gate), marker);
  const addedSnapshot = structuredClone(added);
  removeSymbol(added, gate.id);
  describeTakeoff(added);
  const openings = getGateOpenings(added);
  openings[0].at.x = -1;
  nextSequence(added, 'Lights');

  assert.deepEqual(at, { x: 100, y: 50 });
  assert.deepEqual(gate, gateSnapshot);
  assert.deepEqual(marker, markerSnapshot);
  assert.deepEqual(document, documentSnapshot);
  assert.deepEqual(added, addedSnapshot, 'even a caller editing an opening cannot reach the stored gate');
  assert.notEqual(added.objects, document.objects);
});

test('a symbol needs a real point, and an opening needs a real width', () => {
  assert.throws(() => createTextLabel({ at: { x: 0, y: 0 }, text: '   ' }), /needs some text/);
  assert.throws(() => createTextLabel({ text: 'note' }), /valid point/);
  assert.throws(() => createTextLabel({ at: { x: 0, y: 0 }, text: 'note', sizeInches: 0 }), /positive number of inches/);
  assert.throws(() => createCountMarker({ at: { x: Number.NaN, y: 0 } }), /valid point/);
  assert.throws(() => createGate({ at: { x: 0, y: 0 }, widthInches: 0 }), /positive number of inches/);
  assert.throws(() => createDoor({ at: { x: 0, y: 0 }, widthInches: 'wide' }), /positive number of inches/);
  assert.throws(() => createWindow({ at: { x: 0, y: 0 }, angle: 'sideways' }), /radians/);
  assert.throws(() => addSymbol(createProjectDocument({ id: 'project' }), { type: 'stair', id: 'stair-1' }), /symbol object/);
});
