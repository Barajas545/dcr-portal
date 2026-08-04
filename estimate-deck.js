/* DCR portal — Deck Estimate wizard.
   Port of the DCR Sales Hub prototype (reference/dcr-sales-hub) onto the portal:
   comps live in the SalesReferenceProjects SharePoint list, estimates save to
   SalesEstimates (action=sales), materials come from deck-materials.json.

   Flow: 1 Project info → 2 Similar projects (scored comps, pick a reference)
         → 3 Materials → 4 Review → 5 Preliminary estimate (save / print).

   The scoring + estimate math is ported verbatim from the prototype's
   ProjectMatcher and EstimateEngine (see reference/dcr-sales-hub/docs).
   Pricing honesty rule preserved: material pricing is never fabricated —
   totals come only from completed-project cost history. */

(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var qs = new URLSearchParams(location.search);
  var EDIT_ID = qs.get("id") || null;      // reopen a saved estimate
  var START_NEW = qs.get("new") === "1";   // begin a blank estimate
  var DRAFT_KEY = "dcrDeckEstDraft";

  var PROJECT_TYPES = [
    { id: "new-deck", t: "New deck", d: "Built from the ground up — framing area matches decking." },
    { id: "resurface", t: "Resurface", d: "Existing framing kept; new deck boards only." },
    { id: "deck-expansion", t: "Expansion", d: "Existing deck enlarged — enter only the NEW framing area." },
    { id: "partial-rebuild", t: "Partial rebuild", d: "Some framing replaced — enter the replaced area." },
  ];
  var COMPLEXITY = [
    { id: "standard", t: "Standard", d: "Rectangular layout, easy access, single level." },
    { id: "moderate", t: "Moderate", d: "Some angles, slope, or elevated sections." },
    { id: "complex", t: "Complex", d: "Multi-level, hillside, difficult access, custom features." },
  ];
  var TERRAIN = ["flat", "slope", "hillside"];
  var ACCESS = ["easy", "moderate", "difficult"];

  var state = {
    step: 1,
    estimateId: null,          // SharePoint item id when saved
    estimateRef: "",           // EST-xxxx
    version: 0,
    estStatus: "draft",
    project: { clientName: "", clientPhone: "", clientEmail: "", address: "", city: "",
      projectType: "", deckingArea: "", framingArea: "", railing: "", stairs: "",
      complexity: "", terrain: "", access: "", notes: "" },
    refs: null,                // loaded comps
    ranked: null,
    referenceId: null,         // projectRef of chosen comp
    catalog: null,             // materials
    sel: { primary: null, alternative: null },
    output: null,
    media: { photos: [], audioNotes: [] }, // photos = gallery entries (+.ann markup); audio = {audioId,txtId,name,when,transcript}
    _gal: null,                // mounted gallery handle (step 1 only)
    _rec: null,                // in-progress audio recording state
  };

  /* ══ matcher (ported: type 20 + decking 25 + framing 20 + railing 10 + stairs 10 + complexity 15) ══ */
  function simScore(cur, ref, max) {
    var c = Number(cur) || 0, r = Number(ref) || 0;
    if (c === 0 && r === 0) return max;
    return Math.max(0, max * (1 - Math.abs(c - r) / Math.max(c, r, 1)));
  }
  function matchScore(p, ref) {
    var s = (p.projectType === ref.projectType ? 20 : 0) +
      simScore(p.deckingArea, ref.primaryAreaSF, 25) +
      simScore(p.framingArea, ref.secondaryAreaSF, 20) +
      simScore(p.railing, ref.railingLF, 10) +
      simScore(p.stairs, ref.stairs, 10) +
      (p.complexity === ref.complexity ? 15 : 5);
    return Math.round(Math.min(100, s));
  }
  function rankRefs(p, refs) {
    return refs
      .filter(function (r) { return r.activeAsReference !== false; })
      .map(function (r) { var c = Object.assign({}, r); c.match = matchScore(p, r); return c; })
      .sort(function (a, b) { return b.match - a.match; });
  }

  /* ══ estimate engine (ported: benchmark + comparable range + source rows) ══ */
  var MIN_MATCH = 60, MAX_COMPS = 3;

  function eligibility(r, projectType) {
    var reasons = [];
    if (String(r.refStatus || "") !== "completed") reasons.push("not a completed project");
    if (r.activeAsReference === false) reasons.push("not active as a reference");
    if (r.projectType !== projectType) reasons.push("project type " + (r.projectType || "unknown") + " does not match " + projectType);
    if (!isFinite(Number(r.costPerPrimaryUnit)) || Number(r.costPerPrimaryUnit) <= 0) reasons.push("no usable historical cost per SF");
    if (!isFinite(Number(r.match)) || Number(r.match) < MIN_MATCH) reasons.push("similarity " + r.match + "% is below " + MIN_MATCH + "%");
    return { eligible: reasons.length === 0, reasons: reasons };
  }

  function buildBenchmark(area, projectType, ranked, refId) {
    if (!refId) return { present: false, note: "No historical reference was selected. Selecting one adds a benchmark for this scope." };
    var sel = (ranked || []).find(function (r) { return r.projectRef === refId; });
    if (!sel) return { present: false, note: "The selected reference could not be resolved from the comps library." };
    var cps = Number(sel.costPerPrimaryUnit);
    var elig = eligibility(sel, projectType);
    return {
      present: true, projectRef: sel.projectRef, projectName: sel.projectName,
      projectType: sel.projectType, refAreaSF: sel.primaryAreaSF, currentAreaSF: area,
      match: isFinite(Number(sel.match)) ? Number(sel.match) : null,
      costPerSF: isFinite(cps) ? cps : null,
      total: isFinite(cps) && area > 0 ? Math.round(area * cps) : null,
      isSample: sel.isSample === true,
      eligibleForRange: elig.eligible, exclusionReasons: elig.reasons,
    };
  }

  function buildRange(area, projectType, ranked) {
    var eligible = (ranked || []).filter(function (r) { return eligibility(r, projectType).eligible; }).slice(0, MAX_COMPS);
    var members = eligible.map(function (r) {
      return { projectRef: r.projectRef, projectName: r.projectName, projectType: r.projectType,
        refAreaSF: r.primaryAreaSF, match: Number(r.match), costPerSF: Number(r.costPerPrimaryUnit),
        isSample: r.isSample === true };
    });
    if (!members.length) {
      return { st: "none", areaSF: area, members: [],
        note: "No comparable range is available: no completed projects of the same type score at least " + MIN_MATCH + "% similarity." };
    }
    var costs = members.map(function (m) { return m.costPerSF; });
    var lo = Math.min.apply(null, costs), hi = Math.max.apply(null, costs);
    if (members.length === 1) {
      return { st: "single", areaSF: area, members: members, loCps: lo, hiCps: lo,
        loTotal: Math.round(area * lo), hiTotal: Math.round(area * lo),
        note: "Based on one eligible comparable project." };
    }
    return { st: "range", areaSF: area, members: members, loCps: lo, hiCps: hi,
      loTotal: Math.round(area * lo), hiTotal: Math.round(area * hi),
      loRef: members.find(function (m) { return m.costPerSF === lo; }).projectRef,
      hiRef: members.find(function (m) { return m.costPerSF === hi; }).projectRef,
      note: "Range across " + members.length + " eligible comparable projects of the same type." };
  }

  function buildRows(benchmark, range) {
    var rows = range.members.map(function (m) {
      return Object.assign({}, m, {
        total: Math.round(range.areaSF * m.costPerSF),
        isAnchor: benchmark.present && m.projectRef === benchmark.projectRef,
        inRange: true,
      });
    });
    if (benchmark.present && !rows.some(function (r) { return r.isAnchor; })) {
      rows.unshift({ projectRef: benchmark.projectRef, projectName: benchmark.projectName,
        projectType: benchmark.projectType, refAreaSF: benchmark.refAreaSF, match: benchmark.match,
        costPerSF: benchmark.costPerSF, total: benchmark.total, isAnchor: true, inRange: false,
        isSample: benchmark.isSample });
    }
    return rows;
  }

  function buildAssumptions(p, snapshot, benchmark, range, anySample) {
    var a = [];
    a.push("Quantities are approximate and provided by the sales conversation; they are not field measurements.");
    if (p.projectType === "new-deck") a.push("New deck: framing area assumed equal to decking area unless entered otherwise.");
    if (p.projectType === "resurface") a.push("Resurface: existing framing is retained and assumed structurally sound (0 SF new framing).");
    if (snapshot) {
      a.push("Material selection is recorded for scope only (" + snapshot.primary.officialName +
        (snapshot.primary.colorName ? " — " + snapshot.primary.colorName : "") + ").");
      a.push("Material pricing is pending approved price records; no draft or research price was used in any calculation.");
    } else {
      a.push("No material selection was confirmed for this estimate version.");
    }
    if (benchmark && benchmark.present) {
      a.push("The Selected Reference Benchmark applies " + benchmark.projectName +
        "'s historical cost per decking SF to the current decking area. It is historical context, not a price for this project.");
      if (!benchmark.eligibleForRange) {
        a.push(benchmark.projectName + " is excluded from the Comparable Project Range: " + benchmark.exclusionReasons.join("; ") + ".");
      }
    } else {
      a.push("No historical reference was selected, so no Selected Reference Benchmark is shown.");
    }
    if (range) {
      if (range.st === "none") a.push(range.note);
      if (range.st === "single") a.push("The comparable value is based on one eligible comparable project, so no range is shown.");
      if (range.st === "range") a.push("The Comparable Project Range reflects completed DCR projects of the same type, not a price for this project.");
    }
    if (anySample) a.push("One or more participating reference projects are SAMPLE data seeded with the app — replace them with real completed projects for production use.");
    a.push("This preliminary estimate requires review by a DCR estimator before it is shared with the client.");
    return a;
  }

  function buildOutput() {
    var p = state.project;
    var area = Number(p.deckingArea) || 0;
    var benchmark = buildBenchmark(area, p.projectType, state.ranked, state.referenceId);
    var range = buildRange(area, p.projectType, state.ranked);
    if (benchmark.present) {
      benchmark.inRange = range.members.some(function (m) { return m.projectRef === benchmark.projectRef; });
    }
    var rows = buildRows(benchmark, range);
    var anySample = rows.some(function (r) { return r.isSample; });
    var snapshot = buildSnapshot();
    return {
      generatedAt: new Date().toISOString(),
      scope: Object.assign({}, p),
      selectionSnapshot: snapshot,
      benchmark: benchmark,
      range: range,
      sourceRows: rows,
      anySample: anySample,
      materialCost: { amount: null, status: "pending_admin_pricing",
        note: "Material pricing is deferred until approved price records exist — it is not estimated from research data." },
      assumptions: buildAssumptions(p, snapshot, benchmark, range, anySample),
    };
  }

  /* ══ materials ══ */
  function products() { return (state.catalog && state.catalog.products) || []; }
  function findProduct(id) { return products().find(function (x) { return x.materialId === id; }) || null; }

  function buildSnapshot() {
    var sel = state.sel;
    if (!sel.primary) return null;
    var p = findProduct(sel.primary.materialId);
    if (!p) return null;
    var color = (p.colors || []).find(function (c) { return c.colorId === sel.primary.colorId; }) || (p.colors || [])[0] || null;
    var profile = (p.profiles || []).find(function (x) { return x.profileId === sel.primary.profileId; }) || (p.profiles || [])[0] || null;
    var alt = null;
    if (sel.alternative) {
      var ap = findProduct(sel.alternative.materialId);
      if (ap) {
        var ac = (ap.colors || []).find(function (c) { return c.colorId === sel.alternative.colorId; }) || (ap.colors || [])[0] || null;
        alt = { materialId: ap.materialId, brandName: ap.brandName, officialName: ap.officialName,
          marketTier: ap.marketTier, colorName: ac ? ac.name : "" };
      }
    }
    return {
      primary: { materialId: p.materialId, brandName: p.brandName, officialName: p.officialName,
        marketTier: p.marketTier, colorId: color ? color.colorId : null, colorName: color ? color.name : "",
        profileId: profile ? profile.profileId : null,
        profileType: profile ? profile.profileType : "", nominalDimensions: profile ? profile.nominalDimensions : "" },
      alternative: alt,
      pricingStatus: "pending_admin_pricing",
    };
  }

  /* ══ helpers ══ */
  function money(n) {
    if (!isFinite(Number(n))) return "—";
    return "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  function matchClass(m) { return m >= 75 ? "hi" : m >= 50 ? "md" : "lo"; }
  function syncPhotos() {
    if (state._gal) state.media.photos = state._gal.get();
  }
  function saveDraftLocal() {
    syncPhotos();
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        estimateId: state.estimateId, estimateRef: state.estimateRef, version: state.version,
        estStatus: state.estStatus, project: state.project, referenceId: state.referenceId, sel: state.sel,
        media: state.media,
      }));
    } catch (e) {}
  }
  function clearDraftLocal() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

  async function loadRefs() {
    if (state.refs) return state.refs;
    var d = await DCR.api("/api/portal?action=sales&part=refs&trade=deck");
    state.refs = d.refs || [];
    return state.refs;
  }
  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    // SharePoint Materials Library first (live-managed, with photos); the
    // shipped deck-materials.json is the resilience fallback.
    try {
      var d = await DCR.api("/api/portal?action=sales&part=materials&trade=deck");
      var rows = d.materials || [];
      var prodRows = rows.filter(function (r2) { return r2.itemKind === "product" && r2.itemStatus !== "retired"; });
      if (prodRows.length) {
        state.catalog = {
          source: "sharepoint",
          products: prodRows.map(function (pr) {
            var det = {};
            try { det = JSON.parse(pr.detailsJson || "{}"); } catch (e) {}
            var colors = rows
              .filter(function (c) { return c.itemKind === "color" && c.materialId === pr.materialId && c.itemStatus !== "retired"; })
              .map(function (c) {
                return { colorId: c.itemId, name: c.itemName, status: c.itemStatus,
                  manufacturerUrl: c.manufacturerUrl, pictureUrl: c.pictureUrl, pictureItemId: c.pictureItemId,
                  picturesJson: c.picturesJson };
              });
            var profiles = det.profiles || [];
            if (!profiles.length && pr.profilesJson) {
              try { profiles = JSON.parse(pr.profilesJson) || []; } catch (e) { profiles = []; }
            }
            return {
              materialId: pr.materialId, brandName: pr.brandName, officialName: pr.itemName,
              status: pr.itemStatus, marketTier: pr.marketTier, priceTier: pr.priceTier,
              shortDescription: pr.description, warrantySummary: pr.warrantySummary,
              selectable: pr.selectable !== false && pr.itemStatus === "active",
              pictureUrl: pr.pictureUrl, pictureItemId: pr.pictureItemId,
              // the detail view needs the whole sales story, not just a thumbnail
              picturesJson: pr.picturesJson, manufacturerUrl: pr.manufacturerUrl,
              salesHighlights: pr.salesHighlights, bestFor: pr.bestFor,
              colors: colors,
              profiles: profiles,
            };
          }),
        };
        return state.catalog;
      }
    } catch (e) { /* fall through to the static file */ }
    var r = await fetch("deck-materials.json");
    var raw = await r.json();
    (raw.products || []).forEach(function (p) { p.selectable = p.status === "active"; });
    state.catalog = raw;
    return state.catalog;
  }

  // Post-render picture hydration: uploaded photos need an authenticated blob
  // fetch; pasted URLs load directly. Images stay hidden until they load.
  function hydratePics(scope) {
    scope.querySelectorAll("img[data-pic-item], img[data-pic-url]").forEach(function (img) {
      img.onload = function () {
        img.style.display = "";
        var ph = img.parentElement && img.parentElement.querySelector(".picph");
        if (ph) ph.style.display = "none";
      };
      var itemId = img.getAttribute("data-pic-item"), url = img.getAttribute("data-pic-url");
      if (itemId) {
        DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(itemId))
          .then(function (u) { img.src = u; })
          .catch(function () { if (url) img.src = url; });
      } else if (url) img.src = url;
    });
  }
  /* ══ product detail viewer ══
     ONE color at a time. Mixing every color's photos into one strip put 20
     photos of 10 different colors in front of the client on a line like
     Enhance — the color they are looking at is the only one that sells. */
  function galOf(o) { return (window.DCRGallery && DCRGallery.parse(o || {})) || []; }
  function colorOf(pr, colorId) {
    return (pr.colors || []).filter(function (c) { return c.colorId === colorId; })[0] || null;
  }
  // The library names its pair "<Color>.jpg" and "<Color> sample.jpg" — the
  // board render and a close-up of the real material. Worth saying out loud.
  function shotLabel(entry, fallback) {
    var n = String((entry && entry.name) || "").replace(/^\d+-/, "").replace(/\.[a-z0-9]+$/i, "");
    if (/\bsample\b/i.test(n)) return "Sample";
    if (/\bboard\b/i.test(n)) return "Board";
    return fallback || "";
  }
  // Photos of THIS color; a line's own shots only when the color has none.
  // Never hard-code "two" — the library is live and a third can appear.
  function matPhotos(pr, colorId) {
    var col = colorOf(pr, colorId);
    var own = col ? galOf(col) : [];
    if (own.length) {
      return own.map(function (e, i) {
        return { e: e, cap: col.name, shot: shotLabel(e, own.length > 1 ? (i === 0 ? "Board" : "Sample") : "") };
      });
    }
    return galOf(pr).map(function (e) { return { e: e, cap: pr.officialName, shot: shotLabel(e, "") }; });
  }
  // every photo the line can show — for the row's cover and its "N photos"
  function linePhotoCount(pr) {
    var n = galOf(pr).length;
    (pr.colors || []).forEach(function (c) { n += galOf(c).length; });
    return n;
  }
  function coverPhoto(pr, colorId) {
    var own = matPhotos(pr, colorId);
    if (own.length) return own[0];
    for (var i = 0; i < (pr.colors || []).length; i++) {
      var g = galOf(pr.colors[i]);
      if (g.length) return { e: g[0], cap: pr.colors[i].name, shot: "" };
    }
    return null;
  }
  // esc() stops HTML injection but NOT a scheme: a "javascript:…" value typed
  // into the library's ManufacturerUrl column would run on click. Links are
  // https-only, and we show the host so the client sees whose site it is.
  function safeUrl(u) { return /^https:\/\//i.test(String(u || "").trim()) ? String(u).trim() : ""; }
  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "manufacturer"; }
  }
  function lineName(pr) {
    var short = String(pr.officialName || "").replace(pr.brandName || "", "").trim();
    return short || pr.officialName || "";
  }
  function picAttrs(o) {
    if (o && o.pictureItemId) return ' data-pic-item="' + esc(o.pictureItemId) + '"' + (o.pictureUrl ? ' data-pic-url="' + esc(o.pictureUrl) + '"' : "");
    if (o && o.pictureUrl) return ' data-pic-url="' + esc(o.pictureUrl) + '"';
    return "";
  }

  /* The viewer keeps its OWN color while browsing: opening a line the client
     hasn't chosen shouldn't quietly change the selection. "Use this line"
     commits whatever color is on screen. */
  var mv = { materialId: null, colorId: null, idx: 0, photos: [], onKey: null };
  function openMatModal(materialId) {
    var pr = findProduct(materialId);
    if (!pr) return;
    var isPrimary = state.sel.primary && state.sel.primary.materialId === materialId;
    mv.materialId = materialId;
    mv.colorId = (isPrimary && state.sel.primary.colorId) ||
      ((pr.colors || [])[0] || {}).colorId || null;
    mv.idx = 0;
    el("matModal").hidden = false;
    document.body.style.overflow = "hidden";
    el("mvClose").onclick = closeMatModal;
    el("matModal").onclick = function (e) { if (e.target === el("matModal")) closeMatModal(); };
    mv.present = false;
    mv.onKey = function (e) {
      if (e.key === "Escape") {
        e.preventDefault();
        // in photo view the first Escape steps back out, so a rep with the
        // laptop turned to the client never loses the whole view mid-sentence
        if (mv.present) { mv.present = false; renderMatModal(); } else closeMatModal();
      } else if (e.key === "ArrowRight") { e.preventDefault(); stepColor(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); stepColor(-1); }
    };
    document.addEventListener("keydown", mv.onKey);
    renderMatModal();
  }
  function closeMatModal() {
    el("matModal").hidden = true;
    document.body.style.overflow = "";
    if (mv.onKey) document.removeEventListener("keydown", mv.onKey);
    mv.onKey = null;
    mv.materialId = null;
  }
  // arrows walk the COLORS now — with one color's shots all on screen there is
  // nothing left to page through inside a color
  function stepColor(d) {
    var pr = findProduct(mv.materialId);
    var cols = (pr && pr.colors) || [];
    if (cols.length < 2) return;
    var at = -1;
    cols.forEach(function (c, i) { if (c.colorId === mv.colorId) at = i; });
    var next = cols[((at < 0 ? 0 : at) + d + cols.length) % cols.length];
    pickColor(next.colorId);
  }
  // one place decides what a color choice means: it always changes what you
  // are LOOKING at, and only changes the estimate when this line is the pick
  function pickColor(colorId) {
    var pr = findProduct(mv.materialId);
    mv.colorId = colorId;
    mv.idx = 0;
    if (pr && state.sel.primary && state.sel.primary.materialId === pr.materialId) {
      state.sel.primary.colorId = colorId;
      renderStep3();
    }
    renderMatModal();
  }
  function renderMatModal() {
    var pr = findProduct(mv.materialId);
    if (!pr) { closeMatModal(); return; }
    mv.photos = matPhotos(pr, mv.colorId);
    if (mv.idx >= mv.photos.length) mv.idx = 0;
    var isPrimary = state.sel.primary && state.sel.primary.materialId === pr.materialId;
    var isAlt = state.sel.alternative && state.sel.alternative.materialId === pr.materialId;
    var selectable = pr.selectable !== undefined ? pr.selectable !== false : pr.status === "active";
    var colName = (colorOf(pr, mv.colorId) || {}).name || "";

    // every shot of THIS color at once, side by side — with two photos there is
    // nothing to page through, and the client sees the finish and the real
    // material together. White and uncropped: these are boards on white, and
    // the old fill-and-crop was cutting the ends off them.
    var stage = mv.photos.length
      ? '<div class="mv-shots n' + Math.min(mv.photos.length, 3) + '">' + mv.photos.map(function (p, i) {
          return '<figure class="mv-shot"><span class="mv-frame"><img data-shot="' + i + '" alt="' +
            esc(p.cap + (p.shot ? " — " + p.shot : "")) + '"></span>' +
            (p.shot ? "<figcaption>" + esc(p.shot) + "</figcaption>" : "") + "</figure>";
        }).join("") + "</div>" +
        (colName ? '<div class="mv-colname">' + esc(colName) + "</div>" : "")
      // client-neutral first line; the how-to-fix link stays small and second
      : '<div class="mv-empty"><span class="ic">🖼️</span>No photo for ' +
        (colName ? esc(colName) : "this line") + " yet." +
        '<div style="margin-top:8px;font-size:11.5px;opacity:.75">' +
        '<a href="materials-library.html" target="_blank" rel="noopener">Add one →</a></div></div>';

    var lines = function (s) {
      return String(s || "").split("\n").map(function (x) { return x.trim(); }).filter(Boolean);
    };
    var highlights = lines(pr.salesHighlights), best = lines(pr.bestFor);

    var colors = '<div class="mv-colors">' + (pr.colors || []).map(function (c, ci) {
      var n = galOf(c).length;
      return '<div class="mv-col' + (c.colorId === mv.colorId ? " on" : "") + '" data-mvcolor="' + esc(c.colorId) + '">' +
        '<div class="sw"><img alt="" data-mvsw="' + ci + '"></div>' +
        '<div class="nm">' + esc(c.name) + "</div>" +
        (n ? '<div class="n">' + n + " photo" + (n === 1 ? "" : "s") + "</div>" : "") + "</div>";
    }).join("") + "</div>";

    var profs = (pr.profiles || []).length
      ? '<div class="ed-chips">' + pr.profiles.map(function (f) {
          var on = isPrimary && state.sel.primary.profileId === f.profileId;
          return '<span class="ed-chip' + (on ? " on" : "") + '" data-mvprofile="' + esc(f.profileId) + '">' +
            esc((f.profileType || "").replace(/_/g, " ") + " · " + (f.nominalDimensions || "")) + "</span>";
        }).join("") + "</div>"
      : "";

    var manUrl = safeUrl(pr.manufacturerUrl) ||
      safeUrl(((pr.colors || []).filter(function (c) { return c.colorId === mv.colorId; })[0] || {}).manufacturerUrl);

    document.querySelector(".mv").classList.toggle("present", !!mv.present);
    el("mvBody").innerHTML =
      '<div class="mv-grid">' +
        '<div class="mv-pics">' + stage + "</div>" +
        '<div class="mv-info">' +
          '<div class="mv-eyebrow">' + esc(pr.brandName || "") + "</div>" +
          '<h2 class="mv-title" id="mvTitle">' + esc(lineName(pr)) + "</h2>" +
          '<div class="mv-pills">' +
            (pr.marketTier ? '<span class="ed-tier">' + esc(pr.marketTier) + "</span>" : "") +
            (pr.warrantySummary ? '<span class="ed-badge hi">' + esc(pr.warrantySummary) + "</span>" : "") +
            (selectable ? "" : '<span class="ed-badge sample">quote on request</span>') +
          "</div>" +
          (pr.shortDescription ? '<div class="mv-desc">' + esc(pr.shortDescription) + "</div>" : "") +
          (highlights.length
            ? '<div class="mv-h">Why clients pick it</div><ul class="mv-list">' +
              highlights.map(function (h) { return "<li>" + esc(h) + "</li>"; }).join("") + "</ul>"
            : "") +
          (best.length
            ? '<div class="mv-h">Best for</div><div class="ed-chips">' +
              best.map(function (b) { return '<span class="ed-chip" style="cursor:default">' + esc(b) + "</span>"; }).join("") + "</div>"
            : "") +
          '<div class="mv-h mv-h-color">Color' + ((pr.colors || []).length ? " · " + pr.colors.length : "") + "</div>" + colors +
          (profs ? '<div class="mv-h">Profile</div>' + profs : "") +
        "</div>" +
      "</div>" +
      '<div class="mv-foot">' +
        // the client can read everything on this screen — no notes-to-self
        (manUrl
          ? '<a class="btn btn-ghost btn-sm" href="' + esc(manUrl) + '" target="_blank" rel="noopener noreferrer">🔗 ' +
            esc(hostOf(manUrl)) + " — official page ↗</a>"
          : "<span></span>") +
        '<div class="right">' +
          (mv.photos.length ? '<button class="btn btn-ghost btn-sm" id="mvPresent">' +
            (mv.present ? "✕ Exit photo view" : "⛶ Photo view") + "</button>" : "") +
          (selectable
            ? '<button class="btn btn-ghost btn-sm" id="mvAlt">' + (isAlt ? "✓ Alternative" : "+ Set as alternative") + "</button>" +
              '<button class="btn btn-sm" id="mvUse"' + (isPrimary ? " disabled" : "") + ">" +
                (isPrimary ? "✓ Selected" : "Use this line →") + "</button>"
            : '<span class="ed-sub" style="margin:0;font-size:12px">We quote this line on request.</span>') +
        "</div>" +
      "</div>";

    // photos load through the authenticated blob path, so they arrive late.
    // NOTE: "block", not "" — the stylesheet hides these until they load, so
    // clearing the inline style would just re-apply display:none.
    function show(img, entry) {
      if (!img || !entry) return;
      img.onload = function () { img.style.display = "block"; };
      DCRGallery.srcInto(img, entry);
    }
    el("mvBody").querySelectorAll("img[data-shot]").forEach(function (img) {
      var p = mv.photos[+img.getAttribute("data-shot")];
      if (p) show(img, p.e);
    });
    // a color's swatch is its own first photo (that is where they live)
    el("mvBody").querySelectorAll("img[data-mvsw]").forEach(function (img) {
      var c = (pr.colors || [])[+img.getAttribute("data-mvsw")];
      if (!c) return;
      var entry = galOf(c)[0] ||
        (c.pictureItemId ? { id: c.pictureItemId } : c.pictureUrl ? { url: c.pictureUrl } : null);
      show(img, entry);
    });

    el("mvBody").querySelectorAll("[data-mvcolor]").forEach(function (c) {
      c.onclick = function () { pickColor(c.getAttribute("data-mvcolor")); };
    });
    el("mvBody").querySelectorAll("[data-mvprofile]").forEach(function (c) {
      c.onclick = function () {
        if (!(state.sel.primary && state.sel.primary.materialId === pr.materialId)) return;
        state.sel.primary.profileId = c.getAttribute("data-mvprofile");
        renderStep3();
        renderMatModal();
      };
    });
    var pres = el("mvPresent");
    if (pres) pres.onclick = function () { mv.present = !mv.present; renderMatModal(); };
    var useBtn = el("mvUse");
    if (useBtn) useBtn.onclick = function () {
      state.sel.primary = { materialId: pr.materialId, colorId: mv.colorId,
        profileId: (pr.profiles && pr.profiles[0]) ? pr.profiles[0].profileId : null };
      if (state.sel.alternative && state.sel.alternative.materialId === pr.materialId) state.sel.alternative = null;
      renderStep3();
      closeMatModal();
    };
    var altBtn = el("mvAlt");
    if (altBtn) altBtn.onclick = function () {
      if (state.sel.alternative && state.sel.alternative.materialId === pr.materialId) state.sel.alternative = null;
      else if (!(state.sel.primary && state.sel.primary.materialId === pr.materialId)) {
        state.sel.alternative = { materialId: pr.materialId, colorId: mv.colorId };
      }
      renderStep3();
      renderMatModal();
    };
  }

  /* ══ step navigation ══
     Steps unlock as their prerequisites are met: fill in step 1 and steps 2-3
     open immediately; pick a material and 4-5 open too. Going back is always
     allowed. Locked tabs explain what's missing instead of doing nothing. */

  // Read the step-1 form into state (no-op when step 1 isn't on screen).
  function commitStep1() {
    if (!el("f_client")) return;
    var p = state.project;
    p.clientName = el("f_client").value.trim();
    p.clientPhone = el("f_phone").value.trim();
    p.clientEmail = el("f_email").value.trim();
    p.address = el("f_addr").value.trim();
    p.city = el("f_city").value.trim();
    p.deckingArea = Number(el("f_deck").value);
    p.framingArea = Number(el("f_frame").value);
    p.railing = Number(el("f_rail").value) || 0;
    p.stairs = Number(el("f_stairs").value) || 0;
    p.terrain = el("f_terrain").value;
    p.access = el("f_access").value;
    p.notes = el("f_notes").value;
  }

  // null when step 1 has everything the estimate needs, else what's missing.
  function step1Problem() {
    var p = state.project;
    if (!p.clientName) return "Please enter the client name.";
    if (!p.address) return "Please enter the project address.";
    if (!p.projectType) return "Please select the project type.";
    if (!(Number(p.deckingArea) > 0)) return "Please enter a valid decking surface area.";
    if (!isFinite(Number(p.framingArea)) || Number(p.framingArea) < 0) return "Please enter a valid framing area.";
    if (!p.complexity) return "Please select the project complexity.";
    return null;
  }
  function stepBlockReason(n) {
    if (n <= 1) return null;
    var p1 = step1Problem();
    if (p1) return p1;
    if (n >= 4 && !state.sel.primary) return "Pick a decking material on step 3 first.";
    return null;
  }

  function paintSteps() {
    document.querySelectorAll(".ed-step").forEach(function (s) {
      var n = Number(s.dataset.step);
      var reachable = n < state.step || !stepBlockReason(n); // back is always open
      s.classList.toggle("on", n === state.step);
      s.classList.toggle("done", n < state.step);
      s.classList.toggle("open", reachable && n !== state.step);
      s.classList.toggle("locked", !reachable);
      s.title = reachable ? "" : stepBlockReason(n) || "";
      s.onclick = n === state.step ? null : function () { tryGo(n); };
    });
  }

  // Tab navigation: save what's typed first, then either move or say why not.
  function tryGo(n) {
    if (state.step === 1) commitStep1();
    var why = n > state.step ? stepBlockReason(n) : null;
    if (why) {
      if (el("s1msg")) el("s1msg").textContent = why;
      paintSteps();
      return;
    }
    if (state.step === 1 && n > 1) state.ranked = null; // scope may have changed — re-rank
    go(n);
  }

  async function go(step) {
    state.step = step;
    paintSteps();
    saveDraftLocal(); // also syncs photos from the gallery widget
    if (state._gal && step !== 1) { state._gal.destroy(); state._gal = null; }
    window.scrollTo(0, 0);
    if (step === 1) renderStep1();
    if (step === 2) await renderStep2();
    if (step === 3) await renderStep3();
    if (step === 4) await renderStep4();
    if (step === 5) await renderStep5();
  }

  /* ══ project media: photos (annotatable) + voice notes w/ transcripts ══
     EVERYTHING AUTO-SAVES. Notes upload the moment recording stops; any media
     change (photo, markup, note) also writes the estimate row to SharePoint
     (created as a draft on first change) so nothing lives only in this browser.
     Deleting unused notes beats losing important ones. */
  function mediaPathParts() {
    var who = state.project.clientName ? " - " + state.project.clientName : "";
    return ["Estimates", ((state.estimateRef || "Draft") + who).slice(0, 80)];
  }

  function autoMsg(t, isErr) {
    var n = el("autoSaveMsg");
    if (!n) return;
    n.style.color = isErr ? "var(--err)" : "var(--ok)";
    n.textContent = t || "";
  }

  // Debounced auto-save of the estimate row (media + current scope). Creates the
  // SharePoint row as a draft on the first change, updates it afterwards.
  var autoTimer = null;
  function autoSaveMedia() {
    saveDraftLocal();
    clearTimeout(autoTimer);
    autoMsg("saving…");
    autoTimer = setTimeout(async function () {
      try {
        if (!state.estimateRef) state.estimateRef = "EST-" + Date.now();
        syncPhotos();
        var p = state.project;
        var fields = {
          estimateRef: state.estimateRef, trade: "deck",
          estStatus: state.estStatus || "draft", version: state.version || 0,
          clientName: p.clientName || "", clientPhone: p.clientPhone || "", clientEmail: p.clientEmail || "",
          siteAddress: p.address || "", city: p.city || "",
          projectType: p.projectType || "", complexity: p.complexity || "",
          primaryAreaSF: p.deckingArea || "", secondaryAreaSF: p.framingArea || "",
          railingLF: p.railing || "", stairs: p.stairs || "",
          scopeJson: JSON.stringify(p), notes: p.notes || "",
          mediaJson: JSON.stringify(state.media),
        };
        var res = await DCR.api("/api/portal?action=sales&part=estimates", {
          method: state.estimateId ? "PATCH" : "POST",
          body: state.estimateId ? { id: state.estimateId, fields: fields } : { fields: fields },
        });
        state.estimateId = res.estimate.id;
        saveDraftLocal();
        autoMsg("✓ auto-saved " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
      } catch (e) {
        autoMsg("⚠ auto-save failed — will retry on the next change", true);
      }
    }, 1500);
  }

  function mountMedia() {
    if (state._gal) state._gal.destroy();
    state._gal = DCRGallery.mount(el("edGallery"), {
      initial: state.media.photos,
      getPathParts: mediaPathParts,
      onChange: function () { autoSaveMedia(); },
      tileAction: {
        title: "Open & edit — markup on photos, full editor on drawings",
        icon: "✏️",
        badge: function (p) {
          if (p.cad) return "📐 edit";
          return p.ann && p.ann.items && p.ann.items.length ? "✏️ " + p.ann.items.length : "✏️";
        },
        onClick: function (entry, idx, rerender) {
          if (entry.cad) {
            // a CAD field sketch — reopen the drafting editor
            DCRCad.open({
              entry: entry,
              title: (state.project.clientName || "Site") + " — drawing",
              getPathParts: mediaPathParts,
              onSave: function (patch) {
                Object.assign(entry, patch);
                rerender();
                autoSaveMedia();
              },
            });
            return;
          }
          DCRAnnotate.open({
            entry: entry,
            title: state.project.clientName ? state.project.clientName + " — photo " + (idx + 1) : "Photo " + (idx + 1),
            onSave: function (ann) {
              entry.ann = ann;
              rerender();
              autoSaveMedia();
            },
          });
        },
      },
    });
    el("edNewDrawing").onclick = function () {
      DCRCad.open({
        entry: null,
        title: (state.project.clientName || "Site") + " — new drawing",
        getPathParts: mediaPathParts,
        onSave: function (patch) {
          state._gal.add(patch); // fires onChange → auto-save
        },
      });
    };
    renderAudioList();
    el("recStart").onclick = startRec;
    el("recStop").onclick = stopRec;
    el("recCancel").onclick = cancelRec;
  }

  function renderAudioList() {
    var list = state.media.audioNotes || [];
    el("edNotesList").innerHTML = !list.length ? "" :
      list.map(function (n, i) {
        var status = n.pending ? '<span style="color:var(--gold)">⏳ uploading…</span>'
          : n.failed && n._blob ? '<button type="button" class="btn btn-ghost btn-sm retryNote" data-i="' + i + '" style="padding:2px 8px">⚠ retry upload</button>'
          : n.failed ? '<span style="color:var(--gold)">⚠ audio not saved — transcript kept</span>'
          : "🎤 " + esc(new Date(n.when).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) +
            (n.txtId ? " · 📄 transcript saved" : "");
        return '<div style="display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:8px 10px;margin-top:6px">' +
          '<button type="button" class="btn btn-ghost btn-sm playNote" data-i="' + i + '"' + (n.audioId ? "" : " disabled") + ">▶</button>" +
          '<div style="flex:1;min-width:0"><div style="font-size:11px;color:var(--text-muted)">' + status + "</div>" +
          '<textarea class="noteTxt" data-i="' + i + '" rows="2" style="margin-top:4px;font-size:12.5px" placeholder="(no transcript — type notes here)">' + esc(n.transcript || "") + "</textarea></div>" +
          '<button type="button" class="btn btn-ghost btn-sm delNote" data-i="' + i + '">🗑</button></div>';
      }).join("");
    el("edNotesList").querySelectorAll(".playNote").forEach(function (b) {
      b.onclick = function () { playNote(list[Number(b.dataset.i)], b); };
    });
    el("edNotesList").querySelectorAll(".delNote").forEach(function (b) {
      b.onclick = function () {
        var n = list[Number(b.dataset.i)] || {};
        var preview = (n.transcript || "").trim().replace(/\s+/g, " ").slice(0, 70);
        if (!confirm("Delete this voice note?\n\nThe recording" +
          (n.transcript ? ' and its transcript ("' + preview + (preview.length >= 70 ? "…" : "") + '")' : "") +
          " will be removed from this estimate. This cannot be undone.")) return;
        list.splice(Number(b.dataset.i), 1);
        renderAudioList();
        autoSaveMedia();
      };
    });
    el("edNotesList").querySelectorAll(".retryNote").forEach(function (b) {
      b.onclick = function () { uploadNote(list[Number(b.dataset.i)]); };
    });
    // transcript edits save on blur: update the note, refresh its .txt, auto-save
    el("edNotesList").querySelectorAll(".noteTxt").forEach(function (t) {
      t.onblur = async function () {
        var n = list[Number(t.dataset.i)];
        if (!n || n.transcript === t.value) return;
        n.transcript = t.value;
        autoSaveMedia();
        if (n.audioId && n.transcript.trim()) {
          try {
            var up = await DCR.api("/api/portal?action=sales&part=media", {
              method: "POST",
              body: { name: (n.name || "voice-note").replace(/\.[^.]+$/, "") + ".txt",
                dataBase64: "data:text/plain;base64," + btoa(unescape(encodeURIComponent(n.transcript))),
                pathParts: mediaPathParts() },
            });
            n.txtId = up.file.id;
            autoSaveMedia();
          } catch (e) { /* transcript stays in the estimate row either way */ }
        }
      };
    });
  }

  var audioEl = null;
  function playNote(note, btn) {
    if (audioEl) { audioEl.pause(); audioEl = null; document.querySelectorAll(".playNote").forEach(function (x) { x.textContent = "▶"; }); }
    if (btn.textContent === "⏸") { btn.textContent = "▶"; return; }
    DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(note.audioId))
      .then(function (u) {
        audioEl = new Audio(u);
        btn.textContent = "⏸";
        audioEl.onended = function () { btn.textContent = "▶"; };
        audioEl.play();
      })
      .catch(function () { alert("Could not load the audio."); });
  }

  function setRecPhase(phase) {
    el("edRecIdle").style.display = phase === "idle" ? "" : "none";
    el("edRecLive").style.display = phase === "rec" ? "" : "none";
  }

  // Recorder — SpeechRecognition first, MediaRecorder after a head start (the
  // proven Android ordering from the project voice notes), interim tail kept.
  async function startRec() {
    var rec = state._rec = { chunks: [], finals: "", interim: "", sr: null, mr: null, t0: Date.now(), timer: null };
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      var sr = rec.sr = new SR();
      sr.continuous = true; sr.interimResults = true; sr.lang = "en-US";
      sr.onresult = function (ev) {
        var interim = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) rec.finals += ev.results[i][0].transcript + " ";
          else interim += ev.results[i][0].transcript;
        }
        rec.interim = interim;
        el("recLiveTxt").textContent = (rec.finals + interim).slice(-220) || "Listening…";
      };
      sr.onerror = function () {};
      try { sr.start(); } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 350); });
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var mime = window.MediaRecorder && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      rec.mime = mime;
      var mr = rec.mr = new MediaRecorder(stream, { mimeType: mime });
      mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
      mr.start(1000);
      setRecPhase("rec");
      el("recLiveTxt").textContent = rec.sr ? "Listening…" : "Recording (transcript not supported on this device — audio still saves).";
      rec.timer = setInterval(function () {
        var s = Math.floor((Date.now() - rec.t0) / 1000);
        el("recTime").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        if (s >= 180) stopRec(); // 3-minute cap keeps files under the upload limit
      }, 500);
    } catch (e) {
      if (rec.sr) { try { rec.sr.stop(); } catch (e2) {} }
      state._rec = null;
      alert("Microphone unavailable: " + (e.message || e.name || "permission denied"));
    }
  }

  // Stop = the note is KEPT and uploads immediately (no save/discard gate —
  // notes are never lost; delete from the list if unwanted).
  function stopRec() {
    var rec = state._rec;
    if (!rec) return;
    clearInterval(rec.timer);
    if (rec.sr) { try { rec.sr.stop(); } catch (e) {} }
    if (rec.mr && rec.mr.state !== "inactive") {
      rec.mr.onstop = function () {
        rec.mr.stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(rec.chunks, { type: rec.mime });
        var note = {
          audioId: null, txtId: null,
          name: "voice-note-" + Date.now() + (rec.mime === "audio/mp4" ? ".m4a" : ".webm"),
          when: new Date().toISOString(),
          transcript: (rec.finals + rec.interim).trim(),
          pending: true,
        };
        // keep the blob in memory for retry, but out of JSON serialization
        Object.defineProperty(note, "_blob", { value: blob, enumerable: false, writable: true });
        state.media.audioNotes.push(note);
        state._rec = null;
        setRecPhase("idle");
        renderAudioList();
        uploadNote(note);
      };
      rec.mr.stop();
    } else {
      state._rec = null;
      setRecPhase("idle");
    }
  }

  function cancelRec() {
    var rec = state._rec;
    if (!rec) return;
    clearInterval(rec.timer);
    if (rec.sr) { try { rec.sr.stop(); } catch (e) {} }
    if (rec.mr && rec.mr.state !== "inactive") {
      rec.mr.onstop = function () { rec.mr.stream.getTracks().forEach(function (t) { t.stop(); }); };
      rec.mr.stop();
    }
    state._rec = null;
    setRecPhase("idle");
  }

  async function uploadNote(note) {
    if (!note._blob) { note.failed = true; renderAudioList(); return; }
    note.pending = true; note.failed = false;
    renderAudioList();
    try {
      var b64 = await new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(String(fr.result)); };
        fr.onerror = rej;
        fr.readAsDataURL(note._blob);
      });
      var up = await DCR.api("/api/portal?action=sales&part=media", {
        method: "POST",
        body: { name: note.name, dataBase64: b64, pathParts: mediaPathParts() },
      });
      note.audioId = up.file.id;
      if (note.transcript) {
        try {
          var txtUp = await DCR.api("/api/portal?action=sales&part=media", {
            method: "POST",
            body: { name: note.name.replace(/\.[^.]+$/, "") + ".txt",
              dataBase64: "data:text/plain;base64," + btoa(unescape(encodeURIComponent(note.transcript))),
              pathParts: mediaPathParts() },
          });
          note.txtId = txtUp.file.id;
        } catch (e) { /* transcript still lives in the estimate row */ }
      }
      note.pending = false;
      renderAudioList();
      autoSaveMedia();
    } catch (e) {
      note.pending = false;
      note.failed = true;
      renderAudioList();
      autoSaveMedia(); // transcript is preserved in the estimate even if audio upload failed
    }
  }

  /* ══ STEP 1 — project info ══ */
  function pickCards(list, selected, cls) {
    return '<div class="ed-pick">' + list.map(function (c) {
      return '<div class="ed-pick-card ' + cls + (selected === c.id ? " on" : "") + '" data-id="' + c.id + '">' +
        '<div class="t">' + esc(c.t) + '</div><div class="d">' + esc(c.d) + "</div></div>";
    }).join("") + "</div>";
  }

  function renderStep1() {
    var p = state.project;
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🏗️ Project information</h2>' +
      '<p class="ed-sub">Describe the deck project. Fields marked * are required.</p>' +
      '<div class="ed-grid">' +
      '<div><label class="req">Client name</label><input id="f_client" value="' + esc(p.clientName) + '"></div>' +
      '<div><label class="req">Project address</label><input id="f_addr" value="' + esc(p.address) + '"></div>' +
      '<div><label>Client phone</label><input id="f_phone" type="tel" value="' + esc(p.clientPhone) + '"></div>' +
      '<div><label>Client email</label><input id="f_email" type="email" value="' + esc(p.clientEmail) + '"></div>' +
      '<div><label>City</label><input id="f_city" value="' + esc(p.city) + '"></div>' +
      '<div></div>' +
      '<div class="full"><label class="req">Project type</label>' + pickCards(PROJECT_TYPES, p.projectType, "pt") + "</div>" +
      '<div><label class="req">Decking surface area (SF)</label><input id="f_deck" type="number" min="0" value="' + esc(p.deckingArea) + '"></div>' +
      '<div><label>New framing area (SF)</label><input id="f_frame" type="number" min="0" value="' + esc(p.framingArea) + '">' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:3px" id="frameHelp"></div></div>' +
      '<div><label>Railing (LF)</label><input id="f_rail" type="number" min="0" value="' + esc(p.railing) + '"></div>' +
      '<div><label>Stairs (count)</label><input id="f_stairs" type="number" min="0" value="' + esc(p.stairs) + '"></div>' +
      '<div class="full"><label class="req">Complexity</label>' + pickCards(COMPLEXITY, p.complexity, "cx") + "</div>" +
      '<div><label>Terrain</label><select id="f_terrain"><option value="">—</option>' +
        TERRAIN.map(function (t) { return "<option" + (p.terrain === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
      '<div><label>Site access</label><select id="f_access"><option value="">—</option>' +
        ACCESS.map(function (t) { return "<option" + (p.access === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
      '<div class="full"><label>Notes</label><textarea id="f_notes" rows="2">' + esc(p.notes) + "</textarea></div>" +
      '<div class="full"><label>Project photos & drawings <span style="color:var(--text-muted);font-weight:400">— tap ✏️ to mark up a photo or edit a drawing</span>' +
      '<span id="autoSaveMsg" style="float:right;font-size:11px;font-weight:600"></span></label>' +
      '<div style="margin:2px 0 8px"><button type="button" class="btn btn-ghost btn-sm" id="edNewDrawing">📐 New drawing — sketch the deck plan with real dimensions</button></div>' +
      '<div id="edGallery"></div></div>' +
      '<div class="full"><label>Voice notes <span style="color:var(--text-muted);font-weight:400">— saved automatically when you stop recording (audio + transcript); delete any you don\'t need</span></label>' +
      '<div id="edNotesList"></div>' +
      '<div id="edRecBox" style="border:1px dashed var(--border);border-radius:10px;padding:10px;margin-top:6px">' +
        '<div id="edRecIdle"><button type="button" class="btn btn-sm" id="recStart">🎤 Record a voice note</button> ' +
        '<span style="font-size:11px;color:var(--text-muted)">Speak your site notes — stopping saves the audio and transcript instantly.</span></div>' +
        '<div id="edRecLive" style="display:none"><span style="color:var(--err);font-weight:700;font-size:12px">● Recording</span> ' +
        '<span id="recTime" style="font-size:12px;font-weight:700"></span>' +
        '<div id="recLiveTxt" style="font-size:12px;color:var(--text-muted);margin:6px 0;min-height:16px"></div>' +
        '<button type="button" class="btn btn-sm" id="recStop">⏹ Stop & save</button> ' +
        '<button type="button" class="btn btn-ghost btn-sm" id="recCancel">✕ Cancel</button></div>' +
      "</div></div>" +
      "</div>" +
      '<div class="ed-msg" id="s1msg" style="color:var(--err)"></div>' +
      '<div class="ed-nav"><span></span><button class="btn" id="s1next">Find similar projects →</button></div>' +
      "</div>";

    function applyTypeRules(type) {
      var fr = el("f_frame"), help = el("frameHelp");
      if (type === "new-deck") { fr.disabled = false; fr.value = el("f_deck").value || ""; help.textContent = "New deck: framing area normally matches decking area."; }
      if (type === "resurface") { fr.value = 0; fr.disabled = true; help.textContent = "Resurface: existing framing is retained."; }
      if (type === "deck-expansion") { fr.disabled = false; help.textContent = "Enter only the area requiring new framing."; }
      if (type === "partial-rebuild") { fr.disabled = false; help.textContent = "Enter the approximate area requiring replacement framing."; }
    }
    if (p.projectType) applyTypeRules(p.projectType);

    document.querySelectorAll(".ed-pick-card.pt").forEach(function (c) {
      c.onclick = function () {
        document.querySelectorAll(".ed-pick-card.pt").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        state.project.projectType = c.dataset.id;
        applyTypeRules(c.dataset.id);
        commitStep1(); paintSteps();
      };
    });
    document.querySelectorAll(".ed-pick-card.cx").forEach(function (c) {
      c.onclick = function () {
        document.querySelectorAll(".ed-pick-card.cx").forEach(function (x) { x.classList.remove("on"); });
        c.classList.add("on");
        state.project.complexity = c.dataset.id;
        commitStep1(); paintSteps();
      };
    });
    el("f_deck").addEventListener("input", function () {
      if (state.project.projectType === "new-deck") el("f_frame").value = this.value;
    });
    // keep the step tabs in sync as the form is filled in
    ["f_client", "f_addr", "f_deck", "f_frame"].forEach(function (id) {
      el(id).addEventListener("input", function () { commitStep1(); paintSteps(); });
    });
    mountMedia();
    paintSteps();

    el("s1next").onclick = function () { tryGo(2); };
  }

  /* ══ STEP 2 — similar projects ══ */
  async function renderStep2() {
    el("edApp").innerHTML = '<div class="ed-card"><h2>🔎 Analyzing similar projects…</h2><p class="ed-sub">Comparing your scope with completed DCR projects.</p></div>';
    try {
      var refs = await loadRefs();
      state.ranked = rankRefs(state.project, refs);
    } catch (e) {
      el("edApp").innerHTML = '<div class="ed-card"><h2>Similar projects</h2><p class="ed-sub" style="color:var(--err)">' + esc(e.message || "Could not load the comps library.") + "</p>" +
        '<div class="ed-nav"><button class="btn btn-ghost" id="s2back">← Back</button><span></span></div></div>';
      el("s2back").onclick = function () { go(1); };
      return;
    }
    var cards = state.ranked.map(function (r) {
      var selCls = state.referenceId === r.projectRef ? " sel" : "";
      var gal = DCRGallery.parse(r);
      var picHtml = gal.length
        ? '<div class="ed-refpic" data-car="' + esc(r.projectRef) + '" data-idx="0">' +
          '<img style="display:none" alt="' + esc(r.projectName) + '">' +
          (gal.length > 1
            ? '<button type="button" class="nav prev" data-nav="-1" title="Previous photo">‹</button>' +
              '<button type="button" class="nav next" data-nav="1" title="Next photo">›</button>' +
              '<span class="ct">1 / ' + gal.length + "</span>"
            : "") +
          "</div>"
        : "";
      return '<div class="ed-match' + selCls + '" data-ref="' + esc(r.projectRef) + '">' +
        '<div class="hd"><span class="nm">' + esc(r.projectName) + (r.isSample ? ' <span class="ed-badge sample">sample</span>' : "") + "</span>" +
        '<span class="ed-badge ' + matchClass(r.match) + '">' + r.match + "% match</span></div>" +
        picHtml +
        '<div class="ed-facts">' +
        "<span>Type: <b>" + esc(r.projectType || "—") + "</b></span>" +
        "<span>Decking: <b>" + (r.primaryAreaSF || 0) + " SF</b></span>" +
        "<span>Railing: <b>" + (r.railingLF || 0) + " LF</b></span>" +
        "<span>Stairs: <b>" + (r.stairs || 0) + "</b></span>" +
        "<span>Complexity: <b>" + esc(r.complexity || "—") + "</b></span>" +
        (r.city ? "<span>📍 <b>" + esc(r.city) + "</b></span>" : "") +
        "</div>" +
        '<div class="ed-facts"><span>Final price: <b>' + money(r.referencePrice) + "</b></span>" +
        "<span>Cost/SF: <b>" + (isFinite(Number(r.costPerPrimaryUnit)) ? "$" + Number(r.costPerPrimaryUnit).toFixed(2) : "—") + "</b></span>" +
        (r.productLine ? "<span>" + esc(r.deckingManufacturer || "") + " <b>" + esc(r.productLine) + "</b></span>" : "") +
        "</div>" +
        '<div style="margin-top:10px"><button class="btn btn-sm ' + (state.referenceId === r.projectRef ? "" : "btn-ghost") + ' pickRef" data-ref="' + esc(r.projectRef) + '">' +
        (state.referenceId === r.projectRef ? "✓ Reference selected" : "Use as reference →") + "</button></div></div>";
    }).join("");

    el("edApp").innerHTML =
      '<div class="ed-card"><h2>📊 Similar completed projects</h2>' +
      '<p class="ed-sub">Ranked by similarity to your scope. Pick the best historical reference — it anchors the benchmark on the estimate.</p>' +
      (cards || '<p class="ed-sub">No reference projects in the library yet. You can continue without one, or add past projects from the Estimates page.</p>') +
      '<div class="ed-msg" id="s2msg" style="color:var(--text-muted)">' +
      (state.referenceId ? "Reference: " + esc(state.referenceId) : "No reference selected (optional but recommended).") + "</div>" +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s2back">← Project</button>' +
      '<button class="btn" id="s2next">Choose materials →</button></div></div>';

    document.querySelectorAll(".pickRef").forEach(function (b) {
      b.onclick = function () {
        state.referenceId = b.dataset.ref === state.referenceId ? null : b.dataset.ref;
        renderStep2();
      };
    });
    // photo carousels: load the current photo; ‹ › cycle through that project's gallery
    document.querySelectorAll(".ed-refpic[data-car]").forEach(function (box) {
      var ref = state.ranked.find(function (r) { return r.projectRef === box.dataset.car; });
      var gal = DCRGallery.parse(ref);
      var img = box.querySelector("img");
      function show(idx) {
        idx = ((idx % gal.length) + gal.length) % gal.length;
        box.dataset.idx = idx;
        img.style.display = "none";
        img.onload = function () { img.style.display = ""; };
        DCRGallery.srcInto(img, gal[idx]);
        var ct = box.querySelector(".ct");
        if (ct) ct.textContent = (idx + 1) + " / " + gal.length;
      }
      box.querySelectorAll("[data-nav]").forEach(function (btn) {
        btn.onclick = function (ev) {
          ev.stopPropagation();
          show(Number(box.dataset.idx) + Number(btn.dataset.nav));
        };
      });
      show(0);
    });
    el("s2back").onclick = function () { go(1); };
    el("s2next").onclick = function () { go(3); };
  }

  /* ══ STEP 3 — materials ══ */
  async function renderStep3() {
    // only announce loading the FIRST time — otherwise every color tap blanks
    // the step behind an open viewer while the client is looking at it
    if (!state.catalog) el("edApp").innerHTML = '<div class="ed-card">Loading material catalog…</div>';
    try { await loadCatalog(); } catch (e) {
      el("edApp").innerHTML = '<div class="ed-card"><p style="color:var(--err)">Could not load the material catalog.</p></div>';
      return;
    }
    var cards = products().map(function (pr) {
      var selectable = pr.selectable !== undefined ? pr.selectable !== false : pr.status === "active";
      var isPrimary = state.sel.primary && state.sel.primary.materialId === pr.materialId;
      var isAlt = state.sel.alternative && state.sel.alternative.materialId === pr.materialId;
      var cls = "ed-mat" + (isPrimary ? " sel" : "") + (isAlt ? " alt" : "") + (selectable ? "" : " dis");
      // the cover falls back to the selected (or first) color's photo, since
      // that is where photos actually live for most lines
      var shot = coverPhoto(pr, isPrimary ? state.sel.primary.colorId : null);
      var nPhotos = linePhotoCount(pr);
      var thumb = '<span class="ed-cover' + (shot ? " has-pic" : "") + '">' +
        (shot ? '<img data-mvpic="' + esc(pr.materialId) + '" alt="">' : "🪵") + "</span>";
      var colorChips = "", profChips = "";
      if (isPrimary) {
        colorChips = '<div class="ed-chips">' + (pr.colors || []).map(function (c) {
          var on = state.sel.primary.colorId === c.colorId;
          var sw = (c.pictureItemId || c.pictureUrl)
            ? '<img style="display:none;width:18px;height:18px;border-radius:4px;object-fit:cover;vertical-align:-4px;margin-right:5px"' + picAttrs(c) + ' alt="">'
            : "";
          return '<span class="ed-chip' + (on ? " on" : "") + '" data-color="' + esc(c.colorId) + '">' + sw + esc(c.name) + "</span>";
        }).join("") + "</div>";
        profChips = '<div class="ed-chips">' + (pr.profiles || []).map(function (f) {
          var on = state.sel.primary.profileId === f.profileId;
          return '<span class="ed-chip' + (on ? " on" : "") + '" data-profile="' + esc(f.profileId) + '">' +
            esc((f.profileType || "").replace(/_/g, " ") + " · " + (f.nominalDimensions || "")) + "</span>";
        }).join("") + "</div>";
      }
      return '<div class="' + cls + '" data-mat="' + esc(pr.materialId) + '" data-selectable="' + selectable + '">' +
        '<div class="hd"><div style="display:flex;gap:11px;align-items:center;min-width:0">' + thumb + '<div><b>' + esc(pr.brandName) + " " + esc(lineName(pr)) + "</b>" +
        '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">' + esc(pr.shortDescription || "") + "</div>" +
        '<div class="ed-photos">' + (nPhotos ? "📷 " + nPhotos + " photo" + (nPhotos === 1 ? "" : "s") : "No photos yet") +
          (pr.warrantySummary ? " · " + esc(pr.warrantySummary) : "") + "</div></div></div>" +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="ed-tier">' + esc(pr.marketTier || "") + "</span>" +
        '<button class="btn btn-sm btn-ghost detBtn" data-mat="' + esc(pr.materialId) + '">Details</button>' +
        (selectable
          ? '<button class="btn btn-sm btn-ghost altBtn" data-mat="' + esc(pr.materialId) + '">' + (isAlt ? "✓ Alternative" : "+ Alt") + "</button>"
          : '<span class="ed-badge sample">pending approval</span>') +
        "</div></div>" +
        (isPrimary ? '<div style="font-size:11.5px;font-weight:700;margin-top:8px">Color</div>' + colorChips +
          '<div style="font-size:11.5px;font-weight:700;margin-top:8px">Profile</div>' + profChips : "") +
        "</div>";
    }).join("");

    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🪵 Decking material</h2>' +
      '<p class="ed-sub">Pick the primary decking line (tap a card), then its color and profile. Optionally mark a second line as the client\'s alternative. ' +
      'Identity data is manufacturer-verified; <b>pricing stays pending</b> until approved price records exist.</p>' +
      cards +
      '<div class="ed-msg" id="s3msg" style="color:var(--err)"></div>' +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s3back">← Similar projects</button>' +
      '<button class="btn" id="s3next">Review →</button></div></div>';

    hydratePics(el("edApp"));
    // card covers come from the same photo pool the viewer uses
    el("edApp").querySelectorAll("img[data-mvpic]").forEach(function (img) {
      var pr2 = findProduct(img.getAttribute("data-mvpic"));
      if (!pr2) return;
      var isPri = state.sel.primary && state.sel.primary.materialId === pr2.materialId;
      var first = coverPhoto(pr2, isPri ? state.sel.primary.colorId : null);
      if (!first) return;
      img.style.display = "none";
      img.onload = function () { img.style.display = "block"; };
      DCRGallery.srcInto(img, first.e);
    });
    document.querySelectorAll(".detBtn").forEach(function (b) {
      b.onclick = function (ev) { ev.stopPropagation(); openMatModal(b.dataset.mat); };
    });

    document.querySelectorAll(".ed-mat").forEach(function (card) {
      card.querySelector(".hd").onclick = function (ev) {
        if (ev.target.closest(".altBtn") || ev.target.closest(".detBtn")) return;
        if (card.dataset.selectable !== "true") return;
        var id = card.dataset.mat;
        if (state.sel.primary && state.sel.primary.materialId === id) return;
        var pr = findProduct(id);
        state.sel.primary = { materialId: id,
          colorId: (pr.colors && pr.colors[0]) ? pr.colors[0].colorId : null,
          profileId: (pr.profiles && pr.profiles[0]) ? pr.profiles[0].profileId : null };
        if (state.sel.alternative && state.sel.alternative.materialId === id) state.sel.alternative = null;
        renderStep3();
      };
    });
    document.querySelectorAll(".altBtn").forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var id = b.dataset.mat;
        if (state.sel.alternative && state.sel.alternative.materialId === id) {
          state.sel.alternative = null;
        } else {
          if (state.sel.primary && state.sel.primary.materialId === id) return;
          var pr = findProduct(id);
          state.sel.alternative = { materialId: id, colorId: (pr.colors && pr.colors[0]) ? pr.colors[0].colorId : null };
        }
        renderStep3();
      };
    });
    document.querySelectorAll("[data-color]").forEach(function (chip) {
      chip.onclick = function () { state.sel.primary.colorId = chip.dataset.color; renderStep3(); };
    });
    document.querySelectorAll("[data-profile]").forEach(function (chip) {
      chip.onclick = function () { state.sel.primary.profileId = chip.dataset.profile; renderStep3(); };
    });
    // the viewer is open over this step — keep its contents in step with it
    if (!el("matModal").hidden && mv.materialId) renderMatModal();
    el("s3back").onclick = function () { go(2); };
    el("s3next").onclick = function () {
      if (!state.sel.primary) { el("s3msg").textContent = "Please select a primary material (or go back if you only need the comparison)."; return; }
      // a draft saved while a line was active can be reopened after that line
      // goes back to review — never let it print against something unsellable
      var chosen = findProduct(state.sel.primary.materialId);
      if (!chosen) { el("s3msg").textContent = "That material is no longer in the catalog — please pick another line."; return; }
      var ok = chosen.selectable !== undefined ? chosen.selectable !== false : chosen.status === "active";
      if (!ok) {
        el("s3msg").textContent = chosen.brandName + " " + lineName(chosen) +
          " is not available to quote right now — please pick another line.";
        return;
      }
      go(4);
    };
    paintSteps(); // a just-picked material unlocks steps 4-5 right away
  }

  /* ══ STEP 4 — review ══ */
  async function renderStep4() {
    await loadCatalog();
    var p = state.project;
    var snap = buildSnapshot();
    var ref = state.referenceId && state.ranked ? state.ranked.find(function (r) { return r.projectRef === state.referenceId; }) : null;
    function kv(k, v) { return '<div class="ed-kv"><span>' + k + '</span><span class="v">' + v + "</span></div>"; }
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>🧾 Review before generating</h2>' +
      '<p class="ed-sub">Confirm the scope, the reference, and the material selection.</p>' +
      '<h3 style="margin:8px 0 2px;font-size:14px">Project</h3>' +
      kv("Client", esc(p.clientName) + (p.clientPhone ? " · " + esc(p.clientPhone) : "")) +
      kv("Address", esc([p.address, p.city].filter(Boolean).join(", "))) +
      kv("Type / complexity", esc(p.projectType) + " · " + esc(p.complexity)) +
      kv("Decking / framing", (p.deckingArea || 0) + " SF / " + (p.framingArea || 0) + " SF") +
      kv("Railing / stairs", (p.railing || 0) + " LF / " + (p.stairs || 0)) +
      (p.terrain || p.access ? kv("Site", esc([p.terrain, p.access].filter(Boolean).join(" · "))) : "") +
      '<h3 style="margin:16px 0 2px;font-size:14px">Historical reference</h3>' +
      (ref ? kv(esc(ref.projectName), ref.match + "% match · " + money(ref.referencePrice) + " · $" + Number(ref.costPerPrimaryUnit || 0).toFixed(2) + "/SF")
           : '<p class="ed-sub">None selected — the estimate will show comparables only.</p>') +
      '<h3 style="margin:16px 0 2px;font-size:14px">Materials</h3>' +
      (snap ? kv("Primary", esc(snap.primary.officialName) + " · " + esc(snap.primary.colorName) +
          (snap.primary.nominalDimensions ? " · " + esc(snap.primary.nominalDimensions) : "")) +
          (snap.alternative ? kv("Alternative", esc(snap.alternative.officialName) + " · " + esc(snap.alternative.colorName)) : "")
        : '<p class="ed-sub">No material selected.</p>') +
      '<div class="ed-warn">Material <b>pricing</b> is not included yet — totals below come only from completed-project cost history.</div>' +
      '<div class="ed-nav"><button class="btn btn-ghost" id="s4back">← Materials</button>' +
      '<button class="btn" id="s4next">Generate preliminary estimate →</button></div></div>';
    el("s4back").onclick = function () { go(3); };
    el("s4next").onclick = function () { go(5); };
  }

  /* ══ STEP 5 — preliminary estimate ══ */
  async function renderStep5() {
    await loadRefs(); await loadCatalog();
    if (!state.ranked) state.ranked = rankRefs(state.project, state.refs);
    state.version = (state.version || 0) + 1;
    state.output = buildOutput();
    var o = state.output, p = state.project;
    if (!state.estimateRef) state.estimateRef = "EST-" + Date.now();

    var bench = o.benchmark, range = o.range;
    var benchRef = bench.present && state.ranked
      ? state.ranked.find(function (r) { return r.projectRef === bench.projectRef; }) : null;
    var benchGal = benchRef ? DCRGallery.parse(benchRef) : [];
    var benchPic = benchGal.length
      ? '<div style="display:flex;gap:12px;align-items:center;margin:6px 0 2px">' +
        '<span class="ed-benchpic"><img style="display:none" data-bench-pic alt=""></span>' +
        '<span style="font-size:12px;color:var(--text-muted)">' + esc(bench.projectName) +
        " — completed project photo" + (benchGal.length > 1 ? "s (📷 " + benchGal.length + ")" : "") + "</span></div>"
      : "";
    var benchHtml = bench.present
      ? benchPic +
        '<div class="ed-kv"><span>Reference</span><span class="v">' + esc(bench.projectName) + " (" + (bench.match != null ? bench.match + "%" : "—") + ")</span></div>" +
        '<div class="ed-kv"><span>Historical cost/SF × your ' + bench.currentAreaSF + ' SF</span><span class="v">$' +
          (bench.costPerSF != null ? bench.costPerSF.toFixed(2) : "—") + " × " + bench.currentAreaSF + "</span></div>" +
        '<div class="ed-kv"><span><b>Benchmark total</b></span><span class="v ed-total">' + money(bench.total) + "</span></div>" +
        (!bench.eligibleForRange ? '<div class="ed-warn">Excluded from the comparable range: ' + esc(bench.exclusionReasons.join("; ")) + ".</div>" : "")
      : '<p class="ed-sub">' + esc(bench.note) + "</p>";

    var rangeHtml;
    if (range.st === "none") rangeHtml = '<div class="ed-warn">' + esc(range.note) + "</div>";
    else if (range.st === "single") rangeHtml =
      '<div class="ed-kv"><span>Single comparable value</span><span class="v ed-total">' + money(range.loTotal) + "</span></div>" +
      '<p class="ed-sub">' + esc(range.note) + "</p>";
    else rangeHtml =
      '<div class="ed-kv"><span>Comparable range for ' + range.areaSF + " SF</span>" +
      '<span class="v ed-total">' + money(range.loTotal) + " – " + money(range.hiTotal) + "</span></div>" +
      '<div class="ed-kv"><span>Cost per SF range</span><span class="v">$' + range.loCps.toFixed(2) + " – $" + range.hiCps.toFixed(2) + "</span></div>" +
      '<p class="ed-sub">' + esc(range.note) + "</p>";

    var rowsHtml = o.sourceRows.map(function (r) {
      return "<tr><td>" + esc(r.projectName) +
        (r.isAnchor ? ' <span class="ed-badge hi" style="font-size:10px">reference</span>' : "") +
        (!r.inRange ? ' <span class="ed-badge lo" style="font-size:10px">outside range</span>' : "") +
        (r.isSample ? ' <span class="ed-badge sample" style="font-size:10px">sample</span>' : "") +
        "</td><td>" + esc(r.projectType) + '</td><td class="num">' + (r.refAreaSF || 0) + '</td><td class="num">' +
        (r.match != null ? r.match + "%" : "—") + '</td><td class="num">$' + Number(r.costPerSF || 0).toFixed(2) +
        '</td><td class="num"><b>' + money(r.total) + "</b></td></tr>";
    }).join("");

    var snap = o.selectionSnapshot;
    el("edApp").innerHTML =
      '<div class="ed-card"><h2>💵 Preliminary estimate <span style="font-size:12px;color:var(--text-muted)">' +
      esc(state.estimateRef) + " · v" + state.version + "</span></h2>" +
      '<p class="ed-sub">' + esc(p.clientName) + " — " + esc([p.address, p.city].filter(Boolean).join(", ")) + " · " +
      esc(p.projectType) + " · " + (p.deckingArea || 0) + " SF</p>" +
      '<h3 style="margin:6px 0 4px;font-size:15px">1 · Selected reference benchmark</h3>' + benchHtml +
      '<h3 style="margin:18px 0 4px;font-size:15px">2 · Comparable project range</h3>' + rangeHtml +
      (o.sourceRows.length
        ? '<div style="overflow-x:auto"><table class="ed-tbl"><thead><tr><th>Project</th><th>Type</th><th class="num">SF</th><th class="num">Match</th><th class="num">$/SF</th><th class="num">At your SF</th></tr></thead><tbody>' +
          rowsHtml + "</tbody></table></div>"
        : "") +
      '<h3 style="margin:18px 0 4px;font-size:15px">3 · Materials</h3>' +
      (snap
        ? '<div class="ed-kv"><span>Primary</span><span class="v">' + esc(snap.primary.officialName) + " · " + esc(snap.primary.colorName) + "</span></div>" +
          (snap.alternative ? '<div class="ed-kv"><span>Alternative</span><span class="v">' + esc(snap.alternative.officialName) + " · " + esc(snap.alternative.colorName) + "</span></div>" : "") +
          '<div class="ed-note">Material cost: <b>pending</b> — ' + esc(o.materialCost.note) + "</div>"
        : '<p class="ed-sub">No material selection recorded.</p>') +
      (state.media.photos.length || state.media.audioNotes.length
        ? '<h3 style="margin:18px 0 4px;font-size:15px">Project documentation</h3>' +
          (state.media.photos.length
            ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0">' +
              state.media.photos.slice(0, 8).map(function (ph) {
                var attrs = ph.id ? ' data-pic-item="' + esc(ph.id) + '"' : (ph.url ? ' data-pic-url="' + esc(ph.url) + '"' : "");
                return '<span style="width:56px;height:56px;border-radius:8px;overflow:hidden;background:var(--surface-2);position:relative;display:inline-flex">' +
                  '<img style="display:none;width:100%;height:100%;object-fit:cover"' + attrs + ' alt="">' +
                  (ph.ann && ph.ann.items && ph.ann.items.length
                    ? '<span style="position:absolute;bottom:0;right:0;background:rgba(0,0,0,.65);color:#ffd47f;font-size:9px;font-weight:700;padding:1px 4px;border-radius:6px 0 0 0">✏️</span>' : "") +
                  "</span>";
              }).join("") +
              (state.media.photos.length > 8 ? '<span style="font-size:11px;color:var(--text-muted);align-self:center">+' + (state.media.photos.length - 8) + " more</span>" : "") +
              "</div>"
            : "") +
          '<p class="ed-sub" style="margin:2px 0 0">📸 ' + state.media.photos.length + " photo" + (state.media.photos.length === 1 ? "" : "s") +
          " · 🎤 " + state.media.audioNotes.length + " voice note" + (state.media.audioNotes.length === 1 ? "" : "s") +
          " — attached to this estimate (edit them on step 1).</p>"
        : "") +
      '<h3 style="margin:18px 0 4px;font-size:15px">Assumptions & notes</h3>' +
      '<ul class="ed-assump">' + o.assumptions.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + "</ul>" +
      '<div class="ed-warn no-print"><b>Internal preliminary reference.</b> Review by a DCR estimator is required before any number is shared with the client.</div>' +
      '<div class="ed-nav no-print"><button class="btn btn-ghost" id="s5back">← Review</button>' +
      '<span style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<select id="s5status" class="btn-ghost" style="width:auto;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text)">' +
      ["draft", "preliminary", "reviewed", "sent", "won", "lost"].map(function (s) {
        return "<option" + (state.estStatus === s ? " selected" : "") + ">" + s + "</option>";
      }).join("") + "</select>" +
      '<button class="btn btn-ghost" id="s5print">🖨️ Print</button>' +
      '<button class="btn" id="s5save">💾 Save estimate</button></span></div>' +
      '<div class="ed-msg" id="s5msg"></div></div>';

    var benchImg = document.querySelector("img[data-bench-pic]");
    if (benchImg && benchGal.length) {
      benchImg.onload = function () { benchImg.style.display = ""; };
      DCRGallery.srcInto(benchImg, benchGal[0]);
    }
    hydratePics(el("edApp")); // project-documentation thumbnails
    el("s5back").onclick = function () { go(4); };
    el("s5print").onclick = function () { window.print(); };
    el("s5save").onclick = saveEstimate;
  }

  async function saveEstimate() {
    var msg = el("s5msg"), btn = el("s5save");
    btn.disabled = true; msg.style.color = "var(--text-muted)"; msg.textContent = "Saving…";
    state.estStatus = el("s5status").value;
    var p = state.project, o = state.output;
    var fields = {
      estimateRef: state.estimateRef, trade: "deck", estStatus: state.estStatus, version: state.version,
      clientName: p.clientName, clientPhone: p.clientPhone, clientEmail: p.clientEmail,
      siteAddress: p.address, city: p.city, projectType: p.projectType, complexity: p.complexity,
      primaryAreaSF: p.deckingArea, secondaryAreaSF: p.framingArea, railingLF: p.railing, stairs: p.stairs,
      scopeJson: JSON.stringify(p),
      selectionJson: JSON.stringify({ sel: state.sel, snapshot: o.selectionSnapshot }),
      outputJson: JSON.stringify(o),
      mediaJson: JSON.stringify(state.media),
      referenceProjectId: state.referenceId || "",
      benchmarkTotal: o.benchmark.present && o.benchmark.total != null ? o.benchmark.total : "",
      rangeLowTotal: o.range.st !== "none" ? o.range.loTotal : "",
      rangeHighTotal: o.range.st !== "none" ? o.range.hiTotal : "",
      notes: p.notes || "",
    };
    try {
      var res = await DCR.api("/api/portal?action=sales&part=estimates", {
        method: state.estimateId ? "PATCH" : "POST",
        body: state.estimateId ? { id: state.estimateId, fields: fields } : { fields: fields },
      });
      state.estimateId = res.estimate.id;
      clearDraftLocal();
      msg.style.color = "var(--ok)";
      msg.textContent = "✓ Saved to SharePoint (" + state.estimateRef + " v" + state.version + "). Find it any time on the Estimates page.";
      btn.disabled = false;
    } catch (e) {
      btn.disabled = false; msg.style.color = "var(--err)";
      msg.textContent = e.message || "Save failed.";
    }
  }

  /* ══ reopen a saved estimate ══ */
  async function loadSaved(id) {
    var d = await DCR.api("/api/portal?action=sales&part=estimates&id=" + encodeURIComponent(id));
    var est = d.estimate;
    state.estimateId = est.id;
    state.estimateRef = est.estimateRef || "";
    state.version = Number(est.version) || 0;
    state.estStatus = est.estStatus || "draft";
    try { state.project = Object.assign(state.project, JSON.parse(est.scopeJson || "{}")); } catch (e) {}
    try {
      var selWrap = JSON.parse(est.selectionJson || "{}");
      if (selWrap.sel) state.sel = selWrap.sel;
    } catch (e) {}
    try {
      var media = JSON.parse(est.mediaJson || "{}");
      state.media = { photos: media.photos || [], audioNotes: media.audioNotes || [] };
      normalizeNotes();
    } catch (e) {}
    state.referenceId = est.referenceProjectId || null;
  }

  // A restored note can't still be "uploading" — the in-memory audio is gone.
  // Keep the transcript either way; flag audio-less notes so the row says so.
  function normalizeNotes() {
    (state.media.audioNotes || []).forEach(function (n) {
      n.pending = false;
      if (!n.audioId) n.failed = true;
    });
  }

  /* ══ init ══ */
  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    // print letterhead
    var CO = DCR.companyInfo;
    el("phLogo").src = CO.logo;
    el("phCo").innerHTML = "<b>" + esc(CO.legalName || CO.name) + "</b><br>" +
      [CO.address, [CO.phone, CO.license].filter(Boolean).join(" · ")].filter(Boolean).map(esc).join("<br>");

    if (START_NEW) {
      // "+ New estimate" — blank slate. Anything previously in progress was
      // already auto-saved to SharePoint, so nothing is lost.
      clearDraftLocal();
    } else if (EDIT_ID) {
      try { await loadSaved(EDIT_ID); } catch (e) { /* start fresh on failure */ }
    } else {
      try {
        var draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
        if (draft && draft.project && draft.project.clientName) {
          state.project = Object.assign(state.project, draft.project);
          state.referenceId = draft.referenceId || null;
          state.sel = draft.sel || state.sel;
          state.estimateId = draft.estimateId || null;
          state.estimateRef = draft.estimateRef || "";
          state.version = draft.version || 0;
          state.estStatus = draft.estStatus || "draft";
          if (draft.media) {
            state.media = { photos: draft.media.photos || [], audioNotes: draft.media.audioNotes || [] };
            normalizeNotes();
          }
        }
      } catch (e) {}
    }
    go(1);
  });

  // Expose the pure logic for verification/tests (same pattern as timesheet-pdf).
  window.DeckEstimate = {
    matchScore: matchScore, rankRefs: rankRefs, eligibility: eligibility,
    buildBenchmark: buildBenchmark, buildRange: buildRange, buildRows: buildRows,
    state: state,
  };
})();
