import { distance } from '../../core/geometry/vector.js';
import { deriveDeckBoardingSegments, getDeckBoarding } from '../deck-boarding/deck-boarding.js';

export const TAKEOFF_SCHEMA_VERSION = 1;

export const TAKEOFF_CATEGORIES = [
  { id: 'decking', label: 'Decking & trim' },
  { id: 'stairs', label: 'Stairs' },
  { id: 'railing', label: 'Railing' },
  { id: 'framing', label: 'Framing' },
  { id: 'hardware', label: 'Fasteners & hardware' },
  { id: 'protection', label: 'Protection & finishes' },
  { id: 'custom', label: 'Custom materials' },
];

const defaultId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const round = (value, precision = 2) => Number(Number(value ?? 0).toFixed(precision));

export function createTakeoffState(overrides = {}) {
  return {
    schemaVersion: TAKEOFF_SCHEMA_VERSION,
    settings: {
      wastePercent: 10,
      fieldBoardWidthInches: 5.5,
      fieldBoardGapInches: 0.1875,
      fieldBoardStockFeet: 16,
      squareEdgeStockFeet: 16,
      fasciaStockFeet: 12,
      ...overrides.settings,
    },
    overrides: { ...overrides.overrides },
    manualLines: [...(overrides.manualLines ?? [])],
  };
}

export function getTakeoffState(document) {
  return createTakeoffState(document.takeoff ?? {});
}

export function setTakeoffState(document, takeoff) {
  return { ...document, takeoff: createTakeoffState(takeoff), updatedAt: new Date().toISOString() };
}

function boundaryEdgeLength(boundary, edge) {
  const byId = new Map(boundary.vertices.map((vertex) => [vertex.id, vertex]));
  const start = byId.get(edge.startVertexId);
  const end = byId.get(edge.endVertexId);
  return start && end ? distance(start, end) : 0;
}

function purchaseLine({ id, category, description, specification, requiredLinearFeet = 0, stockLengthFeet, sourceObjectIds = [], confidence = 'calculated' }, settings) {
  const wasteMultiplier = 1 + settings.wastePercent / 100;
  return {
    id,
    category,
    description,
    specification,
    stockLengthFeet,
    calculatedQuantity: Math.ceil(requiredLinearFeet * wasteMultiplier / stockLengthFeet),
    quantity: Math.ceil(requiredLinearFeet * wasteMultiplier / stockLengthFeet),
    unit: 'ea',
    unitPrice: null,
    requiredLinearFeet: round(requiredLinearFeet),
    wastePercent: settings.wastePercent,
    origin: 'auto',
    confidence,
    sourceObjectIds,
  };
}

function countLine({ id, category, description, specification, quantity, sourceObjectIds = [], confidence = 'calculated' }) {
  return { id, category, description, specification, stockLengthFeet: null, calculatedQuantity: Math.ceil(quantity), quantity: Math.ceil(quantity), unit: 'ea', unitPrice: null, requiredLinearFeet: null, wastePercent: 0, origin: 'auto', confidence, sourceObjectIds };
}

