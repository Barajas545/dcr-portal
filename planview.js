/* DCR portal — PDF Plan Viewer / Takeoff tool.
   Web port of the desktop "Professional Takeoff Tools" measurement model:
   - geometry stored in BASE units (PDF points at scale 1, y-down) — zoom-proof
   - pointsPerFoot (ppf) = 72 × paper-inches-per-foot; per-page override via 🎯 calibrate
   - lengths shown as ft'-in frac" rounded to the chosen tolerance (1 … 1/16")
   - work saves as "<pdf name>.PDFNotes" (JSON) in the SAME folder as the PDF.
   PDF bytes come straight from SharePoint's pre-authed downloadUrl (CORS-open). */

(function () {
  var qs = new URLSearchParams(location.search);
  var FILE_ID = qs.get("file");
  var PROJ_ID = qs.get("project") || "";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  /* ── drawing scales ── */
  var SCALES = [
    { label: '1" = 1\'',    ppf: 72 },
    { label: '3/4" = 1\'',  ppf: 54 },
    { label: '1/2" = 1\'',  ppf: 36 },
    { label: '3/8" = 1\'',  ppf: 27 },
    { label: '1/4" = 1\'',  ppf: 18 },
    { label: '3/16" = 1\'', ppf: 13.5 },
    { label: '1/8" = 1\'',  ppf: 9 },
    { label: '3/32" = 1\'', ppf: 6.75 },
    { label: '1/16" = 1\'', ppf: 4.5 },
    { label: '1" = 10\'',   ppf: 7.2 },
    { label: '1" = 20\'',   ppf: 3.6 },
    { label: '1" = 30\'',   ppf: 2.4 },
    { label: '1" = 40\'',   ppf: 1.8 },
    { label: '1" = 50\'',   ppf: 1.44 },
    { label: '1" = 60\'',   ppf: 1.2 },
  ];
  var COLORS = ["#e53935", "#2f80d8", "#2fa679", "#f2b32c", "#9b59d0", "#111111"];

  var state = {
    pdf: null, page: 1, pages: 1, zoom: 1, baseW: 0, baseH: 0,
    tool: "pan", color: COLORS[0], width: 3, tol: 8,
    ppfDefault: 18, scaleLabel: '1/4" = 1\'', ppfPage: {}, scaleLabelPage: {},
    items: [], undo: [], redo: [], sel: -1, hide: false, dirty: false,
    draw: null, // in-progress {type, pts, ...}
    countLabel: "", info: null, notesId: null, rendering: null, renderSeq: 0,
    pinch: null, pointers: {},
    cache: {}, crisp: null, crispTimer: null, // preview page bitmaps + crisp visible-region tile
  };

  /* ══ formatting ══ */
  function ppf(page) { return state.ppfPage[page] || state.ppfDefault; }
  function scaleLabelFor(page) { return state.scaleLabelPage[page] || state.scaleLabel; }
  function fmtFtIn(feet) {
    if (!isFinite(feet)) return "—";
    var neg = feet < 0; feet = Math.abs(feet);
    var totIn = feet * 12;
    var t = state.tol; // fractions per inch denominator
    var frac = Math.round(totIn * t) / t;
    var ft = Math.floor(frac / 12);
    var inch = frac - ft * 12;
    var whole = Math.floor(inch + 1e-9);
    var rem = inch - whole;
    var num = Math.round(rem * t), den = t;
    if (num === den) { whole += 1; num = 0; }
    if (whole === 12) { ft += 1; whole = 0; }
    while (num && num % 2 === 0 && den % 2 === 0) { num /= 2; den /= 2; }
    var inStr = whole + (num ? " " + num + "/" + den : "") + '"';
    var s = ft ? ft + "'-" + inStr : inStr;
    return (neg ? "-" : "") + s;
  }
  function fmtLF(feet) { return feet.toFixed(1) + " LF"; }
  function fmtSF(sf) { return sf.toFixed(1) + " sq ft"; }
  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
  function polyLen(pts) { var L = 0; for (var i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }
  function polyArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i++) { var j = (i + 1) % pts.length; a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
    return Math.abs(a) / 2;
  }

  /* ══ page rendering — pre-rasterize every sheet to an in-memory bitmap ══
     Each page is rendered ONCE to an ImageBitmap (preview res, ~1500px long
     edge). Page switch + zoom are then instant bitmap draws (no pdf.js re-run).
     When zoomed past preview resolution, the current page is re-rendered sharp
     on a short debounce so dimensions stay crisp. */
  async function buildOne(i) {
    if (state.cache[i]) return state.cache[i];
    var page = await state.pdf.getPage(i);
    var base = page.getViewport({ scale: 1 });
    var cs = Math.min(2.2, Math.max(0.6, 1500 / Math.max(base.width, base.height)));
    var vp = page.getViewport({ scale: cs });
    var cv = document.createElement("canvas");
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    var bmp = window.createImageBitmap ? await createImageBitmap(cv) : cv;
    state.cache[i] = { bmp: bmp, scale: cs, w: base.width, h: base.height };
    return state.cache[i];
  }
  async function preloadRest() {
    for (var i = 1; i <= state.pages; i++) {
      if (state.cache[i]) continue;
      hint("Preloading sheets… " + i + "/" + state.pages);
      try { await buildOne(i); } catch (e) {}
    }
    hint("All " + state.pages + " sheets loaded. Scroll to pan · Ctrl+scroll (or pinch, or +/−) to zoom · pick a tool.");
  }
  async function goToPage(n) {
    if (n < 1 || n > state.pages || n === state.page) return;
    state.page = n; state.sel = -1; state.draw = null; el("pvDel").style.display = "none";
    if (!state.cache[n]) { hint("Rendering sheet " + n + "…"); try { await buildOne(n); } catch (e) {} }
    showPage();
  }

  function showPage() {
    var c = state.cache[state.page];
    if (!c) return;
    state.baseW = c.w; state.baseH = c.h;
    var dpr = window.devicePixelRatio || 1;
    var pg = el("pgCanvas"), ov = el("ovCanvas"), wrap = el("viewWrap");
    var pxW = Math.max(1, Math.round(c.w * state.zoom * dpr));
    var pxH = Math.max(1, Math.round(c.h * state.zoom * dpr));
    pg.width = pxW; pg.height = pxH;
    pg.style.width = (pxW / dpr) + "px"; pg.style.height = (pxH / dpr) + "px";
    ov.width = pxW; ov.height = pxH; ov.style.width = pg.style.width; ov.style.height = pg.style.height;
    wrap.style.width = pg.style.width; wrap.style.height = pg.style.height;
    var ctx = pg.getContext("2d");
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, pxW, pxH);
    // preview bitmap scaled to fill — instant, slightly soft when zoomed in
    ctx.drawImage(c.bmp, 0, 0, c.bmp.width, c.bmp.height, 0, 0, pxW, pxH);
    // crisp visible-region tile on top, when it matches the current page & zoom
    var cr = state.crisp;
    if (cr && cr.page === state.page && Math.abs(cr.scale - state.zoom * dpr) < 0.01) {
      ctx.drawImage(cr.bmp, Math.round(cr.x * state.zoom * dpr), Math.round(cr.y * state.zoom * dpr));
    }
    el("pgInfo").textContent = state.page + "/" + state.pages;
    el("zPct").textContent = Math.round(state.zoom * 100) + "%";
    el("pvScaleInfo").textContent = "Scale: " + scaleLabelFor(state.page) +
      (state.ppfPage[state.page] ? " (calibrated)" : "");
    redraw();
    scheduleCrisp();
  }

  // Visible region of the current page, in page points.
  function visibleRectPoints() {
    var c = state.cache[state.page], vpt = el("viewport"), wrap = el("viewWrap");
    var cssX = Math.max(0, vpt.scrollLeft - wrap.offsetLeft);
    var cssY = Math.max(0, vpt.scrollTop - wrap.offsetTop);
    var cssW = Math.min(vpt.clientWidth, c.w * state.zoom - cssX);
    var cssH = Math.min(vpt.clientHeight, c.h * state.zoom - cssY);
    return { x: cssX / state.zoom, y: cssY / state.zoom, w: Math.max(0, cssW) / state.zoom, h: Math.max(0, cssH) / state.zoom };
  }

  // Debounced: re-render just the visible area of the current page at full
  // device resolution so it's crisp at any zoom (bounded by screen size, not page size).
  function scheduleCrisp() {
    var dpr = window.devicePixelRatio || 1, c = state.cache[state.page];
    if (!c) return;
    var needed = state.zoom * dpr;
    if (needed <= c.scale * 1.02) return; // preview already crisp enough
    var cr = state.crisp, v = visibleRectPoints();
    if (cr && cr.page === state.page && Math.abs(cr.scale - needed) < 0.01 &&
        cr.x <= v.x + 0.5 && cr.y <= v.y + 0.5 &&
        cr.x + cr.w >= v.x + v.w - 0.5 && cr.y + cr.h >= v.y + v.h - 0.5) return; // covered
    clearTimeout(state.crispTimer);
    state.crispTimer = setTimeout(renderCrisp, 140);
  }
  async function renderCrisp() {
    var pageNum = state.page, c = state.cache[pageNum];
    if (!c) return;
    var dpr = window.devicePixelRatio || 1, scale = state.zoom * dpr;
    var v = visibleRectPoints();
    if (v.w <= 0 || v.h <= 0) return;
    var mgPt = 60 / state.zoom; // margin so small pans stay crisp
    var x = Math.max(0, v.x - mgPt), y = Math.max(0, v.y - mgPt);
    var w = Math.min(c.w - x, v.w + 2 * mgPt), h = Math.min(c.h - y, v.h + 2 * mgPt);
    var pxW = Math.round(w * scale), pxH = Math.round(h * scale);
    if (pxW * pxH > 40e6 || pxW < 1 || pxH < 1) return; // pathological — keep preview
    try {
      var page = await state.pdf.getPage(pageNum);
      var vp = page.getViewport({ scale: scale });
      var cv = document.createElement("canvas");
      cv.width = pxW; cv.height = pxH;
      await page.render({ canvasContext: cv.getContext("2d"), viewport: vp,
        transform: [1, 0, 0, 1, -x * scale, -y * scale] }).promise;
      var bmp = window.createImageBitmap ? await createImageBitmap(cv) : cv;
      if (state.crisp && state.crisp.bmp && state.crisp.bmp.close) try { state.crisp.bmp.close(); } catch (e) {}
      state.crisp = { page: pageNum, x: x, y: y, w: w, h: h, scale: scale, bmp: bmp };
      if (state.page === pageNum) showPage();
    } catch (e) {}
  }

  /* ══ overlay drawing ══ */
  function S(pt) { var f = state.zoom * (window.devicePixelRatio || 1); return [pt[0] * f, pt[1] * f]; }
  function lw(w) { return w * state.zoom * (window.devicePixelRatio || 1); }

  function pill(ctx, x, y, text, color) {
    var f = (window.devicePixelRatio || 1) * Math.max(0.75, Math.min(1.6, state.zoom));
    var fs = 12 * f;
    ctx.font = "bold " + fs + "px Arial";
    var w = ctx.measureText(text).width + 12 * f, h = fs + 8 * f;
    ctx.fillStyle = "rgba(20,20,20,.82)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * f); else ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = color || "#fff";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
  }

  function arrowHead(ctx, from, to, size) {
    var ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]);
    ctx.lineTo(to[0] - size * Math.cos(ang - 0.45), to[1] - size * Math.sin(ang - 0.45));
    ctx.lineTo(to[0] - size * Math.cos(ang + 0.45), to[1] - size * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }

  function drawItem(ctx, it, selected) {
    var pts = it.pts.map(S);
    ctx.save();
    if (selected) { ctx.shadowColor = "#4ea3ff"; ctx.shadowBlur = 12; }
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color;
    ctx.lineWidth = lw(it.width || 3); ctx.lineCap = "round"; ctx.lineJoin = "round";
    var p = ppf(it.page);

    if (it.type === "measure" && pts.length === 2) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke();
      arrowHead(ctx, pts[0], pts[1], lw(5)); arrowHead(ctx, pts[1], pts[0], lw(5));
      var ft = polyLen(it.pts) / p;
      pill(ctx, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - lw(9), fmtFtIn(ft), "#ffd47f");
    } else if (it.type === "poly" && pts.length >= 2) {
      ctx.beginPath(); pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
      pts.forEach(function (q) { ctx.beginPath(); ctx.arc(q[0], q[1], lw(2), 0, 7); ctx.fill(); });
      var lf = polyLen(it.pts) / p;
      var mid = pts[pts.length - 1];
      pill(ctx, mid[0], mid[1] - lw(11), (it.label ? it.label + ": " : "") + fmtLF(lf) + " (" + fmtFtIn(lf) + ")", "#ffd47f");
    } else if (it.type === "area" && pts.length >= 3) {
      ctx.globalAlpha = 0.18;
      ctx.beginPath(); pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.stroke();
      var sf = polyArea(it.pts) / (p * p);
      var per = (polyLen(it.pts) + dist(it.pts[it.pts.length - 1], it.pts[0])) / p;
      var c = pts.reduce(function (a, q) { return [a[0] + q[0], a[1] + q[1]]; }, [0, 0]).map(function (v) { return v / pts.length; });
      pill(ctx, c[0], c[1], (it.label ? it.label + ": " : "") + fmtSF(sf) + " · per " + fmtLF(per), "#a8e6c7");
    } else if (it.type === "count") {
      var q0 = pts[0], R = lw(9);
      ctx.beginPath(); ctx.arc(q0[0], q0[1], R, 0, 7); ctx.globalAlpha = .9; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      var f2 = (window.devicePixelRatio || 1) * Math.max(0.75, Math.min(1.6, state.zoom));
      ctx.font = "bold " + (11 * f2) + "px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(it.seq), q0[0], q0[1]);
    } else if (it.type === "hl") {
      ctx.globalAlpha = 0.35; ctx.lineWidth = lw((it.width || 3) * 4);
      ctx.beginPath(); pts.forEach(function (q, i) { i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
    } else if (it.type === "hlbox" && pts.length === 2) {
      ctx.globalAlpha = 0.28;
      ctx.fillRect(Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]),
        Math.abs(pts[1][0] - pts[0][0]), Math.abs(pts[1][1] - pts[0][1]));
    } else if (it.type === "arrow" && pts.length === 2) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke();
      arrowHead(ctx, pts[0], pts[1], lw(7));
    } else if (it.type === "text") {
      drawTextBox(ctx, pts[0], it.text, it.color);
    } else if (it.type === "callout" && pts.length === 2) {
      ctx.beginPath(); ctx.moveTo(pts[1][0], pts[1][1]); ctx.lineTo(pts[0][0], pts[0][1]); ctx.stroke();
      arrowHead(ctx, pts[1], pts[0], lw(7));
      drawTextBox(ctx, pts[1], it.text, it.color);
    }
    ctx.restore();
  }

  function drawTextBox(ctx, at, text, color) {
    var f = (window.devicePixelRatio || 1) * Math.max(0.8, Math.min(1.7, state.zoom));
    var fs = 13 * f, pad = 6 * f;
    var lines = String(text || "").split("\n");
    ctx.font = "bold " + fs + "px Arial";
    var w = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; })) + pad * 2;
    var h = lines.length * (fs + 3 * f) + pad * 2;
    ctx.fillStyle = "rgba(255,255,240,.95)";
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * f;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(at[0], at[1] - h, w, h, 4 * f); else ctx.rect(at[0], at[1] - h, w, h);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#222"; ctx.textAlign = "left"; ctx.textBaseline = "top";
    lines.forEach(function (l, i) { ctx.fillText(l, at[0] + pad, at[1] - h + pad + i * (fs + 3 * f)); });
  }

  function redraw() {
    var ov = el("ovCanvas"), ctx = ov.getContext("2d");
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (state.hide) return;
    state.items.forEach(function (it, i) {
      if (it.page === state.page) drawItem(ctx, it, i === state.sel);
    });
    if (state.draw) drawItem(ctx, state.draw, false);
    updateSummary();
  }

  /* ══ history / mutation ══ */
  function snapshot() {
    state.undo.push(JSON.stringify(state.items));
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }
  function markDirty() {
    state.dirty = true;
    el("pvSave").textContent = "💾 Save Notes ●";
  }
  function addItem(it) { snapshot(); state.items.push(it); markDirty(); redraw(); }
  function doUndo() {
    if (!state.undo.length) return;
    state.redo.push(JSON.stringify(state.items));
    state.items = JSON.parse(state.undo.pop());
    state.sel = -1; markDirty(); redraw();
  }
  function doRedo() {
    if (!state.redo.length) return;
    state.undo.push(JSON.stringify(state.items));
    state.items = JSON.parse(state.redo.pop());
    state.sel = -1; markDirty(); redraw();
  }

  /* ══ hit testing ══ */
  function ptSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function hitTest(pt) {
    var TH = 10 / state.zoom;
    for (var i = state.items.length - 1; i >= 0; i--) {
      var it = state.items[i];
      if (it.page !== state.page) continue;
      var pts = it.pts;
      if (it.type === "count" || it.type === "text") {
        if (dist(pt, pts[0]) < TH * 1.6) return i;
      } else if (it.type === "hlbox" && pts.length === 2) {
        var x0 = Math.min(pts[0][0], pts[1][0]), x1 = Math.max(pts[0][0], pts[1][0]);
        var y0 = Math.min(pts[0][1], pts[1][1]), y1 = Math.max(pts[0][1], pts[1][1]);
        if (pt[0] >= x0 - TH && pt[0] <= x1 + TH && pt[1] >= y0 - TH && pt[1] <= y1 + TH) return i;
      } else if (it.type === "callout" && pts.length === 2) {
        if (ptSeg(pt, pts[0], pts[1]) < TH || dist(pt, pts[1]) < TH * 3) return i;
      } else {
        for (var s = 1; s < pts.length; s++) if (ptSeg(pt, pts[s - 1], pts[s]) < TH) return i;
        if (it.type === "area" && pts.length >= 3 && ptSeg(pt, pts[pts.length - 1], pts[0]) < TH) return i;
      }
    }
    return -1;
  }

  /* ══ pointer / tool handling ══ */
  function evBase(e) {
    var ov = el("ovCanvas"), r = ov.getBoundingClientRect();
    return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom];
  }

  var drag = null; // {mode:"pan"|"draw"|"move", start, itemStart, moved}

  function onDown(e) {
    var ov = el("ovCanvas");
    state.pointers[e.pointerId] = e;
    var pk = Object.keys(state.pointers);
    if (pk.length === 2) { // pinch begins — cancel any draw drag
      var a = state.pointers[pk[0]], b = state.pointers[pk[1]];
      state.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: state.zoom };
      drag = null;
      return;
    }
    if (e.button === 1) { drag = { mode: "pan", sx: e.clientX, sy: e.clientY, moved: false }; ov.setPointerCapture(e.pointerId); return; }
    var pt = evBase(e);
    var t = state.tool;

    if (t === "pan") {
      var hi = hitTest(pt);
      if (hi >= 0) {
        state.sel = hi; el("pvDel").style.display = "";
        drag = { mode: "move", start: pt, orig: JSON.parse(JSON.stringify(state.items[hi].pts)), idx: hi, moved: false };
      } else {
        state.sel = -1; el("pvDel").style.display = "none";
        drag = { mode: "pan", sx: e.clientX, sy: e.clientY, moved: false };
      }
      ov.setPointerCapture(e.pointerId); redraw(); return;
    }
    if (t === "erase") {
      var hi2 = hitTest(pt);
      if (hi2 >= 0) { snapshot(); state.items.splice(hi2, 1); state.sel = -1; markDirty(); redraw(); }
      drag = { mode: "erase" }; ov.setPointerCapture(e.pointerId); return;
    }
    if (t === "count") {
      if (!state.countLabel) { openCount(pt); return; }
      var seq = state.items.filter(function (x) { return x.type === "count" && x.label === state.countLabel; }).length + 1;
      addItem({ type: "count", page: state.page, pts: [pt], color: state.color, label: state.countLabel, seq: seq });
      hint("Counting \"" + state.countLabel + "\" — " + seq + " placed. Click to add more, Esc/other tool to stop.");
      return;
    }
    if (t === "text") { openText("Text note", function (txt) { addItem({ type: "text", page: state.page, pts: [pt], color: state.color, text: txt }); }); return; }
    if (t === "poly" || t === "area") {
      if (!state.draw) state.draw = { type: t, page: state.page, pts: [pt], color: state.color, width: state.width };
      else {
        // snap-close for area
        if (t === "area" && state.draw.pts.length >= 3 && dist(pt, state.draw.pts[0]) < 12 / state.zoom) { finishDraw(); return; }
        state.draw.pts.push(pt);
      }
      redraw(); return;
    }
    // two-point drag tools: measure, arrow, hlbox, callout, cal + freehand hl
    if (t === "hl") { state.draw = { type: "hl", page: state.page, pts: [pt], color: state.color, width: state.width }; drag = { mode: "draw" }; ov.setPointerCapture(e.pointerId); return; }
    var map = { measure: "measure", arrow: "arrow", hlbox: "hlbox", callout: "callout", cal: "measure" };
    if (map[t]) {
      // click-click completion: a pending first point exists → this click finishes it
      if (state.draw && state.draw._twoPt) {
        var d0 = state.draw; d0.pts[1] = pt; state.draw = null;
        if (d0._cal) openCalibrate(d0);
        else if (d0.type === "callout") openText("Callout text", function (txt) { d0.text = txt; addItem(d0); });
        else addItem(d0);
        redraw(); return;
      }
      state.draw = { type: map[t], page: state.page, pts: [pt, pt], color: t === "cal" ? "#ff9800" : state.color, width: state.width, _cal: t === "cal", _twoPt: true };
      drag = { mode: "draw" }; ov.setPointerCapture(e.pointerId); return;
    }
  }

  function onMove(e) {
    if (state.pointers[e.pointerId]) state.pointers[e.pointerId] = e;
    var pk = Object.keys(state.pointers);
    if (pk.length === 2 && state.pinch) {
      var a = state.pointers[pk[0]], b = state.pointers[pk[1]];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      var mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      zoomAt(mx, my, (state.pinch.zoom * d / state.pinch.d) / state.zoom);
      return;
    }
    var pt = evBase(e);
    if (drag && drag.mode === "pan") {
      var vpt = el("viewport");
      vpt.scrollLeft -= e.movementX; vpt.scrollTop -= e.movementY;
      drag.moved = true; return;
    }
    if (drag && drag.mode === "move" && state.sel >= 0) {
      var dx = pt[0] - drag.start[0], dy = pt[1] - drag.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 1 / state.zoom) drag.moved = true;
      var it = state.items[drag.idx];
      it.pts = drag.orig.map(function (q) { return [q[0] + dx, q[1] + dy]; });
      redraw(); return;
    }
    if (drag && drag.mode === "erase" && e.buttons) {
      var hi = hitTest(pt);
      if (hi >= 0) { snapshot(); state.items.splice(hi, 1); markDirty(); redraw(); }
      return;
    }
    if (drag && drag.mode === "draw" && state.draw) {
      if (state.draw.type === "hl") state.draw.pts.push(pt);
      else state.draw.pts[1] = pt;
      redraw(); return;
    }
    if (state.draw && (state.draw.type === "poly" || state.draw.type === "area")) {
      state.draw._cursor = pt; redrawWithCursor(); return;
    }
    // click-click preview for pending two-point tools (no button held)
    if (state.draw && state.draw._twoPt && !drag) {
      state.draw.pts[1] = pt; redraw(); return;
    }
  }

  function redrawWithCursor() {
    redraw();
    if (!state.draw || !state.draw._cursor) return;
    var ctx = el("ovCanvas").getContext("2d");
    var last = S(state.draw.pts[state.draw.pts.length - 1]), cur = S(state.draw._cursor);
    ctx.save();
    ctx.strokeStyle = state.draw.color; ctx.setLineDash([6, 5]); ctx.lineWidth = lw(1.5);
    ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
    ctx.restore();
  }

  function onUp(e) {
    delete state.pointers[e.pointerId];
    if (Object.keys(state.pointers).length < 2) state.pinch = null;
    if (drag && drag.mode === "move") {
      if (drag.moved) { state.undo.push(JSON.stringify((function(){ var c=JSON.parse(JSON.stringify(state.items)); c[drag.idx].pts = drag.orig; return c; })())); state.redo = []; markDirty(); }
      drag = null; return;
    }
    if (drag && drag.mode === "draw" && state.draw) {
      var d0 = state.draw;
      if (d0.type === "hl") { if (d0.pts.length > 2) { state.draw = null; addItem(d0); } else state.draw = null; }
      else {
        if (dist(d0.pts[0], d0.pts[1]) < 3 / state.zoom) { drag = null; return; } // click-click: wait for second point via next down+drag
        state.draw = null;
        if (d0._cal) { openCalibrate(d0); }
        else if (d0.type === "callout") {
          openText("Callout text", function (txt) { d0.text = txt; addItem(d0); });
        } else addItem(d0);
      }
      drag = null; redraw(); return;
    }
    drag = null;
  }

  function finishDraw() {
    var d = state.draw;
    if (!d) return;
    state.draw = null;
    if (d.type === "poly" && d.pts.length >= 2) {
      var lbl = ""; // optional label prompt kept lightweight: reuse count label? keep none
      addItem(d);
    } else if (d.type === "area" && d.pts.length >= 3) addItem(d);
    else redraw();
  }

  /* ══ zoom / pan ══ */
  function zoomAt(clientX, clientY, factor) {
    if (!state.cache[state.page]) return;
    var vpt = el("viewport"), r = vpt.getBoundingClientRect();
    var nz = Math.max(0.1, Math.min(8, state.zoom * factor));
    if (Math.abs(nz - state.zoom) < 0.001) return;
    var ox = clientX - r.left + vpt.scrollLeft, oy = clientY - r.top + vpt.scrollTop;
    var k = nz / state.zoom;
    state.zoom = nz;
    showPage(); // synchronous bitmap draw — smooth
    vpt.scrollLeft = ox * k - (clientX - r.left);
    vpt.scrollTop = oy * k - (clientY - r.top);
  }
  function fitWidth() {
    var c = state.cache[state.page]; if (!c) return;
    var vpt = el("viewport");
    state.zoom = Math.min(8, Math.max(0.1, (vpt.clientWidth - 40) / c.w));
    showPage();
  }
  function fitPage() {
    var c = state.cache[state.page]; if (!c) return;
    var vpt = el("viewport");
    state.zoom = Math.min(8, Math.max(0.1, Math.min((vpt.clientWidth - 40) / c.w, (vpt.clientHeight - 40) / c.h)));
    showPage();
  }

  /* ══ modals ══ */
  var txtCb = null;
  function openText(title, cb) {
    el("txtTitle").textContent = title;
    el("txtInput").value = "";
    txtCb = cb;
    el("txtModal").classList.add("open");
    setTimeout(function () { el("txtInput").focus(); }, 50);
  }
  var calPending = null;
  function openCalibrate(d) {
    calPending = d;
    el("calInfo").textContent = "Line length on paper: " + (polyLen(d.pts) / 72).toFixed(3) + " in";
    el("calModal").classList.add("open");
    setTimeout(function () { el("calFt").focus(); el("calFt").select(); }, 50);
  }
  var cntPendingPt = null;
  function openCount(pt) {
    cntPendingPt = pt || null;
    el("cntLabel").value = state.countLabel || "";
    el("cntModal").classList.add("open");
    setTimeout(function () { el("cntLabel").focus(); }, 50);
  }

  /* ══ takeoff summary ══ */
  function summaryData() {
    var g = {}; // key -> {label, unit, valuePage, valueAll, count...}
    state.items.forEach(function (it) {
      var p = ppf(it.page), key, add = 0, unit = "";
      if (it.type === "measure" || it.type === "poly") { key = "LF|" + (it.label || (it.type === "measure" ? "Measurements" : "Lineal ft")); add = polyLen(it.pts) / p; unit = "LF"; }
      else if (it.type === "area") { key = "SF|" + (it.label || "Areas"); add = polyArea(it.pts) / (p * p); unit = "sq ft"; }
      else if (it.type === "count") { key = "EA|" + (it.label || "Count"); add = 1; unit = "ea"; }
      else return;
      if (!g[key]) g[key] = { label: key.split("|")[1], unit: unit, page: 0, all: 0 };
      g[key].all += add;
      if (it.page === state.page) g[key].page += add;
    });
    return g;
  }
  function updateSummary() {
    var g = summaryData(), keys = Object.keys(g).sort();
    if (!keys.length) { el("sumBody").innerHTML = '<div class="pv-note" style="padding:10px 0">No measurements yet.</div>'; return; }
    var html = '<div class="pv-sum-grp">This page / All pages</div>';
    keys.forEach(function (k) {
      var r = g[k];
      var f = r.unit === "ea" ? function (v) { return String(Math.round(v)); } : function (v) { return v.toFixed(1); };
      html += '<div class="pv-sum-row"><span>' + esc(r.label) + '</span><span class="v">' + f(r.page) + " / " + f(r.all) + " " + r.unit + "</span></div>";
    });
    el("sumBody").innerHTML = html;
  }
  function copySummary() {
    var g = summaryData(), lines = ["Item\tQty\tUnit"];
    Object.keys(g).sort().forEach(function (k) {
      var r = g[k];
      lines.push(r.label + "\t" + (r.unit === "ea" ? Math.round(r.all) : r.all.toFixed(1)) + "\t" + r.unit);
    });
    navigator.clipboard.writeText(lines.join("\n")).then(function () { hint("Takeoff summary copied — paste into an estimate or Excel."); });
  }

  /* ══ save / load .PDFNotes ══ */
  function notesName() { return state.info.name + ".PDFNotes"; }

  async function uploadNotes(blob) {
    var s = await DCR.api("/api/portal?action=drive", { method: "POST", body: {
      op: "uploadSession", parentId: state.info.parentId, name: notesName(), mimeType: "application/json" } });
    await new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", s.uploadUrl);
      x.setRequestHeader("Content-Range", "bytes 0-" + (blob.size - 1) + "/" + blob.size);
      x.onload = function () { (x.status === 200 || x.status === 201) ? resolve() : reject(new Error("Save failed (" + x.status + ")")); };
      x.onerror = function () { reject(new Error("Save failed — check connection.")); };
      x.send(blob);
    });
  }

  async function saveNotes() {
    if (!state.info) return;
    var payload = {
      version: 1, app: "dcr-planview", pdfName: state.info.name,
      scaleDefault: { label: state.scaleLabel, ppf: state.ppfDefault },
      scalePerPage: state.ppfPage, scaleLabelPerPage: state.scaleLabelPage,
      tolerance: state.tol, savedAt: new Date().toISOString(),
      items: state.items,
    };
    el("pvSave").disabled = true; el("pvSave").textContent = "Saving…";
    try {
      await uploadNotes(new Blob([JSON.stringify(payload)], { type: "application/json" }));
      state.dirty = false;
      el("pvSave").textContent = "💾 Save Notes";
      hint("Notes saved as " + notesName() + " ✓");
    } catch (e) {
      el("pvSave").textContent = "💾 Save Notes ●";
      hint("SAVE FAILED: " + (e.message || "error"));
      alert(e.message || "Save failed");
    }
    el("pvSave").disabled = false;
  }

  async function loadNotes() {
    try {
      var d = await DCR.api("/api/portal?action=drive&folderId=" + encodeURIComponent(state.info.parentId));
      var hit = (d.items || []).find(function (f) { return !f.isFolder && f.name.toLowerCase() === notesName().toLowerCase(); });
      if (!hit) return;
      var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(hit.id));
      var resp = await fetch(info.downloadUrl);
      var data = await resp.json();
      if (data && data.items) {
        state.items = data.items;
        if (data.scaleDefault) { state.ppfDefault = data.scaleDefault.ppf || 18; state.scaleLabel = data.scaleDefault.label || state.scaleLabel; }
        state.ppfPage = data.scalePerPage || {};
        state.scaleLabelPage = data.scaleLabelPerPage || {};
        if (data.tolerance) { state.tol = data.tolerance; el("pvTol").value = String(data.tolerance); }
        var si = el("pvScale");
        for (var i = 0; i < si.options.length; i++) if (si.options[i].textContent === state.scaleLabel) si.selectedIndex = i;
        hint("Loaded saved notes (" + state.items.length + " items) from " + notesName());
      }
    } catch (e) { /* no notes or unreadable — start fresh */ }
  }

  /* ══ misc UI ══ */
  function hint(t) { el("pvHint").textContent = t; }
  function setTool(t) {
    if (state.draw && (state.draw.type === "poly" || state.draw.type === "area")) finishDraw();
    state.draw = null;
    state.tool = t;
    if (t !== "count") state.countLabel = state.countLabel; // keep session label
    document.querySelectorAll(".pv-tool").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-tool") === t); });
    var hints = {
      pan: "Select/Pan — click an item to select (Del removes, drag moves). Scroll to pan · Ctrl+scroll / pinch to zoom.",
      measure: "Measure — drag (or click-click) between two points. Label shows " + scaleLabelFor(state.page) + " distance.",
      poly: "Lineal ft — click each point; double-click or Enter to finish.",
      area: "Area — click corners; click the first point (or double-click) to close.",
      count: "Count — click to drop numbered pins" + (state.countLabel ? " for \"" + state.countLabel + "\"" : "") + ".",
      hl: "Highlighter — drag to highlight freehand.",
      hlbox: "Box highlight — drag a rectangle.",
      arrow: "Arrow — drag from tail to tip.",
      text: "Text — click where the note should go.",
      callout: "Callout — drag from target to where the text box goes, then type.",
      erase: "Eraser — click (or drag over) annotations to delete.",
      cal: "Calibrate — drag along a known dimension on the plan, then enter its real length.",
    };
    hint(hints[t] || "");
    if (t === "count" && !state.countLabel) openCount(null);
  }

  function buildScaleSelect() {
    var s = el("pvScale");
    s.innerHTML = SCALES.map(function (sc, i) {
      return '<option value="' + i + '"' + (sc.ppf === state.ppfDefault ? " selected" : "") + ">" + esc(sc.label) + "</option>";
    }).join("");
    s.onchange = function () {
      var sc = SCALES[Number(s.value)];
      state.ppfDefault = sc.ppf; state.scaleLabel = sc.label;
      delete state.ppfPage[state.page]; delete state.scaleLabelPage[state.page];
      markDirty(); showPage();
    };
  }

  /* ══ init ══ */
  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!FILE_ID) { el("pvLoad").textContent = "No file selected."; return; }
    buildScaleSelect();

    el("pvColors").innerHTML = COLORS.map(function (c, i) {
      return '<span class="pv-color' + (i === 0 ? " on" : "") + '" data-c="' + c + '" style="background:' + c + '"></span>';
    }).join("");
    document.querySelectorAll("[data-c]").forEach(function (s) {
      s.onclick = function () {
        state.color = s.getAttribute("data-c");
        document.querySelectorAll("[data-c]").forEach(function (x) { x.classList.toggle("on", x === s); });
      };
    });
    document.querySelectorAll(".pv-tool").forEach(function (b) { b.onclick = function () { setTool(b.getAttribute("data-tool")); }; });
    el("pvWidth").onchange = function () { state.width = Number(this.value); };
    el("pvTol").onchange = function () { state.tol = Number(this.value); markDirty(); redraw(); };
    el("tCal").onclick = function () { setTool("cal"); };
    el("pgPrev").onclick = function () { goToPage(state.page - 1); };
    el("pgNext").onclick = function () { goToPage(state.page + 1); };
    el("zIn").onclick = function () { var v = el("viewport"); zoomAt(v.getBoundingClientRect().left + v.clientWidth / 2, v.getBoundingClientRect().top + v.clientHeight / 2, 1.25); };
    el("zOut").onclick = function () { var v = el("viewport"); zoomAt(v.getBoundingClientRect().left + v.clientWidth / 2, v.getBoundingClientRect().top + v.clientHeight / 2, 0.8); };
    el("zFitW").onclick = fitWidth;
    el("zFitP").onclick = fitPage;
    el("pvUndo").onclick = doUndo;
    el("pvRedo").onclick = doRedo;
    el("pvEye").onclick = function () { state.hide = !state.hide; redraw(); };
    el("pvDel").onclick = function () { if (state.sel >= 0) { snapshot(); state.items.splice(state.sel, 1); state.sel = -1; el("pvDel").style.display = "none"; markDirty(); redraw(); } };
    el("pvSave").onclick = saveNotes;
    el("pvSum").onclick = function () { el("sumPanel").classList.toggle("open"); };
    el("sumCopy").onclick = copySummary;

    // modal wiring
    el("txtCancel").onclick = function () { el("txtModal").classList.remove("open"); txtCb = null; };
    el("txtOk").onclick = function () {
      var v = el("txtInput").value.trim();
      el("txtModal").classList.remove("open");
      if (v && txtCb) txtCb(v);
      txtCb = null;
    };
    el("calCancel").onclick = function () { el("calModal").classList.remove("open"); calPending = null; setTool("pan"); };
    el("calOk").onclick = function () {
      var ft = Number(el("calFt").value) || 0, inch = Number(el("calIn").value) || 0;
      var real = ft + inch / 12;
      if (calPending && real > 0) {
        var basePts = polyLen(calPending.pts);
        state.ppfPage[state.page] = basePts / real;
        state.scaleLabelPage[state.page] = "calibrated (" + (basePts / real).toFixed(2) + " pt/ft)";
        markDirty();
      }
      el("calModal").classList.remove("open"); calPending = null;
      setTool("pan"); showPage();
    };
    el("cntCancel").onclick = function () { el("cntModal").classList.remove("open"); if (!state.countLabel) setTool("pan"); };
    el("cntOk").onclick = function () {
      var v = el("cntLabel").value.trim() || "Count";
      state.countLabel = v;
      el("cntModal").classList.remove("open");
      if (cntPendingPt) {
        var seq = state.items.filter(function (x) { return x.type === "count" && x.label === v; }).length + 1;
        addItem({ type: "count", page: state.page, pts: [cntPendingPt], color: state.color, label: v, seq: seq });
        cntPendingPt = null;
      }
      setTool("count");
    };

    // canvas events
    var ov = el("ovCanvas");
    ov.addEventListener("pointerdown", onDown);
    ov.addEventListener("pointermove", onMove);
    ov.addEventListener("pointerup", onUp);
    ov.addEventListener("pointercancel", onUp);
    ov.addEventListener("dblclick", function (e) { e.preventDefault(); if (state.draw) finishDraw(); });
    // Wheel: plain scroll pans; Ctrl/⌘+scroll (and trackpad pinch, which Chrome
    // delivers as ctrl+wheel) zooms smoothly, anchored at the cursor.
    el("viewport").addEventListener("wheel", function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
      }
    }, { passive: false });
    // re-crisp the newly-visible area after a scroll/pan settles
    el("viewport").addEventListener("scroll", function () { scheduleCrisp(); });

    document.addEventListener("keydown", function (e) {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.ctrlKey && e.key.toLowerCase() === "s") { e.preventDefault(); saveNotes(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); return; }
      if (e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); return; }
      if (e.key === "Escape") { state.draw = null; state.sel = -1; el("pvDel").style.display = "none"; redraw(); return; }
      if (e.key === "Enter" && state.draw) { finishDraw(); return; }
      if (e.key === "Delete" && state.sel >= 0) { el("pvDel").onclick(); return; }
      if (e.key === "PageDown") { el("pgNext").onclick(); return; }
      if (e.key === "PageUp") { el("pgPrev").onclick(); return; }
      var keys = { v: "pan", m: "measure", p: "poly", a: "area", c: "count", h: "hl", b: "hlbox", t: "text", e: "erase" };
      var t = keys[e.key.toLowerCase()];
      if (t && !e.ctrlKey && !e.metaKey) setTool(t);
    });
    window.addEventListener("beforeunload", function (e) {
      if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    // ── load the PDF ──
    try {
      state.info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(FILE_ID));
      el("pvName").textContent = state.info.name;
      document.title = "DCR — " + state.info.name;
      if (PROJ_ID) el("pvBack").href = "plans.html";
      var resp = await fetch(state.info.downloadUrl);
      if (!resp.ok) throw new Error("Could not download the PDF (" + resp.status + ")");
      var buf = await resp.arrayBuffer();
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/legacy/build/pdf.worker.min.js";
      state.pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      state.pages = state.pdf.numPages;
      // Render the first sheet for instant display, then preload the rest into
      // memory in the background so page-switching is instant afterwards.
      el("pvLoad").textContent = "Rendering sheet 1…";
      await buildOne(1);
      el("pvLoad").style.display = "none";
      await loadNotes();
      state.page = 1;
      fitWidth();
      preloadRest();
      // record recent
      try {
        var rec = JSON.parse(localStorage.getItem("dcrPlanRecent") || "[]").filter(function (r) { return r.id !== FILE_ID; });
        rec.unshift({ id: FILE_ID, pid: PROJ_ID, name: state.info.name, size: state.info.size, hasNotes: state.items.length > 0 });
        localStorage.setItem("dcrPlanRecent", JSON.stringify(rec.slice(0, 8)));
      } catch (e) {}
    } catch (e) {
      el("pvLoad").textContent = e.message || "Could not load the plan.";
    }
  });
})();
