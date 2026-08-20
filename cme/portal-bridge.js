/* Carries a CME drawing back to the estimate that opened it.

   Three jobs:
     - raster the SVG canvas to a PNG the estimate gallery can show, with the
       takeoff table printed underneath so a saved drawing still explains
       itself a year later;
     - work out the four numbers the estimate form reads;
     - hand the whole lot to the parent window.

   It hooks the existing "Save to Step 1" button in the capture phase rather
   than editing app.js, so the app stays the upstream app and this file stays
   the only portal-specific thing in the tree. */

import { deriveDrawingNumbers, deriveDrawingBreakdown } from './src/core/integrations/dcr-portal-numbers.js';
import { deriveAutomaticTakeoff, getTakeoffState } from './src/tools/takeoff/takeoff.js';
import { formatFeetInches } from './src/core/units/length.js';

const PORTAL = window.CME_PORTAL || {};

/* SharePoint stores every drawing and photo for an estimate in ONE text
   column. Measured 2026-08-20: it accepts 2,097,152 characters and Graph
   refuses past that with a 400 rather than truncating — so nothing is lost
   silently, but the save does fail. Warn well before the cliff, since this
   drawing shares the column with every other drawing and photo on the job. */
const MEDIA_COLUMN_LIMIT = 2_097_152;
const SAFE_DOCUMENT_BUDGET = 700_000;

// The sales image endpoint refuses anything larger (handlers.js IMAGE_MAX_BYTES).
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/* requestAnimationFrame does not fire in a tab that is not compositing - a
   backgrounded tab, or a hidden one. Waiting on it alone meant the export hung
   forever with the button stuck on "Saving...". Whichever comes first wins;
   the frame is a nicety to let a re-render settle, not a requirement. */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 60);
});

// Same reasoning: never let a raster stall the save path indefinitely.
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(what + ' took too long.')), ms)),
  ]);
}

/* Audio never goes in the project document.

   A CAT voice note is kept as an inline base64 data URL — about 700 KB for a
   minute — and a couple of those would push the shared column past its ceiling
   and take the save down with them. The note keeps its text; the recording is
   dropped from what is transmitted. */
function stripForTransport(document) {
  let removed = 0;
  const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'audioDataUrl' && typeof entry === 'string' && entry) { removed += 1; continue; }
        out[key] = clean(entry);
      }
      return out;
    }
    return value;
  };
  return { document: clean(document), removedRecordings: removed };
}

/* A serialized SVG rendered through an Image gets no external stylesheet, so
   the rules the canvas needs have to travel inside it. These are written for
   white paper rather than the dark editor: a dark-on-dark PNG in a light
   gallery tile is useless.

   The class names are the LIVE ones. The stylesheet's own @media print block
   still names .dimension-box and .area-dimension-text, which do not exist —
   which is why dimension labels have never re-inked for printing either. */
const PAPER_STYLE = `
  .model-canvas { background: #ffffff; }
  text { font-family: Arial, Helvetica, sans-serif; }
  .grid-minor { stroke: #eef1f2; stroke-width: 1; }
  .grid-major { stroke: #d9dfe1; stroke-width: 1; }
  .axis-line  { stroke: #bec7ca; stroke-width: 1; }
  .boundary-fill { fill: rgba(84,214,199,0.10); stroke: #167f75; }
  .boundary-edge, .boundary-edge-visible { stroke: #167f75; stroke-width: 2.5; }
  .demolition-edge { stroke: #b4552d; stroke-width: 2.5; stroke-dasharray: 8 5; }
  .fascia-board { stroke: #1f6f8b; stroke-width: 3; }
  .deck-boarding-line { stroke: #9bb3ba; stroke-width: 1; }
  .vertex, .constraint-anchor { fill: #ffffff; stroke: #167f75; stroke-width: 1.5; }
  .railing-run, .railing-run-visible { stroke: #2f6fb5; stroke-width: 3; }
  .railing-post { fill: #2f6fb5; }
  .stair-tread, .stair-outline, .stair-edge { stroke: #4a5a63; stroke-width: 2; fill: none; }
  .level-down, .level-down-marker, .level-down-fascia { stroke: #7a5ea8; stroke-width: 2; }
  .cat-line, .cat-measure-leg, .cat-measure-direct { stroke: #8f7712; stroke-width: 1.5; }
  .cat-guide-line { stroke: #c9b25a; stroke-width: 1; stroke-dasharray: 5 4; }
  .cat-measure-bg, .cat-note-bg { fill: #ffffff; stroke: #8f7712; }
  .cat-measure-text, .cat-note-text { fill: #594a0c; }
  .dimension-annotation, .dimension-line, .dimension-arrow { stroke: #4f5d64; stroke-width: 1.2; }
  .dimension-bg { fill: #ffffff; stroke: #4f5d64; }
  .dimension-text { fill: #111111; }
  .area-dimension, .dimension-text.area { fill: #111111; }
  /* the transparent twins exist only to catch a fingertip; they carry no ink */
  [class$="-hit"], .dimension-hit, .cat-line-hit, .cat-note-hit, .level-down-hit { display: none; }
  .cursor-crosshair, .snap-indicator, .cat-snap-marker, .dimension-arrow-pulse { display: none; }
`;

