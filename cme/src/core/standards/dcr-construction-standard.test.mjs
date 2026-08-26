import test from 'node:test';
import assert from 'node:assert/strict';
import { postLayout, beamBoards, joistLayout, exceedsJoistSpan, isSecondFloor } from './dcr-construction-standard.js';

const STOCK = [8, 10, 12, 16, 20];

test('a beam carries a post at each end, evenly spaced, never over the limit', () => {
  // 24 ft at 6 ft maximum: four spans, five posts, exactly on the limit
  const layout = postLayout(24 * 12, 6);
  assert.equal(layout.spans, 4);
  assert.equal(layout.postCount, 5);
  assert.equal(layout.spacingInches, 72);
  assert.deepEqual(layout.positions, [0, 72, 144, 216, 288]);
});

test('an awkward length spreads evenly rather than leaving one long span', () => {
  /* 20 ft at 6 ft maximum. Four spans of 5 ft, not three of 6 ft plus one of 2 -
     that is what a framer lays out, and it keeps the splice points regular. */
  const layout = postLayout(20 * 12, 6);
  assert.equal(layout.spans, 4);
  assert.equal(layout.spacingInches, 60);
  assert.ok(layout.spacingInches <= 72, 'never exceeds the standard');
});

test('every span stays inside the limit, whatever the run', () => {
  for (let feet = 1; feet <= 60; feet += 1) {
    const layout = postLayout(feet * 12, 6);
    assert.ok(layout.spacingInches <= 72 + 1e-6, `${feet} ft span was ${layout.spacingInches}`);
    assert.equal(layout.postCount, layout.spans + 1, 'a post at each end');
    assert.equal(Math.round(layout.positions.at(-1)), feet * 12, 'the last post closes the run');
  }
});

test('a beam is bought in commercial lengths that land on a post', () => {
  // 24 ft, posts every 6 ft -> two 12 ft boards, each spanning two bays
  const layout = postLayout(24 * 12, 6);
  const result = beamBoards(24 * 12, layout.spacingInches, STOCK);
  assert.deepEqual(result.byLength, { 12: 2 });
  assert.equal(result.leftoverInches, 0, 'nothing left over when it divides');
  result.boards.forEach((board) => {
    assert.equal(Number.isInteger(board.spans), true, 'a board must end on a post');
  });
});

test('a run that no commercial length divides reports its offcut', () => {
  // 14 ft, posts every 7 ft... 14/6 -> 3 spans of 4.667 ft
  const layout = postLayout(14 * 12, 6);
  const result = beamBoards(14 * 12, layout.spacingInches, STOCK);
  const purchased = result.boards.reduce((sum, b) => sum + b.lengthFeet * 12, 0);
  assert.ok(purchased >= 14 * 12 - 1e-6, 'the boards must at least cover the run');
  assert.equal(Math.round(result.leftoverInches), Math.round(purchased - 14 * 12));
  assert.ok(result.leftoverInches > 0, 'the remainder is reported, not rounded away');
});

test('boards always cover the run and never silently fall short', () => {
  for (let feet = 4; feet <= 60; feet += 1) {
    const layout = postLayout(feet * 12, 6);
    const result = beamBoards(feet * 12, layout.spacingInches, STOCK);
    const purchased = result.boards.reduce((sum, b) => sum + b.lengthFeet * 12, 0);
    assert.ok(result.boards.length > 0, `${feet} ft produced no boards`);
    assert.ok(purchased >= feet * 12 - 1e-6, `${feet} ft: bought ${purchased / 12} ft for a ${feet} ft run`);
    assert.ok(result.leftoverInches >= 0);
    // every board is a real commercial length
    result.boards.forEach((b) => assert.ok(STOCK.includes(b.lengthFeet), `${b.lengthFeet} ft is not stocked`));
  }
});

test('a beam shorter than one board is a single piece', () => {
  const layout = postLayout(7 * 12, 6);
  const result = beamBoards(7 * 12, layout.spacingInches, STOCK);
  assert.equal(result.boards.length, 1);
  assert.equal(result.boards[0].lengthFeet, 8, 'the shortest stock that covers 7 ft');
  assert.equal(Math.round(result.leftoverInches), 12, 'a foot left over');
});

test('joists close the bay', () => {
  // 12 ft bay at 12 in centres: 12 spaces, 13 joists
  assert.deepEqual(joistLayout(144, 12), { count: 13, spacingInches: 12 });
  assert.equal(joistLayout(0, 12).count, 0);
  assert.equal(joistLayout(144, 0).count, 0);
});

test('supports further apart than the standard allows are flagged, not fixed', () => {
  assert.equal(exceedsJoistSpan(6 * 12, 6), false, 'exactly the limit is allowed');
  assert.equal(exceedsJoistSpan(6 * 12 + 1, 6), true);
  assert.equal(exceedsJoistSpan(5 * 12, 6), false);
});

test('second floor is out of the standard, and an unset level is not second floor', () => {
  assert.equal(isSecondFloor(48), false, 'a 4 ft deck uses the standard');
  assert.equal(isSecondFloor(120), true);
  assert.equal(isSecondFloor(144), true);
  assert.equal(isSecondFloor(null), false, 'unset must never be read as second floor');
  assert.equal(isSecondFloor(undefined), false);
});

test('nothing is derived from a run with no length or no standard', () => {
  assert.deepEqual(postLayout(0, 6).positions, []);
  assert.deepEqual(postLayout(240, 0).positions, []);
  assert.deepEqual(beamBoards(240, 0, STOCK).boards, []);
  assert.deepEqual(beamBoards(240, 60, []).boards, []);
});

