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
})();
