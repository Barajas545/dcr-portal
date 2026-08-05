/* DCR portal — Sales Leads (unique piece of the Access SalesBoard).
   Data via action=leads; convert-to-project composes the existing
   action=board op:create + a leadUpdate flag. */

(function () {
  var state = { leads: [], canWrite: false, search: "", cat: "all", editing: null, converting: null };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  function fmtDate(v){ if(!v)return "—"; var d=new Date(v); return isNaN(d)?String(v):d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function dateInputVal(v){ if(!v)return ""; var d=new Date(v); return isNaN(d)?"":d.toISOString().slice(0,10); }
  function daysSince(v){ if(!v)return null; var d=new Date(v); if(isNaN(d))return null; return Math.floor((Date.now()-d)/86400000); }

  var LEAD_FIELDS = ["leadClientName","leadClientPhone","leadClientAddress","leadProjectName","leadCategory","leadSource","leadNotes"];

  function contactedBadge(l) {
    var days = daysSince(l.leadLastcontactedDate);
    if (days == null) return '<span class="ld-age over">never contacted</span>';
    var cls = days > 30 ? "over" : (days > 14 ? "warn" : "ok");
    var txt = days === 0 ? "contacted today" : "contacted " + days + "d ago";
    return '<span class="ld-age ' + cls + '">' + txt + "</span>";
  }

  function render() {
    var q = state.search.toLowerCase();
    var cats = {};
    state.leads.forEach(function(l){ cats[l.leadCategory || "Uncategorized"] = 1; });
    el("ldChips").innerHTML = ['all'].concat(Object.keys(cats).sort()).map(function(c){
      var label = c === "all" ? "All (" + state.leads.length + ")" : c;
      return '<span class="ld-chip'+(state.cat===c?" on":"")+'" data-cat="'+esc(c)+'">'+esc(label)+'</span>';
    }).join("");
    el("ldChips").querySelectorAll("[data-cat]").forEach(function(ch){
      ch.onclick = function(){ state.cat = ch.getAttribute("data-cat"); render(); };
    });

    var rows = state.leads.filter(function(l){
      if (state.cat !== "all" && (l.leadCategory || "Uncategorized") !== state.cat) return false;
      if (!q) return true;
      return [l.leadClientName,l.leadClientPhone,l.leadClientAddress,l.leadProjectName,l.leadCategory,l.leadSource,l.leadNotes].join(" ").toLowerCase().indexOf(q) !== -1;
    }).sort(function(a,b){ return new Date(b.leadDate||0) - new Date(a.leadDate||0); });

    el("ldList").innerHTML = rows.map(function(l){
      var acts = state.canWrite ? '<div class="ld-actions">' +
        '<button class="ld-btn ld-btn-sm" data-touch="'+l.id+'">📞 Contacted today</button>' +
        '<button class="ld-btn ld-btn-sm" data-conv="'+l.id+'">→ Convert to project</button>' +
        '<button class="ld-btn ld-btn-sm" data-edit="'+l.id+'">✎ Edit</button>' +
        '<button class="ld-btn ld-btn-sm" data-del="'+l.id+'">🗑</button></div>' : "";
      return '<div class="ld-card"><div class="ld-top">' +
        '<span class="ld-name">'+esc(l.leadClientName || "(no name)")+'</span>' +
        (l.leadCategory?'<span class="ld-cat">'+esc(l.leadCategory)+'</span>':"") +
        (l.leadCreateEstimate?'<span class="ld-flag">✔ estimate created</span>':"") +
        contactedBadge(l) + '</div>' +
        '<div class="ld-meta">' +
          [l.leadProjectName ? "Project: "+esc(l.leadProjectName) : "",
           l.leadClientPhone ? '<a href="tel:'+esc(l.leadClientPhone)+'">'+esc(l.leadClientPhone)+'</a>' : "",
           l.leadClientAddress ? esc(l.leadClientAddress) : "",
           l.leadSource ? "via "+esc(l.leadSource) : "",
           "lead date "+fmtDate(l.leadDate)].filter(Boolean).join(" · ") + '</div>' +
        (l.leadNotes?'<div class="ld-notes">'+esc(l.leadNotes)+'</div>':"") + acts + '</div>';
    }).join("") || '<div class="ld-empty">No leads' + (state.cat!=="all"||q ? " match your filters." : " yet.") + '</div>';

    el("ldList").querySelectorAll("[data-touch]").forEach(function(b){ b.onclick=function(){ touchLead(b.getAttribute("data-touch")); }; });
    el("ldList").querySelectorAll("[data-edit]").forEach(function(b){ b.onclick=function(){ openModal(b.getAttribute("data-edit")); }; });
    el("ldList").querySelectorAll("[data-conv]").forEach(function(b){ b.onclick=function(){ openConvert(b.getAttribute("data-conv")); }; });
    el("ldList").querySelectorAll("[data-del]").forEach(function(b){ b.onclick=function(){ delLead(b.getAttribute("data-del")); }; });
  }

  /* ── actions ── */
  async function touchLead(id) {
    try {
      await DCR.api("/api/portal?action=leads", { method:"POST", body:{ op:"leadTouch", itemId:id } });
      var l = state.leads.find(function(x){ return String(x.id)===String(id); });
      if (l) l.leadLastcontactedDate = new Date().toISOString();
      render();
    } catch (e) { DCR.alert(e.message || "Update failed"); }
  }

  function openModal(id) {
    state.editing = id ? state.leads.find(function(x){ return String(x.id)===String(id); }) : null;
    el("ldModalTitle").textContent = id ? "Edit lead" : "New lead";
    el("ldModalMsg").textContent = "";
    LEAD_FIELDS.forEach(function(f){
      el("lf_"+f).value = state.editing ? (state.editing[f] || "") : "";
    });
    el("lf_leadDate").value = state.editing ? dateInputVal(state.editing.leadDate) : new Date().toISOString().slice(0,10);
    var cats={}, srcs={};
    state.leads.forEach(function(l){ if(l.leadCategory)cats[l.leadCategory]=1; if(l.leadSource)srcs[l.leadSource]=1; });
    el("ldCats").innerHTML = Object.keys(cats).map(function(c){ return '<option value="'+esc(c)+'">'; }).join("");
    el("ldSrcs").innerHTML = Object.keys(srcs).map(function(c){ return '<option value="'+esc(c)+'">'; }).join("");
    el("ldModal").classList.add("open");
  }

  async function saveModal() {
    var fields = {};
    LEAD_FIELDS.forEach(function(f){ var v = el("lf_"+f).value.trim(); if (v !== "") fields[f] = v; });
    if (el("lf_leadDate").value) fields.leadDate = el("lf_leadDate").value + "T12:00:00Z";
    if (!fields.leadClientName) { el("ldModalMsg").textContent = "Client name is required."; return; }
    el("ldSave").disabled = true;
    try {
      var body = state.editing
        ? { op:"leadUpdate", itemId: state.editing.id, fields: fields }
        : { op:"leadAdd", fields: fields };
      await DCR.api("/api/portal?action=leads", { method:"POST", body: body });
      el("ldModal").classList.remove("open");
      await load();
    } catch (e) { el("ldModalMsg").textContent = e.message || "Save failed"; }
    el("ldSave").disabled = false;
  }

  async function delLead(id) {
    if (!(await DCR.confirm("This cannot be undone.", { title: "Delete this lead?", danger: true, okText: "Delete" }))) return;
    try {
      await DCR.api("/api/portal?action=leads", { method:"POST", body:{ op:"leadDelete", itemId:id } });
      await load();
    } catch (e) { DCR.alert(e.message || "Delete failed"); }
  }

  /* ── convert to project ── */
  function openConvert(id) {
    state.converting = state.leads.find(function(x){ return String(x.id)===String(id); });
    if (!state.converting) return;
    el("cvMsg").textContent = "";
    el("cvId").value = "";
    el("cvName").value = state.converting.leadProjectName || (state.converting.leadClientName ? state.converting.leadClientName + " Residence" : "");
    el("cvAddr").value = state.converting.leadClientAddress || "";
    el("cvCity").value = "";
    el("cvModal").classList.add("open");
    el("cvId").focus();
  }

  async function doConvert() {
    var idNum = el("cvId").value.trim(), name = el("cvName").value.trim();
    if (!idNum || !name) { el("cvMsg").textContent = "Internal ID and project name are required."; return; }
    el("cvGo").disabled = true;
    try {
      await DCR.api("/api/portal?action=board", { method:"POST", body:{
        op:"create", internalIDNumber: idNum, projectName: name,
        projectAddress: el("cvAddr").value.trim(), projectCity: el("cvCity").value.trim(),
      }});
      var note = (state.converting.leadNotes ? state.converting.leadNotes + "\n" : "") +
        "Converted to project " + idNum + " on " + new Date().toLocaleDateString("en-US");
      await DCR.api("/api/portal?action=leads", { method:"POST", body:{
        op:"leadUpdate", itemId: state.converting.id,
        fields: { leadCreateEstimate: true, leadNotes: note, projectID: idNum },
      }});
      el("cvModal").classList.remove("open");
      await load();
    } catch (e) { el("cvMsg").textContent = e.message || "Convert failed"; }
    el("cvGo").disabled = false;
  }

  /* ── data ── */
  async function load() {
    try {
      var d = await DCR.api("/api/portal?action=leads");
      state.leads = d.leads || [];
      state.canWrite = !!d.canWrite;
      el("ldNewBtn").style.display = state.canWrite ? "" : "none";
      render();
    } catch (e) {
      el("ldList").innerHTML = '<div class="ld-empty">'+esc(e.message||"Error loading leads.")+'</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    el("ldSearch").addEventListener("input", function(){ state.search = this.value; render(); });
    el("ldRefresh").onclick = load;
    el("ldNewBtn").onclick = function(){ openModal(null); };
    el("ldCancel").onclick = function(){ el("ldModal").classList.remove("open"); };
    el("ldSave").onclick = saveModal;
    el("cvCancel").onclick = function(){ el("cvModal").classList.remove("open"); };
    el("cvGo").onclick = doConvert;
    [el("ldModal"), el("cvModal")].forEach(function(m){ m.addEventListener("click", function(e){ if(e.target===m) m.classList.remove("open"); }); });
    await load();
  });
})();