function svgForPaper(source) {
  const clone = source.cloneNode(true);
  clone.removeAttribute('class');
  clone.setAttribute('class', 'model-canvas');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  /* vector-effect is honoured inconsistently during rasterization, and about
     forty rules rely on it. Explicit widths above, and the attribute stripped
     here, so the line weights survive the trip to the canvas. */
  clone.querySelectorAll('[vector-effect]').forEach((node) => node.removeAttribute('vector-effect'));
  clone.querySelectorAll('[class$="-hit"]').forEach((node) => node.remove());

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = PAPER_STYLE;
  clone.insertBefore(style, clone.firstChild);

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  const box = (clone.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
  background.setAttribute('x', box[0]); background.setAttribute('y', box[1]);
  background.setAttribute('width', box[2]); background.setAttribute('height', box[3]);
  background.setAttribute('fill', '#ffffff');
  clone.insertBefore(background, style.nextSibling);
  return { clone, box };
}

function takeoffRows(documentModel) {
  const lines = deriveAutomaticTakeoff(documentModel, {});
  const state = getTakeoffState(documentModel);
  const manual = state.manualLines || [];
  return [...lines, ...manual]
    .filter((line) => Number(line.quantity) > 0)
    .map((line) => [
      line.category || '',
      line.description || '',
      `${line.quantity} ${line.unit || 'ea'}`,
    ]);
}

/* The drawing, then its takeoff, on one white sheet. The table is what the old
   tool printed underneath its sketch, and it is the reason a saved image is
   worth anything once the drawing tool has moved on. */
export async function exportSketchPng(documentModel, { width = 1600 } = {}) {
  const live = document.querySelector('.model-canvas');
  if (!live) throw new Error('There is no drawing canvas to export.');
  await nextFrame();

  const { clone, box } = svgForPaper(live);
  const aspect = box[3] / box[2] || 0.66;
  const drawingHeight = Math.min(Math.round(width * aspect), 2000);
  clone.setAttribute('width', width);
  clone.setAttribute('height', drawingHeight);

  const rows = takeoffRows(documentModel);
  const rowHeight = 30;
  const tableHeight = rows.length ? 54 + rows.length * rowHeight + 16 : 0;

  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = url;
    await withTimeout(image.decode(), 15000, 'Rendering the drawing image');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = drawingHeight + tableHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, width, drawingHeight);

    if (rows.length) {
      const top = drawingHeight;
      ctx.fillStyle = '#1b2733';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 22px Arial';
      ctx.fillText('TAKEOFF', 26, top + 30);
      ctx.font = '18px Arial';
      rows.forEach((row, index) => {
        const y = top + 54 + index * rowHeight;
        ctx.fillStyle = index % 2 ? '#ffffff' : '#fafbfc';
        ctx.fillRect(20, y, width - 40, rowHeight);
        ctx.fillStyle = '#5a6b7d';
        ctx.fillText(row[0], 30, y + rowHeight / 2);
        ctx.fillStyle = '#1b2733';
        ctx.fillText(row[1], 190, y + rowHeight / 2);
        ctx.textAlign = 'right';
        ctx.font = 'bold 18px Arial';
        ctx.fillText(row[2], width - 34, y + rowHeight / 2);
        ctx.textAlign = 'left';
        ctx.font = '18px Arial';
      });
    }

    let dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length * 0.75 > IMAGE_MAX_BYTES) dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function buildSavePayload(documentModel) {
  const numbers = deriveDrawingNumbers(documentModel);
  const breakdown = deriveDrawingBreakdown(documentModel);
  const { document: transportable, removedRecordings } = stripForTransport(documentModel);
  const serialized = JSON.stringify(transportable);

  return {
    numbers,
    breakdown,
    takeoff: takeoffRows(documentModel),
    project: transportable,
    serializedLength: serialized.length,
    removedRecordings,
    tooLarge: serialized.length > SAFE_DOCUMENT_BUDGET,
    hardLimit: MEDIA_COLUMN_LIMIT,
    summary: `${numbers.deckSF} sq ft · ${formatFeetInches(numbers.railLF * 12)} railing · ${numbers.stairs} stair${numbers.stairs === 1 ? '' : 's'}`,
  };
}

/* Hooked in the capture phase so app.js's own handler never runs. Editing
   app.js would work too, but keeping this file the only portal-aware thing in
   the tree means the upstream app can be re-imported without re-patching. */
function install(getDocument) {
  document.addEventListener('click', async (event) => {
    const button = event.target.closest?.('[data-action="save-step-one"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const documentModel = getDocument();
      const payload = buildSavePayload(documentModel);

      if (payload.tooLarge) {
        const proceed = await (PORTAL.confirm ? PORTAL.confirm(
          `This drawing is unusually large (${Math.round(payload.serializedLength / 1024)} KB). ` +
          'It shares one storage field with every other drawing and photo on this estimate, ' +
          'and if the total goes past about 2 MB the save will be refused. Try anyway?',
          { title: 'Large drawing', okText: 'Try the save' }) : Promise.resolve(true));
        if (!proceed) return;
      }

      payload.png = await exportSketchPng(documentModel);

      const target = window.parent !== window ? window.parent : window.opener;
      if (!target) throw new Error('This drawing was not opened from an estimate, so there is nowhere to save it.');
      target.postMessage({ type: 'dcr.cme.save', payload }, location.origin);
    } catch (error) {
      console.error('[CME] save failed', error);
      if (PORTAL.alert) await PORTAL.alert(error.message || 'Could not save this drawing.', { title: 'Not saved' });
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }, true);
}

window.CME_BRIDGE = { install, exportSketchPng, buildSavePayload, stripForTransport };
