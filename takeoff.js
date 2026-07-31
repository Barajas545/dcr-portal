/* DCR portal — Takeoffs tab.

   A takeoff is the material list for a job: someone sits with the plan set and
   enters hundreds of lines. So the whole screen is built around typing, not
   clicking — every line is entered without touching the mouse, and the item name
   accepts the shorthand code from MaterialList ("2410df" → 2 x 4 x 10 Douglas Fir).

   Rows are grouped four deep: Takeoff → Location → Category → Sub-category.

   Everything destructive goes through one command log, so undo/redo covers edits,
   deletes, moves, copies and bulk actions alike. Commands address rows by a
   STABLE CLIENT KEY, never by SharePoint id — a delete-then-undo mints a brand
   new id, and a history holding raw ids would quietly point at a dead row.

   Exposed as DCR.takeoff: mount / setActive / invalidate. */

(function () {
  var DCR = (window.DCR = window.DCR || {});
  var esc = function (v) { return DCR.esc(v); };

  var UNITS = ["EA", "SF", "LF", "Roll", "Box"];      // one tap; the field takes anything
  var LEVELS = [
    { f: "takeoffName", label: "Takeoff" },
    { f: "itemLocation", label: "Location" },
    { f: "itemCategory", label: "Category" },
    { f: "itemSubCategory", label: "Sub-category" },
  ];
  var SEP = "\u0000";
  var BATCH = 40;                                     // server accepts 50
  var CAT_TTL = 30 * 60 * 1000;

  var T = null;   // live state, created by mount()

  /* ── small helpers ── */
  function el(id) { return document.getElementById(id); }
  function num(v) {
    if (typeof v === "number") return v;
    var n = parseFloat(String(v == null ? "" : v).replace(/[$,]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Group identity: null and "" are the same bucket; the LABEL is derived
  // separately so a group genuinely named "(none)" can't collide with it.
  function gkey(v) { return String(v == null ? "" : v); }
  function glabel(k) { return k === "" ? "(none)" : k; }
  function pathOf(r) { return LEVELS.map(function (L) { return gkey(r[L.f]); }).join(SEP); }
  function rowsEqual(a, b) { return a === b; }

  /* ── quantity: accept "12", "12.5", or "=8*3+2" ─────────────────────────
     A shunting-yard evaluator, not Function()/eval — a regex guard would let
     "=1//2" through as a line comment and silently return the wrong number. */
  function evalQty(src) {
    var s = String(src == null ? "" : src).trim();
    if (s.charAt(0) !== "=") return s;
    var expr = s.slice(1);
    var toks = expr.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
    if (!toks || toks.join("") !== expr.replace(/\s+/g, "")) return null;
    var out = [], ops = [], prec = { "+": 1, "-": 1, "*": 2, "/": 2 };
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (/^\d/.test(t)) out.push(parseFloat(t));
      else if (t === "(") ops.push(t);
      else if (t === ")") {
        while (ops.length && ops[ops.length - 1] !== "(") out.push(ops.pop());
        if (!ops.length) return null;
        ops.pop();
      } else {
        while (ops.length && ops[ops.length - 1] !== "(" && prec[ops[ops.length - 1]] >= prec[t]) out.push(ops.pop());
        ops.push(t);
      }
    }
    while (ops.length) { var o = ops.pop(); if (o === "(") return null; out.push(o); }
    var st = [];
    for (var j = 0; j < out.length; j++) {
      var v = out[j];
      if (typeof v === "number") { st.push(v); continue; }
      var b = st.pop(), a = st.pop();
      if (a === undefined || b === undefined) return null;
      st.push(v === "+" ? a + b : v === "-" ? a - b : v === "*" ? a * b : (b === 0 ? NaN : a / b));
    }
    if (st.length !== 1 || !isFinite(st[0])) return null;
    return String(Math.round(st[0] * 10000) / 10000);
  }

  /* ── material catalog + the shorthand matcher ─────────────────────────── */
  var STOP = { x: 1, ft: 1, in: 1, inch: 1, inches: 1, foot: 1, feet: 1, by: 1, of: 1, and: 1, the: 1 };

  function indexMaterial(m) {
    var name = String(m.itemName || "");
    m._name = name.toLowerCase();
    m._code = String(m.itemCode || "").toLowerCase().replace(/[\s-]/g, "");
    // "2 x 4 x 10 ft Douglas Fir" → digits "2410", initials "df"
    var digits = name.match(/\d+(?:\.\d+)?/g) || [];
    m._digits = digits.join("").replace(/\./g, "");
    var words = (name.toLowerCase().match(/[a-z]+/g) || []).filter(function (w) { return !STOP[w]; });
    m._inits = words.map(function (w) { return w.charAt(0); }).join("");
    m._words = words;
    return m;
  }

  // Returns up to `limit` matches, best first.
  function matchMaterials(q, limit) {
    var s = String(q || "").toLowerCase().trim();
    if (s.length < 2) return [];
    var flat = s.replace(/[\s-]/g, "");
    var qd = (flat.match(/\d+/g) || []).join("");
    var qa = (flat.match(/[a-z]+/g) || []).join("");
    var hits = [];
    var cat = T.catalog;
    for (var i = 0; i < cat.length; i++) {
      var m = cat[i], rank = -1;
      if (m._code && m._code === flat) rank = 0;
      else if (m._code && m._code.indexOf(flat) === 0) rank = 1;
      // the headline case: digits then initials, e.g. 2410df
      else if (qd && qa && m._digits.indexOf(qd) === 0 && m._inits.indexOf(qa) === 0) rank = 2;
      else if (qd && !qa && m._digits.indexOf(qd) === 0) rank = 3;
      else if (m._name.indexOf(s) === 0) rank = 4;
      else if (m._name.indexOf(s) !== -1) rank = 5;
      else if (qa && !qd && m._inits.indexOf(qa) === 0) rank = 6;
      if (rank >= 0) hits.push({ m: m, rank: rank });
    }
    // recently used in THIS project outrank catalog order at equal relevance
    hits.sort(function (a, b) {
      return a.rank - b.rank ||
        (T.mru[b.m._name] || 0) - (T.mru[a.m._name] || 0) ||
        a.m._name.length - b.m._name.length;
    });
    return hits.slice(0, limit || 8).map(function (h) { return h.m; });
  }

  async function loadCatalog() {
    var who = (T.profile && (T.profile.email || T.profile.id)) || "?";
    var ck = "dcrMatCat:" + who + ":" + (T.pricesHidden ? "np" : "p");
    try {
      var c = JSON.parse(sessionStorage.getItem(ck) || "null");
      if (c && c.at && Date.now() - c.at < CAT_TTL && c.rows) {
        T.catalog = c.rows.map(indexMaterial);
        return;
      }
    } catch (e) {}
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + T.pid + "&part=materials");
      T.catalog = (d.rows || []).map(indexMaterial);
      try { sessionStorage.setItem(ck, JSON.stringify({ at: Date.now(), rows: d.rows || [] })); } catch (e) {}
    } catch (e) {
      T.catalog = [];   // typing still works, just without suggestions
      T.catalogError = e.message || "Could not load the material list.";
    }
  }

  /* ── write queue ──────────────────────────────────────────────────────
     One in-flight write per row at a time, and queued updates for the same row
     collapse into one patch. Without that, two PATCHes to the same row can be
     reordered by the network and the older value wins. */
  function enqueue(ops, done) {
    T.queue.push({ ops: ops, done: done });
    drainQueue();
  }

  async function drainQueue() {
    if (T.draining || !T.queue.length) return;
    T.draining = true;
    while (T.queue.length) {
      var job = T.queue.shift();
      try {
        var res = await runOps(job.ops);
        if (job.done) job.done(null, res);
      } catch (e) {
        if (job.done) job.done(e);
      }
    }
    T.draining = false;
    render();
  }

  // Resolve client keys to live SharePoint ids, send in chunks, return per-op results.
  async function runOps(ops) {
    var results = [];
    for (var start = 0; start < ops.length; start += BATCH) {
      var chunk = ops.slice(start, start + BATCH);
      var wire = chunk.map(function (o) {
        var w = { kind: o.kind };
        if (o.kind !== "add") w.itemId = T.idByKey[o.key];
        if (o.kind !== "del") w.fields = o.fields;
        return w;
      });
      // A row whose id we never got (its add failed) can't be updated or deleted.
      for (var i = 0; i < wire.length; i++) {
        if (wire[i].kind !== "add" && !wire[i].itemId) {
          wire[i]._skip = true;
        }
      }
      var send = wire.filter(function (w) { return !w._skip; });
      var map = [];
      wire.forEach(function (w, i) { if (!w._skip) map.push(i); });
      var out = [];
      if (send.length) {
        var d = await DCR.api("/api/portal?action=project", {
          method: "POST", body: { op: "toBatch", projectId: T.pid, ops: send },
        });
        out = d.results || [];
      }
      chunk.forEach(function (o, i) {
        var pos = map.indexOf(i);
        var r = pos === -1
          ? { ok: false, error: "Row was never saved" }
          : (out[pos] || { ok: false, error: "No result" });
        if (r.ok && o.kind === "add" && r.id) T.idByKey[o.key] = r.id;
        if (r.ok && o.kind === "del") delete T.idByKey[o.key];
        results.push({ op: o, res: r });
      });
    }
    return results;
  }

  /* ── command log (undo / redo) ────────────────────────────────────────
     A command carries BOTH directions as data, so replaying either way is the
     same code path. Ops name rows by client key; ids are resolved at send time. */
  function apply(cmd) {
    T.redo.length = 0;
    runCommand(cmd, "do", function () {
      T.undo.push(cmd);
      if (T.undo.length > 100) T.undo.shift();
      render();
    });
  }

  function runCommand(cmd, dir, after) {
    var ops = dir === "do" ? cmd.ops : cmd.inverse;
    // local state first so the screen reacts immediately
    ops.forEach(function (o) { applyLocal(o); });
    render();
    enqueue(ops, function (err, results) {
      var failed = [];
      (results || []).forEach(function (r) {
        if (r.res.ok) return;
        failed.push(r);
        // Roll back exactly what didn't land.
        if (r.op.kind === "upd") applyLocal({ kind: "upd", key: r.op.key, fields: r.op.before || {} });
        if (r.op.kind === "del" && r.op.snapshot) applyLocal({ kind: "add", key: r.op.key, fields: r.op.snapshot });
        if (r.op.kind === "add") markRow(r.op.key, "err");
        if (r.res.gone) removeLocal(r.op.key);
      });
      if (err) {
        msg("err", err.message || "Could not save — nothing was changed on the server.");
        ops.forEach(function (o) { revertLocal(o); });
      } else if (failed.length) {
        msg("err", (ops.length - failed.length) + " of " + ops.length + " saved · " +
          (failed[0].res.error || "some rows failed"));
        // A half-applied command cannot be redone soundly.
        T.redo.length = 0;
      } else {
        msg("ok", (dir === "undo" ? "↶ Undone: " : "✓ ") + (cmd.label || "Saved"));
      }
      if (after) after(failed.length ? "partial" : null);
      render();
    });
  }

  function applyLocal(o) {
    if (o.kind === "add") {
      if (!T.rowByKey[o.key]) {
        var r = { _k: o.key, id: null };
        Object.keys(o.fields || {}).forEach(function (k) { r[k] = o.fields[k]; });
        T.rowByKey[o.key] = r;
        T.rows.push(r);
      }
      return;
    }
    if (o.kind === "del") { removeLocal(o.key); return; }
    if (o.kind === "upd") {
      var row = T.rowByKey[o.key];
      if (!row) return;
      Object.keys(o.fields || {}).forEach(function (k) { row[k] = o.fields[k]; });
    }
  }
  function revertLocal(o) {
    if (o.kind === "add") removeLocal(o.key);
    else if (o.kind === "del" && o.snapshot) applyLocal({ kind: "add", key: o.key, fields: o.snapshot });
    else if (o.kind === "upd" && o.before) applyLocal({ kind: "upd", key: o.key, fields: o.before });
  }
  function removeLocal(key) {
    var row = T.rowByKey[key];
    if (!row) return;
    var i = T.rows.indexOf(row);
    if (i > -1) T.rows.splice(i, 1);
    delete T.rowByKey[key];
    delete T.sel[key];
  }
  function markRow(key, cls) { T.rowFlag[key] = cls; }

  function doUndo() {
    if (!T.undo.length) return;
    var cmd = T.undo.pop();
    runCommand(cmd, "undo", function (partial) {
      if (partial) T.undo.push(cmd);          // residual stays undoable
      else T.redo.push(cmd);
      render();
    });
  }
  function doRedo() {
    if (!T.redo.length) return;
    var cmd = T.redo.pop();
    runCommand(cmd, "do", function (partial) {
      if (!partial) T.undo.push(cmd);
      render();
    });
  }

  /* ── command builders ── */
  var keySeq = 0;
  function newKey() { return "k" + (++keySeq); }

  function cmdAdd(fields) {
    var key = newKey();
    return {
      label: "Added item",
      ops: [{ kind: "add", key: key, fields: fields }],
      inverse: [{ kind: "del", key: key, snapshot: fields }],
      newKey: key,
    };
  }
  function cmdUpdate(key, fields, label) {
    var row = T.rowByKey[key] || {};
    var before = {};
    Object.keys(fields).forEach(function (f) { before[f] = row[f] == null ? null : row[f]; });
    return {
      label: label || "Edited item",
      ops: [{ kind: "upd", key: key, fields: fields, before: before }],
      inverse: [{ kind: "upd", key: key, fields: before, before: fields }],
    };
  }
  function cmdDelete(keys) {
    var ops = [], inv = [];
    keys.forEach(function (k) {
      var row = T.rowByKey[k];
      if (!row) return;
      var snap = snapshot(row);
      ops.push({ kind: "del", key: k, snapshot: snap });
      inv.push({ kind: "add", key: k, fields: snap });
    });
    return { label: "Deleted " + ops.length + " item" + (ops.length === 1 ? "" : "s"), ops: ops, inverse: inv };
  }
  function cmdMove(keys, target) {
    var ops = [], inv = [];
    keys.forEach(function (k) {
      var row = T.rowByKey[k];
      if (!row) return;
      var fields = {}, before = {};
      LEVELS.forEach(function (L) {
        if (!(L.f in target)) return;                    // "keep this level"
        fields[L.f] = target[L.f];                       // value, or null to clear
        before[L.f] = row[L.f] == null ? null : row[L.f];
      });
      if (!Object.keys(fields).length) return;
      ops.push({ kind: "upd", key: k, fields: fields, before: before });
      inv.push({ kind: "upd", key: k, fields: before, before: fields });
    });
    return { label: "Moved " + ops.length + " item" + (ops.length === 1 ? "" : "s"), ops: ops, inverse: inv };
  }
  function cmdCopy(keys, target) {
    var ops = [], inv = [];
    keys.forEach(function (k) {
      var row = T.rowByKey[k];
      if (!row) return;
      var snap = snapshot(row);
      LEVELS.forEach(function (L) { if (L.f in target) snap[L.f] = target[L.f]; });
      // A copy is its own line — never inherit the estimate link, or the estimate
      // item editor shows phantom duplicates and doubles its takeoff total.
      snap.itemGeneralProjectTasksID = null;
      var nk = newKey();
      ops.push({ kind: "add", key: nk, fields: snap });
      inv.push({ kind: "del", key: nk, snapshot: snap });
    });
    return { label: "Copied " + ops.length + " item" + (ops.length === 1 ? "" : "s"), ops: ops, inverse: inv };
  }
  var SNAP_FIELDS = ["takeoffName", "itemLocation", "itemCategory", "itemSubCategory",
    "itemPurpose", "itemName", "itemQty", "itemType", "itemPrice", "itemSortingNumber",
    "itemCalculationFormula", "itemHiperLink", "takeoffID", "itemGeneralProjectTasksID"];
  function snapshot(row) {
    var o = {};
    SNAP_FIELDS.forEach(function (f) { if (row[f] != null && row[f] !== "") o[f] = row[f]; });
    return o;
  }

  /* ── selection ── */
  function selKeys() { return Object.keys(T.sel).filter(function (k) { return T.sel[k] && T.rowByKey[k]; }); }
  function pruneSel() {
    Object.keys(T.sel).forEach(function (k) { if (!T.rowByKey[k]) delete T.sel[k]; });
  }

  /* ── grouping ── */
  function visibleRows() {
    var q = (T.filter || "").toLowerCase().trim();
    var rows = T.rows;
    if (q) {
      rows = rows.filter(function (r) {
        return [r.itemName, r.itemPurpose, r.itemCategory, r.itemSubCategory,
          r.takeoffName, r.itemLocation, r.itemType].filter(Boolean).join(" ").toLowerCase().indexOf(q) !== -1;
      });
    }
    return rows.slice().sort(function (a, b) {
      var pa = pathOf(a), pb = pathOf(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      return (num(a.itemSortingNumber) - num(b.itemSortingNumber)) || (num(a.id) - num(b.id));
    });
  }

  function tree(rows) {
    var out = [], seen = {};
    rows.forEach(function (r) {
      var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
      for (var d = 0; d < 4; d++) {
        var p = keys.slice(0, d + 1).join(SEP);
        if (!seen[p]) { seen[p] = { depth: d, key: keys[d], path: p, rows: [] }; out.push(seen[p]); }
        seen[p].rows.push(r);
      }
      seen[keys.join(SEP)].leaf = true;
    });
    return { nodes: out, index: seen };
  }

  /* ── messages ──
     Held in state, not just in the DOM: almost every message is followed by a
     re-render, which would otherwise wipe it before anyone read it. */
  function msg(kind, text) {
    T.msg = text ? { kind: kind || "", text: text, at: Date.now() } : null;
    paintMsg();
    if (kind === "ok") {
      var stamp = T.msg && T.msg.at;
      setTimeout(function () {
        if (T.msg && T.msg.at === stamp) { T.msg = null; paintMsg(); }
      }, 4000);
    }
  }
  function paintMsg() {
    var m = el("toMsg");
    if (!m) return;
    m.className = "pj-msg " + (T.msg ? T.msg.kind : "");
    m.textContent = T.msg ? T.msg.text : "";
  }

  /* ── rendering ─────────────────────────────────────────────────────── */
  function render() {
    if (!T || !T.pane || !T.active) return;
    pruneSel();
    var rows = visibleRows();
    var t = tree(rows);
    var canEdit = T.canEdit;
    var showPrice = !T.pricesHidden;
    var cols = 5 + (showPrice ? 2 : 0) + (canEdit ? 2 : 0);

    var sel = selKeys();
    var hiddenSel = sel.filter(function (k) { return rows.indexOf(T.rowByKey[k]) === -1; }).length;

    var body = "";
    var open = T.collapsed;
    var skipDepth = -1;
    t.nodes.forEach(function (n) { n._emitted = false; });

    // Walk rows in order, emitting group headers as the path changes.
    var prev = ["\u0001", "\u0001", "\u0001", "\u0001"];
    var groupTotals = {};
    rows.forEach(function (r) {
      var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
      for (var d = 0; d < 4; d++) {
        var p = keys.slice(0, d + 1).join(SEP);
        groupTotals[p] = (groupTotals[p] || 0) + num(r.itemQty) * num(r.itemPrice);
      }
    });

    rows.forEach(function (r) {
      var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
      for (var d = 0; d < 4; d++) {
        if (keys[d] === prev[d] && keys.slice(0, d).join(SEP) === prev.slice(0, d).join(SEP)) continue;
        // A blank level with nothing filled in below it gets no header of its
        // own - an unfiled row should not cost four rows of "(none)".
        if (d > 0 && keys[d] === "") {
          var deeper = false;
          for (var q = d + 1; q < 4; q++) if (keys[q] !== "") deeper = true;
          if (!deeper) { prev[d] = keys[d]; continue; }
        }
        var p = keys.slice(0, d + 1).join(SEP);
        var isCol = !!open[p];
        body += groupRow(p, d, keys[d], t.index[p], groupTotals[p], cols, isCol, showPrice, canEdit);
        for (var k = d; k < 4; k++) prev[k] = "\u0001";
      }
      prev = keys;
      // hide rows under a collapsed ancestor
      var hidden = false;
      for (var d2 = 0; d2 < 4; d2++) {
        if (open[keys.slice(0, d2 + 1).join(SEP)]) { hidden = true; break; }
      }
      if (!hidden) body += itemRow(r, showPrice, canEdit);
    });

    if (canEdit) body += addRow(cols, showPrice);

    var grand = rows.reduce(function (s, r) { return s + num(r.itemQty) * num(r.itemPrice); }, 0);
    if (showPrice && rows.length) {
      body += '<tr class="pj-grand"><td colspan="' + (cols - (canEdit ? 3 : 1)) + '">GRAND TOTAL</td>' +
        '<td class="num"></td><td class="num">' + money(grand) + "</td>" + (canEdit ? "<td></td><td></td>" : "") + "</tr>";
    }

    var head = "<tr>" +
      (canEdit ? '<th class="to-cbc"><input type="checkbox" id="toAllCb" title="Select everything shown"></th>' : "") +
      "<th>Item</th><th>Purpose</th><th class=\"num\">Qty</th><th>Unit</th>" +
      (showPrice ? '<th class="num">Price</th><th class="num">Total</th>' : "") +
      (canEdit ? "<th></th>" : "") + "</tr>";

    T.pane.innerHTML =
      toolbar(sel.length, hiddenSel, canEdit) +
      '<div class="pj-msg" id="toMsg"></div>' +
      (T.rows.length
        ? '<div class="pj-tblwrap"><table class="pj-tbl pj-totbl"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>"
        : '<div class="pj-empty">No takeoff items yet.' + (canEdit ? " Use the row at the top of the table to add the first one." : "") + "</div>") +
      (T.rows.length && !rows.length ? '<div class="pj-empty">No items match “' + esc(T.filter) + '”.</div>' : "");

    wire();
    paintMsg();
  }

  function toolbar(nSel, nHidden, canEdit) {
    var undoT = T.undo.length ? T.undo[T.undo.length - 1].label : "";
    var redoT = T.redo.length ? T.redo[T.redo.length - 1].label : "";
    return '<div class="pj-bar to-bar">' +
      '<input class="pj-search" id="toSearch" placeholder="Search items…" value="' + esc(T.filter || "") + '">' +
      '<span class="pj-sub" id="toCount"></span>' +
      '<span class="to-sp"></span>' +
      (canEdit
        ? '<button class="pj-btn pj-btn-sm" id="toUndo"' + (T.undo.length ? "" : " disabled") +
            ' title="' + esc(undoT ? "Undo: " + undoT : "Nothing to undo") + '">↶ Undo</button>' +
          '<button class="pj-btn pj-btn-sm" id="toRedo"' + (T.redo.length ? "" : " disabled") +
            ' title="' + esc(redoT ? "Redo: " + redoT : "Nothing to redo") + '">↷ Redo</button>'
        : "") +
      '<button class="pj-btn pj-btn-sm" id="toExpand">⇱ Expand all</button>' +
      (canEdit && nSel
        ? '<span class="to-selbar"><b>' + nSel + " selected</b>" +
            (nHidden ? ' <span class="pj-sub">(' + nHidden + " hidden by the search)</span>" : "") +
            '<button class="pj-btn pj-btn-sm" id="toMove">→ Move to…</button>' +
            '<button class="pj-btn pj-btn-sm" id="toCopy">⧉ Copy to…</button>' +
            '<button class="pj-btn pj-btn-sm pj-btn-danger" id="toDel">🗑 Delete</button>' +
            '<button class="pj-btn pj-btn-sm" id="toClearSel">Clear</button></span>'
        : "") +
      "</div>";
  }

  function groupRow(path, depth, key, node, total, cols, collapsed, showPrice, canEdit) {
    var n = node ? node.rows.length : 0;
    return '<tr class="pj-grp to-g' + depth + '" data-gpath="' + esc(path) + '">' +
      (canEdit ? '<td class="to-cbc"><input type="checkbox" data-gsel="' + esc(path) + '" title="Select this group"></td>' : "") +
      '<td colspan="' + (cols - (canEdit ? 2 : 1)) + '">' +
        '<span class="to-caret" data-gtog="' + esc(path) + '">' + (collapsed ? "▸" : "▾") + "</span> " +
        '<span class="to-glabel">' + esc(glabel(key)) + "</span>" +
        ' <span class="pj-sub">· ' + n + " item" + (n === 1 ? "" : "s") + "</span>" +
      "</td>" +
      (showPrice ? '<td class="num">' + (total ? money(total) : "") + "</td>" : "") +
      (canEdit ? "<td></td>" : "") + "</tr>";
  }

  function itemRow(r, showPrice, canEdit) {
    var tot = num(r.itemQty) * num(r.itemPrice);
    var flag = T.rowFlag[r._k] ? " to-" + T.rowFlag[r._k] : "";
    var pending = r.id == null ? " to-pending" : "";
    return '<tr class="to-row' + flag + pending + (T.sel[r._k] ? " to-sel" : "") + '" data-k="' + esc(r._k) + '">' +
      (canEdit ? '<td class="to-cbc"><input type="checkbox" data-rsel="' + esc(r._k) + '"' + (T.sel[r._k] ? " checked" : "") + "></td>" : "") +
      '<td class="to-name"' + (canEdit ? ' data-edit="itemName"' : "") + ">" + esc(r.itemName || "—") + "</td>" +
      '<td class="to-purpose"' + (canEdit ? ' data-edit="itemPurpose"' : "") + ">" + esc(r.itemPurpose || "") + "</td>" +
      '<td class="num"' + (canEdit ? ' data-edit="itemQty"' : "") + ">" + esc(r.itemQty == null ? "" : r.itemQty) + "</td>" +
      '<td' + (canEdit ? ' data-edit="itemType"' : "") + ">" + esc(r.itemType || "") + "</td>" +
      (showPrice
        ? '<td class="num"' + (canEdit ? ' data-edit="itemPrice"' : "") + ">" + (num(r.itemPrice) ? money(r.itemPrice) : "") + "</td>" +
          '<td class="num">' + (tot ? money(tot) : "") + "</td>"
        : "") +
      (canEdit ? '<td class="to-actc"><button class="pj-btn pj-btn-sm" data-detail="' + esc(r._k) + '" title="Open details">⋯</button></td>' : "") +
      "</tr>";
  }

  // The fast-entry line: type, Enter, type the next one. Group fields stick.
  function addRow(cols, showPrice) {
    var g = T.entry;
    return '<tr class="to-addrow"><td class="to-cbc">＋</td>' +
      '<td><input id="toNName" class="to-in" placeholder="Item name or code (e.g. 2410df)" autocomplete="off"><div id="toSug" class="to-sug"></div></td>' +
      '<td><input id="toNPurpose" class="to-in" placeholder="Purpose" value="' + esc(g.itemPurpose || "") + '" autocomplete="off"></td>' +
      '<td class="num"><input id="toNQty" class="to-in to-inq" placeholder="Qty" autocomplete="off"></td>' +
      '<td><input id="toNType" class="to-in to-inu" placeholder="Unit" value="' + esc(g.itemType || "") + '" list="toUnits" autocomplete="off">' +
        '<datalist id="toUnits">' + UNITS.map(function (u) { return '<option value="' + u + '">'; }).join("") + "</datalist></td>" +
      (showPrice ? '<td class="num"><input id="toNPrice" class="to-in to-inq" placeholder="Price" autocomplete="off"></td><td></td>' : "") +
      '<td class="to-actc"><button class="pj-btn pj-btn-sm pj-btn-primary" id="toNAdd" title="Add (Enter)">＋</button></td></tr>' +
      '<tr class="to-addwhere"><td></td><td colspan="' + (cols - 1) + '">' +
        "Adding to: " + LEVELS.map(function (L, i) {
          return '<input class="to-gin" data-gfield="' + L.f + '" placeholder="' + esc(L.label) + '" value="' +
            esc(g[L.f] || "") + '" list="toL' + i + '" autocomplete="off">';
        }).join(' <span class="to-arrow">›</span> ') +
        LEVELS.map(function (L, i) {
          var vals = {};
          T.rows.forEach(function (r) { if (r[L.f]) vals[r[L.f]] = 1; });
          return '<datalist id="toL' + i + '">' + Object.keys(vals).sort().map(function (v) {
            return '<option value="' + esc(v) + '">';
          }).join("") + "</datalist>";
        }).join("") +
      "</td></tr>";
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */
  function wire() {
    var s = el("toSearch");
    if (s) {
      s.oninput = function () {
        T.filter = this.value;
        clearTimeout(T.qTimer);
        T.qTimer = setTimeout(function () {
          render();
          var b = el("toSearch");
          if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); }
        }, 200);
      };
    }
    var cnt = el("toCount");
    if (cnt) {
      var shown = visibleRows().length;
      cnt.textContent = shown === T.rows.length
        ? T.rows.length + " items"
        : shown + " of " + T.rows.length + " items";
    }

    bind("toUndo", doUndo); bind("toRedo", doRedo);
    bind("toExpand", function () {
      var any = Object.keys(T.collapsed).length;
      if (any) T.collapsed = {};
      else visibleRows().forEach(function (r) {
        LEVELS.forEach(function (L, d) {
          T.collapsed[LEVELS.slice(0, d + 1).map(function (X) { return gkey(r[X.f]); }).join(SEP)] = d < 3 ? 0 : 1;
        });
      });
      render();
    });
    bind("toClearSel", function () { T.sel = {}; render(); });
    bind("toMove", function () { openMoveCopy("move"); });
    bind("toCopy", function () { openMoveCopy("copy"); });
    bind("toDel", function () {
      var keys = selKeys();
      if (!keys.length) return;
      if (keys.length > 5 && !confirm("Delete " + keys.length + " takeoff items?\n\nYou can undo this, but it is a lot of rows.")) return;
      T.sel = {};
      apply(cmdDelete(keys));
    });

    T.pane.querySelectorAll("[data-gtog]").forEach(function (b) {
      b.onclick = function () {
        var p = b.getAttribute("data-gtog");
        if (T.collapsed[p]) delete T.collapsed[p]; else T.collapsed[p] = 1;
        render();
      };
    });
    T.pane.querySelectorAll("[data-gsel]").forEach(function (cb) {
      cb.onchange = function () {
        var p = cb.getAttribute("data-gsel");
        visibleRows().forEach(function (r) {
          var rp = LEVELS.map(function (L) { return gkey(r[L.f]); }).join(SEP);
          if (rp === p || rp.indexOf(p + SEP) === 0) {
            if (cb.checked) T.sel[r._k] = 1; else delete T.sel[r._k];
          }
        });
        render();
      };
    });
    T.pane.querySelectorAll("[data-rsel]").forEach(function (cb) {
      cb.onchange = function () {
        var k = cb.getAttribute("data-rsel");
        if (cb.checked) T.sel[k] = 1; else delete T.sel[k];
        render();
      };
    });
    var all = el("toAllCb");
    if (all) all.onchange = function () {
      if (all.checked) visibleRows().forEach(function (r) { T.sel[r._k] = 1; });
      else T.sel = {};
      render();
    };
    T.pane.querySelectorAll("[data-detail]").forEach(function (b) {
      b.onclick = function () { openDetail(b.getAttribute("data-detail")); };
    });
    T.pane.querySelectorAll("tr.to-row").forEach(function (tr) {
      tr.ondblclick = function (e) {
        if (e.target && e.target.tagName === "INPUT") return;
        openDetail(tr.getAttribute("data-k"));
      };
    });
    if (T.canEdit) {
      T.pane.querySelectorAll("[data-edit]").forEach(function (td) {
        td.onclick = function () { editCell(td); };
      });
      wireAddRow();
    }
  }
  function bind(id, fn) { var b = el(id); if (b) b.onclick = fn; }

  /* ── inline cell editing ── */
  function editCell(td) {
    if (td.querySelector("input")) return;
    var tr = td.parentNode, key = tr.getAttribute("data-k"), field = td.getAttribute("data-edit");
    var row = T.rowByKey[key];
    if (!row) return;
    var raw = row[field] == null ? "" : String(row[field]);
    var inp = document.createElement("input");
    inp.className = "to-in";
    inp.value = raw;
    if (field === "itemType") inp.setAttribute("list", "toUnits");
    td.textContent = "";
    td.appendChild(inp);
    inp.focus(); inp.select();
    var done = false;
    function commit(next) {
      if (done) return; done = true;
      var v = inp.value;
      if (field === "itemQty") {
        var q = evalQty(v);
        if (q === null) { msg("err", "That quantity isn't a number or a formula."); render(); return; }
        v = q;
      }
      if (v !== raw) {
        var patch = {}; patch[field] = v === "" ? null : v;
        apply(cmdUpdate(key, patch));
      } else render();
      if (next) setTimeout(function () { focusNextCell(key, field); }, 0);
    }
    inp.onblur = function () { commit(false); };
    inp.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(false); }
      else if (e.key === "Tab") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { done = true; render(); }
    };
  }
  var EDIT_ORDER = ["itemName", "itemPurpose", "itemQty", "itemType", "itemPrice"];
  function focusNextCell(key, field) {
    var i = EDIT_ORDER.indexOf(field);
    for (var j = i + 1; j < EDIT_ORDER.length; j++) {
      var td = T.pane.querySelector('tr[data-k="' + key + '"] [data-edit="' + EDIT_ORDER[j] + '"]');
      if (td) { editCell(td); return; }
    }
  }

  /* ── the fast-entry row ── */
  function wireAddRow() {
    var name = el("toNName"), qty = el("toNQty"), type = el("toNType"),
        purpose = el("toNPurpose"), price = el("toNPrice");
    if (!name) return;

    T.pane.querySelectorAll("[data-gfield]").forEach(function (i) {
      i.onchange = function () { T.entry[i.getAttribute("data-gfield")] = i.value; };
    });
    if (purpose) purpose.onchange = function () { T.entry.itemPurpose = purpose.value; };
    if (type) type.onchange = function () { T.entry.itemType = type.value; };

    var sug = el("toSug"), picks = [], cur = -1;
    function closeSug() { sug.innerHTML = ""; sug.classList.remove("on"); picks = []; cur = -1; }
    function showSug() {
      picks = matchMaterials(name.value, 8);
      if (!picks.length) { closeSug(); return; }
      sug.innerHTML = picks.map(function (m, i) {
        return '<div class="to-sugi' + (i === cur ? " on" : "") + '" data-si="' + i + '">' +
          '<span class="to-sugn">' + esc(m.itemName || "") + "</span>" +
          (m.itemCode ? '<span class="to-sugc">' + esc(m.itemCode) + "</span>" : "") +
          (m.itemType ? '<span class="to-sugt">' + esc(m.itemType) + "</span>" : "") +
          (m.itemPrice != null && num(m.itemPrice) ? '<span class="to-sugp">' + money(m.itemPrice) + "</span>" : "") +
          "</div>";
      }).join("");
      sug.classList.add("on");
      sug.querySelectorAll("[data-si]").forEach(function (d) {
        d.onmousedown = function (e) { e.preventDefault(); choose(picks[+d.getAttribute("data-si")]); };
      });
    }
    function choose(m) {
      if (!m) return;
      name.value = m.itemName || "";
      if (m.itemType && !type.value) type.value = m.itemType;
      if (price && m.itemPrice != null && !price.value) price.value = num(m.itemPrice) || "";
      if (m.itemCategory && !T.entry.itemCategory) setGroupField("itemCategory", m.itemCategory);
      if (m.itemSubCategory && !T.entry.itemSubCategory) setGroupField("itemSubCategory", m.itemSubCategory);
      closeSug();
      qty.focus();
    }
    name.oninput = function () { cur = -1; showSug(); };
    name.onblur = function () { setTimeout(closeSug, 120); };
    name.onkeydown = function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (picks.length) { cur = Math.min(cur + 1, picks.length - 1); showSug(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (picks.length) { cur = Math.max(cur - 1, 0); showSug(); } }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (cur >= 0 && picks[cur]) choose(picks[cur]);
        else if (picks.length === 1 && name.value.length >= 2 && !picks[0]._name.startsWith(name.value.toLowerCase())) choose(picks[0]);
        else qty.focus();
      } else if (e.key === "Escape") closeSug();
    };

    [qty, type, purpose, price].forEach(function (i) {
      if (!i) return;
      i.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); commitNew(); } };
    });
    bind("toNAdd", commitNew);

    function setGroupField(f, v) {
      T.entry[f] = v;
      var i = T.pane.querySelector('[data-gfield="' + f + '"]');
      if (i) i.value = v;
    }

    function commitNew() {
      var nm = name.value.trim();
      if (!nm) { name.focus(); return; }
      var q = evalQty(qty.value.trim());
      if (q === null) { msg("err", "That quantity isn't a number or a formula."); qty.focus(); return; }
      var fields = {
        itemName: nm,
        itemPurpose: purpose.value.trim() || null,
        itemQty: q || null,
        itemType: type.value.trim() || null,
      };
      if (price && price.value.trim()) fields.itemPrice = num(price.value);
      LEVELS.forEach(function (L) { fields[L.f] = T.entry[L.f] || null; });
      // append within its leaf group
      var sibs = T.rows.filter(function (r) {
        return LEVELS.every(function (L) { return gkey(r[L.f]) === gkey(fields[L.f]); });
      });
      fields.itemSortingNumber = sibs.reduce(function (m, r) { return Math.max(m, num(r.itemSortingNumber)); }, 0) + 10;
      T.mru[nm.toLowerCase()] = Date.now();
      apply(cmdAdd(fields));
      // keep the group + purpose + unit; clear what changes per line
      setTimeout(function () {
        var n2 = el("toNName");
        if (n2) { n2.value = ""; n2.focus(); }
        var q2 = el("toNQty"); if (q2) q2.value = "";
        var p2 = el("toNPrice"); if (p2) p2.value = "";
      }, 0);
    }
  }

  /* ── move / copy dialog ── */
  function openMoveCopy(mode) {
    var keys = selKeys();
    if (!keys.length) return;
    var vals = {};
    LEVELS.forEach(function (L) {
      var s = {};
      T.rows.forEach(function (r) { if (r[L.f]) s[r[L.f]] = 1; });
      vals[L.f] = Object.keys(s).sort();
    });
    // Show what the selection currently has, so "keep" is meaningful.
    var cur = {};
    LEVELS.forEach(function (L) {
      var set = {};
      keys.forEach(function (k) { set[gkey(T.rowByKey[k][L.f])] = 1; });
      var u = Object.keys(set);
      cur[L.f] = u.length === 1 ? glabel(u[0]) : "(" + u.length + " different)";
    });
    el("toMcTitle").textContent = (mode === "move" ? "Move " : "Copy ") + keys.length + " item" + (keys.length === 1 ? "" : "s") + " to…";
    el("toMcBody").innerHTML = LEVELS.map(function (L, i) {
      return '<div class="pj-f"><label>' + esc(L.label) + ' <span class="pj-sub">now: ' + esc(cur[L.f]) + "</span></label>" +
        '<select class="to-mcmode" data-mc="' + L.f + '">' +
          '<option value="keep">Keep as it is</option>' +
          '<option value="set">Change to…</option>' +
          '<option value="clear">Clear it</option></select>' +
        '<input class="to-mcval" data-mcv="' + L.f + '" list="toMc' + i + '" placeholder="' + esc(L.label) + '" style="display:none">' +
        '<datalist id="toMc' + i + '">' + vals[L.f].map(function (v) { return '<option value="' + esc(v) + '">'; }).join("") + "</datalist></div>";
    }).join("");
    el("toMcBody").querySelectorAll("[data-mc]").forEach(function (s) {
      s.onchange = function () {
        var inp = el("toMcBody").querySelector('[data-mcv="' + s.getAttribute("data-mc") + '"]');
        inp.style.display = s.value === "set" ? "" : "none";
        if (s.value === "set") inp.focus();
      };
    });
    el("toMcGo").textContent = mode === "move" ? "Move" : "Copy";
    el("toMcGo").onclick = function () {
      var target = {};
      LEVELS.forEach(function (L) {
        var mSel = el("toMcBody").querySelector('[data-mc="' + L.f + '"]').value;
        if (mSel === "keep") return;
        if (mSel === "clear") { target[L.f] = null; return; }
        var v = el("toMcBody").querySelector('[data-mcv="' + L.f + '"]').value.trim();
        target[L.f] = v === "" ? null : v;
      });
      if (!Object.keys(target).length) { msg("err", "Nothing to change — every level is set to keep."); return; }
      el("toMcModal").classList.remove("open");
      T.sel = {};
      apply(mode === "move" ? cmdMove(keys, target) : cmdCopy(keys, target));
    };
    el("toMcModal").classList.add("open");
  }

  /* ── item detail ── */
  var DETAIL = [
    ["itemName", "Item name", "text"], ["itemPurpose", "Purpose", "text"],
    ["itemQty", "Quantity", "text"], ["itemType", "Unit", "unit"],
    ["itemPrice", "Unit price", "num"],
    ["takeoffName", "Takeoff", "text"], ["itemLocation", "Location", "text"],
    ["itemCategory", "Category", "text"], ["itemSubCategory", "Sub-category", "text"],
    ["itemCalculationFormula", "How it was measured", "area"],
    ["itemHiperLink", "Link (product page / cut sheet)", "text"],
    ["itemSortingNumber", "Order in its group", "num"],
  ];
  function openDetail(key) {
    var row = T.rowByKey[key];
    if (!row) return;
    T.detailKey = key;
    el("toDtTitle").textContent = row.itemName || "Takeoff item";
    el("toDtMsg").textContent = "";
    el("toDtBody").innerHTML = DETAIL.map(function (d) {
      if (!T.pricesHidden || d[0] !== "itemPrice") {
        var v = row[d[0]] == null ? "" : row[d[0]];
        if (d[2] === "area") {
          return '<div class="pj-f full"><label>' + esc(d[1]) + "</label><textarea id=\"dt_" + d[0] + '" rows="3"' +
            (T.canEdit ? "" : " disabled") + ">" + esc(v) + "</textarea></div>";
        }
        return '<div class="pj-f"><label>' + esc(d[1]) + "</label><input id=\"dt_" + d[0] + '" value="' + esc(v) + '"' +
          (d[2] === "unit" ? ' list="toUnits"' : "") + (T.canEdit ? "" : " disabled") + "></div>";
      }
      return "";
    }).join("") +
      '<div class="pj-f full"><label>Total</label><input value="' +
        esc(T.pricesHidden ? "—" : money(num(row.itemQty) * num(row.itemPrice))) + '" disabled></div>';
    el("toDtSave").style.display = T.canEdit ? "" : "none";
    el("toDtModal").classList.add("open");
  }
  function saveDetail() {
    var key = T.detailKey, row = T.rowByKey[key];
    if (!row) { el("toDtModal").classList.remove("open"); return; }
    var patch = {}, changed = false;
    for (var i = 0; i < DETAIL.length; i++) {
      var f = DETAIL[i][0];
      var inp = el("dt_" + f);
      if (!inp) continue;
      var v = inp.value.trim();
      if (f === "itemQty") {
        var q = evalQty(v);
        if (q === null) { el("toDtMsg").textContent = "That quantity isn't a number or a formula."; return; }
        v = q;
      }
      var was = row[f] == null ? "" : String(row[f]);
      if (v !== was) { patch[f] = v === "" ? null : v; changed = true; }
    }
    el("toDtModal").classList.remove("open");
    if (changed) apply(cmdUpdate(key, patch, "Edited " + (row.itemName || "item")));
  }

  /* ── keyboard ── */
  function onKey(e) {
    if (!T || !T.active || !T.canEdit) return;
    var tag = (e.target && e.target.tagName) || "";
    var inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    var inModal = e.target && e.target.closest && e.target.closest(".pj-overlay");
    if (inModal) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !inField) {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if (mod && e.key.toLowerCase() === "y" && !inField) {
      e.preventDefault(); doRedo();
    } else if (e.key === "Delete" && !inField && selKeys().length) {
      e.preventDefault(); var b = el("toDel"); if (b) b.click();
    }
  }

  /* ── public API ── */
  DCR.takeoff = {
    async mount(opts) {
      var first = !T || T.pid !== String(opts.pid);
      if (first) {
        T = {
          pid: String(opts.pid), pane: opts.pane, profile: opts.profile || null,
          rows: [], rowByKey: {}, idByKey: {}, rowFlag: {}, sel: {}, collapsed: {},
          undo: [], redo: [], queue: [], draining: false,
          filter: "", entry: {}, mru: {}, catalog: [], canEdit: false, pricesHidden: false,
          active: true, detailKey: null,
        };
        document.addEventListener("keydown", onKey);
      } else {
        T.pane = opts.pane; T.active = true;
      }
      T.pane.innerHTML = '<div class="pj-empty">Loading takeoffs…</div>';
      try {
        var d = await DCR.api("/api/portal?action=project&id=" + T.pid + "&part=takeoffs");
        T.canEdit = !!d.canEdit;
        T.pricesHidden = !!d.pricesHidden;
        T.rows = []; T.rowByKey = {}; T.idByKey = {};
        (d.rows || []).forEach(function (r) {
          r._k = newKey();
          T.rowByKey[r._k] = r;
          T.idByKey[r._k] = r.id;
          T.rows.push(r);
        });
      } catch (e) {
        T.pane.innerHTML = '<div class="pj-empty">' + esc(e.message || "Could not load takeoffs.") + "</div>";
        return;
      }
      render();
      if (!T.catalog.length) {
        await loadCatalog();
        if (T.catalogError) msg("err", T.catalogError + " You can still type item names by hand.");
      }
    },
    setActive(on) { if (T) { T.active = !!on; if (on && T.pane) render(); } },
    // The estimate item editor writes takeoff rows directly; the tab's copy of
    // them is stale the moment it does.
    invalidate() { if (T) T.rows.length = 0; },
    _saveDetail: saveDetail,
    _closeDetail() { el("toDtModal").classList.remove("open"); },
    _closeMc() { el("toMcModal").classList.remove("open"); },
  };
})();
