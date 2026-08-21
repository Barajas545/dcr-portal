export const SALES_HUB_STEP_ONE_SCHEMA = 'com.dcr.sales-hub.step-1.cme';
export const SALES_HUB_STEP_ONE_VERSION = 1;
export const SALES_HUB_MESSAGE_TYPE = 'dcr.cme.step1.ready';

const round = (value, precision = 2) => Number(Number(value).toFixed(precision));
const squareFeet = (squareInches) => round((Number(squareInches) || 0) / 144);
const linearFeet = (inches) => round((Number(inches) || 0) / 12);

export function createSalesHubStepOnePayload(document, options = {}) {
  const deckAreas = document.objects
    .filter((object) => object.type === 'deck-boundary')
    .map((boundary) => ({
      boundaryId: boundary.id,
      name: boundary.name ?? 'Deck area',
      squareFeet: squareFeet(boundary.computed?.areaSquareInches),
      downLevelInches: Number(boundary.metadata?.levelDownInches ?? 0),
    }));
  const railingRuns = (options.railingRuns ?? []).map((run) => ({
    railingId: run.id,
    type: run.system ?? 'unassigned',
    linearFeet: linearFeet(run.lengthInches),
  }));
  const railingByType = Object.entries(railingRuns.reduce((totals, run) => {
    totals[run.type] = (totals[run.type] ?? 0) + run.linearFeet;
    return totals;
  }, {})).map(([type, total]) => ({ type, linearFeet: round(total) }));
  const stairs = document.objects.filter((object) => object.type === 'stair');

  return {
    schema: SALES_HUB_STEP_ONE_SCHEMA,
    schemaVersion: SALES_HUB_STEP_ONE_VERSION,
    exportedAt: options.now ?? new Date().toISOString(),
    opportunityId: options.opportunityId ?? null,
    sketch: {
      projectId: document.id,
      projectName: document.name,
      modelSchema: document.schema,
      modelSchemaVersion: document.schemaVersion,
      workflowStage: document.workflow?.stage ?? 'field-capture',
      updatedAt: document.updatedAt,
    },
    quantities: {
      decking: {
        squareFeet: round(deckAreas.reduce((total, area) => total + area.squareFeet, 0)),
        areaCount: deckAreas.length,
        areas: deckAreas,
      },
      railing: {
        linearFeet: round(railingRuns.reduce((total, run) => total + run.linearFeet, 0)),
        runCount: railingRuns.length,
        byType: railingByType,
        runs: railingRuns,
      },
      stairs: { count: stairs.length },
    },
  };
}

export function createSalesHubStepOneMessage(payload) {
  return { type: SALES_HUB_MESSAGE_TYPE, schemaVersion: SALES_HUB_STEP_ONE_VERSION, payload };
}

/* Where a sketch is allowed to be sent.

   This used to accept ANY syntactically valid origin off the query string, and
   http: as well as https:. The payload is a customer's deck design, so anyone
   who could hand a rep a link - a text message, a QR code on a flyer - chose
   where that design was posted. An allowlist is the whole fix.

   Same-origin is always permitted: hosted inside the portal, CME talks to its
   own parent and never needs postMessage at all. */
/* Same-origin and localhost are always safe; every DEPLOYED origin is supplied
   by the host through window.CME_PORTAL.salesHubOrigins. Hardcoding a
   deployment's URLs here tied the engine to one company's portal - and this
   engine is meant to serve any contractor's. */
export const SALES_HUB_ALLOWED_ORIGINS = [];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (typeof location !== 'undefined' && origin === location.origin) return true;
  if (SALES_HUB_ALLOWED_ORIGINS.includes(origin)) return true;
  const supplied = (typeof window !== 'undefined' && window.CME_PORTAL?.salesHubOrigins) || [];
  if (Array.isArray(supplied) && supplied.includes(origin)) return true;
  // localhost over http only, for development
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function parseSalesHubLaunchContext(search = '') {
  const parameters = new URLSearchParams(search);
  const opportunityId = parameters.get('cmeOpportunityId');
  const requestedOrigin = parameters.get('cmeSalesHubOrigin');
  let targetOrigin = null;
  let rejectedOrigin = null;
  if (requestedOrigin) {
    try {
      const url = new URL(requestedOrigin);
      const wellFormed = url.protocol === 'https:' || url.protocol === 'http:';
      if (wellFormed && url.origin === requestedOrigin && isAllowedOrigin(url.origin)) {
        targetOrigin = url.origin;
      } else {
        rejectedOrigin = requestedOrigin;
      }
    } catch {
      rejectedOrigin = requestedOrigin;
    }
  }
  if (rejectedOrigin && typeof console !== 'undefined') {
    console.warn('[CME] refusing to send the sketch to an unrecognised origin:', rejectedOrigin);
  }
  return {
    opportunityId,
    targetOrigin,
    rejectedOrigin,
    connected: Boolean(opportunityId && targetOrigin),
  };
}
