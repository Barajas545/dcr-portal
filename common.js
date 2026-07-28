// Shared helpers for all portal pages. No secrets here — auth is a signed token
// issued by the backend and stored only in this browser.
(function () {
  const cfg = window.DCR_CONFIG || {};
  const API_BASE = (cfg.API_BASE || "").replace(/\/$/, "");
  const TOKEN_KEY = "dcr_portal_token";

  const DCR = {
    API_BASE,
    company: (cfg.COMPANY && cfg.COMPANY.name) || cfg.COMPANY_NAME || "DCR",
    // Full company block for letterheads etc. — missing fields come back "".
    companyInfo: Object.assign(
      { name: "DCR", legalName: "", logo: "logo.png", address: "", phone: "",
        fax: "", email: "", website: "", license: "" },
      cfg.COMPANY || {}
    ),

    getToken() {
      return localStorage.getItem(TOKEN_KEY) || "";
    },
    setToken(t) {
      localStorage.setItem(TOKEN_KEY, t);
    },
    clearToken() {
      localStorage.removeItem(TOKEN_KEY);
    },

    // Fetch wrapper. Adds the Bearer token, parses JSON, throws on non-2xx.
    async api(path, { method = "GET", body, auth = true } = {}) {
      const headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auth) {
        const token = DCR.getToken();
        if (token) headers.Authorization = "Bearer " + token;
      }
      const res = await fetch(API_BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        /* no body */
      }

      if (res.status === 401 && auth) {
        // Session gone — bounce to login (unless we're already there).
        DCR.clearToken();
        if (!/index\.html$|\/$/.test(location.pathname)) {
          location.href = "index.html";
        }
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },

    // Load the current user or redirect to login. Returns the profile object.
    async requireAuth() {
      if (!DCR.getToken()) {
        location.href = "index.html";
        throw new Error("not signed in");
      }
      try {
        return await DCR.api("/api/portal?action=me");
      } catch (e) {
        location.href = "index.html";
        throw e;
      }
    },

    logout() {
      DCR.clearToken();
      location.href = "index.html";
    },

    // Fetch an authenticated portal endpoint as a blob object-URL (for <img>
    // tags that can't send Authorization headers). Cached per path.
    _blobCache: {},
    async blobUrl(path) {
      if (DCR._blobCache[path]) return DCR._blobCache[path];
      const res = await fetch(API_BASE + path, {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      if (!res.ok) throw new Error("Image load failed (" + res.status + ")");
      const url = URL.createObjectURL(await res.blob());
      DCR._blobCache[path] = url;
      return url;
    },

    // Escape untrusted strings before inserting into HTML.
    esc(v) {
      return String(v ?? "").replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
      );
    },
  };

  window.DCR = DCR;

  // Register the service worker so the portal is installable as an app and
  // opens offline. Registered once; the browser scopes it to /dcr-portal/.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* non-fatal */ });
    });
  }

  // ── Single-instance guard (installed app only) ───────────────────────────
  // Windows opens a brand-new window every time you launch an installed PWA.
  // The manifest's launch_handler:"focus-existing" tells the browser to reuse
  // the existing window; this is the belt-and-suspenders fallback: if a second
  // app window ever appears, it shows a notice and hands control back to the one
  // window that holds an exclusive Web Lock — auto-activating when the other
  // closes. Scoped to display-mode:standalone so it never restricts browser tabs.
  (function () {
    var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      window.navigator.standalone === true;
    if (!standalone || !navigator.locks || !navigator.locks.request) return;

    var LOCK = "dcr-portal-single-instance";
    var overlay = null;

    function showOverlay() {
      if (overlay) { overlay.style.display = "flex"; return; }
      overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;gap:14px;text-align:center;padding:28px;background:#0f141a;" +
        "color:#e6ebf1;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;";
      overlay.innerHTML =
        '<div style="font-size:40px">📲</div>' +
        '<div style="font-size:18px;font-weight:700">DCR Portal is already open</div>' +
        '<div style="font-size:14px;opacity:.75;max-width:340px;line-height:1.5">It’s running in another window. ' +
        'Switch to that window — this one activates automatically when you close the other.</div>' +
        '<button id="dcrSiReload" style="margin-top:6px;padding:9px 16px;border-radius:8px;border:1px solid #2a333d;' +
        'background:#171d25;color:#e6ebf1;font-weight:600;cursor:pointer">Reload this window</button>';
      (document.body || document.documentElement).appendChild(overlay);
      overlay.querySelector("#dcrSiReload").onclick = function () { location.reload(); };
    }

    function becomePrimary() {
      if (overlay) overlay.style.display = "none";
      return new Promise(function () {}); // hold the lock for this window's lifetime
    }

    navigator.locks.request(LOCK, { ifAvailable: true }, function (lock) {
      if (lock) return becomePrimary(); // we are the only instance
      // Another window holds the lock. Wait a moment (to ignore the brief overlap
      // during in-app page navigation), then show the notice if still blocked.
      var t = setTimeout(function () {
        if (document.body) showOverlay();
        else document.addEventListener("DOMContentLoaded", showOverlay);
      }, 400);
      return navigator.locks.request(LOCK, { mode: "exclusive" }, function () {
        clearTimeout(t);
        return becomePrimary(); // the other window closed — take over
      });
    });
  })();
})();
