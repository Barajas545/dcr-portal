/* DCR portal — Floor Plans finder. Search a project → list the PDFs in its
   "Floor Plans" folder (recursive, grouped by subfolder; whole-project
   fallback when the folder doesn't exist) → open in the takeoff viewer.
   Recently opened plans (localStorage) show before any search. */

(function () {
  var state = { projects: [], byId: {}, seq: 0 };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var RECENT_KEY = "dcrPlanRecent";

  function fmtSize(n){ if(!n)return""; if(n>1048576)return (n/1048576).toFixed(1)+" MB"; if(n>1024)return Math.round(n/1024)+" KB"; return n+" B"; }
  function fmtDate(v){ if(!v)return ""; var d=new Date(v); return isNaN(d)?"":d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function projLabel(p){
    return [(p.internalIDNumber||"")+" — "+(p.projectName||""), p.projectClientName,
      [p.projectAddress,p.projectCity].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  }

  function recents(){ try { return JSON.parse(localStorage.getItem(RECENT_KEY)||"[]"); } catch(e){ return []; } }

  function fileRow(f, pid) {
    return '<div class="fp-file" data-file="'+esc(f.id)+'" data-pid="'+esc(pid)+'">' +
      '<span class="ic">📄</span><div class="nm"><div class="t">'+esc(f.name)+'</div>' +
      '<div class="m">'+[fmtSize(f.size), fmtDate(f.modifiedTime)].filter(Boolean).join(" · ")+'</div></div>' +
      (f.hasNotes ? '<span class="fp-badge">📝 has notes</span>' : "") + '</div>';
  }

  function wireRows() {
    el("fpList").querySelectorAll("[data-file]").forEach(function(r){
      r.onclick = function(){
        location.href = "planview.html?file="+encodeURIComponent(r.getAttribute("data-file"))+
          "&project="+encodeURIComponent(r.getAttribute("data-pid"));
      };
    });
  }

  function showRecents() {
    var rec = recents();
    if (!rec.length) return;
    el("fpList").innerHTML = '<div class="fp-grp">🕑 Recently opened</div>' +
      rec.map(function(r){ return fileRow({ id:r.id, name:r.name, size:r.size, modifiedTime:null, hasNotes:r.hasNotes }, r.pid); }).join("");
    wireRows();
  }

  async function loadPlans(p) {
    var my = ++state.seq;
    el("fpSub").textContent = "";
    el("fpList").innerHTML = '<div class="fp-empty">Searching '+esc(p.internalIDNumber||"")+" plans…</div>";
    try {
      var d = await DCR.api("/api/portal?action=drive&plansFor="+encodeURIComponent(p.id));
      if (my !== state.seq) return;
      var files = d.files || [];
      el("fpSub").textContent = (p.internalIDNumber||"")+" — "+(p.projectName||"")+" · "+files.length+" PDF"+(files.length===1?"":"s");
      if (!files.length) {
        el("fpList").innerHTML = '<div class="fp-empty">No PDF plans found for this project.</div>';
        return;
      }
      var note = d.folderFound ? "" :
        '<div class="fp-note">This project has no "Floor Plans" folder — showing all PDFs in the project folder.</div>';
      // group by subfolder path, root first
      var groups = [], gIdx = {};
      files.forEach(function(f){
        var g = f.path || "";
        if (!(g in gIdx)) { gIdx[g] = groups.length; groups.push({ path:g, rows:[] }); }
        groups[gIdx[g]].rows.push(f);
      });
      groups.sort(function(a,b){ return (a.path?1:0)-(b.path?1:0) || a.path.localeCompare(b.path); });
      el("fpList").innerHTML = note + groups.map(function(g){
        return '<div class="fp-grp">📁 '+esc(g.path || (d.folderFound ? "Floor Plans" : "Project folder"))+'</div>' +
          g.rows.map(function(f){ return fileRow(f, p.id); }).join("");
      }).join("");
      wireRows();
    } catch (e) {
      if (my !== state.seq) return;
      el("fpList").innerHTML = '<div class="fp-empty">'+esc(e.message||"Search failed.")+'</div>';
    }
  }

  function trySearch() {
    var v = el("fpSearch").value.trim().toLowerCase();
    if (!v) { showRecents(); return; }
    var hit = state.projects.find(function(p){ return projLabel(p).toLowerCase() === v; })
      || state.projects.find(function(p){ return String(p.internalIDNumber||"").toLowerCase() === v; })
      || state.projects.find(function(p){ return projLabel(p).toLowerCase().indexOf(v) !== -1; });
    if (hit) loadPlans(hit);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    el("fpSearch").addEventListener("change", trySearch);
    el("fpSearch").addEventListener("keydown", function(e){ if (e.key==="Enter") trySearch(); });
    showRecents();
    try {
      var b = await DCR.api("/api/portal?action=board");
      state.projects = b.projects||[];
      state.projects.forEach(function(p){ state.byId[String(p.id)] = p; });
      el("fpProjects").innerHTML = state.projects.map(function(p){
        return '<option value="'+esc(projLabel(p))+'"></option>';
      }).join("");
    } catch (e) { /* search degrades */ }
  });
})();