export function deriveAutomaticTakeoff(document, options = {}) {
  const state = getTakeoffState(document);
  const settings = state.settings;
  const boundaries = document.objects.filter((object) => object.type === 'deck-boundary');
  const stairs = document.objects.filter((object) => object.type === 'stair');
  const pitch = settings.fieldBoardWidthInches + settings.fieldBoardGapInches;
  const fieldLinearFeet = boundaries.reduce((sum, boundary) => {
    const localStairs = stairs.filter((stair) => stair.host?.boundaryId === boundary.id);
    if (getDeckBoarding(boundary)) {
      const byId = new Map(boundary.vertices.map((vertex) => [vertex.id, vertex]));
      const exclusions = localStairs.map((stair) => [stair.anchors?.openingStartVertexId, stair.anchors?.outerStartVertexId, stair.anchors?.outerEndVertexId, stair.anchors?.openingEndVertexId].map((id) => byId.get(id)).filter(Boolean)).filter((polygon) => polygon.length === 4);
      return sum + deriveDeckBoardingSegments(boundary, exclusions, { pitch }).reduce((total, segment) => total + distance(segment.start, segment.end), 0) / 12;
    }
    const stairArea = localStairs.reduce((total, stair) => total + Number(stair.dimensions?.width ?? 0) * Number(stair.dimensions?.totalRun ?? 0), 0);
    const fieldArea = Math.max(0, Number(boundary.computed?.areaSquareInches ?? 0) - stairArea);
    return sum + (pitch > 0 ? fieldArea / pitch / 12 : 0);
  }, 0);
  const lines = [];
  if (fieldLinearFeet > 0) lines.push(purchaseLine({ id: 'auto:decking:grooved-field', category: 'decking', description: 'Grooved field decking', specification: `${settings.fieldBoardStockFeet} ft board`, requiredLinearFeet: fieldLinearFeet, stockLengthFeet: settings.fieldBoardStockFeet, sourceObjectIds: boundaries.map((boundary) => boundary.id), confidence: 'preliminary' }, settings));

  const pictureFrameLF = boundaries.reduce((sum, boundary) => sum + boundary.edges.filter((edge) => edge.properties?.finishes?.pictureFrame).reduce((edgeSum, edge) => edgeSum + boundaryEdgeLength(boundary, edge), 0), 0) / 12;
  if (pictureFrameLF > 0) lines.push(purchaseLine({ id: 'auto:decking:square-picture-frame', category: 'decking', description: 'Square-edge picture frame', specification: `${settings.squareEdgeStockFeet} ft board`, requiredLinearFeet: pictureFrameLF, stockLengthFeet: settings.squareEdgeStockFeet, sourceObjectIds: boundaries.map((boundary) => boundary.id) }, settings));

  const fasciaLF = boundaries.reduce((sum, boundary) => sum + boundary.edges.filter((edge) => edge.properties?.finishes?.fascia).reduce((edgeSum, edge) => edgeSum + boundaryEdgeLength(boundary, edge), 0), 0) / 12;
  if (fasciaLF > 0) lines.push(purchaseLine({ id: 'auto:decking:fascia', category: 'decking', description: 'Fascia board', specification: `${settings.fasciaStockFeet} ft fascia`, requiredLinearFeet: fasciaLF, stockLengthFeet: settings.fasciaStockFeet, sourceObjectIds: boundaries.map((boundary) => boundary.id) }, settings));

  const stairTreadLF = stairs.reduce((sum, stair) => sum + Number(stair.dimensions?.width ?? 0) * Number(stair.dimensions?.treadCount ?? 0), 0) / 12;
  const stairRiserLF = stairs.reduce((sum, stair) => sum + Number(stair.dimensions?.width ?? 0) * Number(stair.dimensions?.riserCount ?? 0), 0) / 12;
  const stairIds = stairs.map((stair) => stair.id);
  if (stairTreadLF > 0) {
    lines.push(purchaseLine({ id: 'auto:stairs:grooved-tread', category: 'stairs', description: 'Grooved stair tread covering', specification: '12 ft board', requiredLinearFeet: stairTreadLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));
    lines.push(purchaseLine({ id: 'auto:stairs:square-nose', category: 'stairs', description: 'Square-edge stair nosing', specification: '12 ft board', requiredLinearFeet: stairTreadLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));
  }
  if (stairRiserLF > 0) lines.push(purchaseLine({ id: 'auto:stairs:square-riser', category: 'stairs', description: 'Square-edge stair riser covering', specification: '12 ft board', requiredLinearFeet: stairRiserLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));

  const wildHog = (options.railingGeometries ?? []).filter((geometry) => (geometry.railing?.settings?.system ?? 'wild-hog') === 'wild-hog');
  const railLengthInches = wildHog.reduce((sum, geometry) => sum + Number(geometry.length ?? 0), 0);
  const panelCount = wildHog.reduce((sum, geometry) => sum + Number(geometry.sectionCount ?? 0), 0);
  const railingIds = wildHog.map((geometry) => geometry.railing.id);
  if (panelCount > 0) {
    lines.push(countLine({ id: 'auto:railing:wild-hog-panel', category: 'railing', description: 'Wild Hog panel', specification: 'Panel', quantity: panelCount, sourceObjectIds: railingIds }));
    lines.push(purchaseLine({ id: 'auto:railing:wild-hog-track', category: 'railing', description: 'Wild Hog aluminum track', specification: '8 ft track', requiredLinearFeet: railLengthInches / 12 * 2, stockLengthFeet: 8, sourceObjectIds: railingIds, confidence: 'review' }, { ...settings, wastePercent: 0 }));
    lines.push(purchaseLine({ id: 'auto:railing:wild-hog-handrail', category: 'railing', description: '2×6 DW handrail', specification: '2×6×8', requiredLinearFeet: railLengthInches / 12, stockLengthFeet: 8, sourceObjectIds: railingIds }, { ...settings, wastePercent: 0 }));
    lines.push(countLine({ id: 'auto:railing:wild-hog-support', category: 'railing', description: 'Panel support', specification: '2×4×8 · top and bottom', quantity: panelCount * 2, sourceObjectIds: railingIds }));
    lines.push(countLine({ id: 'auto:railing:wild-hog-post', category: 'railing', description: 'Railing post', specification: '4×4×5', quantity: options.railingPostCount ?? wildHog.reduce((sum, geometry) => sum + Number(geometry.postCount ?? 0), 0), sourceObjectIds: railingIds }));
  }
  return lines;
}

export function getEffectiveTakeoffLines(document, options = {}) {
  const state = getTakeoffState(document);
  const automatic = deriveAutomaticTakeoff(document, options).map((line) => {
    const override = state.overrides[line.id] ?? {};
    return { ...line, ...override, calculatedQuantity: line.calculatedQuantity, origin: override.quantity !== undefined ? 'adjusted' : 'auto' };
  });
  return [...automatic, ...state.manualLines.map((line) => ({ ...line, origin: 'manual', calculatedQuantity: null }))];
}

export function updateTakeoffLine(document, lineId, patch) {
  const state = getTakeoffState(document);
  const manualIndex = state.manualLines.findIndex((line) => line.id === lineId);
  if (manualIndex >= 0) {
    const manualLines = [...state.manualLines];
    manualLines[manualIndex] = { ...manualLines[manualIndex], ...patch };
    return setTakeoffState(document, { ...state, manualLines });
  }
  return setTakeoffState(document, { ...state, overrides: { ...state.overrides, [lineId]: { ...(state.overrides[lineId] ?? {}), ...patch } } });
}

export function resetTakeoffLine(document, lineId) {
  const state = getTakeoffState(document);
  const { [lineId]: removed, ...overrides } = state.overrides;
  return setTakeoffState(document, { ...state, overrides });
}

export function addManualTakeoffLine(document, input, idFactory = defaultId) {
  const state = getTakeoffState(document);
  const quantity = Number(input.quantity);
  if (!input.description?.trim() || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Enter a material description and quantity greater than zero.');
  const line = {
    id: idFactory('takeoff-line'),
    category: TAKEOFF_CATEGORIES.some((category) => category.id === input.category) ? input.category : 'custom',
    description: input.description.trim(),
    specification: input.specification?.trim() ?? '',
    stockLengthFeet: Number(input.stockLengthFeet) || null,
    quantity,
    unit: input.unit ?? 'ea',
    unitPrice: Number.isFinite(Number(input.unitPrice)) && input.unitPrice !== '' ? Number(input.unitPrice) : null,
    requiredLinearFeet: null,
    wastePercent: 0,
    origin: 'manual',
    confidence: 'user',
    sourceObjectIds: [],
  };
  return setTakeoffState(document, { ...state, manualLines: [...state.manualLines, line] });
}

export function removeManualTakeoffLine(document, lineId) {
  const state = getTakeoffState(document);
  return setTakeoffState(document, { ...state, manualLines: state.manualLines.filter((line) => line.id !== lineId) });
}

export function createTakeoffExport(document, options = {}) {
  const includePrices = options.includePrices === true;
  const lines = getEffectiveTakeoffLines(document, options).map((line) => {
    const exported = { id: line.id, category: line.category, description: line.description, specification: line.specification, calculatedQuantity: line.calculatedQuantity, quantity: line.quantity, unit: line.unit, requiredLinearFeet: line.requiredLinearFeet, origin: line.origin, confidence: line.confidence, sourceObjectIds: line.sourceObjectIds };
    if (includePrices) { exported.unitPrice = line.unitPrice; exported.subtotal = line.unitPrice == null ? null : round(line.quantity * line.unitPrice); }
    return exported;
  });
  return { schema: 'com.dcr.cme.takeoff', schemaVersion: 1, project: { id: document.id, name: document.name }, generatedAt: options.now ?? new Date().toISOString(), pricingIncluded: includePrices, summary: { materialLineCount: lines.length, adjustedLineCount: lines.filter((line) => line.origin === 'adjusted').length, manualLineCount: lines.filter((line) => line.origin === 'manual').length }, lines };
}
