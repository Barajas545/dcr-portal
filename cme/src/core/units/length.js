export const INCHES_PER_FOOT = 12;

export function formatFeetInches(totalInches, precision = 1) {
  if (!Number.isFinite(totalInches)) return '—';
  const rounded = Math.round(Math.abs(totalInches) / precision) * precision;
  const feet = Math.floor(rounded / INCHES_PER_FOOT);
  const inches = rounded - feet * INCHES_PER_FOOT;
  const sign = totalInches < 0 ? '−' : '';
  const decimals = precision < 1 ? Math.min(3, (String(precision).split('.')[1] ?? '').length) : 0;
  const inchText = Number(inches.toFixed(decimals)).toString();
  return `${sign}${feet}′ ${inchText}″`;
}

export function formatInches(totalInches, maximumFractionDigits = 2) {
  if (!Number.isFinite(totalInches)) return '—';
  const fixed = Number(totalInches.toFixed(maximumFractionDigits)).toString();
  return `${fixed}″`;
}

export function squareInchesToSquareFeet(area) {
  return area / (INCHES_PER_FOOT * INCHES_PER_FOOT);
}

export function formatSquareFeet(areaInSquareInches) {
  return `${squareInchesToSquareFeet(areaInSquareInches).toLocaleString(undefined, { maximumFractionDigits: 1 })} sq ft`;
}

/* Feet-inches with a real fraction, the way a tape reads.

   formatFeetInches rounds to a decimal, so 6.5 inches prints as "6.5″" - a
   number nobody can find on a tape measure. This prints 6 1/2″ instead,
   reduced to lowest terms, which is what the old drawing tool showed and what
   a framer expects to read off a dimension line. */
export function formatFeetInchesFraction(totalInches, denominator = 16) {
  if (!Number.isFinite(totalInches)) return '—';
  const sign = totalInches < 0 ? '−' : '';
  const abs = Math.abs(totalInches);
  const ticks = Math.round(abs * denominator);
  let feet = Math.floor(ticks / (INCHES_PER_FOOT * denominator));
  let rest = ticks - feet * INCHES_PER_FOOT * denominator;
  let inches = Math.floor(rest / denominator);
  let numerator = rest - inches * denominator;
  let den = denominator;
  while (numerator > 0 && numerator % 2 === 0 && den % 2 === 0) { numerator /= 2; den /= 2; }
  const fraction = numerator > 0 ? ` ${numerator}/${den}` : '';
  return `${sign}${feet}′ ${inches}${fraction}″`;
}
