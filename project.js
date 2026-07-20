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

  function fmtMoney(n){ return "$" + (Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function num(v){ if(typeof v==="number")return v; var n=parseFloat(String(v??"").replace(/[$,]/g,"")); return isFinite(n)?n:0; }
  function fmtDate(v){ if(!v)return "—"; var d=new Date(v); return isNaN(d)?String(v):d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function dateInputVal(v){ if(!v)return ""; var d=new Date(v); if(isNaN(d))return ""; return d.toISOString().slice(0,10); }

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

  function msg(kind, text) {
    var m = el("pjMsg"); m.textContent = text; m.className = "pj-msg " + (kind||"");
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

  function parseTags(raw) {
    return String(raw||"").split(",").map(function(s){ return s.trim().replace(/^#/,""); }).filter(Boolean);
  }

  function renderOverview() {
    var p = state.project;
    state.originals = {}; state.dirty = {};
    [SEC_PROJECT,SEC_CLIENT,SEC_LINKS,SEC_NOTES,SEC_CHECK].forEach(function(sec){
      sec.forEach(function(d){ state.originals[d[0]] = p[d[0]]; });
    });
    SEC_BOOLS.forEach(function(d){ state.originals[d[0]] = p[d[0]]; });
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

    el("pane-overview").querySelectorAll("[data-key]").forEach(function(inp){
      inp.addEventListener(inp.type==="checkbox"?"change":"input", function(){ markDirty(inp); });
    });
    el("pjTagWrap").querySelectorAll(".pj-tag").forEach(function(tg){
      if (!state.canWrite) return;
      tg.addEventListener("click", function(){
        tg.classList.toggle("on");
        var on = Array.prototype.filter.call(el("pjTagWrap").querySelectorAll(".pj-tag.on"), function(x){return true;})
          .map(function(x){ return "#"+x.getAttribute("data-tag"); });
        var all = on.concat(extra.map(function(e){ return "#"+e; }));
        state.dirty.checkTagNames = all.join(", ");
        el("pjSave").disabled = false;
      });
    });
  }

  function markDirty(inp) {
    var key = inp.getAttribute("data-key"), type = inp.getAttribute("data-type");
    var orig = state.originals[key];
    var val;
    if (type==="bool") val = inp.checked;
    else if (type==="num") val = inp.value==="" ? null : Number(inp.value);
    else if (type==="date") val = inp.value ? inp.value + "T12:00:00Z" : null;
    else val = inp.value;
    var origCmp = type==="date" ? dateInputVal(orig) : (orig==null?"":orig);
    var valCmp = type==="date" ? (inp.value||"") : (val==null?"":val);
    if (String(valCmp) === String(origCmp)) delete state.dirty[key];
    else state.dirty[key] = val;
    el("pjSave").disabled = Object.keys(state.dirty).length === 0;
  }

  async function saveOverview() {
    var keys = Object.keys(state.dirty);
    if (!keys.length) return;
    el("pjSave").disabled = true; msg("", "Saving…");
    var fields = {};
    keys.forEach(function(k){ fields[k] = state.dirty[k]; });
    try {
      await DCR.api("/api/portal?action=data", { method:"PATCH", body:{ list:"project", itemId:PID, fields:fields } });
      msg("ok","✓ Saved");
      await loadRecord();
    } catch (e) {
      msg("err", e.message || "Save failed");
      el("pjSave").disabled = false;
    }
  }

  /* ── tabs ── */
  function activeTab(){ var t=document.querySelector(".pj-tab.active"); return t?t.getAttribute("data-tab"):"overview"; }

  function switchTab(name) {
    document.querySelectorAll(".pj-tab").forEach(function(t){ t.classList.toggle("active", t.getAttribute("data-tab")===name); });
    document.querySelectorAll(".pj-pane").forEach(function(p){ p.classList.toggle("active", p.id==="pane-"+name); });
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
      renderEstimate(d.canEdit);
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  function estLineHtml(r) {
    var lines = [];
    if (r.title) lines.push('<b>'+esc(r.title)+'</b>');
    if (r.taskLaborName) lines.push(esc(r.taskLaborName) + (r.taskLaborNumberOfGuys?' <span class="pj-sub">('+r.taskLaborNumberOfGuys+' guys × '+(r.taskLaborDaysToComplete||0)+' days @ '+fmtMoney(r.taskLaborPricePerHour)+'/hr)</span>':"") + (num(r.taskLaborPrice)?' <span class="pj-sub">('+(r.taskLaborQty||1)+' × '+fmtMoney(r.taskLaborPrice)+')</span>':""));
    if (r.taskMaterialName) lines.push(esc(r.taskMaterialName) + (num(r.taskMaterialQty)?' <span class="pj-sub">('+r.taskMaterialQty+' × '+fmtMoney(r.taskMaterialUnitPrice)+')</span>':""));
    if (r.taskEstimateNotes) lines.push('<span class="pj-sub">'+esc(r.taskEstimateNotes)+'</span>');
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

    var cols = 4;
    var grand = { labor:0, mat:0, tot:0 };
    var body = "";
    secs.forEach(function(s, si){
      if (si > 0) body += '<tr class="pj-gap"><td colspan="'+cols+'"></td></tr>';
      body += '<tr class="pj-est"><td colspan="'+cols+'">📄 '+esc(s.name)+
        (canEdit?' <button class="pj-btn pj-btn-sm" data-est-addto="'+esc(s.name===("(no estimate name)")?"":s.name)+'" style="margin-left:8px">＋ Add item</button>':"")+'</td></tr>';
      s.groups.forEach(function(gr){
        var gl=0, gm=0, gt=0;
        body += '<tr class="pj-grp"><td colspan="'+cols+'">'+esc(gr.name)+'</td></tr>';
        gr.rows.forEach(function(r){
          var labor = r.TaskLaborTotalPrice + r.TaskLaborTotalPricePerQty;
          var mat = r.TaskMaterialTotalPrice;
          gl+=labor; gm+=mat; gt+=r.TaskGrandTotalMaterialAndLabor;
          body += '<tr'+(canEdit?' data-est-open="'+r.id+'" style="cursor:pointer" title="Double-click to edit"':"")+'><td class="pj-il">'+ estLineHtml(r) +'</td>' +
            '<td class="num">'+fmtMoney(labor)+'</td><td class="num">'+fmtMoney(mat)+'</td>' +
            '<td class="num"><b>'+fmtMoney(r.TaskGrandTotalMaterialAndLabor)+'</b></td></tr>';
        });
        s.labor+=gl; s.mat+=gm; s.tot+=gt;
        body += '<tr class="pj-grpTot"><td>Subtotal — '+esc(gr.name)+'</td><td class="num">'+fmtMoney(gl)+'</td><td class="num">'+fmtMoney(gm)+'</td><td class="num">'+fmtMoney(gt)+'</td></tr>';
      });
      grand.labor+=s.labor; grand.mat+=s.mat; grand.tot+=s.tot;
      body += '<tr class="pj-estTot"><td>Estimate total — '+esc(s.name)+'</td><td class="num">'+fmtMoney(s.labor)+'</td><td class="num">'+fmtMoney(s.mat)+'</td><td class="num">'+fmtMoney(s.tot)+'</td></tr>';
    });
    if (state.estFilter === "*") {
      body += '<tr class="pj-gap"><td colspan="'+cols+'"></td></tr>';
      body += '<tr class="pj-grand"><td>GRAND TOTAL</td><td class="num">'+fmtMoney(grand.labor)+'</td><td class="num">'+fmtMoney(grand.mat)+'</td><td class="num">'+fmtMoney(grand.tot)+'</td></tr>';
    }

    pane.innerHTML = bar + '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr>' +
      '<th>Item</th><th class="num">Labor</th><th class="num">Material</th><th class="num">Total</th></tr></thead><tbody>'+body+'</tbody></table></div>';
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
          ieSubTakeoff();
        } catch (e) { alert(e.message||"Add failed"); }
      };
      box.querySelectorAll("[data-iet-del]").forEach(function(b){
        b.onclick = async function(){
          if (!confirm("Delete this takeoff line?")) return;
          try { await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"toDelete", itemId: b.getAttribute("data-iet-del") } }); ieSubTakeoff(); }
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
      box.innerHTML = '<div style="margin-bottom:8px"><a class="pj-btn pj-btn-sm" target="_blank" href="https://drive.google.com/drive/folders/'+esc(d.folderId||"")+'">Open project folder in Drive ↗</a></div>' +
        (items.map(function(f){
          return '<div class="ie-contact-hit" data-ief="'+esc(f.id)+'" data-folder="'+(f.isFolder?1:0)+'" data-link="'+esc(f.webViewLink||"")+'">'+fileIcon(f)+' '+esc(f.name)+'</div>';
        }).join("") || '<div class="pj-empty">Empty folder.</div>');
      box.querySelectorAll("[data-ief]").forEach(function(row){
        row.onclick = function(){
          if (row.getAttribute("data-folder")==="1") {
            var link = row.getAttribute("data-link");
            window.open(link || ("https://drive.google.com/drive/folders/"+row.getAttribute("data-ief")), "_blank");
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

  /* ── takeoffs (editable) ── */
  var TO_DEFS = [
    ["takeoffName","Takeoff (group)","text","toGroups"],["itemSortingNumber","Sorting #","num"],
    ["itemName","Item name","text"],["itemCategory","Category","text","toCats"],
    ["itemSubCategory","Sub-category","text","toSubs"],["itemLocation","Location","text","toLocs"],
    ["itemPurpose","Purpose","text"],["itemQty","Qty","text"],["itemPrice","Price each $","num"],
    ["itemHiperLink","Link","text"],
  ];
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
    to:  { defs:TO_DEFS,  title:"Takeoff item",  rowsKey:"toRows",  reload:function(){loadTakeoffs();} },
    exp: { defs:EXP_DEFS, title:"Expense record", rowsKey:"expRows", reload:function(){loadExpenses();} },
    pay: { defs:PAY_DEFS, title:"Payment",        rowsKey:"payRows", reload:function(){loadPayments();} },
  };

  async function loadTakeoffs() {
    var pane = el("pane-takeoffs");
    pane.innerHTML = '<div class="pj-empty">Loading takeoffs…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=takeoffs");
      var rows = d.rows||[]; var canEdit = !!d.canEdit;
      state.toRows = rows; state.toCanEdit = canEdit;
      var bar = '<div class="pj-bar">' +
        (canEdit?'<button class="pj-btn pj-btn-primary pj-btn-sm" id="toAddBtn">＋ New item</button>':"") +
        '<input class="pj-search" id="toSearch" placeholder="Search items…"><span class="pj-sub">'+rows.length+' items</span></div>';
      pane.innerHTML = bar + '<div id="toTable"></div>' + (rows.length?"":'<div class="pj-empty">No takeoff items for this project.</div>');
      var cols = canEdit ? 7 : 6;
      var render = function(){
        if (!rows.length) { el("toTable").innerHTML=""; return; }
        var q = (el("toSearch").value||"").toLowerCase();
        var f = q ? rows.filter(function(r){ return [r.itemName,r.itemCategory,r.itemSubCategory,r.takeoffName,r.itemLocation].join(" ").toLowerCase().indexOf(q)!==-1; }) : rows;
        var groups = {}; f.forEach(function(r){ var g=r.takeoffName||"(no takeoff)"; (groups[g]=groups[g]||[]).push(r); });
        var grand=0, body="";
        Object.keys(groups).forEach(function(g){
          var gt=0;
          body += '<tr class="pj-grp"><td colspan="'+cols+'">'+esc(g)+'</td></tr>';
          groups[g].forEach(function(r){
            var tot = num(r.itemQty)*num(r.itemPrice); gt+=tot;
            body += '<tr><td>'+esc(r.itemName||"—")+'</td><td>'+esc([r.itemCategory,r.itemSubCategory].filter(Boolean).join(" / "))+'</td><td>'+esc(r.itemLocation||"")+'</td>' +
              '<td class="num">'+(num(r.itemQty)||"")+'</td><td class="num">'+(num(r.itemPrice)?fmtMoney(r.itemPrice):"")+'</td><td class="num">'+(tot?fmtMoney(tot):"")+'</td>' +
              (canEdit?'<td><div class="pj-rowbtns"><button class="pj-btn pj-btn-sm" data-sub-edit="to:'+r.id+'">✎</button><button class="pj-btn pj-btn-sm" data-sub-del="to:'+r.id+'">🗑</button></div></td>':"") + '</tr>';
          });
          grand+=gt;
          body += '<tr class="pj-grpTot"><td colspan="'+(cols-1)+'">Subtotal — '+esc(g)+'</td><td class="num">'+fmtMoney(gt)+'</td>'+(canEdit?'<td></td>':"")+'</tr>';
        });
        body += '<tr class="pj-grand"><td colspan="'+(cols-1)+'">GRAND TOTAL</td><td class="num">'+fmtMoney(grand)+'</td>'+(canEdit?'<td></td>':"")+'</tr>';
        el("toTable").innerHTML = '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr><th>Item</th><th>Category</th><th>Location</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Total</th>'+(canEdit?'<th></th>':"")+'</tr></thead><tbody>'+body+'</tbody></table></div>';
        wireSubButtons(el("toTable"));
      };
      el("toSearch").addEventListener("input", render);
      var ab = el("toAddBtn"); if (ab) ab.onclick = function(){ openSubModal("to", null); };
      render();
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  /* ── sub-list modal (takeoffs + expenses) ── */
  function subDatalists(kind) {
    var rows = state[SUB_CFG[kind].rowsKey] || [];
    var lists = {};
    if (kind==="to") {
      lists.toGroups = {}; lists.toCats = {}; lists.toSubs = {}; lists.toLocs = {};
      rows.forEach(function(r){
        if(r.takeoffName)lists.toGroups[r.takeoffName]=1; if(r.itemCategory)lists.toCats[r.itemCategory]=1;
        if(r.itemSubCategory)lists.toSubs[r.itemSubCategory]=1; if(r.itemLocation)lists.toLocs[r.itemLocation]=1;
      });
    } else if (kind==="exp") {
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

  /* ── expenses (editable) ── */
  async function loadExpenses() {
    var pane = el("pane-expenses");
    pane.innerHTML = '<div class="pj-empty">Loading expenses…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=expenses");
      var rows = d.rows||[]; var canEdit = !!d.canEdit;
      state.expRows = rows;
      var cols = canEdit ? 7 : 6;
      var bar = '<div class="pj-bar">' +
        (canEdit?'<button class="pj-btn pj-btn-primary pj-btn-sm" id="expAddBtn">＋ New expense</button>':"") +
        '<a class="pj-btn pj-btn-sm" href="report-expenses.html?id='+encodeURIComponent(PID)+'">🖨 Print expenses</a>' +
        '<span class="pj-sub">'+rows.length+' records</span></div>';
      if (!rows.length) {
        pane.innerHTML = bar + '<div class="pj-empty">No expense records for this project.</div>';
        var ab0 = el("expAddBtn"); if (ab0) ab0.onclick = function(){ openSubModal("exp", null); };
        return;
      }
      var groups = {}; rows.forEach(function(r){ var g=r.gropingName||"(no group)"; (groups[g]=groups[g]||[]).push(r); });
      var grand={est:0,inv:0,mat:0,con:0}, body="";
      Object.keys(groups).forEach(function(g){
        var t={est:0,inv:0,mat:0,con:0};
        body += '<tr class="pj-grp"><td colspan="'+cols+'">'+esc(g)+'</td></tr>';
        groups[g].forEach(function(r){
          var desc = r.description || r.laborExpenseDescription || r.materialExpenseDescription || r.estimateDescription || "";
          t.est+=num(r.estimate); t.inv+=num(r.invoice); t.mat+=num(r.materials); t.con+=num(r.contractors);
          body += '<tr><td>'+fmtDate(r.expenseDate)+'</td><td>'+esc(desc)+'</td>' +
            '<td class="num">'+(num(r.estimate)?fmtMoney(r.estimate):"")+'</td><td class="num">'+(num(r.invoice)?fmtMoney(r.invoice):"")+'</td>' +
            '<td class="num">'+(num(r.materials)?fmtMoney(r.materials):"")+'</td><td class="num">'+(num(r.contractors)?fmtMoney(r.contractors):"")+'</td>' +
            (canEdit?'<td><div class="pj-rowbtns"><button class="pj-btn pj-btn-sm" data-sub-edit="exp:'+r.id+'">✎</button><button class="pj-btn pj-btn-sm" data-sub-del="exp:'+r.id+'">🗑</button></div></td>':"") + '</tr>';
        });
        Object.keys(t).forEach(function(k){ grand[k]+=t[k]; });
        body += '<tr class="pj-grpTot"><td colspan="2">Subtotal — '+esc(g)+'</td><td class="num">'+fmtMoney(t.est)+'</td><td class="num">'+fmtMoney(t.inv)+'</td><td class="num">'+fmtMoney(t.mat)+'</td><td class="num">'+fmtMoney(t.con)+'</td>'+(canEdit?'<td></td>':"")+'</tr>';
      });
      body += '<tr class="pj-grand"><td colspan="2">GRAND TOTAL</td><td class="num">'+fmtMoney(grand.est)+'</td><td class="num">'+fmtMoney(grand.inv)+'</td><td class="num">'+fmtMoney(grand.mat)+'</td><td class="num">'+fmtMoney(grand.con)+'</td>'+(canEdit?'<td></td>':"")+'</tr>';
      pane.innerHTML = bar +
        '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr><th>Date</th><th>Description</th><th class="num">Estimate</th><th class="num">Invoice</th><th class="num">Materials</th><th class="num">Contractors</th>'+(canEdit?'<th></th>':"")+'</tr></thead><tbody>'+body+'</tbody></table></div>';
      var ab = el("expAddBtn"); if (ab) ab.onclick = function(){ openSubModal("exp", null); };
      wireSubButtons(pane);
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
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
        '<textarea id="mailNotes" '+(state.canWrite?"":"disabled ")+'style="width:100%;box-sizing:border-box;min-height:90px;padding:9px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)">'+esc(p.projectEMailNotes||"")+'</textarea>' +
        (state.canWrite?'<div style="margin-top:8px;display:flex;gap:8px;align-items:center"><button class="pj-btn pj-btn-primary pj-btn-sm" id="mailSave">✓ Save notes</button><span class="pj-msg" id="mailMsg"></span></div>':"")+'</div>' +
      '<div class="pj-sec"><h3>Find a contact</h3><input class="pj-search" id="ctSearch" placeholder="Search contacts…"><div id="ctResults" style="margin-top:10px"></div></div>';

    var ms = el("mailSave");
    if (ms) ms.onclick = async function(){
      ms.disabled = true;
      try {
        await DCR.api("/api/portal?action=data", { method:"PATCH", body:{ list:"project", itemId:PID, fields:{ projectEMailNotes: el("mailNotes").value } } });
        state.project.projectEMailNotes = el("mailNotes").value;
        el("mailMsg").textContent="✓ Saved"; el("mailMsg").className="pj-msg ok";
      } catch (e) { el("mailMsg").textContent=e.message; el("mailMsg").className="pj-msg err"; }
      ms.disabled = false;
    };

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
        state.files.stack = [{ id: d.folderId, name: "Project folder" }];
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
    pane.innerHTML = '<div class="pj-crumb">'+crumbs+
      '<a class="pj-btn pj-btn-sm" style="margin-left:auto" target="_blank" href="https://drive.google.com/drive/folders/'+esc(top.id)+'">Open in Drive ↗</a></div>' +
      '<div class="pj-tblwrap">'+rows+'</div>';
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
          state.files.stack.push({ id: row.getAttribute("data-fid"), name: row.getAttribute("data-name") });
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

  /* ── project switcher ── */
  async function loadSwitcher() {
    try {
      var d = await DCR.api("/api/portal?action=board");
      state.boardList = d.projects || [];
      el("pjJumpList").innerHTML = state.boardList.map(function(p){
        return '<option value="'+esc((p.internalIDNumber||"")+" — "+(p.projectName||""))+'">';
      }).join("");
    } catch (e) { /* non-fatal */ }
    el("pjJump").addEventListener("change", function(){
      var v = this.value.trim().toLowerCase();
      var hit = state.boardList.find(function(p){
        return ((p.internalIDNumber||"")+" — "+(p.projectName||"")).toLowerCase() === v ||
               String(p.internalIDNumber||"").toLowerCase() === v;
      });
      if (hit) location.href = "project.html?id=" + encodeURIComponent(hit.id);
    });
  }

  /* ── init ── */
  document.addEventListener("DOMContentLoaded", async function () {
    state.profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (state.profile.displayName || state.profile.email) + " · " + state.profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    if (!PID) { el("pjTitle").textContent = "No project selected"; el("pane-overview").innerHTML='<div class="pj-empty">Open a project from the <a href="board.html" style="color:var(--acc)">Board</a>.</div>'; return; }

    document.querySelectorAll(".pj-tab").forEach(function(t){ t.onclick = function(){ switchTab(t.getAttribute("data-tab")); }; });
    el("pjSave").onclick = saveOverview;
    el("tkCancel").onclick = function(){ el("taskModal").classList.remove("open"); };
    el("tkSave").onclick = saveTask;
    el("subCancel").onclick = function(){ el("subModal").classList.remove("open"); };
    el("subSave").onclick = saveSubModal;
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
    window.addEventListener("beforeunload", function(e){ if (Object.keys(state.dirty).length) { e.preventDefault(); e.returnValue=""; } });

    try { await loadRecord(); } catch (e) { el("pjTitle").textContent = "Error"; el("pane-overview").innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; return; }
    // Deep-link support (e.g. search results): project.html?id=N&tab=estimate
    var wantTab = qs.get("tab");
    if (wantTab && document.querySelector('.pj-tab[data-tab="'+wantTab+'"]')) switchTab(wantTab);
    loadSwitcher();
  });
})();
