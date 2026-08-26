import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewport, matchViewportAspect, zoomViewport, panViewport } from './viewport-controller.js';

const ratio = (v) => v.width / v.height;
const centre = (v) => ({ x: v.x + v.width / 2, y: v.y + v.height / 2 });

test('the visible world takes the shape of the element showing it', () => {
  // the default 360x250 viewBox on a 16:9 monitor is what letterboxed the grid
  const wide = matchViewportAspect(createViewport(), 16 / 9);
  assert.ok(Math.abs(ratio(wide) - 16 / 9) < 1e-9);
});

test('reshaping only ever reveals more world, never less', () => {
  const start = createViewport(-30, -25, 360, 250);
  for (const target of [16 / 9, 21 / 9, 4 / 3, 1, 0.6]) {
    const next = matchViewportAspect(start, target);
    assert.ok(next.width >= start.width - 1e-9, `width shrank for ${target}`);
    assert.ok(next.height >= start.height - 1e-9, `height shrank for ${target}`);
    // everything that was on screen is still on screen
    assert.ok(next.x <= start.x + 1e-9 && next.y <= start.y + 1e-9);
    assert.ok(next.x + next.width >= start.x + start.width - 1e-9);
    assert.ok(next.y + next.height >= start.y + start.height - 1e-9);
  }
});

test('reshaping keeps what you were looking at in the middle', () => {
  const start = createViewport(100, 200, 360, 250);
  const before = centre(start);
  const after = centre(matchViewportAspect(start, 21 / 9));
  assert.ok(Math.abs(after.x - before.x) < 1e-9);
  assert.ok(Math.abs(after.y - before.y) < 1e-9);
});

test('a viewport already the right shape is returned untouched', () => {
  const square = createViewport(0, 0, 300, 300);
  assert.equal(matchViewportAspect(square, 1), square, 'same object, no needless redraw');
});

test('a nonsense ratio changes nothing rather than producing NaN', () => {
  const start = createViewport();
  for (const bad of [0, -2, NaN, Infinity, undefined, null]) {
    assert.equal(matchViewportAspect(start, bad), start);
  }
  // a collapsed element (height 0) is the real case behind this
  assert.equal(matchViewportAspect({ x: 0, y: 0, width: 100, height: 0 }, 1.5).width, 100);
});

test('reshaping composes with pan and zoom without drifting', () => {
  let v = createViewport();
  v = matchViewportAspect(v, 16 / 9);
  v = zoomViewport(v, { x: 0, y: 0 }, 0.5);
  v = panViewport(v, { x: 40, y: -20 });
  v = matchViewportAspect(v, 16 / 9);
  assert.ok(Math.abs(ratio(v) - 16 / 9) < 1e-9, 'zoom preserves the shape, so this is a no-op');
});
