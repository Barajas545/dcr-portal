/* DCR portal — takeoff ordering, shared by the grid and the printed sheet.

   The order groups appear in is not derivable from the data: the owner drags
   Levels and Categories into the order the job is actually built in, and that
   order is saved as JSON on the takeoff header (TakeoffLayout). If the grid and
   the Material List each worked it out for themselves they would drift the
   first time either changed — the same trap expense-filter.js exists to avoid.
   So the rules live here once, and takeoff.js and report-takeoff.js both ask.

   Reads fail open: a corrupt or missing layout means the fallback order, never
   a crash and never an empty sheet. */
(function () {
  var DCR = (window.DCR = window.DCR || {});

  // Group paths join on a NUL — it cannot occur in a level or category
  // name. Written as an escape on purpose: a literal control byte in source is
  // invisible and does not survive every tool. Must equal takeoff.js SEP.
  var SEP = "\u0000";
  var LEVELS = [
    { f: "itemLocation", label: "Level" },
    { f: "itemCategory", label: "Category" },
    { f: "itemSubCategory", label: "Sub-category" },
  ];
  // the owner's canonical level order — a lexical sort would put Basement first
  var LEVEL_CHIPS = ["Lower Level", "Basement", "Main Level", "First Level", "Second Level", "Third Level", "Roof"];
  var LEVEL_RANK = {};
  LEVEL_CHIPS.forEach(function (n, i) { LEVEL_RANK[n.toLowerCase()] = i; });

  function gkey(v) { return String(v == null ? "" : v); }
  function normName(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  function num(v) {
    if (typeof v === "number") return v;
    var n = parseFloat(String(v == null ? "" : v).replace(/[$,]/g, ""));
    return isFinite(n) ? n : 0;
  }
  function levelRank(v) {
    var r = LEVEL_RANK[normName(v)];
    return r === undefined ? 100 : r;
  }
  function pathOf(r) { return LEVELS.map(function (L) { return gkey(r[L.f]); }).join(SEP); }

  function parseLayout(header) {
    if (!header || !header.takeoffLayout) return null;
    try {
      var o = JSON.parse(header.takeoffLayout);
      if (o && o.v === 1 && Object.prototype.toString.call(o.levels) === "[object Array]") return o;
    } catch (e) {}
    return null;
  }

  function maps(header) {
    var m = { lvl: {}, cat: {}, sub: {} };
    var lay = parseLayout(header);
    if (!lay) return m;
    lay.levels.forEach(function (L, i) {
      var ln = normName(L.n);
      if (!(ln in m.lvl)) m.lvl[ln] = i;
      (L.cats || []).forEach(function (C, j) {
        var ck = ln + SEP + normName(C.n);
        if (!(ck in m.cat)) m.cat[ck] = j;
        (C.subs || []).forEach(function (S, k) {
          var sk = ck + SEP + normName(S);
          if (!(sk in m.sub)) m.sub[sk] = k;
        });
      });
    });
    return m;
  }

  // Layout wins; groups it doesn't mention keep the fallback order. An empty
  // category/sub sorts FIRST — it draws no header of its own, so sorting it
  // later would make its rows look like they belong to the previous group.
  function levelPosOf(m, loc) {
    var i = m.lvl[normName(loc)];
    return i === undefined ? 100000 + levelRank(loc) : i;
  }
  function catPosOf(m, loc, cat) {
    if (gkey(cat) === "") return -1;
    var i = m.cat[normName(loc) + SEP + normName(cat)];
    return i === undefined ? 100000 : i;
  }
  function subPosOf(m, loc, cat, sub) {
    if (gkey(sub) === "") return -1;
    var i = m.sub[normName(loc) + SEP + normName(cat) + SEP + normName(sub)];
    return i === undefined ? 100000 : i;
  }

  function topCompare(m) {
    return function (a, b) {
      var d = levelPosOf(m, a.itemLocation) - levelPosOf(m, b.itemLocation);
      if (d) return d;
      d = catPosOf(m, a.itemLocation, a.itemCategory) - catPosOf(m, b.itemLocation, b.itemCategory);
      if (d) return d;
      d = subPosOf(m, a.itemLocation, a.itemCategory, a.itemSubCategory) -
          subPosOf(m, b.itemLocation, b.itemCategory, b.itemSubCategory);
      if (d) return d;
      // raw-path tie-break keeps name variants ("Walls" vs "walls ") contiguous
      var pa = pathOf(a), pb = pathOf(b);
      if (pa !== pb) return pa < pb ? -1 : 1;
      return bySort(a, b);
    };
  }
  function bySort(a, b) {
    return (num(a.itemSortingNumber) - num(b.itemSortingNumber)) || (num(a.id) - num(b.id));
  }

  /* Flatten into print order: every row followed by its components, depth-first.
     Each node carries what the connector lines need — `depth`, `last` (is this
     the final child of its parent) and `cont[]` (which ancestor levels still
     have rows below, so their vertical line keeps running).

     Keyed on the server id / parentItemID, which is what a freshly fetched row
     has. A parent pointing outside this set is treated as a top-level row
     rather than dropped, so a half-moved assembly still prints. */
  function tree(rows, header) {
    var inScope = {};
    rows.forEach(function (r) { inScope[String(r.id)] = 1; });

    var tops = [], byParent = {};
    rows.forEach(function (r) {
      var pid = r.parentItemID == null || r.parentItemID === "" ? "" : String(r.parentItemID);
      if (pid && pid !== String(r.id) && inScope[pid]) (byParent[pid] = byParent[pid] || []).push(r);
      else tops.push(r);
    });
    tops.sort(topCompare(maps(header)));
    Object.keys(byParent).forEach(function (k) { byParent[k].sort(bySort); });

    var out = [], guard = {};
    function walk(list, depth, cont) {
      list.forEach(function (r, i) {
        var k = String(r.id);
        if (guard[k]) return;            // a cycle in ParentItemID must not hang the print
        guard[k] = 1;
        var last = i === list.length - 1;
        out.push({ row: r, depth: depth, last: last, cont: cont.slice() });
        var kids = byParent[k];
        if (kids && kids.length) walk(kids, depth + 1, cont.concat([!last]));
      });
    }
    walk(tops, 0, []);
    // anything unreachable (its parent was filtered out mid-chain) still prints
    rows.forEach(function (r) {
      if (!guard[String(r.id)]) out.push({ row: r, depth: 0, last: true, cont: [] });
    });
    return out;
  }

  DCR.tko = {
    SEP: SEP, LEVELS: LEVELS,
    gkey: gkey, num: num, normName: normName, levelRank: levelRank, pathOf: pathOf,
    parseLayout: parseLayout, maps: maps,
    levelPosOf: levelPosOf, catPosOf: catPosOf, subPosOf: subPosOf,
    topCompare: topCompare, bySort: bySort, tree: tree,
  };
})();
