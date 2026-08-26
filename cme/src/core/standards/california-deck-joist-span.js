// 2025 California Residential Code / 2024 IRC R507.6 reference.
// Prescriptive residential deck values: No. 2 grade, wet service,
// 40 psf live load, 10 psf dead load, L/360. These values are estimating
// guidance only; local amendments and project-specific loads still govern.

export const JOIST_SPAN_REFERENCE = Object.freeze({
  code: '2025 CRC / 2024 IRC R507.6',
  assumptions: Object.freeze({ grade: 'No. 2', service: 'wet', liveLoadPsf: 40, deadLoadPsf: 10, deflection: 'L/360' }),
  species: Object.freeze({
    'douglas-fir-larch': Object.freeze({
      label: 'Douglas Fir-Larch / Hem-Fir / SPF (incised)',
      spans: Object.freeze({
        '2x6': Object.freeze({ 12: 114, 16: 100, 24: 82 }),
        '2x8': Object.freeze({ 12: 150, 16: 133, 24: 109 }),
        '2x10': Object.freeze({ 12: 188, 16: 163, 24: 133 }),
        '2x12': Object.freeze({ 12: 216, 16: 189, 24: 154 }),
      }),
    }),
    redwood: Object.freeze({
      label: 'Redwood / Western Cedar',
      spans: Object.freeze({
        '2x6': Object.freeze({ 12: 106, 16: 96, 24: 82 }),
        '2x8': Object.freeze({ 12: 140, 16: 127, 24: 104 }),
        '2x10': Object.freeze({ 12: 179, 16: 156, 24: 127 }),
        '2x12': Object.freeze({ 12: 209, 16: 181, 24: 148 }),
      }),
    }),
  }),
});

export function normalizeJoistNominalSize(value) {
  const match = String(value ?? '').toLowerCase().replaceAll('×', 'x').match(/2\s*x\s*(6|8|10|12)/);
  return match ? `2x${match[1]}` : null;
}

export function maximumJoistSpan({ size, spacingInches = 16, speciesGroup = 'douglas-fir-larch' } = {}) {
  const nominalSize = normalizeJoistNominalSize(size);
  const spacing = Number(spacingInches);
  const table = JOIST_SPAN_REFERENCE.species[speciesGroup] ?? JOIST_SPAN_REFERENCE.species['douglas-fir-larch'];
  const exact = table.spans[nominalSize]?.[spacing];
  if (!nominalSize || !Number.isFinite(exact)) return null;
  return { maximumInches: exact, nominalSize, spacingInches: spacing, speciesGroup, speciesLabel: table.label, code: JOIST_SPAN_REFERENCE.code };
}

export function validateJoistBays({ bays = [], size, spacingInches = 16, speciesGroup = 'douglas-fir-larch' } = {}) {
  const reference = maximumJoistSpan({ size, spacingInches, speciesGroup });
  if (!reference) return { status: 'review', valid: null, reason: 'Select a recognized joist size and layout to validate span.', reference: null, bays: [] };
  const checked = bays.map((bay) => {
    const spanInches = Number(bay.lengthInches) || 0;
    const ratio = spanInches / reference.maximumInches;
    return { ...bay, spanInches, ratio, valid: spanInches <= reference.maximumInches + 1e-6 };
  });
  const longest = checked.reduce((winner, bay) => !winner || bay.spanInches > winner.spanInches ? bay : winner, null);
  const valid = checked.length > 0 && checked.every((bay) => bay.valid);
  const nearLimit = valid && checked.some((bay) => bay.ratio > .9);
  return {
    status: valid ? nearLimit ? 'near-limit' : 'valid' : 'invalid',
    valid,
    reason: valid ? nearLimit ? 'Longest supported bay is within 10% of the prescriptive maximum.' : 'Every supported bay is within the prescriptive maximum.' : 'One or more supported bays exceed the prescriptive maximum.',
    reference,
    longestSpanInches: longest?.spanInches ?? 0,
    bays: checked,
  };
}
