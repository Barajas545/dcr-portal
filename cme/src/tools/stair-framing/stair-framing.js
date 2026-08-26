export const STAIR_FRAMING_STOCK_LENGTHS_FEET = Object.freeze([8, 10, 12, 16, 20]);
export const DEFAULT_STAIR_STRINGER_SPACING_INCHES = 12;

function planLinearStock(requiredInches, stockLengths = STAIR_FRAMING_STOCK_LENGTHS_FEET) {
  const requiredFeet = Math.max(0, Number(requiredInches) || 0) / 12;
  if (!requiredFeet) return [];
  const lengths = [...stockLengths].map(Number).filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b);
  const target = Math.ceil(requiredFeet);
  const limit = target + Math.max(...lengths);
  const plans = Array(limit + 1).fill(null);
  plans[0] = [];
  for (let total = 1; total <= limit; total += 1) {
    lengths.forEach((length) => {
      const previous = plans[total - length];
      if (!previous) return;
      const candidate = [...previous, length].sort((a, b) => a - b);
      const current = plans[total];
      if (!current || candidate.length < current.length) plans[total] = candidate;
    });
  }
  for (let total = target; total <= limit; total += 1) if (plans[total]) return plans[total];
  return [];
}

function continuousStockLength(requiredInches, stockLengths = STAIR_FRAMING_STOCK_LENGTHS_FEET) {
  const requiredFeet = Math.max(0, Number(requiredInches) || 0) / 12;
  return [...stockLengths].map(Number).filter((value) => value >= requiredFeet).sort((a, b) => a - b)[0] ?? null;
}

export function deriveStairFraming(stair, options = {}) {
  const widthInches = Math.max(0, Number(stair?.dimensions?.width) || 0);
  const totalRiseInches = Math.max(0, Number(stair?.dimensions?.totalRise) || 0);
  const totalRunInches = Math.max(0, Number(stair?.dimensions?.totalRun) || 0);
  const maximumSpacingInches = Math.max(1, Number(options.maximumSpacingInches) || DEFAULT_STAIR_STRINGER_SPACING_INCHES);
  const stringerCount = widthInches > 0 ? Math.max(2, Math.ceil(widthInches / maximumSpacingInches) + 1) : 0;
  const internalStringerCount = Math.max(0, stringerCount - 2);
  const actualSpacingInches = stringerCount > 1 ? widthInches / (stringerCount - 1) : 0;
  const stringerLengthInches = Math.hypot(totalRunInches, totalRiseInches);
  const stringerStockLengthFeet = continuousStockLength(stringerLengthInches, options.stockLengthsFeet);
  const ledgerStockPieces = planLinearStock(widthInches, options.stockLengthsFeet);
  return {
    stairId: stair?.id ?? null,
    material: '2×12 PT',
    widthInches,
    totalRiseInches,
    totalRunInches,
    maximumSpacingInches,
    actualSpacingInches,
    stringerCount,
    sideStringerCount: stringerCount ? 2 : 0,
    internalStringerCount,
    stringerLengthInches,
    stringerStockLengthFeet,
    ledgerLengthInches: widthInches,
    ledgerStockPieces,
    needsReview: stringerCount > 0 && !stringerStockLengthFeet,
    reviewReason: stringerCount > 0 && !stringerStockLengthFeet ? 'Continuous stair stringer exceeds available 20 ft stock.' : null,
  };
}

export function describeStairFramingTakeoff(document, options = {}) {
  const stairs = (document?.objects ?? []).filter((object) => object.type === 'stair');
  const stringers = new Map();
  const ledgers = new Map();
  const overlength = [];
  stairs.forEach((stair) => {
    const framing = deriveStairFraming(stair, options);
    if (framing.stringerStockLengthFeet) {
      const key = framing.stringerStockLengthFeet;
      const group = stringers.get(key) ?? { quantity: 0, sourceObjectIds: [] };
      group.quantity += framing.stringerCount;
      group.sourceObjectIds.push(stair.id);
      stringers.set(key, group);
    } else if (framing.stringerCount) {
      overlength.push({ stair, framing });
    }
    framing.ledgerStockPieces.forEach((lengthFeet) => {
      const group = ledgers.get(lengthFeet) ?? { quantity: 0, sourceObjectIds: [] };
      group.quantity += 1;
      group.sourceObjectIds.push(stair.id);
      ledgers.set(lengthFeet, group);
    });
  });
  const lines = [...stringers.entries()].map(([lengthFeet, group]) => ({
    kind: 'count',
    id: `auto:stairs:stringer:${lengthFeet}`,
    category: 'framing',
    description: '2×12 PT stair stringer',
    specification: `${lengthFeet} ft stock · sides + internal at 12″ maximum`,
    quantity: group.quantity,
    stockLengthFeet: lengthFeet,
    sourceObjectIds: [...new Set(group.sourceObjectIds)],
    confidence: 'preliminary',
  }));
  lines.push(...[...ledgers.entries()].map(([lengthFeet, group]) => ({
    kind: 'count',
    id: `auto:stairs:ledger:${lengthFeet}`,
    category: 'framing',
    description: '2×12 PT stair ledger / header',
    specification: `${lengthFeet} ft stock · one measured header per stair`,
    quantity: group.quantity,
    stockLengthFeet: lengthFeet,
    sourceObjectIds: [...new Set(group.sourceObjectIds)],
    confidence: 'preliminary',
  })));
  lines.push(...overlength.map(({ stair, framing }) => ({
    kind: 'count',
    id: `auto:stairs:stringer:review:${stair.id}`,
    category: 'framing',
    description: '2×12 PT stair stringer · REVIEW',
    specification: `${(framing.stringerLengthInches / 12).toFixed(2)} ft continuous length exceeds available stock`,
    quantity: framing.stringerCount,
    sourceObjectIds: [stair.id],
    confidence: 'review',
  })));
  return lines;
}
