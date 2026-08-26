import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../../core/document/project-document.js';
import { addBeam, createBeam } from '../beam/beam.js';
import { addJoist, createJoist } from '../joist-group/joist-group.js';
import { addPost, createPost } from '../post-footing/post-footing.js';
import { deriveAutomaticTakeoff } from './takeoff.js';

test('framing takeoff emits only the commercial stock required by the drawn Beam', () => {
  let document = createProjectDocument({ id: 'project' });
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }, () => 'beam-1'));
  const lines = deriveAutomaticTakeoff(document);
  const beams = lines.filter((line) => line.id.startsWith('auto:framing:beam:'));
  assert.equal(beams.length, 1);
  assert.equal(beams[0].quantity, 1);
  assert.equal(beams[0].description, '4×6 PT beam');
  assert.equal(beams[0].specification, '10 ft stock');
  assert.equal(beams[0].stockLengthFeet, 10);
});

test('beam-derived and explicit coincident posts are deduplicated', () => {
  let document = createProjectDocument({ id: 'project' });
  document = addBeam(document, createBeam({ start: { x: 0, y: 0 }, end: { x: 120, y: 0 } }, () => 'beam-1'));
  document = addPost(document, createPost({ at: { x: 0, y: 0 } }, () => 'post-1'));
  const lines = deriveAutomaticTakeoff(document);
  const stock = lines.find((line) => line.id === 'auto:framing:post-stock');
  const bases = lines.find((line) => line.id === 'auto:hardware:post-base');
  assert.equal(stock.quantity, 2); // three derived locations, with the explicit start post deduplicated
  assert.equal(bases.quantity, 3);
  assert.equal(bases.description, 'Simpson Strong-Tie ABW Post Base');
  assert.match(bases.specification, /model\/size to match post/);
});

test('only drawn or repeated joists enter the material list', () => {
  let document = createProjectDocument({ id: 'project' });
  document = addJoist(document, createJoist({ start: { x: 0, y: 0 }, end: { x: 0, y: 120 } }, () => 'joist-1'));
  const line = deriveAutomaticTakeoff(document).find((entry) => entry.id.startsWith('auto:framing:joist:'));
  assert.equal(line.quantity, 1);
  assert.equal(line.stockLengthFeet, 10);
});

test('derived Joist Blocking enters Framing Takeoff as optimized 16 foot stock', () => {
  let document = createProjectDocument({ id: 'blocking-takeoff' });
  for (let index = 0; index < 3; index += 1) {
    const x = index * 16;
    document = addJoist(document, createJoist({
      start: { x, y: 0 }, end: { x, y: 120 }, size: '2×6 PT',
      layout: {
        fieldId: 'field-1', boundaryId: 'deck-1', spacingInches: 16,
        bays: [{ start: { x, y: 0 }, end: { x, y: 120 }, lengthInches: 120, startSupportId: 'ledger', endSupportId: 'rim' }],
      },
    }, () => `joist-${index}`));
  }
  const line = deriveAutomaticTakeoff(document).find((entry) => entry.id.startsWith('auto:framing:joist-blocking:'));
  assert.equal(line.description, '2×6 PT joist blocking');
  assert.equal(line.stockLengthFeet, 16);
  assert.equal(line.quantity, 1);
  assert.match(line.specification, /2 blocks/);
});
