import { distance } from '../../core/geometry/vector.js';
import { analyzeRailingGeometries } from '../railing/railing.js';
import { deriveDeckBoardingSegments, getDeckBoarding } from '../deck-boarding/deck-boarding.js';
import { describeTakeoff as describeBeams } from '../beam/beam.js';
import { describeTakeoff as describeJoists } from '../joist-group/joist-group.js';
import { describeTakeoff as describePosts } from '../post-footing/post-footing.js';
import { describeTakeoff as describeSymbols } from '../symbols/symbols.js';
import { getFramingLayer } from '../../core/annotations/framing-layer.js';
import { DCR_DEFAULT_POST_BASE } from '../../core/standards/dcr-construction-standard.js';
import { deriveAllBeamGeometries } from '../beam/beam-geometry.js';
import { describeJoistBlockingTakeoff } from '../joist-blocking/joist-blocking.js';
import { describeLedgerTakeoff } from '../ledger/ledger.js';
import { describeRimJoistTakeoff } from '../rim-joist/rim-joist.js';
import { describeStairFramingTakeoff } from '../stair-framing/stair-framing.js';
import { getPosts } from '../post-footing/post-footing.js';
import { describeTakeoff as describeRailingSystems, netGateOpenings } from '../railing/railing-systems.js';
import { getGateOpenings } from '../symbols/symbols.js';

export const TAKEOFF_SCHEMA_VERSION = 1;

const WILD_HOG_HANDRAIL_STOCK_FEET = Object.freeze([8, 10, 12, 16, 20]);

export function planWildHogHandrailStock(geometry, stockLengths = WILD_HOG_HANDRAIL_STOCK_FEET) {
  const panelCount = Math.max(0, Math.floor(Number(geometry?.sectionCount ?? 0)));
  const runFeet = Math.max(0, Number(geometry?.length ?? 0)) / 12;
  if (!panelCount || !runFeet) return [];
  const panelSpanFeet = runFeet / panelCount;
  const lengths = [...new Set(stockLengths.map(Number).filter((length) => Number.isFinite(length) && length > 0))].sort((a, b) => a - b);
  const plans = Array(panelCount + 1).fill(null);
  plans[0] = { pieces: [], purchasedFeet: 0 };
  for (let covered = 1; covered <= panelCount; covered += 1) {
    for (let previous = 0; previous < covered; previous += 1) {
      const requiredFeet = panelSpanFeet * (covered - previous);
      const stockLength = lengths.find((length) => length + 1e-8 >= requiredFeet);
      if (!stockLength || !plans[previous]) continue;
      const candidate = { pieces: [...plans[previous].pieces, stockLength], purchasedFeet: plans[previous].purchasedFeet + stockLength };
      const current = plans[covered];
      if (!current || candidate.purchasedFeet < current.purchasedFeet - 1e-8 || (Math.abs(candidate.purchasedFeet - current.purchasedFeet) < 1e-8 && candidate.pieces.length < current.pieces.length)) plans[covered] = candidate;
    }
  }
  return plans[panelCount]?.pieces ?? [];
}


/* Fascia is cut to length off the board and the offcuts are mostly usable, so
   the tool being replaced allowed 5% here against 10% everywhere else
   (cad-sketch.js:900). Keeping the difference rather than rounding it into the
   global rate, because it changes what gets ordered. */
