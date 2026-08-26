/* DCR Construction Standard (DCRCS) — the shop's standard framing layout.

   IMPORTANT, and the reason this file is separate from every tool:

   These are DCR's STANDARD DETAILS, not an engineering calculation. The tool
   does not verify a span, size a member, or check a load. A different
   jurisdiction, soil, snow load or live load changes every number here, which
   is why each figure is a setting a contractor edits rather than a constant,
   and why everything derived from them reaches the takeoff flagged
   'preliminary'. The beam and joist READMEs reserved this work explicitly —
   "adding real engineering here is a separate, specified project" — and this
   is that project, kept to a stated shop standard and nothing more.

   Everything here is a pure function of numbers. It is used twice: by the
   takeoff, to say what to buy, and (once the tool draws them) by the canvas,
   to place real posts and footings. One derivation, two consumers, so a drawn
   layout and its material list can never disagree. */

/* A deck at or near grade uses the standard layout. A second-floor deck does
   not: at that height the estimator picks spacing and sizes, because the
   standard was never meant to cover it. */
export const SECOND_FLOOR_LEVEL_INCHES = 120;
export const DCR_DEFAULT_POST_BASE = Object.freeze({
  manufacturer: 'Simpson Strong-Tie',
  series: 'ABW',
  description: 'Simpson Strong-Tie ABW Post Base',
});

export function isSecondFloor(deckLevelInches, threshold = SECOND_FLOOR_LEVEL_INCHES) {
  const level = Number(deckLevelInches);
  return Number.isFinite(level) && level >= threshold;
}

/* Posts along a beam, spaced EVENLY and never further apart than the standard
   allows. Even spacing rather than "6 ft until the remainder" is what a framer
   actually lays out, and it keeps the splice points regular, which the board
   arithmetic below depends on. A beam always carries a post at each end. */
export function postLayout(beamLengthInches, maxSpacingFeet) {
  const length = Number(beamLengthInches) || 0;
  const maxSpacing = (Number(maxSpacingFeet) || 0) * 12;
  if (length <= 0 || maxSpacing <= 0) return { spans: 0, spacingInches: 0, postCount: 0, positions: [] };
  const spans = Math.max(1, Math.ceil(length / maxSpacing));
  const spacingInches = length / spans;
  return {
    spans,
    spacingInches,
    postCount: spans + 1,
    positions: Array.from({ length: spans + 1 }, (_, index) => index * spacingInches),
  };
}

/* Boards for one beam run.

   Two rules from the shop, and they fight each other:
     - beams are spliced END TO END OVER A POST, so a board must cover a whole
       number of spans;
     - lumber comes in commercial lengths only.

   So a board's usable length is the largest whole number of spans that fits
   inside a commercial length. When nothing lands exactly on the last post the
   final board runs long, and that remainder is REPORTED rather than rounded
   away — it is usable stock and the estimator wants to know it exists. */
export function beamBoards(beamLengthInches, spacingInches, stockLengthsFeet) {
  const length = Number(beamLengthInches) || 0;
  const spacing = Number(spacingInches) || 0;
  const stock = [...new Set((stockLengthsFeet ?? []).map(Number).filter((n) => n > 0))].sort((a, b) => a - b);
  if (length <= 0 || spacing <= 0 || !stock.length) return { boards: [], leftoverInches: 0, byLength: {} };

  const spans = Math.max(1, Math.round(length / spacing));
  // the cheapest board that can carry g whole spans, or null if none reaches
  const costOf = (g) => stock.find((feet) => feet * 12 >= g * spacing - 1e-6) ?? null;

  /* Choosing the LONGEST board that fits looks right and is not: on a 24 ft run
     at 6 ft spans it buys 20 + 10 and wastes 6 ft, where 12 + 12 wastes none.
     What matters is the total bought, so this is a small exact search over how
     many spans each board carries. Runs have few spans, so it is cheap. */
  const best = [{ total: 0, boards: [] }];
  for (let n = 1; n <= spans; n += 1) {
    let winner = null;
    for (let g = 1; g <= n; g += 1) {
      const feet = costOf(g);
      if (feet == null) break; // no board reaches g spans, nor will any larger g
      const candidate = best[n - g].total + feet;
      if (!winner || candidate < winner.total) {
        winner = { total: candidate, boards: [...best[n - g].boards, { lengthFeet: feet, spans: g, usedInches: g * spacing }] };
      }
    }
    // a single span longer than the longest board cannot follow the standard;
    // buy the longest stock and let the offcut figure say so
    best[n] = winner ?? { total: best[n - 1].total + stock.at(-1),
      boards: [...best[n - 1].boards, { lengthFeet: stock.at(-1), spans: 1, usedInches: spacing }] };
  }

  const boards = best[spans].boards;
  const purchasedInches = boards.reduce((sum, board) => sum + board.lengthFeet * 12, 0);
  const byLength = boards.reduce((map, board) => ({ ...map, [board.lengthFeet]: (map[board.lengthFeet] ?? 0) + 1 }), {});
  return { boards, leftoverInches: Math.max(0, purchasedInches - length), byLength };
}

/* Joists across a bay. The standard fixes the spacing; the count is the bay
   divided by it, plus the closing joist. */
export function joistLayout(bayWidthInches, spacingInches) {
  const width = Number(bayWidthInches) || 0;
  const spacing = Number(spacingInches) || 0;
  if (width <= 0 || spacing <= 0) return { count: 0, spacingInches: spacing };
  return { count: Math.floor(width / spacing) + 1, spacingInches: spacing };
}

/* A run of beam whose supports sit further apart than the standard allows is
   not something the tool silently fixes — the estimator is told. */
export function exceedsJoistSpan(supportSpacingInches, maxJoistSpanFeet) {
  const spacing = Number(supportSpacingInches) || 0;
  const max = (Number(maxJoistSpanFeet) || 0) * 12;
  return max > 0 && spacing > max + 1e-6;
}
