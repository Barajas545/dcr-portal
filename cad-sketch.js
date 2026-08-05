/* DCR portal — CAD field-sketch editor (tablet-first).
   Draw a real dimensioned plan during the site visit: grid + snap + ortho,
   lines/rectangles/polygons with live ft-in dimensions and areas, dimension
   lines, text, post markers; select/move (whole or single vertex), pinch-zoom
   and pan. World units are FEET; labels use ft-in (1/16 tolerance).

   Saving exports a clean PNG (uploaded like any photo, so drawings display
   everywhere: tiles, carousels, printouts) AND keeps the drawing JSON on the
   gallery entry (entry.cad) so it reopens fully editable.

   API: DCRCad.open({ entry|null, title, getPathParts, onSave(entryPatch) })
        entryPatch = { id, name, cad } — caller merges into its gallery entry. */
(function () {
  var COLORS = ["#111111", "#e53935", "#1f6fc8", "#1f9d55", "#8b5a2b"];
  // Per-tool default look, so a plan reads by trade at a glance. Used when the
  // colour picker is on "A" (auto); picking a swatch overrides everything.
  var DECK_BROWN = "#8b5a2b", DECK_FILL = "rgba(193,154,107,0.28)";
  var TYPE_STYLE = {
    rect:    { color: DECK_BROWN, fill: DECK_FILL },   // deck areas
    poly:    { color: DECK_BROWN, fill: DECK_FILL },
    circle:  { color: DECK_BROWN, fill: DECK_FILL },
    stairs:  { color: DECK_BROWN },
    beam:    { color: "#1f9d55" },                     // green
    pillar:  { color: "#1f9d55" },
    railing: { color: "#1f6fc8" },                     // blue
    joist:   { color: "#d9b83c" },                     // light yellow, dotted
    fascia:  { color: "#b5651d" },                     // orange-brown band
  };
  var FILLED = { rect: 1, poly: 1, circle: 1 };
  var TOL = 16;
  var SNAPS = [0.5, 1, 0.25, 0];        // ft: 6in → 1ft → 3in → off
  var ORTHO_STEPS = [45, 22.5, 90, 0];  // deg between allowed directions (0 = free)
  var TAKEOFF_SUGGEST = ["Deck area", "Decking", "Framing", "Railing", "Stairs",
    "Fascia", "Posts", "Footings", "Beams", "Joists", "Lights", "Doors", "Windows", "Gates", "Pillars"];
  // tools whose symbol has a user-chosen size (asked on first use / re-tap)
  var SIZE_TOOLS = {
    door: { key: "doorW", title: "🚪 Door width", label: "Width", name: "Door", after: "tap on a wall to place it." },
    window: { key: "winW", title: "🪟 Window width", label: "Width", name: "Window", after: "tap on a wall to place it." },
    gate: { key: "gateW", title: "🚧 Gate width", label: "Width", name: "Gate", after: "tap on a railing to place it." },
    stairs: { key: "stairW", title: "🪜 Stair width", label: "Width", name: "Stairs", after: "drag the run out from the deck." },
    pillar: { key: "pillarSize", title: "▪ Pillar size", label: "Size (square)", name: "Pillar", after: "tap to place each one." },
  };
  var ui = null, st = null;

  /* ── ui ── */
  function injectUi() {
    if (ui) return;
    var css = document.createElement("style");
    css.textContent =
      ".cs-overlay{position:fixed;inset:0;background:#fff;z-index:9000;display:none;flex-direction:column}" +
      ".cs-overlay.open{display:flex}" +
      ".cs-bar{display:flex;align-items:center;gap:5px;padding:7px 10px;flex-wrap:wrap;background:#171d25;border-bottom:1px solid #2a333d}" +
      ".cs-title{font-size:13px;font-weight:700;color:#e6ebf1;margin-right:4px;max-width:20vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".cs-tool{min-width:40px;height:36px;border-radius:8px;border:1px solid #2a333d;background:#171d25;color:#e6ebf1;cursor:pointer;font-size:15px;flex-shrink:0;padding:0 8px}" +
      ".cs-tool.on{background:#2f80d8;border-color:#2f80d8;color:#fff}" +
      ".cs-tool.tog{font-size:11px;font-weight:700}" +
      ".cs-tool.tog.act{background:#1f6f4a;border-color:#2fa679;color:#fff}" +
      ".cs-color{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;flex-shrink:0}" +
      ".cs-color.on{border-color:#fff;box-shadow:0 0 0 2px rgba(47,128,216,.5)}" +
      ".cs-auto{font-size:10px;font-weight:800;color:#fff;text-align:center;line-height:19px;" +
      "text-shadow:0 1px 2px rgba(0,0,0,.7);background:linear-gradient(135deg,#8b5a2b 0 25%,#1f6fc8 25% 50%,#1f9d55 50% 75%,#d9b83c 75% 100%)}" +
      ".cs-btn{padding:7px 12px;font-size:12.5px;font-weight:600;border-radius:7px;cursor:pointer;border:1px solid #2a333d;background:#171d25;color:#e6ebf1}" +
      ".cs-btn.primary{background:#2f80d8;border-color:#2f80d8;color:#fff}" +
      ".cs-stage{flex:1;position:relative;overflow:hidden;touch-action:none;background:#fff}" +
      ".cs-stage canvas{position:absolute;left:0;top:0;touch-action:none}" +
      ".cs-hint{font-size:12px;color:#5a6b7d;padding:5px 12px;background:#f2f4f7;border-top:1px solid #dfe3e8;min-height:17px}" +
      ".cs-ctx{position:absolute;left:50%;transform:translateX(-50%);bottom:14px;display:none;gap:8px;background:rgba(23,29,37,.94);padding:8px 10px;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.35)}" +
      ".cs-ctx.open{display:flex}" +
      ".cs-prompt{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9100;display:none;align-items:center;justify-content:center;padding:16px}" +
      ".cs-prompt.open{display:flex}" +
      ".cs-prompt .box{background:#171d25;color:#e6ebf1;border:1px solid #2a333d;border-radius:12px;max-width:360px;width:100%;padding:18px}" +
      ".cs-prompt textarea,.cs-prompt input{width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border:1px solid #2a333d;border-radius:8px;background:#10151b;color:#e6ebf1}" +
      ".cs-prompt .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}" +
      ".cs-chip{font-size:11.5px;padding:4px 10px;border-radius:12px;border:1px solid #2a333d;background:#10151b;color:#e6ebf1;cursor:pointer}" +
      ".cs-chip:hover{border-color:#2f80d8;color:#7db9f0}" +
      ".cs-panel{position:absolute;right:0;top:0;bottom:0;width:260px;background:#fff;border-left:1px solid #dfe3e8;display:none;flex-direction:column;box-shadow:-4px 0 18px rgba(0,0,0,.12)}" +
      ".cs-panel.open{display:flex}" +
      ".cs-panel .ph{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #dfe3e8;font-size:13px;color:#1b2733;background:#f7f9fb}" +
      ".cs-panel .pb{flex:1;overflow:auto;padding:8px 12px 14px;font-size:12.5px;color:#1b2733}" +
      ".cs-grp{margin:10px 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#5a6b7d}" +
      ".cs-row{display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #eef1f5}" +
      ".cs-row b{white-space:nowrap}" +
      ".cs-tot{display:flex;justify-content:space-between;gap:8px;padding:6px 0;font-weight:700;color:#1f6f4a}";
    document.head.appendChild(css);

    ui = document.createElement("div");
    ui.className = "cs-overlay";
    ui.innerHTML =
      '<div class="cs-bar">' +
      '<span class="cs-title" id="csTitle">Drawing</span>' +
      '<button class="cs-tool" data-tool="select" title="Select / move">✥</button>' +
      '<button class="cs-tool" data-tool="pan" title="Pan (or drag with two fingers any time)">🖐</button>' +
      '<button class="cs-tool on" data-tool="line" title="Line / wall — live length">╱</button>' +
      '<button class="cs-tool" data-tool="arc" title="Arc / curve — tap start, end, then a point on the curve">◡</button>' +
      '<button class="cs-tool" data-tool="rect" title="Rectangle — auto W×H + area">▭</button>' +
      '<button class="cs-tool" data-tool="poly" title="Outline — tap corners; tap the first corner to close">⬠</button>' +
      '<button class="cs-tool" data-tool="tri" title="Triangle — tap 3 corners">◺</button>' +
      '<button class="cs-tool" data-tool="circle" title="Circle — drag from the center">◯</button>' +
      '<span style="width:6px"></span>' +
      '<button class="cs-tool" data-tool="railing" title="Railing run — tap along the edge, ✓ Finish (lineal feet)">⌗</button>' +
      '<button class="cs-tool" data-tool="fascia" title="Fascia run — tap along the exposed edges, ✓ Finish. Or select a deck outline and tap its edges.">▬</button>' +
      '<button class="cs-tool" data-tool="trim" title="Trim / extend — tap the line to fix, then the line it should meet">✂</button>' +
      '<button class="cs-tool" data-tool="array" title="Array — repeat the selected item at an on-centre spacing (joists, footings, balusters)">⧉</button>' +
      '<button class="cs-tool" data-tool="beam" title="Beam — drag the span (green)">═</button>' +
      '<button class="cs-tool" data-tool="joist" title="Floor joist — dotted line (drag the span)">⋯</button>' +
      '<button class="cs-tool" data-tool="stairs" title="Stairs — drag the run (tap the tool again for the width)">🪜</button>' +
      '<button class="cs-tool" data-tool="gate" title="Gate on a railing (tap the tool again for the width)">🚧</button>' +
      '<button class="cs-tool" data-tool="door" title="Door symbol (tap the tool again to change the size)">🚪</button>' +
      '<button class="cs-tool" data-tool="window" title="Window symbol (tap the tool again to change the size)">🪟</button>' +
      '<button class="cs-tool" data-tool="pillar" title="Pillar / column (tap the tool again for the size)">▪</button>' +
      '<button class="cs-tool" data-tool="post" title="Post marker">⊙</button>' +
      '<button class="cs-tool" data-tool="count" title="Count items — tap to drop numbered markers">🔢</button>' +
      '<button class="cs-tool" data-tool="dim" title="Dimension line">📏</button>' +
      '<button class="cs-tool" data-tool="text" title="Text label">T</button>' +
      '<button class="cs-tool" data-tool="erase" title="Eraser">🧽</button>' +
      '<button class="cs-btn" id="csEditSel" style="display:none">✏️</button>' +
      '<button class="cs-btn" id="csDimSel" style="display:none" title="Type the exact dimension">📐</button>' +
      '<button class="cs-btn" id="csTagSel" style="display:none" title="Takeoff label for this item">🏷</button>' +
      '<button class="cs-btn" id="csDelSel" style="display:none">🗑</button>' +
      '<span style="width:6px"></span>' +
      '<button class="cs-tool tog act" id="csOrtho" title="Keep lines square (horizontal/vertical)">ORTHO</button>' +
      '<button class="cs-tool tog act" id="csSnap" title="Snap distance">SNAP 6"</button>' +
      '<button class="cs-tool tog act" id="csGrid" title="Show grid">GRID</button>' +
      '<span id="csColors" style="display:flex;gap:5px;align-items:center"></span>' +
      '<span style="flex:1"></span>' +
      '<button class="cs-btn" id="csTakeoff" title="Takeoff — areas, lineal feet and counts">Σ Takeoff</button>' +
      '<button class="cs-tool" id="csZoomOut">−</button>' +
      '<button class="cs-tool" id="csZoomIn">＋</button>' +
      '<button class="cs-tool" id="csFit" title="Fit drawing">⛶</button>' +
      '<button class="cs-btn" id="csUndo">↶</button>' +
      '<button class="cs-btn" id="csRedo">↷</button>' +
      '<button class="cs-btn" id="csCancel">Cancel</button>' +
      '<button class="cs-btn primary" id="csSave">✓ Save drawing</button>' +
      "</div>" +
      '<div class="cs-stage" id="csStage"><canvas id="csCanvas"></canvas>' +
      '<div class="cs-ctx" id="csCtx">' +
      '<button class="cs-btn primary" id="csPolyDone">✓ Finish</button>' +
      '<button class="cs-btn" id="csPolyClose">⭯ Close shape</button>' +
      '<button class="cs-btn" id="csPolyCancel">✕</button></div>' +
      '<div class="cs-panel" id="csPanel"><div class="ph">' +
      '<span><button class="cs-btn cs-tab on" data-tab="takeoff" style="padding:3px 9px">Σ Takeoff</button> ' +
      '<button class="cs-btn cs-tab" data-tab="mats" style="padding:3px 9px">🧾 Materials</button></span>' +
      '<span><button class="cs-btn" id="csTakeoffCopy" style="padding:3px 8px">📋</button> ' +
      '<button class="cs-btn" id="csPanelClose" style="padding:3px 8px">✕</button></span></div>' +
      '<div class="pb" id="csPanelBody"></div></div></div>' +
      '<div class="cs-hint" id="csHint"></div>' +
      '<div class="cs-prompt" id="csPrompt"><div class="box">' +
      '<h4 id="csPromptTitle" style="margin:0 0 10px;font-size:14px"></h4>' +
      '<div id="csPromptText"><textarea id="csPromptInput" rows="2"></textarea>' +
      '<div id="csPromptChips" style="display:none;flex-wrap:wrap;gap:6px;margin-top:8px"></div></div>' +
      '<div id="csPromptDims" style="display:none">' +
        '<div id="csDimRowA" style="display:flex;gap:8px;align-items:end">' +
          '<div style="flex:1"><label id="csDimLabelA" style="font-size:11px;color:#93a1b1">Length — feet</label>' +
          '<input id="csDimAft" type="number" min="0" step="1" inputmode="numeric"></div>' +
          '<div style="flex:1"><label style="font-size:11px;color:#93a1b1">inches</label>' +
          '<input id="csDimAin" type="number" min="0" step="0.5" inputmode="decimal"></div></div>' +
        '<div id="csDimRowB" style="display:none;flex-direction:row;gap:8px;align-items:end;margin-top:8px">' +
          '<div style="flex:1"><label style="font-size:11px;color:#93a1b1">Height — feet</label>' +
          '<input id="csDimBft" type="number" min="0" step="1" inputmode="numeric"></div>' +
          '<div style="flex:1"><label style="font-size:11px;color:#93a1b1">inches</label>' +
          '<input id="csDimBin" type="number" min="0" step="0.5" inputmode="decimal"></div></div>' +
      "</div>" +
      '<div class="acts"><button class="cs-btn" id="csPromptCancel">Cancel</button>' +
      '<button class="cs-btn primary" id="csPromptOk">✓ OK</button></div></div></div>';
    document.body.appendChild(ui);
    wireStatic();
  }
  var q = function (s) { return ui.querySelector(s); };

  /* ── math ── */
  function fmtFtIn(feet) {
    if (!isFinite(feet)) return "";
    feet = Math.abs(feet);
    var ft = Math.floor(feet), inches = (feet - ft) * 12;
    var whole = Math.floor(inches), frac = Math.round((inches - whole) * TOL);
    if (frac === TOL) { frac = 0; whole++; }
    if (whole === 12) { whole = 0; ft++; }
    var g = (function gcd(a, b) { return b ? gcd(b, a % b) : a; })(frac || TOL, TOL);
    return ft + "'-" + whole + (frac ? " " + frac / g + "/" + TOL / g : "") + '"';
  }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function polyArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      s += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
    }
    return Math.abs(s / 2);
  }
  function ptSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  /* ── arcs: defined by 3 taps — start, end, then a point the curve passes
     through (standard 3-point arc). Everything downstream (length, hit-test,
     takeoff) works off a sampled polyline, which keeps the math honest. ── */
  function arcGeom(p0, p1, pm) {
    var ax = p0[0], ay = p0[1], bx = pm[0], by = pm[1], cx = p1[0], cy = p1[1];
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return null; // three points in a line
    var ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    var uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    var r = Math.hypot(ax - ux, ay - uy);
    var a0 = Math.atan2(ay - uy, ax - ux);
    var am = Math.atan2(by - uy, bx - ux);
    var a1 = Math.atan2(cy - uy, cx - ux);
    function norm(t) { t %= 2 * Math.PI; return t < 0 ? t + 2 * Math.PI : t; }
    var em = norm(am - a0), e1 = norm(a1 - a0);
    var sweep = em <= e1 ? e1 : e1 - 2 * Math.PI; // the way round that hits the mid point
    return { c: [ux, uy], r: r, a0: a0, sweep: sweep, len: r * Math.abs(sweep) };
  }
  function arcPoints(it, n) {
    var p = it.pts;
    if (p.length < 3) return p.slice();
    var g = arcGeom(p[0], p[1], p[2]);
    if (!g) return [p[0], p[2], p[1]];
    n = n || 40;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var a = g.a0 + g.sweep * (i / n);
      out.push([g.c[0] + Math.cos(a) * g.r, g.c[1] + Math.sin(a) * g.r]);
    }
    return out;
  }
  /* ── per-item styling (auto by tool, or the picked swatch) ── */
  function hexToRgba(hex, a) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return "rgba(140,140,140," + a + ")";
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function itemColor(kind) {
    return st.color || (TYPE_STYLE[kind] && TYPE_STYLE[kind].color) || "#111111";
  }
  function itemFill(kind) {
    if (!FILLED[kind]) return null;
    return st.color ? hexToRgba(st.color, 0.18) : TYPE_STYLE[kind].fill;
  }
  function pointInPoly(p, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function treadCount(it) {
    return Math.max(1, Math.round(dist(it.pts[0], it.pts[1]) / (11 / 12))); // 11" treads
  }

  // Every edge of an item, as [a,b] pairs (drives hit-testing, wall snapping
  // for openings, and lineal-foot takeoff).
  function segmentsOf(it) {
    var p = it.pts || [], out = [];
    if (it.type === "arc") {
      var ap = arcPoints(it, 24);
      for (var k = 1; k < ap.length; k++) out.push([ap[k - 1], ap[k]]);
      return out;
    }
    if (it.type === "rect" && p.length === 2) {
      var c = [p[0], [p[1][0], p[0][1]], p[1], [p[0][0], p[1][1]]];
      for (var i = 0; i < 4; i++) out.push([c[i], c[(i + 1) % 4]]);
      return out;
    }
    for (var j = 1; j < p.length; j++) out.push([p[j - 1], p[j]]);
    if (it.closed && p.length > 2) out.push([p[p.length - 1], p[0]]);
    return out;
  }
  function itemLength(it) {
    if (it.type === "arc" && it.pts.length >= 3) {
      var g = arcGeom(it.pts[0], it.pts[1], it.pts[2]);
      if (g) return g.len;
    }
    return segmentsOf(it).reduce(function (s, g2) { return s + dist(g2[0], g2[1]); }, 0);
  }
  // Openings sit ON a wall/railing: find the nearest edge and align/center to it.
  function placeOpening(type, w) {
    var width = type === "door" ? st.doorW : type === "gate" ? st.gateW : st.winW;
    var best = null, bd = 3; // ft search radius
    st.items.forEach(function (it) {
      if (["line", "rect", "poly", "railing", "beam", "arc"].indexOf(it.type) === -1) return;
      segmentsOf(it).forEach(function (s) {
        var d = ptSeg(w, s[0], s[1]);
        if (d < bd) { bd = d; best = s; }
      });
    });
    var dir = [1, 0], center = w;
    if (best) {
      var dx = best[1][0] - best[0][0], dy = best[1][1] - best[0][1];
      var L = Math.hypot(dx, dy) || 1;
      dir = [dx / L, dy / L];
      var t = Math.max(0, Math.min(1, ((w[0] - best[0][0]) * dx + (w[1] - best[0][1]) * dy) / (L * L)));
      center = [best[0][0] + dx * t, best[0][1] + dy * t];
    }
    var h = width / 2;
    return {
      type: type, color: itemColor(type),
      takeoff: type === "door" ? "Doors" : type === "gate" ? "Gates" : "Windows",
      pts: [[center[0] - dir[0] * h, center[1] - dir[1] * h],
            [center[0] + dir[0] * h, center[1] + dir[1] * h]],
    };
  }

  /* ── viewport ── */
  function toScreen(w) { return [(w[0] - st.offX) * st.ppf, (w[1] - st.offY) * st.ppf]; }
  function toWorld(clientX, clientY) {
    var r = q("#csCanvas").getBoundingClientRect();
    return [st.offX + (clientX - r.left) / st.ppf, st.offY + (clientY - r.top) / st.ppf];
  }
  function snapPoint(w, opts) {
    // endpoint snap beats grid snap
    var th = 12 / st.ppf, best = null, bd = th;
    st.items.forEach(function (it, i) {
      if (opts && opts.skip === i) return;
      (it.pts || []).forEach(function (p) {
        var d = dist(w, p);
        if (d < bd) { bd = d; best = p; }
      });
    });
    if (best) return [best[0], best[1]];
    if (st.snapFt > 0) return [Math.round(w[0] / st.snapFt) * st.snapFt, Math.round(w[1] / st.snapFt) * st.snapFt];
    return w;
  }
  // ORTHO: lock the direction to the nearest multiple of the chosen angle step
  // (90° = square only, 45° = square + diagonals, 22.5° = eighth-turns), and
  // land the length on the snap increment so 45° runs get clean numbers too.
  function applyOrtho(prev, pt) {
    if (!st.orthoDeg || !prev) return pt;
    var dx = pt[0] - prev[0], dy = pt[1] - prev[1];
    var len = Math.hypot(dx, dy);
    if (len < 1e-9) return pt;
    var step = st.orthoDeg * Math.PI / 180;
    var ang = Math.round(Math.atan2(dy, dx) / step) * step;
    if (st.snapFt > 0) len = Math.max(st.snapFt, Math.round(len / st.snapFt) * st.snapFt);
    return [prev[0] + Math.cos(ang) * len, prev[1] + Math.sin(ang) * len];
  }

  /* ── rendering ── */
  function resize() {
    var stage = q("#csStage"), cv = q("#csCanvas");
    var dpr = window.devicePixelRatio || 1;
    cv.width = stage.clientWidth * dpr;
    cv.height = stage.clientHeight * dpr;
    cv.style.width = stage.clientWidth + "px";
    cv.style.height = stage.clientHeight + "px";
    render();
  }

  function drawGrid(ctx, wpx, hpx) {
    if (!st.grid) return;
    var minor = st.ppf >= 14 ? 1 : 5, major = 5 * minor;
    function lines(stepFt, color) {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      var x0 = Math.floor(st.offX / stepFt) * stepFt;
      for (var x = x0; (x - st.offX) * st.ppf < wpx; x += stepFt) {
        var sx = (x - st.offX) * st.ppf;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, hpx);
      }
      var y0 = Math.floor(st.offY / stepFt) * stepFt;
      for (var y = y0; (y - st.offY) * st.ppf < hpx; y += stepFt) {
        var sy = (y - st.offY) * st.ppf;
        ctx.moveTo(0, sy); ctx.lineTo(wpx, sy);
      }
      ctx.stroke();
    }
    lines(minor, "#eef1f5");
    lines(major, "#dbe2ea");
  }

  function label(ctx, x, y, text, color, bg) {
    ctx.save();
    ctx.font = "bold 12px Arial";
    var w = ctx.measureText(text).width + 10, h = 18;
    ctx.fillStyle = bg || "rgba(255,255,255,.88)";
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = color || "#333";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  function arrowHead(ctx, from, to, size) {
    var ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]);
    ctx.lineTo(to[0] - size * Math.cos(ang - 0.4), to[1] - size * Math.sin(ang - 0.4));
    ctx.lineTo(to[0] - size * Math.cos(ang + 0.4), to[1] - size * Math.sin(ang + 0.4));
    ctx.closePath(); ctx.fill();
  }

  function drawItem(ctx, it, selected) {
    var P = (it.pts || []).map(toScreen);
    ctx.save();
    if (selected) { ctx.shadowColor = "#4ea3ff"; ctx.shadowBlur = 12; }
    ctx.strokeStyle = it.color || "#111"; ctx.fillStyle = it.color || "#111";
    ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (it.type === "line" && P.length === 2) {
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      label(ctx, (P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 - 13, fmtFtIn(dist(it.pts[0], it.pts[1])), it.color);
    } else if (it.type === "rect" && P.length === 2) {
      var x = Math.min(P[0][0], P[1][0]), y = Math.min(P[0][1], P[1][1]);
      var w = Math.abs(P[1][0] - P[0][0]), h = Math.abs(P[1][1] - P[0][1]);
      if (it.fill) { ctx.save(); ctx.fillStyle = it.fill; ctx.fillRect(x, y, w, h); ctx.restore(); }
      ctx.strokeRect(x, y, w, h);
      var wf = Math.abs(it.pts[1][0] - it.pts[0][0]), hf = Math.abs(it.pts[1][1] - it.pts[0][1]);
      label(ctx, x + w / 2, y - 12, fmtFtIn(wf), it.color);
      ctx.save(); ctx.translate(x - 12, y + h / 2); ctx.rotate(-Math.PI / 2);
      label(ctx, 0, 0, fmtFtIn(hf), it.color); ctx.restore();
      if (w > 60 && h > 30) label(ctx, x + w / 2, y + h / 2, (Math.round(wf * hf * 10) / 10) + " SF", "#666");
    } else if (it.type === "poly" && P.length >= 2) {
      ctx.beginPath();
      P.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      if (it.closed) ctx.closePath();
      if (it.closed && it.fill) { ctx.save(); ctx.fillStyle = it.fill; ctx.fill(); ctx.restore(); }
      ctx.stroke();
      for (var i2 = 1; i2 < it.pts.length; i2++) {
        var a = P[i2 - 1], b = P[i2];
        label(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12, fmtFtIn(dist(it.pts[i2 - 1], it.pts[i2])), it.color);
      }
      if (it.closed && it.pts.length >= 3) {
        var a2 = P[P.length - 1], b2 = P[0];
        label(ctx, (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2 - 12, fmtFtIn(dist(it.pts[it.pts.length - 1], it.pts[0])), it.color);
        var cx = 0, cy = 0;
        P.forEach(function (p) { cx += p[0]; cy += p[1]; });
        label(ctx, cx / P.length, cy / P.length, (Math.round(polyArea(it.pts) * 10) / 10) + " SF", "#1f6f4a", "rgba(220,245,232,.9)");
      }
    } else if (it.type === "dim" && P.length === 2) {
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      arrowHead(ctx, P[0], P[1], 8); arrowHead(ctx, P[1], P[0], 8);
      label(ctx, (P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 - 12, fmtFtIn(dist(it.pts[0], it.pts[1])), "#b3541e", "rgba(255,244,230,.92)");
    } else if (it.type === "text" && P.length === 1) {
      ctx.font = "bold 14px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      var tw = ctx.measureText(it.text || "").width;
      ctx.fillStyle = "rgba(255,255,255,.85)";
      ctx.fillRect(P[0][0] - 4, P[0][1] - 11, tw + 8, 22);
      ctx.fillStyle = it.color || "#111";
      ctx.fillText(it.text || "", P[0][0], P[0][1]);
    } else if (it.type === "post" && P.length === 1) {
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], 7, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], 1.8, 0, 7); ctx.fill();
    } else if (it.type === "circle" && P.length === 2) {
      var rpx = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], rpx, 0, 7);
      if (it.fill) { ctx.save(); ctx.fillStyle = it.fill; ctx.fill(); ctx.restore(); }
      ctx.stroke();
      var rft = dist(it.pts[0], it.pts[1]);
      label(ctx, P[0][0], P[0][1] - 12, "Dia " + fmtFtIn(rft * 2), it.color);
      if (rpx > 34) label(ctx, P[0][0], P[0][1] + 9, (Math.round(Math.PI * rft * rft * 10) / 10) + " SF", "#1f6f4a", "rgba(220,245,232,.9)");
    } else if ((it.type === "door" || it.type === "window") && P.length === 2) {
      var a = P[0], b = P[1];
      var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      var wpx = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // knock a clean opening through the wall beneath the symbol
      ctx.save();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 2;
      var nx = Math.cos(ang - Math.PI / 2), ny = Math.sin(ang - Math.PI / 2);
      // jamb ticks
      [a, b].forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(p[0] + nx * 5, p[1] + ny * 5);
        ctx.lineTo(p[0] - nx * 5, p[1] - ny * 5);
        ctx.stroke();
      });
      if (it.type === "door") {
        ctx.beginPath(); ctx.arc(a[0], a[1], wpx, ang - Math.PI / 2, ang, false); ctx.stroke(); // swing
        ctx.beginPath(); ctx.moveTo(a[0], a[1]);
        ctx.lineTo(a[0] + nx * wpx, a[1] + ny * wpx); ctx.stroke();                              // leaf
      } else {
        [3, -3].forEach(function (o) {
          ctx.beginPath();
          ctx.moveTo(a[0] + nx * o, a[1] + ny * o);
          ctx.lineTo(b[0] + nx * o, b[1] + ny * o);
          ctx.stroke();
        });
      }
      label(ctx, (a[0] + b[0]) / 2 + nx * 16, (a[1] + b[1]) / 2 + ny * 16,
        (it.type === "door" ? "D " : "W ") + fmtFtIn(dist(it.pts[0], it.pts[1])), it.color);
    } else if (it.type === "arc") {
      var ap = arcPoints(it, 48).map(toScreen);
      ctx.beginPath();
      ap.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
      if (it.pts.length >= 3) {
        var mid = ap[Math.floor(ap.length / 2)];
        label(ctx, mid[0], mid[1] - 13, fmtFtIn(itemLength(it)), it.color);
      }
    } else if (it.type === "railing" && P.length >= 2) {
      ctx.beginPath();
      P.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
      // baluster ticks along each run
      ctx.lineWidth = 1.2;
      for (var ri = 1; ri < P.length; ri++) {
        var a3 = P[ri - 1], b3 = P[ri];
        var L3 = Math.hypot(b3[0] - a3[0], b3[1] - a3[1]);
        if (L3 < 6) continue;
        var ux3 = (b3[0] - a3[0]) / L3, uy3 = (b3[1] - a3[1]) / L3;
        var nx3 = -uy3 * 4, ny3 = ux3 * 4;
        for (var d3 = 6; d3 < L3; d3 += 9) {
          ctx.beginPath();
          ctx.moveTo(a3[0] + ux3 * d3 + nx3, a3[1] + uy3 * d3 + ny3);
          ctx.lineTo(a3[0] + ux3 * d3 - nx3, a3[1] + uy3 * d3 - ny3);
          ctx.stroke();
        }
      }
      var lastR = P[P.length - 1];
      label(ctx, lastR[0], lastR[1] - 14, "Railing " + fmtFtIn(itemLength(it)), it.color);
    } else if (it.type === "fascia" && P.length >= 2) {
      // a fascia run is a band on the outside face — draw it heavy so it reads
      // as trim, not another wall, and print its own lineal feet
      ctx.lineWidth = 5;
      ctx.beginPath();
      P.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
      var fa = P[0], fb = P[P.length - 1];
      label(ctx, (fa[0] + fb[0]) / 2, (fa[1] + fb[1]) / 2 - 14,
        "Fascia " + fmtFtIn(itemLength(it)), it.color);
    } else if (it.type === "joist" && P.length === 2) {
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, (P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 - 13,
        fmtFtIn(dist(it.pts[0], it.pts[1])), "#8a7420");
    } else if (it.type === "beam" && P.length === 2) {
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      ctx.save();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      ctx.restore();
      label(ctx, (P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2 - 14,
        "Beam " + fmtFtIn(dist(it.pts[0], it.pts[1])), it.color);
    } else if (it.type === "stairs" && P.length === 2) {
      var wft = it.size || 4;
      var L4 = dist(it.pts[0], it.pts[1]);
      var ux4 = L4 > 1e-6 ? (it.pts[1][0] - it.pts[0][0]) / L4 : 1;
      var uy4 = L4 > 1e-6 ? (it.pts[1][1] - it.pts[0][1]) / L4 : 0;
      var px4 = -uy4 * (wft / 2), py4 = ux4 * (wft / 2);
      var c1 = toScreen([it.pts[0][0] + px4, it.pts[0][1] + py4]);
      var c2 = toScreen([it.pts[1][0] + px4, it.pts[1][1] + py4]);
      var c3 = toScreen([it.pts[1][0] - px4, it.pts[1][1] - py4]);
      var c4 = toScreen([it.pts[0][0] - px4, it.pts[0][1] - py4]);
      ctx.beginPath();
      ctx.moveTo(c1[0], c1[1]); ctx.lineTo(c2[0], c2[1]);
      ctx.lineTo(c3[0], c3[1]); ctx.lineTo(c4[0], c4[1]); ctx.closePath();
      ctx.stroke();
      // treads
      var n4 = treadCount(it);
      ctx.lineWidth = 1.4;
      for (var ti = 1; ti < n4; ti++) {
        var f4 = ti / n4;
        var s1 = toScreen([it.pts[0][0] + (it.pts[1][0] - it.pts[0][0]) * f4 + px4,
                           it.pts[0][1] + (it.pts[1][1] - it.pts[0][1]) * f4 + py4]);
        var s2 = toScreen([it.pts[0][0] + (it.pts[1][0] - it.pts[0][0]) * f4 - px4,
                           it.pts[0][1] + (it.pts[1][1] - it.pts[0][1]) * f4 - py4]);
        ctx.beginPath(); ctx.moveTo(s1[0], s1[1]); ctx.lineTo(s2[0], s2[1]); ctx.stroke();
      }
      label(ctx, (P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2,
        n4 + " treads · " + fmtFtIn(wft) + " wide", it.color);
    } else if (it.type === "gate" && P.length === 2) {
      var ag = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]);
      var wg = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]);
      var ngx = Math.cos(ag - Math.PI / 2), ngy = Math.sin(ag - Math.PI / 2);
      ctx.save();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); ctx.lineTo(P[1][0], P[1][1]); ctx.stroke();
      ctx.restore();
      ctx.lineWidth = 2;
      [P[0], P[1]].forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(p[0] + ngx * 6, p[1] + ngy * 6);
        ctx.lineTo(p[0] - ngx * 6, p[1] - ngy * 6);
        ctx.stroke();
      });
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], wg, ag - Math.PI / 2, ag, false); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]);
      ctx.lineTo(P[0][0] + ngx * wg, P[0][1] + ngy * wg); ctx.stroke();
      label(ctx, (P[0][0] + P[1][0]) / 2 + ngx * 16, (P[0][1] + P[1][1]) / 2 + ngy * 16,
        "G " + fmtFtIn(dist(it.pts[0], it.pts[1])), it.color);
    } else if (it.type === "pillar" && P.length === 1) {
      var sPx = Math.max(6, (it.size || 0.5) * st.ppf);
      ctx.lineWidth = 2;
      ctx.fillStyle = it.color;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(P[0][0] - sPx / 2, P[0][1] - sPx / 2, sPx, sPx);
      ctx.globalAlpha = 1;
      ctx.strokeRect(P[0][0] - sPx / 2, P[0][1] - sPx / 2, sPx, sPx);
      // diagonal cross marks a column
      ctx.beginPath();
      ctx.moveTo(P[0][0] - sPx / 2, P[0][1] - sPx / 2); ctx.lineTo(P[0][0] + sPx / 2, P[0][1] + sPx / 2);
      ctx.moveTo(P[0][0] + sPx / 2, P[0][1] - sPx / 2); ctx.lineTo(P[0][0] - sPx / 2, P[0][1] + sPx / 2);
      ctx.stroke();
    } else if (it.type === "count" && P.length === 1) {
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], 9, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(String(it.seq || 1), P[0][0], P[0][1]);
    }
    ctx.restore();
  }

  // A light wash over exactly the shapes counted as deck surface, so the rep
  // can see WHICH shapes made the number before sending it to the estimate.
  function drawDeckHighlight(ctx) {
    ctx.save();
    ctx.fillStyle = "rgba(47,166,121,0.20)";
    ctx.strokeStyle = "rgba(31,111,74,0.85)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    st.items.forEach(function (it) {
      if (!isDeckShape(it)) return;
      var P = (it.pts || []).map(toScreen);
      ctx.beginPath();
      if (it.type === "rect" && P.length === 2) {
        ctx.rect(Math.min(P[0][0], P[1][0]), Math.min(P[0][1], P[1][1]),
          Math.abs(P[1][0] - P[0][0]), Math.abs(P[1][1] - P[0][1]));
      } else if (it.type === "circle" && P.length === 2) {
        ctx.arc(P[0][0], P[0][1], Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]), 0, 7);
      } else {
        P.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
  }
  function render() {
    var cv = q("#csCanvas"), ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var wpx = cv.width / dpr, hpx = cv.height / dpr;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, wpx, hpx);
    drawGrid(ctx, wpx, hpx);
    if (st.hiDeck) drawDeckHighlight(ctx);
    st.items.forEach(function (it, i) { drawItem(ctx, it, i === st.sel); });
    if (st.draw) drawItem(ctx, st.draw, false);
    // vertex handles on the selection
    if (st.sel >= 0 && st.items[st.sel]) {
      ctx.fillStyle = "#2f80d8";
      (st.items[st.sel].pts || []).forEach(function (p) {
        var s = toScreen(p);
        ctx.beginPath(); ctx.arc(s[0], s[1], 5, 0, 7); ctx.fill();
      });
    }
    updateCtxButtons();
  }
  function updateCtxButtons() {
    var it = st.sel >= 0 ? st.items[st.sel] : null;
    q("#csDelSel").style.display = it ? "" : "none";
    q("#csEditSel").style.display = it && it.type === "text" ? "" : "none";
    var dimBtn = q("#csDimSel");
    if (it && ["line", "dim", "door", "window", "gate", "beam", "joist"].indexOf(it.type) !== -1) {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(dist(it.pts[0], it.pts[1]));
    } else if (it && it.type === "stairs") {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 run " + fmtFtIn(dist(it.pts[0], it.pts[1])) + " × " + fmtFtIn(it.size || 4);
    } else if (it && it.type === "pillar") {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(it.size || 0.5);
    } else if (it && it.type === "rect") {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(Math.abs(it.pts[1][0] - it.pts[0][0])) + " × " + fmtFtIn(Math.abs(it.pts[1][1] - it.pts[0][1]));
    } else if (it && it.type === "circle") {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 Dia " + fmtFtIn(dist(it.pts[0], it.pts[1]) * 2);
    } else {
      dimBtn.style.display = "none";
    }
    var tagBtn = q("#csTagSel");
    if (it && it.type !== "text") {
      tagBtn.style.display = "";
      tagBtn.textContent = "🏷 " + (it.takeoff || defaultLabel(it));
    } else tagBtn.style.display = "none";
    if (q("#csPanel").classList.contains("open")) renderPanel();
  }

  /* ── type an exact dimension for the selection ── */
  function splitFtIn(feet) {
    var ft = Math.floor(feet + 1e-9);
    return [ft, Math.round((feet - ft) * 12 * 2) / 2];
  }
  function openDimPrompt() {
    var it = st.sel >= 0 ? st.items[st.sel] : null;
    if (!it) return;
    var isRect = it.type === "rect", isCircle = it.type === "circle";
    var isStairs = it.type === "stairs", isPillar = it.type === "pillar";
    if (!isRect && !isCircle && !isStairs && !isPillar &&
        ["line", "dim", "door", "window", "gate", "beam", "joist"].indexOf(it.type) === -1) return;
    var twoRow = isRect || isStairs;
    q("#csPromptText").style.display = "none";
    q("#csPromptDims").style.display = "";
    q("#csDimRowB").style.display = twoRow ? "flex" : "none";
    q("#csDimLabelA").textContent =
      (isRect ? "Width" : isCircle ? "Diameter" : isStairs ? "Run length" : isPillar ? "Size" : "Length") + " — feet";
    var a = isRect ? splitFtIn(Math.abs(it.pts[1][0] - it.pts[0][0]))
      : isCircle ? splitFtIn(dist(it.pts[0], it.pts[1]) * 2)
      : isPillar ? splitFtIn(it.size || 0.5)
      : splitFtIn(dist(it.pts[0], it.pts[1]));
    q("#csDimAft").value = a[0]; q("#csDimAin").value = a[1];
    if (isRect) {
      var b = splitFtIn(Math.abs(it.pts[1][1] - it.pts[0][1]));
      q("#csDimBft").value = b[0]; q("#csDimBin").value = b[1];
    }
    if (twoRow) {
      var bFeet = isStairs ? (it.size || 4) : Math.abs(it.pts[1][1] - it.pts[0][1]);
      var bb = splitFtIn(bFeet);
      q("#csDimBft").value = bb[0]; q("#csDimBin").value = bb[1];
      q("#csDimRowB").querySelector("label").textContent = (isStairs ? "Width" : "Height") + " — feet";
    }
    openPromptRaw(isRect ? "📐 Exact size (width × height)"
      : isStairs ? "📐 Exact stairs (run × width)"
      : isCircle ? "📐 Exact diameter"
      : isPillar ? "📐 Exact pillar size" : "📐 Exact length", function () {
      var lenA = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      if (!(lenA > 0)) return;
      snapshot();
      if (isPillar) { it.size = lenA; render(); return; }
      if (isStairs) {
        var wid = (Number(q("#csDimBft").value) || 0) + (Number(q("#csDimBin").value) || 0) / 12;
        if (wid > 0) it.size = wid;
        var curS = dist(it.pts[0], it.pts[1]);
        if (curS < 1e-6) it.pts[1] = [it.pts[0][0] + lenA, it.pts[0][1]];
        else {
          var fS = lenA / curS;
          it.pts[1] = [it.pts[0][0] + (it.pts[1][0] - it.pts[0][0]) * fS,
                       it.pts[0][1] + (it.pts[1][1] - it.pts[0][1]) * fS];
        }
        render();
        return;
      }
      if (isCircle) {
        var cur0 = dist(it.pts[0], it.pts[1]);
        var ux = cur0 > 1e-6 ? (it.pts[1][0] - it.pts[0][0]) / cur0 : 1;
        var uy = cur0 > 1e-6 ? (it.pts[1][1] - it.pts[0][1]) / cur0 : 0;
        it.pts[1] = [it.pts[0][0] + ux * (lenA / 2), it.pts[0][1] + uy * (lenA / 2)];
        render();
        return;
      }
      if (isRect) {
        var lenB = (Number(q("#csDimBft").value) || 0) + (Number(q("#csDimBin").value) || 0) / 12;
        if (!(lenB > 0)) return;
        // keep the first-drawn corner anchored; preserve the rectangle's direction
        var sx = it.pts[1][0] >= it.pts[0][0] ? 1 : -1;
        var sy = it.pts[1][1] >= it.pts[0][1] ? 1 : -1;
        it.pts[1] = [it.pts[0][0] + sx * lenA, it.pts[0][1] + sy * lenB];
      } else {
        // keep the start point anchored; extend along the current direction
        var cur = dist(it.pts[0], it.pts[1]);
        if (cur < 1e-6) { it.pts[1] = [it.pts[0][0] + lenA, it.pts[0][1]]; }
        else {
          var f = lenA / cur;
          it.pts[1] = [it.pts[0][0] + (it.pts[1][0] - it.pts[0][0]) * f,
                       it.pts[0][1] + (it.pts[1][1] - it.pts[0][1]) * f];
        }
      }
      render();
    });
    setTimeout(function () { q("#csDimAft").focus(); q("#csDimAft").select(); }, 60);
  }

  /* ── history ── */
  function snapshot() {
    st.undo.push(JSON.stringify(st.items));
    if (st.undo.length > 80) st.undo.shift();
    st.redo = [];
    st.dirty = true;
  }
  function doUndo() { if (st.undo.length) { st.redo.push(JSON.stringify(st.items)); st.items = JSON.parse(st.undo.pop()); st.sel = -1; render(); } }
  function doRedo() { if (st.redo.length) { st.undo.push(JSON.stringify(st.items)); st.items = JSON.parse(st.redo.pop()); st.sel = -1; render(); } }

  /* ── hit testing ── */
  function hitTest(w) {
    var th = 10 / st.ppf;
    for (var i = st.items.length - 1; i >= 0; i--) {
      var it = st.items[i], pts = it.pts;
      if (it.type === "text") { if (dist(w, pts[0]) < Math.max(th * 3, (it.text || "").length * 4 / st.ppf)) return i; continue; }
      if (it.type === "post" || it.type === "count") { if (dist(w, pts[0]) < th * 2) return i; continue; }
      if (it.type === "pillar") { if (dist(w, pts[0]) < Math.max(th * 1.5, (it.size || 0.5))) return i; continue; }
      if (it.type === "stairs" && pts.length === 2) {
        // anywhere within the run's footprint
        var wf = (it.size || 4) / 2;
        if (ptSeg(w, pts[0], pts[1]) < Math.max(th, wf)) return i;
        continue;
      }
      if (it.type === "circle" && pts.length === 2) {
        // the ring itself, or anywhere inside once it's filled
        var rr = dist(pts[0], pts[1]);
        var dc = dist(w, pts[0]);
        if (Math.abs(dc - rr) < th || dc < (it.fill ? rr : Math.min(rr, th * 2))) return i;
        continue;
      }
      if (it.type === "rect" && pts.length === 2) {
        var edges = segmentsOf(it);
        for (var c = 0; c < edges.length; c++) if (ptSeg(w, edges[c][0], edges[c][1]) < th) return i;
        // filled decks are solid objects — tapping inside picks them up
        if (it.fill &&
            w[0] > Math.min(pts[0][0], pts[1][0]) && w[0] < Math.max(pts[0][0], pts[1][0]) &&
            w[1] > Math.min(pts[0][1], pts[1][1]) && w[1] < Math.max(pts[0][1], pts[1][1])) return i;
        continue;
      }
      if (it.type === "poly" && it.closed && it.fill && pts.length >= 3 && pointInPoly(w, pts)) return i;
      var segs = segmentsOf(it);
      for (var s = 0; s < segs.length; s++) if (ptSeg(w, segs[s][0], segs[s][1]) < th) return i;
    }
    return -1;
  }
  function grabVertex(it, w) {
    var th = 14 / st.ppf;
    for (var i = 0; i < it.pts.length; i++) if (dist(w, it.pts[i]) < th) return i;
    return -1;
  }

  /* ── takeoff: areas (SF), lineal (LF), counts (each) ──
     Every item carries an optional `takeoff` label; totals group by it so the
     sketch doubles as the material takeoff. Closed shapes contribute their area
     AND their perimeter (railing/fascia), listed separately. */
  function defaultLabel(it) {
    if (it.type === "rect" || it.type === "circle" || (it.type === "poly" && it.closed)) return "Deck area";
    if (it.type === "line" || it.type === "poly" || it.type === "arc") return "Lineal";
    if (it.type === "railing") return "Railing";
    if (it.type === "fascia") return "Fascia";
    if (it.type === "beam") return "Beams";
    if (it.type === "joist") return "Joists";
    if (it.type === "stairs") return "Stairs";
    if (it.type === "gate") return "Gates";
    if (it.type === "pillar") return "Pillars";
    if (it.type === "dim") return "Dimension";
    if (it.type === "post") return "Posts";
    if (it.type === "door") return "Doors";
    if (it.type === "window") return "Windows";
    return "Count";
  }
  function areaOf(it) {
    if (it.type === "rect") return Math.abs(it.pts[1][0] - it.pts[0][0]) * Math.abs(it.pts[1][1] - it.pts[0][1]);
    if (it.type === "circle") { var r = dist(it.pts[0], it.pts[1]); return Math.PI * r * r; }
    if (it.type === "poly" && it.closed && it.pts.length >= 3) return polyArea(it.pts);
    return 0;
  }
  /* ── 🧾 preliminary framing material list ───────────────────────────────
     Sizes a framer actually orders, grouped the way a lumber yard quotes.
     The list starts from what is ON the drawing (joists arrayed, beams drawn,
     posts dropped, deck SF, railing and fascia LF) and stays fully editable —
     it is a PRELIMINARY list, so every line can be typed over. */
  var MAT_PRESETS = [
    { g: "Joists / rim", s: ["2x6x8", "2x6x10", "2x6x12", "2x6x16", "2x8x10", "2x8x12", "2x8x16", "2x8x20", "2x10x12", "2x10x16", "2x10x20", "2x12x16", "2x12x20"] },
    { g: "Beams", s: ["4x6x8", "4x6x10", "4x6x12", "4x8x10", "4x8x12", "4x8x16", "6x6x10", "6x6x12", "(2) 2x10x16 built-up", "(3) 2x12x16 built-up"] },
    { g: "Posts", s: ["4x4x8", "4x4x10", "6x6x8", "6x6x10", "6x6x12"] },
    { g: "Ledger / blocking", s: ["2x8x16 ledger", "2x10x16 ledger", "2x6 blocking", "2x8 blocking", "2x10 blocking"] },
    { g: "Decking / fascia", s: ["5/4x6x12 decking", "5/4x6x16 decking", "2x6x16 decking", "1x8x16 fascia", "1x12x16 fascia"] },
    { g: "Railing", s: ["4x4x4 rail post", "2x4x8 rail", "2x6x8 cap rail", "Baluster 36\"", "Post base / anchor"] },
    { g: "Hardware / concrete", s: ["Joist hanger", "Hurricane tie", "Ledger screw", "Post base", "Carriage bolt 1/2x6",
      "3\" deck screw (5lb)", "16d nail (5lb)", "Concrete 60lb bag", "Footing tube 12\""] },
  ];
  var MAT_KEY = "dcrCadMatPresets";     // the user's own additions, across drawings
  function customPresets() {
    try { return JSON.parse(localStorage.getItem(MAT_KEY) || "[]") || []; } catch (e) { return []; }
  }
  function addCustomPreset(name) {
    var list = customPresets();
    if (list.indexOf(name) !== -1) return;
    list.unshift(name);
    try { localStorage.setItem(MAT_KEY, JSON.stringify(list.slice(0, 60))); } catch (e) {}
  }
  // A first cut straight off the drawing. Every line is editable — this is the
  // estimator's starting point, not a bill of materials.
  function suggestedMaterials() {
    var n = deckNumbers(), out = [], byType = {};
    st.items.forEach(function (it) {
      byType[it.type] = (byType[it.type] || 0) + 1;
    });
    function push(name, qty, unit, note) {
      if (qty > 0) out.push({ name: name, qty: Math.ceil(qty * 10) / 10, unit: unit || "ea", note: note || "", from: "drawing" });
    }
    if (byType.joist) push("Joist (size to span)", byType.joist, "ea", byType.joist + " drawn");
    if (byType.beam) push("Beam (size to span)", byType.beam, "ea", byType.beam + " drawn");
    if (byType.post) push("4x4x8 post", byType.post, "ea", byType.post + " posts drawn");
    if (byType.post) push("Post base / anchor", byType.post, "ea", "one per post");
    if (byType.post) push("Concrete 60lb bag", byType.post * 3, "ea", "≈3 bags per footing");
    if (byType.pillar) push("6x6 pillar", byType.pillar, "ea", "");
    if (byType.joist) push("Joist hanger", byType.joist * 2, "ea", "both ends");
    if (n.deckSF > 0) {
      // 5/4x6 covers 5.5" net → 2.18 LF of board per SF, +10% waste
      push("Decking board (5/4x6)", n.deckSF * 2.18 * 1.1, "LF", n.deckSF + " SF +10% waste");
      push("3\" deck screw (5lb)", Math.ceil(n.deckSF / 100), "box", "≈1 box per 100 SF");
    }
    if (n.fasciaLF > 0) push("Fascia board (1x8)", n.fasciaLF * 1.05, "LF", n.fasciaLF + " LF +5%");
    if (n.railLF > 0) {
      push("Rail post (4x4)", Math.floor(n.railLF / 6) + 1, "ea", "≈6' o.c.");
      push("Rail (2x4)", n.railLF * 2, "LF", "top and bottom");
      push("Baluster", Math.ceil(n.railLF * 12 / 4.5), "ea", "4\" gap max");
    }
    if (n.stairs > 0) push("Stair stringer (2x12)", n.stairs * 3, "ea", n.stairs + " flight(s), 3 stringers each");
    return out;
  }
  function matList() {
    if (!st.mats) st.mats = suggestedMaterials();
    return st.mats;
  }
  function renderMaterials() {
    var rows = matList();
    var groups = MAT_PRESETS.map(function (g) {
      return '<div class="cs-grp">' + g.g + "</div><div style='display:flex;flex-wrap:wrap;gap:5px'>" +
        g.s.map(function (s) { return '<button class="cs-chip" data-mat="' + DCR.esc(s) + '">' + DCR.esc(s) + "</button>"; }).join("") +
        "</div>";
    }).join("");
    var mine = customPresets();
    if (mine.length) {
      groups = '<div class="cs-grp">Mine</div><div style="display:flex;flex-wrap:wrap;gap:5px">' +
        mine.map(function (s) { return '<button class="cs-chip" data-mat="' + DCR.esc(s) + '">' + DCR.esc(s) + "</button>"; }).join("") +
        "</div>" + groups;
    }
    var listHtml = rows.length
      ? rows.map(function (r, i) {
          return '<div class="cs-row" style="align-items:center">' +
            '<span style="flex:1;min-width:0"><input class="cs-mname" data-i="' + i + '" value="' + DCR.esc(r.name) +
              '" style="width:100%;border:none;background:transparent;font:inherit;color:inherit;padding:0">' +
              (r.note ? '<span style="display:block;font-size:10.5px;color:#8a97a6">' + DCR.esc(r.note) + "</span>" : "") +
            "</span>" +
            '<span style="display:flex;gap:4px;align-items:center">' +
              '<input class="cs-mqty" data-i="' + i + '" type="number" min="0" step="0.1" value="' + r.qty +
                '" style="width:62px;text-align:right">' +
              '<span style="width:26px;font-size:11px;color:#5a6b7d">' + DCR.esc(r.unit) + "</span>" +
              '<button class="cs-chip cs-mdel" data-i="' + i + '" style="padding:2px 7px">✕</button>' +
            "</span></div>";
        }).join("")
      : '<p style="color:#5a6b7d">Nothing yet — tap a size below, or draw the framing and tap ↻ to read it off the plan.</p>';

    q("#csPanelBody").innerHTML =
      '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
        '<button class="cs-btn" id="csMatRefresh" style="padding:4px 9px">↻ From drawing</button>' +
        '<button class="cs-btn" id="csMatAdd" style="padding:4px 9px">＋ Other…</button>' +
        '<button class="cs-btn" id="csMatCopy" style="padding:4px 9px">📋 Copy list</button>' +
      "</div>" + listHtml +
      '<div class="cs-grp" style="margin-top:14px">Add a size — tap to add one</div>' + groups;

    q("#csPanelBody").querySelectorAll("[data-mat]").forEach(function (b) {
      b.onclick = function () { addMat(b.getAttribute("data-mat")); };
    });
    q("#csPanelBody").querySelectorAll(".cs-mqty").forEach(function (inp) {
      inp.onchange = function () { matList()[+inp.dataset.i].qty = Number(inp.value) || 0; };
    });
    q("#csPanelBody").querySelectorAll(".cs-mname").forEach(function (inp) {
      inp.onchange = function () { matList()[+inp.dataset.i].name = inp.value; };
    });
    q("#csPanelBody").querySelectorAll(".cs-mdel").forEach(function (b) {
      b.onclick = function () { matList().splice(+b.dataset.i, 1); st.dirty = true; renderMaterials(); };
    });
    q("#csMatRefresh").onclick = function () {
      var keep = matList().filter(function (r) { return r.from !== "drawing"; });
      st.mats = suggestedMaterials().concat(keep);
      st.dirty = true;
      renderMaterials();
      q("#csHint").textContent = "↻ Re-read the framing off the drawing — your own lines were kept.";
    };
    q("#csMatAdd").onclick = function () {
      openPrompt("＋ Material", function () {
        var v = q("#csPromptInput").value.trim();
        if (!v) return;
        addCustomPreset(v);
        addMat(v);
      }, "", ["2x6x12", "4x6x8", "4x4x8", "2x8x16", "6x6x10"]);
    };
    q("#csMatCopy").onclick = function () {
      var txt = matList().map(function (r) { return r.qty + "\t" + r.unit + "\t" + r.name; }).join("\n");
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () {});
      q("#csHint").textContent = "✓ Material list copied — paste into the order or a spreadsheet.";
    };
  }
  function addMat(name) {
    var list = matList();
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name) { list[i].qty += 1; st.dirty = true; renderMaterials(); return; }
    }
    list.push({ name: name, qty: 1, unit: "ea", note: "", from: "manual" });
    st.dirty = true;
    renderMaterials();
  }

  /* ── the three numbers the estimate actually runs on ──────────────────
     Deck area, railing LF and fascia LF, read straight off the drawing so a
     rep never re-measures on the tablet. An item's takeoff label wins over its
     type, so a rectangle tagged "Landing" still counts as deck surface unless
     it is tagged something that clearly isn't (Roof, House…). */
  function isDeckShape(it) {
    if (areaOf(it) <= 0) return false;
    var lbl = String(it.takeoff || defaultLabel(it)).toLowerCase();
    return /deck|decking|landing|surface|platform|patio/.test(lbl);
  }
  function deckNumbers() {
    var deckSF = 0, railLF = 0, fasciaLF = 0, stairs = 0, deckShapes = [];
    st.items.forEach(function (it, i) {
      var lbl = String(it.takeoff || defaultLabel(it)).toLowerCase();
      if (isDeckShape(it)) { deckSF += areaOf(it); deckShapes.push(i); }
      if (it.type === "railing" || /railing|guard/.test(lbl)) {
        if (it.type !== "gate" && areaOf(it) <= 0) railLF += itemLength(it);
      }
      if (it.type === "fascia" || (/fascia|rim board|skirt/.test(lbl) && areaOf(it) <= 0)) {
        fasciaLF += itemLength(it);
      }
      if (it.type === "stairs") stairs++;
    });
    // a gate is an opening in the run — it doesn't get railing
    st.items.forEach(function (it) {
      if (it.type === "gate") railLF -= itemLength(it);
    });
    var r1 = function (n) { return Math.round(Math.max(0, n) * 10) / 10; };
    return { deckSF: r1(deckSF), railLF: r1(railLF), fasciaLF: r1(fasciaLF),
      stairs: stairs, deckShapes: deckShapes };
  }
  function takeoffData() {
    var areas = {}, lineals = {}, counts = {};
    function add(bag, key, val) {
      if (!bag[key]) bag[key] = { qty: 0, n: 0 };
      bag[key].qty += val;
      bag[key].n++;
    }
    st.items.forEach(function (it) {
      var lbl = it.takeoff || defaultLabel(it);
      var a = areaOf(it);
      if (a > 0) {
        add(areas, lbl, a);
        // ALL sides, including the one against the house — it is not the
        // fascia or railing number, and saying so stops it being ordered
        add(lineals, lbl + " perimeter (all sides)", itemLength(it));
      } else if (["line", "poly", "dim", "arc", "railing", "fascia", "beam", "joist"].indexOf(it.type) !== -1) {
        add(lineals, lbl, itemLength(it));
      } else if (it.type === "stairs") {
        add(counts, lbl, 1);
        // tread material: width × number of treads
        add(lineals, lbl + " treads", (it.size || 4) * treadCount(it));
      } else if (["post", "count", "door", "window", "gate", "pillar"].indexOf(it.type) !== -1) {
        add(counts, lbl, 1);
      }
    });
    function rows(bag) {
      return Object.keys(bag).sort().map(function (k) {
        return { label: k, qty: Math.round(bag[k].qty * 10) / 10, n: bag[k].n };
      });
    }
    return { areas: rows(areas), lineals: rows(lineals), counts: rows(counts) };
  }
  function renderPanel() {
    if (st.panelTab === "mats") renderMaterials(); else renderTakeoff();
  }
  function renderTakeoff() {
    var t = takeoffData();
    var n = deckNumbers();
    // The estimate runs on three numbers. Put them at the top, show which
    // shapes made the area, and let the rep push them into step 1 in one tap.
    var html =
      '<div class="cs-grp">For the estimate</div>' +
      '<div class="cs-row"><span>Deck area' +
        (n.deckShapes.length > 1 ? " (" + n.deckShapes.length + " shapes)" : "") +
        '</span><b>' + n.deckSF + " SF</b></div>" +
      '<div class="cs-row"><span>Railing</span><b>' + n.railLF + " LF</b></div>" +
      '<div class="cs-row"><span>Fascia</span><b>' + n.fasciaLF + " LF</b></div>" +
      (n.stairs ? '<div class="cs-row"><span>Stairs</span><b>' + n.stairs + "</b></div>" : "") +
      '<div style="display:flex;gap:6px;margin:8px 0 2px;flex-wrap:wrap">' +
        '<button class="cs-btn' + (st.hiDeck ? " primary" : "") + '" id="csHiDeck" style="padding:4px 9px">' +
          (st.hiDeck ? "◼ Area shown" : "◻ Show deck area") + "</button>" +
        (st.onNumbers
          ? '<button class="cs-btn primary" id="csUseNums" style="padding:4px 9px">→ Send to estimate</button>'
          : "") +
      "</div>" +
      (n.deckSF <= 0
        ? '<div style="color:#8a6d3b;font-size:11.5px;margin-bottom:6px">No deck surface yet — draw the deck with the ▭ or ⬠ tool.</div>'
        : "");
    function block(title, rows, unit) {
      if (!rows.length) return "";
      var tot = rows.reduce(function (s, r) { return s + r.qty; }, 0);
      var h = '<div class="cs-grp">' + title + "</div>";
      h += rows.map(function (r) {
        return '<div class="cs-row"><span>' + DCR.esc(r.label) + (r.n > 1 ? " ×" + r.n : "") +
          "</span><b>" + (Math.round(r.qty * 10) / 10) + " " + unit + "</b></div>";
      }).join("");
      if (rows.length > 1) h += '<div class="cs-tot"><span>Total</span><span>' + (Math.round(tot * 10) / 10) + " " + unit + "</span></div>";
      return h;
    }
    html += block("Areas", t.areas, "SF");
    html += block("Lineal", t.lineals, "LF");
    html += block("Counts", t.counts, "ea");
    if (!st.items.length) {
      html += '<p style="color:#5a6b7d">Draw shapes and drop markers — areas, lineal feet and counts total up here. Select an item and tap 🏷 to name it (Decking, Railing, Posts…).</p>';
    }
    q("#csPanelBody").innerHTML = html;
    var hi = q("#csHiDeck");
    if (hi) hi.onclick = function () { st.hiDeck = !st.hiDeck; render(); renderTakeoff(); };
    var use = q("#csUseNums");
    if (use) use.onclick = function () {
      var d = deckNumbers();
      st.onNumbers({ deckSF: d.deckSF, railLF: d.railLF, fasciaLF: d.fasciaLF, stairs: d.stairs });
      q("#csHint").textContent = "✓ Sent to the estimate — " + d.deckSF + " SF deck, " +
        d.railLF + " LF railing" + (d.fasciaLF ? ", " + d.fasciaLF + " LF fascia" : "") + ".";
    };
  }
  function takeoffText() {
    var t = takeoffData(), lines = [];
    t.areas.forEach(function (r) { lines.push("Area\t" + r.label + "\t" + r.qty + "\tSF"); });
    t.lineals.forEach(function (r) { lines.push("Lineal\t" + r.label + "\t" + r.qty + "\tLF"); });
    t.counts.forEach(function (r) { lines.push("Count\t" + r.label + "\t" + r.qty + "\tea"); });
    return lines.join("\n");
  }

  /* ── prompt ── */
  var promptCb = null;
  function openPromptRaw(title, cb) {
    promptCb = cb;
    q("#csPromptTitle").textContent = title;
    q("#csPrompt").classList.add("open");
  }
  function openPrompt(title, cb, prefill, chips) {
    q("#csPromptText").style.display = "";
    q("#csPromptDims").style.display = "none";
    q("#csPromptInput").value = prefill || "";
    var box = q("#csPromptChips");
    if (chips && chips.length) {
      box.style.display = "flex";
      box.innerHTML = chips.map(function (c) { return '<button type="button" class="cs-chip">' + DCR.esc(c) + "</button>"; }).join("");
      box.querySelectorAll(".cs-chip").forEach(function (b) {
        b.onclick = function () { q("#csPromptInput").value = b.textContent; };
      });
    } else { box.style.display = "none"; box.innerHTML = ""; }
    openPromptRaw(title, cb);
    setTimeout(function () { q("#csPromptInput").focus(); }, 60);
  }
  // Single feet+inches entry (opening sizes, etc.)
  function openFtInPrompt(title, labelA, feet, cb) {
    q("#csPromptText").style.display = "none";
    q("#csPromptDims").style.display = "";
    q("#csDimRowB").style.display = "none";
    q("#csDimLabelA").textContent = labelA + " — feet";
    var a = splitFtIn(feet);
    q("#csDimAft").value = a[0]; q("#csDimAin").value = a[1];
    openPromptRaw(title, function () {
      var v = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      if (v > 0) cb(v);
    });
    setTimeout(function () { q("#csDimAft").focus(); q("#csDimAft").select(); }, 60);
  }
  function closePrompt() { q("#csPrompt").classList.remove("open"); promptCb = null; }

  /* ── ✂ trim / extend ────────────────────────────────────────────────────
     Pick the line to fix, then the line it should meet. We move whichever END
     of the first line is nearer the crossing point onto that point — one rule
     that trims a long line back and stretches a short one out. */
  var TRIMMABLE = ["line", "poly", "railing", "fascia", "beam", "joist", "dim"];
  // which segment of which item did the tap land on
  function pickSegment(w) {
    var best = null, bd = 14 / st.ppf;
    st.items.forEach(function (it, i) {
      if (TRIMMABLE.indexOf(it.type) === -1) return;
      segmentsOf(it).forEach(function (s, si) {
        var d = ptSeg(w, s[0], s[1]);
        if (d < bd) { bd = d; best = { idx: i, seg: si, a: s[0], b: s[1] }; }
      });
    });
    return best;
  }
  // infinite-line intersection; null when they're parallel
  function lineCross(p1, p2, p3, p4) {
    var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    var x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
    var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    var a = x1 * y2 - y1 * x2, b = x3 * y4 - y3 * x4;
    return [(a * (x3 - x4) - (x1 - x2) * b) / den, (a * (y3 - y4) - (y1 - y2) * b) / den];
  }
  function trimPick(w) {
    var hit = pickSegment(w);
    if (!hit) {
      q("#csHint").textContent = st.trimFirst
        ? "Tap the line it should meet (a line, railing, beam or joist)."
        : "Tap a line to fix — lines, railings, beams and joists can be trimmed.";
      return;
    }
    if (!st.trimFirst) {
      var it0 = st.items[hit.idx];
      if (it0.type === "rect" || it0.type === "circle") {
        q("#csHint").textContent = "A rectangle can't be trimmed — redraw it as an outline (⬠) first.";
        return;
      }
      st.trimFirst = hit;
      st.sel = hit.idx;
      q("#csHint").textContent = "✂ 2 of 2 — now tap the line it should meet.";
      render();
      return;
    }
    if (hit.idx === st.trimFirst.idx && hit.seg === st.trimFirst.seg) {
      q("#csHint").textContent = "Pick a DIFFERENT line for it to meet.";
      return;
    }
    var f = st.trimFirst, x = lineCross(f.a, f.b, hit.a, hit.b);
    if (!x) {
      st.trimFirst = null;
      q("#csHint").textContent = "Those two lines are parallel — they never meet. Start again.";
      render();
      return;
    }
    var it = st.items[f.idx];
    // f.a / f.b are copies; find which stored point they came from
    var ia = nearestPtIndex(it, f.a), ib = nearestPtIndex(it, f.b);
    var moveIdx = dist(f.a, x) <= dist(f.b, x) ? ia : ib;
    if (moveIdx < 0) {
      st.trimFirst = null;
      q("#csHint").textContent = "That edge can't be moved on its own.";
      render();
      return;
    }
    snapshot();
    var was = it.pts[moveIdx].slice();
    it.pts[moveIdx] = [x[0], x[1]];
    st.trimFirst = null;
    var grew = dist(was, x) ;
    q("#csHint").textContent = "✓ " + (dist(f.a, f.b) < dist(it.pts[ia] || f.a, it.pts[ib] || f.b) ? "Extended" : "Trimmed") +
      " to the crossing — moved " + fmtFtIn(grew) + ". Now " + fmtFtIn(itemLength(it)) + " total.";
    render();
  }
  function nearestPtIndex(it, p) {
    var best = -1, bd = 1e-6;
    (it.pts || []).forEach(function (q2, i) {
      var d = dist(q2, p);
      if (best < 0 || d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /* ── ⧉ linear array ─────────────────────────────────────────────────────
     The joist feature: repeat the selected item at a real on-centre spacing.
     Copies carry the source's takeoff label, so the count and lineal feet fall
     straight into the takeoff with no extra bookkeeping. */
  var OC_CHIPS = [12, 16, 19.2, 24];
  function openArrayPrompt(w) {
    if (st.sel < 0 && w) {
      var hi = hitTest(w);
      if (hi >= 0) { st.sel = hi; render(); }
    }
    var src = st.sel >= 0 ? st.items[st.sel] : null;
    if (!src) { q("#csHint").textContent = "Tap the item you want to repeat first, then tap ⧉."; return; }
    if (!src.pts || !src.pts.length) { q("#csHint").textContent = "That item can't be arrayed."; return; }
    var body = q("#csPromptText"), dims = q("#csPromptDims");
    body.style.display = "none";
    dims.style.display = "";
    q("#csDimRowB").style.display = "none";
    q("#csDimLabelA").textContent = "Spacing on centre — feet";
    var sp = st.arraySpacing || 16 / 12;
    q("#csDimAft").value = Math.floor(sp);
    q("#csDimAin").value = Math.round((sp - Math.floor(sp)) * 12 * 10) / 10;
    // an extra row for the count + the o.c. chips framers actually use
    var extra = document.createElement("div");
    extra.id = "csArrExtra";
    extra.style.marginTop = "8px";
    extra.innerHTML =
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">' +
      OC_CHIPS.map(function (n) {
        return '<button type="button" class="cs-chip" data-oc="' + n + '">' + n + '" o.c.</button>';
      }).join("") + "</div>" +
      '<div style="display:flex;gap:8px;align-items:end">' +
      '<div style="flex:1"><label style="font-size:11px;color:#93a1b1">How many copies</label>' +
      '<input id="csArrN" type="number" min="1" max="200" step="1" inputmode="numeric" value="' + (st.arrayN || 8) + '"></div>' +
      '<div style="flex:1"><label style="font-size:11px;color:#93a1b1">Direction</label>' +
      '<select id="csArrDir"><option value="perp">Across (perpendicular)</option>' +
      '<option value="along">Along its own line</option></select></div></div>' +
      '<div id="csArrNote" style="font-size:11px;color:#93a1b1;margin-top:6px"></div>';
    dims.appendChild(extra);
    function note() {
      var n = Math.max(1, Math.min(200, Number(q("#csArrN").value) || 1));
      var s = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      q("#csArrNote").textContent = s > 0
        ? n + " copies at " + fmtFtIn(s) + " o.c. spans " + fmtFtIn(n * s) + "."
        : "Set a spacing greater than zero.";
    }
    extra.querySelectorAll("[data-oc]").forEach(function (b) {
      b.onclick = function () {
        var inch = Number(b.dataset.oc);
        q("#csDimAft").value = Math.floor(inch / 12);
        q("#csDimAin").value = Math.round((inch % 12) * 10) / 10;
        note();
      };
    });
    ["csArrN", "csDimAft", "csDimAin"].forEach(function (id) {
      q("#" + id).addEventListener("input", note);
    });
    note();
    openPromptRaw("⧉ Array — repeat " + defaultLabel(src).toLowerCase(), function () {
      var n = Math.max(1, Math.min(200, Number(q("#csArrN").value) || 1));
      var s = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      var dir = q("#csArrDir").value;
      cleanupArray();
      if (!(s > 0)) { q("#csHint").textContent = "Array needs a spacing greater than zero."; return; }
      runArray(src, n, s, dir);
    });
    // the shared OK handler closes the prompt; make sure our extra row goes too
    var cancel = q("#csPromptCancel");
    cancel.addEventListener("click", cleanupArray, { once: true });
  }
  function cleanupArray() {
    var e = q("#csArrExtra");
    if (e && e.parentNode) e.parentNode.removeChild(e);
    q("#csPromptText").style.display = "";
    q("#csPromptDims").style.display = "none";
  }
  function runArray(src, n, spacing, dir) {
    // direction: across the item (joists off a beam) or along its own run
    var p0 = src.pts[0], p1 = src.pts[src.pts.length - 1];
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    var L = Math.hypot(dx, dy);
    var ux, uy;
    if (L < 1e-6) { ux = 1; uy = 0; }                       // a point: array sideways
    else if (dir === "along") { ux = dx / L; uy = dy / L; }
    else { ux = -dy / L; uy = dx / L; }                     // perpendicular
    st.arraySpacing = spacing; st.arrayN = n;
    snapshot();                                             // ONE snapshot for the batch
    for (var i = 1; i <= n; i++) {
      var c = JSON.parse(JSON.stringify(src));
      c.pts = c.pts.map(function (p) { return [p[0] + ux * spacing * i, p[1] + uy * spacing * i]; });
      delete c.seq;
      st.items.push(c);
    }
    st.sel = -1;
    render();
    q("#csHint").textContent = "✓ " + n + " copies at " + fmtFtIn(spacing) + " o.c. — " +
      (n + 1) + " total, " + fmtFtIn(n * spacing) + " across.";
  }

  /* ── pointers (draw / select / pan / pinch) ── */
  function onDown(e) {
    if (!st) return;
    st.pointers[e.pointerId] = e;
    var ids = Object.keys(st.pointers);
    if (ids.length === 2) {
      var a = st.pointers[ids[0]], b = st.pointers[ids[1]];
      st.pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        mid: [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2],
        ppf: st.ppf, offX: st.offX, offY: st.offY,
        w: toWorld((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2) };
      st.drag = null;
      return;
    }
    try { q("#csCanvas").setPointerCapture(e.pointerId); } catch (e2) {}
    var raw = toWorld(e.clientX, e.clientY);
    var t = st.tool;
    if (t === "pan") { st.drag = { mode: "pan", x: e.clientX, y: e.clientY, offX: st.offX, offY: st.offY }; return; }
    if (t === "select") {
      var hi = hitTest(raw);
      if (hi >= 0) {
        st.sel = hi;
        var it = st.items[hi];
        st.drag = { mode: "move", idx: hi, vertex: grabVertex(it, raw), start: raw,
          orig: JSON.parse(JSON.stringify(it.pts)), before: JSON.stringify(st.items), moved: false };
      } else { st.sel = -1; st.drag = { mode: "pan", x: e.clientX, y: e.clientY, offX: st.offX, offY: st.offY }; }
      render();
      return;
    }
    if (t === "erase") {
      var hi2 = hitTest(raw);
      if (hi2 >= 0) { snapshot(); st.items.splice(hi2, 1); st.sel = -1; render(); }
      st.drag = { mode: "erase" };
      return;
    }
    var w = snapPoint(raw);
    if (t === "text") {
      openPrompt("📝 Text label", function () {
        var v = q("#csPromptInput").value.trim();
        if (v) { snapshot(); st.items.push({ type: "text", pts: [w], color: itemColor("text"), text: v }); render(); }
      });
      return;
    }
    if (t === "post") { snapshot(); st.items.push({ type: "post", pts: [w], color: itemColor("post"), takeoff: "Posts" }); render(); return; }
    if (t === "count") {
      var lbl = st.countLabel || "Count";
      var seq = st.items.filter(function (x) { return x.type === "count" && (x.takeoff || "Count") === lbl; }).length + 1;
      snapshot();
      st.items.push({ type: "count", pts: [w], color: itemColor("count"), takeoff: lbl, seq: seq });
      render();
      return;
    }
    if (t === "door" || t === "window" || t === "gate") {
      snapshot();
      st.items.push(placeOpening(t, raw));
      render();
      return;
    }
    if (t === "pillar") {
      snapshot();
      st.items.push({ type: "pillar", pts: [w], color: itemColor("pillar"), size: st.pillarSize, takeoff: "Pillars" });
      render();
      return;
    }
    // ✂ trim/extend — two picks, one rule: move the nearer end of the first
    // segment onto where the two lines cross. Short lines extend, long ones
    // cut back, which is how a framer thinks about it ("make it meet that").
    if (t === "trim") { trimPick(raw); return; }
    // ⧉ array — repeat the selection at an on-centre spacing
    if (t === "array") { openArrayPrompt(raw); return; }

    // multi-tap tools: outline, triangle (3), arc (3), railing run, fascia run
    if (t === "poly" || t === "tri" || t === "arc" || t === "railing" || t === "fascia") {
      var cap = (t === "tri" || t === "arc") ? 3 : 0;
      var kind = t === "tri" ? "poly" : t;
      if (!st.draw) { st.draw = { type: kind, pts: [w], color: itemColor(kind), fill: itemFill(kind), _cap: cap }; q("#csCtx").classList.add("open"); }
      else {
        // tapping the first point closes an outline
        if (kind === "poly" && st.draw.pts.length >= 3 && dist(raw, st.draw.pts[0]) < 14 / st.ppf) { finishPoly(true); return; }
        // arcs take their 3rd point raw (the curve's bulge), not ortho-locked
        st.draw.pts.push(kind === "arc" && st.draw.pts.length === 2 ? w : applyOrtho(st.draw.pts[st.draw.pts.length - 1], w));
        if (st.draw._cap && st.draw.pts.length >= st.draw._cap) { finishPoly(kind === "poly"); return; }
      }
      render();
      return;
    }
    if (t === "stairs") {
      st.draw = { type: "stairs", pts: [w, w], color: itemColor("stairs"), size: st.stairW, takeoff: "Stairs" };
      st.drag = { mode: "draw" };
      return;
    }
    if (t === "beam") {
      st.draw = { type: "beam", pts: [w, w], color: itemColor("beam"), takeoff: "Beams" };
      st.drag = { mode: "draw" };
      return;
    }
    if (t === "joist") {
      st.draw = { type: "joist", pts: [w, w], color: itemColor("joist"), takeoff: "Joists" };
      st.drag = { mode: "draw" };
      return;
    }
    // line / rect / dim / circle: drag from anchor
    st.draw = { type: t, pts: [w, w], color: itemColor(t), fill: itemFill(t) };
    st.drag = { mode: "draw" };
  }

  function onMove(e) {
    if (!st) return;
    if (st.pointers[e.pointerId]) st.pointers[e.pointerId] = e;
    var ids = Object.keys(st.pointers);
    if (ids.length === 2 && st.pinch) {
      var a = st.pointers[ids[0]], b = st.pointers[ids[1]];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      var mid = [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
      st.ppf = Math.max(4, Math.min(240, st.pinch.ppf * (d / st.pinch.d)));
      var r = q("#csCanvas").getBoundingClientRect();
      st.offX = st.pinch.w[0] - (mid[0] - r.left) / st.ppf;
      st.offY = st.pinch.w[1] - (mid[1] - r.top) / st.ppf;
      render();
      return;
    }
    if (!st.drag && !(st.draw && isMultiTap(st.draw.type))) return;
    var raw = toWorld(e.clientX, e.clientY);
    if (st.drag && st.drag.mode === "pan") {
      st.offX = st.drag.offX - (e.clientX - st.drag.x) / st.ppf;
      st.offY = st.drag.offY - (e.clientY - st.drag.y) / st.ppf;
      render();
      return;
    }
    if (st.drag && st.drag.mode === "move") {
      var m = st.drag, it = st.items[m.idx];
      var dx = raw[0] - m.start[0], dy = raw[1] - m.start[1];
      if (!m.moved && Math.hypot(dx, dy) * st.ppf > 4) m.moved = true;
      if (!m.moved) return;
      if (m.vertex >= 0) {
        var nv = snapPoint([m.orig[m.vertex][0] + dx, m.orig[m.vertex][1] + dy], { skip: m.idx });
        it.pts[m.vertex] = nv;
      } else {
        var sdx = st.snapFt > 0 ? Math.round(dx / st.snapFt) * st.snapFt : dx;
        var sdy = st.snapFt > 0 ? Math.round(dy / st.snapFt) * st.snapFt : dy;
        it.pts = m.orig.map(function (p) { return [p[0] + sdx, p[1] + sdy]; });
      }
      render();
      return;
    }
    if (st.drag && st.drag.mode === "erase" && e.buttons) {
      var hi = hitTest(raw);
      if (hi >= 0) { snapshot(); st.items.splice(hi, 1); render(); }
      return;
    }
    if (st.drag && st.drag.mode === "draw" && st.draw) {
      var w2 = snapPoint(raw);
      // rectangles need both axes free; a circle's radius is free too
      st.draw.pts[1] = (st.draw.type === "rect" || st.draw.type === "circle") ? w2 : applyOrtho(st.draw.pts[0], w2);
      render();
      return;
    }
    if (st.draw && isMultiTap(st.draw.type)) {
      st.draw._hover = applyOrtho(st.draw.pts[st.draw.pts.length - 1], snapPoint(raw));
      renderPolyPreview();
    }
  }

  function renderPolyPreview() {
    render();
    if (!st.draw || !st.draw._hover) return;
    var ctx = q("#csCanvas").getContext("2d");
    // an arc with both ends placed previews the real curve through the cursor
    if (st.draw.type === "arc" && st.draw.pts.length === 2) {
      drawItem(ctx, { type: "arc", color: st.draw.color, pts: [st.draw.pts[0], st.draw.pts[1], st.draw._hover] }, false);
      return;
    }
    var a = toScreen(st.draw.pts[st.draw.pts.length - 1]), b = toScreen(st.draw._hover);
    ctx.save();
    ctx.strokeStyle = st.color; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    label(ctx, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12, fmtFtIn(dist(st.draw.pts[st.draw.pts.length - 1], st.draw._hover)), "#666");
    ctx.restore();
  }

  function onUp(e) {
    if (!st) return;
    delete st.pointers[e.pointerId];
    if (Object.keys(st.pointers).length < 2) st.pinch = null;
    if (st.drag && st.drag.mode === "move") {
      if (st.drag.moved) {
        st.undo.push(st.drag.before);
        if (st.undo.length > 80) st.undo.shift();
        st.redo = [];
        st.dirty = true;
      }
      st.drag = null;
      return;
    }
    if (st.drag && st.drag.mode === "draw" && st.draw) {
      var d = st.draw;
      st.draw = null; st.drag = null;
      if (dist(d.pts[0], d.pts[1]) * st.ppf > 5) { snapshot(); st.items.push(d); }
      render();
      return;
    }
    st.drag = null;
  }

  function isMultiTap(type) { return ["poly", "arc", "railing", "fascia"].indexOf(type) !== -1; }

  function finishPoly(close) {
    if (!st.draw || !isMultiTap(st.draw.type)) return;
    var d = st.draw;
    st.draw = null;
    q("#csCtx").classList.remove("open");
    var enough = d.type === "arc" ? d.pts.length >= 3 : d.pts.length >= 2;
    if (enough) {
      if (d.type === "poly") d.closed = !!close && d.pts.length >= 3;
      delete d._hover;
      delete d._cap;
      snapshot();
      st.items.push(d);
    }
    render();
  }

  /* ── zoom helpers ── */
  function zoomAt(cx, cy, f) {
    var w = toWorld(cx, cy);
    st.ppf = Math.max(4, Math.min(240, st.ppf * f));
    var r = q("#csCanvas").getBoundingClientRect();
    st.offX = w[0] - (cx - r.left) / st.ppf;
    st.offY = w[1] - (cy - r.top) / st.ppf;
    render();
  }
  function bbox() {
    if (!st.items.length) return null;
    var xs = [], ys = [];
    st.items.forEach(function (it) { (it.pts || []).forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
    return [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)];
  }
  function fit() {
    var stage = q("#csStage"), b = bbox();
    if (!b) { st.offX = -2; st.offY = -2; st.ppf = 36; render(); return; }
    var w = Math.max(b[2] - b[0], 4), h = Math.max(b[3] - b[1], 4);
    st.ppf = Math.max(4, Math.min(240, Math.min((stage.clientWidth - 90) / w, (stage.clientHeight - 90) / h)));
    st.offX = b[0] - ((stage.clientWidth / st.ppf) - w) / 2;
    st.offY = b[1] - ((stage.clientHeight / st.ppf) - h) / 2;
    render();
  }

  /* ── save: PNG export + JSON ── */
  // Export a printable PNG: the drawing, plus the takeoff table beneath it so
  // the saved image is self-documenting.
  function exportPng() {
    var b = bbox() || [0, 0, 20, 15];
    var margin = 2;
    var w = b[2] - b[0] + margin * 2, h = b[3] - b[1] + margin * 2;
    var outW = 1600, ppf = outW / w, drawH = Math.round(h * ppf);
    if (drawH > 2000) { drawH = 2000; ppf = drawH / h; outW = Math.round(w * ppf); }

    var t = takeoffData();
    var rows = [];
    t.areas.forEach(function (r) { rows.push(["Area", r.label, r.qty + " SF"]); });
    t.lineals.forEach(function (r) { rows.push(["Lineal", r.label, r.qty + " LF"]); });
    t.counts.forEach(function (r) { rows.push(["Count", r.label, r.qty + " ea"]); });
    var rowH = 30, tableH = rows.length ? 54 + rows.length * rowH + 14 : 0;

    var cv = document.createElement("canvas");
    cv.width = outW; cv.height = drawH + tableH;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);

    // temporarily rebind the viewport to the export surface
    var keep = { offX: st.offX, offY: st.offY, ppf: st.ppf, sel: st.sel };
    st.offX = b[0] - margin; st.offY = b[1] - margin; st.ppf = ppf; st.sel = -1;
    drawGrid(ctx, outW, drawH);
    st.items.forEach(function (it) { drawItem(ctx, it, false); });
    st.offX = keep.offX; st.offY = keep.offY; st.ppf = keep.ppf; st.sel = keep.sel;

    if (rows.length) {
      var y = drawH;
      ctx.fillStyle = "#f2f4f7"; ctx.fillRect(0, y, outW, tableH);
      ctx.strokeStyle = "#c7d0da"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, y + 1); ctx.lineTo(outW, y + 1); ctx.stroke();
      ctx.fillStyle = "#1b2733";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.font = "bold 22px Arial";
      ctx.fillText("TAKEOFF", 26, y + 30);
      ctx.font = "18px Arial";
      rows.forEach(function (r, i) {
        var ry = y + 54 + i * rowH + rowH / 2;
        ctx.fillStyle = i % 2 ? "#ffffff" : "#fafbfc";
        ctx.fillRect(20, y + 54 + i * rowH, outW - 40, rowH);
        ctx.fillStyle = "#5a6b7d"; ctx.fillText(r[0], 30, ry);
        ctx.fillStyle = "#1b2733"; ctx.fillText(r[1], 120, ry);
        ctx.textAlign = "right";
        ctx.font = "bold 18px Arial";
        ctx.fillText(r[2], outW - 34, ry);
        ctx.textAlign = "left";
        ctx.font = "18px Arial";
      });
    }
    return cv.toDataURL("image/png");
  }

  async function save() {
    var btn = q("#csSave");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      var dataUrl = exportPng();
      var name = (st.entry && st.entry.name && /^drawing/.test(st.entry.name) ? st.entry.name : "drawing-" + Date.now() + ".png");
      var up = await DCR.api("/api/portal?action=sales&part=image", {
        method: "POST",
        body: { name: name, dataBase64: dataUrl, pathParts: st.getPathParts ? st.getPathParts() : [] },
      });
      var patch = { id: up.image.id, url: "", name: up.image.name,
        // v3 adds the material list and the estimate numbers; older drawings
        // have neither and open fine (both default from the geometry)
        cad: { version: 3, items: st.items, takeoff: takeoffData(),
          mats: st.mats || null, numbers: deckNumbers() } };
      if (st.onSave) st.onSave(patch);
      close();
    } catch (e) {
      q("#csHint").textContent = "⚠ Could not save: " + (e.message || "upload failed") + " — your drawing is still here, try again.";
      btn.disabled = false; btn.textContent = "✓ Save drawing";
    }
  }

  /* ── ui wiring ── */
  var HINTS = {
    select: "Select — tap an item, drag to move it (blue dots = grab a corner). Tap 📐 (or double-tap a line) to TYPE its exact dimension. Empty space drags the view.",
    pan: "Pan — drag the view. Pinch with two fingers to zoom anytime.",
    line: "Line — drag to draw a wall/edge. Length shows live. ORTHO keeps it square.",
    rect: "Rectangle — drag corner to corner. Width, height and area label automatically.",
    poly: "Outline — tap each corner. Tap the FIRST corner to close the shape (area computes), or ✓ Finish.",
    tri: "Triangle — tap 3 corners; it closes itself and labels each side plus the area.",
    circle: "Circle — drag from the center out. Shows diameter and area.",
    arc: "Arc — tap the start, then the end, then a point the curve passes through. Length counts as lineal feet.",
    railing: "Railing — tap along the edge it follows, then ✓ Finish. Total lineal feet is labeled and totalled in the takeoff.",
    fascia: "Fascia — tap along the EXPOSED edges only (skip the house side), then ✓ Finish. Tip: select a deck outline first and its edges become tappable.",
    trim: "Trim / extend — tap the line to fix, then the line it should meet. Works both ways: short lines extend, long ones cut back.",
    array: "Array — select an item first, then tap ⧉ to repeat it at 12/16/19.2/24\" on centre (joists, footings, balusters).",
    beam: "Beam — drag the span (green). Counts as lineal feet.",
    joist: "Floor joist — drag the span; draws as a dotted yellow line. Counts as lineal feet.",
    stairs: "Stairs — drag the run out from the deck edge; treads draw automatically. Tap the 🪜 tool again to change the width.",
    gate: "Gate — tap on a railing; it aligns and shows the swing. Tap the 🚧 tool again to change the width.",
    pillar: "Pillar / column — tap to place. Tap the ▪ tool again to change the size.",
    door: "Door — tap on a wall; the symbol aligns to it. Tap the 🚪 tool again to change the width.",
    window: "Window — tap on a wall; the symbol aligns to it. Tap the 🪟 tool again to change the width.",
    count: "Count — tap to drop numbered markers. Tap the 🔢 tool again to change what you're counting.",
    dim: "Dimension — drag between two points to place a measurement.",
    text: "Text — tap where the label goes.",
    post: "Post — tap to place a post symbol (counts as Posts in the takeoff).",
    erase: "Eraser — tap items to remove them.",
  };
  function paintOrtho() {
    var b = q("#csOrtho");
    b.textContent = st.orthoDeg ? "ORTHO " + st.orthoDeg + "°" : "ORTHO off";
    b.classList.toggle("act", st.orthoDeg > 0);
  }

  function setTool(t) {
    var reselect = st.tool === t;
    if (st.draw && isMultiTap(st.draw.type)) finishPoly(false);
    st.trimFirst = null;   // a half-finished trim must not survive a tool change
    st.tool = t;
    // ⧉ array works ON the selection, so it must not clear it the way the
    // drawing tools do — that made "select it, then tap ⧉" impossible
    if (t !== "select" && t !== "array" && st.sel >= 0) { st.sel = -1; }
    ui.querySelectorAll(".cs-tool[data-tool]").forEach(function (b) { b.classList.toggle("on", b.dataset.tool === t); });
    q("#csHint").textContent = HINTS[t] || "";
    render();
    // sized symbols ask for their dimension the first time (tap the tool again
    // any time to change it)
    var sz = SIZE_TOOLS[t];
    if (sz && (reselect || !st._asked[t])) {
      st._asked[t] = true;
      openFtInPrompt(sz.title, sz.label, st[sz.key], function (v) {
        st[sz.key] = v;
        q("#csHint").textContent = sz.name + " set to " + fmtFtIn(v) + " — " + sz.after;
      });
    }
    // picking ⧉ with something already selected goes straight to the dialog;
    // with nothing selected the hint asks for a tap, and that tap opens it
    if (t === "array" && st.sel >= 0) openArrayPrompt(null);
    if (t === "count" && (reselect || !st.countLabel)) {
      openPrompt("🔢 What are you counting?", function () {
        st.countLabel = q("#csPromptInput").value.trim() || "Count";
        q("#csHint").textContent = 'Counting "' + st.countLabel + '" — tap to drop numbered markers.';
      }, st.countLabel || "", ["Posts", "Footings", "Lights", "Balusters", "Joist hangers", "Stair treads"]);
    }
  }

  function wireStatic() {
    ui.querySelectorAll(".cs-tool[data-tool]").forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    // "A" = auto: each tool draws in its own colour (deck brown, railing blue,
    // beams/pillars green, joists yellow…). A swatch overrides everything.
    q("#csColors").innerHTML =
      '<span class="cs-color cs-auto on" data-c="" title="Auto — each tool uses its own colour">A</span>' +
      COLORS.map(function (c) {
        return '<span class="cs-color" data-c="' + c + '" style="background:' + c + '"></span>';
      }).join("");
    ui.querySelectorAll(".cs-color").forEach(function (s2) {
      s2.onclick = function () {
        st.color = s2.dataset.c || null; // "" → auto
        ui.querySelectorAll(".cs-color").forEach(function (x) { x.classList.toggle("on", x === s2); });
      };
    });
    q("#csOrtho").onclick = function () {
      st.orthoIdx = (st.orthoIdx + 1) % ORTHO_STEPS.length;
      st.orthoDeg = ORTHO_STEPS[st.orthoIdx];
      paintOrtho();
    };
    q("#csTagSel").onclick = function () {
      var it = st.sel >= 0 ? st.items[st.sel] : null;
      if (!it) return;
      openPrompt("🏷 Takeoff label", function () {
        var v = q("#csPromptInput").value.trim();
        if (v) { snapshot(); it.takeoff = v; render(); }
      }, it.takeoff || defaultLabel(it), TAKEOFF_SUGGEST);
    };
    q("#csTakeoff").onclick = function () {
      var p = q("#csPanel");
      p.classList.toggle("open");
      if (p.classList.contains("open")) renderPanel();
    };
    ui.querySelectorAll(".cs-tab").forEach(function (b) {
      b.onclick = function () {
        st.panelTab = b.dataset.tab;
        ui.querySelectorAll(".cs-tab").forEach(function (x) { x.classList.toggle("on", x === b); });
        renderPanel();
      };
    });
    q("#csPanelClose").onclick = function () { q("#csPanel").classList.remove("open"); };
    q("#csTakeoffCopy").onclick = function () {
      var txt = takeoffText();
      if (navigator.clipboard) navigator.clipboard.writeText(txt).catch(function () {});
      q("#csHint").textContent = "✓ Takeoff copied — paste into the estimate or a spreadsheet.";
    };
    q("#csSnap").onclick = function () {
      st.snapIdx = (st.snapIdx + 1) % SNAPS.length;
      st.snapFt = SNAPS[st.snapIdx];
      this.textContent = st.snapFt === 0 ? "SNAP off" : "SNAP " + (st.snapFt >= 1 ? st.snapFt + "'" : (st.snapFt * 12) + '"');
      this.classList.toggle("act", st.snapFt > 0);
    };
    q("#csGrid").onclick = function () { st.grid = !st.grid; this.classList.toggle("act", st.grid); render(); };
    q("#csZoomIn").onclick = function () { var r = q("#csCanvas").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.3); };
    q("#csZoomOut").onclick = function () { var r = q("#csCanvas").getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.3); };
    q("#csFit").onclick = fit;
    q("#csUndo").onclick = doUndo;
    q("#csRedo").onclick = doRedo;
    q("#csCancel").onclick = async function () {
      if (st.dirty && !(await DCR.confirm("Your markup on this drawing will be lost.", { title: "Discard the changes?", danger: true, okText: "Discard" }))) return;
      close();
    };
    q("#csSave").onclick = save;
    q("#csDelSel").onclick = function () { if (st.sel >= 0) { snapshot(); st.items.splice(st.sel, 1); st.sel = -1; render(); } };
    q("#csDimSel").onclick = openDimPrompt;
    ["csDimAft", "csDimAin", "csDimBft", "csDimBin"].forEach(function (id) {
      q("#" + id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); q("#csPromptOk").click(); }
      });
    });
    q("#csEditSel").onclick = function () {
      var it = st.sel >= 0 ? st.items[st.sel] : null;
      if (!it || it.type !== "text") return;
      openPrompt("✏️ Edit label", function () {
        var v = q("#csPromptInput").value.trim();
        if (v && v !== it.text) { snapshot(); it.text = v; render(); }
      }, it.text);
    };
    q("#csPolyDone").onclick = function () { finishPoly(false); };
    q("#csPolyClose").onclick = function () { finishPoly(true); };
    q("#csPolyCancel").onclick = function () { st.draw = null; q("#csCtx").classList.remove("open"); render(); };
    q("#csPromptCancel").onclick = closePrompt;
    q("#csPromptOk").onclick = function () { var cb = promptCb; closePrompt(); if (cb) cb(); };
    var cv = q("#csCanvas");
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onUp);
    cv.addEventListener("dblclick", function (e) {
      var hi = hitTest(toWorld(e.clientX, e.clientY));
      if (hi < 0) return;
      st.sel = hi;
      render();
      var t = st.items[hi].type;
      if (t === "text") q("#csEditSel").onclick();
      else if (t === "line" || t === "dim" || t === "rect") openDimPrompt();
    });
    cv.addEventListener("wheel", function (e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    document.addEventListener("keydown", function (e) {
      if (!st || !ui.classList.contains("open")) return;
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if ((e.key === "Delete" || e.key === "Backspace") && st.sel >= 0) { e.preventDefault(); q("#csDelSel").onclick(); }
      if (e.key === "Escape") {
        if (st.draw) { st.draw = null; q("#csCtx").classList.remove("open"); render(); }
        if (st.trimFirst) { st.trimFirst = null; q("#csHint").textContent = HINTS.trim || ""; render(); }
      }
      if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
      if (e.ctrlKey && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
    });
    window.addEventListener("resize", function () { if (st && ui.classList.contains("open")) resize(); });
  }

  function close() {
    ui.classList.remove("open");
    closePrompt();
    q("#csCtx").classList.remove("open");
    st = null;
  }

  function open(opts) {
    injectUi();
    var cad = (opts.entry && opts.entry.cad) || {};
    st = {
      entry: opts.entry || null, onSave: opts.onSave, getPathParts: opts.getPathParts,
      onNumbers: opts.onNumbers || null, hiDeck: false,
      items: (cad.items || []).map(function (x) { return JSON.parse(JSON.stringify(x)); }),
      undo: [], redo: [], draw: null, drag: null, dirty: false,
      sel: -1, tool: "line", color: null, // null = auto (per-tool colours)
      offX: -2, offY: -2, ppf: 36,
      snapIdx: 0, snapFt: SNAPS[0], grid: true,
      orthoIdx: 0, orthoDeg: ORTHO_STEPS[0],
      doorW: 3, winW: 4, gateW: 3, stairW: 4, pillarSize: 0.5,
      countLabel: "", _asked: {},
      trimFirst: null, arraySpacing: 16 / 12, arrayN: 8,
      mats: (cad.mats || null), panelTab: "takeoff",
      pointers: {}, pinch: null,
    };
    q("#csTitle").textContent = opts.title || "New drawing";
    q("#csSave").disabled = false; q("#csSave").textContent = "✓ Save drawing";
    q("#csSnap").textContent = 'SNAP 6"'; q("#csSnap").classList.add("act");
    q("#csGrid").classList.add("act");
    q("#csPanel").classList.remove("open");
    paintOrtho();
    ui.classList.add("open");
    resize();
    if (st.items.length) fit(); else render();
    setTool("line");
  }

  window.DCRCad = { open: open };
})();
