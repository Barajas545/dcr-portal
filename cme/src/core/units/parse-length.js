const MM_PER_INCH = 25.4;

/* What a framer actually types.

   Two things made the original unusable in the field:

   1. formatFeetInches emits TYPOGRAPHIC primes - 12′ 6″ - and a Unicode minus,
      but the parser only accepted ASCII ' and ". So every field the UI
      pre-filled was rejected the moment you pressed Apply, unless you deleted
      the value and retyped it in plain ASCII.
   2. No fractions. On site a length is "6 1/2", not "6.5", and a plan reads
      12'-6". Both were rejected.

   So: normalise the punctuation first, then read the number. Everything below
   returns INCHES, which is CME's world unit. */

const UNICODE_FRACTIONS = {
  '¼': '1/4', '½': '1/2', '¾': '3/4',
  '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
  '⅓': '1/3', '⅔': '2/3',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6',
  '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

function normalise(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  // typographic punctuation the formatter and mobile keyboards produce
  s = s.replace(/[′‵ʹ‘’]/g, "'");     // primes, smart single quotes
  s = s.replace(/[″‶ʺ“”]/g, '"');      // double primes, smart double quotes
  s = s.replace(/[−‒–—―]/g, '-');      // minus, figure/en/em dashes
  s = s.replace(/[   ]/g, ' ');                  // non-breaking spaces
  for (const [glyph, ascii] of Object.entries(UNICODE_FRACTIONS)) {
    // ½ binds to the number before it: 6½ -> 6 1/2
    s = s.replace(new RegExp(glyph, 'g'), ' ' + ascii);
  }
  s = s.replace(/,/g, '').replace(/\s+/g, ' ').trim();
  return s;
}

// "6", "6.5", "1/2", "6 1/2", "6-1/2" -> number. Null when it is not a number.
function readNumber(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t) return null;
  const mixed = t.match(/^(\d+(?:\.\d+)?)\s*[- ]\s*(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const den = Number(mixed[3]);
    if (!den) return null;
    return Number(mixed[1]) + Number(mixed[2]) / den;
  }
  const fraction = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) {
    const den = Number(fraction[2]);
    return den ? Number(fraction[1]) / den : null;
  }
  const plain = t.match(/^\d+(?:\.\d+)?$/);
  return plain ? Number(t) : null;
}

const FEET_UNIT = "(?:'|ft\\.?|feet|foot)";
const INCH_UNIT = '(?:"|in\\.?|inch|inches)';
const NUM = '\\d+(?:\\.\\d+)?(?:\\s*[- ]\\s*\\d+\\s*\\/\\s*\\d+)?|\\d+\\s*\\/\\s*\\d+';

export function parseConstructionLength(value) {
  let input = normalise(value);
  if (!input) return null;

  let sign = 1;
  if (input.startsWith('-')) { sign = -1; input = input.slice(1).trim(); }
  else if (input.startsWith('+')) { input = input.slice(1).trim(); }
  if (!input) return null;

  const signed = (n) => (n == null ? null : sign * n);

  // 12' 6 1/2"  ·  12'6"  ·  12 ft 6 in  ·  12' (inches optional)
  const feetInches = input.match(
    new RegExp('^(' + NUM + ')\\s*' + FEET_UNIT + '(?:\\s*-?\\s*(' + NUM + ')\\s*' + INCH_UNIT + '?)?$'));
  if (feetInches) {
    const ft = readNumber(feetInches[1]);
    const inch = feetInches[2] == null ? 0 : readNumber(feetInches[2]);
    if (ft == null || inch == null) return null;
    return signed(ft * 12 + inch);
  }

  // 6 1/2"  ·  6in  ·  1/2"
  const inches = input.match(new RegExp('^(' + NUM + ')\\s*' + INCH_UNIT + '$'));
  if (inches) return signed(readNumber(inches[1]));

  const millimetres = input.match(/^(\d+(?:\.\d+)?)\s*mm$/);
  if (millimetres) return signed(Number(millimetres[1]) / MM_PER_INCH);

  const metres = input.match(/^(\d+(?:\.\d+)?)\s*m$/);
  if (metres) return signed((Number(metres[1]) * 1000) / MM_PER_INCH);

  const centimetres = input.match(/^(\d+(?:\.\d+)?)\s*cm$/);
  if (centimetres) return signed((Number(centimetres[1]) * 10) / MM_PER_INCH);

  /* Plan shorthand with no units at all.

     "12-6" is twelve foot six - that is how it reads on a drawing.
     "6-1/2" is six and a half INCHES, because the part after the dash is a
     fraction of the part before it. The slash is what tells them apart. */
  const dashed = input.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (dashed) return signed(Number(dashed[1]) * 12 + Number(dashed[2]));

  // 6-1/2 or 6 1/2 with no unit: inches-with-fraction reads as one number,
  // and a bare number is FEET (the long-standing convention here).
  const asNumber = readNumber(input);
  if (asNumber != null) {
    const hasFraction = /\//.test(input);
    return signed(hasFraction ? asNumber : asNumber * 12);
  }
  return null;
}