const FASCIA_WASTE_PERCENT = 5;

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
    /* These ARE the shop's recipes, shipped with one contractor's numbers as
       the defaults. They live in settings - per document, editable, saved with
       the project - because a different contractor runs different rules, and a
       rule a user cannot see or change is a hardcode wearing a hat. */
    settings: {
      wastePercent: 10,
      fieldBoardWidthInches: 5.5,
      fieldBoardGapInches: 0.1875,
      fieldBoardStockFeet: 16,
      squareEdgeStockFeet: 16,
      fasciaStockFeet: 12,
      // fascia offcuts are mostly reusable, so it runs leaner than the field
      fasciaWastePercent: 5,
      screwBoxCoverageSqFt: 100,
      // a box of SDWS screws, so the order is in boxes rather than loose pieces
      ledgerScrewBoxQuantity: 50,
      ledgerFlashingStockFeet: 10,
      stringersPerFlight: 3,
      /* DCR construction standards — a CUT length is not a PURCHASE length.
         A railing post is a 5 ft cut, but no yard sells a 5 ft 4x4: you buy a
         4x4x10 and get two posts out of it. Ordering "7 posts" is not
         orderable and 3.5 boards is not a thing, so the takeoff resolves the
         need into whole boards. */
      railingPostCutFeet: 5,
      railingPostStockFeet: 10,
      /* DCR Construction Standard — the shop's standard framing for a deck at
         or near grade. These are DCR's standard details, NOT an engineering
         calculation: nothing here verifies a span or checks a load, which is
         why every line derived from them reaches the takeoff 'preliminary'.
         A different jurisdiction or load changes them, so they are settings. */
      beamSize: '4x6',
      beamMaxPostSpacingFeet: 6,
      beamStockFeet: [8, 10, 12, 16, 20],
      postSize: '4x4',
      dcrcsPostCutFeet: 4,
      dcrcsPostStockFeet: 8,
      footingSizeInches: 16,
      concreteBagsPerFooting: 3,
      joistSize: '2x6',
      joistSpacingInches: 12,
      joistMaxSpanFeet: 6,
      // the project default; each beam may override it (a deck can mix)
      framingSystem: 'bottom',
      ledgerScrewsPerFoot: 5,
      ledgerFlashingStockFeet: 10,
      ...overrides.settings,
    },
    overrides: { ...overrides.overrides },
    /* The estimator's own words, keyed by line id. Kept apart from the
       calculation note, which is DERIVED on every read: change the stock
       length and the arithmetic note follows, while this text never moves
       unless a person edits it. Line ids are pure functions of content, so a
       note cannot drift onto a different material. */
    notes: { ...overrides.notes },
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

/* Cut-from-stock. Distinct from purchaseLine, which spreads linear feet across
   boards on the assumption that one board's offcut becomes the next run — true
   for decking, false for a post. Here each board yields a whole number of cuts
   and the remainder is an offcut, never half a board on the order. */
function yieldLine({ id, category, description, specification, piecesNeeded, cutFeet, stockFeet, sourceObjectIds = [], confidence = 'calculated' }) {
  const cut = Number(cutFeet) || 0;
  const stock = Number(stockFeet) || 0;
  const perStock = cut > 0 && stock >= cut ? Math.floor(stock / cut) : 1;
  const needed = Math.max(0, Math.ceil(Number(piecesNeeded) || 0));
  const boards = Math.ceil(needed / perStock);
  const leftover = boards * perStock - needed;
  return {
    id, category, description,
    specification: specification ?? `${stock} ft stock · ${perStock} cut${perStock === 1 ? '' : 's'} each`,
    stockLengthFeet: stock,
    calculatedQuantity: boards,
    quantity: boards,
    unit: 'ea',
    unitPrice: null,
    requiredLinearFeet: null,
    wastePercent: 0,
    origin: 'auto',
    confidence,
    sourceObjectIds,
    // what the note pane explains, kept as data rather than a sentence
    cutPlan: { piecesNeeded: needed, cutFeet: cut, stockFeet: stock, piecesPerStock: perStock, boards, leftoverCuts: leftover },
  };
}

function countLine({ id, category, description, specification, quantity, unit = 'ea', stockLengthFeet = null, sourceObjectIds = [], confidence = 'calculated' }) {
  return { id, category, description, specification, stockLengthFeet, calculatedQuantity: Math.ceil(quantity), quantity: Math.ceil(quantity), unit, unitPrice: null, requiredLinearFeet: null, wastePercent: 0, origin: 'auto', confidence, sourceObjectIds };
}

/* The framing modules hand back plain descriptors rather than finished lines,
   so they never have to import from here - that would be circular. This is the
   one place that turns them into takeoff lines. */
function fromDescriptors(descriptors, settings) {
  return descriptors.map((descriptor) => {
    if (descriptor.kind === 'count') {
      const line = countLine(descriptor);
      // countLine builds a fixed shape, so anything the note needs rides along
      return descriptor.beamPlan ? { ...line, beamPlan: descriptor.beamPlan } : line;
    }
    /* A module names the STANDARD it cuts from ('railingPost') rather than the
       numbers, so one edit in settings moves every line that uses it. */
    if (descriptor.kind === 'yield') {
      return yieldLine({
        ...descriptor,
        cutFeet: descriptor.cutFeet ?? settings[`${descriptor.standard}CutFeet`],
        stockFeet: descriptor.stockFeet ?? settings[`${descriptor.standard}StockFeet`],
      });
    }
    return purchaseLine(descriptor, descriptor.wastePercent === undefined
      ? settings
      : { ...settings, wastePercent: descriptor.wastePercent });
  });
}

