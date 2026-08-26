export const CRC_DECK_BEAM_REFERENCE = Object.freeze({
  edition: '2025 California Residential Code',
  section: 'R507.5(1)',
  liveLoadPsf: 40,
  deadLoadPsf: 10,
  grade: 'No. 2',
  service: 'wet',
  speciesGroup: 'douglas-fir-larch',
  beamCantilever: 'none',
});

export const DECK_BEAM_JOIST_SPANS_FEET = Object.freeze([6, 8, 10, 12, 14, 16, 18]);

// CRC 2025 Table R507.5(1), zero joist cantilever, Douglas fir-larch /
// Hem-fir / Spruce-pine-fir. Values are maximum post-to-post beam spans.
const MAXIMUM_SPANS = Object.freeze({
  '2-2x6': [6 + 6 / 12, 6 + 1 / 12, 5 + 8 / 12, 5 + 3 / 12, 4 + 9 / 12, 4 + 6 / 12, 4 + 4 / 12],
  '2-2x8': [8 + 8 / 12, 8 + 2 / 12, 7 + 7 / 12, 7 + 1 / 12, 6 + 4 / 12, 6, 5 + 9 / 12],
  '2-2x10': [10 + 8 / 12, 10, 9 + 3 / 12, 8 + 7 / 12, 7 + 9 / 12, 7 + 4 / 12, 7],
  '2-2x12': [12 + 4 / 12, 11 + 7 / 12, 10 + 9 / 12, 10, 8 + 11 / 12, 8 + 6 / 12, 8 + 2 / 12],
  '3-2x6': [8 + 2 / 12, 7 + 8 / 12, 7 + 2 / 12, 6 + 8 / 12, 6, 5 + 9 / 12, 5 + 6 / 12],
  '3-2x8': [10 + 11 / 12, 10 + 3 / 12, 9 + 6 / 12, 8 + 10 / 12, 7 + 11 / 12, 7 + 7 / 12, 7 + 3 / 12],
  '3-2x10': [13 + 4 / 12, 12 + 6 / 12, 11 + 8 / 12, 10 + 10 / 12, 9 + 8 / 12, 9 + 3 / 12, 8 + 10 / 12],
  '3-2x12': [15 + 6 / 12, 14 + 6 / 12, 13 + 6 / 12, 12 + 7 / 12, 11 + 3 / 12, 10 + 9 / 12, 10 + 3 / 12],
});

export function maximumDeckBeamSpanFeet(preset, joistSpanFeet) {
  const values = MAXIMUM_SPANS[preset];
  const requested = Number(joistSpanFeet);
  if (!values || !Number.isFinite(requested) || requested <= 0) return null;
  if (requested <= DECK_BEAM_JOIST_SPANS_FEET[0]) return values[0];
  if (requested > DECK_BEAM_JOIST_SPANS_FEET.at(-1)) return null;
  const upperIndex = DECK_BEAM_JOIST_SPANS_FEET.findIndex((span) => requested <= span);
  const lowerIndex = upperIndex - 1;
  const lowerSpan = DECK_BEAM_JOIST_SPANS_FEET[lowerIndex];
  const upperSpan = DECK_BEAM_JOIST_SPANS_FEET[upperIndex];
  const ratio = (requested - lowerSpan) / (upperSpan - lowerSpan);
  return values[lowerIndex] + (values[upperIndex] - values[lowerIndex]) * ratio;
}

export function isPrescriptiveDeckBeamPreset(preset) {
  return Boolean(MAXIMUM_SPANS[preset]);
}
