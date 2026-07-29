/* DCR portal — photo annotation editor (shared).
   Full-screen markup over any gallery photo: ➤ arrows, T text, 📏 measurements
   (with 🎯 calibrate → real ft-in labels), 🖍 freehand + ▭ box highlights,
   🧽 eraser, colors, line width, undo/redo. NON-DESTRUCTIVE: annotations are
   stored as JSON on the gallery entry ({items:[…], ppf}) in the image's own
   pixel space, so they can be re-edited any time. Drawing engine ported from
   the plan viewer (planview.js).

   API: DCRAnnotate.open({ entry, title, onSave(ann) })
        entry = {id?|url?, name, ann?} — image loaded like DCRGallery.srcInto. */
(function () {
  var COLORS = ["#e53935", "#2f80d8", "#2fa679", "#f2b32c", "#9b59d0", "#111111"];
  var TOL = 16; // measurement display tolerance: nearest 1/16"

  var ui = null; // singleton editor DOM
  var st = null; // per-open state

  function injectUi() {
    if (ui) return;
    var css = document.createElement("style");
    css.textContent =
      ".pa-overlay{position:fixed;inset:0;background:rgba(10,13,17,.96);z-index:9000;display:none;flex-direction:column}" +
      ".pa-overlay.open{display:flex}" +
      ".pa-bar{display:flex;align-items:center;gap:6px;padding:8px 12px;flex-wrap:wrap;background:var(--surface,#171d25);border-bottom:1px solid var(--border,#2a333d)}" +
      ".pa-title{font-size:13px;font-weight:700;color:var(--text,#e6ebf1);margin-right:6px;max-width:24vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".pa-tool{width:38px;height:34px;border-radius:8px;border:1px solid var(--border,#2a333d);background:var(--surface,#171d25);color:var(--text,#e6ebf1);cursor:pointer;font-size:15px;flex-shrink:0}" +
      ".pa-tool.on{background:#2f80d8;border-color:#2f80d8;color:#fff}" +
      ".pa-color{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;flex-shrink:0}" +
      ".pa-color.on{border-color:#fff;box-shadow:0 0 0 2px rgba(47,128,216,.5)}" +
      ".pa-btn{padding:6px 12px;font-size:12.5px;font-weight:600;border-radius:7px;cursor:pointer;border:1px solid var(--border,#2a333d);background:var(--surface,#171d25);color:var(--text,#e6ebf1)}" +
      ".pa-btn.primary{background:#2f80d8;border-color:#2f80d8;color:#fff}" +
      ".pa-stage{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;position:relative;padding:10px}" +
      ".pa-wrap{position:relative;box-shadow:0 4px 24px rgba(0,0,0,.6)}" +
      ".pa-wrap canvas{display:block}" +
      ".pa-wrap #paOv{position:absolute;left:0;top:0;touch-action:none;cursor:crosshair}" +
      ".pa-hint{font-size:12px;color:var(--text-muted,#93a1b1);padding:6px 14px;background:var(--surface,#171d25);border-top:1px solid var(--border,#2a333d);min-height:18px}" +
      ".pa-sel{padding:6px 8px;font-size:12.5px;border:1px solid var(--border,#2a333d);border-radius:7px;background:var(--surface,#171d25);color:var(--text,#e6ebf1);width:auto;cursor:pointer}" +
      ".pa-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9100;display:none;align-items:center;justify-content:center;padding:16px}" +
      ".pa-modal-bg.open{display:flex}" +
      ".pa-modal{background:var(--surface,#171d25);color:var(--text,#e6ebf1);border:1px solid var(--border,#2a333d);border-radius:12px;max-width:360px;width:100%;padding:18px}" +
      ".pa-modal h4{margin:0 0 10px;font-size:14px}" +
      ".pa-modal input,.pa-modal textarea{width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;border:1px solid var(--border,#2a333d);border-radius:8px;background:var(--surface,#171d25);color:var(--text,#e6ebf1)}" +
      ".pa-modal .row{display:flex;gap:8px;margin-top:6px}" +
      ".pa-modal .row>div{flex:1}" +
      ".pa-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}";
    document.head.appendChild(css);

    ui = document.createElement("div");
    ui.className = "pa-overlay";
    ui.innerHTML =
      '<div class="pa-bar">' +
      '<span class="pa-title" id="paTitle"></span>' +
      '<button class="pa-tool on" data-tool="arrow" title="Arrow">➤</button>' +
      '<button class="pa-tool" data-tool="text" title="Text note">T</button>' +
      '<button class="pa-tool" data-tool="measure" title="Measure">📏</button>' +
      '<button class="pa-tool" data-tool="cal" title="Calibrate scale from a known length">🎯</button>' +
      '<button class="pa-tool" data-tool="hl" title="Highlighter (freehand)">🖍</button>' +
      '<button class="pa-tool" data-tool="hlbox" title="Box highlight">▭</button>' +
      '<button class="pa-tool" data-tool="erase" title="Eraser">🧽</button>' +
      '<span style="width:8px"></span>' +
      '<span id="paColors" style="display:flex;gap:5px;align-items:center"></span>' +
      '<select class="pa-sel" id="paWidth"><option value="1.5">Thin</option><option value="3" selected>Medium</option><option value="6">Thick</option></select>' +
      '<span style="flex:1"></span>' +
      '<button class="pa-btn" id="paUndo" title="Undo">↶</button>' +
      '<button class="pa-btn" id="paRedo" title="Redo">↷</button>' +
      '<button class="pa-btn" id="paCancel">Cancel</button>' +
      '<button class="pa-btn primary" id="paSave">✓ Save markup</button>' +
      "</div>" +
      '<div class="pa-stage"><div class="pa-wrap"><canvas id="paBase"></canvas><canvas id="paOv"></canvas></div></div>' +
      '<div class="pa-hint" id="paHint"></div>' +
      '<div class="pa-modal-bg" id="paPrompt"><div class="pa-modal">' +
      '<h4 id="paPromptTitle"></h4>' +
      '<div id="paPromptText" style="display:none"><textarea id="paTextInput" rows="2" placeholder="Type the note…"></textarea></div>' +
      '<div id="paPromptCal" style="display:none"><p style="font-size:12px;color:var(--text-muted,#93a1b1);margin:0 0 8px">Enter the real length of the line you just drew:</p>' +
      '<div class="row"><div><label style="font-size:11px">Feet</label><input id="paCalFt" type="number" min="0" value="0"></div>' +
      '<div><label style="font-size:11px">Inches</label><input id="paCalIn" type="number" min="0" step="0.5" value="0"></div></div></div>' +
      '<div class="pa-actions"><button class="pa-btn" id="paPromptCancel">Cancel</button>' +
      '<button class="pa-btn primary" id="paPromptOk">✓ OK</button></div>' +
      "</div></div>";
    document.body.appendChild(ui);
    wireStatic();
  }

  var q = function (sel) { return ui.querySelector(sel); };

  /* ── formatting (ported) ── */
  function fmtFtIn(feet) {
    if (!isFinite(feet)) return "";
    var neg = feet < 0; feet = Math.abs(feet);
    var ft = Math.floor(feet);
    var inches = (feet - ft) * 12;
    var whole = Math.floor(inches);
    var frac = Math.round((inches - whole) * TOL);
    if (frac === TOL) { frac = 0; whole++; }
    if (whole === 12) { whole = 0; ft++; }
    var g = (function gcd(a, b) { return b ? gcd(b, a % b) : a; })(frac || TOL, TOL);
    var fs = frac ? " " + (frac / g) + "/" + (TOL / g) : "";
    return (neg ? "-" : "") + ft + "'-" + whole + fs + '"';
  }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /* ── drawing ── */
  function sf() { return Math.max(1, Math.min(4, st.w / 900)); } // stroke/font scale for big photos
  function drawItem(ctx, it) {
    var pts = it.pts;
    ctx.save();
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color;
    ctx.lineWidth = (it.width || 3) * sf(); ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (it.type === "arrow" && pts.length === 2) {
      line(ctx, pts[0], pts[1]); head(ctx, pts[0], pts[1], 9 * sf());
    } else if (it.type === "measure" && pts.length === 2) {
      line(ctx, pts[0], pts[1]);
      head(ctx, pts[0], pts[1], 7 * sf()); head(ctx, pts[1], pts[0], 7 * sf());
      var label = st.ppf ? fmtFtIn(dist(pts[0], pts[1]) / st.ppf) : Math.round(dist(pts[0], pts[1])) + " px";
      pill(ctx, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2 - 12 * sf(), label, "#ffd47f");
    } else if (it.type === "text" && pts.length === 1) {
      pill(ctx, pts[0][0], pts[0][1], it.text || "", "#fff", it.color);
    } else if (it.type === "hl" && pts.length >= 2) {
      ctx.globalAlpha = 0.35; ctx.lineWidth = (it.width || 3) * 4 * sf();
      ctx.beginPath();
      pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
      ctx.stroke();
    } else if (it.type === "hlbox" && pts.length === 2) {
      ctx.globalAlpha = 0.28;
      ctx.fillRect(Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]),
        Math.abs(pts[1][0] - pts[0][0]), Math.abs(pts[1][1] - pts[0][1]));
    }
    ctx.restore();
  }
  function line(ctx, a, b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  function head(ctx, from, to, size) {
    var ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
    ctx.beginPath();
    ctx.moveTo(to[0], to[1]);
    ctx.lineTo(to[0] - size * Math.cos(ang - 0.45), to[1] - size * Math.sin(ang - 0.45));
    ctx.lineTo(to[0] - size * Math.cos(ang + 0.45), to[1] - size * Math.sin(ang + 0.45));
    ctx.closePath(); ctx.fill();
  }
  function pill(ctx, x, y, text, fg, bg) {
    var fs2 = 14 * sf();
    ctx.save();
    ctx.font = "bold " + fs2 + "px Arial";
    var w = ctx.measureText(text).width + 14 * sf(), h = fs2 + 10 * sf();
    ctx.fillStyle = bg || "rgba(20,20,20,.82)";
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - w / 2, y - h / 2, w, h, 5 * sf()); else ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, y);
    ctx.restore();
  }
  function redraw() {
    var ov = q("#paOv"), ctx = ov.getContext("2d");
    ctx.clearRect(0, 0, ov.width, ov.height);
    st.items.forEach(function (it) { drawItem(ctx, it); });
    if (st.draw) drawItem(ctx, st.draw);
  }

  /* ── history ── */
  function snapshot() {
    st.undo.push(JSON.stringify(st.items));
    if (st.undo.length > 60) st.undo.shift();
    st.redo = [];
  }
  function doUndo() {
    if (!st.undo.length) return;
    st.redo.push(JSON.stringify(st.items));
    st.items = JSON.parse(st.undo.pop());
    redraw();
  }
  function doRedo() {
    if (!st.redo.length) return;
    st.undo.push(JSON.stringify(st.items));
    st.items = JSON.parse(st.redo.pop());
    redraw();
  }

  /* ── hit testing (eraser) ── */
  function ptSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function hitTest(pt) {
    var TH = 14 * sf();
    for (var i = st.items.length - 1; i >= 0; i--) {
      var it = st.items[i], pts = it.pts;
      if (it.type === "text") { if (dist(pt, pts[0]) < TH * 2.5) return i; continue; }
      if (it.type === "hlbox" && pts.length === 2) {
        var x0 = Math.min(pts[0][0], pts[1][0]) - TH, x1 = Math.max(pts[0][0], pts[1][0]) + TH;
        var y0 = Math.min(pts[0][1], pts[1][1]) - TH, y1 = Math.max(pts[0][1], pts[1][1]) + TH;
        if (pt[0] >= x0 && pt[0] <= x1 && pt[1] >= y0 && pt[1] <= y1) return i;
        continue;
      }
      for (var s = 1; s < pts.length; s++) if (ptSeg(pt, pts[s - 1], pts[s]) < TH) return i;
    }
    return -1;
  }

  /* ── prompt modal (text / calibrate) ── */
  var promptCb = null;
  function openPrompt(mode, title, cb) {
    promptCb = cb;
    q("#paPromptTitle").textContent = title;
    q("#paPromptText").style.display = mode === "text" ? "" : "none";
    q("#paPromptCal").style.display = mode === "cal" ? "" : "none";
    if (mode === "text") { q("#paTextInput").value = ""; }
    else { q("#paCalFt").value = ""; q("#paCalIn").value = ""; }
    q("#paPrompt").classList.add("open");
    setTimeout(function () { (mode === "text" ? q("#paTextInput") : q("#paCalFt")).focus(); }, 60);
  }
  function closePrompt() { q("#paPrompt").classList.remove("open"); promptCb = null; }

  /* ── pointer handling ── */
  function evPt(e) {
    var ov = q("#paOv"), r = ov.getBoundingClientRect();
    return [(e.clientX - r.left) * (st.w / r.width), (e.clientY - r.top) * (st.h / r.height)];
  }
  function onDown(e) {
    if (!st || (e.button !== undefined && e.button !== 0)) return;
    var pt = evPt(e), t = st.tool;
    try { q("#paOv").setPointerCapture(e.pointerId); } catch (e2) { /* synthetic/stale pointer — capture is best-effort */ }
    if (t === "erase") {
      var hi = hitTest(pt);
      if (hi >= 0) { snapshot(); st.items.splice(hi, 1); redraw(); }
      st.drag = "erase";
      return;
    }
    if (t === "text") {
      openPrompt("text", "📝 Text note", function () {
        var v = q("#paTextInput").value.trim();
        if (v) { snapshot(); st.items.push({ type: "text", pts: [pt], color: st.color, text: v }); redraw(); markDirty(); }
      });
      return;
    }
    if (t === "hl") {
      st.draw = { type: "hl", pts: [pt], color: st.color, width: st.width };
      st.drag = "draw";
      return;
    }
    // two-point tools: arrow / measure / hlbox / cal
    st.draw = { type: t === "cal" ? "measure" : t, pts: [pt, pt], color: t === "cal" ? "#ff9800" : st.color, width: st.width, _cal: t === "cal" };
    st.drag = "draw";
  }
  function onMove(e) {
    if (!st.drag) return;
    var pt = evPt(e);
    if (st.drag === "erase" && e.buttons) {
      var hi = hitTest(pt);
      if (hi >= 0) { snapshot(); st.items.splice(hi, 1); redraw(); }
      return;
    }
    if (st.drag === "draw" && st.draw) {
      if (st.draw.type === "hl") st.draw.pts.push(pt);
      else st.draw.pts[1] = pt;
      redraw();
    }
  }
  function onUp() {
    if (st.drag === "draw" && st.draw) {
      var d = st.draw;
      st.draw = null;
      var isClick = d.pts.length === 2 && dist(d.pts[0], d.pts[1]) < 4 * sf();
      if (d.type === "hl" ? d.pts.length > 2 : !isClick) {
        if (d._cal) {
          // calibrate: ask the real length of the drawn line
          openPrompt("cal", "🎯 Calibrate this photo", function () {
            var ft = Number(q("#paCalFt").value) || 0, inch = Number(q("#paCalIn").value) || 0;
            var real = ft + inch / 12;
            if (real > 0) {
              st.ppf = dist(d.pts[0], d.pts[1]) / real;
              markDirty();
              hint("✓ Calibrated (" + st.ppf.toFixed(1) + " px/ft). Measurements now show real lengths.");
              setTool("measure");
            }
            redraw();
          });
        } else if (d.type === "measure" && !st.ppf) {
          // first measurement doubles as calibration
          openPrompt("cal", "🎯 First measurement — calibrate", function () {
            var ft = Number(q("#paCalFt").value) || 0, inch = Number(q("#paCalIn").value) || 0;
            var real = ft + inch / 12;
            if (real > 0) {
              st.ppf = dist(d.pts[0], d.pts[1]) / real;
              snapshot(); st.items.push(d); markDirty();
              hint("✓ Calibrated — keep measuring, labels show ft-in.");
            }
            redraw();
          });
        } else {
          snapshot(); st.items.push(d); markDirty();
        }
      }
      redraw();
    }
    st.drag = null;
  }

  /* ── ui helpers ── */
  function hint(t) { q("#paHint").textContent = t; }
  var HINTS = {
    arrow: "Arrow — drag from tail to tip.",
    text: "Text — click where the note should point.",
    measure: "Measure — drag between two points. First measurement calibrates the photo.",
    cal: "Calibrate — drag along something with a KNOWN length (a board, a door…), then enter it.",
    hl: "Highlighter — drag freehand.",
    hlbox: "Box highlight — drag a rectangle.",
    erase: "Eraser — click or drag over a markup to remove it.",
  };
  function setTool(t) {
    st.tool = t;
    ui.querySelectorAll(".pa-tool").forEach(function (b) { b.classList.toggle("on", b.dataset.tool === t); });
    hint(HINTS[t] || "");
  }
  function markDirty() { st.dirty = true; }

  function wireStatic() {
    ui.querySelectorAll(".pa-tool").forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    q("#paColors").innerHTML = COLORS.map(function (c, i) {
      return '<span class="pa-color' + (i === 0 ? " on" : "") + '" data-c="' + c + '" style="background:' + c + '"></span>';
    }).join("");
    ui.querySelectorAll(".pa-color").forEach(function (s2) {
      s2.onclick = function () {
        st.color = s2.dataset.c;
        ui.querySelectorAll(".pa-color").forEach(function (x) { x.classList.toggle("on", x === s2); });
      };
    });
    q("#paWidth").onchange = function () { st.width = Number(this.value); };
    q("#paUndo").onclick = function () { doUndo(); markDirty(); };
    q("#paRedo").onclick = function () { doRedo(); markDirty(); };
    q("#paCancel").onclick = close;
    q("#paSave").onclick = function () {
      if (st.onSave) st.onSave({ items: st.items, ppf: st.ppf || null });
      close();
    };
    q("#paPromptCancel").onclick = closePrompt;
    q("#paPromptOk").onclick = function () {
      var cb = promptCb;
      closePrompt();
      if (cb) cb();
    };
    var ov = q("#paOv");
    ov.addEventListener("pointerdown", onDown);
    ov.addEventListener("pointermove", onMove);
    ov.addEventListener("pointerup", onUp);
    ov.addEventListener("pointercancel", onUp);
  }

  function close() {
    ui.classList.remove("open");
    closePrompt();
    st = null;
  }

  function open(opts) {
    injectUi();
    var ann = (opts.entry && opts.entry.ann) || {};
    st = {
      entry: opts.entry, onSave: opts.onSave,
      items: (ann.items || []).map(function (x) { return JSON.parse(JSON.stringify(x)); }),
      ppf: ann.ppf || null,
      undo: [], redo: [], draw: null, drag: null, dirty: false,
      tool: "arrow", color: COLORS[0], width: 3, w: 0, h: 0,
    };
    q("#paTitle").textContent = opts.title || opts.entry.name || "Photo";
    q("#paWidth").value = "3";
    setTool("arrow");
    ui.classList.add("open");
    hint("Loading photo…");

    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      if (!st) return;
      st.w = img.naturalWidth; st.h = img.naturalHeight;
      var base = q("#paBase"), ov = q("#paOv");
      base.width = ov.width = st.w;
      base.height = ov.height = st.h;
      // fit within the stage
      var maxW = Math.min(window.innerWidth - 40, 1400);
      var maxH = window.innerHeight - 150;
      var scale = Math.min(maxW / st.w, maxH / st.h, 1);
      var cssW = Math.round(st.w * scale) + "px", cssH = Math.round(st.h * scale) + "px";
      base.style.width = ov.style.width = cssW;
      base.style.height = ov.style.height = cssH;
      base.getContext("2d").drawImage(img, 0, 0);
      redraw();
      hint(HINTS.arrow);
    };
    img.onerror = function () { hint("Could not load this photo."); };
    var entry = opts.entry;
    if (entry.id) {
      DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(entry.id))
        .then(function (u) { img.src = u; })
        .catch(function () { if (entry.url) img.src = entry.url; else hint("Could not load this photo."); });
    } else if (entry.url) img.src = entry.url;
  }

  window.DCRAnnotate = { open: open };
})();
