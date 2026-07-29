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
  var SNAPS = [0.5, 1, 0.25, 0]; // ft: 6in → 1ft → 3in → off
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
      ".cs-prompt .acts{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}";
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
      '<button class="cs-tool" data-tool="dim" title="Dimension line">📏</button>' +
      '<button class="cs-tool" data-tool="text" title="Text label">T</button>' +
      '<button class="cs-tool" data-tool="post" title="Post marker">⊙</button>' +
      '<button class="cs-tool" data-tool="erase" title="Eraser">🧽</button>' +
      '<button class="cs-btn" id="csEditSel" style="display:none">✏️</button>' +
      '<button class="cs-btn" id="csDimSel" style="display:none" title="Type the exact dimension">📐</button>' +
      '<button class="cs-btn" id="csDelSel" style="display:none">🗑</button>' +
      '<span style="width:6px"></span>' +
      '<button class="cs-tool tog act" id="csOrtho" title="Keep lines square (horizontal/vertical)">ORTHO</button>' +
      '<button class="cs-tool tog act" id="csSnap" title="Snap distance">SNAP 6"</button>' +
      '<button class="cs-tool tog act" id="csGrid" title="Show grid">GRID</button>' +
      '<span id="csColors" style="display:flex;gap:5px;align-items:center"></span>' +
      '<span style="flex:1"></span>' +
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
      '<button class="cs-btn" id="csPolyCancel">✕</button></div></div>' +
      '<div class="cs-hint" id="csHint"></div>' +
      '<div class="cs-prompt" id="csPrompt"><div class="box">' +
      '<h4 id="csPromptTitle" style="margin:0 0 10px;font-size:14px"></h4>' +
      '<div id="csPromptText"><textarea id="csPromptInput" rows="2"></textarea></div>' +
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
  function applyOrtho(prev, pt) {
    if (!st.ortho || !prev) return pt;
    return Math.abs(pt[0] - prev[0]) >= Math.abs(pt[1] - prev[1]) ? [pt[0], prev[1]] : [prev[0], pt[1]];
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
    if (it && (it.type === "line" || it.type === "dim")) {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(dist(it.pts[0], it.pts[1]));
    } else if (it && it.type === "rect") {
      dimBtn.style.display = "";
      dimBtn.textContent = "📐 " + fmtFtIn(Math.abs(it.pts[1][0] - it.pts[0][0])) + " × " + fmtFtIn(Math.abs(it.pts[1][1] - it.pts[0][1]));
    } else {
      dimBtn.style.display = "none";
    }
  }

  /* ── type an exact dimension for the selection ── */
  function splitFtIn(feet) {
    var ft = Math.floor(feet + 1e-9);
    return [ft, Math.round((feet - ft) * 12 * 2) / 2];
  }
  function openDimPrompt() {
    var it = st.sel >= 0 ? st.items[st.sel] : null;
    if (!it) return;
    var isRect = it.type === "rect";
    if (!isRect && it.type !== "line" && it.type !== "dim") return;
    q("#csPromptText").style.display = "none";
    q("#csPromptDims").style.display = "";
    q("#csDimRowB").style.display = isRect ? "flex" : "none";
    q("#csDimLabelA").textContent = (isRect ? "Width" : "Length") + " — feet";
    var a = isRect ? splitFtIn(Math.abs(it.pts[1][0] - it.pts[0][0])) : splitFtIn(dist(it.pts[0], it.pts[1]));
    q("#csDimAft").value = a[0]; q("#csDimAin").value = a[1];
    if (isRect) {
      var b = splitFtIn(Math.abs(it.pts[1][1] - it.pts[0][1]));
      q("#csDimBft").value = b[0]; q("#csDimBin").value = b[1];
    }
    openPromptRaw(isRect ? "📐 Exact size (width × height)" : "📐 Exact length", function () {
      var lenA = (Number(q("#csDimAft").value) || 0) + (Number(q("#csDimAin").value) || 0) / 12;
      if (!(lenA > 0)) return;
      snapshot();
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
      if (it.type === "post") { if (dist(w, pts[0]) < th * 2) return i; continue; }
      if (it.type === "rect" && pts.length === 2) {
        var corners = [pts[0], [pts[1][0], pts[0][1]], pts[1], [pts[0][0], pts[1][1]], pts[0]];
        for (var c = 1; c < corners.length; c++) if (ptSeg(w, corners[c - 1], corners[c]) < th) return i;
        continue;
      }
      var n = it.closed ? pts.length + 1 : pts.length;
      for (var s = 1; s < n; s++) if (ptSeg(w, pts[s - 1], pts[s % pts.length]) < th) return i;
    }
    return -1;
  }
  function grabVertex(it, w) {
    var th = 14 / st.ppf;
    for (var i = 0; i < it.pts.length; i++) if (dist(w, it.pts[i]) < th) return i;
    return -1;
  }

  /* ── prompt ── */
  var promptCb = null;
  function openPromptRaw(title, cb) {
    promptCb = cb;
    q("#csPromptTitle").textContent = title;
    q("#csPrompt").classList.add("open");
  }
  function openPrompt(title, cb, prefill) {
    q("#csPromptText").style.display = "";
    q("#csPromptDims").style.display = "none";
    q("#csPromptInput").value = prefill || "";
    openPromptRaw(title, cb);
    setTimeout(function () { q("#csPromptInput").focus(); }, 60);
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
    if (t === "post") { snapshot(); st.items.push({ type: "post", pts: [w], color: st.color }); render(); return; }
    if (t === "poly") {
      if (!st.draw) { st.draw = { type: "poly", pts: [w], color: st.color }; q("#csCtx").classList.add("open"); }
      else {
        // tapping the first point closes the shape
        if (st.draw.pts.length >= 3 && dist(raw, st.draw.pts[0]) < 14 / st.ppf) { finishPoly(true); return; }
        st.draw.pts.push(applyOrtho(st.draw.pts[st.draw.pts.length - 1], w));
      }
      render();
      return;
    }
    // line / rect / dim: drag from anchor
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
      st.draw.pts[1] = st.draw.type === "rect" ? w2 : applyOrtho(st.draw.pts[0], w2);
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
  function exportPng() {
    var b = bbox() || [0, 0, 20, 15];
    var margin = 2;
    var w = b[2] - b[0] + margin * 2, h = b[3] - b[1] + margin * 2;
    var outW = 1600, ppf = outW / w, outH = Math.round(h * ppf);
    if (outH > 2200) { outH = 2200; ppf = outH / h; outW = Math.round(w * ppf); }
    var cv = document.createElement("canvas");
    cv.width = outW; cv.height = outH;
    // temporarily rebind the viewport to the export surface
    var keep = { offX: st.offX, offY: st.offY, ppf: st.ppf, sel: st.sel, grid: st.grid };
    st.offX = b[0] - margin; st.offY = b[1] - margin; st.ppf = ppf; st.sel = -1;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, outW, outH);
    drawGrid(ctx, outW, outH);
    var realToScreen = toScreen; // uses st.* which we just rebound
    st.items.forEach(function (it) { drawItem(ctx, it, false); });
    st.offX = keep.offX; st.offY = keep.offY; st.ppf = keep.ppf; st.sel = keep.sel;
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
      var patch = { id: up.image.id, url: "", name: up.image.name, cad: { version: 1, items: st.items } };
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
    dim: "Dimension — drag between two points to place a measurement.",
    text: "Text — tap where the label goes.",
    post: "Post — tap to place a post symbol.",
    erase: "Eraser — tap items to remove them.",
  };
  function setTool(t) {
    if (st.draw && st.draw.type === "poly") finishPoly(false);
    st.tool = t;
    if (t !== "select" && st.sel >= 0) { st.sel = -1; }
    ui.querySelectorAll(".cs-tool[data-tool]").forEach(function (b) { b.classList.toggle("on", b.dataset.tool === t); });
    q("#csHint").textContent = HINTS[t] || "";
    render();
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
    q("#csOrtho").onclick = function () { st.ortho = !st.ortho; this.classList.toggle("act", st.ortho); };
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
      snapIdx: 0, snapFt: SNAPS[0], ortho: true, grid: true,
      pointers: {}, pinch: null,
    };
    q("#csTitle").textContent = opts.title || "New drawing";
    q("#csSave").disabled = false; q("#csSave").textContent = "✓ Save drawing";
    q("#csSnap").textContent = 'SNAP 6"'; q("#csSnap").classList.add("act");
    q("#csOrtho").classList.add("act"); q("#csGrid").classList.add("act");
    ui.classList.add("open");
    resize();
    if (st.items.length) fit(); else render();
    setTool("line");
  }

  window.DCRCad = { open: open };
})();
