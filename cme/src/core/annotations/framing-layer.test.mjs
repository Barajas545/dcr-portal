import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectDocument } from '../document/project-document.js';
import { getFramingLayer, setFramingLayerVisibility, setJoistLayerVisibility, updateFramingSettings } from './framing-layer.js';

test('framing layer has professional defaults without storing hidden geometry', () => {
  const document = createProjectDocument({ id: 'project' });
  const layer = getFramingLayer(document);
  assert.equal(layer.visible, true);
  assert.equal(layer.joistsVisible, true);
  assert.equal(layer.settings.defaultJoistSpacingInches, 16);
  assert.equal(layer.settings.beamMaxPostSpacingFeet, 6);
  assert.equal(document.objects.length, 0);
});

test('joists can be hidden independently without hiding beams and supports', () => {
  const document = setJoistLayerVisibility(createProjectDocument({ id: 'project' }), false);
  assert.equal(getFramingLayer(document).visible, true);
  assert.equal(getFramingLayer(document).joistsVisible, false);
});

test('framing visibility and rules persist as one serializable layer object', () => {
  let document = createProjectDocument({ id: 'project' });
  document = setFramingLayerVisibility(document, false);
  document = updateFramingSettings(document, { beamMaxPostSpacingFeet: 5 });
  assert.equal(getFramingLayer(document).visible, false);
  assert.equal(getFramingLayer(document).settings.beamMaxPostSpacingFeet, 5);
  assert.equal(document.objects.filter((object) => object.type === 'framing-layer').length, 1);
});
