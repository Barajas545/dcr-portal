/* DCR portal — Log History: today's (or any window's) project logs grouped by
   project, plus a project search for a single project's full log history.
   Data: action=board&logsSince/logsUntil (window mode) or &logs=<id>&top=300
   (project mode); project names joined from the board list. */

(function () {
  var state = { projects: [], byId: {}, filter: "today", logs: [], projMode: null, seq: 0 };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  var FILTERS = [
    ["today","Today"], ["morning","Morning"], ["afternoon","Afternoon"],
    ["yesterday","Yesterday"], ["week","This week"], ["lastweek","Last week"], ["month","This month"],
  ];

  function fmtWhen(v){
    if (!v) return "—";
    var d = new Date(v); if (isNaN(d)) return String(v);
    var day = d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
    var hasTime = d.getHours() || d.getMinutes() || d.getSeconds();
    return hasTime ? day+" · "+d.toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}) : day;
  }
  function startOfDay(d){ var x=new Date(d); x.setHours(0,0,0,0); return x; }
  function satOfWeek(d){ var x=startOfDay(d); var day=x.getDay(); x.setDate(x.getDate()-(day===6?0:day+1)); return x; }

  // [since, until) for each filter, in local time.
  function windowFor(f) {
    var now = new Date(), today = startOfDay(now);
    var noon = new Date(today); noon.setHours(12);
    var tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
    switch (f) {
      case "today":     return [today, tomorrow];
      case "morning":   return [today, noon];
      case "afternoon": return [noon, tomorrow];
      case "yesterday": { var y=new Date(today); y.setDate(y.getDate()-1); return [y, today]; }
      case "week":      return [satOfWeek(now), tomorrow];
      case "lastweek":  { var s=satOfWeek(now); var p=new Date(s); p.setDate(p.getDate()-7); return [p, s]; }
      case "month":     { var m=new Date(today.getFullYear(), today.getMonth(), 1); return [m, tomorrow]; }
      default:          return [today, tomorrow];
    }
  }

  function projLabel(p){
    return [(p.internalIDNumber||"")+" — "+(p.projectName||""), p.projectClientName,
      [p.projectAddress,p.projectCity].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  }
  function projTitle(pid, fallbackName){
    var p = state.byId[String(pid)];
    if (p) return (p.internalIDNumber||"")+" — "+(p.projectName||"");
    return fallbackName || ("Project "+pid);
  }

  function render() {
    // chips
    el("lgChips").innerHTML = FILTERS.map(function(f){
      return '<span class="lg-chip'+(!state.projMode && state.filter===f[0]?" on":"")+'" data-f="'+f[0]+'">'+f[1]+'</span>';
    }).join("");
    el("lgChips").querySelectorAll("[data-f]").forEach(function(c){
      c.onclick = function(){
        state.projMode = null; el("lgSearch").value = "";
        state.filter = c.getAttribute("data-f");
        load();
      };
    });

    var logs = state.logs;
    if (!logs.length) {
      el("lgList").innerHTML = '<div class="lg-empty">No log entries '+(state.projMode?"for this project.":"in this period.")+'</div>';
      return;
    }

    // group by project, newest group first
    var groups = [], idx = {};
    logs.forEach(function(l){
      var key = String(l.projectID||"?");
      if (!(key in idx)) { idx[key] = groups.length; groups.push({ pid:key, name:projTitle(l.projectID, l.projectName), rows:[] }); }
      groups[idx[key]].rows.push(l);
    });

    el("lgList").innerHTML = groups.map(function(g){
      var p = state.byId[g.pid] || {};
      var sub = [p.projectAddress, p.projectCity, p.projectClientName].filter(Boolean).join(" · ");
      return '<div class="lg-proj">' +
        '<div class="lg-proj-head" data-open="'+esc(g.pid)+'" title="Open project logs">' +
          '<span class="lg-proj-name">'+esc(g.name)+'</span>' +
          '<span class="lg-proj-sub">'+esc(sub)+'</span>' +
          '<span class="lg-count">'+g.rows.length+'</span></div>' +
        g.rows.map(function(l){
          return '<div class="lg-entry"><div class="lg-when">'+fmtWhen(l.logDate)+'</div>' +
            '<div class="lg-text">'+esc(l.logDescription||"")+'</div>' +
            (l.logUserName?'<div class="lg-user">— '+esc(l.logUserName)+'</div>':"")+'</div>';
        }).join("") + '</div>';
    }).join("");

    el("lgList").querySelectorAll("[data-open]").forEach(function(h){
      h.onclick = function(){ location.href = "project.html?id="+encodeURIComponent(h.getAttribute("data-open"))+"&tab=logs"; };
    });
  }

  async function load() {
    var my = ++state.seq;
    el("lgList").innerHTML = '<div class="lg-empty">Loading…</div>';
    try {
      if (state.projMode) {
        var d = await DCR.api("/api/portal?action=board&logs="+encodeURIComponent(state.projMode.id)+"&top=300");
        if (my !== state.seq) return;
        state.logs = (d.logs||[]).map(function(l){ l.projectID = state.projMode.id; return l; });
        el("lgSub").textContent = "Full log history — " + projTitle(state.projMode.id) + " ("+state.logs.length+" entries)";
      } else {
        var w = windowFor(state.filter);
        var q = "logsSince="+encodeURIComponent(w[0].toISOString())+"&logsUntil="+encodeURIComponent(w[1].toISOString());
        var d2 = await DCR.api("/api/portal?action=board&"+q);
        if (my !== state.seq) return;
        state.logs = d2.logs||[];
        var label = FILTERS.filter(function(f){ return f[0]===state.filter; })[0][1];
        el("lgSub").textContent = label + " — " + state.logs.length + " entr" + (state.logs.length===1?"y":"ies") +
          " across " + new Set(state.logs.map(function(l){ return String(l.projectID); })).size + " project(s)";
      }
      render();
    } catch (e) {
      if (my !== state.seq) return;
      el("lgList").innerHTML = '<div class="lg-empty">'+esc(e.message||"Could not load logs.")+'</div>';
    }
  }

  function trySearch() {
    var v = el("lgSearch").value.trim().toLowerCase();
    if (!v) { if (state.projMode) { state.projMode = null; load(); } render(); return; }
    var hit = state.projects.find(function(p){ return projLabel(p).toLowerCase() === v; })
      || state.projects.find(function(p){ return String(p.internalIDNumber||"").toLowerCase() === v; })
      || state.projects.find(function(p){ return projLabel(p).toLowerCase().indexOf(v) !== -1; });
    if (hit) { state.projMode = { id: hit.id }; load(); }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    el("lgRefresh").onclick = load;
    el("lgSearch").addEventListener("change", trySearch);
    el("lgSearch").addEventListener("keydown", function(e){ if (e.key==="Enter") trySearch(); });
    el("lgSearch").addEventListener("input", function(){ if (!this.value.trim() && state.projMode) { state.projMode=null; load(); } });

    try {
      var b = await DCR.api("/api/portal?action=board");
      state.projects = b.projects||[];
      state.projects.forEach(function(p){ state.byId[String(p.id)] = p; });
      el("lgProjects").innerHTML = state.projects.map(function(p){
        return '<option value="'+esc(projLabel(p))+'"></option>';
      }).join("");
    } catch (e) { /* names degrade gracefully */ }
    load();
  });
})();
