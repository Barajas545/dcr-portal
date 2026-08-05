/* DCR portal — Marketing Tasks (unique piece of the Access MarketingBoard).
   Billable marketing work: price + Done/Invoiced/Paid tracking via action=mtasks.
   NOTE: field keys mirror SharePoint's actual (misspelled) column names:
   marketingTaskCaterogy, marketingTaskDescripiton. */

(function () {
  var state = { tasks: [], projects: {}, projList: [], canWrite: false, search: "", filter: "open", editing: null };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  function fmtDate(v){ if(!v)return "—"; var d=new Date(v); return isNaN(d)?String(v):d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function dateInputVal(v){ if(!v)return ""; var d=new Date(v); return isNaN(d)?"":d.toISOString().slice(0,10); }
  function fmtMoney(n){ return "$" + (Number(n)||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}); }
  function num(v){ var n=parseFloat(String(v??"").replace(/[$,]/g,"")); return isFinite(n)?n:0; }
  function isOn(v){ return v===true || v==="true"; }

  var FILTERS = [
    ["open","Open"], ["completed","Completed"], ["uninvoiced","Not invoiced"],
    ["unpaid","Not paid"], ["all","All"],
  ];

  function passes(t) {
    var done = isOn(t.marketingTaskMarkComplete), inv = isOn(t.marketingTaskCheckInvoiced), paid = isOn(t.marketingTaskCheckPaid);
    switch (state.filter) {
      case "open": return !done;
      case "completed": return done;
      case "uninvoiced": return done && !inv;
      case "unpaid": return inv && !paid;
      default: return true;
    }
  }

  function projName(pid) {
    if (!pid) return "General / no project";
    var p = state.projects[String(pid)];
    return p ? ((p.internalIDNumber||"") + " — " + (p.projectName||"")) : ("Project " + pid);
  }

  function render() {
    el("mkChips").innerHTML = FILTERS.map(function(f){
      return '<span class="mk-chip'+(state.filter===f[0]?" on":"")+'" data-f="'+f[0]+'">'+f[1]+'</span>';
    }).join("");
    el("mkChips").querySelectorAll("[data-f]").forEach(function(ch){
      ch.onclick = function(){ state.filter = ch.getAttribute("data-f"); render(); };
    });

    // totals across ALL tasks (independent of filter)
    var t = { open:0, uninv:0, unpaid:0, paid:0 };
    state.tasks.forEach(function(x){
      var p = num(x.marketingTaskPrice);
      var done = isOn(x.marketingTaskMarkComplete), inv = isOn(x.marketingTaskCheckInvoiced), paid = isOn(x.marketingTaskCheckPaid);
      if (!done) t.open += p;
      else if (!inv) t.uninv += p;
      else if (!paid) t.unpaid += p;
      else t.paid += p;
    });
    el("mkTotals").innerHTML =
      'Open: <b>'+fmtMoney(t.open)+'</b> · Done, not invoiced: <b>'+fmtMoney(t.uninv)+'</b> · ' +
      'Invoiced, not paid: <b>'+fmtMoney(t.unpaid)+'</b> · Paid: <b style="color:var(--ok)">'+fmtMoney(t.paid)+'</b>';

    var q = state.search.toLowerCase();
    var rows = state.tasks.filter(function(x){
      if (!passes(x)) return false;
      if (!q) return true;
      return [x.marketingTaskName, x.marketingTaskCaterogy, x.marketingTaskDescripiton, projName(x.projectID)].join(" ").toLowerCase().indexOf(q) !== -1;
    });

    if (!rows.length) { el("mkList").innerHTML = '<div class="mk-empty">No tasks match.</div>'; return; }

    var groups = {};
    rows.forEach(function(x){ var g = projName(x.projectID); (groups[g]=groups[g]||[]).push(x); });
    var cols = state.canWrite ? 8 : 7;
    var body = "";
    Object.keys(groups).sort().forEach(function(g){
      body += '<tr class="mk-grp"><td colspan="'+cols+'">'+esc(g)+'</td></tr>';
      groups[g].sort(function(a,b){ return new Date(b.marketingTaskDate||0)-new Date(a.marketingTaskDate||0); }).forEach(function(x){
        body += '<tr><td>'+esc(x.marketingTaskName||"—")+
          (x.marketingTaskDescripiton?'<br><span style="color:var(--text-muted);font-size:11.5px">'+esc(x.marketingTaskDescripiton)+'</span>':"")+'</td>' +
          '<td>'+esc(x.marketingTaskCaterogy||"")+'</td><td>'+fmtDate(x.marketingTaskDate)+'</td>' +
          '<td class="num">'+(num(x.marketingTaskPrice)?fmtMoney(x.marketingTaskPrice):"")+'</td>' +
          '<td>'+tgl(x,"marketingTaskMarkComplete","✓ Done")+'</td>' +
          '<td>'+tgl(x,"marketingTaskCheckInvoiced","Invoiced")+'</td>' +
          '<td>'+tgl(x,"marketingTaskCheckPaid","Paid")+'</td>' +
          (state.canWrite?'<td><div style="display:flex;gap:4px"><button class="mk-btn mk-btn-sm" data-edit="'+x.id+'">✎</button><button class="mk-btn mk-btn-sm" data-del="'+x.id+'">🗑</button></div></td>':"") +
          '</tr>';
      });
    });
    el("mkList").innerHTML = '<div class="mk-tblwrap"><table class="mk-tbl"><thead><tr>' +
      '<th>Task</th><th>Category</th><th>Date</th><th class="num">Price</th><th>Done</th><th>Invoiced</th><th>Paid</th>'+(state.canWrite?'<th></th>':"")+'</tr></thead><tbody>'+body+'</tbody></table></div>';

    el("mkList").querySelectorAll("[data-tgl]").forEach(function(b){
      b.onclick = function(){ toggle(b.getAttribute("data-tgl"), b.getAttribute("data-field")); };
    });
    el("mkList").querySelectorAll("[data-edit]").forEach(function(b){ b.onclick=function(){ openModal(b.getAttribute("data-edit")); }; });
    el("mkList").querySelectorAll("[data-del]").forEach(function(b){ b.onclick=function(){ delTask(b.getAttribute("data-del")); }; });
  }

  function tgl(x, field, label) {
    var on = isOn(x[field]);
    if (!state.canWrite) return '<span class="mk-tgl ro'+(on?" on":"")+'">'+label+'</span>';
    return '<span class="mk-tgl'+(on?" on":"")+'" data-tgl="'+x.id+'" data-field="'+field+'">'+label+'</span>';
  }

  async function toggle(id, field) {
    var x = state.tasks.find(function(r){ return String(r.id)===String(id); });
    if (!x) return;
    var newVal = !isOn(x[field]);
    var fields = {}; fields[field] = newVal;
    try {
      await DCR.api("/api/portal?action=mtasks", { method:"POST", body:{ op:"mtUpdate", itemId:id, fields:fields } });
      x[field] = newVal;
      if (field==="marketingTaskMarkComplete" && newVal && !x.marketingTaskCompletedDate) x.marketingTaskCompletedDate = new Date().toISOString();
      render();
    } catch (e) { DCR.alert(e.message || "Update failed"); }
  }

  /* ── modal ── */
  var MT_TEXT = ["marketingTaskName","marketingTaskCaterogy","marketingTaskDescripiton","marketingTaskCompletedWork"];

  function openModal(id) {
    state.editing = id ? state.tasks.find(function(x){ return String(x.id)===String(id); }) : null;
    el("mkModalTitle").textContent = id ? "Edit marketing task" : "New marketing task";
    el("mkModalMsg").textContent = "";
    MT_TEXT.forEach(function(f){ el("mf_"+f).value = state.editing ? (state.editing[f] || "") : ""; });
    el("mf_marketingTaskDate").value = state.editing ? dateInputVal(state.editing.marketingTaskDate) : new Date().toISOString().slice(0,10);
    el("mf_marketingTaskPrice").value = state.editing ? (state.editing.marketingTaskPrice ?? "") : "";
    el("mf_project").value = state.editing ? (state.editing.projectID ? projName(state.editing.projectID) : "") : "";
    el("mkProjects").innerHTML = state.projList.map(function(p){
      return '<option value="'+esc((p.internalIDNumber||"")+" — "+(p.projectName||""))+'">';
    }).join("");
    var cats = {};
    state.tasks.forEach(function(x){ if(x.marketingTaskCaterogy) cats[x.marketingTaskCaterogy]=1; });
    el("mkCats").innerHTML = Object.keys(cats).map(function(c){ return '<option value="'+esc(c)+'">'; }).join("");
    el("mkModal").classList.add("open");
  }

  function resolveProjectId(text) {
    var v = String(text||"").trim().toLowerCase();
    if (!v) return "";
    var hit = state.projList.find(function(p){
      return ((p.internalIDNumber||"")+" — "+(p.projectName||"")).toLowerCase() === v ||
             String(p.internalIDNumber||"").toLowerCase() === v;
    });
    return hit ? String(hit.id) : "";
  }

  async function saveModal() {
    var fields = {};
    MT_TEXT.forEach(function(f){ var v = el("mf_"+f).value.trim(); if (v!=="") fields[f]=v; });
    if (!fields.marketingTaskName) { el("mkModalMsg").textContent = "Task name is required."; return; }
    if (el("mf_marketingTaskDate").value) fields.marketingTaskDate = el("mf_marketingTaskDate").value + "T12:00:00Z";
    if (el("mf_marketingTaskPrice").value !== "") fields.marketingTaskPrice = Number(el("mf_marketingTaskPrice").value);
    var pid = resolveProjectId(el("mf_project").value);
    if (pid) fields.projectID = pid;
    el("mkSave").disabled = true;
    try {
      var body = state.editing
        ? { op:"mtUpdate", itemId: state.editing.id, fields: fields }
        : { op:"mtAdd", fields: fields };
      await DCR.api("/api/portal?action=mtasks", { method:"POST", body: body });
      el("mkModal").classList.remove("open");
      await load();
    } catch (e) { el("mkModalMsg").textContent = e.message || "Save failed"; }
    el("mkSave").disabled = false;
  }

  async function delTask(id) {
    if (!(await DCR.confirm("This cannot be undone.", { title: "Delete this marketing task?", danger: true, okText: "Delete" }))) return;
    try {
      await DCR.api("/api/portal?action=mtasks", { method:"POST", body:{ op:"mtDelete", itemId:id } });
      await load();
    } catch (e) { DCR.alert(e.message || "Delete failed"); }
  }

  /* ── data ── */
  async function load() {
    try {
      var results = await Promise.all([
        DCR.api("/api/portal?action=mtasks"),
        DCR.api("/api/portal?action=board").catch(function(){ return { projects: [] }; }),
      ]);
      state.tasks = results[0].tasks || [];
      state.canWrite = !!results[0].canWrite;
      state.projList = results[1].projects || [];
      state.projects = {};
      state.projList.forEach(function(p){ state.projects[String(p.id)] = p; });
      el("mkNewBtn").style.display = state.canWrite ? "" : "none";
      render();
    } catch (e) {
      el("mkList").innerHTML = '<div class="mk-empty">'+esc(e.message||"Error loading tasks.")+'</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    el("mkSearch").addEventListener("input", function(){ state.search = this.value; render(); });
    el("mkRefresh").onclick = load;
    el("mkNewBtn").onclick = function(){ openModal(null); };
    el("mkCancel").onclick = function(){ el("mkModal").classList.remove("open"); };
    el("mkSave").onclick = saveModal;
    el("mkModal").addEventListener("click", function(e){ if(e.target===this) this.classList.remove("open"); });
    await load();
  });
})();
