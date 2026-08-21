/* Starts CME inside the portal.

   Order matters here. app.js ends with a bare render() at module scope, so it
   draws the instant it is imported — before an async auth check could finish.
   Importing it dynamically, after requireAuth() resolves, is what keeps an
   unauthenticated visitor from seeing a working editor for a second.

   Everything the portal offers the app is put on window.CME_PORTAL rather than
   imported, so the module tree still loads standalone (npm start) with no
   portal present. */

const DCR = window.DCR;

function fail(why) {
  const box = document.getElementById('cmeBootError');
  const line = document.getElementById('cmeBootWhy');
  if (line) line.textContent = why;
  if (box) box.style.display = 'block';
}

try {
  if (!DCR || typeof DCR.requireAuth !== 'function') {
    throw new Error('The portal scripts did not load, so sign-in could not be checked.');
  }

  // Redirects to the sign-in page when there is no valid token.
  const profile = await DCR.requireAuth();

  const qs = new URLSearchParams(location.search);

  /* An existing drawing is handed over through sessionStorage, not postMessage
     or the URL. The integration has no inbound message channel at all, a
     message would race the module boot, and a project document is far past any
     sane URL length. sessionStorage is same-origin, survives the navigation,
     and is read once and deleted. */
  let incoming = null;
  const handoffKey = qs.get('cmeHandoff');
  if (handoffKey) {
    try {
      const raw = sessionStorage.getItem(handoffKey);
      sessionStorage.removeItem(handoffKey);
      if (raw) incoming = JSON.parse(raw);
    } catch (error) {
      console.warn('[CME] could not read the handed-over drawing:', error);
    }
  }

  const estimateId = qs.get('estimateId') || null;

  window.CME_PORTAL = {
    profile,
    estimateId,
    entryId: qs.get('entryId') || null,
    clientName: qs.get('clientName') || '',
    incoming,
    fresh: qs.get('cmeFresh') === '1',
    /* The origins a sketch may be posted to, supplied HERE rather than
       hardcoded in cme/src - the engine stays independently deployable and a
       different contractor's portal names its own origins at this seam. */
    salesHubOrigins: ['https://barajas545.github.io', 'https://dcrframing.github.io'],
    returnTo: estimateId
      ? 'estimate-deck.html?id=' + encodeURIComponent(estimateId)
      : 'estimates.html',
    /* Read off the global at call time, never captured, so the app still runs
       with no portal around it. */
    api: (...args) => window.DCR.api(...args),
    esc: (v) => window.DCR.esc(v),
    confirm: (...args) => window.DCR.confirm(...args),
    alert: (...args) => window.DCR.alert(...args),
    ask: (...args) => window.DCR.ask(...args),
    uploadQueue: () => window.DCR.uploadQueue,
  };

  /* One drawing belongs to one estimate. CME's own library key is device-wide
     with an activeProjectId, so without this the project switcher on a shared
     tablet lists — and can silently attach — another customer's deck. */
  window.CME_STORAGE_SCOPE = estimateId ? 'estimate-' + estimateId : 'standalone';

  await import('./src/ui/app.js');

  /* After the app, so window.CME_CURRENT_DOCUMENT exists to read from. */
  await import('./portal-bridge.js');
  window.CME_BRIDGE.install(() => window.CME_CURRENT_DOCUMENT());
} catch (error) {
  console.error('[CME] boot failed', error);
  fail((error && error.message) || 'Something went wrong starting the drawing tool.');
}