/* Posts are counted ONCE per location.

   An explicitly drawn post sitting on a beam end is one post, not two. The
   Portal used to count getPosts() in post-footing and beam-derived posts in
   framing-standard with no dedup between them, which double-ordered every
   shared location. Upstream solved it by keying locations on a 1-inch grid,
   and that solution comes across whole. */
/* An edge is a ledger line when it runs against the house and has not been
   opted out - the same test the ledger module itself applies, so the board and
   its fasteners can never disagree about which edges count. */
function isLedgerEdge(edge) {
  const relationship = edge.properties?.classification?.relationship;
  const houseAttachment = edge.role === 'house' || relationship === 'house-attachment';
  return houseAttachment && edge.properties?.attachments?.ledger !== false;
}

function ledgerRunInches(document) {
  return (document.objects ?? [])
    .filter((object) => object.type === 'deck-boundary')
    .reduce((total, boundary) => {
      const byId = new Map((boundary.vertices ?? []).map((vertex) => [vertex.id, vertex]));
      return total + (boundary.edges ?? []).reduce((sum, edge) => {
        if (!isLedgerEdge(edge)) return sum;
        const start = byId.get(edge.startVertexId);
        const end = byId.get(edge.endVertexId);
        return sum + (start && end ? distance(start, end) : 0);
      }, 0);
    }, 0);
}

function ledgerFastenerLines(document, settings) {
  const inches = ledgerRunInches(document);
  if (inches <= 0) return [];
  const feet = inches / 12;
  const perFoot = Number(settings.ledgerScrewsPerFoot) || 0;
  const boxOf = Number(settings.ledgerScrewBoxQuantity) || 0;
  const out = [];
  if (perFoot > 0) {
    const screws = Math.ceil(feet * perFoot);
    // ordered in whole boxes, with the loose count kept in the specification
    const boxes = boxOf > 0 ? Math.ceil(screws / boxOf) : screws;
    out.push(countLine({
      id: 'auto:hardware:ledger-sdws-5',
      category: 'hardware',
      description: 'Simpson Strong-Tie SDWS Timber Screw 5\u2033',
      specification: boxOf > 0
        ? `${perFoot} per ft \u00b7 ${screws} needed \u00b7 ${boxOf} per box \u00b7 ${Math.round(feet * 10) / 10} lf of ledger`
        : `${perFoot} per ft \u00b7 ${Math.round(feet * 10) / 10} lf of ledger`,
      quantity: boxes,
      unit: boxOf > 0 ? 'box' : 'ea',
      sourceObjectIds: [],
      confidence: 'preliminary',
    }));
  }
  out.push(purchaseLine({
    id: 'auto:protection:ledger-j-flashing',
    category: 'protection',
    description: 'J flashing',
    specification: `${settings.ledgerFlashingStockFeet} ft length \u00b7 full ledger run`,
    requiredLinearFeet: feet,
    stockLengthFeet: settings.ledgerFlashingStockFeet,
    sourceObjectIds: [],
    confidence: 'preliminary',
  }, { ...settings, wastePercent: 0 }));
  return out;
}

