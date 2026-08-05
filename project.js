/* DCR portal — Project page (web port of the Access ProjectManager form).
   Data: action=project (record + per-tab parts), action=data (field saves),
   action=board (logs + status w/ auto-log), action=drive (files), action=thumb. */

(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var state = {
    profile: null, project: null,
    canWrite: false, canEstimate: false, canLog: false, driveReady: false,
    originals: {}, dirty: {},
    parts: {}, // cache per tab
    estRows: [], estEditing: null,
    // expenses tab: group / period / text filters + sort. Restored from the URL
    // or from this tab's last session on load (see init), so coming back from
    // the printed report is not a reset.
    expRows: [], expCanEdit: false, expQTimer: null, expView: [],
    expFilter: { group: "*", range: "all", from: "", to: "", q: "", sort: "date", dir: -1, pa: "", pb: "" },
    taskFilter: "pending",
    files: { stack: [] },
    boardList: [],
  };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  var STATUSES = ["To Do","Recived","On Hold","Estimating","Sent","Aproved","In Progress","Completed","Closed","Follow","Active","Not Started"];
  var TAGS = ["New Construction","Siding Installation","ADU","Deck Installation","Remodel","Windows and Doors","Repairs","Luxury","General Contracting","Apartments","Commercial","Pergolla","Metal Studs","Duplex"];

  // Overview field definitions: [key, label, type] — type: text|num|date|bool|area
  var SEC_PROJECT = [
    ["internalIDNumber","Internal ID","text"], ["projectName","Project name","text"],
    ["projectAddress","Address","text"], ["projectCity","City","text"],
    ["projectDate","Date received","date"], ["projectCompletedDate","Date completed","date"],
    ["projectSortingNumber","Sorting #","num"],
  ];
  var SEC_CLIENT = [
    ["projectClientName","Client name","text"], ["projectPhoneNumber","Phone","text"],
    ["projectEmailAddress","Email","text"],
  ];
  var SEC_LINKS = [
    ["projectOnlineAddress","Houzz link","text"], ["projectWebsite","Website","text"],
    ["projectGoogleSheetLink","Google Sheet link","text"], ["projectPlansURL","Plans URL","text"],
    ["projectLaborRate","Labor rate ($/hr)","num"],
  ];
  var SEC_NOTES = [
    ["checkScopeAndProjectFeatures","Project scope and features","area"],
    ["projectFinalEstimateNotes","Estimate notes","area"],
    ["estimateStatusDescription","Status description","text"],
    ["projectNotes","Project notes","area"],
  ];
  var SEC_CHECK = [
    ["checkDateFloorPlansRecived","Floor plans received on","text"],
    ["checkTotalLivingAreaPerPlan","Total living area (per plan)","num"],
    ["checkWallHigt","Wall heights","text"], ["checkMaxRoofPitch","Max roof pitch","num"],
    ["checkWallsMaterials","Exterior wall material","text"],
    ["checkRoofType","Roof type (trusses/stick)","text"], ["checkFundationType","Foundation type","text"],
    ["checkTotalNumberOfFloors","Total number of floors","num"],
    ["checkComplexityOfFloorplans","Complexity: floor plans","num"],
    ["checkComplexityOfGettingMaterial","Complexity: getting materials","num"],
    ["checkComplexityOfInstallingMater","Complexity: installing","num"],
    ["checkComplexityOfComunication","Complexity: communication","num"],
    ["checkEstimateAprovedDate","Estimate approved date","text"],
  ];
  var SEC_BOOLS = [
    ["checkHaveFundationFloorJoist","Estimate lower-level floor joist"],
    ["checkLaborMaterialPrice","Labor + material price"],
    ["checkCompletedFullProjectCostAna","Completed full cost analysis"],
    ["checkHaveBasementOrLowerLevelFlo","Has basement / lower level"],
    ["checkBuildOnAHill","Built on a hill"],
    ["checkIsARemodel","Is a remodel"],
    ["checkWeInstallWindows","We install doors & windows"],
  ];

  // Money / number / date helpers live in expense-filter.js so the Expenses tab
  // and the printed expense sheet format identically. These stay function
  // declarations (not var aliases) so binding happens at call time.
  function fmtMoney(n){ return DCR.exp.money(n); }
  function num(v){ return DCR.exp.num(v); }
  // SharePoint stores these as calendar dates but hands them back as UTC
  // instants ("2026-07-05T00:00:00Z"). Reading that with new Date() and showing
  // it in Pacific time lands on Jul 4 — a day early, and it also throws off the
  // month filters at the 1st. DCR.exp.toDate takes the Y-M-D exactly as written.
  function toDate(v){ return DCR.exp.toDate(v); }
  function fmtDate(v){ var d=toDate(v); return !v ? "—" : (d ? d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : String(v)); }
  function dateInputVal(v){
    if(!v)return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return m[0];
    var d=new Date(v); if(isNaN(d))return "";
    return [d.getFullYear(), String(d.getMonth()+1).padStart(2,"0"), String(d.getDate()).padStart(2,"0")].join("-");
  }

  /* ── header ── */
  async function loadRecord() {
    var d = await DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID));
    state.project = d.project; state.canWrite = d.canWrite; state.canEstimate = d.canEstimate;
    state.canLog = d.canLog; state.driveReady = d.driveReady;
    renderHead(); renderOverview();
  }

  function renderHead() {
    var p = state.project;
    document.title = "DCR — " + (p.internalIDNumber || "") + " " + (p.projectName || "");
    el("pjTitle").textContent = (p.internalIDNumber ? p.internalIDNumber + " — " : "") + (p.projectName || "(no name)");
    el("pjSub").textContent = [p.projectAddress, p.projectCity, p.projectClientName].filter(Boolean).join(" · ");
    var st = el("pjStatus");
    if (state.canWrite) {
      st.innerHTML = '<select id="pjStatusSel" style="background:none;border:none;color:inherit;font:inherit;cursor:pointer">' +
        STATUSES.map(function(s){ return '<option' + (s===p.estimateStatus?" selected":"") + '>' + esc(s) + "</option>"; }).join("") + "</select>";
      el("pjStatusSel").onchange = changeStatus;
    } else {
      st.textContent = p.estimateStatus || "—";
    }
    loadThumb();
  }

  async function changeStatus() {
    var ns = el("pjStatusSel").value;
    try {
      await DCR.api("/api/portal?action=board", { method:"POST", body:{ op:"status", projectId:PID, newStatus:ns } });
      state.project.estimateStatus = ns;
      msg("ok","✓ Status updated (logged)");
      delete state.parts.logs; if (activeTab()==="logs") loadTab("logs");
    } catch (e) { msg("err", e.message||"Status change failed"); }
  }

  async function loadThumb() {
    if (!state.driveReady) { el("pjThumb").textContent = "no preview"; return; }
    try {
      var r = await fetch(DCR.API_BASE + "/api/portal?action=thumb&projectId=" + encodeURIComponent(PID),
        { headers:{ Authorization:"Bearer "+DCR.getToken() } });
      if (!r.ok) throw 0;
      el("pjThumb").innerHTML = '<img src="' + URL.createObjectURL(await r.blob()) + '" alt="">';
    } catch (e) { el("pjThumb").textContent = "no preview"; }
  }

  // transient page notices — the auto-save badge owns #pjMsg
  function msg(kind, text) {
    var m = el("pjNotice"); m.textContent = text; m.className = "pj-msg " + (kind||"");
    if (kind==="ok") setTimeout(function(){ if(m.textContent===text){m.textContent="";} }, 3500);
  }

  /* ── overview ── */
  function fieldHtml(def) {
    var key=def[0], label=def[1], type=def[2];
    var v = state.project[key];
    var dis = state.canWrite ? "" : " disabled";
    if (type==="area") return '<div class="pj-f full"><label>'+esc(label)+'</label><textarea data-key="'+key+'" data-type="area"'+dis+'>'+esc(v==null?"":v)+'</textarea></div>';
    if (type==="date") return '<div class="pj-f"><label>'+esc(label)+'</label><input type="date" data-key="'+key+'" data-type="date" value="'+dateInputVal(v)+'"'+dis+'></div>';
    if (type==="num") return '<div class="pj-f"><label>'+esc(label)+'</label><input type="number" step="any" data-key="'+key+'" data-type="num" value="'+esc(v==null?"":v)+'"'+dis+'></div>';
    return '<div class="pj-f"><label>'+esc(label)+'</label><input type="text" data-key="'+key+'" data-type="text" value="'+esc(v==null?"":v)+'"'+dis+'></div>';
  }

  // Resize a textarea to fit its content (no inner scrollbar).
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = (ta.scrollHeight + 4) + "px";
  }

  function parseTags(raw) {
    return String(raw||"").split(",").map(function(s){ return s.trim().replace(/^#/,""); }).filter(Boolean);
  }

  function renderOverview() {
    var p = state.project;
    // Seed the saver's "what the server has" in the SAME shape the inputs
    // produce, or a field reads as changed the moment it's touched.
    state.originals = {};
    [SEC_PROJECT,SEC_CLIENT,SEC_LINKS,SEC_NOTES,SEC_CHECK].forEach(function(sec){
      sec.forEach(function(d){
        state.originals[d[0]] = d[2]==="date"
          ? (dateInputVal(p[d[0]]) ? dateInputVal(p[d[0]]) + "T12:00:00Z" : null)
          : p[d[0]];
      });
    });
    SEC_BOOLS.forEach(function(d){ state.originals[d[0]] = !!p[d[0]]; });
    state.originals.checkTagNames = p.checkTagNames;

    var links = [
      p.projectOnlineAddress ? '<a class="pj-btn pj-btn-sm" target="_blank" href="'+esc(p.projectOnlineAddress)+'">Houzz ↗</a>' : "",
      p.projectWebsite ? '<a class="pj-btn pj-btn-sm" target="_blank" href="'+esc(p.projectWebsite)+'">Website ↗</a>' : "",
      p.projectGoogleSheetLink ? '<a class="pj-btn pj-btn-sm" target="_blank" href="'+esc(p.projectGoogleSheetLink)+'">Google Sheet ↗</a>' : "",
      p.projectPlansURL ? '<a class="pj-btn pj-btn-sm" target="_blank" href="'+esc(p.projectPlansURL)+'">Plans ↗</a>' : "",
      '<a class="pj-btn pj-btn-sm" target="_blank" href="https://www.google.com/maps/search/?api=1&query='+encodeURIComponent([p.projectAddress,p.projectCity].filter(Boolean).join(", "))+'">Maps ↗</a>',
    ].filter(Boolean).join("");

    var activeTags = parseTags(p.checkTagNames);
    var tagHtml = TAGS.map(function(t){
      var on = activeTags.some(function(a){ return a.toLowerCase()===t.toLowerCase(); });
      return '<span class="pj-tag'+(on?" on":"")+(state.canWrite?"":" disabled")+'" data-tag="'+esc(t)+'">'+esc(t)+"</span>";
    }).join("");
    // keep custom tags not in the standard list
    var extra = activeTags.filter(function(a){ return !TAGS.some(function(t){ return t.toLowerCase()===a.toLowerCase(); }); });

    el("pane-overview").innerHTML =
      '<div class="pj-sec"><h3>Quick links</h3><div class="pj-links">'+links+'</div></div>' +
      '<div class="pj-sec"><h3>Project</h3><div class="pj-grid">'+SEC_PROJECT.map(fieldHtml).join("")+'</div></div>' +
      '<div class="pj-sec"><h3>Client</h3><div class="pj-grid">'+SEC_CLIENT.map(fieldHtml).join("")+'</div></div>' +
      '<div class="pj-sec"><h3>Links & rate</h3><div class="pj-grid">'+SEC_LINKS.map(fieldHtml).join("")+'</div></div>' +
      '<div class="pj-sec"><h3>Tags</h3><div class="pj-tagwrap" id="pjTagWrap">'+tagHtml+'</div>' +
        (extra.length?'<div class="pj-sub" style="margin-top:6px">Other tags kept: '+esc(extra.join(", "))+'</div>':"")+'</div>' +
      '<div class="pj-sec"><h3>Notes</h3><div class="pj-grid">'+SEC_NOTES.map(fieldHtml).join("")+'</div></div>' +
      '<div class="pj-sec"><h3>Scope checklist</h3><div class="pj-grid">'+SEC_CHECK.map(fieldHtml).join("")+'</div>' +
        '<div class="pj-grid" style="margin-top:8px">'+SEC_BOOLS.map(function(d){
          return '<label class="pj-check"><input type="checkbox" data-key="'+d[0]+'" data-type="bool"'+(state.project[d[0]]?" checked":"")+(state.canWrite?"":" disabled")+'> '+esc(d[1])+'</label>';
        }).join("")+'</div></div>';

    // The form saves itself — no Save button to remember. One saver per record,
    // so every field on this page coalesces into a single PATCH.
    projectSaver().baseline(state.originals).bind(el("pane-overview"));
    // multi-line note boxes grow to fit their content
    el("pane-overview").querySelectorAll('textarea[data-type="area"]').forEach(function(ta){
      autoGrow(ta);
      ta.addEventListener("input", function(){ autoGrow(ta); });
    });
    el("pjTagWrap").querySelectorAll(".pj-tag").forEach(function(tg){
      if (!state.canWrite) return;
      tg.addEventListener("click", function(){
        tg.classList.toggle("on");
        var on = Array.prototype.filter.call(el("pjTagWrap").querySelectorAll(".pj-tag.on"), function(x){return true;})
          .map(function(x){ return "#"+x.getAttribute("data-tag"); });
        var all = on.concat(extra.map(function(e){ return "#"+e; }));
        // a tag click is complete the moment it happens — save right away
        projectSaver().set("checkTagNames", all.join(", "), { now: true });
      });
    });
  }

  /* ── live saving of the project record ──────────────────────────────────
     Every writer of the Project row (Overview form, tag chips, Mailing notes)
     shares this one saver, keyed by record, so they can never race or clobber
     each other. Success patches state.project in place: re-rendering mid-edit
     would eat the caret and the textarea's grown height. */
  function projectSaver() {
    return DCR.live.record({
      key: "project:" + PID,
      status: "pjMsg",
      write: function (fields) {
        return DCR.api("/api/portal?action=data", {
          method: "PATCH",
          body: { list: "project", itemId: PID, fields: fields, lean: true },
        });
      },
      onSaved: function (fields) {
        for (var k in fields) { state.project[k] = fields[k]; state.originals[k] = fields[k]; }
      },
    });
  }

  /* ── tabs ── */
  function activeTab(){ var t=document.querySelector(".pj-tab.active"); return t?t.getAttribute("data-tab"):"overview"; }

  function switchTab(name) {
    document.querySelectorAll(".pj-tab").forEach(function(t){ t.classList.toggle("active", t.getAttribute("data-tab")===name); });
    document.querySelectorAll(".pj-pane").forEach(function(p){ p.classList.toggle("active", p.id==="pane-"+name); });
    if (DCR.takeoff) DCR.takeoff.setActive(name === "takeoffs");
    // keep the tab in the address bar so a reload comes back where you were
    try {
      var u = new URL(location.href);
      u.searchParams.set("tab", name);
      history.replaceState(null, "", u);
    } catch (e) {}
    loadTab(name);
  }

  function loadTab(name) {
    if (name==="overview" || state.parts[name]) return;
    state.parts[name] = true;
    if (name==="estimate") loadEstimate();
    else if (name==="takeoffs") loadTakeoffs();
    else if (name==="expenses") loadExpenses();
    else if (name==="payments") loadPayments();
    else if (name==="tasks") loadTasks();
    else if (name==="logs") loadLogs();
    else if (name==="mailing") renderMailing();
    else if (name==="files") loadFiles();
  }

  /* ── estimate (grouped: estimate name → grouping name → sorting number) ── */
  async function loadEstimate() {
    var pane = el("pane-estimate");
    pane.innerHTML = '<div class="pj-empty">Loading estimate…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=estimate");
      state.estRows = d.rows||[];
      state.estCanEdit = !!d.canEdit;
      state.estPricesHidden = !!d.pricesHidden;
      renderEstimate(d.canEdit);
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  // Escape, and keep the line breaks the estimator typed into the description.
  // Notes pasted from Word/email sometimes carry markup; show those as plain
  // text with their breaks, never as live HTML (esc still runs on the result).
  // Notes pasted from Word/email carry markup — read it as plain text with its
  // line breaks intact (never as live HTML). Shared with the printed sheet.
  function stripML(v) { return DCR.exp.stripML(v); }
  function escML(v) { return DCR.exp.escML(v); }

  function estLineHtml(r) {
    // Money parentheticals are skipped when their fields are absent (e.g. the
    // server stripped prices for a Lead) — "(4 guys × 2 days)" reads fine alone.
    var lines = [];
    if (r.title) lines.push('<b>'+escML(r.title)+'</b>');
    if (r.taskLaborName) {
      var lab = escML(r.taskLaborName);
      if (r.taskLaborNumberOfGuys) {
        lab += ' <span class="pj-sub">('+r.taskLaborNumberOfGuys+' guys × '+(r.taskLaborDaysToComplete||0)+' days'+
          (r.taskLaborPricePerHour!=null && num(r.taskLaborPricePerHour) ? ' @ '+fmtMoney(r.taskLaborPricePerHour)+'/hr' : '')+')</span>';
      }
      if (r.taskLaborPrice!=null && num(r.taskLaborPrice)) lab += ' <span class="pj-sub">('+(r.taskLaborQty||1)+' × '+fmtMoney(r.taskLaborPrice)+')</span>';
      lines.push(lab);
    }
    if (r.taskMaterialName) {
      var mat = escML(r.taskMaterialName);
      if (num(r.taskMaterialQty)) {
        mat += ' <span class="pj-sub">('+r.taskMaterialQty+
          (r.taskMaterialUnitPrice!=null && num(r.taskMaterialUnitPrice) ? ' × '+fmtMoney(r.taskMaterialUnitPrice) : ' pcs')+')</span>';
      }
      lines.push(mat);
    }
    if (r.taskEstimateNotes) lines.push('<span class="pj-sub">'+escML(r.taskEstimateNotes)+'</span>');
    return lines.join("<br>")||"—";
  }

  function renderEstimate(canEdit) {
    var pane = el("pane-estimate");
    var rows = state.estRows;

    // All estimate names (for the filter list) — from every row, always.
    var allNames = [];
    rows.forEach(function(r){ var n = r.taskEstimateName || "(no estimate name)"; if (allNames.indexOf(n)===-1) allNames.push(n); });
    if (!allNames.length || allNames.indexOf(state.estFilter)===-1) state.estFilter = "*";

    var filterSel = allNames.length > 1
      ? '<select class="pj-btn pj-btn-sm" id="estFilter" style="cursor:pointer"><option value="*">All estimates ('+allNames.length+')</option>' +
        allNames.map(function(n){ return '<option value="'+esc(n)+'"'+(state.estFilter===n?" selected":"")+'>'+esc(n)+'</option>'; }).join("") + '</select>'
      : "";
    var bar = '<div class="pj-bar">' +
      (canEdit ? '<button class="pj-btn pj-btn-primary pj-btn-sm" id="estAddBtn">＋ New item</button>' : "") +
      '<button class="pj-btn pj-btn-sm" id="estReload">↻</button>' +
      filterSel +
      '<a class="pj-btn pj-btn-sm" href="report-estimate.html?id='+encodeURIComponent(PID)+'">🖨 Print estimate</a>' +
      '<span class="pj-sub">'+rows.length+' lines'+(canEdit?' · double-click an item to edit':"")+'</span></div>';
    if (!rows.length) { pane.innerHTML = bar + '<div class="pj-empty">No estimate lines yet.</div>'; wireEstBar(canEdit); return; }

    // Rows arrive server-sorted (estimate name → grouping → sorting number);
    // build the section/group structure preserving that order.
    var secs = [], secIdx = {};
    rows.forEach(function(r){
      var sn = r.taskEstimateName || "(no estimate name)";
      if (state.estFilter !== "*" && sn !== state.estFilter) return;
      if (!(sn in secIdx)) { secIdx[sn] = secs.length; secs.push({ name:sn, groups:[], gIdx:{}, labor:0, mat:0, tot:0 }); }
      var s = secs[secIdx[sn]];
      var g = r.taskGroupingName || "(no group)";
      if (!(g in s.gIdx)) { s.gIdx[g] = s.groups.length; s.groups.push({ name:g, rows:[] }); }
      s.groups[s.gIdx[g]].rows.push(r);
    });

    // Money formatting: zeros are hidden everywhere; $ shows only on totals
    // (item Labor/Material columns show the bare number). When the server sent
    // pricesHidden (Lead role), all money columns/totals are omitted entirely.
    var showMoney = !state.estPricesHidden;
    var m$ = function(n){ return num(n) ? fmtMoney(n) : ""; };
    var mBare = function(n){ return num(n) ? fmtMoney(n).replace("$", "") : ""; };
    var cols = showMoney ? 4 : 1;

    // Per-estimate totals, computed up front so they can sit at the TOP of each card.
    var grand = { labor:0, mat:0, tot:0 };
    secs.forEach(function(s){
      s.groups.forEach(function(gr){
        gr.rows.forEach(function(r){
          s.labor += (r.TaskLaborTotalPrice||0) + (r.TaskLaborTotalPricePerQty||0);
          s.mat   += (r.TaskMaterialTotalPrice||0);
          s.tot   += (r.TaskGrandTotalMaterialAndLabor||0);
        });
      });
      grand.labor += s.labor; grand.mat += s.mat; grand.tot += s.tot;
    });

    var html = "";
    secs.forEach(function(s){
      var addBtn = canEdit ? ' <button class="pj-btn pj-btn-sm" data-est-addto="'+esc(s.name==="(no estimate name)"?"":s.name)+'" style="margin-left:8px">＋ Add item</button>' : "";
      html += '<div class="pj-esttable"><table class="pj-tbl"><thead>' +
        '<tr class="pj-est"><td><span class="pj-estname">📄 '+esc(s.name)+'</span>'+addBtn+'</td>' +
          (showMoney ? '<td class="num">'+m$(s.labor)+'</td><td class="num">'+m$(s.mat)+'</td><td class="num">'+m$(s.tot)+'</td>' : "") + '</tr>' +
        '<tr class="pj-colhead"><th>Item</th>'+(showMoney?'<th class="num">Labor</th><th class="num">Material</th><th class="num">Total</th>':"")+'</tr>' +
        '</thead><tbody>';
      s.groups.forEach(function(gr){
        html += '<tr class="pj-grp"><td colspan="'+cols+'">'+esc(gr.name)+'</td></tr>';
        var gl=0, gm=0, gt=0;
        gr.rows.forEach(function(r){
          var labor = (r.TaskLaborTotalPrice||0) + (r.TaskLaborTotalPricePerQty||0);
          var mat = (r.TaskMaterialTotalPrice||0);
          gl+=labor; gm+=mat; gt+=(r.TaskGrandTotalMaterialAndLabor||0);
          html += '<tr'+(canEdit?' data-est-open="'+r.id+'" style="cursor:pointer" title="Double-click to edit"':"")+'><td class="pj-il">'+ estLineHtml(r) +'</td>' +
            (showMoney ? '<td class="num">'+mBare(labor)+'</td><td class="num">'+mBare(mat)+'</td>' +
              '<td class="num"><b>'+m$(r.TaskGrandTotalMaterialAndLabor)+'</b></td>' : "") + '</tr>';
        });
        if (showMoney && s.groups.length > 1) {
          html += '<tr class="pj-grpTot"><td>Subtotal — '+esc(gr.name)+'</td><td class="num">'+m$(gl)+'</td><td class="num">'+m$(gm)+'</td><td class="num">'+m$(gt)+'</td></tr>';
        }
      });
      html += '</tbody></table></div>';
    });
    if (showMoney && state.estFilter === "*" && secs.length > 1) {
      html += '<div class="pj-esttable"><table class="pj-tbl"><tbody>' +
        '<tr class="pj-grand"><td>GRAND TOTAL — all estimates</td><td class="num">'+m$(grand.labor)+'</td><td class="num">'+m$(grand.mat)+'</td><td class="num">'+m$(grand.tot)+'</td></tr>' +
        '</tbody></table></div>';
    }

    pane.innerHTML = bar + html;
    wireEstBar(canEdit);
    if (canEdit) {
      pane.querySelectorAll("[data-est-addto]").forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); ieOpen(null, b.getAttribute("data-est-addto")); }; });
      pane.querySelectorAll("[data-est-open]").forEach(function(tr){ tr.ondblclick=function(){ ieOpen(tr.getAttribute("data-est-open")); }; });
    }
  }

  function wireEstBar(canEdit) {
    var r = el("estReload"); if (r) r.onclick = loadEstimate;
    var a = el("estAddBtn"); if (a) a.onclick = function(){ ieOpen(null, ""); };
    var f = el("estFilter"); if (f) f.onchange = function(){ state.estFilter = this.value; renderEstimate(state.estCanEdit); };
  }

  /* ══ Estimate item editor (Access GeneralProjectTasksSideForm port) ══
     SharePoint formulas mirrored for the live preview:
       MenHours = Guys×Days×8; LaborTotal = MenHours×Rate×Markup;
       LaborPerQty = Markup×Price×Qty; MaterialTotal = Qty×Unit×Markup;
       Grand = LaborTotal + LaborPerQty + MaterialTotal.
     Markup is stored as a MULTIPLIER (1 = 0%, 1.3 = 30%). */
  var IE_NUM = [
    ["ie_sort","taskSortingNumber"],["ie_quoted","taskQuotedPrice"],
    ["ie_lArea","taskLaborSurfaceArea"],["ie_lRate","taskLaborPricePerHour"],
    ["ie_lGuys","taskLaborNumberOfGuys"],["ie_lDays","taskLaborDaysToComplete"],
    ["ie_lQty","taskLaborQty"],["ie_lPrice","taskLaborPrice"],
    ["ie_mQty","taskMaterialQty"],["ie_mPrice","taskMaterialUnitPrice"],["ie_mArea","taskMaterialSurfaceArea"],
  ];
  var IE_TEXT = [
    ["ie_estName","taskEstimateName"],["ie_title","title"],["ie_laborName","taskLaborName"],
    ["ie_matName","taskMaterialName"],["ie_assigned","taskAssignedPerson"],
    ["ie_email","taskAssignedEmail"],["ie_notes","taskEstimateNotes"],
  ];

  function mkFill(sel, stored) {
    var v = num(stored) || 1;
    var opts = "";
    var found = false;
    for (var p=0; p<=50; p+=5) {
      var m = Math.round((1+p/100)*100)/100;
      if (Math.abs(m-v) < 0.001) found = true;
      opts += '<option value="'+m+'"'+(Math.abs(m-v)<0.001?" selected":"")+'>'+p+'%</option>';
    }
    if (!found) opts += '<option value="'+v+'" selected>'+Math.round((v-1)*100)+'%</option>';
    sel.innerHTML = opts;
  }

  function ieRecalc() {
    var mk = num(el("ie_lMk").value)||1, mmk = num(el("ie_mMk").value)||1;
    var lab1 = num(el("ie_lGuys").value)*num(el("ie_lDays").value)*8*num(el("ie_lRate").value)*mk;
    var lab2 = mk*num(el("ie_lPrice").value)*num(el("ie_lQty").value);
    var labT = lab1+lab2;
    var matT = num(el("ie_mQty").value)*num(el("ie_mPrice").value)*mmk;
    var area = num(el("ie_lArea").value), marea = num(el("ie_mArea").value);
    el("ieLab1").textContent = fmtMoney(lab1);
    el("ieLab2").textContent = fmtMoney(lab2);
    el("ieLabT").textContent = fmtMoney(labT);
    el("ieMatT").textContent = fmtMoney(matT);
    el("ieLabSq").textContent = area>0 ? fmtMoney(labT/area)+" /F²" : "";
    el("ieMatSq").textContent = marea>0 ? fmtMoney(matT/marea)+" /F²" : "";
    el("ieGrand").textContent = "Total: "+fmtMoney(labT+matT);
  }

  function ieOpen(rowId, presetEstName) {
    var r = rowId ? state.estRows.find(function(x){ return String(x.id)===String(rowId); }) : null;
    state.ie = { id: r ? r.id : null, log: r ? (r.taskUpdateLog||"") : "", subTab: "takeoff" };
    var names = {}; state.estRows.forEach(function(x){ if(x.taskEstimateName) names[x.taskEstimateName]=1; });
    el("ieEstNames").innerHTML = Object.keys(names).map(function(n){ return '<option value="'+esc(n)+'">'; }).join("");
    IE_TEXT.forEach(function(d){ el(d[0]).value = r ? (r[d[1]]||"") : ""; });
    IE_NUM.forEach(function(d){ var v = r ? r[d[1]] : null; el(d[0]).value = (v===null||v===undefined||v==="") ? "" : v; });
    if (!r && presetEstName) el("ie_estName").value = presetEstName;
    mkFill(el("ie_lMk"), r ? r.taskLaborMarkup : 1);
    mkFill(el("ie_mMk"), r ? r.taskMaterialMarkup : 1);
    el("ieTaskId").value = r ? r.id : "(new)";
    el("ieLogView").textContent = state.ie.log;
    el("ieLogNote").value = "";
    el("ieContactSearch").value = ""; el("ieContactHits").innerHTML = "";
    el("ieMsg").textContent = ""; el("ieMsg").className = "pj-msg";
    el("ieDelete").style.display = r ? "" : "none";
    document.querySelectorAll(".ie-tab").forEach(function(t){ t.classList.toggle("active", t.getAttribute("data-ietab")==="takeoff"); });
    ieRecalc();
    renderIeSub();
    el("ieModal").classList.add("open");
  }

  function ieCollect() {
    var fields = {};
    IE_TEXT.forEach(function(d){ fields[d[1]] = el(d[0]).value; });
    IE_NUM.forEach(function(d){ var v = el(d[0]).value; if (v!=="") fields[d[1]] = Number(v); });
    fields.taskLaborMarkup = Number(el("ie_lMk").value)||1;
    fields.taskMaterialMarkup = Number(el("ie_mMk").value)||1;
    fields.taskUpdateLog = state.ie.log;
    Object.keys(fields).forEach(function(k){ if (fields[k]==="" ) delete fields[k]; });
    return fields;
  }

  async function ieSave() {
    el("ieSave").disabled = true;
    el("ieMsg").textContent = "Saving…"; el("ieMsg").className = "pj-msg";
    try {
      var fields = ieCollect();
      if (!Object.keys(fields).length) throw new Error("Nothing to save.");
      var body = state.ie.id
        ? { op:"estUpdate", itemId: state.ie.id, fields: fields }
        : { op:"estAdd", projectId: PID, fields: fields };
      var d = await DCR.api("/api/portal?action=project", { method:"POST", body: body });
      if (!state.ie.id && d.id) { state.ie.id = d.id; el("ieTaskId").value = d.id; el("ieDelete").style.display=""; renderIeSub(); }
      el("ieMsg").textContent = "Saved ✓"; el("ieMsg").className = "pj-msg ok";
      loadEstimate();
    } catch (e) { el("ieMsg").textContent = e.message||"Save failed"; el("ieMsg").className = "pj-msg err"; }
    el("ieSave").disabled = false;
  }

  /* contacts search for Assigned-to */
  async function ieContactLookup(q) {
    var box = el("ieContactHits");
    if (q.length < 2) { box.innerHTML = ""; return; }
    if (!state.contacts) {
      try {
        var d = await DCR.api("/api/portal?action=data&list=contacts&top=999");
        state.contacts = d.value||[];
      } catch (e) { box.innerHTML = '<div class="pj-sub">'+esc(e.message)+'</div>'; return; }
    }
    var ql = q.toLowerCase();
    var hits = state.contacts.filter(function(c){
      return [c.contactName,c.contactCompany,c.contactTrade,c.contactPhone].join(" ").toLowerCase().indexOf(ql)!==-1;
    }).slice(0,6);
    box.innerHTML = hits.map(function(c,i){
      return '<div class="ie-contact-hit" data-ci="'+i+'"><b>'+esc(c.contactName||"")+'</b> <span class="pj-sub">'+esc([c.contactCompany,c.contactTrade,c.contactPhone].filter(Boolean).join(" · "))+'</span></div>';
    }).join("");
    box.querySelectorAll("[data-ci]").forEach(function(h){
      h.onclick = function(){
        var c = hits[Number(h.getAttribute("data-ci"))];
        el("ie_assigned").value = [c.contactName, c.contactCompany, c.contactPhone].filter(Boolean).join("\n");
        if (c.contactEMail) el("ie_email").value = c.contactEMail;
        box.innerHTML = ""; el("ieContactSearch").value = "";
      };
    });
  }

  function ieMailto(kind) {
    var email = el("ie_email").value.trim();
    if (!email) { alert("No e-mail address set."); return; }
    var p = state.project||{};
    var title = el("ie_title").value || "estimate item";
    var subj = (kind==="quote" ? "Quote request — " : "Following up — ") +
      (p.internalIDNumber||"") + " " + (p.projectName||"") + " — " + title;
    var lines = [];
    if (kind==="quote") {
      lines.push("Hello,", "", "Could you give us a quote for the following work on " + (p.projectAddress||p.projectName||"our project") + ":", "");
      if (el("ie_laborName").value) lines.push("Labor: " + el("ie_laborName").value, "");
      if (el("ie_matName").value) lines.push("Material: " + el("ie_matName").value, "");
      lines.push("Thank you,", DCR.companyInfo.name);
    } else {
      lines.push("Hello,", "", "Just following up on the quote request for " + title + " (" + (p.projectAddress||p.projectName||"") + "). Let us know if you need anything.", "", "Thank you,", DCR.companyInfo.name);
    }
    location.href = "mailto:"+encodeURIComponent(email)+"?subject="+encodeURIComponent(subj)+"&body="+encodeURIComponent(lines.join("\n"));
  }

  /* right-side sub-tabs: takeoff / expenses / files */
  function renderIeSub() {
    var box = el("ieSub");
    var tab = state.ie.subTab;
    if (tab !== "files" && !state.ie.id) {
      box.innerHTML = '<div class="pj-empty">Save the item first to attach '+(tab==="takeoff"?"takeoff lines":"expenses")+'.</div>';
      return;
    }
    box.innerHTML = '<div class="pj-empty">Loading…</div>';
    if (tab === "takeoff") ieSubTakeoff();
    else if (tab === "expenses") ieSubExpenses();
    else ieSubFiles();
  }

  async function ieSubTakeoff() {
    var box = el("ieSub");
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=takeoffs");
      var rows = (d.rows||[]).filter(function(r){ return String(r.itemGeneralProjectTasksID||"")===String(state.ie.id); });
      var tot = 0;
      var body = rows.map(function(r){
        var t = num(r.itemQty)*num(r.itemPrice); tot+=t;
        return '<tr><td>'+esc(r.itemName||r.itemPurpose||"—")+'</td><td class="num">'+(num(r.itemQty)||"")+'</td>' +
          '<td class="num">'+(num(r.itemPrice)?fmtMoney(r.itemPrice):"")+'</td><td class="num">'+(t?fmtMoney(t):"")+'</td>' +
          '<td><button class="pj-btn pj-btn-sm" data-iet-del="'+r.id+'">✗</button></td></tr>';
      }).join("");
      box.innerHTML = '<table class="ie-mini"><thead><tr><th>Purpose / name</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
        body + '<tr><td colspan="3" style="text-align:right;font-weight:700">Total takeoff:</td><td class="num" style="font-weight:700">'+fmtMoney(tot)+'</td><td></td></tr></tbody></table>' +
        '<div class="ie-calcrow" style="margin-top:10px">' +
          '<div class="pj-f" style="flex:1;min-width:110px"><label>Item</label><input id="ietName" /></div>' +
          '<div class="pj-f"><label>Qty</label><input id="ietQty" type="number" step="any" style="width:64px" /></div>' +
          '<div class="pj-f"><label>Price $</label><input id="ietPrice" type="number" step="any" style="width:80px" /></div>' +
          '<button class="pj-btn pj-btn-sm" id="ietAdd">＋</button></div>';
      el("ietAdd").onclick = async function(){
        var name = el("ietName").value.trim();
        if (!name) return;
        try {
          var fields = { itemName: name, itemGeneralProjectTasksID: Number(state.ie.id),
            takeoffName: el("ie_title").value || ("Item "+state.ie.id) };
          if (el("ietQty").value!=="") fields.itemQty = el("ietQty").value;
          if (el("ietPrice").value!=="") fields.itemPrice = Number(el("ietPrice").value);
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"toAdd", projectId: PID, fields: fields } });
          DCR.takeoff.invalidate();   // the Takeoffs tab is now holding a stale row set
          ieSubTakeoff();
        } catch (e) { alert(e.message||"Add failed"); }
      };
      box.querySelectorAll("[data-iet-del]").forEach(function(b){
        b.onclick = async function(){
          if (!confirm("Delete this takeoff line?")) return;
          try { await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"toDelete", itemId: b.getAttribute("data-iet-del") } }); DCR.takeoff.invalidate(); ieSubTakeoff(); }
          catch (e) { alert(e.message||"Delete failed"); }
        };
      });
    } catch (e) { box.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  async function ieSubExpenses() {
    var box = el("ieSub");
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=expenses");
      var rows = (d.rows||[]).filter(function(r){ return String(r.expenseOriginalEstimateNumber||"")===String(state.ie.id); });
      var tot = 0;
      var body = rows.map(function(r){
        var amt = num(r.materials)+num(r.contractors)+num(r.invoice); tot+=amt;
        return '<tr><td>'+fmtDate(r.expenseDate)+'<br><span class="pj-sub">'+esc(r.description||"")+'</span></td>' +
          '<td class="num">'+fmtMoney(amt)+'</td>' +
          '<td><button class="pj-btn pj-btn-sm" data-iee-del="'+r.id+'">✗</button></td></tr>';
      }).join("");
      box.innerHTML = '<table class="ie-mini"><thead><tr><th>Expense</th><th class="num">Amount</th><th></th></tr></thead><tbody>' +
        body + '<tr><td style="text-align:right;font-weight:700">Total expenses:</td><td class="num" style="font-weight:700">'+fmtMoney(tot)+'</td><td></td></tr></tbody></table>' +
        '<div class="ie-calcrow" style="margin-top:10px">' +
          '<div class="pj-f" style="flex:1;min-width:110px"><label>Description</label><input id="ieeDesc" /></div>' +
          '<div class="pj-f"><label>Materials $</label><input id="ieeMat" type="number" step="any" style="width:84px" /></div>' +
          '<div class="pj-f"><label>Contractors $</label><input id="ieeCon" type="number" step="any" style="width:84px" /></div>' +
          '<button class="pj-btn pj-btn-sm" id="ieeAdd">＋</button></div>';
      el("ieeAdd").onclick = async function(){
        var desc = el("ieeDesc").value.trim();
        if (!desc) return;
        try {
          var fields = { description: desc, expenseDate: new Date().toISOString().slice(0,10)+"T12:00:00Z",
            expenseOriginalEstimateNumber: String(state.ie.id),
            gropingName: el("ie_title").value || ("Item "+state.ie.id) };
          if (el("ieeMat").value!=="") fields.materials = Number(el("ieeMat").value);
          if (el("ieeCon").value!=="") fields.contractors = Number(el("ieeCon").value);
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"expAdd", projectId: PID, fields: fields } });
          ieSubExpenses();
        } catch (e) { alert(e.message||"Add failed"); }
      };
      box.querySelectorAll("[data-iee-del]").forEach(function(b){
        b.onclick = async function(){
          if (!confirm("Delete this expense?")) return;
          try { await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"expDelete", itemId: b.getAttribute("data-iee-del") } }); ieSubExpenses(); }
          catch (e) { alert(e.message||"Delete failed"); }
        };
      });
    } catch (e) { box.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  async function ieSubFiles() {
    var box = el("ieSub");
    if (!state.driveReady) { box.innerHTML = '<div class="pj-empty">Google Drive is not connected.</div>'; return; }
    try {
      var d = await DCR.api("/api/portal?action=drive&projectId="+encodeURIComponent(PID));
      var items = d.items||[];
      box.innerHTML = (d.folderUrl ? '<div style="margin-bottom:8px"><a class="pj-btn pj-btn-sm" target="_blank" href="'+esc(d.folderUrl)+'">Open project folder in SharePoint ↗</a></div>' : "") +
        (items.map(function(f){
          return '<div class="ie-contact-hit" data-ief="'+esc(f.id)+'" data-folder="'+(f.isFolder?1:0)+'" data-link="'+esc(f.webViewLink||"")+'">'+fileIcon(f)+' '+esc(f.name)+'</div>';
        }).join("") || '<div class="pj-empty">Empty folder.</div>');
      box.querySelectorAll("[data-ief]").forEach(function(row){
        row.onclick = function(){
          if (row.getAttribute("data-folder")==="1") {
            var link = row.getAttribute("data-link");
            if (link) window.open(link, "_blank");
          } else openFile(row.getAttribute("data-ief"), row.getAttribute("data-link"));
        };
      });
    } catch (e) { box.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  async function delEstRow(rowId) {
    if (!confirm("Delete this estimate line? This cannot be undone.")) return;
    try {
      await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"estDelete", itemId: rowId } });
      if (state.ie && String(state.ie.id)===String(rowId)) el("ieModal").classList.remove("open");
      loadEstimate();
    } catch (e) { alert(e.message || "Delete failed"); }
  }

  var EXP_DEFS = [
    ["gropingName","Grouping name","text","expGroups"],["gropingNumber","Grouping #","num"],
    ["expenseDate","Date","date"],["description","Description","text"],
    ["estimate","Estimate $","num"],["changeOrder","Change order $","num"],
    ["invoice","Invoice $","num"],["materials","Materials $","num"],
    ["contractors","Contractors $","num"],["laborExpenseHours","Labor hours","num"],
    ["laborExpenseRatePerHour","Labor rate $/hr","text"],["laborExpenseDescription","Labor description","text"],
    ["materialExpenseDescription","Material description","text"],["remarks","Remarks","text"],
  ];
  var PAY_DEFS = [
    ["paymentName","Payment name","text"],["paymentPaidDate","Paid date","date"],
    ["paymentEstimateAmount","Estimate $","num"],["paymentInvoiceAmount","Invoice $","num"],
    ["paymentExpenseAmount","Expense $","num"],["paymentDescription","Description","text"],
    ["paymentPaidNotes","Paid notes","text"],
  ];
  var SUB_CFG = {
    exp: { defs:EXP_DEFS, title:"Expense record", rowsKey:"expRows", reload:function(){loadExpenses();} },
    pay: { defs:PAY_DEFS, title:"Payment",        rowsKey:"payRows", reload:function(){loadPayments();} },
  };

  // The Takeoffs tab is its own module (takeoff.js) — grouping four deep,
  // fast entry, move/copy and undo/redo are a lot of machinery to carry here.
  function loadTakeoffs() {
    DCR.takeoff.mount({ pane: el("pane-takeoffs"), pid: PID, profile: state.profile });
  }

  /* ── sub-list modal (expenses + payments) ── */
  function subDatalists(kind) {
    var rows = state[SUB_CFG[kind].rowsKey] || [];
    var lists = {};
    if (kind === "exp") {
      lists.expGroups = {};
      rows.forEach(function(r){ if(r.gropingName)lists.expGroups[r.gropingName]=1; });
    }
    return Object.keys(lists).map(function(id){
      return '<datalist id="'+id+'">'+Object.keys(lists[id]).map(function(v){ return '<option value="'+esc(v)+'">'; }).join("")+'</datalist>';
    }).join("");
  }

  function openSubModal(kind, rowId) {
    var cfg = SUB_CFG[kind];
    state.subKind = kind;
    state.subEditing = rowId ? (state[cfg.rowsKey]||[]).find(function(r){ return String(r.id)===String(rowId); }) : null;
    el("subModalTitle").textContent = (rowId?"Edit ":"New ") + cfg.title.toLowerCase();
    el("subMsg").textContent = "";
    // delete only makes sense on an existing record, and only if you may edit
    el("subDelete").style.display = rowId && state.canWrite ? "" : "none";
    el("subFields").innerHTML = cfg.defs.map(function(d){
      var v = state.subEditing ? state.subEditing[d[0]] : "";
      if (d[2]==="date") return '<div class="pj-f"><label>'+d[1]+'</label><input type="date" id="sf_'+d[0]+'" value="'+dateInputVal(v)+'"></div>';
      var t = d[2]==="num" ? ' type="number" step="any"' : ' type="text"';
      var dl = d[3] ? ' list="'+d[3]+'"' : "";
      return '<div class="pj-f"><label>'+d[1]+'</label><input'+t+dl+' id="sf_'+d[0]+'" value="'+esc(v==null?"":v)+'"></div>';
    }).join("") + subDatalists(kind);
    el("subModal").classList.add("open");
  }

  async function saveSubModal() {
    var kind = state.subKind, cfg = SUB_CFG[kind];
    var fields = {};
    cfg.defs.forEach(function(d){
      var inp = el("sf_"+d[0]); if (!inp) return;
      var v = inp.value;
      if (v==="") return;
      if (d[2]==="num") fields[d[0]] = Number(v);
      else if (d[2]==="date") fields[d[0]] = v + "T12:00:00Z";
      else fields[d[0]] = v;
    });
    if (!Object.keys(fields).length) { el("subMsg").textContent = "Nothing to save."; return; }
    el("subSave").disabled = true;
    try {
      var body = state.subEditing
        ? { op: kind+"Update", itemId: state.subEditing.id, fields: fields }
        : { op: kind+"Add", projectId: PID, fields: fields };
      await DCR.api("/api/portal?action=project", { method:"POST", body: body });
      el("subModal").classList.remove("open");
      cfg.reload();
    } catch (e) { el("subMsg").textContent = e.message || "Save failed"; }
    el("subSave").disabled = false;
  }

  // Delete from inside the open record (the row has no delete button, so this
  // is a deliberate two-step action: open it, read it, then remove it).
  async function deleteSubModal() {
    var kind = state.subKind, row = state.subEditing;
    if (!row) return;
    var what = kind === "exp"
      ? [fmtDate(row.expenseDate), expDesc(row)].filter(Boolean).join(" — ")
      : (row.itemName || row.description || "this record");
    if (!confirm("Delete this " + SUB_CFG[kind].title.toLowerCase() + "?\n\n" + what + "\n\nThis cannot be undone.")) return;
    var btn = el("subDelete");
    btn.disabled = true;
    el("subMsg").textContent = "Deleting…";
    try {
      await DCR.api("/api/portal?action=project", { method: "POST", body: { op: kind + "Delete", itemId: row.id } });
      el("subModal").classList.remove("open");
      SUB_CFG[kind].reload();
    } catch (e) { el("subMsg").textContent = e.message || "Delete failed"; }
    btn.disabled = false;
  }

  function wireSubButtons(scope) {
    scope.querySelectorAll("[data-sub-edit]").forEach(function(b){
      b.onclick = function(){ var p=b.getAttribute("data-sub-edit").split(":"); openSubModal(p[0], p[1]); };
    });
    scope.querySelectorAll("[data-sub-del]").forEach(function(b){
      b.onclick = async function(){
        var p=b.getAttribute("data-sub-del").split(":");
        if (!confirm("Delete this record? This cannot be undone.")) return;
        try {
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:p[0]+"Delete", itemId:p[1] } });
          SUB_CFG[p[0]].reload();
        } catch (e) { alert(e.message||"Delete failed"); }
      };
    });
  }

  /* ── expenses (editable) ──
     Filterable by group, date period and free text; sortable; totals always
     reflect what's on screen. Rows are opened (double-click or ✎) to edit —
     deleting lives inside that editor so a record can't be lost by a stray tap. */

  // Matching, sorting and grouping live in expense-filter.js — the printed
  // report runs the very same code, so the paper can't disagree with the screen.
  function expFiltered() { return DCR.exp.filter(state.expRows || [], state.expFilter); }
  function expDesc(r) { return DCR.exp.descOf(r); }
  function expSortRows(rows) { return DCR.exp.sort(rows, state.expFilter); }

  // Remember the filter for this project: in the address bar (so reload, browser
  // Back and the report's ← Back all land on the same view) and in sessionStorage
  // (so a plain refresh restores it too). Called from one place — renderExpenses.
  function expPersist() {
    try { DCR.exp.save(PID, state.expFilter); } catch (e) {}
    try {
      if (activeTab() !== "expenses") return;
      var u = new URL(location.href);
      u.searchParams.set("tab", "expenses");
      DCR.exp.applyToUrl(u, state.expFilter);
      history.replaceState(null, "", u);
    } catch (e) {}
  }

  function expCsv(rows) {
    function cell(v) { var s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var out = [["Date", "Group", "Description", "Estimate", "Invoice", "Materials", "Contractors", "Remarks"].join(",")];
    rows.forEach(function (r) {
      // ISO date so Excel/Sheets import it as a date, not as text
      out.push([dateInputVal(r.expenseDate), r.gropingName || "", stripML(expDesc(r)), num(r.estimate) || "",
        num(r.invoice) || "", num(r.materials) || "", num(r.contractors) || "", stripML(r.remarks)].map(cell).join(","));
    });
    return out.join("\r\n");
  }

  async function loadExpenses() {
    var pane = el("pane-expenses");
    pane.innerHTML = '<div class="pj-empty">Loading expenses…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + PID + "&part=expenses");
      state.expRows = d.rows || [];
      state.expCanEdit = !!d.canEdit;
      renderExpenses();
    } catch (e) { pane.innerHTML = '<div class="pj-empty">' + esc(e.message) + '</div>'; }
  }

  function renderExpenses() {
    var pane = el("pane-expenses");
    var all = state.expRows || [], canEdit = state.expCanEdit, f = state.expFilter;
    var cols = canEdit ? 7 : 6;

    var groupNames = [];
    all.forEach(function (r) { var g = DCR.exp.groupOf(r); if (groupNames.indexOf(g) === -1) groupNames.push(g); });
    groupNames.sort();
    if (f.group !== "*" && groupNames.indexOf(f.group) === -1) f.group = "*";

    // One choke point: every filter change re-renders, so remembering the view
    // here covers all of them — and only after a vanished group has been reset.
    expPersist();

    var PERIODS = DCR.exp.PERIODS;

    var bar = '<div class="pj-bar">' +
      (canEdit ? '<button class="pj-btn pj-btn-primary pj-btn-sm" id="expAddBtn">＋ New expense</button>' : "") +
      '<select class="pj-btn pj-btn-sm" id="expGroup" style="cursor:pointer" title="Filter by group">' +
        '<option value="*">All groups (' + groupNames.length + ')</option>' +
        groupNames.map(function (g) { return '<option value="' + esc(g) + '"' + (f.group === g ? " selected" : "") + '>' + esc(g) + '</option>'; }).join("") +
      '</select>' +
      '<select class="pj-btn pj-btn-sm" id="expRange" style="cursor:pointer" title="Filter by date">' +
        PERIODS.map(function (p) { return '<option value="' + p[0] + '"' + (f.range === p[0] ? " selected" : "") + '>' + p[1] + '</option>'; }).join("") +
      '</select>' +
      '<span id="expCustom" style="' + (f.range === "custom" ? "display:inline-flex" : "display:none") + ';gap:6px;align-items:center">' +
        '<input type="date" id="expFrom" class="pj-btn pj-btn-sm" value="' + esc(f.from) + '" title="From">' +
        '<span class="pj-sub">to</span>' +
        '<input type="date" id="expTo" class="pj-btn pj-btn-sm" value="' + esc(f.to) + '" title="To">' +
      '</span>' +
      '<input class="pj-search" id="expSearch" placeholder="Search description…" value="' + esc(f.q) + '">' +
      (f.group !== "*" || f.range !== "all" || f.q ? '<button class="pj-btn pj-btn-sm" id="expClear">✕ Clear filters</button>' : "") +
      // The report prints exactly this view: the filter rides along on the link,
      // with the date window already resolved so "This month" can't re-resolve
      // to a different month on the way there.
      '<a class="pj-btn pj-btn-sm" href="' + esc(DCR.exp.hrefWith("report-expenses.html", { id: PID }, f, true)) +
        '" title="Print what you see">🖨 Print</a>' +
      '<button class="pj-btn pj-btn-sm" id="expCsvBtn" title="Download what you see as a spreadsheet">⤓ CSV</button>' +
      '</div>';

    if (!all.length) {
      pane.innerHTML = bar + '<div class="pj-empty">No expense records for this project.</div>';
      wireExpBar();
      return;
    }

    // Filter and sort ONCE, keep the result: the table, the CSV export and the
    // printed report all read this same array, in this same order.
    var rows = DCR.exp.sort(DCR.exp.filter(all, f), f);
    state.expView = rows;
    var t = DCR.exp.totals(rows);
    var spent = t.mat + t.con;
    var filtered = DCR.exp.isActive(f);

    var summary = '<div class="pj-expsum">' +
      '<div><span>Records</span><b>' + rows.length + (rows.length !== all.length ? ' <span class="pj-sub">of ' + all.length + '</span>' : "") + '</b></div>' +
      '<div><span>Materials</span><b>' + fmtMoney(t.mat) + '</b></div>' +
      '<div><span>Contractors</span><b>' + fmtMoney(t.con) + '</b></div>' +
      '<div class="hi"><span>Total spent</span><b>' + fmtMoney(spent) + '</b></div>' +
      '<div><span>Invoiced</span><b>' + fmtMoney(t.inv) + '</b></div>' +
      '<div><span>Estimated</span><b>' + fmtMoney(t.est) + '</b></div>' +
      '</div>';

    if (!rows.length) {
      pane.innerHTML = bar + summary + '<div class="pj-empty">No expenses match these filters.</div>';
      wireExpBar();
      return;
    }

    var body = "";
    // Rows arrive already sorted; grouping only buckets them.
    DCR.exp.group(rows).forEach(function (grp) {
      var g = grp.name, gt = DCR.exp.totals(grp.rows);
      body += '<tr class="pj-grp"><td colspan="' + cols + '">' + esc(g) + ' <span class="pj-sub" style="font-weight:400">· ' + grp.rows.length + ' record' + (grp.rows.length === 1 ? "" : "s") + '</span></td></tr>';
      grp.rows.forEach(function (r) {
        var remark = r.remarks ? '<div class="pj-sub">' + escML(r.remarks) + '</div>' : "";
        body += '<tr' + (canEdit ? ' data-exp-open="' + r.id + '" style="cursor:pointer" title="Double-click to open"' : "") + '>' +
          '<td style="white-space:nowrap">' + fmtDate(r.expenseDate) + '</td>' +
          '<td class="pj-expdesc">' + escML(expDesc(r)) + remark + '</td>' +
          '<td class="num">' + (num(r.estimate) ? fmtMoney(r.estimate) : "") + '</td>' +
          '<td class="num">' + (num(r.invoice) ? fmtMoney(r.invoice) : "") + '</td>' +
          '<td class="num">' + (num(r.materials) ? fmtMoney(r.materials) : "") + '</td>' +
          '<td class="num">' + (num(r.contractors) ? fmtMoney(r.contractors) : "") + '</td>' +
          (canEdit ? '<td><button class="pj-btn pj-btn-sm" data-sub-edit="exp:' + r.id + '" title="Open / edit">✎</button></td>' : "") + '</tr>';
      });
      body += '<tr class="pj-grpTot"><td colspan="2">Subtotal — ' + esc(g) + '</td><td class="num">' + fmtMoney(gt.est) + '</td><td class="num">' + fmtMoney(gt.inv) + '</td><td class="num">' + fmtMoney(gt.mat) + '</td><td class="num">' + fmtMoney(gt.con) + '</td>' + (canEdit ? '<td></td>' : "") + '</tr>';
    });
    body += '<tr class="pj-grand"><td colspan="2">' + (filtered ? "FILTERED TOTAL" : "GRAND TOTAL") + '</td><td class="num">' + fmtMoney(t.est) + '</td><td class="num">' + fmtMoney(t.inv) + '</td><td class="num">' + fmtMoney(t.mat) + '</td><td class="num">' + fmtMoney(t.con) + '</td>' + (canEdit ? '<td></td>' : "") + '</tr>';

    function sortTh(key, label, cls) {
      var on = f.sort === key;
      return '<th' + (cls ? ' class="' + cls + '"' : "") + ' data-exp-sort="' + key + '" style="cursor:pointer" title="Sort">' +
        label + (on ? ' <span class="pj-sortarrow">' + (f.dir > 0 ? "▲" : "▼") + '</span>' : "") + '</th>';
    }
    pane.innerHTML = bar + summary +
      '<div class="pj-tblwrap"><table class="pj-tbl pj-exptbl"><thead><tr>' +
      sortTh("date", "Date") + sortTh("desc", "Description") +
      sortTh("est", "Estimate", "num") + sortTh("inv", "Invoice", "num") +
      sortTh("mat", "Materials", "num") + sortTh("con", "Contractors", "num") +
      (canEdit ? '<th></th>' : "") + '</tr></thead><tbody>' + body + '</tbody></table></div>';

    wireExpBar();
    wireSubButtons(pane);
    if (canEdit) {
      pane.querySelectorAll("[data-exp-open]").forEach(function (tr) {
        tr.ondblclick = function () { openSubModal("exp", tr.getAttribute("data-exp-open")); };
      });
    }
    pane.querySelectorAll("[data-exp-sort]").forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute("data-exp-sort");
        if (f.sort === k) f.dir = -f.dir; else { f.sort = k; f.dir = k === "desc" ? 1 : -1; }
        renderExpenses();
      };
    });
  }

  function wireExpBar() {
    var f = state.expFilter;
    var ab = el("expAddBtn"); if (ab) ab.onclick = function () { openSubModal("exp", null); };
    var g = el("expGroup"); if (g) g.onchange = function () { f.group = this.value; renderExpenses(); };
    var r = el("expRange");
    if (r) r.onchange = function () {
      f.range = this.value;
      if (f.range === "custom" && !f.from && !f.to) {
        // local Y-M-D — toISOString() is UTC and would seed tomorrow's date
        // for a Pacific user after 5pm
        var now = new Date();
        f.from = DCR.exp.ymd(new Date(now.getFullYear(), now.getMonth(), 1));
        f.to = DCR.exp.ymd(now);
      }
      renderExpenses();
    };
    var fr = el("expFrom"); if (fr) fr.onchange = function () { f.from = this.value; renderExpenses(); };
    var to = el("expTo"); if (to) to.onchange = function () { f.to = this.value; renderExpenses(); };
    var s = el("expSearch");
    if (s) {
      s.oninput = function () {
        f.q = this.value;
        clearTimeout(state.expQTimer);
        state.expQTimer = setTimeout(function () {
          renderExpenses();
          var box = el("expSearch");
          if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
        }, 250);
      };
    }
    var c = el("expClear");
    if (c) c.onclick = function () {
      var d = DCR.exp.defaults();   // keep the column they were sorting by
      d.sort = f.sort; d.dir = f.dir;
      state.expFilter = d;
      renderExpenses();
    };
    var csv = el("expCsvBtn");
    if (csv) csv.onclick = function () {
      var rows = state.expView || [];   // exactly the rows on screen
      if (!rows.length) return;
      var blob = new Blob(["﻿" + expCsv(rows)], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "expenses-" + (state.project && state.project.internalIDNumber ? state.project.internalIDNumber : PID) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    };
  }

  /* ── payments (editable) ── */
  async function loadPayments() {
    var pane = el("pane-payments");
    pane.innerHTML = '<div class="pj-empty">Loading payments…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=payments");
      var rows = d.rows||[]; var canEdit = !!d.canEdit;
      state.payRows = rows;
      var cols = canEdit ? 7 : 6;
      var bar = '<div class="pj-bar">' +
        (canEdit?'<button class="pj-btn pj-btn-primary pj-btn-sm" id="payAddBtn">＋ New payment</button>':"") +
        '<span class="pj-sub">'+rows.length+' payment records</span></div>';
      if (!rows.length) {
        pane.innerHTML = bar + '<div class="pj-empty">No payment records for this project.</div>';
        var ab0 = el("payAddBtn"); if (ab0) ab0.onclick = function(){ openSubModal("pay", null); };
        return;
      }
      var t = { est:0, inv:0, exp:0, paid:0 };
      var body = rows.map(function(r){
        var isPaid = r.paymentPAID===true || r.paymentPAID==="true";
        t.est+=num(r.paymentEstimateAmount); t.inv+=num(r.paymentInvoiceAmount); t.exp+=num(r.paymentExpenseAmount);
        if (isPaid) t.paid += num(r.paymentInvoiceAmount);
        var paidChip = canEdit
          ? '<span class="pj-chip'+(isPaid?" on":"")+'" style="'+(isPaid?"background:var(--ok);border-color:var(--ok);":"")+'" data-pay-tgl="'+r.id+'">'+(isPaid?"✓ PAID":"unpaid")+'</span>'
          : (isPaid ? '<b style="color:var(--ok)">✓ PAID</b>' : '<span class="pj-sub">unpaid</span>');
        return '<tr><td>'+esc(r.paymentName||"—")+
          (r.paymentDescription?'<br><span class="pj-sub">'+esc(r.paymentDescription)+'</span>':"")+'</td>' +
          '<td class="num">'+(num(r.paymentEstimateAmount)?fmtMoney(r.paymentEstimateAmount):"")+'</td>' +
          '<td class="num">'+(num(r.paymentInvoiceAmount)?fmtMoney(r.paymentInvoiceAmount):"")+'</td>' +
          '<td class="num">'+(num(r.paymentExpenseAmount)?fmtMoney(r.paymentExpenseAmount):"")+'</td>' +
          '<td>'+paidChip+(r.paymentPaidDate?'<br><span class="pj-sub">'+fmtDate(r.paymentPaidDate)+'</span>':"")+'</td>' +
          '<td>'+esc(r.paymentPaidNotes||"")+'</td>' +
          (canEdit?'<td><div class="pj-rowbtns"><button class="pj-btn pj-btn-sm" data-sub-edit="pay:'+r.id+'">✎</button><button class="pj-btn pj-btn-sm" data-sub-del="pay:'+r.id+'">🗑</button></div></td>':"") + '</tr>';
      }).join("");
      body += '<tr class="pj-grand"><td>TOTALS &nbsp;<span class="pj-sub" style="font-weight:400">collected '+fmtMoney(t.paid)+' · outstanding '+fmtMoney(t.inv-t.paid)+'</span></td>' +
        '<td class="num">'+fmtMoney(t.est)+'</td><td class="num">'+fmtMoney(t.inv)+'</td><td class="num">'+fmtMoney(t.exp)+'</td><td></td><td></td>'+(canEdit?'<td></td>':"")+'</tr>';
      pane.innerHTML = bar +
        '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr><th>Payment</th><th class="num">Estimate</th><th class="num">Invoice</th><th class="num">Expense</th><th>Status</th><th>Notes</th>'+(canEdit?'<th></th>':"")+'</tr></thead><tbody>'+body+'</tbody></table></div>';
      var ab = el("payAddBtn"); if (ab) ab.onclick = function(){ openSubModal("pay", null); };
      wireSubButtons(pane);
      pane.querySelectorAll("[data-pay-tgl]").forEach(function(b){
        b.onclick = async function(){
          var row = rows.find(function(r){ return String(r.id)===b.getAttribute("data-pay-tgl"); });
          var newVal = !(row.paymentPAID===true || row.paymentPAID==="true");
          try {
            await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"payUpdate", itemId:row.id, fields:{ paymentPAID:newVal } } });
            loadPayments();
          } catch (e) { alert(e.message||"Update failed"); }
        };
      });
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  /* ── tasks ── */
  async function loadTasks() {
    var pane = el("pane-tasks");
    pane.innerHTML = '<div class="pj-empty">Loading tasks…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=tasks");
      state.taskRows = d.rows||[]; state.canTask = d.canTask;
      renderTasks();
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  function priDot(p) {
    var l=String(p||"").toLowerCase();
    var c = l.indexOf("urgent")!==-1||l.indexOf("high")!==-1 ? "#d9614f" : (l.indexOf("medium")!==-1||l.indexOf("normal")!==-1 ? "#d6a13a" : "#2fa679");
    return '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:'+c+';margin-right:7px"></span>';
  }

  function renderTasks() {
    var pane = el("pane-tasks");
    var rows = state.taskRows||[];
    var f = state.taskFilter;
    var shown = rows.filter(function(r){
      var done = r.taskCompleteCheck===true || r.taskCompleteCheck==="true";
      return f==="all" || (f==="pending" ? !done : done);
    });
    var chips = ["pending","completed","all"].map(function(c){
      return '<span class="pj-chip'+(state.taskFilter===c?" on":"")+'" data-tf="'+c+'">'+c.charAt(0).toUpperCase()+c.slice(1)+'</span>';
    }).join("");
    var bar = '<div class="pj-bar">'+chips+(state.canTask?'<button class="pj-btn pj-btn-primary pj-btn-sm" id="tkAddBtn" style="margin-left:auto">＋ New task</button>':"")+'</div>';
    var body = shown.map(function(r){
      var done = r.taskCompleteCheck===true || r.taskCompleteCheck==="true";
      return '<tr><td>'+(state.canTask?'<input type="checkbox" data-tk="'+r.id+'"'+(done?" checked":"")+'>':(done?"✅":"⬜"))+'</td>' +
        '<td>'+priDot(r.taskPrioraty)+esc(r.taskName||r.title||"—")+(r.marketingFotageDescription?'<br><span class="pj-sub">'+esc(r.marketingFotageDescription)+'</span>':"")+'</td>' +
        '<td>'+esc(r.marketingFotageCategory||"")+'</td><td>'+esc(r.marketingFotageAssignedPerson||"")+'</td>' +
        '<td>'+fmtDate(r.marketingFotageDateRequested)+'</td></tr>';
    }).join("");
    pane.innerHTML = bar + (shown.length
      ? '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr><th></th><th>Task</th><th>Category</th><th>Assigned</th><th>Requested</th></tr></thead><tbody>'+body+'</tbody></table></div>'
      : '<div class="pj-empty">No '+f+' tasks.</div>');
    pane.querySelectorAll("[data-tf]").forEach(function(c){ c.onclick=function(){ state.taskFilter=c.getAttribute("data-tf"); renderTasks(); }; });
    var add = el("tkAddBtn"); if (add) add.onclick = function(){ el("taskModal").classList.add("open"); el("tkMsg").textContent=""; };
    pane.querySelectorAll("[data-tk]").forEach(function(cb){
      cb.onchange = async function(){
        try {
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"taskToggle", itemId: cb.getAttribute("data-tk"), complete: cb.checked } });
          var row = state.taskRows.find(function(r){ return String(r.id)===cb.getAttribute("data-tk"); });
          if (row) row.taskCompleteCheck = cb.checked;
          renderTasks();
        } catch (e) { alert(e.message||"Update failed"); cb.checked=!cb.checked; }
      };
    });
  }

  async function saveTask() {
    var name = el("tkName").value.trim();
    if (!name) { el("tkMsg").textContent = "Task name is required."; return; }
    el("tkSave").disabled = true;
    try {
      await DCR.api("/api/portal?action=project", { method:"POST", body:{
        op:"taskAdd", projectId: PID, taskName: name,
        priority: el("tkPriority").value, assignedPerson: el("tkAssigned").value.trim(),
        description: el("tkDesc").value.trim(),
      }});
      el("taskModal").classList.remove("open");
      ["tkName","tkAssigned","tkDesc"].forEach(function(i){ el(i).value=""; });
      loadTasks();
    } catch (e) { el("tkMsg").textContent = e.message || "Create failed"; }
    el("tkSave").disabled = false;
  }

  /* ── logs ── */
  async function loadLogs() {
    var pane = el("pane-logs");
    pane.innerHTML = '<div class="pj-empty">Loading logs…</div>';
    try {
      var d = await DCR.api("/api/portal?action=board&logs="+encodeURIComponent(PID));
      var list = (d.logs||[]).map(function(l){
        return '<div class="pj-log"><div class="pj-log-date">'+fmtDate(l.logDate)+'</div>' +
          '<div class="pj-log-text">'+esc(l.logDescription||"")+'</div>' +
          (l.logUserName?'<div class="pj-log-user">— '+esc(l.logUserName)+'</div>':"")+'</div>';
      }).join("") || '<div class="pj-empty">No log entries yet.</div>';
      var add = d.canLog
        ? '<div class="pj-sec"><h3>Add log entry</h3><textarea id="lgText" class="pj-f" style="width:100%;box-sizing:border-box;min-height:64px;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)"></textarea>' +
          '<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="pj-btn pj-btn-primary pj-btn-sm" id="lgSave">✓ Save entry</button><span class="pj-msg" id="lgMsg"></span></div></div>'
        : "";
      pane.innerHTML = add + list;
      var b = el("lgSave");
      if (b) b.onclick = async function(){
        var t = el("lgText").value.trim();
        if (!t) { el("lgMsg").textContent="Write something first."; el("lgMsg").className="pj-msg err"; return; }
        b.disabled = true;
        try {
          await DCR.api("/api/portal?action=board", { method:"POST", body:{ op:"log", projectId: PID, text: t } });
          delete state.parts.logs; loadTab("logs");
        } catch (e) { el("lgMsg").textContent=e.message; el("lgMsg").className="pj-msg err"; b.disabled=false; }
      };
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  /* ── mailing ── */
  function mailto(subject, bodyText) {
    var p = state.project;
    return "mailto:" + encodeURIComponent(p.projectEmailAddress||"") +
      "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(bodyText);
  }

  function renderMailing() {
    var p = state.project;
    var full = (p.internalIDNumber?p.internalIDNumber+" — ":"") + (p.projectName||"");
    var addr = [p.projectAddress,p.projectCity].filter(Boolean).join(", ");
    var quote = mailto("Estimate — "+full, "Hello "+(p.projectClientName||"")+",\n\nPlease find attached our estimate for "+(p.projectName||"the project")+" at "+addr+".\n\nLet us know if you have any questions.\n\nBest regards,\nDCR Framing");
    var follow = mailto("Following up — "+full, "Hello "+(p.projectClientName||"")+",\n\nJust following up on the estimate we sent for "+(p.projectName||"the project")+" at "+addr+". We'd be happy to answer any questions.\n\nBest regards,\nDCR Framing");
    var blank = mailto(full, "");
    el("pane-mailing").innerHTML =
      '<div class="pj-sec"><h3>Client</h3><div style="font-size:14px;color:var(--text)">' +
        '<b>'+esc(p.projectClientName||"—")+'</b><br>' +
        (p.projectEmailAddress?'<a href="mailto:'+esc(p.projectEmailAddress)+'" style="color:var(--acc)">'+esc(p.projectEmailAddress)+'</a><br>':"") +
        esc(p.projectPhoneNumber||"")+'</div>' +
        '<div class="pj-links" style="margin-top:10px">' +
        '<a class="pj-btn pj-btn-sm" href="'+quote+'">✉️ Quote email</a>' +
        '<a class="pj-btn pj-btn-sm" href="'+follow+'">✉️ Follow-up email</a>' +
        '<a class="pj-btn pj-btn-sm" href="'+blank+'">✉️ Blank email</a></div></div>' +
      '<div class="pj-sec"><h3>Email notes</h3>' +
        '<textarea id="mailNotes" data-key="projectEMailNotes" '+(state.canWrite?"":"disabled ")+'style="width:100%;box-sizing:border-box;min-height:90px;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)">'+esc(p.projectEMailNotes||"")+'</textarea>' +
        (state.canWrite?'<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><span class="dcr-live" id="mailMsg"></span></div>':"")+'</div>' +
      '<div class="pj-sec"><h3>Find a contact</h3><input class="pj-search" id="ctSearch" placeholder="Search contacts…"><div id="ctResults" style="margin-top:10px"></div></div>';

    // same record saver as the Overview form — these notes used to be lost
    // entirely if you navigated away without pressing Save
    if (state.canWrite) {
      projectSaver().baseline({ projectEMailNotes: p.projectEMailNotes })
        .bind(el("pane-mailing"));
      DCR.live.record({ key: "project:" + PID, status: "mailMsg" });
    }

    var contacts = null;
    el("ctSearch").addEventListener("input", async function(){
      var q = this.value.trim().toLowerCase();
      if (q.length < 2) { el("ctResults").innerHTML=""; return; }
      if (!contacts) {
        el("ctResults").innerHTML = '<span class="pj-sub">Loading contacts…</span>';
        try { contacts = (await DCR.api("/api/portal?action=data&list=contacts&top=999")).value || []; }
        catch (e) { el("ctResults").innerHTML = '<span class="pj-sub">'+esc(e.message)+'</span>'; return; }
      }
      var f = contacts.filter(function(c){
        return [c.contactName,c.contactCompany,c.contactEMail,c.contactTrade].join(" ").toLowerCase().indexOf(q)!==-1;
      }).slice(0,12);
      el("ctResults").innerHTML = f.length ? '<div class="pj-tblwrap"><table class="pj-tbl"><tbody>' + f.map(function(c){
        return '<tr><td><b>'+esc(c.contactName||"")+'</b><br><span class="pj-sub">'+esc(c.contactCompany||"")+' '+esc(c.contactTrade||"")+'</span></td>' +
          '<td>'+(c.contactEMail?'<a style="color:var(--acc)" href="mailto:'+esc(c.contactEMail)+'">'+esc(c.contactEMail)+'</a>':"")+'<br><span class="pj-sub">'+esc(c.contactPhone||"")+'</span></td></tr>';
      }).join("") + '</tbody></table></div>' : '<span class="pj-sub">No matches.</span>';
    });
  }

  /* ── files ── */
  async function loadFiles(folderId) {
    var pane = el("pane-files");
    if (!state.driveReady) { pane.innerHTML = '<div class="pj-empty">Google Drive is not connected.</div>'; return; }
    pane.innerHTML = '<div class="pj-empty">Loading files…</div>';
    try {
      var d;
      if (folderId) d = await DCR.api("/api/portal?action=drive&folderId="+encodeURIComponent(folderId));
      else {
        d = await DCR.api("/api/portal?action=drive&projectId="+encodeURIComponent(PID));
        state.files.stack = [{ id: d.folderId, name: "Project folder", url: d.folderUrl || "" }];
      }
      renderFiles(d.items||[]);
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  function fmtSize(n){ if(!n)return""; if(n>1048576)return (n/1048576).toFixed(1)+" MB"; if(n>1024)return Math.round(n/1024)+" KB"; return n+" B"; }
  function fileIcon(f){ if(f.isFolder)return "📁"; var m=f.mimeType||""; if(m.indexOf("image")===0)return "🖼️"; if(m.indexOf("pdf")!==-1)return "📕"; if(m.indexOf("sheet")!==-1||m.indexOf("excel")!==-1)return "📊"; if(m.indexOf("video")===0)return "🎬"; return "📄"; }

  function renderFiles(items) {
    var pane = el("pane-files");
    var crumbs = state.files.stack.map(function(s,i){
      return i===state.files.stack.length-1 ? '<b>'+esc(s.name)+'</b>' : '<a data-crumb="'+i+'">'+esc(s.name)+'</a>';
    }).join(' <span style="color:var(--text-muted)">/</span> ');
    var top = state.files.stack[state.files.stack.length-1];
    var rows = items.map(function(f){
      return '<div class="pj-file" data-fid="'+esc(f.id)+'" data-folder="'+(f.isFolder?1:0)+'" data-name="'+esc(f.name)+'" data-link="'+esc(f.webViewLink||"")+'">' +
        '<span>'+fileIcon(f)+'</span><span>'+esc(f.name)+'</span>' +
        '<span class="meta">'+fmtSize(f.size)+(f.modifiedTime?' · '+fmtDate(f.modifiedTime):"")+'</span></div>';
    }).join("") || '<div class="pj-empty">Empty folder.</div>';
    pane.innerHTML = capBarHtml() + '<div class="pj-crumb">'+crumbs+
      (top.url ? '<a class="pj-btn pj-btn-sm" style="margin-left:auto" target="_blank" href="'+esc(top.url)+'">Open in SharePoint ↗</a>' : "")+'</div>' +
      '<div class="pj-tblwrap">'+rows+'</div>';
    wireCapBar();
    pane.querySelectorAll("[data-crumb]").forEach(function(a){
      a.onclick = function(){
        var i = Number(a.getAttribute("data-crumb"));
        state.files.stack = state.files.stack.slice(0, i+1);
        loadFiles(state.files.stack[i].id);
      };
    });
    pane.querySelectorAll(".pj-file").forEach(function(row){
      row.onclick = function(){
        if (row.getAttribute("data-folder")==="1") {
          state.files.stack.push({ id: row.getAttribute("data-fid"), name: row.getAttribute("data-name"), url: row.getAttribute("data-link") || "" });
          loadFiles(row.getAttribute("data-fid"));
        } else openFile(row.getAttribute("data-fid"), row.getAttribute("data-link"));
      };
    });
  }

  async function openFile(fileId, webViewLink) {
    msg("", "Opening file…");
    try {
      var r = await fetch(DCR.API_BASE + "/api/portal?action=drive&fileId="+encodeURIComponent(fileId)+"&download=1",
        { headers:{ Authorization:"Bearer "+DCR.getToken() } });
      if (r.status === 413) {
        var d = await r.json();
        msg("", "");
        if (d.webViewLink || webViewLink) window.open(d.webViewLink || webViewLink, "_blank");
        else alert("File is too large to preview and has no Drive link.");
        return;
      }
      if (!r.ok) throw new Error("Could not open file");
      var url = URL.createObjectURL(await r.blob());
      window.open(url, "_blank");
      msg("", "");
    } catch (e) {
      msg("err", e.message||"Open failed");
      if (webViewLink) window.open(webViewLink, "_blank");
    }
  }

  /* ══ Site documentation capture (photos w/ markup, video, voice, notes → Drive) ══
     Upload path: portal mints a Drive resumable-session URL; the browser PUTs the
     bytes DIRECTLY to Google (no serverless body limit; session URL is
     self-authorizing). Photos/videos → Pictures; audio/transcripts/notes → Site Notes. */

  function capBarHtml() {
    if (!state.driveReady) return "";
    return '<div class="cap-bar"><span class="cap-title">📸 Site documentation</span>' +
      '<button class="pj-btn pj-btn-sm" id="capPhoto">📷 Photo</button>' +
      '<button class="pj-btn pj-btn-sm" id="capVideo">🎬 Video</button>' +
      '<button class="pj-btn pj-btn-sm" id="capVoice">🎙 Voice note</button>' +
      '<button class="pj-btn pj-btn-sm" id="capNote">📝 Note</button>' +
      '<span class="cap-prog" id="capProgEl"></span></div>';
  }
  function wireCapBar() {
    var b;
    b = el("capPhoto"); if (b) b.onclick = function(){ el("capPhotoInput").value=""; el("capPhotoInput").click(); };
    b = el("capVideo"); if (b) b.onclick = function(){ el("capVideoInput").value=""; el("capVideoInput").click(); };
    b = el("capVoice"); if (b) b.onclick = recOpen;
    b = el("capNote"); if (b) b.onclick = function(){ el("noteTitle").value=""; el("noteBody").value=""; el("noteMsg").textContent=""; el("noteModal").classList.add("open"); el("noteBody").focus(); };
  }
  function capProg(txt) { var p = el("capProgEl"); if (p) p.textContent = txt; }
  function capStamp() {
    var d = new Date(), p2 = function(n){ return String(n).padStart(2,"0"); };
    return d.getFullYear()+"-"+p2(d.getMonth()+1)+"-"+p2(d.getDate())+" "+p2(d.getHours())+"."+p2(d.getMinutes())+"."+p2(d.getSeconds());
  }

  // SharePoint upload sessions require chunked PUTs in 320KiB multiples.
  async function uploadToDrive(blob, target, name, mime) {
    if (!blob.size) throw new Error("Nothing to upload (empty file).");
    // Photos/videos are filed by company week (Sat–Fri), same as the Site Photos
    // screen; notes stay flat in "Site Notes".
    var s = await DCR.api("/api/portal?action=drive", { method:"POST",
      body:{ op:"uploadSession", projectId: PID, target: target, name: name, mimeType: mime,
             weekFolder: target === "notes" ? "" : DCR.weekFolder() } });
    var CHUNK = 320 * 1024 * 24; // 7.5 MiB, 320KiB-aligned
    var pos = 0, total = blob.size;
    while (pos < total) {
      var end = Math.min(pos + CHUNK, total);
      await new Promise(function(resolve, reject){
        var x = new XMLHttpRequest();
        x.open("PUT", s.uploadUrl);
        x.setRequestHeader("Content-Range", "bytes "+pos+"-"+(end-1)+"/"+total);
        var base = pos;
        x.upload.onprogress = function(e){ if (e.lengthComputable) capProg("Uploading "+name+" — "+Math.round((base+e.loaded)/total*100)+"%"); };
        x.onload = function(){ if (x.status===200 || x.status===201 || x.status===202) resolve(); else reject(new Error("Upload failed ("+x.status+")")); };
        x.onerror = function(){ reject(new Error("Upload failed — check your connection.")); };
        x.send(blob.slice(pos, end));
      });
      pos = end;
    }
    capProg("✓ Saved "+name);
    setTimeout(function(){ capProg(""); }, 4000);
  }

  /* ── photo annotator (pen / highlighter / arrow / text) ── */
  var an = { queue: [], img: null, ops: [], cur: null, tool: "pen", color: "#e53935", width: 6, origFile: null };
  var AN_COLORS = ["#e53935","#fdd835","#2f80d8","#2fa679","#ffffff","#111111"];

  function anNext() {
    if (!an.queue.length) { el("anModal").classList.remove("open"); loadFiles(); return; }
    var f = an.queue.shift();
    an.origFile = f; an.ops = []; an.cur = null;
    el("anQueue").textContent = an.queue.length ? (an.queue.length+" more queued") : "";
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function(){
      URL.revokeObjectURL(url);
      an.img = img;
      var c = el("anCanvas");
      var MAX = 2200; // cap canvas size — keeps annotated JPEGs a sane size
      var sc = Math.min(1, MAX/Math.max(img.naturalWidth||1, img.naturalHeight||1));
      c.width = Math.round((img.naturalWidth||800)*sc);
      c.height = Math.round((img.naturalHeight||600)*sc);
      anRender();
      el("anModal").classList.add("open");
    };
    img.onerror = function(){ alert("Could not read that image."); anNext(); };
    img.src = url;
  }

  function anRender() {
    var c = el("anCanvas"), ctx = c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height);
    ctx.drawImage(an.img, 0, 0, c.width, c.height);
    an.ops.concat(an.cur?[an.cur]:[]).forEach(function(op){ anDraw(ctx, op, c); });
  }

  function anDraw(ctx, op, c) {
    ctx.save();
    if (op.tool==="pen" || op.tool==="hl") {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.tool==="hl" ? op.width*4 : op.width;
      ctx.globalAlpha = op.tool==="hl" ? 0.35 : 1;
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      op.pts.forEach(function(p,i){ i?ctx.lineTo(p[0],p[1]):ctx.moveTo(p[0],p[1]); });
      ctx.stroke();
    } else if (op.tool==="arrow") {
      ctx.strokeStyle = op.color; ctx.fillStyle = op.color; ctx.lineWidth = op.width; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(op.x1,op.y1); ctx.lineTo(op.x2,op.y2); ctx.stroke();
      var ang = Math.atan2(op.y2-op.y1, op.x2-op.x1), hl = Math.max(16, op.width*4);
      ctx.beginPath();
      ctx.moveTo(op.x2,op.y2);
      ctx.lineTo(op.x2-hl*Math.cos(ang-0.45), op.y2-hl*Math.sin(ang-0.45));
      ctx.lineTo(op.x2-hl*Math.cos(ang+0.45), op.y2-hl*Math.sin(ang+0.45));
      ctx.closePath(); ctx.fill();
    } else if (op.tool==="text") {
      var size = Math.max(22, Math.round(c.width*0.03));
      ctx.font = "bold "+size+"px Arial";
      ctx.strokeStyle = "rgba(0,0,0,.7)"; ctx.lineWidth = Math.max(2, size/8);
      ctx.fillStyle = op.color;
      ctx.strokeText(op.text, op.x, op.y);
      ctx.fillText(op.text, op.x, op.y);
    }
    ctx.restore();
  }

  function anPos(e) {
    var c = el("anCanvas"), r = c.getBoundingClientRect();
    return [ (e.clientX-r.left)*(c.width/r.width), (e.clientY-r.top)*(c.height/r.height) ];
  }

  /* ── voice notes w/ live browser transcription ──
     Flow: Start → live transcript (finals + the in-flight interim tail) →
     Stop → REVIEW (transcript becomes editable so the user can fix it) →
     Save uploads the audio + the reviewed transcript as a .txt, both into the
     project's Site Notes folder. The interim tail is captured at stop time —
     losing it was why short notes used to save empty/truncated transcripts. */
  var rec = { mr: null, chunks: [], stream: null, timer: null, t0: 0, sr: null, tx: "", interim: "", phase: "idle", blob: null, mime: "" };

  function recOpen() {
    rec.tx = ""; rec.interim = ""; rec.phase = "idle"; rec.blob = null;
    var supported = window.SpeechRecognition || window.webkitSpeechRecognition;
    var ta = el("recTranscript");
    ta.value = ""; ta.readOnly = true;
    el("recHint").textContent = supported
      ? "" : "Live transcription isn't supported on this device — the audio still saves; you can type the transcript after stopping.";
    el("recTimer").textContent = "0:00";
    el("recState").textContent = "Ready to record";
    el("recMsg").textContent = "";
    el("recBtn").textContent = "● Start recording";
    el("recBtn").disabled = false;
    el("recModal").classList.add("open");
  }

  async function recToggle() {
    if (rec.phase === "review") { recSave(); return; }
    if (rec.phase === "rec") {
      // Stop → review. Capture the interim tail BEFORE tearing recognition down.
      clearInterval(rec.timer);
      if (rec.sr) { try { rec.sr.onend = null; rec.sr.stop(); } catch(e){} }
      var full = (rec.tx + " " + rec.interim).replace(/\s+/g, " ").trim();
      var ta = el("recTranscript");
      ta.value = full;
      ta.readOnly = false;
      ta.placeholder = "No transcript was captured — you can type one here before saving.";
      el("recState").textContent = "Review — check the transcript, then Save";
      el("recHint").textContent = "The transcript below is editable. It saves as a .txt next to the audio in Site Notes.";
      el("recBtn").textContent = "⬆ Save to Drive";
      rec.phase = "review";
      try { rec.mr.stop(); } catch(e){} // assembles rec.blob in onstop
      return;
    }
    // idle → start recording.
    // ORDER MATTERS on Android: the speech engine and MediaRecorder compete for
    // the microphone, and whoever starts second can silently lose. Start the
    // speech recognizer FIRST so it holds its audio path, then attach the
    // recorder — this yields live transcripts on many Android devices that got
    // none with the reverse order. (Desktop browsers share the mic either way.)
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      rec.sr = new SR();
      rec.sr.continuous = true; rec.sr.interimResults = true;
      rec.sr.lang = navigator.language || "en-US";
      rec.sr.onresult = function(ev){
        var interim = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) rec.tx += ev.results[i][0].transcript + " ";
          else interim += ev.results[i][0].transcript;
        }
        rec.interim = interim;
        el("recTranscript").value = (rec.tx + " " + interim).replace(/\s+/g, " ").trim();
      };
      rec.sr.onerror = function(ev){
        if (rec.phase !== "rec" && rec.phase !== "idle") return;
        if (ev.error === "audio-capture" || ev.error === "not-allowed" || ev.error === "service-not-allowed") {
          el("recHint").textContent = "Live transcription isn't available on this device (" + ev.error + ") — the audio still records; you can type the transcript after stopping.";
        }
      };
      rec.sr.onend = function(){ if (rec.phase === "rec") { try { rec.sr.start(); } catch(e){} } };
      try { rec.sr.start(); } catch(e) {}
      // brief head start for the recognizer before the recorder grabs the mic
      await new Promise(function(r){ setTimeout(r, 350); });
    }
    try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) {
      if (rec.sr) { try { rec.sr.onend = null; rec.sr.stop(); } catch(x){} }
      el("recMsg").textContent = "Microphone access was denied.";
      return;
    }
    var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) ? "audio/webm;codecs=opus"
      : ((window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/mp4")) ? "audio/mp4" : "");
    rec.chunks = []; rec.blob = null; rec.mime = mime || "audio/webm";
    rec.mr = mime ? new MediaRecorder(rec.stream, { mimeType: mime }) : new MediaRecorder(rec.stream);
    rec.mr.ondataavailable = function(e){ if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.mr.onstop = function(){
      if (rec.stream) rec.stream.getTracks().forEach(function(t){ t.stop(); });
      rec.blob = new Blob(rec.chunks, { type: (rec.mr && rec.mr.mimeType) || rec.mime });
    };
    rec.mr.start();
    rec.phase = "rec";
    rec.t0 = Date.now();
    rec.timer = setInterval(function(){
      var s = Math.floor((Date.now()-rec.t0)/1000);
      el("recTimer").textContent = Math.floor(s/60)+":"+String(s%60).padStart(2,"0");
    }, 500);
    el("recState").textContent = "Recording…";
    el("recBtn").textContent = "■ Stop";
  }

  async function recSave() {
    // MediaRecorder.onstop is async — wait briefly for the blob if needed.
    for (var w = 0; w < 20 && !rec.blob; w++) await new Promise(function(r){ setTimeout(r, 100); });
    if (!rec.blob || !rec.blob.size) { el("recMsg").textContent = "No audio was captured."; return; }
    var type = rec.blob.type || rec.mime;
    var ext = type.indexOf("mp4") !== -1 ? "m4a" : "webm";
    var base = "AUD " + capStamp();
    el("recBtn").disabled = true;
    el("recState").textContent = "Saving…";
    try {
      await uploadToDrive(rec.blob, "notes", base+"."+ext, type);
      var txt = el("recTranscript").value.trim();
      if (txt && el("recSaveTx").checked) {
        await uploadToDrive(new Blob(["Voice note transcript — "+base+"\n\n"+txt], { type: "text/plain" }),
          "notes", base+" - transcript.txt", "text/plain");
        capProg("✓ Saved audio + transcript to Site Notes");
      }
      rec.phase = "idle";
      el("recModal").classList.remove("open");
      loadFiles();
    } catch (e) {
      el("recMsg").textContent = e.message || "Upload failed";
      el("recBtn").disabled = false;
      el("recBtn").textContent = "⬆ Save to Drive";
      el("recState").textContent = "Review — check the transcript, then Save";
    }
  }

  /* ── text notes ── */
  async function noteSave() {
    var body = el("noteBody").value.trim();
    if (!body) { el("noteMsg").textContent = "Write something first."; return; }
    var title = el("noteTitle").value.trim();
    var name = "NOTE "+capStamp()+(title ? " - "+title : "")+".txt";
    el("noteSave").disabled = true;
    try {
      var content = (title ? title+"\n" : "") + new Date().toLocaleString("en-US") + "\n\n" + body;
      await uploadToDrive(new Blob([content], { type: "text/plain" }), "notes", name, "text/plain");
      el("noteModal").classList.remove("open");
      loadFiles();
    } catch (e) { el("noteMsg").textContent = e.message || "Upload failed"; }
    el("noteSave").disabled = false;
  }

  /* ── project switcher (search by ID, name, client, address, phone, email) ── */
  function projLabel(p) {
    return [
      (p.internalIDNumber || "") + " — " + (p.projectName || ""),
      p.projectClientName,
      [p.projectAddress, p.projectCity].filter(Boolean).join(", "),
      p.projectPhoneNumber,
      p.projectEmailAddress,
    ].filter(Boolean).join(" · ");
  }
  async function loadSwitcher() {
    try {
      var d = await DCR.api("/api/portal?action=board");
      state.boardList = d.projects || [];
      // Each option's value carries all searchable fields, so the datalist
      // surfaces a project whether you type its ID, client, address, phone…
      el("pjJumpList").innerHTML = state.boardList.map(function(p){
        return '<option value="'+esc(projLabel(p))+'"></option>';
      }).join("");
    } catch (e) { /* non-fatal */ }
    var jump = function(){
      var v = el("pjJump").value.trim().toLowerCase();
      if (!v) return;
      var hit = state.boardList.find(function(p){ return projLabel(p).toLowerCase() === v; })
        || state.boardList.find(function(p){ return String(p.internalIDNumber||"").toLowerCase() === v; })
        || state.boardList.find(function(p){ return projLabel(p).toLowerCase().indexOf(v) !== -1; });
      if (hit) location.href = "project.html?id=" + encodeURIComponent(hit.id);
    };
    el("pjJump").addEventListener("change", jump);
    el("pjJump").addEventListener("keydown", function(e){ if (e.key === "Enter") jump(); });
  }

  /* ── init ── */
  document.addEventListener("DOMContentLoaded", async function () {
    state.profile = await DCR.requireAuth();
    // expense-filter.js carries the money/date helpers this whole page uses —
    // fail loudly rather than throwing on every tab.
    if (!DCR.exp) {
      el("pjTitle").textContent = "Page failed to load — please refresh";
      el("pane-overview").innerHTML = '<div class="pj-empty">A required script (expense-filter.js) did not load.</div>';
      return;
    }
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (state.profile.displayName || state.profile.email) + " · " + state.profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    if (!PID) { el("pjTitle").textContent = "No project selected"; el("pane-overview").innerHTML='<div class="pj-empty">Open a project from the <a href="board.html" style="color:var(--acc)">Board</a>.</div>'; return; }

    document.querySelectorAll(".pj-tab").forEach(function(t){ t.onclick = function(){ switchTab(t.getAttribute("data-tab")); }; });
    // The page saves itself; this is a "flush now" affordance for anyone who
    // still reaches for Save, and doubles as the manual retry after a failure.
    el("pjSave").onclick = function () { DCR.live.flushAll(); };
    DCR.live.mountBadge("pjMsg");
    var pmBtn = el("pjPmBtn");
    if (pmBtn) pmBtn.href = "pm.html?id=" + encodeURIComponent(PID);
    el("tkCancel").onclick = function(){ el("taskModal").classList.remove("open"); };
    el("tkSave").onclick = saveTask;
    el("subCancel").onclick = function(){ el("subModal").classList.remove("open"); };
    el("subSave").onclick = saveSubModal;
    el("subDelete").onclick = deleteSubModal;
    el("toMcCancel").onclick = function(){ DCR.takeoff._closeMc(); };
    el("toDtCancel").onclick = function(){ DCR.takeoff._closeDetail(); };
    el("toDtSave").onclick = function(){ DCR.takeoff._saveDetail(); };
    el("toTkCancel").onclick = function(){ DCR.takeoff._closeTk(); };
    el("toTkGo").onclick = function(){ DCR.takeoff._saveTk(); };
    el("toPpCancel").onclick = function(){ DCR.takeoff._closePp(); };
    el("toCatCancel").onclick = function(){ DCR.takeoff._closeCat(); };
    [el("taskModal"), el("subModal")].forEach(function(m){ m.addEventListener("click", function(e){ if(e.target===m) m.classList.remove("open"); }); });

    // item editor wiring (no backdrop-close: large form, avoid accidental loss)
    el("ieExit").onclick = function(){ el("ieModal").classList.remove("open"); };
    el("ieSave").onclick = ieSave;
    el("ieDelete").onclick = function(){ if (state.ie && state.ie.id) delEstRow(state.ie.id); };
    el("ieLogAdd").onclick = function(){
      var note = el("ieLogNote").value.trim(); if (!note) return;
      state.ie.log = new Date().toLocaleDateString("en-US") + " - " + note + (state.ie.log ? "\n" + state.ie.log : "");
      el("ieLogView").textContent = state.ie.log;
      el("ieLogNote").value = "";
    };
    el("ieQuoteBtn").onclick = function(){ ieMailto("quote"); };
    el("ieFollowBtn").onclick = function(){ ieMailto("follow"); };
    el("ieContactSearch").addEventListener("input", function(){ ieContactLookup(this.value.trim()); });
    document.querySelectorAll(".ie-tab").forEach(function(t){
      t.onclick = function(){
        state.ie.subTab = t.getAttribute("data-ietab");
        document.querySelectorAll(".ie-tab").forEach(function(x){ x.classList.toggle("active", x===t); });
        renderIeSub();
      };
    });
    document.querySelectorAll("[data-step]").forEach(function(b){
      b.onclick = function(){
        var p = b.getAttribute("data-step").split(":");
        var inp = el(p[0]);
        inp.value = Math.max(0, num(inp.value) + Number(p[1]));
        ieRecalc();
      };
    });
    ["ie_lArea","ie_lRate","ie_lGuys","ie_lDays","ie_lQty","ie_lPrice","ie_lMk","ie_mQty","ie_mPrice","ie_mMk","ie_mArea"].forEach(function(id){
      el(id).addEventListener("input", ieRecalc);
      el(id).addEventListener("change", ieRecalc);
    });

    // site documentation capture wiring
    el("capPhotoInput").addEventListener("change", function(){
      an.queue = Array.prototype.slice.call(this.files || []);
      if (an.queue.length) anNext();
    });
    el("capVideoInput").addEventListener("change", async function(){
      var f = this.files && this.files[0]; if (!f) return;
      var ext = (f.name.split(".").pop() || "mp4").toLowerCase();
      try { await uploadToDrive(f, "pictures", "VID "+capStamp()+"."+ext, f.type || "video/mp4"); loadFiles(); }
      catch (e) { alert(e.message || "Upload failed"); capProg(""); }
    });
    document.querySelectorAll("[data-antool]").forEach(function(b){
      b.onclick = function(){
        an.tool = b.getAttribute("data-antool");
        document.querySelectorAll("[data-antool]").forEach(function(x){ x.classList.toggle("active", x===b); });
      };
    });
    el("anColors").innerHTML = AN_COLORS.map(function(c,i){
      return '<span class="an-color'+(i===0?" active":"")+'" data-ancolor="'+c+'" style="background:'+c+'"></span>';
    }).join("");
    document.querySelectorAll("[data-ancolor]").forEach(function(s){
      s.onclick = function(){
        an.color = s.getAttribute("data-ancolor");
        document.querySelectorAll("[data-ancolor]").forEach(function(x){ x.classList.toggle("active", x===s); });
      };
    });
    el("anWidth").onchange = function(){ an.width = Number(this.value)||6; };
    el("anUndo").onclick = function(){ an.ops.pop(); anRender(); };
    el("anClear").onclick = function(){ an.ops = []; an.cur = null; anRender(); };
    el("anCancel").onclick = function(){ an.queue = []; el("anModal").classList.remove("open"); };
    el("anSave").onclick = function(){
      el("anSave").disabled = true;
      el("anCanvas").toBlob(async function(blob){
        try { await uploadToDrive(blob, "pictures", "IMG "+capStamp()+".jpg", "image/jpeg"); }
        catch (e) { alert(e.message || "Upload failed"); }
        el("anSave").disabled = false;
        anNext();
      }, "image/jpeg", 0.9);
    };
    el("anOrig").onclick = async function(){
      var f = an.origFile; if (!f) return;
      var ext = (f.name.split(".").pop() || "jpg").toLowerCase();
      el("anOrig").disabled = true;
      try { await uploadToDrive(f, "pictures", "IMG "+capStamp()+"."+ext, f.type || "image/jpeg"); }
      catch (e) { alert(e.message || "Upload failed"); }
      el("anOrig").disabled = false;
      anNext();
    };
    var cv = el("anCanvas");
    cv.addEventListener("pointerdown", function(e){
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch(ex){}
      var p = anPos(e);
      if (an.tool === "text") {
        var t = prompt("Text:");
        if (t) { an.ops.push({ tool:"text", x:p[0], y:p[1], text:t, color:an.color }); anRender(); }
        return;
      }
      if (an.tool === "arrow") an.cur = { tool:"arrow", x1:p[0], y1:p[1], x2:p[0], y2:p[1], color:an.color, width:an.width };
      else an.cur = { tool:an.tool, pts:[p], color:an.color, width:an.width };
    });
    cv.addEventListener("pointermove", function(e){
      if (!an.cur) return;
      e.preventDefault();
      var p = anPos(e);
      if (an.cur.tool === "arrow") { an.cur.x2 = p[0]; an.cur.y2 = p[1]; }
      else an.cur.pts.push(p);
      anRender();
    });
    cv.addEventListener("pointerup", function(){ if (an.cur) { an.ops.push(an.cur); an.cur = null; anRender(); } });
    el("recBtn").onclick = recToggle;
    el("recCancel").onclick = function(){
      clearInterval(rec.timer);
      if (rec.sr) { try { rec.sr.onend = null; rec.sr.stop(); } catch(e){} }
      if (rec.mr && rec.mr.state === "recording") { rec.mr.onstop = null; try { rec.mr.stop(); } catch(e){} }
      if (rec.stream) rec.stream.getTracks().forEach(function(t){ t.stop(); });
      rec.mr = null; rec.blob = null; rec.phase = "idle";
      el("recModal").classList.remove("open");
    };
    el("noteSave").onclick = noteSave;
    el("noteCancel").onclick = function(){ el("noteModal").classList.remove("open"); };
    // (the unsaved-work guard now lives in common.js and covers every record)

    // Restore the Expenses filter: the URL wins (a shared link, or ← Back from
    // the printed report), then this tab's last session (a plain reload), then
    // the defaults. Never let a bad value here break the page.
    try {
      var savedF = DCR.exp.fromQuery(qs) || DCR.exp.load(PID);
      if (savedF) state.expFilter = savedF;
    } catch (e) {}

    try { await loadRecord(); } catch (e) { el("pjTitle").textContent = "Error"; el("pane-overview").innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; return; }
    // Deep-link support (e.g. search results): project.html?id=N&tab=estimate
    var wantTab = qs.get("tab");
    if (wantTab && document.querySelector('.pj-tab[data-tab="'+wantTab+'"]')) switchTab(wantTab);
    loadSwitcher();
  });
})();
