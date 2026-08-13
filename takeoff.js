/* DCR portal — Takeoffs tab, v3 (assemblies, drag-and-drop, insert-in-place).

   On top of v2 (MaterialTakeoff header records, purpose-picker skeletons,
   inline matcher):

   - A row can hold COMPONENTS one level deep (a Toilet contains its wax ring,
     silicone, seat). Stored in the ParentItemID number column. Components
     always share their parent's Level/Category/Sub-category and travel with it.
   - The checkbox column is gone. Each row has a slim grip (⠿): tap = select,
     drag = move. A group header's grip selects the group; the thead grip
     selects everything shown.
   - Drag with pointer events (works on iPad): a line between rows places there,
     hovering the middle of a row nests inside it. Autoscroll near the edges.
   - Items are entered WHERE they go: "＋ add item" on any group, "Insert below"
     or "Add component" on any row. The entry line re-arms under the row it just
     created, so a run of items is still name-Enter-qty-Enter.

   Command-log rules that keep assemblies safe:
   - Ops reference a parent by CLIENT KEY (fields.parentRef); the wire layer
     resolves it to the server id per chunk, forcing a chunk boundary when the
     parent's add is in the same batch — a component can never silently save as
     top-level.
   - An unresolvable parent skips the op with a visible error, never a silent
     detach. Add ops are idempotent on retry (a key that already has an id is
     not re-sent), so a half-failed undo can be pressed again without duplicates. */