function pointKey(point, tolerance = 1) {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`;
}

function deriveFramingTakeoff(document, settings) {
  const layer = getFramingLayer(document);
  const beams = descriptorLines(describeBeams(document));
  const joists = descriptorLines(describeJoists(document));
  // post-footing's own post/base/concrete lines are dropped: the deduplicated
  // set below replaces them, and keeping both would order each post twice
  const explicitDescriptors = describePosts(document)
    .filter((line) => !['auto:framing:post', 'auto:hardware:post-base', 'auto:framing:concrete-bag'].includes(line.id));
  const uniquePostLocations = new Map(getPosts(document).map((post) => [pointKey(post.at), { point: post.at, sourceId: post.id }]));
  deriveAllBeamGeometries(document, layer.settings).forEach((geometry) => {
    geometry.posts.forEach((post) => uniquePostLocations.set(pointKey(post), { point: post, sourceId: geometry.beam.id }));
  });
  const postLocations = [...uniquePostLocations.values()];
  const sourceObjectIds = [...new Set(postLocations.map((entry) => entry.sourceId))];
  const postCount = postLocations.length;
  const posts = postCount ? [
    yieldLine({
      id: 'auto:framing:post-stock', category: 'framing',
      description: `4\u00d74\u00d7${layer.settings.postStockFeet} post stock`,
      piecesNeeded: postCount,
      cutFeet: layer.settings.postCutFeet, stockFeet: layer.settings.postStockFeet,
      sourceObjectIds, confidence: 'preliminary',
    }),
    countLine({ id: 'auto:hardware:post-base', category: 'hardware', description: DCR_DEFAULT_POST_BASE.description,
      specification: 'One per post \u00b7 model/size to match post', quantity: postCount, sourceObjectIds, confidence: 'preliminary' }),
    countLine({ id: 'auto:framing:concrete-bag', category: 'framing', description: 'Concrete 60lb bag',
      specification: `${layer.settings.concreteBagsPerFooting} bags per footing`,
      quantity: postCount * layer.settings.concreteBagsPerFooting, sourceObjectIds, confidence: 'preliminary' }),
  ] : [];
  return [
    ...descriptorLines(describeLedgerTakeoff(document)),
    ...ledgerFastenerLines(document, settings),
    ...beams, ...joists,
    ...descriptorLines(describeJoistBlockingTakeoff(document)),
    ...descriptorLines(explicitDescriptors),
    ...posts,
  ];
}

function descriptorLines(descriptors) {
  return descriptors.map((descriptor) => countLine(descriptor));
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
  if (fasciaLF > 0) lines.push(purchaseLine({ id: 'auto:decking:fascia', category: 'decking', description: 'Fascia board', specification: `${settings.fasciaStockFeet} ft fascia`, requiredLinearFeet: fasciaLF, stockLengthFeet: settings.fasciaStockFeet, sourceObjectIds: boundaries.map((boundary) => boundary.id) }, { ...settings, wastePercent: Number(settings.fasciaWastePercent ?? FASCIA_WASTE_PERCENT) }));

  const stairTreadLF = stairs.reduce((sum, stair) => sum + Number(stair.dimensions?.width ?? 0) * Number(stair.dimensions?.treadCount ?? 0), 0) / 12;
  const stairRiserLF = stairs.reduce((sum, stair) => sum + Number(stair.dimensions?.width ?? 0) * Number(stair.dimensions?.riserCount ?? 0), 0) / 12;
  const stairIds = stairs.map((stair) => stair.id);
  if (stairTreadLF > 0) {
    lines.push(purchaseLine({ id: 'auto:stairs:grooved-tread', category: 'stairs', description: 'Grooved stair tread covering', specification: '12 ft board', requiredLinearFeet: stairTreadLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));
    lines.push(purchaseLine({ id: 'auto:stairs:square-nose', category: 'stairs', description: 'Square-edge stair nosing', specification: '12 ft board', requiredLinearFeet: stairTreadLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));
  }
  if (stairRiserLF > 0) lines.push(purchaseLine({ id: 'auto:stairs:square-riser', category: 'stairs', description: 'Square-edge stair riser covering', specification: '12 ft board', requiredLinearFeet: stairRiserLF, stockLengthFeet: 12, sourceObjectIds: stairIds, confidence: 'review' }, settings));

  /* Posts are counted over the Wild Hog runs ONLY. options.railingPostCount is
     analysed across every run in the project, so once stick-built and Trex
     started billing their own posts this line was adding theirs a second time. */
  const wildHog = (options.railingGeometries ?? []).filter((geometry) => (geometry.railing?.settings?.system ?? 'wild-hog') === 'wild-hog');
  /* A gate is a hole in this railing too. Stick-built and Trex runs were netted
     while Wild Hog - the DEFAULT system - billed its track and handrail straight
     across the opening. Panels and posts stay as laid out: a gate interrupts
     footage, not the post pattern. */
  const wildHogNet = netGateOpenings(
    wildHog.map((geometry) => ({ railing: geometry.railing, geometry, lengthInches: Number(geometry.length ?? 0) })),
    getGateOpenings(document));
  const railLengthInches = wildHogNet.reduce((sum, entry) => sum + entry.lengthInches, 0);
  const panelCount = wildHog.reduce((sum, geometry) => sum + Number(geometry.sectionCount ?? 0), 0);
  const railingIds = wildHog.map((geometry) => geometry.railing.id);
  if (panelCount > 0) {
    lines.push(countLine({ id: 'auto:railing:wild-hog-panel', category: 'railing', description: 'Wild Hog panel', specification: 'Panel', quantity: panelCount, sourceObjectIds: railingIds }));
    /* Sold as a complete 6 ft kit, one per panel - billing aluminium by the
       foot matched no SKU a supplier could quote against. */
    lines.push(countLine({ id: 'auto:railing:wild-hog-track', category: 'railing',
      description: '6 ft. Wild Hog Black Aluminum Hog Track Kit',
      specification: 'Complete 6 ft kit \u00b7 1 kit per railing panel',
      quantity: panelCount, sourceObjectIds: railingIds }));
    /* Planned per RUN rather than pooled off total footage, so joints land at
       posts: a 9'4" two-panel run buys one 10-footer, where pooling bought
       two 8-footers and cut both. */
    const handrailStock = new Map();
    wildHog.forEach((geometry) => {
      planWildHogHandrailStock(geometry).forEach((lengthFeet) => {
        const group = handrailStock.get(lengthFeet) ?? { quantity: 0, sourceObjectIds: [] };
        group.quantity += 1;
        group.sourceObjectIds.push(geometry.railing.id);
        handrailStock.set(lengthFeet, group);
      });
    });
    lines.push(...[...handrailStock.entries()].sort(([a], [b]) => a - b).map(([lengthFeet, group]) => countLine({
      id: `auto:railing:wild-hog-handrail:${lengthFeet}`,
      category: 'railing',
      description: '2\u00d76 DW handrail',
      specification: `2\u00d76\u00d7${lengthFeet} \u00b7 continuous across panels; joints land at posts`,
      quantity: group.quantity,
      stockLengthFeet: lengthFeet,
      sourceObjectIds: [...new Set(group.sourceObjectIds)],
    })));
    lines.push(countLine({ id: 'auto:railing:wild-hog-support', category: 'railing', description: 'Panel support', specification: '2×4×8 · top and bottom', quantity: panelCount * 2, sourceObjectIds: railingIds }));
    lines.push(yieldLine({ id: 'auto:railing:wild-hog-post', category: 'railing',
      description: `4x4x${settings.railingPostStockFeet} railing post stock`,
      piecesNeeded: analyzeRailingGeometries(wildHog).estimatedPostCount
        || wildHog.reduce((sum, geometry) => sum + Number(geometry.postCount ?? 0), 0),
      cutFeet: settings.railingPostCutFeet, stockFeet: settings.railingPostStockFeet,
      sourceObjectIds: railingIds }));
  }
  /* Framing: counted pieces, straight from the drawing. See the READMEs in
     tools/beam and tools/joist-group for why these are counts and not a
     lineal-feet buy off a stock length. */
  // beams, joists and posts now come through deriveFramingTakeoff below
  /* Count pins are how a rep tallies anything this tool has no idea about, so
     their labels reach the estimator verbatim. */
  lines.push(...fromDescriptors(describeSymbols(document), settings));
  /* The framing pipeline: ledger, beams and joists in commercial stock,
     blocking, and posts counted once per location. This supersedes the older
     DCRCS beam/post lines, which double-counted against beam.js once upstream
     moved stock planning into the beam itself. */
  lines.push(...deriveFramingTakeoff(document, settings));
  lines.push(...descriptorLines(describeRimJoistTakeoff(document)));
  lines.push(...descriptorLines(describeStairFramingTakeoff(document)));
  /* Stick-built and Trex only. Wild Hog is billed above and must not be billed
     twice. */
  lines.push(...fromDescriptors(describeRailingSystems(document, options), settings));

  /* Recipes the tool being replaced had and this one did not.
     Each carries its source line so the arithmetic can be checked later. */

  // cad-sketch.js:898 - roughly one 5lb box per 100 sq ft
  const deckSquareFeet = boundaries.reduce(
    (sum, boundary) => sum + (Number(boundary.computed?.areaSquareInches) || 0) / 144, 0);
  if (deckSquareFeet > 0) {
    lines.push(countLine({
      id: 'auto:hardware:deck-screw', category: 'hardware',
      description: '3" deck screw (5lb)', specification: `about one box per ${Number(settings.screwBoxCoverageSqFt) || 100} sq ft`,
      quantity: Math.ceil(deckSquareFeet / (Number(settings.screwBoxCoverageSqFt) || 100)),
      sourceObjectIds: boundaries.map((boundary) => boundary.id),
    }));
  }

  // cad-sketch.js:906 - three stringers to a flight
  if (stairs.length) {
    lines.push(countLine({
      id: 'auto:stairs:stringer', category: 'stairs',
      description: 'Stair stringer (2x12)', specification: `${Number(settings.stringersPerFlight) || 3} per flight`,
      quantity: stairs.length * (Number(settings.stringersPerFlight) || 3), sourceObjectIds: stairs.map((stair) => stair.id),
    }));
  }

  return lines;
}

/* The audit trail of a quantity, composed from the numbers the line already
   carries rather than stored as a sentence — so it stays true when a setting
   changes, and can be worded differently without touching the engine. */
export function calculationNote(line) {
  if (line.origin === 'manual') return 'Added by hand — no calculation behind it.';
  const plan = line.beamPlan;
  if (plan) {
    return `${plan.runFeet} lf of beam across ${plan.runs} run${plan.runs === 1 ? '' : 's'} · `
      + `posts every ${plan.spacingFeet} ft · spliced over a post`
      + (plan.offcutFeet > 0 ? ` · ${plan.offcutFeet} ft of offcut left over` : ' · no offcut');
  }
  const cut = line.cutPlan;
  if (cut && cut.piecesNeeded) {
    return `${cut.piecesNeeded} × ${cut.cutFeet} ft cuts needed · ${cut.piecesPerStock} per ${cut.stockFeet} ft board · `
      + `${cut.boards} board${cut.boards === 1 ? '' : 's'} to buy`
      + (cut.leftoverCuts ? ` · ${cut.leftoverCuts} cut${cut.leftoverCuts === 1 ? '' : 's'} left over` : ' · no offcut');
  }
  if (line.requiredLinearFeet != null && line.stockLengthFeet) {
    const withWaste = Math.round(line.requiredLinearFeet * (1 + line.wastePercent / 100) * 10) / 10;
    return `${line.requiredLinearFeet} lf needed`
      + (line.wastePercent ? ` + ${line.wastePercent}% waste = ${withWaste} lf` : '')
      + ` ÷ ${line.stockLengthFeet} ft stock = ${line.calculatedQuantity} board${line.calculatedQuantity === 1 ? '' : 's'}`;
  }
  return line.specification ? `Counted from the drawing · ${line.specification}` : 'Counted from the drawing.';
}

export function getTakeoffNote(document, lineId) {
  return getTakeoffState(document).notes[lineId] ?? '';
}

export function setTakeoffNote(document, lineId, text) {
  const state = getTakeoffState(document);
  const notes = { ...state.notes };
  const trimmed = String(text ?? '').trim();
  if (trimmed) notes[lineId] = trimmed; else delete notes[lineId];
  return setTakeoffState(document, { ...state, notes });
}

export function getEffectiveTakeoffLines(document, options = {}) {
  const state = getTakeoffState(document);
  const automatic = deriveAutomaticTakeoff(document, options).map((line) => {
    const override = state.overrides[line.id] ?? {};
    /* ANY human edit makes the line 'adjusted', not just a quantity. A
       renamed line that still read AUTO would claim the tool chose that
       wording, and the calculated figure is preserved either way so the
       original is never lost. */
    const touched = override.quantity !== undefined || override.description !== undefined;
    const merged = {
      ...line, ...override,
      calculatedQuantity: line.calculatedQuantity,
      calculatedDescription: line.description,
      origin: touched ? 'adjusted' : 'auto',
    };
    return { ...merged, calcNote: calculationNote(merged), note: state.notes[line.id] ?? '' };
  });
  return [...automatic, ...state.manualLines.map((line) => ({
    ...line, origin: 'manual', calculatedQuantity: null,
    calcNote: calculationNote({ ...line, origin: 'manual' }), note: state.notes[line.id] ?? '',
  }))];
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
    if (options.includeNotes === true) { exported.calcNote = line.calcNote; exported.note = line.note; }
    return exported;
  });
  return { schema: 'com.dcr.cme.takeoff', schemaVersion: 1, project: { id: document.id, name: document.name }, generatedAt: options.now ?? new Date().toISOString(), pricingIncluded: includePrices, summary: { materialLineCount: lines.length, adjustedLineCount: lines.filter((line) => line.origin === 'adjusted').length, manualLineCount: lines.filter((line) => line.origin === 'manual').length }, lines };
}

function constructionRole(description = '') {
  const text = String(description).toLowerCase();
  if (text.includes('stair stringer')) return 'Stair stringer';
  if (text.includes('stair ledger') || text.includes('stair header')) return 'Stair ledger / header';
  if (text.includes('joist blocking')) return 'Joist blocking';
  if (text.includes('rim joist') || text.includes('flush beam')) return 'Rim / flush';
  if (text.includes('ledger')) return 'Ledger';
  if (text.includes('joist')) return 'Joist';
  if (text.includes('beam')) return 'Beam';
  return null;
}

function lumberBase(description = '') {
  return String(description)
    .replace(/\bstair ledger\s*\/\s*header\b|\bstair stringer\b|\bjoist blocking\b|\brim joist\s*\/\s*flush beam\b|\brim joist\b|\bflush beam\b|\bledger\b|\bjoist\b|\bbeam\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Produces a purchasing view: identical stock is grouped regardless of the
 * construction role that generated it. The detailed Takeoff remains unchanged.
 */
export function consolidateTakeoffLines(lines = []) {
  const groups = new Map();
  lines.forEach((line) => {
    const role = constructionRole(line.description);
    const base = role && line.stockLengthFeet ? lumberBase(line.description) : String(line.description ?? '').trim();
    const stock = Number(line.stockLengthFeet) || null;
    const key = [base.toLowerCase(), stock ?? '', String(line.unit ?? 'ea').toLowerCase(), stock ? '' : String(line.specification ?? '').trim().toLowerCase()].join('|');
    const group = groups.get(key) ?? {
      ...line,
      id: `consolidated:${groups.size + 1}`,
      category: role && stock ? 'framing' : line.category,
      description: role && stock ? `${base} lumber` : line.description,
      specification: stock ? `${stock} ft stock` : line.specification,
      calculatedQuantity: 0,
      quantity: 0,
      requiredLinearFeet: 0,
      origin: 'consolidated',
      sourceObjectIds: [],
      sourceRoles: [],
      allCalculated: true,
      allRequiredLinearFeet: true,
      allPriced: true,
      pricedSubtotal: 0,
    };
    const quantity = Number(line.quantity) || 0;
    group.quantity += quantity;
    if (line.calculatedQuantity != null && Number.isFinite(Number(line.calculatedQuantity))) group.calculatedQuantity += Number(line.calculatedQuantity);
    else group.allCalculated = false;
    if (line.requiredLinearFeet != null && Number.isFinite(Number(line.requiredLinearFeet))) group.requiredLinearFeet += Number(line.requiredLinearFeet);
    else group.allRequiredLinearFeet = false;
    if (line.unitPrice == null) group.allPriced = false;
    else group.pricedSubtotal += quantity * Number(line.unitPrice);
    group.sourceObjectIds.push(...(line.sourceObjectIds ?? []));
    if (role) group.sourceRoles.push(role);
    groups.set(key, group);
  });
  return [...groups.values()].map((group) => {
    const sourceRoles = [...new Set(group.sourceRoles)];
    const specification = sourceRoles.length
      ? `${group.specification} · combined: ${sourceRoles.join(', ')}`
      : group.specification;
    const result = {
      ...group,
      specification,
      quantity: round(group.quantity),
      calculatedQuantity: group.allCalculated ? round(group.calculatedQuantity) : null,
      requiredLinearFeet: group.allRequiredLinearFeet ? round(group.requiredLinearFeet) : null,
      unitPrice: group.allPriced && group.quantity ? round(group.pricedSubtotal / group.quantity) : null,
      sourceObjectIds: [...new Set(group.sourceObjectIds)],
      confidence: group.confidence === 'calculated' ? 'calculated' : 'preliminary',
    };
    delete result.sourceRoles;
    delete result.allCalculated;
    delete result.allRequiredLinearFeet;
    delete result.allPriced;
    delete result.pricedSubtotal;
    return result;
  });
}
