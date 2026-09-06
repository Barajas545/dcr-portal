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
    else if (name==="estimates") loadEstimatesSent();
    else if (name==="takeoffs") loadTakeoffs();
    else if (name==="expenses") loadExpenses();
    else if (name==="payments") loadPayments();
    else if (name==="tasks") loadTasks();
    else if (name==="journal") loadJournal();
    else if (name==="logs") loadLogs();
    else if (name==="mailing") renderMailing();
    else if (name==="files") loadFiles();
  }

  /* ── estimates sent to the client (Estimates → EstimateDetails) ──────────
     The Access relationship, as it stands there: a project has many estimates,
     each estimate has many priced lines. Distinct from the Estimate tab, which
     is the internal working breakdown built from GeneralProjectTasks rows. */
  async function loadEstimatesSent() {
    var pane = el("pane-estimates");
    pane.innerHTML = '<div class="pj-empty">Loading estimates…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id="+PID+"&part=estimates");
      renderEstimatesSent(d);
    } catch (e) { pane.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  function estStatusChip(h) {
    if (h.estimateAppoved) return '<span class="pj-schip ok">Approved</span>';
    if (h.estimateSent || h.estimateSentDate) return '<span class="pj-schip sent">Sent</span>';
    return '<span class="pj-schip draft">Not sent</span>';
  }

  function renderEstimatesSent(d) {
    var pane = el("pane-estimates");
    var rows = d.rows || [];
    var c = d.counts || {};
    var showMoney = !d.pricesHidden;
    var m$ = function(n){ return num(n) ? fmtMoney(n) : ""; };
    var mBare = function(n){ return num(n) ? fmtMoney(n).replace("$", "") : ""; };

    if (!rows.length) {
      pane.innerHTML = '<div class="pj-empty">No estimates recorded for this project.' +
        (c.lineRows ? ' (' + c.lineRows + ' estimate lines exist but have no estimate to belong to.)' : '') +
        '</div>';
      return;
    }

    /* The join can come up empty without erroring, so when there are lines but
       none of them matched, say exactly that — otherwise every estimate just
       looks like it has no items, which is a different problem entirely. */
    var diag = "";
    /* "Nothing matched" has two very different causes and only one is a bug.
       If no line carries an estimate number at all, the lists are not keyed
       differently — the numbers were simply never filled in. Claiming a
       schema fault there sends the reader hunting for something that is not
       broken, so only say it when a row actually held a number that fit
       nothing. */
    if (d.joinedVia === "none" && (c.unmatched || 0) > 0) {
      diag = '<div class="pj-diag"><b>No lines matched.</b> ' + (c.unmatched || 0) +
        ' estimate line' + ((c.unmatched || 0) === 1 ? " carries a number that does" : "s carry numbers that do") +
        ' not line up with any estimate — the two lists are keyed differently. ' +
        'Tell Claude the numbers you see here and it can be corrected.</div>';
    } else if (d.joinedVia === "oldID") {
      // _OldID is an export artifact, not live keying — landing here means the
      // numbers are not what they should be, so say so rather than shrug.
      diag = '<div class="pj-diag"><b>Matched on the old Access ID.</b> These lines are ' +
        'linked by the number SharePoint wrote during the export, rather than by the ' +
        'ID of the estimate itself. The figures below are right, but the numbering ' +
        'is worth a look.</div>';
    }
    /* Every line the join did not attach, each under its own name. These
       three counts are disjoint and together with `attached` they account for
       every row, so leaving one out means money missing from the totals with
       nothing on screen to explain it — which is the exact failure this note
       exists to prevent. `foreign` was the one being dropped. */
    var parts = [];
    if (c.unkeyed) parts.push(c.unkeyed + ' with no estimate number');
    if (c.unmatched) parts.push(c.unmatched + ' with a number that fits no estimate');
    if (c.foreign) parts.push(c.foreign + ' pointing at an estimate on another project');
    var loose = (c.unkeyed || 0) + (c.unmatched || 0) + (c.foreign || 0);
    // Suppressed only when the banner above already said the same thing.
    if (loose && !(d.joinedVia === "none" && (c.unmatched || 0) > 0)) {
      diag += '<div class="pj-diag">' + loose + ' estimate line' + (loose === 1 ? " is" : "s are") +
        ' not attached to any estimate here' +
        (parts.length ? ' (' + parts.join(", ") + ')' : '') +
        '. They still appear on the Estimate tab.</div>';
    }

    var html = diag;
    rows.forEach(function (h) {
      var name = h.estimateName || h.title || "Untitled estimate";
      var sub = [];
      // fmtDate falls through to the raw stored value when it cannot parse it,
      // so this is list content and has to be escaped like any other.
      if (h.estimateSentDate) sub.push("Sent " + esc(fmtDate(h.estimateSentDate)));
      if (h.estimateClientName) sub.push(esc(h.estimateClientName));
      if (h.estimateDescription) sub.push(esc(String(h.estimateDescription)));

      // The estimate's own price if it carries one, else the sum of its lines.
      var amt = "";
      if (showMoney) {
        var total = num(h.estimatePrice) ? Number(h.estimatePrice) : (h.lineTotal || 0);
        amt = '<div class="pj-sent-amt">' + fmtMoney(total) + '</div>';
      }

      html += '<div class="pj-sent">' +
        '<div class="pj-sent-hd">' +
          '<div class="pj-sent-nm">' + esc(name) +
            (sub.length ? '<div class="pj-sent-sub">' + sub.join(" · ") + '</div>' : '') +
          '</div>' +
          estStatusChip(h) + amt +
        '</div>';

      var lines = h.lines || [];
      if (!lines.length) {
        html += '<div class="pj-sent-none">No lines on this estimate.</div>';
      } else {
        // Group by grouping name, the way the Estimate tab does.
        var groups = [];
        var seen = {};
        lines.forEach(function (r) {
          var g = r.taskGroupingName || "(ungrouped)";
          if (!seen[g]) { seen[g] = { name: g, rows: [] }; groups.push(seen[g]); }
          seen[g].rows.push(r);
        });

        var cols = showMoney ? 4 : 1;
        html += '<div class="pj-tblwrap"><table class="pj-tbl"><thead><tr><th>Item</th>' +
          (showMoney ? '<th class="num">Labor</th><th class="num">Material</th><th class="num">Total</th>' : '') +
          '</tr></thead><tbody>';
        groups.forEach(function (gr) {
          if (groups.length > 1) {
            html += '<tr class="pj-grp"><td colspan="' + cols + '">' + esc(gr.name) + '</td></tr>';
          }
          gr.rows.forEach(function (r) {
            var labor = (r.TaskLaborTotalPrice || 0) + (r.TaskLaborTotalPricePerQty || 0);
            html += '<tr><td class="pj-il">' + estLineHtml(r) + '</td>' +
              (showMoney
                ? '<td class="num">' + mBare(labor) + '</td>' +
                  '<td class="num">' + mBare(r.TaskMaterialTotalPrice) + '</td>' +
                  '<td class="num"><b>' + m$(r.TaskGrandTotalMaterialAndLabor) + '</b></td>'
                : '') + '</tr>';
          });
        });
        if (showMoney) {
          html += '<tr class="pj-grpTot"><td>Estimate total</td><td class="num"></td>' +
            '<td class="num"></td><td class="num">' + m$(h.lineTotal) + '</td></tr>';
        }
        html += '</tbody></table></div>';
      }
      html += '</div>';
    });

    pane.innerHTML = html;
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
      state.estBilled = d.billed || {};
      state.estCanBill = !!d.canBill;
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

  /* The estimate's name, trimmed.

     The billed record is stored under the trimmed name, so grouping on the
     raw value would look the record up under a key that differs by a space
     and find nothing: the estimate would read as unbilled however many times
     it had been marked, and Undo would never be offered. Access-migrated text
     carries stray whitespace, and the estimate editor does not trim on the way
     in either, so this is reachable from inside the portal. Trimming here also
     makes a whitespace-only name fall through to "(no estimate name)", which
     suppresses the button rather than letting it 400. */
  function estName(r) {
    return String((r && r.taskEstimateName) || "").trim() || "(no estimate name)";
  }

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
    rows.forEach(function(r){ var n = estName(r); if (allNames.indexOf(n)===-1) allNames.push(n); });
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
      var sn = estName(r);
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
      /* Billing is tracked per estimate because that is the unit that gets
         invoiced - one estimate per billing period for time-and-materials
         work. An estimate with no name cannot be marked: there would be
         nothing to key the record on. */
      var named = s.name !== "(no estimate name)";
      var bill = (state.estBilled || {})[s.name];
      var billBadge = bill
        ? ' <span class="pj-billed" title="Recorded ' + esc(bill.at || "") +
            (bill.by ? " by " + esc(bill.by) : "") + '">✓ Billed' +
            (bill.invoice ? " · inv " + esc(bill.invoice) : "") +
            (bill.amount != null && showMoney ? " · " + fmtMoney(bill.amount) : "") + '</span>'
        : "";
      var billBtn = (state.estCanBill && named)
        ? ' <button class="pj-btn pj-btn-sm" data-est-bill="'+esc(s.name)+'" data-billed="'+(bill?1:0)+
          '" data-total="'+esc(String(s.tot||0))+'" style="margin-left:6px">'+(bill?"Undo billed":"Mark billed…")+'</button>'
        : "";
      html += '<div class="pj-esttable'+(bill?" is-billed":"")+'"><table class="pj-tbl"><thead>' +
        '<tr class="pj-est"><td><span class="pj-estname">📄 '+esc(s.name)+'</span>'+billBadge+addBtn+billBtn+'</td>' +
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
    // Marking billed is gated on project:write, not on estimate editing, so it
    // is wired outside the canEdit block.
    pane.querySelectorAll("[data-est-bill]").forEach(function(b){
      b.onclick = function(e){ e.stopPropagation(); markEstimateBilled(b); };
    });
    if (canEdit) {
      pane.querySelectorAll("[data-est-addto]").forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); ieOpen(null, b.getAttribute("data-est-addto")); }; });
      pane.querySelectorAll("[data-est-open]").forEach(function(tr){ tr.ondblclick=function(){ ieOpen(tr.getAttribute("data-est-open")); }; });
    }
  }

  /* Record (or undo) that an estimate has gone out on an invoice.

     Time-and-materials work is billed in periods, and nothing else in the
     system remembers which periods have been billed: an invoice is a single
     typed amount with no link back to the work. Without this the second
     invoice has no way to exclude what the first one covered. */
  async function markEstimateBilled(btn) {
    var name = btn.getAttribute("data-est-bill");
    var already = btn.getAttribute("data-billed") === "1";
    var total = Number(btn.getAttribute("data-total")) || 0;

    if (already) {
      if (!(await DCR.confirm(
            'Clear the billing record for "' + name + '"? It will look unbilled again.',
            { title: "Undo billed", okText: "Clear", danger: true }))) return;
      await postBilled({ estimateName: name, clear: true }, btn);
      return;
    }
    var r = await DCR.modal({
      title: "Mark as billed",
      message: 'Record that "' + name + '" has gone out to the client.',
      fields: [
        { name: "invoice", label: "Invoice number", placeholder: "e.g. 1042" },
        // Prefilled with what this estimate actually totals, so the recorded
        // figure matches the work rather than being retyped from memory.
        { name: "amount", label: "Amount billed", type: "number", step: "0.01",
          value: total ? String(Math.round(total * 100) / 100) : "" },
      ],
      okText: "Mark billed",
    });
    if (!r) return;
    await postBilled({ estimateName: name, invoice: r.invoice || "", amount: r.amount || "" }, btn);
  }

  async function postBilled(body, btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = "…";
    try {
      body.op = "billed";
      body.projectId = PID;
      await DCR.api("/api/portal?action=pm", { method: "POST", body: body });
      await loadEstimate();
    } catch (e) {
      btn.disabled = false; btn.textContent = label;
      DCR.alert((e && e.message) || "Could not record that.", { title: "Billing not saved" });
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
    if (!email) { DCR.alert("No e-mail address set."); return; }
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
        } catch (e) { DCR.alert(e.message||"Add failed"); }
      };
      box.querySelectorAll("[data-iet-del]").forEach(function(b){
        b.onclick = async function(){
          if (!(await DCR.confirm("Delete this takeoff line?", { title: "Delete line", danger: true, okText: "Delete" }))) return;
          try { await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"toDelete", itemId: b.getAttribute("data-iet-del") } }); DCR.takeoff.invalidate(); ieSubTakeoff(); }
          catch (e) { DCR.alert(e.message||"Delete failed"); }
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
        } catch (e) { DCR.alert(e.message||"Add failed"); }
      };
      box.querySelectorAll("[data-iee-del]").forEach(function(b){
        b.onclick = async function(){
          if (!(await DCR.confirm("Delete this expense?", { title: "Delete expense", danger: true, okText: "Delete" }))) return;
          try { await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"expDelete", itemId: b.getAttribute("data-iee-del") } }); ieSubExpenses(); }
          catch (e) { DCR.alert(e.message||"Delete failed"); }
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
          return '<div class="ie-contact-hit" data-ief="'+esc(f.id)+'" data-folder="'+(f.isFolder?1:0)+'" data-name="'+esc(f.name)+'" data-link="'+esc(f.webViewLink||"")+'">'+fileIcon(f)+' '+esc(f.name)+'</div>';
        }).join("") || '<div class="pj-empty">Empty folder.</div>');
      box.querySelectorAll("[data-ief]").forEach(function(row){
        row.onclick = function(){
          if (row.getAttribute("data-folder")==="1") {
            var link = row.getAttribute("data-link");
            if (link) window.open(link, "_blank");
          } else if (isTakeoff(row.getAttribute("data-name"))) {
            openInTakeoff(row.getAttribute("data-ief"), row.getAttribute("data-name"), row);
          } else if (/\.pdf$/i.test(row.getAttribute("data-name") || "")) {
            location.href = "planview.html?file=" + encodeURIComponent(row.getAttribute("data-ief")) +
              "&project=" + encodeURIComponent(PID) + "&from=files";
          } else openFile(row.getAttribute("data-ief"), row.getAttribute("data-link"));
        };
      });
    } catch (e) { box.innerHTML = '<div class="pj-empty">'+esc(e.message)+'</div>'; }
  }

  async function delEstRow(rowId) {
    if (!(await DCR.confirm("This cannot be undone.", { title: "Delete this estimate line?", danger: true, okText: "Delete" }))) return;
    try {
      await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"estDelete", itemId: rowId } });
      if (state.ie && String(state.ie.id)===String(rowId)) el("ieModal").classList.remove("open");
      loadEstimate();
    } catch (e) { DCR.alert(e.message || "Delete failed"); }
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
    if (!(await DCR.confirm(what + "\n\nThis cannot be undone.",
      { title: "Delete this " + SUB_CFG[kind].title.toLowerCase() + "?", danger: true, okText: "Delete" }))) return;
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
        if (!(await DCR.confirm("This cannot be undone.", { title: "Delete this record?", danger: true, okText: "Delete" }))) return;
        try {
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:p[0]+"Delete", itemId:p[1] } });
          SUB_CFG[p[0]].reload();
        } catch (e) { DCR.alert(e.message||"Delete failed"); }
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
      /* A payment now has to say which bill it settles — that link is what
         makes "approved before paid" enforceable, and what makes "still owed"
         computable. So it is recorded from the money band on the progress
         chart, beside the bill, rather than from a free-standing form here. */
      var bar = '<div class="pj-bar">' +
        (canEdit?'<a class="pj-btn pj-btn-primary pj-btn-sm" href="pm.html?id='+encodeURIComponent(PID)+'">＋ Record a payment</a>':"") +
        '<span class="pj-sub">'+rows.length+' payment records</span>' +
        (canEdit?'<span class="pj-sub">Payments are recorded against the bill they pay, on the progress chart.</span>':"") +
        '</div>';
      if (!rows.length) {
        pane.innerHTML = bar + '<div class="pj-empty">No payment records for this project.</div>';
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
      wireSubButtons(pane);
      pane.querySelectorAll("[data-pay-tgl]").forEach(function(b){
        b.onclick = async function(){
          var row = rows.find(function(r){ return String(r.id)===b.getAttribute("data-pay-tgl"); });
          var newVal = !(row.paymentPAID===true || row.paymentPAID==="true");
          try {
            await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"payUpdate", itemId:row.id, fields:{ paymentPAID:newVal } } });
            loadPayments();
          } catch (e) { DCR.alert(e.message||"Update failed"); }
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
    var add = el("tkAddBtn"); if (add) add.onclick = openTaskModal;
    pane.querySelectorAll("[data-tk]").forEach(function(cb){
      cb.onchange = async function(){
        try {
          await DCR.api("/api/portal?action=project", { method:"POST", body:{ op:"taskToggle", itemId: cb.getAttribute("data-tk"), complete: cb.checked } });
          var row = state.taskRows.find(function(r){ return String(r.id)===cb.getAttribute("data-tk"); });
          if (row) row.taskCompleteCheck = cb.checked;
          renderTasks();
        } catch (e) { DCR.alert(e.message||"Update failed"); cb.checked=!cb.checked; }
      };
    });
  }

  /* ── task request ──────────────────────────────────────────────────────
     The web version of the Access "Project Task Request" form. Project detail
     autofills from the open project, the employee list fills the notification
     address, and submitting both creates the record and notifies the assignee.

     This is deliberately NOT a DCR.live auto-save form. It creates a record
     and sends a message — both are one-way — so it stays one deliberate
     click, exactly as the auto-save engine's own contract says. */
  function tkPerson(name) {
    var want = String(name || "").trim().toLowerCase();
    return (state.assignees || []).find(function (p) { return p.name.toLowerCase() === want; }) || null;
  }

  // Addresses live behind the same gate as creating the task, so this only
  // resolves for someone who could assign the work anyway.
  async function loadAssignees() {
    if (state.assignees) return state.assignees;
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=assignees");
      state.assignees = d.people || [];
    } catch (e) {
      state.assignees = [];        // typing a name by hand still works
    }
    el("tkPeople").innerHTML = state.assignees
      .map(function (p) { return '<option value="' + esc(p.name) + '"></option>'; }).join("");
    return state.assignees;
  }

  function openTaskModal() {
    var p = state.project || {};
    el("tkProject").innerHTML =
      [["Internal ID", p.internalIDNumber], ["Project ID", PID], ["Name", p.projectName],
       ["Address", p.projectAddress], ["City", p.projectCity]]
      .map(function (r) {
        return "<div><b>" + esc(r[0]) + "</b><span>" + esc(r[1] || "—") + "</span></div>";
      }).join("");
    el("tkMsg").className = "pj-msg";
    el("tkMsg").textContent = "";
    el("taskModal").classList.add("open");
    loadAssignees();
    setTimeout(function () { el("tkAssigned").focus(); }, 30);
  }

  // Opening a mailto: must never be done with location.href — it can take the
  // app window with it and abort an in-flight save. A detached anchor cannot.
  function openDraft(to, cc, subject, body) {
    var url = "mailto:" + encodeURIComponent(to) +
      "?subject=" + encodeURIComponent(subject) +
      (cc ? "&cc=" + encodeURIComponent(cc) : "") +
      "&body=" + encodeURIComponent(body);
    var a = document.createElement("a");
    a.href = url;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  async function saveTask() {
    var name = el("tkName").value.trim();
    if (!name) { el("tkMsg").className = "pj-msg err"; el("tkMsg").textContent = "Task name is required."; return; }

    var who = el("tkAssigned").value.trim();
    var hit = tkPerson(who);
    var to = el("tkToEmail").value.trim() || (hit ? hit.email : "");

    el("tkSave").disabled = true;
    el("tkMsg").className = "pj-msg";
    el("tkMsg").textContent = "Submitting…";
    try {
      var r = await DCR.api("/api/portal?action=project", { method: "POST", body: {
        op: "taskAdd", projectId: PID, taskName: name,
        priority: el("tkPriority").value,
        category: el("tkCategory").value,
        subCategory: el("tkSubCategory").value,
        assignedPerson: who,
        assignedEmail: to,
        toName: who,
        cc: el("tkCc").value.trim(),
        mapLink: el("tkMapLink").value.trim(),
        description: el("tkDesc").value.trim(),
        portalLink: location.origin + location.pathname + "?id=" + encodeURIComponent(PID) + "&tab=tasks",
      }});

      el("taskModal").classList.remove("open");
      ["tkName", "tkDesc", "tkCc", "tkMapLink"].forEach(function (i) { el(i).value = ""; });
      loadTasks();

      // The record is saved either way; all that varies is how the assignee
      // hears about it. Say which happened rather than implying an email went
      // out when it didn't.
      var n = r.notify || {};
      if (n.sent) msg("ok", "Task created — " + (who || "assignee") + " has been emailed.");
      else if (n.to) {
        openDraft(n.to, n.cc, n.subject, n.body);
        msg("ok", "Task created — the notification is open in your email, ready to send.");
      } else if (who) {
        msg("ok", "Task created and assigned to " + who + ". No email address on file for them, so nothing was sent.");
      } else {
        msg("ok", "Task created. Nobody was assigned, so nobody was notified.");
      }
    } catch (e) {
      el("tkMsg").className = "pj-msg err";
      el("tkMsg").textContent = e.message || "Create failed";
    }
    el("tkSave").disabled = false;
  }

  /* ── logs ── */
  /* ── project journal ──────────────────────────────────────────────────
     The PM's running diary of the job: what happened, who was there, what got
     in the way. ProjectLog is the terse status trail; this is the daily report.

     NOTHING HERE HAS A SAVE BUTTON. A journal is written on a phone, on a
     truck seat, between other things — the app will get closed mid-sentence,
     and losing the day's write-up to that is the one failure this feature
     cannot have. So: every keystroke goes to localStorage immediately, and
     once there is something worth keeping the row is created on the server and
     kept up to date from then on. Closing the tab mid-word costs nothing.

     Photos and video go to Pictures / Project Jurnal, named "<date> <time>
     IMG.jpg" so the folder sorts itself chronologically. Each upload also
     writes a small .thumb.jpg beside it, because a month of daily reports is
     a lot of full-size pictures to pull just to draw a list. Media can stand
     on its own — a photo with a caption and no write-up is a valid entry. */
  var JRN_CATS = ["Progress", "Delay", "Issue", "Safety", "Inspection",
                  "Delivery", "Visitor", "Weather", "Change order", "Other"];
  var JRN_THUMB_PX = 320;          // long edge of the stored thumbnail
  var JRN_DRAFT_KEY = "dcrJrnDraft:";

  // The LOCAL date. new Date().toISOString() rolls over at 4pm Pacific, so a
  // PM writing up the day in the evening would get tomorrow's date while the
  // photos beside it were stamped today.
  function jrnToday() {
    var d = new Date(), p2 = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  }
  // "2026-08-13 15.30.15" — sorts as text exactly as it sorts in time
  function jrnStamp(d) {
    var p2 = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
      p2(d.getHours()) + "." + p2(d.getMinutes()) + "." + p2(d.getSeconds());
  }
  // keep the camera's own extension — an iPhone HEIC must not be stored as .jpg
  function jrnExt(file) {
    var m = /\.([A-Za-z0-9]{2,5})$/.exec(file.name || "");
    if (m) return "." + m[1].toLowerCase();
    var t = String(file.type || "");
    return "." + ((t.split("/")[1] || "bin").split(";")[0]);
  }
  function jrnIsVideo(f) { return String(f.type || "").indexOf("video/") === 0; }

  /* Media is stored as JSON so each file can carry its own caption, but a
     plain newline list is still read — that is what the column held first, and
     a journal must never lose a picture to a format change. */
  function jrnMedia(row) {
    var raw = String((row && row.journalMedia) || "").trim();
    if (!raw) return [];
    if (raw.charAt(0) === "[") {
      try {
        var arr = JSON.parse(raw);
        if (Object.prototype.toString.call(arr) === "[object Array]") {
          return arr.filter(Boolean).map(function (m) {
            return typeof m === "string" ? { name: m, desc: "", thumb: "" } : {
              name: String(m.name || ""), desc: String(m.desc || ""),
              thumb: String(m.thumb || ""), video: !!m.video,
            };
          }).filter(function (m) { return m.name; });
        }
      } catch (e) { /* fall through to the old format */ }
    }
    return raw.split("\n").map(function (x) { return x.trim(); }).filter(Boolean)
      .map(function (n) { return { name: n, desc: "", thumb: "", video: /\.(mp4|mov|m4v|avi|3gp|webm)$/i.test(n) }; });
  }

  /* ---- thumbnails -----------------------------------------------------
     Built in the browser, before upload. A video's poster comes from seeking
     a little way in — frame zero is very often black. Failing to make one is
     not an error: the picture still uploads, the list just shows a placeholder
     for it. */
  function jrnShrink(source, w, h) {
    var scale = Math.min(1, JRN_THUMB_PX / Math.max(w || 1, h || 1));
    var c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
    return new Promise(function (res) { c.toBlob(res, "image/jpeg", 0.62); });
  }
  function jrnThumbFor(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var done = function (blob) { try { URL.revokeObjectURL(url); } catch (e) {} resolve(blob || null); };
      var bail = setTimeout(function () { done(null); }, 8000);
      if (jrnIsVideo(file)) {
        var v = document.createElement("video");
        v.preload = "metadata"; v.muted = true; v.playsInline = true;
        v.onloadeddata = function () {
          // a second in, so the poster is not the black frame at the very start
          try { v.currentTime = Math.min(1, (v.duration || 2) / 4); } catch (e) {}
        };
        v.onseeked = function () {
          clearTimeout(bail);
          jrnShrink(v, v.videoWidth, v.videoHeight).then(done, function () { done(null); });
        };
        v.onerror = function () { clearTimeout(bail); done(null); };
        v.src = url;
      } else {
        var im = new Image();
        im.onload = function () {
          clearTimeout(bail);
          jrnShrink(im, im.naturalWidth, im.naturalHeight).then(done, function () { done(null); });
        };
        im.onerror = function () { clearTimeout(bail); done(null); };
        im.src = url;
      }
    });
  }

  /* ---- the draft ------------------------------------------------------
     Local first, server second. The local copy is what makes closing the app
     safe; the server row is what makes it visible to everyone else. */
  function jrnDraftKey() { return JRN_DRAFT_KEY + PID; }
  function jrnReadDraft() {
    try { return JSON.parse(localStorage.getItem(jrnDraftKey()) || "null") || null; }
    catch (e) { return null; }
  }
  function jrnWriteDraft(d) {
    try {
      if (d) localStorage.setItem(jrnDraftKey(), JSON.stringify(d));
      else localStorage.removeItem(jrnDraftKey());
    } catch (e) { /* private mode / full quota — the server copy still runs */ }
  }

  async function loadJournal() {
    var pane = el("pane-journal");
    pane.innerHTML = '<div class="pj-empty">Loading journal…</div>';
    try {
      var d = await DCR.api("/api/portal?action=project&id=" + PID + "&part=journal");
      state.jrnRows = d.rows || [];
      state.jrnCanWrite = !!d.canWrite;
      renderJournal();
      // thumbnails come after the text: the entries are readable immediately
      // and the pictures fill in, rather than the whole tab waiting on Graph
      jrnLoadMedia();
    } catch (e) {
      pane.innerHTML = '<div class="pj-empty">' + esc(e.message || "Could not load the journal.") + "</div>";
    }
  }

  async function jrnLoadMedia() {
    try {
      var d = await DCR.api("/api/portal?action=drive&journalFor=" + encodeURIComponent(PID));
      state.jrnFiles = d.files || {};
    } catch (e) {
      state.jrnFiles = {};
      return;
    }
    el("pane-journal").querySelectorAll("[data-jrn-thumb]").forEach(function (box) {
      var f = state.jrnFiles[box.getAttribute("data-jrn-thumb")];
      var full = state.jrnFiles[box.getAttribute("data-jrn-full")];
      if (f && f.url) {
        box.innerHTML = '<img src="' + esc(f.url) + '" alt="">' +
          (box.getAttribute("data-jrn-video") === "1" ? '<span class="pj-jrn-play">▶</span>' : "");
      }
      if (full && full.url) {
        box.style.cursor = "pointer";
        box.onclick = function () { window.open(full.url, "_blank", "noopener"); };
        box.title = "Open the full size";
      }
    });
  }

  function jrnMediaHtml(list) {
    if (!list.length) return "";
    return '<div class="pj-jrn-media">' + list.map(function (m) {
      return '<figure class="pj-jrn-fig">' +
        '<div class="pj-jrn-thumb" data-jrn-thumb="' + esc(m.thumb || m.name) + '"' +
          ' data-jrn-full="' + esc(m.name) + '"' +
          ' data-jrn-video="' + (m.video ? "1" : "0") + '">' +
          (m.video ? '<span class="pj-jrn-play">▶</span>' : "") + "</div>" +
        (m.desc ? "<figcaption>" + esc(m.desc) + "</figcaption>" : "") +
        "</figure>";
    }).join("") + "</div>";
  }

  function jrnEntryHtml(r) {
    var media = jrnMedia(r);
    var meta = [];
    if (r.journalWeather) meta.push(esc(r.journalWeather));
    if (num(r.journalCrewSize)) meta.push(num(r.journalCrewSize) + " on site");
    if (num(r.journalHours)) meta.push(num(r.journalHours) + " hrs");
    return '<div class="pj-jrn" data-jrn-row="' + esc(r.id) + '">' +
      '<div class="pj-jrn-top">' +
        "<b>" + fmtDate(r.journalDate) + "</b>" +
        (r.journalCategory ? '<span class="pj-tag on">' + esc(r.journalCategory) + "</span>" : "") +
        (r.journalFollowUp ? '<span class="pj-tag pj-jrn-flag">&#9873; Follow up</span>' : "") +
        '<span class="pj-sub pj-jrn-who">' + esc(r.journalAuthor || "") + "</span>" +
        (state.jrnCanWrite
          ? ' <button class="pj-btn pj-btn-sm" data-jrn-del="' + esc(r.id) + '" title="Delete this entry">&#128465;</button>'
          : "") +
      "</div>" +
      (r.title ? '<div class="pj-jrn-h">' + esc(r.title) + "</div>" : "") +
      (r.journalEntry ? '<div class="pj-jrn-body">' + esc(r.journalEntry) + "</div>" : "") +
      (meta.length ? '<div class="pj-sub pj-jrn-meta">' + meta.join(" &middot; ") + "</div>" : "") +
      jrnMediaHtml(media) +
      "</div>";
  }

  function renderJournal() {
    var pane = el("pane-journal");
    var rows = state.jrnRows || [];
    var draft = jrnReadDraft() || {};
    // The app was closed part-way through an entry. Pick that entry back up
    // rather than starting a second one: without this the next keystroke wrote
    // a brand-new row and the day ended up with the same entry twice.
    if (state.jrnDraftId == null && draft.id &&
        rows.some(function (r) { return String(r.id) === String(draft.id); })) {
      state.jrnDraftId = String(draft.id);
    }
    // Auto-save means the entry being typed is already a real row. Keep it out
    // of the list below, or it reads as a finished entry sitting under the
    // half-written copy of itself.
    if (state.jrnDraftId) {
      rows = rows.filter(function (r) { return String(r.id) !== String(state.jrnDraftId); });
    }
    var form = state.jrnCanWrite
      ? '<div class="pj-sec"><h3>Today\'s entry <span class="pj-jrn-auto" id="jrAuto">saved automatically</span></h3>' +
        '<div class="pj-grid">' +
          '<div class="pj-f"><label>Date</label><input type="date" id="jrDate" value="' +
            esc(draft.date || jrnToday()) + '"></div>' +
          '<div class="pj-f"><label>What kind of entry</label><select id="jrCat">' +
            JRN_CATS.map(function (c) {
              return '<option' + (draft.cat === c ? " selected" : "") + ">" + esc(c) + "</option>";
            }).join("") + "</select></div>" +
          '<div class="pj-f"><label>Weather</label><input id="jrWx" placeholder="Clear, 78F" value="' + esc(draft.wx || "") + '"></div>' +
          '<div class="pj-f"><label>People on site</label><input id="jrCrew" type="number" min="0" step="1" value="' + esc(draft.crew || "") + '"></div>' +
          '<div class="pj-f"><label>Hours worked</label><input id="jrHrs" type="number" min="0" step="any" value="' + esc(draft.hrs || "") + '"></div>' +
        "</div>" +
        '<div class="pj-f full pj-jrn-row"><label>Headline</label>' +
          '<input id="jrTitle" placeholder="One line — what today was about" value="' + esc(draft.title || "") + '"></div>' +
        '<div class="pj-f full pj-jrn-row"><label>What happened</label>' +
          '<textarea id="jrBody" rows="5" placeholder="What got done, who was on site, what got in the way…">' +
          esc(draft.body || "") + "</textarea></div>" +
        '<div class="pj-links pj-jrn-row" style="align-items:center">' +
          '<label class="pj-check"><input type="checkbox" id="jrFollow"' + (draft.follow ? " checked" : "") + "> Needs follow-up</label>" +
          '<button class="pj-btn pj-btn-sm" id="jrPick">&#128247; Add photos / video</button>' +
          '<button class="pj-btn pj-btn-sm" id="jrDone">&#10003; Finish this entry</button>' +
          '<span class="pj-msg" id="jrMsg"></span>' +
        "</div>" +
        '<input type="file" id="jrInput" accept="image/*,video/*" multiple style="display:none">' +
        '<div id="jrPending"></div>' +
        "</div>"
      : "";
    pane.innerHTML =
      '<div class="pj-links" style="margin-bottom:10px">' +
        '<a class="pj-btn pj-btn-sm" id="jrReport" href="report-journal.html?id=' + encodeURIComponent(PID) +
          '&from=' + encodeURIComponent(jrnToday()) + '">&#128196; Day report (PDF / email)</a>' +
      "</div>" + form +
      (rows.length ? rows.map(jrnEntryHtml).join("")
        : '<div class="pj-empty">Nothing in the journal yet.</div>');

    wireJrnDelete();
    if (!state.jrnCanWrite) return;
    // Its photos come back too — without this the next keystroke would push an
    // empty media list and the pictures would drop off the entry they belong to.
    if (!state.jrnPending && (draft.media || []).length) {
      state.jrnPending = draft.media.map(function (m) {
        return { name: m.name, desc: m.desc || "", thumb: m.thumb || "",
                 video: !!m.video, preview: "", qid: null };
      });
    }
    jrnRenderPending();
    jrnWatchQueue();
    ["jrDate", "jrCat", "jrWx", "jrCrew", "jrHrs", "jrTitle", "jrBody", "jrFollow"]
      .forEach(function (id) {
        var n = el(id);
        if (!n) return;
        n.addEventListener("input", jrnTouched);
        n.addEventListener("change", jrnTouched);
      });
    el("jrPick").onclick = function () { el("jrInput").value = ""; el("jrInput").click(); };
    el("jrInput").onchange = function () { jrnQueueFiles(this.files); };
    el("jrDone").onclick = jrnFinish;
  }

  /* Every keystroke: keep the local copy now, push to the server shortly.
     The local write is synchronous and cannot fail on a bad connection —
     that is what makes closing the app safe. */
  var _jrnPush = null;
  function jrnDraftFromForm() {
    return {
      date: el("jrDate") ? el("jrDate").value : "",
      cat: el("jrCat") ? el("jrCat").value : "",
      wx: el("jrWx") ? el("jrWx").value : "",
      crew: el("jrCrew") ? el("jrCrew").value : "",
      hrs: el("jrHrs") ? el("jrHrs").value : "",
      title: el("jrTitle") ? el("jrTitle").value : "",
      body: el("jrBody") ? el("jrBody").value : "",
      follow: el("jrFollow") ? el("jrFollow").checked : false,
      media: (state.jrnPending || []).filter(function (m) { return m.name; })
        .map(function (m) { return { name: m.name, desc: m.desc || "", thumb: m.thumb || "", video: !!m.video }; }),
      id: state.jrnDraftId || null,
    };
  }
  function jrnTouched() {
    var d = jrnDraftFromForm();
    jrnWriteDraft(d);
    jrnStatus("saving");
    clearTimeout(_jrnPush);
    _jrnPush = setTimeout(jrnPushDraft, 900);
  }
  function jrnStatus(kind) {
    var n = el("jrAuto");
    if (!n) return;
    n.textContent = kind === "saving" ? "saving…"
      : kind === "saved" ? "saved" : kind === "error" ? "not saved — will retry"
      : "saved automatically";
    n.className = "pj-jrn-auto" + (kind === "error" ? " err" : "");
  }

  // Worth a row on the server? Only once there is something a person would be
  // upset to lose — otherwise every tab that ever opened the tab leaves junk.
  function jrnWorthKeeping(d) {
    return String(d.body || "").trim().length >= 3 ||
      String(d.title || "").trim().length >= 3 ||
      (d.media || []).length > 0;
  }

  async function jrnPushDraft() {
    var d = jrnDraftFromForm();
    if (!jrnWorthKeeping(d)) { jrnStatus(""); return; }
    var fields = {
      title: d.title || (String(d.body || "").split("\n")[0] || "").slice(0, 80),
      // noon UTC — the app's date-only convention, so a timezone never rolls
      // the day backwards
      journalDate: d.date ? d.date + "T12:00:00Z" : "",
      journalCategory: d.cat,
      journalEntry: d.body,
      journalWeather: d.wx,
      journalCrewSize: d.crew,
      journalHours: d.hrs,
      journalFollowUp: !!d.follow,
      journalMedia: JSON.stringify(d.media || []),
    };
    try {
      if (state.jrnDraftId) {
        await DCR.api("/api/portal?action=project", { method: "POST",
          body: { op: "jrnUpdate", itemId: state.jrnDraftId, fields: fields } });
      } else {
        var r = await DCR.api("/api/portal?action=project", { method: "POST",
          body: { op: "jrnAdd", projectId: PID, fields: fields } });
        state.jrnDraftId = r && r.id ? String(r.id) : null;
        d.id = state.jrnDraftId;
        jrnWriteDraft(d);
      }
      jrnStatus("saved");
    } catch (e) {
      // The local copy still holds it; try again on the next keystroke rather
      // than nagging someone who is mid-sentence.
      jrnStatus("error");
    }
  }

  /* ---- media ----------------------------------------------------------
     Files are handed to DCR.uploadQueue the moment they are picked. That call
     resolves once the bytes are on the device, not once they reach SharePoint
     — so a photo taken with no signal is already safe, and goes up by itself
     when the phone finds a connection. The entry records the file name right
     away; the picture catches up. */
  function jrnRenderPending() {
    var host = el("jrPending");
    if (!host) return;
    var list = state.jrnPending || [];
    var q = state.jrnQ || {};
    host.innerHTML = list.length
      ? '<div class="pj-jrn-media">' + list.map(function (m, i) {
          // keyed by file name, not queue id, so a reload mid-upload still
          // finds its own bytes and keeps drawing the bar
          var up = q[m.name] || null;
          var pct = up ? up.pct : 100;
          var failed = up && up.state === "failed";
          var waiting = up && up.state === "waiting";
          var label = !up ? "saved"
            : failed ? (up.error || "failed") + " — retry"
            : waiting ? (!DCR.uploadQueue.durable() ? "keep this page open"
                        : DCR.uploadQueue.online() ? "waiting…" : "held on this device")
            : pct + "%";
          // after a reload the blob URL is dead; the copy already on SharePoint
          // stands in for it
          var srv = state.jrnFiles && (state.jrnFiles[m.thumb] || state.jrnFiles[m.name]);
          var src = m.preview || (srv && srv.url) || "";
          return '<figure class="pj-jrn-fig">' +
            '<div class="pj-jrn-thumb">' +
              (src ? '<img src="' + esc(src) + '" alt="">' : "") +
              (m.video ? '<span class="pj-jrn-play">▶</span>' : "") +
              // The remove control sits in the CORNER OF THE PICTURE. It used to
              // be a full-width button directly under the caption box, which is
              // exactly where a thumb reaching for the text lands.
              '<button class="pj-jrn-x" data-jrn-rm="' + i + '" title="Remove this file">✕</button>' +
              (up && !failed ? '<span class="pj-jrn-bar"><i style="width:' + pct + '%"></i></span>' : "") +
              (up ? '<span class="pj-jrn-up' + (failed ? " err" : "") + '"' +
                    (failed ? ' data-jrn-retry="1"' : "") + ">" + esc(label) + "</span>" : "") +
            "</div>" +
            '<input class="pj-jrn-cap" data-jrn-cap="' + i + '" placeholder="Describe this photo…" value="' +
              esc(m.desc || "") + '">' +
            "</figure>";
        }).join("") + "</div>"
      : "";
    host.querySelectorAll("[data-jrn-cap]").forEach(function (inp) {
      inp.addEventListener("input", function () {
        var m = state.jrnPending[+inp.getAttribute("data-jrn-cap")];
        if (m) { m.desc = inp.value; jrnTouched(); }
      });
    });
    host.querySelectorAll("[data-jrn-rm]").forEach(function (b) {
      b.onclick = async function () {
        var i = +b.getAttribute("data-jrn-rm");
        var m = (state.jrnPending || [])[i];
        if (!m) return;
        // Always ask. A photo of something now buried behind drywall cannot be
        // taken again, and this control sits on top of the picture.
        var noun = m.video ? "video" : "photo";
        var ok = await DCR.confirm(
          "This " + noun + " will be taken off the entry" +
          (m.qid ? " and will not be uploaded." : "."),
          { title: "Remove this " + noun + "?", danger: true, okText: "Remove" });
        if (!ok) return;
        if (m.qid) { try { await DCR.uploadQueue.remove(m.qid); } catch (e) {} }
        state.jrnPending.splice(i, 1);
        jrnRenderPending();
        jrnTouched();
      };
    });
    host.querySelectorAll("[data-jrn-retry]").forEach(function (n) {
      n.onclick = function () { DCR.uploadQueue.retryAll(); };
    });
  }

  /* Watch the queue so the bars move and "held on this device" flips to a
     percentage the moment signal returns. */
  function jrnWatchQueue() {
    if (state._jrnQOff) return;
    var refresh = function () {
      DCR.uploadQueue.listFor(PID).then(function (items) {
        var map = {};
        items.forEach(function (it) { map[it.name] = it; });
        state.jrnQ = map;
        // a file that has left the queue has landed
        (state.jrnPending || []).forEach(function (m) {
          m.qid = map[m.name] ? map[m.name].id : null;
        });
        jrnRenderPending();
      });
    };
    state._jrnQOff = DCR.uploadQueue.on(refresh);
    refresh();
  }

  async function jrnQueueFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    if (!arr.length) return;
    state.jrnPending = state.jrnPending || [];
    var when = new Date();
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i];
      var kind = jrnIsVideo(f) ? "VID" : "IMG";
      // +1s each so files picked in the same second keep the order chosen
      var base = jrnStamp(new Date(when.getTime() + (state.jrnPending.length) * 1000));
      var m = {
        video: jrnIsVideo(f), desc: "", name: base + " " + kind + jrnExt(f),
        thumb: base + " " + kind + ".thumb.jpg",
        preview: URL.createObjectURL(f), qid: null,
      };
      state.jrnPending.push(m);
      jrnRenderPending();

      // Custody first: on the device before anything touches the network.
      m.qid = await DCR.uploadQueue.add({
        pid: PID, target: "journal", name: m.name, mime: f.type || "", blob: f,
        tag: "journal",
      });
      // The thumbnail is a nicety — if it cannot be built the picture still
      // uploads and the list falls back to the full size.
      try {
        var t = await jrnThumbFor(f);
        if (t && t.size) {
          await DCR.uploadQueue.add({
            pid: PID, target: "journal", name: m.thumb, mime: "image/jpeg", blob: t,
            tag: "journal-thumb",
          });
        } else m.thumb = "";
      } catch (e) { m.thumb = ""; }
      jrnTouched();          // the entry owns a file now — worth a row
    }
    jrnWatchQueue();
    jrnRenderPending();
  }

  /* "Finish" is not a save — everything is already saved. It closes the
     current entry off so the next one starts clean. */
  async function jrnFinish() {
    clearTimeout(_jrnPush);
    var d = jrnDraftFromForm();
    if (!jrnWorthKeeping(d)) {
      var msg = el("jrMsg");
      msg.className = "pj-msg err";
      msg.textContent = "Write something, or add a photo, first.";
      return;
    }
    // Pictures still going up are NOT a reason to stop. The entry already
    // holds their file names and the bytes are on the device; the queue keeps
    // working across pages and across a closed app.
    var still = (state.jrnPending || []).filter(function (m) { return m.qid; }).length;
    await jrnPushDraft();
    state.jrnDraftId = null;
    state.jrnPending = [];
    jrnWriteDraft(null);
    delete state.parts.journal;
    // awaited: it rebuilds the pane, so anything written to jrMsg before it
    // finishes is thrown away with the old node
    await loadJournal();
    if (still) {
      var m2 = el("jrMsg");
      if (m2) {
        m2.className = "pj-msg";
        var one = still === 1;
        m2.textContent = still + (one ? " file is " : " files are ") +
          (DCR.uploadQueue.online()
            ? "still uploading — " + (one ? "it finishes" : "they finish") + " on its own."
            : "saved on this device — " + (one ? "it uploads" : "they upload") +
              " as soon as you have signal.");
      }
    }
  }

  function wireJrnDelete() {
    el("pane-journal").querySelectorAll("[data-jrn-del]").forEach(function (b) {
      b.onclick = async function () {
        var ok = await DCR.confirm(
          "This cannot be undone. Any photos stay in the Project Jurnal folder.",
          { title: "Delete this journal entry?", danger: true, okText: "Delete" });
        if (!ok) return;
        try {
          await DCR.api("/api/portal?action=project", { method: "POST",
            body: { op: "jrnDelete", itemId: b.getAttribute("data-jrn-del") } });
          if (String(state.jrnDraftId) === b.getAttribute("data-jrn-del")) {
            state.jrnDraftId = null; jrnWriteDraft(null);
          }
          delete state.parts.journal;
          loadJournal();
        } catch (e) { await DCR.alert(e.message || "Could not delete the entry."); }
      };
    });
  }

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
  function fileIcon(f){ if(f.isFolder)return "📁"; if(isTakeoff(f.name))return "📐"; var m=f.mimeType||""; if(m.indexOf("image")===0)return "🖼️"; if(m.indexOf("pdf")!==-1)return "📕"; if(m.indexOf("sheet")!==-1||m.indexOf("excel")!==-1)return "📊"; if(m.indexOf("video")===0)return "🎬"; return "📄"; }

  function renderFiles(items) {
    var pane = el("pane-files");
    var crumbs = state.files.stack.map(function(s,i){
      return i===state.files.stack.length-1 ? '<b>'+esc(s.name)+'</b>' : '<a data-crumb="'+i+'">'+esc(s.name)+'</a>';
    }).join(' <span style="color:var(--text-muted)">/</span> ');
    var top = state.files.stack[state.files.stack.length-1];
    var rows = items.map(function(f){
      return '<div class="pj-file" data-fid="'+esc(f.id)+'" data-folder="'+(f.isFolder?1:0)+'" data-name="'+esc(f.name)+'" data-link="'+esc(f.webViewLink||"")+'">' +
        '<span>'+fileIcon(f)+'</span><span>'+esc(f.name)+'</span>' +
        '<span class="meta">'+fmtSize(f.size)+(f.modifiedTime?' · '+fmtDate(f.modifiedTime):"")+'</span>' +
        (f.isFolder ? "" :
          '<button class="pj-dl" data-dl="'+esc(f.id)+'" title="Download '+esc(f.name)+'" ' +
          'aria-label="Download '+esc(f.name)+'">&#11015;</button>') +
        '</div>';
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
    pane.querySelectorAll("[data-dl]").forEach(function(btn){
      btn.onclick = function(ev){
        // The row itself opens the file (PDFs go to the plan viewer), so a
        // click on the button must stop there or it would do both.
        ev.stopPropagation();
        downloadFile(btn.getAttribute("data-dl"), btn.closest(".pj-file").getAttribute("data-name"), btn);
      };
    });
    pane.querySelectorAll(".pj-file").forEach(function(row){
      row.onclick = function(){
        if (row.getAttribute("data-folder")==="1") {
          state.files.stack.push({ id: row.getAttribute("data-fid"), name: row.getAttribute("data-name"), url: row.getAttribute("data-link") || "" });
          loadFiles(row.getAttribute("data-fid"));
        } else if (isTakeoff(row.getAttribute("data-name"))) {
          openInTakeoff(row.getAttribute("data-fid"), row.getAttribute("data-name"), row);
        } else if (/\.pdf$/i.test(row.getAttribute("data-name") || "")) {
          // PDFs open in our own viewer — it measures, marks up and saves
          // notes, and it streams the file straight from SharePoint, so the
          // 56 MB plan sets that used to bounce out to the browser open here.
          location.href = "planview.html?file=" + encodeURIComponent(row.getAttribute("data-fid")) +
            "&project=" + encodeURIComponent(PID) + "&from=files";
        } else openFile(row.getAttribute("data-fid"), row.getAttribute("data-link"));
      };
    });
  }

  /* Save a file to the machine, as opposed to openFile() which views it.

     The bytes come straight from SharePoint's pre-authed downloadUrl rather
     than through /api/portal: that URL supports CORS and byte ranges and has
     no size ceiling, while the serverless route buffers the whole file and
     already answers 413 for the big ones. A 56 MB plan set is normal here.

     Small files are fetched into a blob so the saved file carries its real
     name - the `download` attribute is ignored on a cross-origin href, so a
     plain link would leave the browser to name it. Past a threshold that
     buffering is the bigger problem (a phone holding 80 MB in a tab), so
     those hand off to SharePoint, which sends its own filename. */
  var DL_BLOB_MAX = 60 * 1024 * 1024;

  /* Takeoff projects open in the web build of the estimating app.

     Where it lives is configurable, but both apps are GitHub Pages sites on
     barajas545.github.io, so the default sits beside this one. Same origin is
     not a convenience here — it is what lets the handoff go through
     sessionStorage instead of the address bar. */
  var TAKEOFF_APP = (window.DCR_CONFIG && window.DCR_CONFIG.TAKEOFF_URL) || "../takeoff-web/";

  function isTakeoff(name){ return /\.(takeoff|pdfcache)$/i.test(String(name || "")); }

  /* Open a .takeoff project without downloading it.

     The app reads a project by slicing it — header, metadata and page index
     only, about 2 KB even on a 2.3 GB job — and SharePoint’s pre-authed URL
     serves byte ranges, so it never fetches the whole file. The 155 MB Cooper
     Road plan set opens on about 40 KB. Handing over a blob instead would mean
     155 MB through a phone before the first sheet appeared.

     The link goes through sessionStorage rather than the URL: it is a
     credential, and a query string lands in history and in the Referer header.
     Only a one-shot key travels in the hash, and the app consumes it on
     arrival. The file id and token key go with it so the app can mint a fresh
     link when this one expires mid-afternoon. */
  async function openInTakeoff(fileId, fallbackName, row) {
    // Both listings show an icon, but only one of them wraps it in an element.
    var icon = row && row.firstElementChild;
    var was = icon ? icon.textContent : "";
    if (icon) icon.textContent = "⏳";
    try {
      var info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(fileId));
      if (!info || !info.downloadUrl) throw new Error("No download link for this file.");

      var key = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem("ptt.open." + key, JSON.stringify({
        v: 1,
        name: info.name || fallbackName || "project.takeoff",
        size: Number(info.size) || 0,
        url: info.downloadUrl,
        renew: {
          url: DCR.API_BASE + "/api/portal?action=drive&fileInfo=" + encodeURIComponent(fileId),
          tokenKey: "dcr_portal_token",
        },
      }));
      location.href = TAKEOFF_APP + "index.html#open=" + encodeURIComponent(key);
    } catch (e) {
      if (icon) icon.textContent = was;
      DCR.alert((e && e.message) || "Could not open that project.",
                { title: "Could not open" });
    }
  }

  async function downloadFile(fileId, fallbackName, btn) {
    var restore = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = "…"; }
    var info = null;
    try {
      info = await DCR.api("/api/portal?action=drive&fileInfo=" + encodeURIComponent(fileId));
      if (!info || !info.downloadUrl) throw new Error("No download link for this file.");
      var name = info.name || fallbackName || "download";

      if (Number(info.size) > DL_BLOB_MAX) {
        window.open(info.downloadUrl, "_blank", "noopener");
        return;
      }
      var r = await fetch(info.downloadUrl);
      if (!r.ok) throw new Error("Download failed (" + r.status + ")");
      var obj = URL.createObjectURL(await r.blob());
      var a = document.createElement("a");
      a.href = obj;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Freed on a timer, not immediately: revoking before the browser has
      // started writing cancels the save in some of them.
      setTimeout(function(){ URL.revokeObjectURL(obj); }, 60000);
    } catch (e) {
      /* Falling back to the SharePoint page is better than an error: the file
         is still reachable, just with one more click. */
      var link = (info && (info.downloadUrl || info.webUrl)) || "";
      if (link) window.open(link, "_blank", "noopener");
      else DCR.alert((e && e.message) || "Could not download that file.", { title: "Download failed" });
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = restore; }
    }
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
        else DCR.alert("File is too large to preview and has no Drive link.");
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
    // Journal media has its own folder and notes stay flat, so neither takes a
    // week folder — only the site-photo stream is filed by company week.
    var byWeek = target !== "notes" && target !== "journal";
    var s = await DCR.api("/api/portal?action=drive", { method:"POST",
      body:{ op:"uploadSession", projectId: PID, target: target, name: name, mimeType: mime,
             weekFolder: byWeek ? DCR.weekFolder() : "" } });
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
    img.onerror = function(){ DCR.alert("Could not read that image."); anNext(); };
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
    // Picking an employee fills their address, the way the Access combo does.
    //
    // An address WE filled must be replaced when the assignee changes — even
    // with a blank. Keeping it "because the box wasn't empty" is how a task
    // assigned to one person gets emailed to the last one: reassigning left
    // the previous address sitting there under a hint that said the new person
    // had none. A hand-typed address is different — that is a deliberate
    // choice and survives, which is what data-auto distinguishes.
    el("tkAssigned").addEventListener("input", function () {
      var hit = tkPerson(this.value);
      if (!hit) return;
      var box = el("tkToEmail");
      if (!box.value.trim() || box.dataset.auto === "1") {
        box.value = hit.email || "";
        box.dataset.auto = "1";
      }
      el("tkMsg").className = "pj-msg";
      el("tkMsg").textContent = hit.email || box.value.trim()
        ? "" : "No email on file for " + hit.name + " — the task will still be created, but nothing will be sent.";
    });
    el("tkToEmail").addEventListener("input", function () { this.dataset.auto = ""; });
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
      catch (e) { DCR.alert(e.message || "Upload failed"); capProg(""); }
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
        catch (e) { DCR.alert(e.message || "Upload failed"); }
        el("anSave").disabled = false;
        anNext();
      }, "image/jpeg", 0.9);
    };
    el("anOrig").onclick = async function(){
      var f = an.origFile; if (!f) return;
      var ext = (f.name.split(".").pop() || "jpg").toLowerCase();
      el("anOrig").disabled = true;
      try { await uploadToDrive(f, "pictures", "IMG "+capStamp()+"."+ext, f.type || "image/jpeg"); }
      catch (e) { DCR.alert(e.message || "Upload failed"); }
      el("anOrig").disabled = false;
      anNext();
    };
    var cv = el("anCanvas");
    cv.addEventListener("pointerdown", async function(e){
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch(ex){}
      var p = anPos(e);
      if (an.tool === "text") {
        var t = await DCR.ask("What should it say?", { title: "Add text", placeholder: "Type the label" });
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
