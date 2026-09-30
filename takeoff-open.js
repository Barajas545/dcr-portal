/* DCR portal — open a .takeoff project in Professional Takeoff Tools.

   Shared by the project page (Files tab and the item-files panel) and the
   search page (the plan-files menu on a project tile), so the handoff to the
   tool is written once. Exposes window.DCRTakeoff = { open, isTakeoff, APP }. */

(function () {
  /* Takeoff projects open in the web build of the estimating app.

     Where it lives is configurable, but both apps are GitHub Pages sites on
     barajas545.github.io, so the default sits beside this one. Same origin is
     not a convenience here — it is what lets the handoff go through
     sessionStorage instead of the address bar. */
  var APP = (window.DCR_CONFIG && window.DCR_CONFIG.TAKEOFF_URL) || "../takeoff-web/";

  function isTakeoff(name) { return /\.(takeoff|pdfcache)$/i.test(String(name || "")); }

  /* Open a .takeoff project without downloading it.

     The app reads a project by slicing it — header, metadata and page index
     only, about 2 KB even on a 2.3 GB job — and SharePoint’s pre-authed URL
     serves byte ranges, so it never fetches the whole file. The 155 MB Cooper
     Road plan set opens on about 40 KB. Handing over a blob instead would mean
     155 MB through a phone before the first sheet appeared.

     The link goes through sessionStorage rather than the URL: it is a
     credential, and a query string lands in history and in the Referer header.
     Only a one-shot key travels in the hash, and the app consumes it on
     arrival. The file id and token key go with it so the app can mint a fresh
     link when this one expires mid-afternoon.

     iconEl is the element whose text shows the file's icon; it reads ⏳ while
     the link is fetched and gets its old text back if that fails. It may be
     null (a listing whose icon is plain text), which means no swap. Resolves
     true once the page is on its way to the tool, false after the failure
     alert, so a caller can put its own buttons back.

     opts.proceed, if given, is asked once the link is back. Fetching it can
     take a few seconds on a cold server, and a caller whose owner has closed
     its menu or moved on meanwhile answers false: the page then stays where
     it is, with no alert, and open resolves false. */
  async function open(fileId, fallbackName, iconEl, opts) {
    var icon = iconEl || null;
    var was = icon ? icon.textContent : "";
    var proceed = opts && typeof opts.proceed === "function" ? opts.proceed : null;
    if (icon) icon.textContent = "⏳";
    try {
      var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(fileId));
      if (proceed && !proceed()) {
        if (icon) icon.textContent = was;
        return false;
      }
      if (!info || !info.downloadUrl) throw new Error("No download link for this file.");

      var key = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("ptt.open." + key, JSON.stringify({
        v: 1,
        name: info.name || fallbackName || "project.takeoff",
        size: Number(info.size) || 0,
        url: info.downloadUrl,
        renew: {
          url: DCR.API_BASE + "/api/portal?action=drive&fileInfo=" + encodeURIComponent(fileId),
          tokenKey: "dcr_portal_token",
        },
      }));
      // Coming Back from the tool can restore this page from the browser's
      // page cache exactly as it was left, ⏳ and all. Put the icon back then,
      // so the row does not look like it is still opening.
      if (icon) {
        window.addEventListener("pageshow", function (e) {
          if (e.persisted) icon.textContent = was;
        }, { once: true });
      }
      location.href = APP + "index.html#open=" + encodeURIComponent(key);
      return true;
    } catch (e) {
      if (icon) icon.textContent = was;
      // Nor an alert about a file the owner has already walked away from.
      if (proceed && !proceed()) return false;
      DCR.alert((e && e.message) || "Could not open that project.",
                { title: "Could not open" });
      return false;
    }
  }

  window.DCRTakeoff = { open: open, isTakeoff: isTakeoff, APP: APP };
})();
