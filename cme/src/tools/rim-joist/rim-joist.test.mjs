import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectDocument, upsertObject } from '../../core/document/project-document.js';
import { createDeckBoundary } from '../deck-boundary/deck-boundary.js';
import { createRimJoistProperty, describeRimJoistTakeoff, normalizeRimJoist, rimJoistLabel } from './rim-joist.js';

const ids = (() => { let next = 0; return (prefix) => `${prefix}-${++next}`; })();

function documentWithRim(lengthInches, rim) {
  const boundary = createDeckBoundary([{ x: 0, y: 0 }, { x: lengthInches, y: 0 }, { x: lengthInches, y: 96 }, { x: 0, y: 96 }], {}, ids);
  boundary.edges[0].properties.attachments.rimJoist = rim;
  return { boundary, document: upsertObject(createProjectDocument({ id: 'rim-project' }), boundary) };
}

test('a Rim Joist / Flush Beam defaults to a single 2x6 PT member', () => {
  const rim = createRimJoistProperty();
  assert.equal(rimJoistLabel(rim), '2×6 PT');
  assert.equal(rim.plyCount, 1);
  assert.equal(normalizeRimJoist(null).enabled, false);
});

test('a double Rim Joist doubles every commercial stock piece in Takeoff', () => {
  const { boundary, document } = documentWithRim(243, createRimJoistProperty({ plyCount: 2 }));
  const lines = describeRimJoistTakeoff(document);
  assert.deepEqual(lines.map((line) => [line.specification, line.quantity]), [['10 ft stock · double joist', 2], ['12 ft stock · double joist', 2]]);
  assert.ok(lines.every((line) => line.description === '2×6 PT rim joist / flush beam'));
  assert.ok(lines.every((line) => line.sourceObjectIds[0] === boundary.edges[0].id));
});

test('custom Rim Joist material remains structured and reaches Takeoff', () => {
  const custom = createRimJoistProperty({ preset: 'custom', customLabel: '3×12 DF #1', plyCount: 1 });
  const { document } = documentWithRim(120, custom);
  const [line] = describeRimJoistTakeoff(document);
  assert.equal(line.description, '3×12 DF #1 rim joist / flush beam');
  assert.equal(line.specification, '10 ft stock · single joist');
});