(function () {
  var DCR = (window.DCR = window.DCR || {});
  var esc = function (v) { return DCR.esc(v); };

  var UNITS = ["EA", "SF", "LF", "Roll", "Box"];
  var LEVELS = [
    { f: "itemLocation", label: "Level" },
    { f: "itemCategory", label: "Category" },
    { f: "itemSubCategory", label: "Sub-category" },
  ];
  var ND = LEVELS.length;
  // The owner's canonical level order — lexical sort would put Basement first.
  var LEVEL_CHIPS = ["Lower Level", "Basement", "Main Level", "First Level", "Second Level", "Third Level", "Roof"];
  var LEVEL_RANK = {};
  LEVEL_CHIPS.forEach(function (n, i) { LEVEL_RANK[n.toLowerCase()] = i; });
  var CAT_CHIPS = ["Sub-Floor", "Walls", "Ceiling", "Roofing", "Hardware", "Siding", "Deck Framing", "Railing Framing"];
  // NOT a local copy: the layout map keys are built from this, so if the two
  // files ever disagreed the ordering would break silently.
  var SEP = DCR.tko.SEP;
  var FORCE = "";
  var BATCH = 40;
  var CAT_TTL = 30 * 60 * 1000;

  // The single source of truth for group ordering, shared with the printed
  // Material List. Loaded by the <script> before this one; SEP must match it
  // or the layout map keys silently stop lining up.
  var TKO = DCR.tko;

  var T = null;

  /* ── helpers ── */
  function el(id) { return document.getElementById(id); }
  function num(v) {
    if (typeof v === "number") return v;
    var n = parseFloat(String(v == null ? "" : v).replace(/[$,]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function gkey(v) { return String(v == null ? "" : v); }
  function glabel(k) { return k === "" ? "(none)" : k; }
  function pathOf(r) { return LEVELS.map(function (L) { return gkey(r[L.f]); }).join(SEP); }
  function qtyDisp(v) { return (v == null || Number(v) === 0) ? "" : String(v); }
  function levelRank(v) {
    var r = LEVEL_RANK[String(v || "").trim().toLowerCase()];
    return r === undefined ? 100 : r;
  }
  // group paths use a NUL separator, which HTML attributes silently corrupt
  // (NUL becomes U+FFFD) — always percent-encode a path stored in a data-attr
  function pathAttr(p) { return encodeURIComponent(p); }
  function pathFromAttr(s) { try { return decodeURIComponent(s || ""); } catch (e) { return s || ""; } }
  function tkIdOf(r) { return r.takeoffID == null || r.takeoffID === "" ? "" : String(r.takeoffID); }
  function coarse() { return window.matchMedia && matchMedia("(pointer:coarse)").matches; }

  /* ── assembly helpers ─────────────────────────────────────────────────
     A component points at its parent by _parentRef (client key, this session)
     or parentItemID (server id, loaded data). */
  function parentKeyOf(r) {
    if (r._parentRef && T.rowByKey[r._parentRef]) return r._parentRef;
    if (r._parentRef === null) return null;   // explicitly detached this session
    if (r.parentItemID != null && r.parentItemID !== "") {
      var k = T.keyById[String(r.parentItemID)];
      if (k && T.rowByKey[k]) return k;
    }
    return null;
  }
  function claimsParent(r) {
    if (r._parentRef) return true;
    if (r._parentRef === null) return false;
    return r.parentItemID != null && r.parentItemID !== "";
  }
  function componentsOf(key) {
    return T.rows.filter(function (r) { return parentKeyOf(r) === key; })
      .sort(function (a, b) { return (num(a.itemSortingNumber) - num(b.itemSortingNumber)) || (num(a.id) - num(b.id)); });
  }
  function hasComponents(key) {
    for (var i = 0; i < T.rows.length; i++) if (parentKeyOf(T.rows[i]) === key) return true;
    return false;
  }
  // Assemblies nest to MAX_NEST component levels (item > component >
  // sub-component). One constant; every gate reads it through canNestUnder.
  var MAX_NEST = 2, HOP_CAP = 50;
  // Ancestor keys, nearest first. Every parent walk is capped and
  // visited-guarded — stale data CAN hold a cycle and must never hang the tab.
  function ancestorsOf(key) {
    var out = [], seen = {}, k = key;
    for (var hop = 0; hop < HOP_CAP; hop++) {
      var r = T.rowByKey[k];
      if (!r) break;
      var pk = parentKeyOf(r);
      if (!pk || seen[pk]) break;
      seen[pk] = 1;
      out.push(pk);
      k = pk;
    }
    return out;
  }
  function depthOf(key) { return ancestorsOf(key).length; }
  // All rows below key (BFS, ancestors before descendants), cycle-safe.
  function descendantsOf(key) {
    var out = [], seen = {}; seen[key] = 1;
    var queue = [key];
    while (queue.length) {
      var k = queue.shift();
      componentsOf(k).forEach(function (c) {
        if (seen[c._k]) return;
        seen[c._k] = 1;
        out.push(c);
        queue.push(c._k);
      });
    }
    return out;
  }
  function subtreeHeightOf(key) {
    var h = 0;
    descendantsOf(key).forEach(function (c) {
      var d = 0, k = c._k;
      while (k && k !== key && d < HOP_CAP) { k = parentKeyOf(T.rowByKey[k] || {}); d++; }
      if (k === key) h = Math.max(h, d);
    });
    return h;
  }
  // THE nesting gate — menu, drag, drop and commit all ask this one question.
  function canNestUnder(targetKey, extraHeight) {
    if (!targetKey || !T.rowByKey[targetKey]) return false;
    return depthOf(targetKey) + 1 + (extraHeight || 0) <= MAX_NEST;
  }
  // Parents pull their WHOLE subtree into any selection-driven operation.
  function expandKeys(keys) {
    var out = [], seen = {};
    keys.forEach(function (k) { if (!seen[k] && T.rowByKey[k]) { seen[k] = 1; out.push(k); } });
    for (var i = 0; i < out.length; i++) {
      componentsOf(out[i]).forEach(function (c) {
        if (!seen[c._k]) { seen[c._k] = 1; out.push(c._k); }
      });
    }
    return out;
  }
  // Roots: drop members with ANY ancestor also present (they travel with it).
  function rootsOf(keys) {
    var set = {};
    keys.forEach(function (k) { set[k] = 1; });
    return keys.filter(function (k) {
      var anc = ancestorsOf(k);
      for (var i = 0; i < anc.length; i++) if (set[anc[i]]) return false;
      return true;
    });
  }

  /* ── quantity: "12", "12.5", "1,200" or "=8*3+2" ── */
  function evalQty(src) {
    var s = String(src == null ? "" : src).trim();
    if (s.charAt(0) !== "=") {
      if (s === "") return "";
      var plain = s.replace(/,/g, "");
      return /^-?\d*\.?\d+$/.test(plain) ? plain : null;
    }
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

  /* ── material catalog + matcher ── */
  var STOP = { x: 1, ft: 1, in: 1, inch: 1, inches: 1, foot: 1, feet: 1, by: 1, of: 1, and: 1, the: 1 };
  function indexMaterial(m) {
    var name = String(m.itemName || "");
    m._name = name.toLowerCase();
    m._code = String(m.itemCode || "").toLowerCase().replace(/[\s-]/g, "");
    var digits = name.match(/\d+(?:\.\d+)?/g) || [];
    m._digits = digits.join("").replace(/\./g, "");
    var words = (name.toLowerCase().match(/[a-z]+/g) || []).filter(function (w) { return !STOP[w]; });
    m._inits = words.map(function (w) { return w.charAt(0); }).join("");
    return m;
  }
  function matchMaterials(q, limit) {
    var s = String(q || "").toLowerCase().trim();
    if (s.length < 2) return [];
    var flat = s.replace(/[\s-]/g, "");
    var qd = (flat.match(/\d+/g) || []).join("");
    var qa = (flat.match(/[a-z]+/g) || []).join("");
    var hits = [];
    for (var i = 0; i < T.catalog.length; i++) {
      var m = T.catalog[i], rank = -1;
      if (m._code && m._code === flat) rank = 0;
      else if (m._code && m._code.indexOf(flat) === 0) rank = 1;
      else if (qd && qa && m._digits.indexOf(qd) === 0 && m._inits.indexOf(qa) === 0) rank = 2;
      else if (qd && !qa && m._digits.indexOf(qd) === 0) rank = 3;
      else if (m._name.indexOf(s) === 0) rank = 4;
      else if (m._name.indexOf(s) !== -1) rank = 5;
      else if (qa && !qd && m._inits.indexOf(qa) === 0) rank = 6;
      if (rank >= 0) hits.push({ m: m, rank: rank });
    }
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
      if (c && c.at && Date.now() - c.at < CAT_TTL && c.rows) { T.catalog = c.rows.map(indexMaterial); return; }
    } catch (e) {}
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + T.pid + "&part=materials");
      T.catalog = (d.rows || []).map(indexMaterial);
      try { sessionStorage.setItem(ck, JSON.stringify({ at: Date.now(), rows: d.rows || [] })); } catch (e) {}
    } catch (e) { T.catalog = []; }
  }

  /* ── purpose catalog ── */
  async function loadPurposes() {
    try {
      var c = JSON.parse(sessionStorage.getItem("dcrPurposes") || "null");
      if (c && c.at && Date.now() - c.at < CAT_TTL && c.rows) { T.purposes = c.rows; return; }
    } catch (e) {}
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + T.pid + "&part=purposes");
      T.purposes = d.rows || [];
      try { sessionStorage.setItem("dcrPurposes", JSON.stringify({ at: Date.now(), rows: T.purposes })); } catch (e) {}
    } catch (e) { T.purposes = []; }
  }
  function normCode(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function stemCat(s) { return normCode(s).replace(/s$/, "").replace(/ing$/, ""); }
  function purposesFor(category) {
    var stem = stemCat(category);
    if (!stem) return [];
    return T.purposes.filter(function (p) {
      var code = normCode(p.code);
      return code && (code.indexOf(stem) !== -1 || stem.indexOf(code) !== -1);
    });
  }

  /* ── write queue ── */
  function enqueue(ops, done) { T.queue.push({ ops: ops, done: done }); drainQueue(); }
  async function drainQueue() {
    if (T.draining || !T.queue.length) return;
    T.draining = true;
    while (T.queue.length) {
      var job = T.queue.shift();
      try { var res = await runOps(job.ops); if (job.done) job.done(null, res); }
      catch (e) { if (job.done) job.done(e); }
    }
    T.draining = false;
    render();
  }
  function queueIdle() {
    return new Promise(function (resolve) {
      (function poll(n) {
        if ((!T.queue.length && !T.draining) || n > 100) return resolve();
        setTimeout(function () { poll(n + 1); }, 100);
      })(0);
    });
  }
  // Chunks are sent sequentially, and a boundary is forced before any op whose
  // parent's add is in the same chunk — the parent's id exists by the time the
  // child's wire fields are built. Nesting depth N costs N+1 waves.
  async function runOps(ops) {
    // safety net: no caller may hand a child's add before its parent's add —
    // stable-sort adds by dependency depth so every wave can resolve its refs
    var addOps = ops.filter(function (o) { return o.kind === "add"; });
    if (addOps.length > 1) {
      var adep = addOpDepths(addOps);
      ops = ops.slice().sort(function (a, b) {
        return (a.kind === "add" ? adep[a.key] : 0) - (b.kind === "add" ? adep[b.key] : 0);
      });
    }
    var chunks = [], cur = [], curAdds = {};
    ops.forEach(function (o) {
      var ref = o.fields && o.fields.parentRef;
      if (cur.length >= BATCH || (ref && !T.idByKey[ref] && curAdds[ref])) {
        chunks.push(cur); cur = []; curAdds = {};
      }
      cur.push(o);
      if (o.kind === "add") curAdds[o.key] = 1;
    });
    if (cur.length) chunks.push(cur);

    var results = [];
    for (var c = 0; c < chunks.length; c++) {
      var chunk = chunks[c];
      var wire = chunk.map(function (o) {
        var w = { kind: o.kind };
        // idempotent retry: an add whose key already has an id is NOT re-sent
        if (o.kind === "add" && T.idByKey[o.key]) { w._done = T.idByKey[o.key]; return w; }
        if (o.kind !== "add") {
          w.itemId = T.idByKey[o.key];
          if (!w.itemId) { w._skip = "Row was never saved"; return w; }
        }
        if (o.kind !== "del") {
          var f = {};
          Object.keys(o.fields || {}).forEach(function (k) { if (k !== "parentRef") f[k] = o.fields[k]; });
          if (o.fields && ("parentRef" in o.fields)) {
            var ref = o.fields.parentRef;
            if (ref == null) f.parentItemID = null;
            else {
              var pid = T.idByKey[ref];
              if (!pid) { w._skip = "Its parent was never saved"; return w; }
              f.parentItemID = Number(pid);
            }
          }
          w.fields = f;
        }
        return w;
      });
      var send = wire.filter(function (w) { return !w._skip && !w._done; });
      var map = [];
      wire.forEach(function (w, i) { if (!w._skip && !w._done) map.push(i); });
      var out = [];
      if (send.length) {
        try {
          var d = await DCR.api("/api/portal?action=project", {
            method: "POST", body: { op: "toBatch", projectId: T.pid, ops: send },
          });
          out = d.results || [];
        } catch (netErr) {
          // earlier chunks are already committed — never bubble a throw that
          // would revert them locally. Report this chunk and everything after
          // it as failed ops so the per-op rollback path runs instead.
          for (var rc = c; rc < chunks.length; rc++) {
            chunks[rc].forEach(function (o, oi) {
              if (rc === c && wire[oi] && wire[oi]._done) {
                results.push({ op: o, res: { ok: true, kind: "add", id: wire[oi]._done } });
                return;
              }
              results.push({ op: o, res: { ok: false, error: netErr.message || "Network error" } });
            });
          }
          return results;
        }
      }
      chunk.forEach(function (o, i) {
        var r;
        if (wire[i]._done) r = { ok: true, kind: "add", id: wire[i]._done };
        else if (wire[i]._skip) r = { ok: false, error: wire[i]._skip };
        else r = out[map.indexOf(i)] || { ok: false, error: "No result" };
        if (r.ok && o.kind === "add" && r.id) { T.idByKey[o.key] = r.id; T.keyById[String(r.id)] = o.key; }
        if (r.ok && o.kind === "del") {
          var oldId = T.idByKey[o.key];
          delete T.idByKey[o.key];
          if (oldId != null) delete T.keyById[String(oldId)];
        }
        results.push({ op: o, res: r });
      });
    }
    return results;
  }

  /* ── command log ── */
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
    ops.forEach(function (o) { applyLocal(o); });
    render();
    enqueue(ops, function (err, results) {
      var failed = [];
      (results || []).forEach(function (r) {
        if (r.res.ok) return;
        failed.push(r);
        if (r.op.kind === "upd") applyLocal({ kind: "upd", key: r.op.key, fields: r.op.before || {} });
        if (r.op.kind === "del" && r.op.snapshot) applyLocal({ kind: "add", key: r.op.key, fields: r.op.snapshot });
        if (r.op.kind === "add") markRow(r.op.key, "err");
        if (r.res.gone) removeLocal(r.op.key);
      });
      if (err) {
        msg("err", err.message || "Could not save — nothing was changed on the server.");
        ops.forEach(function (o) { revertLocal(o); });
      } else if (failed.length) {
        msg("err", (ops.length - failed.length) + " of " + ops.length + " saved · " + (failed[0].res.error || "some rows failed"));
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
        setRowFields(r, o.fields);
        T.rowByKey[o.key] = r;
        T.rows.push(r);
      }
      return;
    }
    if (o.kind === "del") { removeLocal(o.key); return; }
    if (o.kind === "upd") {
      var row = T.rowByKey[o.key];
      if (!row) return;
      setRowFields(row, o.fields);
    }
  }
  function setRowFields(row, fields) {
    Object.keys(fields || {}).forEach(function (k) {
      if (k === "parentRef") {
        row._parentRef = fields[k];
        if (fields[k] === null) row.parentItemID = null;
        return;
      }
      row[k] = fields[k];
    });
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
      if (partial) T.undo.push(cmd); else T.redo.push(cmd);
      render();
    });
  }
  function doRedo() {
    if (!T.redo.length) return;
    var cmd = T.redo.pop();
    runCommand(cmd, "do", function (partial) { if (!partial) T.undo.push(cmd); render(); });
  }

  /* ── command builders ── */
  var keySeq = 0;
  function newKey() { return "k" + (++keySeq); }
  var SNAP_FIELDS = ["takeoffName", "takeoffID", "itemLocation", "itemCategory", "itemSubCategory",
    "itemPurpose", "itemName", "itemQty", "itemType", "itemPrice", "itemSortingNumber",
    "itemCalculationFormula", "itemHiperLink", "itemGeneralProjectTasksID"];
  function snapshot(row) {
    var o = {};
    SNAP_FIELDS.forEach(function (f) { if (row[f] != null && row[f] !== "") o[f] = row[f]; });
    // parent linkage by client key whenever the parent is loaded — server ids
    // change on every delete-undo cycle, client keys never do
    var pk = parentKeyOf(row);
    if (pk) o.parentRef = pk;
    else if (claimsParent(row)) o.parentItemID = Number(row.parentItemID);
    return o;
  }
  function linkBefore(row) {
    var pk = parentKeyOf(row);
    if (pk) return { parentRef: pk };
    if (claimsParent(row)) return { parentItemID: Number(row.parentItemID) };
    return { parentRef: null };
  }
  // Depth of an add op: chase parentRef through the op set (those rows don't
  // exist yet), then through live rows. Memoized, hop-capped.
  function addOpDepths(ops) {
    var byKey = {}, memo = {};
    ops.forEach(function (o) { byKey[o.key] = o; });
    function d(key, hop) {
      if (hop > HOP_CAP) return hop;
      if (memo[key] != null) return memo[key];
      memo[key] = hop; // cycle backstop while computing
      var o = byKey[key];
      var ref = o && o.fields && o.fields.parentRef;
      var out = 0;
      if (ref) out = byKey[ref] ? d(ref, hop + 1) + 1 : depthOf(ref) + 1;
      memo[key] = out;
      return out;
    }
    var map = {};
    ops.forEach(function (o) { map[o.key] = d(o.key, 0); });
    return map;
  }
  function cmdAddMany(list, label) {
    var ops = [], inv = [];
    list.forEach(function (entry) {
      var key = entry._key || newKey();
      var fields = {};
      Object.keys(entry).forEach(function (k) { if (k !== "_key") fields[k] = entry[k]; });
      ops.push({ kind: "add", key: key, fields: fields });
    });
    var listKeys = ops.map(function (o) { return o.key; });
    // BFS level order: every parent's add lands a whole chunk before its
    // children's, so runOps needs one wave per DEPTH, not one per child
    var dep = addOpDepths(ops);
    ops.sort(function (a, b) { return dep[a.key] - dep[b.key]; });
    // inverse: deepest first (delete order)
    ops.slice().sort(function (a, b) { return dep[b.key] - dep[a.key]; })
      .forEach(function (o) { inv.push({ kind: "del", key: o.key, snapshot: o.fields }); });
    return {
      label: label || ("Added " + ops.length + " item" + (ops.length === 1 ? "" : "s")),
      ops: ops, inverse: inv,
      newKeys: listKeys,
    };
  }
  function cmdUpdate(key, fields, label) {
    var row = T.rowByKey[key] || {};
    var before = {};
    Object.keys(fields).forEach(function (f) {
      if (f === "parentRef") { var lb = linkBefore(row); Object.keys(lb).forEach(function (k) { before[k] = lb[k]; }); }
      else before[f] = row[f] == null ? null : row[f];
    });
    return {
      label: label || "Edited item",
      ops: [{ kind: "upd", key: key, fields: fields, before: before }],
      inverse: [{ kind: "upd", key: key, fields: before, before: fields }],
    };
  }
  function cmdDelete(keys) {
    var expanded = expandKeys(keys);
    // deepest first, so an abort mid-way tends to leave ancestors alive
    var depths = {};
    expanded.forEach(function (k) { depths[k] = depthOf(k); });
    var ordered = expanded.slice().sort(function (a, b) { return depths[b] - depths[a]; });
    var ops = [];
    ordered.forEach(function (k) {
      var row = T.rowByKey[k];
      if (!row) return;
      ops.push({ kind: "del", key: k, snapshot: snapshot(row) });
    });
    // inverse re-adds shallowest first (the wave logic then links each level)
    var inv = [];
    ops.slice().sort(function (a, b) { return depths[a.key] - depths[b.key]; })
      .forEach(function (o) { inv.push({ kind: "add", key: o.key, fields: o.snapshot }); });
    var nComp = ordered.length - rootsOf(ordered).length;
    return {
      label: "Deleted " + ordered.length + " item" + (ordered.length === 1 ? "" : "s") +
        (nComp ? " (incl. " + nComp + " component" + (nComp === 1 ? "" : "s") + ")" : ""),
      ops: ops, inverse: inv, count: ordered.length,
    };
  }
  function updPair(ops, inv, row, fields) {
    var before = {};
    Object.keys(fields).forEach(function (f) {
      if (f === "parentRef") { var lb = linkBefore(row); Object.keys(lb).forEach(function (k) { before[k] = lb[k]; }); }
      else before[f] = row[f] == null ? null : row[f];
    });
    ops.push({ kind: "upd", key: row._k, fields: fields, before: before });
    inv.push({ kind: "upd", key: row._k, fields: before, before: fields });
  }
  function cmdMove(keys, target) {
    var expanded = expandKeys(keys);
    var roots = rootsOf(expanded);
    var set = {};
    expanded.forEach(function (k) { set[k] = 1; });
    var ops = [], inv = [];
    var detached = {};   // dest leaf -> rows that left an assembly and need a top-level sort
    roots.forEach(function (k) {
      var row = T.rowByKey[k];
      if (!row) return;
      var fields = {};
      LEVELS.forEach(function (L) { if (L.f in target) fields[L.f] = target[L.f]; });
      // a component moved WITHOUT its parent detaches from it
      var pk = parentKeyOf(row);
      var detaching = !!(pk && !set[pk]);
      if (detaching) fields.parentRef = null;
      if (!Object.keys(fields).length) return;
      updPair(ops, inv, row, fields);
      if (detaching) {
        var leaf = LEVELS.map(function (L) {
          return gkey(L.f in fields ? fields[L.f] : row[L.f]);
        }).join(SEP);
        (detached[leaf] = detached[leaf] || []).push(row);
      }
      // the whole subtree inherits the destination group
      descendantsOf(k).forEach(function (c) {
        var cf = {};
        LEVELS.forEach(function (L) { if (L.f in target) cf[L.f] = target[L.f]; });
        if (Object.keys(cf).length) updPair(ops, inv, c, cf);
      });
    });
    // a detached row keeps a component-scope sort number — give it a real
    // position at the end of its new top-level run instead of a tie-break
    Object.keys(detached).forEach(function (leaf) {
      var p = leaf.split(SEP);
      var moving = detached[leaf];
      var sibs = topSibsOf(p[0], p[1], p[2]);
      var plan = planPlacement(sibs, sibs.length, moving);
      moving.forEach(function (row, i) { updPair(ops, inv, row, { itemSortingNumber: plan.sorts[i] }); });
      plan.renumber.forEach(function (rn) { updPair(ops, inv, rn.row, { itemSortingNumber: rn.sort }); });
    });
    return { label: "Moved " + roots.length + " item" + (roots.length === 1 ? "" : "s"), ops: ops, inverse: inv };
  }
  function cmdCopy(keys, target) {
    var expanded = expandKeys(keys);
    var roots = rootsOf(expanded);
    var list = [], copied = {};
    function copyOne(row, parentNewKey) {
      if (copied[row._k]) return;   // cycle backstop on stale data
      copied[row._k] = 1;
      var snap = snapshot(row);
      LEVELS.forEach(function (L) { if (L.f in target) snap[L.f] = target[L.f]; });
      snap.itemGeneralProjectTasksID = null;
      delete snap.parentRef; delete snap.parentItemID;   // a lone component copies unlinked
      if (parentNewKey) snap.parentRef = parentNewKey;   // remapped to the copy; resolved per-chunk
      var nk = newKey();
      snap._key = nk;
      list.push(snap);
      componentsOf(row._k).forEach(function (c) { copyOne(c, nk); });
    }
    roots.forEach(function (k) {
      var row = T.rowByKey[k];
      if (row) copyOne(row, null);
    });
    return cmdAddMany(list, "Copied " + roots.length + " item" + (roots.length === 1 ? "" : "s"));
  }

  /* ── selection ── */
  function selKeys() { return Object.keys(T.sel).filter(function (k) { return T.sel[k] && T.rowByKey[k]; }); }
  function pruneSel() { Object.keys(T.sel).forEach(function (k) { if (!T.rowByKey[k]) delete T.sel[k]; }); }

  /* ── group layout: the saved order of levels / categories / sub-categories.
     Stored as JSON on the takeoff header (TakeoffLayout). Groups absent from
     the layout keep the old fallback order, so an empty layout renders exactly
     as before. Reads fail open: a corrupt blob means fallback, never a crash. */
  // Delegated to takeoff-order.js so the grid and the printed Material List
  // cannot order groups differently — see that file's header.
  function normName(s) { return TKO.normName(s); }
  function parseLayout(h) { return TKO.parseLayout(h); }
  function layoutMaps() {
    var h = currentHeader();
    var str = h ? (h.takeoffLayout || "") : "";
    if (T._lm && T._lm.str === str) return T._lm.maps;
    var maps = TKO.maps(h);
    T._lm = { str: str, maps: maps };
    return maps;
  }
  // Positions: layout wins; unknown groups keep the old fallback order; an
  // empty category/sub sorts FIRST (it draws no header of its own, so sorting
  // it later would make its rows look like they belong to the previous group).
  function levelPosOf(maps, loc) { return TKO.levelPosOf(maps, loc); }
  function catPosOf(maps, loc, cat) { return TKO.catPosOf(maps, loc, cat); }
  function subPosOf(maps, loc, cat, sub) { return TKO.subPosOf(maps, loc, cat, sub); }

  /* ── scope ── */
  function headerIds() {
    var s = {};
    (T.headers || []).forEach(function (h) { s[String(h.id)] = 1; });
    return s;
  }
  function isEstimateRow(r) { return r.itemGeneralProjectTasksID != null && r.itemGeneralProjectTasksID !== ""; }
  function scopeRows() {
    var v = T.view;
    if (v.screen !== "one") return [];
    if (v.est) return T.rows.filter(isEstimateRow);
    if (v.tkId != null) return T.rows.filter(function (r) { return tkIdOf(r) === String(v.tkId); });
    var hs = headerIds();
    return T.rows.filter(function (r) {
      if (isEstimateRow(r)) return false;
      var tid = tkIdOf(r);
      if (tid && hs[tid]) return false;
      return gkey(r.takeoffName).trim() === String(v.nameKey || "");
    });
  }
  function canEditView() { return T.canEdit && !(T.view && T.view.est); }

  /* ── ordering: tops by group/sort, components spliced after their parent ── */
  function rowMatches(r, q) {
    return [r.itemName, r.itemPurpose, r.itemCategory, r.itemSubCategory, r.itemLocation, r.itemType]
      .filter(Boolean).join(" ").toLowerCase().indexOf(q) !== -1;
  }
  /* One pass builds everything the table needs: the flat DFS order, and per
     row its nest depth, ancestor-rail continuation stack and last-sibling
     flag. The armed entry line is spliced in as a synthetic node so the rows
     around it get their rails recomputed for free. Stale data can hold a
     cycle — a global emitted-set degrades it to a flat, healable render. */
  function visibleStructure() {
    var q = (T.filter || "").toLowerCase().trim();
    var rows = scopeRows();
    if (q) {
      // assembly-atomic: a match keeps its whole ancestor chain and subtree
      var pass = {};
      rows.forEach(function (r) { if (rowMatches(r, q)) pass[r._k] = 1; });
      rows.forEach(function (r) {
        if (!pass[r._k]) return;
        ancestorsOf(r._k).forEach(function (ak) { pass[ak] = 1; });
      });
      var grew = true;
      while (grew) {
        grew = false;
        rows.forEach(function (r) {
          if (pass[r._k]) return;
          var pk = parentKeyOf(r);
          if (pk && pass[pk]) { pass[r._k] = 1; grew = true; }
        });
      }
      rows = rows.filter(function (r) { return pass[r._k]; });
    }
    var inScope = {};
    rows.forEach(function (r) { inScope[r._k] = 1; });
    var tops = [], byParent = {};
    rows.forEach(function (r) {
      var pk = parentKeyOf(r);
      if (pk && inScope[pk]) (byParent[pk] = byParent[pk] || []).push(r);
      else tops.push(r);
    });
    var maps = layoutMaps();
    tops.sort(function (a, b) {
      var d = levelPosOf(maps, a.itemLocation) - levelPosOf(maps, b.itemLocation);
      if (d) return d;
      d = catPosOf(maps, a.itemLocation, a.itemCategory) - catPosOf(maps, b.itemLocation, b.itemCategory);
      if (d) return d;
      d = subPosOf(maps, a.itemLocation, a.itemCategory, a.itemSubCategory) -
          subPosOf(maps, b.itemLocation, b.itemCategory, b.itemSubCategory);
      if (d) return d;
      // raw-path tie-break keeps name variants ("Walls" vs "walls ") contiguous
      var pa = pathOf(a), pb = pathOf(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      return (num(a.itemSortingNumber) - num(b.itemSortingNumber)) || (num(a.id) - num(b.id));
    });
    var bySort = function (a, b) {
      return (num(a.itemSortingNumber) - num(b.itemSortingNumber)) || (num(a.id) - num(b.id));
    };
    Object.keys(byParent).forEach(function (k) { byParent[k].sort(bySort); });

    // splice the armed entry in AFTER sorting, as a synthetic sibling — the
    // tree pass then computes its rails and its neighbours' rails together
    var entryNode = null;
    if (T.entry2 && canEditView()) {
      var ec = entryContext();
      var ea = T.entry2.anchor;
      if (ec) {
        entryNode = { _k: "__entry__", __entry: true, itemLocation: ec.loc, itemCategory: ec.cat, itemSubCategory: ec.sub };
        var placed = false;
        if (ec.parentKey && inScope[ec.parentKey]) {
          var kids = byParent[ec.parentKey] = byParent[ec.parentKey] || [];
          if (ea.t === "after") {
            var ai = -1;
            kids.forEach(function (c, i) { if (c._k === ea.key) ai = i; });
            kids.splice(ai === -1 ? kids.length : ai + 1, 0, entryNode);
          } else kids.push(entryNode);
          placed = true;
        } else if (!ec.parentKey) {
          var at = -1;
          if (ea.t === "after") tops.forEach(function (t, i) { if (t._k === ea.key) at = i; });
          else {
            var leaf = [gkey(ec.loc), gkey(ec.cat), gkey(ec.sub)].join(SEP);
            tops.forEach(function (t, i) { if (pathOf(t) === leaf) at = i; });
          }
          if (at !== -1) { tops.splice(at + 1, 0, entryNode); placed = true; }
        }
        if (!placed) entryNode = null;   // pend-group / fallback paths draw it
      }
    }

    // classic tree drawing: cont[j] = "the rail at nest level j keeps going
    // below this row" (that ancestor has later siblings); last = own elbow
    var nodes = [], meta = {}, emitted = {};
    var ignoreAsm = !!q;   // searching auto-sees into collapsed assemblies
    function emit(n, depth, prefix, isLast, hidden) {
      if (emitted[n._k]) return;
      emitted[n._k] = 1;
      meta[n._k] = { depth: depth, cont: prefix, last: isLast, hidden: hidden, cyc: false };
      nodes.push(n);
      if (n.__entry) return;
      var kidHidden = hidden || (!ignoreAsm && !!T.collapsed["asm:" + n._k]);
      var kids = (byParent[n._k] || []).filter(function (c) { return !emitted[c._k]; });
      var cp = prefix.concat([!isLast]);
      kids.forEach(function (c, i) { emit(c, depth + 1, cp, i === kids.length - 1, kidHidden); });
    }
    tops.forEach(function (t, i) {
      var nx = tops[i + 1];
      var lastOfRun = !nx || pathOf(nx) !== pathOf(t);
      emit(t, 0, [], lastOfRun, false);
    });
    // anything unreached sits on a cycle of stale parent links: render it
    // flat with a badge so a detach can heal it
    rows.forEach(function (r) {
      if (emitted[r._k]) return;
      emit(r, 0, [], true, false);
      meta[r._k].cyc = true;
    });
    return { nodes: nodes, meta: meta, hasEntry: !!entryNode };
  }
  function visibleRows() {
    return visibleStructure().nodes.filter(function (n) { return !n.__entry; });
  }

  /* ── sort placement: midpoint when a real gap exists, else renumber ── */
  function planPlacement(siblings, insertIdx, movingRows) {
    var placed = siblings.filter(function (s) { return movingRows.indexOf(s) === -1; });
    if (insertIdx > placed.length) insertIdx = placed.length;
    var prev = placed[insertIdx - 1], next = placed[insertIdx];
    var pv = prev ? num(prev.itemSortingNumber) : null;
    var nv = next ? num(next.itemSortingNumber) : null;
    var n = movingRows.length;
    if (nv == null) {
      var base = pv == null ? 0 : pv;
      return { sorts: movingRows.map(function (_, i) { return base + (i + 1) * 10; }), renumber: [] };
    }
    var lo = pv == null ? 0 : pv;
    var step = (nv - lo) / (n + 1);
    // legacy rows share sort 0 constantly — equal/inverted gaps renumber the leaf
    if (!(step > 0.002)) {
      var final = [];
      placed.slice(0, insertIdx).forEach(function (r) { final.push(r); });
      movingRows.forEach(function (r) { final.push(r); });
      placed.slice(insertIdx).forEach(function (r) { final.push(r); });
      var renumber = [], sorts = [];
      final.forEach(function (r, i) {
        var want = (i + 1) * 10;
        if (movingRows.indexOf(r) !== -1) sorts.push(want);
        else if (num(r.itemSortingNumber) !== want) renumber.push({ row: r, sort: want });
      });
      return { sorts: sorts, renumber: renumber };
    }
    return { sorts: movingRows.map(function (_, i) { return lo + step * (i + 1); }), renumber: [] };
  }

  /* ── pending structure ── */
  function pendKey() { return "dcrToPend:" + T.pid + ":" + (T.view.tkId || T.view.nameKey || ""); }
  function loadPend() {
    try { return JSON.parse(sessionStorage.getItem(pendKey()) || "[]"); } catch (e) { return []; }
  }
  function savePend(list) {
    try {
      if (list.length) sessionStorage.setItem(pendKey(), JSON.stringify(list));
      else sessionStorage.removeItem(pendKey());
    } catch (e) {}
  }
  function prunePend(rows) {
    var have = {};
    rows.forEach(function (r) {
      for (var d = 0; d < ND; d++) {
        have[LEVELS.slice(0, d + 1).map(function (L) { return gkey(r[L.f]); }).join(SEP)] = 1;
      }
    });
    var keep = loadPend().filter(function (p) {
      return !have[[p.loc || "", p.cat || "", p.sub || ""].slice(0, p.depth + 1).join(SEP)];
    });
    savePend(keep);
    return keep;
  }

  /* ── group tree + layout mutations ──
     The tree is built from scopeRows() + pending groups in COMPARATOR order,
     never from the DOM or the filtered view — a search must not scramble a
     synthesized layout. */
  function currentGroupTree() {
    var maps = layoutMaps();
    var rows = scopeRows().slice().sort(function (a, b) {
      var d = levelPosOf(maps, a.itemLocation) - levelPosOf(maps, b.itemLocation);
      if (d) return d;
      d = catPosOf(maps, a.itemLocation, a.itemCategory) - catPosOf(maps, b.itemLocation, b.itemCategory);
      if (d) return d;
      d = subPosOf(maps, a.itemLocation, a.itemCategory, a.itemSubCategory) -
          subPosOf(maps, b.itemLocation, b.itemCategory, b.itemSubCategory);
      if (d) return d;
      var pa = pathOf(a), pb = pathOf(b);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
    var levels = [], lIdx = {};
    function touch(loc, cat, sub) {
      if (gkey(loc) === "") return;
      var lk = normName(loc);
      if (!(lk in lIdx)) { lIdx[lk] = levels.length; levels.push({ n: gkey(loc).trim(), cats: [], _c: {} }); }
      var L = levels[lIdx[lk]];
      if (gkey(cat) === "") return;
      var ck = normName(cat);
      if (!(ck in L._c)) { L._c[ck] = L.cats.length; L.cats.push({ n: gkey(cat).trim(), subs: [], _s: {} }); }
      var C = L.cats[L._c[ck]];
      if (gkey(sub) === "") return;
      var sk = normName(sub);
      if (!(sk in C._s)) { C._s[sk] = 1; C.subs.push(gkey(sub).trim()); }
    }
    rows.forEach(function (r) { touch(r.itemLocation, r.itemCategory, r.itemSubCategory); });
    loadPend().forEach(function (p) { touch(p.loc, p.depth >= 1 ? p.cat : "", p.depth >= 2 ? p.sub : ""); });
    // strip the private index keys
    return levels.map(function (L) {
      return { n: L.n, cats: L.cats.map(function (C) { return C.subs.length ? { n: C.n, subs: C.subs } : { n: C.n }; }) };
    });
  }
  function saveLayout(levels, toast) {
    var h = currentHeader();
    if (!h || !T.canManage) return;
    var prev = h.takeoffLayout || "";
    var json = JSON.stringify({ v: 1, levels: levels });
    h.takeoffLayout = json;
    T._lm = null;
    render();
    if (toast) msg("ok", toast);
    DCR.api("/api/portal?action=project", { method: "POST", body: { op: "tkUpdate", itemId: h.id, fields: { takeoffLayout: json } } })
      .catch(function (e) {
        h.takeoffLayout = prev;
        T._lm = null;
        msg("err", (e.message || "Could not save the new order") + " — the order was put back.");
        render();
      });
  }
  // A brand-new level slots at its canonical position (Basement lands before
  // Roof); categories and subs append in creation order. Only touches a layout
  // that already exists — creating one on a mere add would freeze the order.
  function layoutOnAdd(kind, loc, cat, sub) {
    var h = currentHeader();
    if (!h || !T.canManage || !parseLayout(h)) return;
    var levels = currentGroupTree();
    if (kind === "level") {
      var without = levels.filter(function (L) { return normName(L.n) !== normName(loc); });
      var mine = levels.filter(function (L) { return normName(L.n) === normName(loc); });
      if (!mine.length) mine = [{ n: gkey(loc).trim(), cats: [] }];
      var at = without.length;
      for (var i = 0; i < without.length; i++) {
        if (levelRank(without[i].n) > levelRank(loc)) { at = i; break; }
      }
      without.splice(at, 0, mine[0]);
      levels = without;
    }
    saveLayout(levels, null);
  }

  /* ── messages ── */
  function msg(kind, text) {
    T.msg = text ? { kind: kind || "", text: text, at: Date.now() } : null;
    paintMsg();
    if (kind === "ok") {
      var stamp = T.msg && T.msg.at;
      setTimeout(function () { if (T.msg && T.msg.at === stamp) { T.msg = null; paintMsg(); } }, 4000);
    }
  }
  function paintMsg() {
    var m = el("toMsg");
    if (!m) return;
    m.className = "pj-msg " + (T.msg ? T.msg.kind : "");
    m.textContent = T.msg ? T.msg.text : "";
  }

  /* ── render (deferred while a gesture is live — an innerHTML rebuild would
        kill pointer capture mid-drag and wipe half-typed entry text) ── */
  function render() {
    if (!T || !T.pane || !T.active) return;
    if (T.gesture) { T.renderPending = true; return; }
    pruneSel();
    if (T.view.screen === "one") renderOne();
    else renderCards();
    paintMsg();
  }
  function endGesture() {
    T.gesture = null;
    if (T.renderPending) { T.renderPending = false; render(); }
  }

  /* ── screen A ── */
  function orphanGroups() {
    var hs = headerIds(), groups = {}, order = [];
    T.rows.forEach(function (r) {
      if (isEstimateRow(r)) return;
      var tid = tkIdOf(r);
      if (tid && hs[tid]) return;
      var k = gkey(r.takeoffName).trim();
      if (!(k in groups)) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    order.sort();
    return order.map(function (k) { return { key: k, rows: groups[k] }; });
  }
  function rowsTotal(rows) {
    return rows.reduce(function (s, r) { return s + num(r.itemQty) * num(r.itemPrice); }, 0);
  }
  function fmtDay(v) {
    if (!v) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
    return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function renderCards() {
    var showPrice = !T.pricesHidden;
    var hs = headerIds();
    var byTk = {};
    T.rows.forEach(function (r) {
      var tid = tkIdOf(r);
      if (tid && hs[tid]) (byTk[tid] = byTk[tid] || []).push(r);
    });
    var estRows = T.rows.filter(isEstimateRow);
    var orphans = orphanGroups();

    var html = '<div class="pj-bar">' +
      (T.canManage ? '<button class="pj-btn pj-btn-primary pj-btn-sm" id="tkNewBtn">＋ New takeoff</button>' : "") +
      '<span class="pj-sub">' + (T.headers.length + orphans.length) + " takeoff" +
        ((T.headers.length + orphans.length) === 1 ? "" : "s") + " · " + T.rows.length + " items</span></div>" +
      '<div class="pj-msg" id="toMsg"></div>';

    if (T.serverOld) {
      html += '<div class="pj-empty">The server is still updating — takeoff records are not available yet. Try again in a minute.</div>';
      T.pane.innerHTML = html;
      var nb = el("tkNewBtn"); if (nb) nb.disabled = true;
      return;
    }

    html += '<div class="tk-cards">';
    T.headers.forEach(function (h) {
      var rows = byTk[String(h.id)] || [];
      html += '<button type="button" class="tk-card" data-open-tk="' + esc(String(h.id)) + '">' +
        '<span class="tk-nm">' + esc(h.takeoffName || "(unnamed)") + "</span>" +
        (h.takeoffDescription ? '<span class="tk-ds">' + esc(h.takeoffDescription) + "</span>" : "") +
        '<span class="tk-meta">' + esc([h.takeoffPreparedBy, fmtDay(h.takeoffDate)].filter(Boolean).join(" · ")) + "</span>" +
        '<span class="tk-cnt">' + rows.length + " item" + (rows.length === 1 ? "" : "s") +
          (showPrice && rows.length ? " · " + money(rowsTotal(rows)) : "") + "</span></button>";
    });
    orphans.forEach(function (g) {
      html += '<button type="button" class="tk-card tk-unlinked" data-open-name="' + esc(g.key) + '">' +
        '<span class="tk-nm">' + esc(g.key || "(no name)") + ' <span class="tk-badge">unlinked</span></span>' +
        '<span class="tk-ds">Rows from before takeoff records existed.</span>' +
        '<span class="tk-cnt">' + g.rows.length + " item" + (g.rows.length === 1 ? "" : "s") +
          (showPrice ? " · " + money(rowsTotal(g.rows)) : "") + "</span></button>";
    });
    if (estRows.length) {
      html += '<button type="button" class="tk-card tk-est" data-open-est="1">' +
        '<span class="tk-nm">From estimate items</span>' +
        '<span class="tk-ds">Rows the estimate editor manages — view only here.</span>' +
        '<span class="tk-cnt">' + estRows.length + " item" + (estRows.length === 1 ? "" : "s") + "</span></button>";
    }
    html += "</div>";
    if (!T.headers.length && !orphans.length && !estRows.length) {
      html += '<div class="pj-empty">No takeoffs yet for this project.' +
        (T.canManage ? " Create the first one to start counting materials." : "") + "</div>";
    }
    T.pane.innerHTML = html;

    var nb2 = el("tkNewBtn"); if (nb2) nb2.onclick = function () { openTkModal(null); };
    T.pane.querySelectorAll("[data-open-tk]").forEach(function (b) {
      b.onclick = function () { enterTakeoff({ tkId: b.getAttribute("data-open-tk") }); };
    });
    T.pane.querySelectorAll("[data-open-name]").forEach(function (b) {
      b.onclick = function () { enterTakeoff({ nameKey: b.getAttribute("data-open-name") }); };
    });
    T.pane.querySelectorAll("[data-open-est]").forEach(function (b) {
      b.onclick = function () { enterTakeoff({ est: true }); };
    });
  }
  function enterTakeoff(sel) {
    T.view = { screen: "one", tkId: sel.tkId != null ? String(sel.tkId) : null, nameKey: sel.nameKey != null ? sel.nameKey : null, est: !!sel.est };
    T.msg = null;
    T.filter = "";
    T.sel = {};
    T.collapsed = {};
    T.entry2 = null;
    render();
  }
  function currentHeader() {
    if (!T.view.tkId) return null;
    for (var i = 0; i < T.headers.length; i++) if (String(T.headers[i].id) === T.view.tkId) return T.headers[i];
    return null;
  }

  /* ── screen B ── */
  // Delegated to takeoff-order.js — the printed Material List tints the same
  // groups the same way, and two copies would drift. The rules (colours in
  // order of appearance, keyed on the deepest named group) live there.
  function deepestOf(keys) { return TKO.deepestOf(keys); }
  function groupColorer() { return TKO.colorer(); }

  function renderOne() {
    var canEdit = canEditView();
    // The takeoff grid is a material list — what to order and how much of it.
    // Money lives on the Estimate tab, and a row's unit price is still on its
    // Details panel; carrying Price and Total here only cost the columns that
    // the item and purpose text actually need.
    var showPrice = false;
    var gcolor = groupColorer();
    var h = currentHeader();
    var vs = visibleStructure();
    var rows = vs.nodes.filter(function (n) { return !n.__entry; });
    var pend = canEdit ? prunePend(scopeRows()) : [];
    // Purpose, Item, Qty, Unit [, Price, Total]. The drag grip lives inside the
    // Purpose cell, and the row menu hangs off it (right-click), so neither one
    // costs a column.
    var cols = 4 + (showPrice ? 2 : 0);
    var sel = selKeys();
    var hiddenSel = sel.filter(function (k) { return rows.indexOf(T.rowByKey[k]) === -1; }).length;

    var title = T.view.est ? "From estimate items"
      : h ? (h.takeoffName || "(unnamed)")
      : (T.view.nameKey || "(no name)");
    var sub = T.view.est ? "Managed from the Estimate tab — open an estimate item to change these."
      : h ? [h.takeoffPreparedBy ? "Prepared by " + h.takeoffPreparedBy : "", fmtDay(h.takeoffDate), h.takeoffDescription || ""].filter(Boolean).join(" · ")
      : "Unlinked rows (before takeoff records existed).";

    var head = '<div class="tk-head">' +
      '<button class="pj-btn pj-btn-sm" id="tkBack">← All takeoffs</button>' +
      '<div class="tk-headmid"><div class="tk-title">' + esc(title) + "</div>" +
      '<div class="pj-sub">' + esc(sub) + "</div></div>" +
      (h ? '<a class="pj-btn pj-btn-sm" id="tkPrint" title="Printable material list" ' +
        'href="report-takeoff.html?id=' + encodeURIComponent(T.pid) + "&tk=" + encodeURIComponent(h.id) + '">🖨 Material list</a>' : "") +
      (h && T.canManage ? '<button class="pj-btn pj-btn-sm" id="tkEdit" title="Edit name, description, notes">✎</button>' +
        '<button class="pj-btn pj-btn-sm" id="tkDel" title="Delete this takeoff (must be empty)">🗑</button>' : "") +
      (!h && !T.view.est && T.canManage ? '<button class="pj-btn pj-btn-sm pj-btn-primary" id="tkConvert" title="Create a takeoff record and link these rows to it">Convert to takeoff record</button>' : "") +
      "</div>";

    var bar = '<div class="pj-bar to-bar">' +
      '<input class="pj-search" id="toSearch" placeholder="Search items…" value="' + esc(T.filter || "") + '">' +
      '<span class="pj-sub" id="toCount"></span>' +
      '<span class="to-sp"></span>' +
      (canEdit
        ? '<button class="pj-btn pj-btn-sm" id="toUndo"' + (T.undo.length ? "" : " disabled") +
            ' title="' + esc(T.undo.length ? "Undo: " + T.undo[T.undo.length - 1].label : "Nothing to undo") + '">↶ Undo</button>' +
          '<button class="pj-btn pj-btn-sm" id="toRedo"' + (T.redo.length ? "" : " disabled") +
            ' title="' + esc(T.redo.length ? "Redo: " + T.redo[T.redo.length - 1].label : "Nothing to redo") + '">↷ Redo</button>'
        : "") +
      '<button class="pj-btn pj-btn-sm" id="toExpand">⇱ Expand all</button>' +
      "</div>" +
      (canEdit && sel.length
        ? '<div class="to-selbar' + (coarse() ? " to-selbar-fix" : "") + '"><b>' + sel.length + " selected</b>" +
            (hiddenSel ? ' <span class="pj-sub">(' + hiddenSel + " hidden by the search)</span>" : "") +
            '<button class="pj-btn pj-btn-sm" id="toMove">→ Move to…</button>' +
            '<button class="pj-btn pj-btn-sm" id="toCopy">⧉ Copy to…</button>' +
            '<button class="pj-btn pj-btn-sm pj-btn-danger" id="toDel">🗑 Delete</button>' +
            '<button class="pj-btn pj-btn-sm" id="toClearSel">Clear</button></div>'
        : "");

    var chips = "";
    if (canEdit) {
      var present = {};
      scopeRows().forEach(function (r) { present[gkey(r.itemLocation).trim().toLowerCase()] = 1; });
      pend.forEach(function (p) { if (p.depth >= 0) present[gkey(p.loc).trim().toLowerCase()] = 1; });
      var missing = LEVEL_CHIPS.filter(function (n) { return !present[n.toLowerCase()]; });
      chips = '<div class="tk-chips"><span class="pj-sub">＋ Level:</span>' +
        missing.map(function (n) { return '<button class="pj-tag" data-add-level="' + esc(n) + '">' + esc(n) + "</button>"; }).join("") +
        '<button class="pj-tag" data-add-level="*">Other…</button></div>';
    }

    var open = T.collapsed;
    var body = "";
    var groupTotals = {};
    rows.forEach(function (r) {
      var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
      for (var d = 0; d < ND; d++) {
        var p = keys.slice(0, d + 1).join(SEP);
        groupTotals[p] = (groupTotals[p] || 0) + num(r.itemQty) * num(r.itemPrice);
      }
    });
    // the structure pass already computed every row's depth, rails and the
    // armed entry's position — this loop only interleaves the group headers
    var prev = [FORCE, FORCE, FORCE];
    var emitted = {};
    var entryDrawn = false;
    vs.nodes.forEach(function (r) {
      var m = vs.meta[r._k] || { depth: 0, cont: [], last: true };
      var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
      for (var d = 0; d < ND; d++) {
        if (keys[d] === prev[d] && keys.slice(0, d).join(SEP) === prev.slice(0, d).join(SEP)) continue;
        if (d > 0 && keys[d] === "") {
          var deeper = false;
          for (var q = d + 1; q < ND; q++) if (keys[q] !== "") deeper = true;
          if (!deeper) { prev[d] = keys[d]; continue; }
        }
        var p = keys.slice(0, d + 1).join(SEP);
        emitted[p] = 1;
        // Only the group that actually owns the items wears the colour bar. A
        // Level is a container for other groups, and giving it one of their
        // hues just reads as a fourth group that isn't there.
        body += groupRow(p, d, keys, groupTotals[p], countUnder(rows, keys, d), cols, !!open[p], showPrice, canEdit,
          false, d === deepestOf(keys) ? gcolor(keys) : null);
        for (var k = d; k < ND; k++) prev[k] = FORCE;
      }
      prev = keys;
      if (r.__entry) { body += entryRowHtml(cols, showPrice, m); entryDrawn = true; return; }
      var hidden = !!m.hidden;
      for (var d2 = 0; d2 < ND; d2++) if (open[keys.slice(0, d2 + 1).join(SEP)]) { hidden = true; break; }
      if (!hidden) body += itemRow(r, showPrice, canEdit, cols, m, gcolor(keys));
    });
    pend.forEach(function (p) {
      var keys = [gkey(p.loc), gkey(p.cat), gkey(p.sub)];
      for (var d = 0; d <= p.depth; d++) {
        var path = keys.slice(0, d + 1).join(SEP);
        if (emitted[path]) continue;
        emitted[path] = 1;
        body += groupRow(path, d, keys, 0, 0, cols, false, showPrice, canEdit, true,
          d === deepestOf(keys) ? gcolor(keys) : null);
      }
      if (canEdit && T.entry2 && !entryDrawn && T.entry2.anchor.t === "group" &&
          gkey(T.entry2.anchor.loc) === keys[0] && gkey(T.entry2.anchor.cat) === keys[1] && gkey(T.entry2.anchor.sub) === keys[2]) {
        body += entryRowHtml(cols, showPrice, null);
        entryDrawn = true;
      }
    });
    if (canEdit && T.entry2 && !entryDrawn) body += entryRowHtml(cols, showPrice, null);

    var grand = rowsTotal(rows);
    if (showPrice && rows.length) {
      body += '<tr class="pj-grand"><td colspan="4">TAKEOFF TOTAL</td>' +
        '<td class="num"></td><td class="num">' + money(grand) + "</td></tr>";
    }

    // the classes matter: table-layout:fixed sizes every column from this row
    var thead = "<tr>" +
      '<th class="to-purpose">' + (canEdit ? '<span class="to-grip" id="toAllGrip" title="Select everything shown">⠿</span> ' : "") +
        "Purpose</th><th class=\"to-name\">Item</th><th class=\"num\">Qty</th><th class=\"to-unit\">Unit</th>" +
      (showPrice ? '<th class="num">Price</th><th class="num">Total</th>' : "") + "</tr>";

    var emptyAdd = "";
    if (canEdit && !scopeRows().length && !pend.length && !T.entry2) {
      emptyAdd = '<button class="pj-btn pj-btn-primary" id="toFirstItem" style="width:100%;padding:13px;margin-top:8px">＋ Add first item</button>';
    }

    // Any open cell editor is about to be torn out of the DOM. Chrome fires
    // blur on the way out, and whether the node still reports isConnected at
    // that instant is not something to bet on — it does not, reliably. Left
    // unguarded the dying input runs commit(), which clears T.editing, so the
    // restore below never happens: Tab moves to the next field and then the
    // save lands and takes the focus with it. Mark them explicitly instead.
    T.pane.querySelectorAll("[data-edit] input.to-in").forEach(function (i) { i._dcrDead = true; });

    T.pane.innerHTML = head + bar + '<div class="pj-msg" id="toMsg"></div>' + chips +
      (scopeRows().length || pend.length || T.entry2
        ? '<div class="pj-tblwrap" id="toWrap"><table class="pj-tbl pj-totbl" id="toTable"><thead>' + thead + "</thead><tbody>" + body + "</tbody></table></div>"
        : '<div class="pj-empty">No items in this takeoff yet. Add a level above to build the structure, or just add the first item.</div>' + emptyAdd);

    // The grips this hold was counting on are gone with the old markup
    clearHold();
    wireOne(canEdit);
    if (canEdit && T.entry2) hydrateEntry();
    if (canEdit && T.editing) restoreEditor();
  }
  function countUnder(rows, keys, depth) {
    var p = keys.slice(0, depth + 1).join(SEP);
    var n = 0;
    rows.forEach(function (r) {
      var rp = LEVELS.map(function (L) { return gkey(r[L.f]); });
      if (rp.slice(0, depth + 1).join(SEP) === p) n++;
    });
    return n;
  }
  function groupRow(path, depth, keys, total, n, cols, collapsed, showPrice, canEdit, pending, gc) {
    var key = keys[depth];
    return '<tr class="pj-grp to-g' + depth + (pending ? " to-pendg" : "") + '" data-gpath="' + esc(pathAttr(path)) + '" data-gdepth="' + depth + '"' +
      (gc == null ? "" : ' style="--gc:var(--tg' + gc + ')"') +
      ' data-gloc="' + esc(keys[0]) + '" data-gcat="' + esc(keys[1] || "") + '" data-gsub="' + esc(keys[2] || "") + '">' +
      '<td colspan="' + (4 + (showPrice ? 1 : 0)) + '">' +
        (canEdit ? '<span class="to-grip" data-gselgrip="' + esc(pathAttr(path)) + '" title="Select this group">⠿</span> ' : "") +
        '<span class="to-caret" data-gtog="' + esc(pathAttr(path)) + '">' + (collapsed ? "▸" : "▾") + "</span> " +
        '<span class="to-glabel">' + esc(glabel(key)) + "</span>" +
        (pending
          ? ' <span class="pj-sub">· empty</span>' +
            (canEdit ? ' <button class="pj-tag tk-minitag" data-pend-x="' + esc(pathAttr(path)) + '" title="Remove this empty group">✕</button>' : "")
          : ' <span class="pj-sub">· ' + n + " item" + (n === 1 ? "" : "s") + "</span>") +
        (canEdit ? ' <button class="pj-tag tk-minitag" data-add-item="' + esc(pathAttr(path)) + '">＋ add item</button>' : "") +
        (canEdit && depth === 0
          ? ' <button class="pj-tag tk-minitag" data-add-cat="' + esc(key) + '">＋ Category</button>' : "") +
        (canEdit && depth === 1
          ? ' <button class="pj-tag tk-minitag" data-add-purp="' + esc(pathAttr(path)) + '">＋ Purposes</button>' +
            ' <button class="pj-tag tk-minitag" data-add-sub="' + esc(pathAttr(path)) + '">＋ Sub-category</button>'
          : "") +
      "</td>" +
      (showPrice ? '<td class="num">' + (total ? money(total) : "") + "</td>" : "") + "</tr>";
  }
  // rails: one <i> per ancestor level that continues below this row, plus the
  // row's own connector (tee while siblings follow, elbow when last)
  function railsHtml(m, own) {
    var out = "";
    for (var j = 0; j < m.depth; j++) {
      if (m.cont[j]) out += '<i class="to-rl" style="--k:' + j + '"></i>';
    }
    out += '<i class="to-rl to-rlown' + (own || "") + (m.last ? " to-rlast" : "") + '" style="--k:' + m.depth + '"></i>';
    return out;
  }
  function itemRow(r, showPrice, canEdit, cols, m, gc) {
    var tot = num(r.itemQty) * num(r.itemPrice);
    var flag = T.rowFlag[r._k] ? " to-" + T.rowFlag[r._k] : "";
    var pending = r.id == null ? " to-pending" : "";
    var missing = !parentKeyOf(r) && claimsParent(r) && !m.cyc;
    var nDesc = hasComponents(r._k) ? descendantsOf(r._k).length : 0;
    var caret = nDesc
      ? '<span class="to-caret" data-atog="' + esc(r._k) + '">' + (T.collapsed["asm:" + r._k] ? "▸" : "▾") + "</span> "
      : "";
    var leafDepth = gkey(r.itemSubCategory) !== "" ? 2 : gkey(r.itemCategory) !== "" ? 1 : 0;
    // --n drives the indent, --gc the rail colour this row's group owns
    var styleAttr = ' style="' + (m.depth ? "--n:" + m.depth + ";" : "") +
      (gc == null ? "" : "--gc:var(--tg" + gc + ");") + '"';
    return '<tr class="to-row' + flag + pending + (T.sel[r._k] ? " to-sel" : "") + (m.depth ? " to-child" : "") +
        " to-d" + leafDepth + '" data-k="' + esc(r._k) + '"' + styleAttr + ">" +
      '<td class="to-purpose"' + (canEdit ? ' data-edit="itemPurpose"' : "") + ">" + railsHtml(m) +
        (canEdit ? '<span class="to-grip" data-grip="' + esc(r._k) + '" title="Drag to move · right-click for actions">⠿</span> ' : "") +
        caret + esc(r.itemPurpose || "") + "</td>" +
      '<td class="to-name"' + (canEdit ? ' data-edit="itemName"' : "") + ">" + esc(r.itemName || "—") +
        (missing ? ' <span class="pj-sub to-missing">· parent missing</span>' : "") +
        (m.cyc ? ' <span class="pj-sub to-missing">· circular link — move it to repair</span>' : "") +
        (nDesc ? ' <span class="pj-sub">· ' + nDesc + "</span>" : "") + "</td>" +
      '<td class="num"' + (canEdit ? ' data-edit="itemQty"' : "") + ">" + esc(qtyDisp(r.itemQty)) + "</td>" +
      '<td class="to-unit"' + (canEdit ? ' data-edit="itemType"' : "") + ">" + esc(r.itemType || "") + "</td>" +
      (showPrice
        ? '<td class="num"' + (canEdit ? ' data-edit="itemPrice"' : "") + ">" + (num(r.itemPrice) ? money(r.itemPrice) : "") + "</td>" +
          '<td class="num">' + (tot ? money(tot) : "") + "</td>"
        : "") +
      "</tr>";
  }

  /* ── the positional entry row ── */
  function entryRowHtml(cols, showPrice, meta) {
    // the entry line plugs into the tree at the depth it will insert; the
    // connector arrow (CSS) points at the Purpose box, so no text label
    var ctx = entryContext();
    var m = meta || { depth: ctx && ctx.parentKey ? Math.min(depthOf(ctx.parentKey) + 1, MAX_NEST) : 0, cont: [], last: true };
    var d = ctx ? (ctx.sub ? 2 : ctx.cat ? 1 : 0) : 0;
    var depthAttr = m.depth ? ' style="--n:' + m.depth + '"' : "";
    return '<tr class="to-addrow to-d' + d + '" id="toEntryRow" title="' + esc(entryCtxLabel()) + '"' + depthAttr + ">" +
      '<td colspan="' + cols + '">' + railsHtml(m, " to-rlacc") + '<div class="to-entry">' +
        '<span class="to-ewrap to-ew-purp"><input id="toNPurpose" class="to-in" placeholder="Purpose" autocomplete="off"><div id="toPSug" class="to-sug"></div></span>' +
        '<span class="to-ewrap to-ew-name"><input id="toNName" class="to-in" placeholder="Item name or code (e.g. 2410df)" autocomplete="off"><div id="toSug" class="to-sug"></div></span>' +
        '<input id="toNQty" class="to-in to-inq" placeholder="Qty" autocomplete="off">' +
        '<input id="toNType" class="to-in to-inu" placeholder="Unit" list="toUnits" autocomplete="off">' +
        '<datalist id="toUnits">' + UNITS.map(function (u) { return '<option value="' + u + '">'; }).join("") + "</datalist>" +
        (showPrice ? '<input id="toNPrice" class="to-in to-inq" placeholder="Price" autocomplete="off">' : "") +
        '<button class="pj-btn pj-btn-sm pj-btn-primary" id="toNAdd" title="Add (Enter)">＋</button>' +
        '<button class="pj-btn pj-btn-sm" id="toNClose" title="Close">✕</button>' +
      "</div></td></tr>";
  }
  function entryContext() {
    var a = T.entry2 && T.entry2.anchor;
    if (!a) return null;
    if (a.t === "group") return { loc: a.loc || "", cat: a.cat || "", sub: a.sub || "", parentKey: null };
    var row = T.rowByKey[a.key];
    if (!row) return null;
    if (a.t === "child") return { loc: gkey(row.itemLocation), cat: gkey(row.itemCategory), sub: gkey(row.itemSubCategory), parentKey: a.key };
    // after: same leaf; after a component = sibling component in the same assembly
    return { loc: gkey(row.itemLocation), cat: gkey(row.itemCategory), sub: gkey(row.itemSubCategory), parentKey: parentKeyOf(row) };
  }
  function entryCtxLabel() {
    var a = T.entry2 && T.entry2.anchor;
    var c = entryContext();
    if (!c) return "";
    function rowLabel(row) { return (row && (row.itemPurpose || row.itemName)) || "this item"; }
    if (c.parentKey) {
      return "↳ New component inside " + [c.parentKey].concat(ancestorsOf(c.parentKey)).reverse()
        .map(function (k) { return rowLabel(T.rowByKey[k]); }).join(" › ");
    }
    var place = [c.loc, c.cat, c.sub].filter(Boolean).join(" › ");
    if (a && a.t === "after") {
      var ar = T.rowByKey[a.key];
      if (ar) return "↳ New item below " + rowLabel(ar) + (place ? " — " + place : "");
    }
    return place ? "↳ New item in " + place : "↳ New item";
  }
  function spawnEntry(anchor) {
    // arming inside a collapsed assembly would hide the entry — expand the way in
    if (anchor.key) {
      var chain = [anchor.key].concat(ancestorsOf(anchor.key));
      chain.forEach(function (k) { delete T.collapsed["asm:" + k]; });
    }
    T.entry2 = {
      anchor: anchor,
      values: { name: "", purpose: T.entryStickyPurpose || "", qty: "", type: T.entryStickyType || "", price: "" },
      focusField: (T.entryStickyPurpose ? "name" : "purpose"), caret: 0,
    };
    render();
  }
  function closeEntry() {
    if (T.entry2) {
      T.entryStickyPurpose = T.entry2.values.purpose;
      T.entryStickyType = T.entry2.values.type;
    }
    T.entry2 = null;
    render();
  }
  function hydrateEntry() {
    var e2 = T.entry2;
    if (!e2) return;
    var tr = el("toEntryRow");
    if (!tr) return;
    var map = { name: "toNName", purpose: "toNPurpose", qty: "toNQty", type: "toNType", price: "toNPrice" };
    Object.keys(map).forEach(function (f) {
      var inp = el(map[f]);
      if (!inp) return;
      inp.value = e2.values[f] || "";
      inp.addEventListener("input", function () { e2.values[f] = inp.value; e2.focusField = f; e2.caret = inp.selectionStart; });
      inp.addEventListener("focus", function () { e2.focusField = f; });
    });
    var name = el("toNName"), qty = el("toNQty"), type = el("toNType"), purpose = el("toNPurpose"), price = el("toNPrice");
    attachMatcher(name, el("toSug"), function (m) {
      name.value = m.itemName || "";
      e2.values.name = name.value;
      if (m.itemType && !type.value) { type.value = m.itemType; e2.values.type = m.itemType; }
      if (price && m.itemPrice != null && !price.value) { price.value = num(m.itemPrice) || ""; e2.values.price = String(price.value); }
      T.mru[String(m.itemName || "").toLowerCase()] = Date.now();
      qty.focus();
    });
    name.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !el("toSug").classList.contains("on")) { ev.preventDefault(); qty.focus(); }
      if (ev.key === "Escape") closeEntry();
    });
    var psugCtl = attachPurposeSug(purpose);
    if (purpose) purpose.addEventListener("keydown", function (ev) {
      // suggestions open: ↓/↑ move the highlight, Enter takes the highlighted
      // purpose (the NEXT Enter creates the row). Suggestions closed: Enter or
      // arrowing away CREATES the row — no name, qty or ＋ button needed.
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        if (psugCtl.isOpen()) psugCtl.move(ev.key === "ArrowDown" ? 1 : -1);
        else commitEntry("purpose");
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (psugCtl.isOpen() && psugCtl.hasPick()) { psugCtl.pick(); return; }
        psugCtl.close();
        commitEntry("purpose");
        return;
      }
      if (ev.key === "Escape") {
        if (psugCtl.isOpen()) psugCtl.close();
        else closeEntry();
      }
    });
    [qty, type, price].forEach(function (i) {
      if (!i) return;
      i.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); commitEntry(); }
        if (ev.key === "Escape") closeEntry();
      });
    });
    var add = el("toNAdd"); if (add) add.onclick = commitEntry;
    var cl = el("toNClose"); if (cl) cl.onclick = closeEntry;
    // restore focus + caret so a background render is invisible to the typist
    var focusInp = el(map[e2.focusField] || "toNName");
    if (focusInp && document.activeElement !== focusInp) {
      focusInp.focus();
      var pos = e2.caret == null ? focusInp.value.length : e2.caret;
      try { focusInp.setSelectionRange(pos, pos); } catch (e) {}
    }
    if (!e2._scrolled) {
      e2._scrolled = true;
      setTimeout(function () { if (tr.isConnected) tr.scrollIntoView({ block: "center" }); }, 30);
    }
  }
  function commitEntry(origin) {
    var e2 = T.entry2;
    if (!e2) return;
    var ctx = entryContext();
    if (!ctx) { closeEntry(); return; }
    // the cap is enforced HERE, not just at the menu — undo/redo can deepen
    // the anchor chain between arming and committing
    if (ctx.parentKey && !canNestUnder(ctx.parentKey, 0)) {
      msg("err", "Too deep — an item can hold " + MAX_NEST + " levels of components.");
      return;
    }
    var nm = (e2.values.name || "").trim();
    var pp = (e2.values.purpose || "").trim();
    // typing just a purpose and pressing Enter creates the row — the name and
    // quantity are filled in later, inline
    if (!nm && !pp) { var p0 = el("toNPurpose"); if (p0) p0.focus(); return; }
    var q = evalQty((e2.values.qty || "").trim());
    if (q === null) { msg("err", "That quantity isn't a number or a formula."); var qi = el("toNQty"); if (qi) qi.focus(); return; }
    var fields = {
      itemName: nm || null,
      itemPurpose: pp || null,
      itemQty: q || null,
      itemType: (e2.values.type || "").trim() || null,
      itemLocation: ctx.loc || null, itemCategory: ctx.cat || null, itemSubCategory: ctx.sub || null,
    };
    if ((e2.values.price || "").trim()) fields.itemPrice = num(e2.values.price);
    if (ctx.parentKey) fields.parentRef = ctx.parentKey;
    stampLink(fields);
    var sibs = ctx.parentKey ? componentsOf(ctx.parentKey) : topSibsOf(ctx.loc, ctx.cat, ctx.sub);
    var insertIdx = sibs.length;
    if (e2.anchor.t === "after") {
      var aRow = T.rowByKey[e2.anchor.key];
      var ai = sibs.indexOf(aRow);
      if (ai !== -1) insertIdx = ai + 1;
    }
    var plan = planPlacement(sibs, insertIdx, [{}]);
    fields.itemSortingNumber = plan.sorts[0];
    T.mru[nm.toLowerCase()] = Date.now();
    var cmd = cmdAddMany([fields], "Added " + (nm || pp));
    plan.renumber.forEach(function (rn) {
      cmd.ops.push({ kind: "upd", key: rn.row._k, fields: { itemSortingNumber: rn.sort },
        before: { itemSortingNumber: rn.row.itemSortingNumber == null ? null : rn.row.itemSortingNumber } });
      cmd.inverse.unshift({ kind: "upd", key: rn.row._k,
        fields: { itemSortingNumber: rn.row.itemSortingNumber == null ? null : rn.row.itemSortingNumber },
        before: { itemSortingNumber: rn.sort } });
    });
    var newKey0 = cmd.newKeys[0];
    apply(cmd);
    // re-arm just below what we made ("after" a component stays in the assembly)
    T.entryStickyPurpose = e2.values.purpose;
    T.entryStickyType = e2.values.type;
    // purpose-only entry keeps listing purposes; a named item goes back to the
    // name field (the purpose sticks). Purpose-only rows don't hold the sticky.
    T.entry2 = {
      anchor: { t: "after", key: newKey0 },
      values: { name: "", purpose: origin === "purpose" ? "" : (e2.values.purpose || ""), qty: "", type: e2.values.type || "", price: "" },
      focusField: origin === "purpose" ? "purpose" : "name", caret: 0, _scrolled: true,
    };
    render();
    var tr = el("toEntryRow");
    if (tr) tr.scrollIntoView({ block: "center" });
  }
  function attachPurposeSug(purpose) {
    var noop = { isOpen: function () { return false; }, hasPick: function () { return false; },
      move: function () {}, pick: function () {}, close: function () {} };
    if (!purpose) return noop;
    var psug = el("toPSug");
    var items = [], cur = -1; // {t:"open", q} opens the picker; {t:"pick", name} fills the input
    function close() { psug.innerHTML = ""; psug.classList.remove("on"); items = []; cur = -1; }
    function paint() {
      psug.querySelectorAll(".to-sugi").forEach(function (d, i) { d.classList.toggle("on", i === cur); });
    }
    function showP() {
      var q = purpose.value.trim().toLowerCase();
      var ctx = entryContext() || {};
      var catMatches = q.length >= 2 ? purposesFor(q) : [];
      var pool = T.purposes.slice();
      if (ctx.cat) {
        var inCat = purposesFor(ctx.cat);
        pool = inCat.concat(pool.filter(function (p) { return inCat.indexOf(p) === -1; }));
      }
      var hits = q ? pool.filter(function (p) { return p.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 6) : [];
      items = []; cur = -1;
      var html = "";
      if (catMatches.length >= 3) {
        items.push({ t: "open", q: purpose.value.trim() });
        html += '<div class="to-sugi tk-ppshort" data-pp-open="' + esc(purpose.value.trim()) + '">＋ Add the usual ' +
          esc(purpose.value.trim()) + " purposes…</div>";
      }
      hits.forEach(function (p) {
        items.push({ t: "pick", name: p.name });
        html += '<div class="to-sugi" data-pn="' + esc(p.name) + '"><span class="to-sugn">' + esc(p.name) + "</span>" +
          (p.code ? '<span class="to-sugt">' + esc(p.code) + "</span>" : "") + "</div>";
      });
      if (!html) { close(); return; }
      psug.innerHTML = html;
      psug.classList.add("on");
      placeSug(purpose, psug);
      psug.querySelectorAll("[data-pn]").forEach(function (d) {
        tapPick(d, function () {
          purpose.value = d.getAttribute("data-pn");
          if (T.entry2) T.entry2.values.purpose = purpose.value;
          close();
          var n = el("toNName"); if (n) n.focus();
        });
      });
      psug.querySelectorAll("[data-pp-open]").forEach(function (d) {
        tapPick(d, function () {
          close();
          var ctx2 = entryContext() || {};
          openPurposePicker(ctx2.loc || "", d.getAttribute("data-pp-open"), ctx2.sub || "");
        });
      });
    }
    purpose.addEventListener("input", showP);
    purpose.addEventListener("blur", function () { setTimeout(close, 120); });
    return {
      isOpen: function () { return psug.classList.contains("on"); },
      hasPick: function () { return cur >= 0 && !!items[cur]; },
      close: close,
      move: function (dir) {
        if (!items.length) return;
        cur = dir > 0 ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0);
        paint();
      },
      pick: function () {
        var it = items[cur];
        if (!it) return;
        if (it.t === "open") {
          close();
          var ctx2 = entryContext() || {};
          openPurposePicker(ctx2.loc || "", it.q, ctx2.sub || "");
          return;
        }
        // keyboard pick fills the box and stays put — the next Enter makes the row
        purpose.value = it.name;
        if (T.entry2) T.entry2.values.purpose = purpose.value;
        close();
      },
    };
  }

  /* ── wiring: screen B ── */
  function wireOne(canEdit) {
    bind("tkBack", function () { T.view = { screen: "cards" }; T.msg = null; T.entry2 = null; render(); });
    bind("tkEdit", function () { openTkModal(currentHeader()); });
    bind("tkDel", deleteTakeoff);
    bind("tkConvert", convertGroup);
    bind("toFirstItem", function () { spawnEntry({ t: "group", loc: "", cat: "", sub: "" }); });

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
      var shown = visibleRows().length, all = scopeRows().length;
      cnt.textContent = shown === all ? all + " items" : shown + " of " + all + " items";
    }
    bind("toUndo", doUndo); bind("toRedo", doRedo);
    bind("toExpand", function () {
      var any = Object.keys(T.collapsed).length;
      T.collapsed = {};
      if (!any) {
        visibleRows().forEach(function (r) {
          LEVELS.forEach(function (L, d) {
            T.collapsed[LEVELS.slice(0, d + 1).map(function (X) { return gkey(r[X.f]); }).join(SEP)] = d < ND - 1 ? 0 : 1;
          });
          if (hasComponents(r._k)) T.collapsed["asm:" + r._k] = 1;
        });
      }
      render();
    });
    bind("toClearSel", function () { T.sel = {}; render(); });
    bind("toMove", function () { openMoveCopy("move"); });
    bind("toCopy", function () { openMoveCopy("copy"); });
    bind("toDel", function () { deleteSelection(selKeys()); });

    T.pane.querySelectorAll("[data-add-level]").forEach(function (b) {
      b.onclick = async function () {
        var v = b.getAttribute("data-add-level");
        if (v === "*") {
          v = await DCR.ask("Name the level", { title: "New level", placeholder: "e.g. Second Floor" });
          v = (v || "").trim(); if (!v) return;
        }
        addPending({ depth: 0, loc: v, cat: "", sub: "" });
        layoutOnAdd("level", v);
        spawnEntry({ t: "group", loc: v, cat: "", sub: "" });
      };
    });
    T.pane.querySelectorAll("[data-add-cat]").forEach(function (b) {
      b.onclick = function () { openCatChips(b.getAttribute("data-add-cat")); };
    });
    T.pane.querySelectorAll("[data-add-sub]").forEach(function (b) {
      b.onclick = async function () {
        var parts = pathFromAttr(b.getAttribute("data-add-sub")).split(SEP);
        var v = await DCR.ask("Name the sub-category", { title: "New sub-category", placeholder: "e.g. Headers" });
        v = (v || "").trim();
        if (!v) return;
        addPending({ depth: 2, loc: parts[0], cat: parts[1], sub: v });
        layoutOnAdd("sub", parts[0], parts[1], v);
        spawnEntry({ t: "group", loc: parts[0], cat: parts[1], sub: v });
      };
    });
    T.pane.querySelectorAll("[data-add-purp]").forEach(function (b) {
      b.onclick = function () {
        var parts = pathFromAttr(b.getAttribute("data-add-purp")).split(SEP);
        openPurposePicker(parts[0], parts[1], "");
      };
    });
    T.pane.querySelectorAll("[data-add-item]").forEach(function (b) {
      b.onclick = function () {
        var parts = pathFromAttr(b.getAttribute("data-add-item")).split(SEP);
        spawnEntry({ t: "group", loc: parts[0] || "", cat: parts[1] || "", sub: parts[2] || "" });
      };
    });
    T.pane.querySelectorAll("[data-pend-x]").forEach(function (b) {
      b.onclick = function () {
        var path = pathFromAttr(b.getAttribute("data-pend-x"));
        savePend(loadPend().filter(function (p) {
          return [gkey(p.loc), gkey(p.cat), gkey(p.sub)].slice(0, p.depth + 1).join(SEP) !== path;
        }));
        render();
      };
    });
    T.pane.querySelectorAll("[data-gtog]").forEach(function (b) {
      b.onclick = function () {
        var p = pathFromAttr(b.getAttribute("data-gtog"));
        if (T.collapsed[p]) delete T.collapsed[p]; else T.collapsed[p] = 1;
        render();
      };
    });
    T.pane.querySelectorAll("[data-atog]").forEach(function (b) {
      b.onclick = function () {
        var k = "asm:" + b.getAttribute("data-atog");
        if (T.collapsed[k]) delete T.collapsed[k]; else T.collapsed[k] = 1;
        render();
      };
    });
    // group grips are handled by the pointer machine in wireDrag
    // (tap = select the group, drag = reorder it)
    var ag = el("toAllGrip");
    if (ag) ag.onclick = function () {
      var rows = visibleRows();
      var allSel = rows.length && rows.every(function (r) { return T.sel[r._k]; });
      rows.forEach(function (r) { if (allSel) delete T.sel[r._k]; else T.sel[r._k] = 1; });
      render();
    };
    T.pane.querySelectorAll("tr.to-row").forEach(function (tr) {
      tr.ondblclick = function (e) {
        if (e.target && e.target.tagName === "INPUT") return;
        if (Date.now() < (T.suppressClickUntil || 0)) return;
        openDetail(tr.getAttribute("data-k"));
      };
      // The actions used to be a ⋯ button in a column of its own. They hang off
      // the grip now: right-click it. Everywhere else in the row the menu stays
      // suppressed, so a stray right-click never opens the browser's menu over
      // the grid.
      tr.oncontextmenu = function (e) {
        e.preventDefault();
        var grip = e.target && e.target.closest ? e.target.closest("[data-grip]") : null;
        if (grip && canEdit) openRowMenu(grip, grip.getAttribute("data-grip"));
      };
    });
    if (canEdit) {
      T.pane.querySelectorAll("[data-edit]").forEach(function (td) {
        td.onclick = function (e) {
          if (Date.now() < (T.suppressClickUntil || 0)) return;
          // the grip lives inside the Purpose cell; tapping it selects, never edits
          if (e.target && e.target.closest && e.target.closest("[data-grip]")) return;
          editCell(td);
        };
      });
      wireDrag();
    }
  }
  function bind(id, fn) { var b = el(id); if (b) b.onclick = fn; }
  function addPending(entry) {
    var list = loadPend();
    var key = [gkey(entry.loc), gkey(entry.cat), gkey(entry.sub)].slice(0, entry.depth + 1).join(SEP);
    var dup = list.some(function (p) {
      return [gkey(p.loc), gkey(p.cat), gkey(p.sub)].slice(0, p.depth + 1).join(SEP) === key;
    });
    if (!dup) { list.push(entry); savePend(list); }
  }
  async function deleteSelection(keys) {
    if (!keys.length) return;
    var cmd = cmdDelete(keys);
    if (cmd.count > 5 && !(await DCR.confirm("You can undo this, but it is a lot of rows.",
      { title: "Delete " + cmd.count + " takeoff items?", danger: true, okText: "Delete" }))) return;
    T.sel = {};
    apply(cmd);
  }

  /* ── row menu (⋯) ── */
  function closeRowMenu() {
    var m = el("toRowMenu"), b = el("toRowMenuBk");
    if (m) m.remove();
    if (b) b.remove();
    window.removeEventListener("scroll", closeRowMenu, true);
    if (T.gesture === "menu") endGesture();
  }
  function openRowMenu(btn, key) {
    closeRowMenu();
    var row = T.rowByKey[key];
    if (!row) return;
    T.gesture = "menu";
    var nestOk = canNestUnder(key, 0);
    var nDesc = descendantsOf(key).length;
    var bk = document.createElement("div");
    bk.className = "to-menu-backdrop";
    bk.id = "toRowMenuBk";
    bk.addEventListener("pointerdown", function (e) { e.preventDefault(); e.stopPropagation(); closeRowMenu(); });
    document.body.appendChild(bk);
    var m = document.createElement("div");
    m.className = "to-menu";
    m.id = "toRowMenu";
    m.innerHTML =
      '<button data-act="detail">Details</button>' +
      '<button data-act="below">＋ Insert below</button>' +
      (nestOk ? '<button data-act="child">↳ Add component inside</button>' : "") +
      '<button data-act="del" class="to-menu-danger">🗑 Delete' +
        (nDesc ? " (with " + nDesc + " component" + (nDesc === 1 ? "" : "s") + ")" : "") + "</button>";
    document.body.appendChild(m);
    var r = btn.getBoundingClientRect();
    var mw = 240, mh = m.offsetHeight || 190;
    var left = Math.min(r.left, window.innerWidth - mw - 8);
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    m.style.left = left + "px";
    m.style.top = top + "px";
    m.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        var act = b.getAttribute("data-act");
        closeRowMenu();
        if (act === "detail") openDetail(key);
        else if (act === "below") spawnEntry({ t: "after", key: key });
        else if (act === "child") spawnEntry({ t: "child", key: key });
        else if (act === "del") deleteSelection([key]);
      };
    });
    window.addEventListener("scroll", closeRowMenu, true);
  }

  function clearHold() { if (T && T.holdTimer) { clearTimeout(T.holdTimer); T.holdTimer = null; } }

  /* ── drag engine (grip tap = select, grip drag = move) ── */
  function wireDrag() {
    var tbl = el("toTable");
    if (!tbl || tbl._dragWired) return;
    tbl._dragWired = true;
    tbl.addEventListener("pointerdown", function (e) {
      var grip = e.target.closest ? e.target.closest("[data-grip]") : null;
      if (!grip) return;
      // Right-click on the grip opens the row menu (see the contextmenu handler
      // in wire()). It must not also start a drag or toggle the selection, so
      // only the primary button drives this gesture.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (T.drag) return;   // one gesture at a time
      e.preventDefault();
      // commit any open cell editor before the gesture starts
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      var key = grip.getAttribute("data-grip");
      var isTouch = e.pointerType === "touch";
      var st = { key: key, x0: e.clientX, y0: e.clientY, isTouch: isTouch, started: false };
      T.drag = st;
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      var thresh = isTouch ? 12 : 6;
      // A tablet has no right-click, and the ⋯ button is gone, so hold the grip
      // to reach the same menu. Cancelled the moment the finger travels far
      // enough to mean "drag".
      // The timer lives on T, not on st, because a background save can re-render
      // the table mid-hold and detach this grip. Detaching releases pointer
      // capture WITHOUT firing pointercancel, so onUp/onCancel never run on the
      // dead node and a timer kept only in the closure would fire into nothing.
      // render() clears it.
      if (isTouch) {
        clearHold();
        T.holdTimer = setTimeout(function () {
          T.holdTimer = null;
          if (st.started || T.drag !== st || !grip.isConnected) return;
          st.longPressed = true;
          T.drag = null;
          cleanup();
          try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
          openRowMenu(grip, key);
        }, 500);
      }
      function onMove(ev) {
        if (!st.started) {
          if (Math.abs(ev.clientX - st.x0) + Math.abs(ev.clientY - st.y0) < thresh) return;
          clearHold();
          startDrag(st);
        }
        dragMove(ev.clientX, ev.clientY);
      }
      function onUp(ev) {
        clearHold();
        cleanup();
        if (st.longPressed) return;         // the menu already took this gesture
        if (st.started) finishDrag();
        else {
          T.drag = null;
          // shift-tap selects the whole range from the last picked row
          if (ev.shiftKey && T.lastSelKey && T.lastSelKey !== key) {
            var order = visibleRows().map(function (r) { return r._k; });
            var a = order.indexOf(T.lastSelKey), b = order.indexOf(key);
            if (a !== -1 && b !== -1) {
              var lo = Math.min(a, b), hi = Math.max(a, b);
              for (var i = lo; i <= hi; i++) T.sel[order[i]] = 1;
            } else T.sel[key] = 1;
          } else {
            if (T.sel[key]) delete T.sel[key]; else T.sel[key] = 1;
          }
          T.lastSelKey = key;
          render();
        }
      }
      function onCancel() { clearHold(); cleanup(); if (st.started) abortDrag(); else T.drag = null; }
      function cleanup() {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onCancel);
      }
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onCancel);
    });

    // ── group headers: tap = select the group, drag = reorder it ──
    tbl.addEventListener("pointerdown", function (e) {
      var grip = e.target.closest ? e.target.closest("[data-gselgrip]") : null;
      if (!grip) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;   // right-click is not a drag
      if (T.drag) return;   // one gesture at a time
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      var tr0 = grip.closest("tr");
      var path = pathFromAttr(grip.getAttribute("data-gselgrip"));
      var st = {
        mode: "group", path: path,
        depth: Number(tr0.getAttribute("data-gdepth")),
        loc: tr0.getAttribute("data-gloc") || "", cat: tr0.getAttribute("data-gcat") || "",
        sub: tr0.getAttribute("data-gsub") || "",
        x0: e.clientX, y0: e.clientY, isTouch: e.pointerType === "touch", started: false,
      };
      T.drag = st;
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      var thresh = st.isTouch ? 12 : 6;
      function onMove(ev) {
        if (!st.started) {
          if (Math.abs(ev.clientX - st.x0) + Math.abs(ev.clientY - st.y0) < thresh) return;
          startGroupDrag(st);
        }
        if (st.started) groupDragMove(ev.clientX, ev.clientY);
      }
      function onUp() {
        cleanup();
        if (st.started) { finishGroupDrag(); return; }
        T.drag = null;
        // tap: toggle the group's visible rows
        var rows = visibleRows().filter(function (r) {
          var rp = LEVELS.map(function (L) { return gkey(r[L.f]); }).join(SEP);
          return rp === path || rp.indexOf(path + SEP) === 0;
        });
        var allSel = rows.length && rows.every(function (r) { return T.sel[r._k]; });
        rows.forEach(function (r) { if (allSel) delete T.sel[r._k]; else T.sel[r._k] = 1; });
        render();
      }
      function onCancel() { cleanup(); if (st.started) abortGroupDrag(); else T.drag = null; }
      function cleanup() {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        grip.removeEventListener("pointercancel", onCancel);
      }
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
      grip.addEventListener("pointercancel", onCancel);
    });
  }

  /* ── group reorder drag ── */
  function groupKindLabel(depth) { return depth === 0 ? "Level" : depth === 1 ? "Category" : "Sub-category"; }
  function startGroupDrag(st) {
    st.started = true;
    st.gname = st.depth === 0 ? st.loc : st.depth === 1 ? st.cat : st.sub;
    st.kindLabel = groupKindLabel(st.depth);
    st.canReorder = !!currentHeader() && T.canManage && !T.view.est;
    // same-parent sibling count, from the unfiltered tree
    var tree = currentGroupTree();
    var sibs = [];
    if (st.depth === 0) tree.forEach(function (L) { sibs.push(L.n); });
    else tree.forEach(function (L) {
      if (normName(L.n) !== normName(st.loc)) return;
      if (st.depth === 1) L.cats.forEach(function (C) { sibs.push(C.n); });
      else L.cats.forEach(function (C) {
        if (normName(C.n) === normName(st.cat)) (C.subs || []).forEach(function (S) { sibs.push(S); });
      });
    });
    st.sibCount = sibs.length;
    // collapse sibling subtrees for a compact reorder view — BEFORE arming the
    // gesture, or that render would be swallowed by the gesture guard
    st.collapsedSnap = {};
    Object.keys(T.collapsed).forEach(function (k) { st.collapsedSnap[k] = T.collapsed[k]; });
    if (st.canReorder && st.sibCount >= 2) {
      scopeRows().forEach(function (r) {
        var keys = LEVELS.map(function (L) { return gkey(r[L.f]); });
        var parentOk = st.depth === 0 ||
          (normName(keys[0]) === normName(st.loc) && (st.depth === 1 || normName(keys[1]) === normName(st.cat)));
        if (parentOk && keys[st.depth] !== "") T.collapsed[keys.slice(0, st.depth + 1).join(SEP)] = 1;
      });
      render();
    }
    T.gesture = "drag";
    var tbl2 = el("toTable");
    if (tbl2) tbl2.classList.add("to-dragmode");
    var g = document.createElement("div");
    g.className = "to-ghost";
    g.innerHTML = "<b>" + esc(glabel(st.gname)) + '</b><span class="to-ghost-label" id="toGhostLbl"></span>';
    document.body.appendChild(g);
    st.ghost = g;
    var line = document.createElement("div");
    line.className = "to-drop-line";
    line.style.display = "none";
    document.body.appendChild(line);
    st.line = line;
    st.escHandler = function (e) { if (e.key === "Escape") abortGroupDrag(); };
    document.addEventListener("keydown", st.escHandler);
    st.autoScroll = requestAnimationFrame(function tick() {
      if (!T.drag || !T.drag.started) return;
      var y = st.lastY || 0, vh = window.innerHeight, dy = 0;
      if (y > 0 && y < 60) dy = -((60 - y) / 60) * 24;
      else if (y > vh - 80) dy = ((y - (vh - 80)) / 80) * 24;
      if (dy) { window.scrollBy(0, dy); groupDragMove(st.lastX, st.lastY); }
      st.autoScroll = requestAnimationFrame(tick);
    });
    var lbl = el("toGhostLbl");
    if (lbl) {
      if (!st.canReorder) {
        lbl.textContent = currentHeader()
          ? "You need takeoff-manage access to reorder"
          : "Convert to a takeoff record to reorder groups";
      } else if (st.sibCount < 2) {
        lbl.textContent = "Only one " + st.kindLabel.toLowerCase() + " here — nothing to reorder";
      }
    }
  }
  function groupDragMove(x, y) {
    var st = T.drag;
    if (!st || st.mode !== "group" || !st.started) return;
    st.lastX = x; st.lastY = y;
    st.ghost.style.left = (x + 12) + "px";
    st.ghost.style.top = (y + 12) + "px";
    var lbl = el("toGhostLbl");
    st.target = null;
    if (!st.canReorder || st.sibCount < 2) { st.line.style.display = "none"; return; }
    var elAt = document.elementFromPoint(x, y);
    var tr = elAt && elAt.closest ? elAt.closest("tr") : null;
    if (tr && tr.classList.contains("pj-grp")) {
      var d = Number(tr.getAttribute("data-gdepth"));
      var loc = tr.getAttribute("data-gloc") || "", cat = tr.getAttribute("data-gcat") || "", sub = tr.getAttribute("data-gsub") || "";
      var name = d === 0 ? loc : d === 1 ? cat : sub;
      if (d === st.depth && normName(name) !== normName(st.gname)) {
        var sameParent = d === 0 ||
          (normName(loc) === normName(st.loc) && (d === 1 || normName(cat) === normName(st.cat)));
        if (sameParent) {
          var rect = tr.getBoundingClientRect();
          var zone = y < rect.top + rect.height / 2 ? "above" : "below";
          st.target = { name: name, zone: zone };
          st.line.style.display = "block";
          st.line.style.left = (rect.left - 3) + "px";
          st.line.style.width = (rect.width + 6) + "px";
          st.line.style.top = ((zone === "above" ? rect.top : rect.bottom) - 2) + "px";
          if (lbl) lbl.textContent = glabel(st.gname) + " — " + zone + " " + glabel(name);
          return;
        }
        st.line.style.display = "none";
        if (lbl) lbl.textContent = "Stays inside " + glabel(d === 1 ? loc : cat) + " — drag its items instead";
        return;
      }
    }
    st.line.style.display = "none";
    if (lbl) lbl.textContent = "Drop on another " + st.kindLabel + " header to reorder";
  }
  function abortGroupDrag() {
    var st = T.drag;
    if (!st) return;
    clearDragVisuals(st);
    if (st.collapsedSnap) T.collapsed = st.collapsedSnap;
    T.drag = null;
    T.suppressClickUntil = Date.now() + 400;
    endGesture();
  }
  function finishGroupDrag() {
    var st = T.drag;
    if (!st) return;
    var target = st.target;
    clearDragVisuals(st);
    if (st.collapsedSnap) T.collapsed = st.collapsedSnap;
    T.drag = null;
    T.suppressClickUntil = Date.now() + 400;
    endGesture();
    if (!st.canReorder || st.sibCount < 2) { render(); return; }
    if (!target) {
      msg("ok", "Nothing moved — drop on another " + st.kindLabel + " header to reorder.");
      render();
      return;
    }
    var levels = currentGroupTree();
    function move(arr, nameOf) {
      var from = -1, i;
      for (i = 0; i < arr.length; i++) if (normName(nameOf(arr[i])) === normName(st.gname)) { from = i; break; }
      if (from === -1) return false;
      var entry = arr.splice(from, 1)[0];
      var at = -1;
      for (i = 0; i < arr.length; i++) if (normName(nameOf(arr[i])) === normName(target.name)) { at = i; break; }
      if (at === -1) { arr.splice(from, 0, entry); return false; }
      arr.splice(target.zone === "above" ? at : at + 1, 0, entry);
      return true;
    }
    var ok = false;
    if (st.depth === 0) ok = move(levels, function (L) { return L.n; });
    else {
      for (var i = 0; i < levels.length; i++) {
        if (normName(levels[i].n) !== normName(st.loc)) continue;
        if (st.depth === 1) ok = move(levels[i].cats, function (C) { return C.n; });
        else {
          for (var j = 0; j < levels[i].cats.length; j++) {
            if (normName(levels[i].cats[j].n) === normName(st.cat)) {
              levels[i].cats[j].subs = levels[i].cats[j].subs || [];
              ok = move(levels[i].cats[j].subs, function (S) { return S; });
            }
          }
        }
      }
    }
    if (!ok) { render(); return; }
    saveLayout(levels, "\u2713 " + glabel(st.gname) + " moved \u2014 drag again to change (not in Undo)");
  }

  function dragPayload(key) {
    var keys = T.sel[key] ? selKeys() : [key];
    var expanded = expandKeys(keys);
    return { roots: rootsOf(expanded), all: expanded };
  }
  function startDrag(st) {
    T.gesture = "drag";
    st.started = true;
    st.payload = dragPayload(st.key);
    st.inPayload = {};
    st.payload.all.forEach(function (k) { st.inPayload[k] = 1; });
    // tallest dragged subtree — nesting must fit target depth + this + itself
    st.subH = 0;
    st.payload.roots.forEach(function (k) { st.subH = Math.max(st.subH, subtreeHeightOf(k)); });
    var tbl = el("toTable");
    if (tbl) tbl.classList.add("to-dragmode");
    // dim the dragged subtree so "can't drop on itself" is visible, not silent
    st.payload.all.forEach(function (k) {
      var tr = tbl && tbl.querySelector('tr[data-k="' + k + '"]');
      if (tr) tr.classList.add("to-dragsrc");
    });
    var g = document.createElement("div");
    g.className = "to-ghost";
    g.innerHTML = "<b>" + st.payload.roots.length + " item" + (st.payload.roots.length === 1 ? "" : "s") + '</b><span class="to-ghost-label" id="toGhostLbl"></span>';
    document.body.appendChild(g);
    st.ghost = g;
    var line = document.createElement("div");
    line.className = "to-drop-line";
    line.style.display = "none";
    document.body.appendChild(line);
    st.line = line;
    st.zone = null;
    st.escHandler = function (e) { if (e.key === "Escape") abortDrag(); };
    document.addEventListener("keydown", st.escHandler);
    st.autoScroll = requestAnimationFrame(function tick() {
      if (!T.drag || !T.drag.started) return;
      var y = st.lastY || 0;
      var vh = window.innerHeight;
      var dy = 0;
      if (y > 0 && y < 60) dy = -((60 - y) / 60) * 24;
      else if (y > vh - 80) dy = ((y - (vh - 80)) / 80) * 24;
      if (dy) {
        window.scrollBy(0, dy);
        dragMove(st.lastX, st.lastY);   // re-hit-test under a stationary finger
      }
      st.autoScroll = requestAnimationFrame(tick);
    });
  }
  function dragMove(x, y) {
    var st = T.drag;
    if (!st || !st.started) return;
    st.lastX = x; st.lastY = y;
    st.ghost.style.left = (x + 12) + "px";
    st.ghost.style.top = (y + 12) + "px";
    var elAt = document.elementFromPoint(x, y);
    var tr = elAt && elAt.closest ? elAt.closest("tr") : null;
    var target = null;
    st.hint = "";
    if (tr && tr.classList.contains("to-row")) {
      var tKey = tr.getAttribute("data-k");
      if (st.inPayload[tKey]) {
        st.hint = "Can't drop inside itself";
      } else {
        var rect = tr.getBoundingClientRect();
        var tRow = T.rowByKey[tKey];
        // any row can host components — unless it's the dragged subtree, the
        // result would be too deep, or (on touch) it's already nested (finger
        // jitter makes deep nest bands hostile; the row menu covers those)
        var canNest = !!tRow && !isEstimateRow(tRow), whyNot = "";
        if (canNest && st.isTouch && depthOf(tKey) > 0) { canNest = false; whyNot = "Hold the ⠿ grip for the row menu to nest deeper"; }
        if (canNest && !canNestUnder(tKey, st.subH)) { canNest = false; whyNot = "Too deep — " + MAX_NEST + " levels max"; }
        // Placing between rows is the common move, so it gets the outer third of
        // the row on each side; only the middle band nests.
        var band = Math.max(st.isTouch ? 14 : 10, Math.round(rect.height * 0.35));
        if (!canNest) band = rect.height / 2;
        var zone;
        if (y < rect.top + band) zone = "above";
        else if (y > rect.bottom - band) zone = "below";
        else zone = canNest ? "nest" : (y < rect.top + rect.height / 2 ? "above" : "below");
        // hysteresis: stick to the previous zone until clearly past the boundary
        if (st.zone && st.zone.key === tKey && st.zone.zone !== zone) {
          var edge = st.zone.zone === "above" ? rect.top + band : st.zone.zone === "below" ? rect.bottom - band : null;
          if (edge != null && Math.abs(y - edge) < 4) zone = st.zone.zone;
        }
        // explain the missing nest band while the pointer rides the middle
        if (whyNot && y > rect.top + rect.height * 0.35 && y < rect.bottom - rect.height * 0.35) st.hint = whyNot;
        target = { key: tKey, zone: zone, rect: rect };
      }
    } else if (tr && tr.classList.contains("pj-grp")) {
      // hovering a header = first position inside that group
      target = {
        gloc: tr.getAttribute("data-gloc"), gcat: tr.getAttribute("data-gcat"), gsub: tr.getAttribute("data-gsub"),
        gdepth: Number(tr.getAttribute("data-gdepth")),
        zone: "group-top", rect: tr.getBoundingClientRect(),
      };
    }
    st.zone = target;
    paintDropIndicator(st);
    var lbl = el("toGhostLbl");
    if (lbl) {
      if (st.hint) lbl.textContent = st.hint;
      else if (!target) lbl.textContent = "";
      else if (target.zone === "nest") {
        var tgt = T.rowByKey[target.key] || {};
        lbl.textContent = "Into: " + (tgt.itemPurpose || tgt.itemName || "item");
      }
      else if (target.zone === "group-top") lbl.textContent = "Into " + glabel(target.gdepth >= 2 ? target.gsub : target.gdepth === 1 ? target.gcat : target.gloc);
      else {
        // name what it lands between, so the line is never ambiguous
        var ord = visibleRows();
        var ti = -1;
        ord.forEach(function (r, i) { if (r._k === target.key) ti = i; });
        var aRow = target.zone === "above" ? ord[ti - 1] : ord[ti];
        var bRow = target.zone === "above" ? ord[ti] : ord[ti + 1];
        function nm(r) { return r ? (r.itemPurpose || r.itemName || "item") : null; }
        var an = nm(aRow), bn = nm(bRow);
        lbl.textContent = an && bn ? ("Between " + an + " and " + bn)
          : an ? ("After " + an) : bn ? ("Before " + bn) : "";
      }
    }
  }
  function paintDropIndicator(st) {
    document.querySelectorAll(".to-drop-nest").forEach(function (n) { n.classList.remove("to-drop-nest"); });
    var z = st.zone;
    if (!z) { st.line.style.display = "none"; return; }
    if (z.zone === "nest") {
      st.line.style.display = "none";
      var tr = el("toTable").querySelector('tr[data-k="' + z.key + '"]');
      if (tr) tr.classList.add("to-drop-nest");
      return;
    }
    var y = z.zone === "above" ? z.rect.top : z.rect.bottom;
    st.line.style.display = "block";
    st.line.style.left = (z.rect.left - 3) + "px";
    st.line.style.width = (z.rect.width + 6) + "px";
    st.line.style.top = (y - 2) + "px";
  }
  function clearDragVisuals(st) {
    if (st.autoScroll) cancelAnimationFrame(st.autoScroll);
    if (st.escHandler) document.removeEventListener("keydown", st.escHandler);
    if (st.ghost) st.ghost.remove();
    if (st.line) st.line.remove();
    document.querySelectorAll(".to-drop-nest").forEach(function (n) { n.classList.remove("to-drop-nest"); });
    document.querySelectorAll(".to-dragsrc").forEach(function (n) { n.classList.remove("to-dragsrc"); });
    var tbl = el("toTable");
    if (tbl) tbl.classList.remove("to-dragmode");
  }
  function abortDrag() {
    var st = T.drag;
    if (!st) return;
    clearDragVisuals(st);
    T.drag = null;
    T.suppressClickUntil = Date.now() + 400;
    endGesture();
  }
  function finishDrag() {
    var st = T.drag;
    if (!st) return;
    var z = st.zone;
    var payload = st.payload;
    clearDragVisuals(st);
    T.drag = null;
    T.suppressClickUntil = Date.now() + 400;
    endGesture();
    if (!z) return;
    var roots = payload.roots.map(function (k) { return T.rowByKey[k]; }).filter(Boolean);
    if (!roots.length) return;

    if (z.zone === "nest") {
      var target = T.rowByKey[z.key];
      if (!target) return;
      // re-check at commit time: the tree may have shifted mid-gesture
      if (payload.all.indexOf(z.key) !== -1) { msg("err", "An item can't go inside itself."); return; }
      var maxH = 0;
      payload.roots.forEach(function (k) { maxH = Math.max(maxH, subtreeHeightOf(k)); });
      if (!canNestUnder(z.key, maxH)) {
        msg("err", "Too deep — an item can hold " + MAX_NEST + " levels of components.");
        return;
      }
      var comps = componentsOf(z.key);
      var plan = planPlacement(comps, comps.length, roots);
      var ops = [], inv = [];
      roots.forEach(function (row, i) {
        var fields = {
          parentRef: z.key,
          itemLocation: target.itemLocation == null ? null : target.itemLocation,
          itemCategory: target.itemCategory == null ? null : target.itemCategory,
          itemSubCategory: target.itemSubCategory == null ? null : target.itemSubCategory,
          itemSortingNumber: plan.sorts[i],
        };
        updPair(ops, inv, row, fields);
        // the whole dragged subtree inherits the destination group
        descendantsOf(row._k).forEach(function (c) {
          var cf = {};
          LEVELS.forEach(function (L) {
            if (gkey(c[L.f]) !== gkey(target[L.f])) cf[L.f] = target[L.f] == null ? null : target[L.f];
          });
          if (Object.keys(cf).length) updPair(ops, inv, c, cf);
        });
      });
      plan.renumber.forEach(function (rn) { updPair(ops, inv, rn.row, { itemSortingNumber: rn.sort }); });
      // dropping into a collapsed assembly must not make rows vanish
      [z.key].concat(ancestorsOf(z.key)).forEach(function (k) { delete T.collapsed["asm:" + k]; });
      apply({ label: "Nested " + roots.length + " under " + (target.itemPurpose || target.itemName || "item"), ops: ops, inverse: inv });
      return;
    }

    // between rows / group top: resolve destination leaf + insertion index
    var destLoc, destCat, destSub, destParent = null, sibs, insertIdx;
    if (z.zone === "group-top") {
      destLoc = z.gloc; destCat = z.gdepth >= 1 ? z.gcat : ""; destSub = z.gdepth >= 2 ? z.gsub : "";
      sibs = topSibsOf(destLoc, destCat, destSub);
      insertIdx = 0;
    } else {
      var tRow = T.rowByKey[z.key];
      if (!tRow) return;
      destLoc = gkey(tRow.itemLocation); destCat = gkey(tRow.itemCategory); destSub = gkey(tRow.itemSubCategory);
      destParent = parentKeyOf(tRow);   // between components = join the assembly
      if (destParent) {
        // never re-parent into the dragged subtree (cycle), and respect the cap
        if (payload.all.indexOf(destParent) !== -1) destParent = null;
        else {
          var anc = ancestorsOf(destParent);
          for (var ci = 0; ci < anc.length; ci++) {
            if (payload.all.indexOf(anc[ci]) !== -1) { destParent = null; break; }
          }
        }
      }
      if (destParent) {
        var mh = 0;
        payload.roots.forEach(function (k) { mh = Math.max(mh, subtreeHeightOf(k)); });
        if (!canNestUnder(destParent, mh)) {
          msg("err", "Too deep — an item can hold " + MAX_NEST + " levels of components.");
          return;
        }
      }
      sibs = destParent ? componentsOf(destParent) : topSibsOf(destLoc, destCat, destSub);
      var ti = sibs.indexOf(tRow);
      insertIdx = ti === -1 ? sibs.length : (z.zone === "above" ? ti : ti + 1);
    }
    var plan2 = planPlacement(sibs, insertIdx, roots);
    var ops2 = [], inv2 = [];
    roots.forEach(function (row, i) {
      var fields = { itemSortingNumber: plan2.sorts[i] };
      if (gkey(row.itemLocation) !== destLoc) fields.itemLocation = destLoc || null;
      if (gkey(row.itemCategory) !== destCat) fields.itemCategory = destCat || null;
      if (gkey(row.itemSubCategory) !== destSub) fields.itemSubCategory = destSub || null;
      var curParent = parentKeyOf(row);
      if ((destParent || null) !== (curParent || null)) fields.parentRef = destParent || null;
      updPair(ops2, inv2, row, fields);
      descendantsOf(row._k).forEach(function (c) {
        var cf = {};
        if (gkey(c.itemLocation) !== destLoc) cf.itemLocation = destLoc || null;
        if (gkey(c.itemCategory) !== destCat) cf.itemCategory = destCat || null;
        if (gkey(c.itemSubCategory) !== destSub) cf.itemSubCategory = destSub || null;
        if (Object.keys(cf).length) updPair(ops2, inv2, c, cf);
      });
    });
    plan2.renumber.forEach(function (rn) { updPair(ops2, inv2, rn.row, { itemSortingNumber: rn.sort }); });
    apply({ label: "Moved " + roots.length + " item" + (roots.length === 1 ? "" : "s"), ops: ops2, inverse: inv2 });
  }
  function topSibsOf(loc, cat, sub) {
    return scopeRows().filter(function (r) {
      return !parentKeyOf(r) &&
        gkey(r.itemLocation) === gkey(loc) && gkey(r.itemCategory) === gkey(cat) && gkey(r.itemSubCategory) === gkey(sub);
    }).sort(function (a, b) { return num(a.itemSortingNumber) - num(b.itemSortingNumber) || num(a.id) - num(b.id); });
  }

  /* ── category chips + purpose picker ── */
  function openCatChips(levelName) {
    var existing = {};
    scopeRows().forEach(function (r) {
      if (gkey(r.itemLocation) === levelName && r.itemCategory) existing[stemCat(r.itemCategory)] = 1;
    });
    var options = CAT_CHIPS.filter(function (c) { return !existing[stemCat(c)]; });
    var box = el("toCatModal");
    el("toCatTitle").textContent = "Add a category to " + (levelName || "(none)");
    el("toCatBody").innerHTML =
      '<div class="pj-tagwrap">' + options.map(function (c) {
        return '<button class="pj-tag" data-cat-pick="' + esc(c) + '">' + esc(c) + "</button>";
      }).join("") + "</div>" +
      '<div class="pj-f" style="margin-top:10px"><label>Or type your own</label>' +
      '<input id="toCatFree" placeholder="Category name"></div>';
    box.classList.add("open");
    box.querySelectorAll("[data-cat-pick]").forEach(function (b) {
      b.onclick = function () { box.classList.remove("open"); catChosen(levelName, b.getAttribute("data-cat-pick")); };
    });
    el("toCatFree").onkeydown = function (e) {
      if (e.key === "Enter") {
        var v = this.value.trim();
        if (!v) return;
        box.classList.remove("open");
        catChosen(levelName, v);
      }
    };
    el("toCatGo").onclick = function () {
      var v = el("toCatFree").value.trim();
      if (!v) return;
      box.classList.remove("open");
      catChosen(levelName, v);
    };
  }
  function catChosen(levelName, cat) {
    addPending({ depth: 1, loc: levelName, cat: cat, sub: "" });
    layoutOnAdd("cat", levelName, cat, "");
    openPurposePicker(levelName, cat, "");
  }
  function openPurposePicker(levelName, cat, sub) {
    var matches = purposesFor(cat);
    var box = el("toPpModal");
    el("toPpTitle").textContent = matches.length
      ? "Usual " + cat + " purposes — pick the ones you need"
      : "Add purposes to " + (cat || "(none)");
    // what this leaf already holds — reopening the picker must not create doubles
    var used = {};
    scopeRows().forEach(function (r) {
      if (parentKeyOf(r)) return;
      if (gkey(r.itemLocation) === gkey(levelName) && gkey(r.itemCategory) === gkey(cat) &&
          gkey(r.itemSubCategory) === gkey(sub) && r.itemPurpose) {
        used[normName(r.itemPurpose)] = 1;
      }
    });
    var usedCount = 0;
    matches.forEach(function (p) { if (used[normName(p.name)]) usedCount++; });
    var html = "";
    if (!matches.length) {
      html += '<div class="pj-sub" style="margin-bottom:8px">No saved purposes for “' + esc(cat) + '” yet — type them below, one per line.</div>';
    } else {
      html += '<div class="pj-sub" style="margin-bottom:8px">' + usedCount + " of " + matches.length +
        " usual " + esc(cat) + " purposes already in this group.</div>" +
        '<div class="tk-pplist">' + matches.map(function (p, i) {
        var isUsed = !!used[normName(p.name)];
        return '<label class="tk-pp' + (isUsed ? " tk-pp-used" : "") + '"><input type="checkbox" data-pp="' + i + '"' +
          (isUsed ? " checked disabled" : "") + "> " + esc(p.name) +
          (isUsed ? ' <span class="pj-sub">✓ already added</span>' : "") + "</label>";
      }).join("") + "</div>";
    }
    html += '<div class="pj-f" style="margin-top:10px"><label>Extra purposes (one per line)</label>' +
      '<textarea id="toPpFree" rows="2" placeholder="e.g. Double Plates&#10;Trimmers"></textarea></div>';
    el("toPpBody").innerHTML = html;
    el("toPpGo").textContent = "Add selected";
    el("toPpGo").onclick = function () {
      var picked = [];
      box.querySelectorAll("[data-pp]").forEach(function (cb) {
        if (cb.checked && !cb.disabled) picked.push(matches[+cb.getAttribute("data-pp")]);
      });
      String((el("toPpFree").value || "")).split(/\r?\n/).forEach(function (line) {
        var v = line.trim();
        if (v) picked.push({ name: v, sort: 0 });
      });
      box.classList.remove("open");
      if (!picked.length) return;
      var base = 0;
      scopeRows().forEach(function (r) {
        if (gkey(r.itemLocation) === levelName && gkey(r.itemCategory) === cat && gkey(r.itemSubCategory) === gkey(sub)) {
          base = Math.max(base, num(r.itemSortingNumber));
        }
      });
      var list = picked.map(function (p, i) {
        var f = {
          itemPurpose: p.name,
          itemLocation: levelName || null, itemCategory: cat || null, itemSubCategory: sub || null,
          itemSortingNumber: base + ((p.sort || i + 1) * 10),
        };
        stampLink(f);
        return f;
      });
      apply(cmdAddMany(list, "Added " + list.length + " purpose" + (list.length === 1 ? "" : "s") + " to " + (cat || "(none)")));
    };
    box.classList.add("open");
  }
  function stampLink(fields) {
    var h = currentHeader();
    if (h) {
      fields.takeoffID = Number(h.id);
      fields.takeoffName = h.takeoffName || "";
    } else if (T.view.nameKey != null) {
      fields.takeoffName = T.view.nameKey || null;
    }
    return fields;
  }

  /* Suggestion lists position FIXED from their input: the table wrapper
     scrolls horizontally (overflow clips), and near the first rows there is
     nothing below to overlap anyway. Flips upward near the viewport bottom. */
  /* Choosing a row out of a suggestion list.

     Mouse and pen commit on pointerdown: preventDefault there keeps focus in the
     input, so the blur handler cannot close the list out from under the click.

     Touch cannot do that. pointerdown fires the instant a finger lands, before
     anyone knows whether this is a tap or the start of a scroll — and the list
     scrolls (max-height 270px, eight results). Committing then means a crew
     member swiping down the list writes whichever material they happened to
     touch first into the row. So on touch we wait for the finger to come up and
     only count it if it stayed put.

     Either way the trailing click gets suppressed: the pick re-renders the grid,
     so that click would land on whatever row slid under the pointer and open an
     editor there. */
  function tapPick(node, choose) {
    var TAP_SLOP = 10;
    node.onpointerdown = function (e) {
      if (e.pointerType === "touch") { node._px = e.clientX; node._py = e.clientY; return; }
      e.preventDefault();
      T.suppressClickUntil = Date.now() + 500;
      choose();
    };
    node.onpointerup = function (e) {
      if (e.pointerType !== "touch" || node._px == null) return;
      var moved = Math.abs(e.clientX - node._px) + Math.abs(e.clientY - node._py);
      node._px = node._py = null;
      if (moved > TAP_SLOP) return;          // that was a scroll, not a choice
      e.preventDefault();
      T.suppressClickUntil = Date.now() + 500;
      choose();
    };
    node.onpointercancel = function () { node._px = node._py = null; };
  }

  function placeSug(input, sugEl) {
    var r = input.getBoundingClientRect();
    var w = Math.max(r.width, 300);
    var left = Math.max(4, Math.min(r.left, window.innerWidth - w - 8));
    sugEl.style.position = "fixed";
    sugEl.style.left = left + "px";
    sugEl.style.width = w + "px";
    sugEl.style.right = "auto";
    sugEl.style.margin = "0";
    var below = window.innerHeight - r.bottom;
    if (below < 240 && r.top > 280) {
      sugEl.style.top = "auto";
      sugEl.style.bottom = (window.innerHeight - r.top + 4) + "px";
    } else {
      sugEl.style.bottom = "auto";
      sugEl.style.top = (r.bottom + 4) + "px";
    }
  }

  /* ── shared suggestion dropdown ── */
  function attachMatcher(input, sugEl, onChoose) {
    var picks = [], cur = -1;
    function close() { sugEl.innerHTML = ""; sugEl.classList.remove("on"); picks = []; cur = -1; }
    function show() {
      picks = matchMaterials(input.value, 8);
      if (!picks.length) { close(); return; }
      sugEl.innerHTML = picks.map(function (m, i) {
        return '<div class="to-sugi' + (i === cur ? " on" : "") + '" data-si="' + i + '">' +
          '<span class="to-sugn">' + esc(m.itemName || "") + "</span>" +
          (m.itemCode ? '<span class="to-sugc">' + esc(m.itemCode) + "</span>" : "") +
          (m.itemType ? '<span class="to-sugt">' + esc(m.itemType) + "</span>" : "") +
          (m.itemPrice != null && num(m.itemPrice) ? '<span class="to-sugp">' + money(m.itemPrice) + "</span>" : "") +
          "</div>";
      }).join("");
      sugEl.classList.add("on");
      placeSug(input, sugEl);
      sugEl.querySelectorAll("[data-si]").forEach(function (d) {
        // pointerdown, not click: the pick re-renders the table underneath, so
        // by the time a click would resolve, the element pressed is gone.
        // preventDefault keeps focus in the input so the list is not closed by
        // the blur handler first.
        //
        // The same re-render is why the trailing click has to be swallowed —
        // mouseup lands on whatever row now sits under the cursor, and that
        // cell's handler would open an editor on a row nobody asked for. That
        // is what made picking with the mouse feel broken and left the arrow
        // keys as the only reliable way through.
        tapPick(d, function () {
          var m = picks[+d.getAttribute("data-si")];
          if (!m) return;
          close();
          onChoose(m);
        });
      });
    }
    input.addEventListener("input", function () { cur = -1; show(); });
    input.addEventListener("blur", function () { setTimeout(close, 120); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (picks.length) { cur = Math.min(cur + 1, picks.length - 1); show(); } }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (picks.length) { cur = Math.max(cur - 1, 0); show(); } }
      else if (e.key === "Enter" && cur >= 0 && picks[cur]) { e.preventDefault(); var m = picks[cur]; close(); onChoose(m); }
      else if (e.key === "Enter") close(); // no highlight: let Enter act on the field itself
      else if (e.key === "Escape") close();
    });
    return { close: close, hasPick: function () { return cur >= 0; } };
  }

  /* ── inline cell editing ──────────────────────────────────────────────
     Saving re-renders the table, and a save lands a few hundred milliseconds
     after the keystroke that caused it. Without T.editing, Tab looked like it
     worked — focus moved to the next cell — and then the write from the
     PREVIOUS cell came back, render() rebuilt the table, and the cell you were
     already typing into evaporated. So the open editor is state, not just DOM:
     it is recorded here and put back at the end of every render, caret and all,
     which makes a background save invisible to the typist. */
  var EDIT_ORDER = ["itemPurpose", "itemName", "itemQty", "itemType", "itemPrice"];
  function restoreEditor() {
    var e = T.editing;
    if (!e) return;
    var tr = T.pane && T.pane.querySelector('tr.to-row[data-k="' + cssq(e.key) + '"]');
    var td = tr && tr.querySelector('[data-edit="' + e.field + '"]');
    if (!td) { T.editing = null; return; }   // the row went away (deleted, filtered, collapsed)
    if (td.querySelector("input")) return;   // still open — nothing to put back
    editCell(td, e);
  }
  // attribute-selector quoting: keys are ours, but a stray quote would break
  // the selector rather than merely miss
  function cssq(v) { return String(v == null ? "" : v).replace(/["\\]/g, "\\$&"); }
  function editCell(td, restore) {
    if (td.querySelector("input")) return;
    var tr = td.parentNode, key = tr.getAttribute("data-k"), field = td.getAttribute("data-edit");
    var row = T.rowByKey[key];
    if (!row) return;
    var raw = field === "itemQty" ? qtyDisp(row.itemQty) : (row[field] == null ? "" : String(row[field]));
    var inp = document.createElement("input");
    inp.className = "to-in";
    inp.value = restore ? restore.value : raw;
    // Carry the caret forward. One save fires render() THREE times in a row
    // (apply's callback, runCommand's tail, then drainQueue), so if a restore
    // dropped the caret the second pass would fall through to inp.select() and
    // the next keystroke would replace the whole cell — the exact data loss
    // T.editing exists to prevent, one keystroke later.
    T.editing = { key: key, field: field, value: inp.value,
      start: restore ? restore.start : null, end: restore ? restore.end : null };
    inp.addEventListener("input", function () {
      if (T.editing) {
        T.editing.value = inp.value;
        T.editing.start = inp.selectionStart;
        T.editing.end = inp.selectionEnd;
      }
    });
    // arrow keys and clicks move the caret without changing the value
    ["keyup", "click", "select"].forEach(function (ev) {
      inp.addEventListener(ev, function () {
        if (T.editing) { T.editing.start = inp.selectionStart; T.editing.end = inp.selectionEnd; }
      });
    });
    if (field === "itemType") inp.setAttribute("list", "toUnits");
    // Clear the LABEL only. The rails are absolutely-positioned elements living
    // in this same cell, so blanking it wholesale snapped the tree lines for as
    // long as the cell was being typed into. They carry no text and cost
    // nothing to leave in place.
    Array.prototype.slice.call(td.childNodes).forEach(function (n) {
      if (n.nodeType === 1 && n.classList && n.classList.contains("to-rl")) return;
      td.removeChild(n);
    });
    td.appendChild(inp);
    // (the row re-renders on commit/escape, which restores the grip)
    var matcher = null;
    if (field === "itemName") {
      var sug = document.createElement("div");
      sug.className = "to-sug to-sug-cell";
      td.style.position = "relative";
      td.appendChild(sug);
      matcher = attachMatcher(inp, sug, function (m) {
        done = true;
        T.editing = null;               // the pick supersedes whatever was typed
        var patch = { itemName: m.itemName || "" };
        if (m.itemType && !row.itemType) patch.itemType = m.itemType;
        if (m.itemPrice != null && num(m.itemPrice) && !num(row.itemPrice)) patch.itemPrice = num(m.itemPrice);
        T.mru[String(m.itemName || "").toLowerCase()] = Date.now();
        apply(cmdUpdate(key, patch));
        setTimeout(function () { focusNextCell(key, "itemName"); }, 0);
      });
    }
    inp.focus();
    if (restore && restore.start != null) {
      try { inp.setSelectionRange(restore.start, restore.end == null ? restore.start : restore.end); } catch (e) {}
    } else inp.select();
    var done = false;
    function commit(advance) {
      if (done) return; done = true;
      if (T.editing && T.editing.key === key && T.editing.field === field) T.editing = null;
      var v = inp.value;
      if (field === "itemQty") {
        var q = evalQty(v);
        if (q === null) {
          msg("err", "That quantity isn't a number or a formula.");
          // Only hold the cell open when the user actively tried to move on
          // (Enter/Tab) — then keeping their text is a kindness. On a blur it
          // would be a trap: the click that blurred us gets destroyed by the
          // re-render, so the button they aimed at never fires and focus snaps
          // back here. Clicking away has to be a way OUT, so drop the bad text
          // and leave the stored quantity alone.
          if (advance) T.editing = { key: key, field: field, value: v, start: null, end: null };
          render();
          return;
        }
        v = q;
      }
      if (v !== raw) {
        var patch = {}; patch[field] = v === "" ? null : v;
        apply(cmdUpdate(key, patch));
      } else render();
      if (advance === "next") setTimeout(function () { focusNextCell(key, field); }, 0);
      if (advance === "down") setTimeout(function () { fillDownFrom(key); }, 0);
    }
    // A re-render rips this input out of the DOM, and Chrome fires blur on the
    // way out. Committing then would write a half-typed value nobody asked to
    // save — and it is unnecessary, because T.editing already holds the text
    // and restoreEditor is about to put it back.
    inp.onblur = function () {
      // _dcrDead: render() is tearing this node out (see renderOne). isConnected
      // is kept as a belt-and-braces check for any other detach path.
      if (inp._dcrDead || !inp.isConnected) { done = true; return; }
      commit(false);
    };
    inp.onkeydown = function (e) {
      if (e.key === "Enter") {
        if (matcher && matcher.hasPick()) return;
        e.preventDefault();
        commit(field === "itemQty" ? "down" : "next");
      } else if (e.key === "Tab") { e.preventDefault(); commit("next"); }
      else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !(matcher && matcher.hasPick())) {
        // spreadsheet motion: save this cell, open the same column one row over
        e.preventDefault();
        var dir = e.key === "ArrowDown" ? 1 : -1;
        commit(false);
        setTimeout(function () { focusAdjacent(key, field, dir); }, 0);
      }
      else if (e.key === "Escape") { done = true; T.editing = null; render(); }
    };
  }
  function focusNextCell(key, field) {
    var i = EDIT_ORDER.indexOf(field);
    var row = T.rowByKey[key];
    for (var j = i + 1; j < EDIT_ORDER.length; j++) {
      var f = EDIT_ORDER[j];
      if (f === "itemPurpose" && row && row.itemPurpose) continue;
      if (f === "itemType" && row && row.itemType) continue;
      var td = T.pane.querySelector('tr[data-k="' + cssq(key) + '"] [data-edit="' + f + '"]');
      if (td) { editCell(td); return; }
    }
    // Out of fields on this row. Carry on at the start of the next one the way
    // a spreadsheet does — tabbing off the last column used to open nothing at
    // all, which reads as "Tab lost my place".
    var trs = Array.prototype.slice.call(T.pane.querySelectorAll("tr.to-row"));
    var idx = -1;
    trs.forEach(function (tr, n) { if (tr.getAttribute("data-k") === key) idx = n; });
    var next = idx === -1 ? null : trs[idx + 1];
    if (!next) return;
    for (var n2 = 0; n2 < EDIT_ORDER.length; n2++) {
      var td2 = next.querySelector('[data-edit="' + EDIT_ORDER[n2] + '"]');
      if (td2) { editCell(td2); return; }
    }
  }
  function focusAdjacent(key, field, dir) {
    var trs = Array.prototype.slice.call(T.pane.querySelectorAll("tr.to-row"));
    var idx = -1;
    trs.forEach(function (tr, i) { if (tr.getAttribute("data-k") === key) idx = i; });
    var j = idx + dir;
    if (j < 0 || j >= trs.length) return;
    var td = trs[j].querySelector('[data-edit="' + field + '"]');
    if (td) editCell(td);
  }
  function fillDownFrom(key) {
    var trs = Array.prototype.slice.call(T.pane.querySelectorAll("tr.to-row"));
    var idx = -1;
    trs.forEach(function (tr, i) { if (tr.getAttribute("data-k") === key) idx = i; });
    for (var i = idx + 1; i < trs.length; i++) {
      var k = trs[i].getAttribute("data-k");
      var r = T.rowByKey[k];
      if (r && !r.itemName) {
        var td = trs[i].querySelector('[data-edit="itemName"]');
        if (td) { editCell(td); return; }
      }
    }
  }

  /* ── move / copy modal ── */
  function openMoveCopy(mode) {
    var keys = selKeys();
    if (!keys.length) return;
    var vals = {};
    LEVELS.forEach(function (L) {
      var s = {};
      scopeRows().forEach(function (r) { if (r[L.f]) s[r[L.f]] = 1; });
      loadPend().forEach(function (p) {
        var v = { itemLocation: p.loc, itemCategory: p.cat, itemSubCategory: p.sub }[L.f];
        if (v) s[v] = 1;
      });
      vals[L.f] = Object.keys(s).sort();
    });
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
      // Copy with everything on "keep" is duplicate-in-place; a move needs a change.
      if (!Object.keys(target).length && mode === "move") {
        msg("err", "Nothing to change — every level is set to keep.");
        return;
      }
      el("toMcModal").classList.remove("open");
      T.sel = {};
      apply(mode === "move" ? cmdMove(keys, target) : cmdCopy(keys, target));
    };
    el("toMcModal").classList.add("open");
  }

  /* ── item detail ── */
  /* ── "How it was measured" — a VB-flavored running calculator ─────────
     Each line is a little formula: leave the line (Enter at its end) and it
     becomes «20 x 60 = 1200» with the result seeding the next line. «x»,
     «*» and «2(4+2)» multiply; «600 + 10%» adds ten percent. A «'» starts a
     comment (green, aligned), unless it sits right after a number — that's
     feet. Bad lines get a wavy underline and a plain-words message.

     Measurements keep their unit through the math: feet/inches multiply into
     square then cubic feet, and results print the way an estimator writes
     them — «12" + 1' = 2'», «20' x 60' = 1200 SF», «8' / 16" = 6». Anything
     printed can be typed back in, so a result seeds the next line intact. */
  function fxInches(str) {
    var m = String(str).trim().match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
    if (m) {
      var den = parseFloat(m[3]);
      if (!den) return NaN;
      return (m[1] ? parseFloat(m[1]) : 0) + parseFloat(m[2]) / den;
    }
    return parseFloat(str);
  }
  var FX_UNITS = { lf: 1, ft: 1, sf: 2, cf: 3 };
  var FX_DIMS = ["a plain number", "a length", "an area", "a volume"];
  function fxDimName(d) { return FX_DIMS[d] || "a mixed unit"; }
  function fxTokenize(s) {
    var toks = [], i = 0, m;
    while (i < s.length) {
      var c = s[i];
      if (c === " " || c === "\t") { i++; continue; }
      var rest = s.slice(i);
      // feet, optionally with inches: 4'   4'6"   4'-6"   4' 6"   4'-6 1/2"
      // (a hyphen only joins them when tight — «12' - 3"» is a subtraction)
      if ((m = rest.match(/^(\d+(?:\.\d+)?|\.\d+)'/))) {
        var ftv = parseFloat(m[1]);
        i += m[0].length;
        var m2 = s.slice(i).match(/^(?:-|[ \t]*)((?:\d+[ \t]+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?|\.\d+))"/);
        // «12'-3» with the inch mark left off still means twelve foot three;
        // the lookahead keeps «20'-2'» a subtraction of two real lengths
        if (!m2) m2 = s.slice(i).match(/^-((?:\d+[ \t]+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?))(?!['\d.])/);
        if (m2) { ftv += fxInches(m2[1]) / 12; i += m2[0].length; }
        toks.push({ t: "n", v: ftv, deg: 1 });
        continue;
      }
      // inches: 6"   6.5"   1/2"   6 1/2"
      if ((m = rest.match(/^((?:\d+[ \t]+\d+\/\d+)|(?:\d+\/\d+)|(?:\d+(?:\.\d+)?|\.\d+))"/))) {
        toks.push({ t: "n", v: fxInches(m[1]) / 12, deg: 1 });
        i += m[0].length;
        continue;
      }
      // plain number (thousands commas fine), maybe a percent or a unit
      if ((m = rest.match(/^(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.\d+|\d+)/))) {
        var v = parseFloat(m[1].replace(/,/g, ""));
        i += m[0].length;
        if (s[i] === "%") { toks.push({ t: "n", v: v, deg: 0, pct: true }); i++; continue; }
        var mu = s.slice(i).match(/^[ \t]*(lf|ft|sf|cf)\b/i);
        if (mu) { toks.push({ t: "n", v: v, deg: FX_UNITS[mu[1].toLowerCase()] }); i += mu[0].length; continue; }
        toks.push({ t: "n", v: v, deg: 0 });
        continue;
      }
      // `raw` keeps the character the user actually typed, so an error can
      // quote «x» rather than the internal «*»
      if (c === "x" || c === "X" || c === "×" || c === "*") { toks.push({ t: "op", v: "*", raw: c }); i++; continue; }
      if (c === "+" || c === "-") { toks.push({ t: "op", v: c, raw: c }); i++; continue; }
      if (c === "/" || c === "÷") { toks.push({ t: "op", v: "/", raw: c }); i++; continue; }
      if (c === "(") { toks.push({ t: "(" }); i++; continue; }
      if (c === ")") {
        toks.push({ t: ")" });
        i++;
        // a unit hung on the group: (8-2)' is six feet
        if (s[i] === "'") { toks.push({ t: "unit", scale: 1 }); i++; }
        else if (s[i] === '"') { toks.push({ t: "unit", scale: 1 / 12 }); i++; }
        continue;
      }
      // appending after a result is a natural gesture — say what to do
      if (c === "=") return { error: "one “=” per line — edit the formula on the left of it" };
      return { error: "can't read “" + rest.slice(0, 8).trim() + "”" };
    }
    // implicit multiplication: 2(4+2), (2)(3), (4+2)3
    var out = [];
    toks.forEach(function (tk) {
      var prev = out[out.length - 1];
      var implied = prev && (
        ((prev.t === "n" || prev.t === ")") && tk.t === "(") ||
        (prev.t === ")" && tk.t === "n"));
      if (implied) out.push({ t: "op", v: "*" });
      out.push(tk);
    });
    return { toks: out };
  }
  function fxTokStr(t) { return t.t === "n" ? fxFmt(t.v, t.deg || 0) : (t.raw || t.v || t.t); }
  function fxEval(code) {
    var tk = fxTokenize(code);
    if (tk.error) return { ok: false, error: tk.error };
    var toks = tk.toks, p = 0, err = null, used = 0;
    if (!toks.length) return { ok: false, error: "nothing to calculate" };
    function factor() {
      var t = toks[p];
      if (!t) { err = "the formula ends too soon"; return null; }
      if (t.t === "n") { p++; return { v: t.v, deg: t.deg || 0, pct: !!t.pct }; }
      if (t.t === "(") {
        p++;
        var v = expr();
        if (v === null) return null;
        if (!toks[p] || toks[p].t !== ")") { err = "a “)” is missing"; return null; }
        p++;
        var gv = v.pct ? v.v / 100 : v.v, gdeg = v.pct ? 0 : v.deg;
        if (toks[p] && toks[p].t === "unit") {      // (8-2)' = six feet
          if (gdeg !== 0) { err = "that already has a unit"; return null; }
          gv *= toks[p].scale;
          gdeg = 1;
          p++;
        }
        return { v: gv, deg: gdeg, pct: false };
      }
      if (t.t === "op" && (t.v === "-" || t.v === "+")) {
        p++;
        var f = factor();
        if (!f) return null;
        return { v: t.v === "-" ? -f.v : f.v, deg: f.deg, pct: f.pct };
      }
      err = "didn't expect “" + fxTokStr(t) + "” there";
      return null;
    }
    function term() {
      var l = factor();
      if (!l) return null;
      while (toks[p] && toks[p].t === "op" && (toks[p].v === "*" || toks[p].v === "/")) {
        var op = toks[p++].v;
        used++;
        // a percent on the LEFT is just its ratio: 10% x 20' = 2'
        if (l.pct) l = { v: l.v / 100, deg: 0, pct: false };
        var r = factor();
        if (!r) return null;
        // a percentage on the right reads as "of": 600 x 10% = 60
        if (r.pct) {
          if (op === "/" && r.v === 0) { err = "that divides by zero"; return null; }
          l = { v: op === "*" ? l.v * (r.v / 100) : l.v / (r.v / 100), deg: l.deg, pct: false };
          continue;
        }
        if (op === "/" && r.v === 0) { err = "that divides by zero"; return null; }
        // feet x feet = square feet; square feet x feet = cubic feet;
        // feet / feet = a plain count ("how many pieces")
        l = {
          v: op === "*" ? l.v * r.v : l.v / r.v,
          deg: op === "*" ? l.deg + r.deg : l.deg - r.deg,
          pct: false,
        };
      }
      return l;
    }
    function expr() {
      var l = term();
      if (!l) return null;
      while (toks[p] && toks[p].t === "op" && (toks[p].v === "+" || toks[p].v === "-")) {
        var op = toks[p++].v;
        used++;
        if (l.pct) l = { v: l.v / 100, deg: 0, pct: false };   // 10% + 600
        var r = term();
        if (!r) return null;
        if (r.pct) {   // 600 + 10% = 660
          var pv = l.v * (r.v / 100);
          l = { v: op === "+" ? l.v + pv : l.v - pv, deg: l.deg, pct: false };
          continue;
        }
        // a bare number takes the units of what it's added to (20' + 5 = 25');
        // two REAL units that disagree is a mistake worth catching
        if (l.deg > 0 && r.deg > 0 && l.deg !== r.deg) {
          err = "can't " + (op === "+" ? "add " : "subtract ") + fxDimName(r.deg) +
            (op === "+" ? " to " : " from ") + fxDimName(l.deg);
          return null;
        }
        l = { v: op === "+" ? l.v + r.v : l.v - r.v, deg: Math.max(l.deg, r.deg), pct: false };
      }
      return l;
    }
    var out = expr();
    if (out === null) return { ok: false, error: err || "can't read the formula" };
    if (toks[p]) return { ok: false, error: "didn't expect “" + fxTokStr(toks[p]) + "” after the formula" };
    var val = out.pct ? out.v / 100 : out.v;
    var deg = out.pct ? 0 : out.deg;
    if (isNaN(val)) return { ok: false, error: "can't read the numbers" };
    if (!isFinite(val)) return { ok: false, error: "that divides by zero" };
    // never hand back a unit we can't print — it would silently launder into a
    // plain number and pass every later check (1200 SF x 40 SF is a mistake)
    if (deg < 0 || deg > 3) return { ok: false, error: "that ends up " + fxDimName(deg) + " — check the units" };
    // a lone value isn't a calculation — no «= itself» tacked onto it
    return { ok: true, value: val, deg: deg, trivial: used === 0 };
  }
  function fxNum(v) { return String(Math.round(v * 10000) / 10000); }
  // feet-and-inches the way a takeoff is written: 2'   12'-3"   9 1/2"
  function fxFeetStr(v) {
    var six = Math.round(Math.abs(v) * 192);       // sixteenths of an inch
    var sign = v < 0 && six ? "-" : "";            // decide AFTER rounding, or −0.001" prints «-0"»
    var ft = Math.floor(six / 192);
    var rem = six - ft * 192;
    var inch = Math.floor(rem / 16), frac = rem - inch * 16, den = 16;
    while (frac && frac % 2 === 0) { frac /= 2; den /= 2; }
    var ins = "";
    if (inch || frac) {
      ins = (inch ? String(inch) : "") + (frac ? (inch ? " " : "") + frac + "/" + den : "") + '"';
    }
    if (!ft) return sign + (ins || '0"');
    return sign + ft + "'" + (ins ? "-" + ins : "");
  }
  function fxFmt(v, deg) {
    if (deg === 1) return fxFeetStr(v);
    if (deg === 2) return fxNum(v) + " SF";
    if (deg === 3) return fxNum(v) + " CF";
    return fxNum(v);
  }
  // A «'» right after a number or a «)» is a feet mark, not a comment — but
  // «1200'wall» is plainly a note, so a following WORD ends the exemption
  // («20'x30'» keeps multiplying, since "x" is an operator).
  function fxFeetMark(line, i) {
    if (!(i > 0 && /[\d)]/.test(line[i - 1]))) return false;
    var w = line.slice(i + 1).match(/^[A-Za-z]+/);
    if (!w) return true;
    var word = w[0].toLowerCase();
    return word === "x" || word === "lf" || word === "ft" || word === "sf" || word === "cf";
  }
  function fxCommentIdx(line) {
    for (var i = 0; i < line.length; i++) {
      if (line[i] === "'" && !fxFeetMark(line, i)) return i;
    }
    return -1;
  }
  // Everything after the LAST «=» is a result we wrote — drop it and
  // recompute. (A leading «=», Excel-style, means the rest IS the formula.)
  function fxCodeSplit(code) {
    var eq = code.lastIndexOf("=");
    if (eq === -1) return { expr: code, result: null };
    var before = code.slice(0, eq);
    // Excel habit: a leading «=» means the rest IS the formula
    if (!before.trim()) return { expr: code.slice(eq + 1).replace(/^[ \t]+/, ""), result: null };
    // Only a bare value is OUR result. Anything else after «=» is something
    // the user typed (5 x 5 = 25 + 10) and must never be silently deleted.
    var tail = code.slice(eq + 1);
    var tt = fxTokenize(tail);
    if (tt.error || !tt.toks || tt.toks.length !== 1 || tt.toks[0].t !== "n") return { expr: code, result: null };
    return { expr: before, result: tail };
  }
  function fxSplitLine(line) {
    var ci = fxCommentIdx(line);
    var code = ci === -1 ? line : line.slice(0, ci);
    var comment = ci === -1 ? "" : line.slice(ci);
    return {
      lead: (line.match(/^[ \t]*/) || [""])[0],
      expr: fxCodeSplit(code).expr.replace(/\s+$/, ""),
      comment: comment.replace(/\s+$/, ""),
    };
  }
  // Recompute every line's «= result» and line the comments up in a column.
  function fxNormalize(text) {
    var errors = [];
    var built = String(text).split("\n").map(function (line, li) {
      var pl = fxSplitLine(line);
      if (!pl.expr.trim()) {
        return { code: pl.expr.trim(), comment: pl.comment, res: null, lead: pl.lead, raw: line.replace(/\s+$/, "") };
      }
      var ev = fxEval(pl.expr);
      if (!ev.ok) {
        errors.push({ line: li + 1, error: ev.error });
        return { code: pl.expr, comment: pl.comment, res: null, lead: pl.lead };
      }
      return {
        code: ev.trivial ? pl.expr : pl.expr + " = " + fxFmt(ev.value, ev.deg),
        comment: pl.comment, lead: pl.lead,
        // a bare value isn't a calculation, so it seeds nothing — otherwise
        // holding Enter would stamp the same number down the page
        res: ev.trivial ? null : { v: ev.value, deg: ev.deg },
      };
    });
    var width = 0;
    built.forEach(function (b) { if (b.comment && b.code) width = Math.max(width, b.code.length); });
    var lines = built.map(function (b) {
      if (b.raw !== undefined && !b.comment) return b.raw;      // untouched blank line
      if (!b.code) return (b.lead || "") + b.comment;           // comment-only line keeps its indent
      if (!b.comment) return b.code;
      return b.code + Array(Math.max(1, width + 2 - b.code.length) + 1).join(" ") + b.comment;
    });
    return { text: lines.join("\n"), errors: errors, results: built.map(function (b) { return b.res; }) };
  }
  function fxHl(text, errSet, activeLine) {
    return String(text).split("\n").map(function (line, li) {
      var ci = fxCommentIdx(line);
      var code = ci === -1 ? line : line.slice(0, ci);
      var com = ci === -1 ? "" : line.slice(ci);
      var cs = fxCodeSplit(code);
      var codeHtml;
      if (cs.result === null) codeHtml = esc(code);
      else {
        var pad = cs.result.match(/\s*$/)[0];                     // alignment spaces
        var shown = cs.result.slice(0, cs.result.length - pad.length);
        codeHtml = esc(cs.expr) + "=" + '<span class="fx-res">' + esc(shown) + "</span>" + pad;
      }
      if (errSet[li] && li !== activeLine) codeHtml = '<span class="fx-bad">' + codeHtml + "</span>";
      return codeHtml + (com ? '<span class="fx-com">' + esc(com) + "</span>" : "");
    }).join("\n") + "\n";
  }
  function fxEnhance(ta) {
    if (!ta || ta._fx) return;
    ta._fx = true;
    var wrap = document.createElement("div");
    wrap.className = "fx-wrap";
    ta.parentNode.insertBefore(wrap, ta);
    var hl = document.createElement("div");
    hl.className = "fx-hl";
    wrap.appendChild(hl);
    wrap.appendChild(ta);
    // its own message line — sharing the modal's would wipe out an unfixed
    // quantity error just because the formula box was focused
    var note = document.createElement("div");
    note.className = "fx-msg";
    wrap.appendChild(note);
    ta.classList.add("fx-src");
    ta.setAttribute("wrap", "off");
    ta.spellcheck = false;
    // tracked explicitly: document.activeElement still names this box when the
    // whole WINDOW loses focus, which would keep an error suppressed forever
    var focused = false;
    function activeLine() { return ta.value.slice(0, ta.selectionStart).split("\n").length - 1; }
    function errLines() {
      var set = {};
      ta.value.split("\n").forEach(function (line, li) {
        var pl = fxSplitLine(line);
        if (!pl.expr.trim()) return;
        var ev = fxEval(pl.expr);
        if (!ev.ok) set[li] = ev.error;
      });
      return set;
    }
    function paint() {
      var errs = errLines();
      var cur = focused ? activeLine() : -1;
      hl.innerHTML = fxHl(ta.value, errs, cur);
      hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft;
      // report the first bad line that isn't the one being typed, so a
      // half-typed formula doesn't shout, but a fixed one clears at once
      var keys = Object.keys(errs).map(Number).sort(function (a, b) { return a - b; });
      var show = null;
      for (var i = 0; i < keys.length; i++) if (keys[i] !== cur) { show = keys[i]; break; }
      note.textContent = show === null ? "" : "Formula line " + (show + 1) + ": " + errs[show];
    }
    function report(errors) {
      note.textContent = errors.length ? "Formula line " + errors[0].line + ": " + errors[0].error : "";
    }
    ta.addEventListener("input", paint);
    // a caret move changes which line is "the one being edited", so the
    // squiggle and the message have to follow it
    ta.addEventListener("focus", function () { focused = true; paint(); });
    ["keyup", "click", "select"].forEach(function (ev) { ta.addEventListener(ev, paint); });
    ta.addEventListener("scroll", function () { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; });
    ta.addEventListener("keydown", function (e) {
      // Shift/Ctrl/Alt+Enter stays a plain newline
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      var pos = ta.selectionStart;
      var after = ta.value.slice(pos);
      // the leave-the-line ritual happens only at the END of a line
      if (ta.selectionEnd !== pos || (after && after[0] !== "\n")) return;
      e.preventDefault();
      var li = ta.value.slice(0, pos).split("\n").length - 1;
      var norm = fxNormalize(ta.value);
      report(norm.errors);
      var lines = norm.text.split("\n");
      var res = norm.results[li];
      var seed = res == null ? "" : fxFmt(res.v, res.deg) + " ";
      lines.splice(li + 1, 0, seed);
      ta.value = lines.join("\n");
      var caret = lines.slice(0, li + 1).join("\n").length + 1 + seed.length;
      ta.setSelectionRange(caret, caret);
      paint();
    });
    ta.addEventListener("blur", function () {
      focused = false;
      var norm = fxNormalize(ta.value);
      if (norm.text !== ta.value) ta.value = norm.text;
      report(norm.errors);
      paint();
    });
    paint();
  }

  var DETAIL = [
    ["itemPurpose", "Purpose", "text"], ["itemName", "Item name", "text"],
    ["itemQty", "Quantity", "qty"], ["itemType", "Unit", "unit"],
    ["itemPrice", "Unit price", "num"],
    ["itemLocation", "Level", "text"],
    ["itemCategory", "Category", "text"], ["itemSubCategory", "Sub-category", "text"],
    ["itemCalculationFormula", "How it was measured", "area"],
    ["itemHiperLink", "Link (product page / cut sheet)", "text"],
    ["itemSortingNumber", "Order in its group", "num"],
  ];
  function openDetail(key) {
    var row = T.rowByKey[key];
    if (!row) return;
    var canEdit = canEditView();
    T.detailKey = key;
    el("toDtTitle").textContent = row.itemName || "Takeoff item";
    el("toDtMsg").textContent = "";
    var pk = parentKeyOf(row);
    el("toDtBody").innerHTML = DETAIL.map(function (d) {
      if (T.pricesHidden && d[0] === "itemPrice") return "";
      // a component's group always follows its parent — not editable here
      var lockGroup = pk && (d[0] === "itemLocation" || d[0] === "itemCategory" || d[0] === "itemSubCategory");
      var v = d[2] === "qty" ? qtyDisp(row.itemQty) : (row[d[0]] == null ? "" : row[d[0]]);
      if (d[2] === "area") {
        return '<div class="pj-f full"><label>' + esc(d[1]) + "</label><textarea id=\"dt_" + d[0] + '" rows="3"' +
          (canEdit ? "" : " disabled") + ">" + esc(v) + "</textarea></div>";
      }
      return '<div class="pj-f"><label>' + esc(d[1]) + (lockGroup ? ' <span class="pj-sub">(follows its parent)</span>' : "") +
        "</label><input id=\"dt_" + d[0] + '" value="' + esc(v) + '"' +
        (d[2] === "unit" ? ' list="toUnits"' : "") + (canEdit && !lockGroup ? "" : " disabled") + "></div>";
    }).join("") +
      (pk ? '<div class="pj-f"><label>Component of</label><input value="' +
        esc([pk].concat(ancestorsOf(pk)).reverse().map(function (k) {
          var p = T.rowByKey[k] || {};
          return p.itemPurpose || p.itemName || "item";
        }).join(" › ")) + '" disabled></div>' : "") +
      '<div class="pj-f"><label>Takeoff</label><input value="' +
        esc(currentHeader() ? currentHeader().takeoffName : (row.takeoffName || "—")) + '" disabled></div>' +
      '<div class="pj-f"><label>Total</label><input value="' +
        esc(T.pricesHidden ? "—" : money(num(row.itemQty) * num(row.itemPrice))) + '" disabled></div>';
    el("toDtSave").style.display = canEdit ? "" : "none";
    el("toDtModal").classList.add("open");
    fxEnhance(el("dt_itemCalculationFormula"));
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
      var was;
      if (f === "itemQty") {
        var q = evalQty(v);
        if (q === null) { el("toDtMsg").textContent = "That quantity isn't a number or a formula."; return; }
        v = q;
        was = qtyDisp(row.itemQty);
      } else {
        was = row[f] == null ? "" : String(row[f]);
      }
      if (v !== was) { patch[f] = v === "" ? null : v; changed = true; }
    }
    el("toDtModal").classList.remove("open");
    if (changed) apply(cmdUpdate(key, patch, "Edited " + (row.itemName || "item")));
  }

  /* ── takeoff header create / edit / delete / convert ── */
  function openTkModal(header) {
    T.tkEditing = header || null;
    el("toTkTitle").textContent = header ? "Edit takeoff" : "New takeoff";
    el("toTkMsg").textContent = "";
    el("tf_name").value = header ? (header.takeoffName || "") : "";
    el("tf_desc").value = header ? (header.takeoffDescription || "") : "";
    el("tf_notes").value = header ? (header.takeoffNotes || "") : "";
    el("tf_prep").value = header
      ? (header.takeoffPreparedBy || "")
      : ((T.profile && (T.profile.displayName || T.profile.email)) || "");
    el("toTkGo").textContent = header ? "✓ Save" : "＋ Create takeoff";
    el("toTkModal").classList.add("open");
    el("tf_name").focus();
  }
  async function saveTkModal() {
    var name = el("tf_name").value.trim();
    if (!name) { el("toTkMsg").textContent = "The takeoff needs a name."; return; }
    var fields = {
      takeoffName: name,
      takeoffDescription: el("tf_desc").value.trim(),
      takeoffNotes: el("tf_notes").value.trim(),
      takeoffPreparedBy: el("tf_prep").value.trim(),
    };
    el("toTkGo").disabled = true;
    try {
      if (T.tkEditing) {
        var old = T.tkEditing.takeoffName || "";
        await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "tkUpdate", itemId: T.tkEditing.id, fields: fields } });
        Object.keys(fields).forEach(function (k) { T.tkEditing[k] = fields[k]; });
        el("toTkModal").classList.remove("open");
        if (old !== name) {
          var mine = T.rows.filter(function (r) { return tkIdOf(r) === String(T.tkEditing.id); });
          if (mine.length) {
            enqueue(mine.map(function (r) { return { kind: "upd", key: r._k, fields: { takeoffName: name } }; }),
              function (err, results) {
                var bad = (results || []).filter(function (x) { return !x.res.ok; }).length;
                if (!err && !bad) mine.forEach(function (r) { r.takeoffName = name; });
                msg(bad ? "err" : "ok", bad ? bad + " rows kept the old name — try the rename again" : "✓ Takeoff renamed");
                render();
              });
          } else msg("ok", "✓ Takeoff updated");
        } else msg("ok", "✓ Takeoff updated");
      } else {
        var d = await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "tkAdd", projectId: T.pid, fields: fields } });
        var h = { id: String(d.id), projectID: String(T.pid), takeoffName: name,
          takeoffDescription: fields.takeoffDescription, takeoffNotes: fields.takeoffNotes,
          takeoffPreparedBy: fields.takeoffPreparedBy || ((T.profile && T.profile.displayName) || ""),
          takeoffDate: new Date().toISOString() };
        T.headers.unshift(h);
        el("toTkModal").classList.remove("open");
        enterTakeoff({ tkId: h.id });
        msg("ok", "✓ Takeoff created — add a level to start");
      }
    } catch (e) {
      el("toTkMsg").textContent = e.message || "Save failed";
    }
    el("toTkGo").disabled = false;
    render();
  }
  async function deleteTakeoff() {
    var h = currentHeader();
    if (!h) return;
    var mine = T.rows.filter(function (r) { return tkIdOf(r) === String(h.id); });
    if (mine.length) { msg("err", "This takeoff still has " + mine.length + " items — delete or move them first."); return; }
    if (!(await DCR.confirm("It has no items.",
      { title: 'Delete the takeoff "' + (h.takeoffName || "") + '"?', danger: true, okText: "Delete" }))) return;
    await queueIdle();
    try {
      await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "tkDelete", itemId: h.id } });
      T.headers = T.headers.filter(function (x) { return String(x.id) !== String(h.id); });
      try { sessionStorage.removeItem(pendKey()); } catch (e) {}
      T.view = { screen: "cards" };
      msg("ok", "✓ Takeoff deleted");
    } catch (e) { msg("err", e.message || "Delete failed"); }
    render();
  }
  async function convertGroup() {
    var nameKey = T.view.nameKey || "";
    var rows = scopeRows();
    if (!rows.length) return;
    var name = await DCR.ask("Name for this takeoff record", { title: "Convert to a takeoff record",
      value: nameKey || "Takeoff", okText: "Continue" });
    name = (name || "").trim();
    if (!name) return;
    if (!(await DCR.confirm("Links " + rows.length + " row" + (rows.length === 1 ? "" : "s") +
      " to it. This cannot be undone — though the rows themselves only gain the link.",
      { title: 'Create the takeoff record "' + name + '"?', okText: "Create" }))) return;
    await queueIdle();
    try {
      var h = null;
      for (var i = 0; i < T.headers.length; i++) {
        if ((T.headers[i].takeoffName || "").trim().toLowerCase() === name.toLowerCase()) { h = T.headers[i]; break; }
      }
      if (!h) {
        var d = await DCR.api("/api/portal?action=project", { method: "POST", body: { op: "tkAdd", projectId: T.pid, fields: { takeoffName: name } } });
        h = { id: String(d.id), projectID: String(T.pid), takeoffName: name,
          takeoffPreparedBy: (T.profile && T.profile.displayName) || "", takeoffDate: new Date().toISOString() };
        T.headers.unshift(h);
      }
      enqueue(rows.map(function (r) {
        return { kind: "upd", key: r._k, fields: { takeoffID: Number(h.id), takeoffName: name } };
      }), function (err, results) {
        var ok = (results || []).filter(function (x) { return x.res.ok; }).length;
        var bad = (results || []).length - ok;
        if (!err) {
          (results || []).forEach(function (x) {
            if (x.res.ok) {
              var r = T.rowByKey[x.op.key];
              if (r) { r.takeoffID = Number(h.id); r.takeoffName = name; }
            }
          });
        }
        if (err || bad) msg("err", "Linked " + ok + " of " + (ok + bad) + " — press Convert again to finish.");
        else {
          msg("ok", "✓ " + ok + " rows linked to \"" + name + "\"");
          enterTakeoff({ tkId: h.id });
        }
        render();
      });
    } catch (e) { msg("err", e.message || "Convert failed"); }
  }

  /* ── keyboard ── */
  function onKey(e) {
    if (!T || !T.active || !canEditView() || T.gesture) return;
    var tag = (e.target && e.target.tagName) || "";
    var inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    if (e.target && e.target.closest && e.target.closest(".pj-overlay")) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !inField) {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    } else if (mod && e.key.toLowerCase() === "y" && !inField) {
      e.preventDefault(); doRedo();
    } else if (e.key === "Delete" && !inField && selKeys().length) {
      e.preventDefault(); deleteSelection(selKeys());
    }
  }

  /* ── data load ── */
  async function loadData() {
    await queueIdle();
    var d = await DCR.api("/api/portal?action=project&id=" + T.pid + "&part=takeoffs");
    T.canEdit = !!d.canEdit;
    T.canManage = !!d.canManage;
    T.pricesHidden = !!d.pricesHidden;
    T.serverOld = d.takeoffs === undefined;
    T.headers = d.takeoffs || [];
    T.rows = []; T.rowByKey = {}; T.idByKey = {}; T.keyById = {};
    T.undo = []; T.redo = []; T.sel = {}; T.rowFlag = {};
    T.entry2 = null;
    (d.rows || []).forEach(function (r) {
      r._k = newKey();
      T.rowByKey[r._k] = r;
      T.idByKey[r._k] = r.id;
      T.keyById[String(r.id)] = r._k;
      T.rows.push(r);
    });
    if (T.view.screen === "one" && T.view.tkId && !currentHeader()) T.view = { screen: "cards" };
  }

  /* ── public API ── */
  DCR.takeoff = {
    async mount(opts) {
      var first = !T || T.pid !== String(opts.pid);
      if (first) {
        T = {
          pid: String(opts.pid), pane: opts.pane, profile: opts.profile || null,
          rows: [], rowByKey: {}, idByKey: {}, keyById: {}, rowFlag: {}, sel: {}, collapsed: {},
          headers: [], purposes: [], catalog: [], mru: {},
          undo: [], redo: [], queue: [], draining: false,
          filter: "", canEdit: false, canManage: false, pricesHidden: false,
          active: true, detailKey: null, tkEditing: null, msg: null,
          view: { screen: "cards" }, gesture: null, renderPending: false,
          entry2: null, drag: null, suppressClickUntil: 0, editing: null,
          entryStickyPurpose: "", entryStickyType: "",
        };
        document.addEventListener("keydown", onKey);
      } else {
        T.pane = opts.pane;
        T.active = true;
        if (opts.profile) T.profile = opts.profile;
      }
      T.pane.innerHTML = '<div class="pj-empty">Loading takeoffs…</div>';
      try {
        await loadData();
      } catch (e) {
        T.pane.innerHTML = '<div class="pj-empty">' + esc(e.message || "Could not load takeoffs.") + "</div>";
        return;
      }
      if (T.view.screen === "cards" && T.headers.length === 1 &&
          !orphanGroups().length && !T.rows.some(isEstimateRow)) {
        T.view = { screen: "one", tkId: String(T.headers[0].id), nameKey: null, est: false };
      }
      render();
      if (!T.catalog.length || !T.purposes.length) {
        await Promise.all([loadCatalog(), loadPurposes()]);
        render();
      }
    },
    setActive(on) { if (T) { T.active = !!on; if (on && T.pane) render(); } },
    invalidate() { if (T) T.rows.length = 0; },
    _saveDetail: saveDetail,
    _closeDetail() { el("toDtModal").classList.remove("open"); },
    _closeMc() { el("toMcModal").classList.remove("open"); },
    _saveTk: saveTkModal,
    _closeTk() { el("toTkModal").classList.remove("open"); },
    _closePp() { el("toPpModal").classList.remove("open"); },
    _closeCat() { el("toCatModal").classList.remove("open"); },
  };
})();
