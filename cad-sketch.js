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
  var COLORS = ["#111111", "#e53935", "#2f80d8", "#2fa679"];
  var TOL = 16;
  var SNAPS = [0.5, 1, 0.25, 0];        // ft: 6in → 1ft → 3in → off
  var ORTHO_STEPS = [45, 22.5, 90, 0];  // deg between allowed directions (0 = free)
  var TAKEOFF_SUGGEST = ["Deck area", "Decking", "Framing", "Railing", "Stairs",
    "Fascia", "Posts", "Footings", "Beams", "Lights", "Doors", "Windows"];
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
      '<button class="cs-tool" data-tool="rect" title="Rectangle — auto W×H + area">▭</button>' +
      '<button class="cs-tool" data-tool="poly" title="Outline — tap corners; tap the first corner to close">⬠</button>' +
      '<button class="cs-tool" data-tool="tri" title="Triangle — tap 3 corners">◺</button>' +
      '<button class="cs-tool" data-tool="circle" title="Circle — drag from the center">◯</button>' +
      '<button class="cs-tool" data-tool="door" title="Door symbol (tap the tool again to change the size)">🚪</button>' +
      '<button class="cs-tool" data-tool="window" title="Window symbol (tap the tool again to change the size)">🪟</button>' +
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
      '<div class="cs-panel" id="csPanel"><div class="ph"><b>Σ Takeoff</b>' +
      '<span><button class="cs-btn" id="csTakeoffCopy" style="padding:3px 8px">📋 Copy</button> ' +
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
  // Every edge of an item, as [a,b] pairs (drives hit-testing, wall snapping
  // for openings, and lineal-foot takeoff).
  function segmentsOf(it) {
    var p = it.pts || [], out = [];
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
    return segmentsOf(it).reduce(function (s, g) { return s + dist(g[0], g[1]); }, 0);
  }
  // Openings sit ON a wall: find the nearest edge and align/center to it.
  function placeOpening(type, w) {
    var width = type === "door" ? st.doorW : st.winW;
    var best = null, bd = 3; // ft search radius
    st.items.forEach(function (it) {
      if (["line", "rect", "poly"].indexOf(it.type) === -1) return;
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
      type: type, color: st.color,
      takeoff: type === "door" ? "Doors" : "Windows",
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
      ctx.beginPath(); ctx.arc(P[0][0], P[0][1], rpx, 0, 7); ctx.stroke();
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

  function render() {
    var cv = q("#csCanvas"), ctx = cv.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var wpx = cv.width / dpr, hpx = cv.height / dpr;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, wpx, hpx);
    drawGrid(ctx, wpx, hpx);
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
    if (it && (it.type === "line" || it.type === "dim" || it.type === "door" || it.type === "window")) {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(dist(it.pts[0], it.pts[1]));
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
    if (q("#csPanel").classList.contains("open")) renderTakeoff();
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
    if (!isRect && !isCircle && ["line", "dim", "door", "window"].indexOf(it.type) === -1) return;
    q("#csPromptText").style.display = "none";
    q("#csPromptDims").style.display = "";
    q("#csDimRowB").style.display = isRect ? "flex" : "none";
    q("#csDimLabelA").textContent = (isRect ? "Width" : isCircle ? "Diameter" : "Length") + " — feet";
    var a = isRect ? splitFtIn(Math.abs(it.pts[1][0] - it.pts[0][0]))
      : isCircle ? splitFtIn(dist(it.pts[0], it.pts[1]) * 2)
      : splitFtIn(dist(it.pts[0], it.pts[1]));
    q("#csDimAft").value = a[0]; q("#csDimAin").value = a[1];
    if (isRect) {
      var b = splitFtIn(Math.abs(it.pts[1][1] - it.pts[0][1]));
      q("#csDimBft").value = b[0]; q("#csDimBin").value = b[1];
    }
    openPromptRaw(isRect ? "📐 Exact size (width × height)" : isCircle ? "📐 Exact diameter" : "📐 Exact length", function () {
      var lenA = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      if (!(lenA > 0)) return;
      snapshot();
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
      if (it.type === "circle" && pts.length === 2) {
        // the ring itself, or anywhere inside a small circle
        var rr = dist(pts[0], pts[1]);
        if (Math.abs(dist(w, pts[0]) - rr) < th || dist(w, pts[0]) < Math.min(rr, th * 2)) return i;
        continue;
      }
      if (it.type === "rect" && pts.length === 2) {
        var edges = segmentsOf(it);
        for (var c = 0; c < edges.length; c++) if (ptSeg(w, edges[c][0], edges[c][1]) < th) return i;
        continue;
      }
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
    if (it.type === "line" || it.type === "poly") return "Lineal";
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
        add(lineals, lbl + " perimeter", itemLength(it)); // railing / fascia runs
      } else if (it.type === "line" || it.type === "poly" || it.type === "dim") {
        add(lineals, lbl, itemLength(it));
      } else if (["post", "count", "door", "window"].indexOf(it.type) !== -1) {
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
  function renderTakeoff() {
    var t = takeoffData();
    var html = "";
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
    if (!html) html = '<p style="color:#5a6b7d">Draw shapes and drop markers — areas, lineal feet and counts total up here. Select an item and tap 🏷 to name it (Decking, Railing, Posts…).</p>';
    q("#csPanelBody").innerHTML = html;
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
        if (v) { snapshot(); st.items.push({ type: "text", pts: [w], color: st.color, text: v }); render(); }
      });
      return;
    }
    if (t === "post") { snapshot(); st.items.push({ type: "post", pts: [w], color: st.color, takeoff: "Posts" }); render(); return; }
    if (t === "count") {
      var lbl = st.countLabel || "Count";
      var seq = st.items.filter(function (x) { return x.type === "count" && (x.takeoff || "Count") === lbl; }).length + 1;
      snapshot();
      st.items.push({ type: "count", pts: [w], color: st.color, takeoff: lbl, seq: seq });
      render();
      return;
    }
    if (t === "door" || t === "window") {
      snapshot();
      st.items.push(placeOpening(t, raw));
      render();
      return;
    }
    if (t === "poly" || t === "tri") {
      var cap = t === "tri" ? 3 : 0; // triangles auto-close at 3 corners
      if (!st.draw) { st.draw = { type: "poly", pts: [w], color: st.color, _cap: cap }; q("#csCtx").classList.add("open"); }
      else {
        // tapping the first point closes the shape
        if (st.draw.pts.length >= 3 && dist(raw, st.draw.pts[0]) < 14 / st.ppf) { finishPoly(true); return; }
        st.draw.pts.push(applyOrtho(st.draw.pts[st.draw.pts.length - 1], w));
        if (st.draw._cap && st.draw.pts.length >= st.draw._cap) { finishPoly(true); return; }
      }
      render();
      return;
    }
    // line / rect / dim / circle: drag from anchor
    st.draw = { type: t, pts: [w, w], color: st.color };
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
    if (!st.drag && !(st.draw && st.draw.type === "poly")) return;
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
    if (st.draw && st.draw.type === "poly") {
      st.draw._hover = applyOrtho(st.draw.pts[st.draw.pts.length - 1], snapPoint(raw));
      renderPolyPreview();
    }
  }

  function renderPolyPreview() {
    render();
    if (!st.draw || !st.draw._hover) return;
    var ctx = q("#csCanvas").getContext("2d");
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

  function finishPoly(close) {
    if (!st.draw || st.draw.type !== "poly") return;
    var d = st.draw;
    st.draw = null;
    q("#csCtx").classList.remove("open");
    if (d.pts.length >= 2) {
      d.closed = !!close && d.pts.length >= 3;
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
        cad: { version: 2, items: st.items, takeoff: takeoffData() } };
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
    if (st.draw && st.draw.type === "poly") finishPoly(false);
    st.tool = t;
    if (t !== "select" && st.sel >= 0) { st.sel = -1; }
    ui.querySelectorAll(".cs-tool[data-tool]").forEach(function (b) { b.classList.toggle("on", b.dataset.tool === t); });
    q("#csHint").textContent = HINTS[t] || "";
    render();
    // openings and counts ask for their size/label the first time (tap the tool
    // again any time to change it)
    if ((t === "door" || t === "window") && (reselect || !st[t === "door" ? "doorAsked" : "winAsked"])) {
      st[t === "door" ? "doorAsked" : "winAsked"] = true;
      openFtInPrompt(t === "door" ? "🚪 Door width" : "🪟 Window width", "Width",
        t === "door" ? st.doorW : st.winW,
        function (v) {
          if (t === "door") st.doorW = v; else st.winW = v;
          q("#csHint").textContent = (t === "door" ? "Door" : "Window") + " set to " + fmtFtIn(v) + " — tap on a wall to place it.";
        });
    }
    if (t === "count" && (reselect || !st.countLabel)) {
      openPrompt("🔢 What are you counting?", function () {
        st.countLabel = q("#csPromptInput").value.trim() || "Count";
        q("#csHint").textContent = 'Counting "' + st.countLabel + '" — tap to drop numbered markers.';
      }, st.countLabel || "", ["Posts", "Footings", "Lights", "Balusters", "Joist hangers", "Stair treads"]);
    }
  }

  function wireStatic() {
    ui.querySelectorAll(".cs-tool[data-tool]").forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    q("#csColors").innerHTML = COLORS.map(function (c, i) {
      return '<span class="cs-color' + (i === 0 ? " on" : "") + '" data-c="' + c + '" style="background:' + c + '"></span>';
    }).join("");
    ui.querySelectorAll(".cs-color").forEach(function (s2) {
      s2.onclick = function () {
        st.color = s2.dataset.c;
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
      if (p.classList.contains("open")) renderTakeoff();
    };
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
    q("#csCancel").onclick = function () {
      if (st.dirty && !confirm("Discard the changes to this drawing?")) return;
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
      if (e.key === "Escape" && st.draw) { st.draw = null; q("#csCtx").classList.remove("open"); render(); }
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
      items: (cad.items || []).map(function (x) { return JSON.parse(JSON.stringify(x)); }),
      undo: [], redo: [], draw: null, drag: null, dirty: false,
      sel: -1, tool: "line", color: COLORS[0],
      offX: -2, offY: -2, ppf: 36,
      snapIdx: 0, snapFt: SNAPS[0], grid: true,
      orthoIdx: 0, orthoDeg: ORTHO_STEPS[0],
      doorW: 3, winW: 4, countLabel: "", doorAsked: false, winAsked: false,
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
