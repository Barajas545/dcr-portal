/* DCR portal — printable weekly Time Card (web port of
   AccountingTimeSheetIndividualONTimeCARD). Frontend-only: action=roster for the
   scoped employee picker, action=timesheets for the two-week window. */

(function () {
  var qs = new URLSearchParams(location.search);
  var CO = DCR.companyInfo;
  var LOGO = CO.logo;

  function coBlock() {
    var lines = ["<b>" + DCR.esc(CO.legalName || CO.name) + "</b>"];
    if (CO.address) lines.push(DCR.esc(CO.address));
    var pf = [CO.phone ? "Ph " + CO.phone : "", CO.fax ? "Fax " + CO.fax : ""].filter(Boolean).join(" · ");
    if (pf) lines.push(DCR.esc(pf));
    if (CO.license) lines.push(DCR.esc(CO.license));
    return lines.join("<br>");
  }
  var LEAVE_TYPES = ["Holiday", "Vacation", "Sick", "Day Off"];
  var state = { items: [], employees: [], emp: qs.get("emp") || "", week: "this" };

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  function num(v){ var n=parseFloat(v); return isFinite(n)?n:0; }

  /* time helpers (same conventions as the timesheet pages) */
  function tsParseSpTime(iso){ if(!iso) return null; var d=new Date(iso); if(isNaN(d)) return null; return {hours:d.getHours(),minutes:d.getMinutes()}; } // wall-clock time via the stored instant's own UTC offset (no DST re-anchoring — see timesheet.js)
  function clock(iso){ var t=tsParseSpTime(iso); if(!t) return ""; var a=t.hours>=12?"PM":"AM"; var h=t.hours%12||12; return h+":"+String(t.minutes).padStart(2,"0")+a; }
  function fmtDate(v){ if(!v) return ""; var d=new Date(v); return isNaN(d)?"":d.toISOString().split("T")[0]; }
  function getSaturdayOf(date){ var d=new Date(date); d.setHours(0,0,0,0); var day=d.getDay(); d.setDate(d.getDate()-(day===6?0:day+1)); return d; }
  function niceDay(d){ return d.toLocaleDateString("en-US",{weekday:"long"}); }
  function niceDate(d){ return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}); }

  function weekStart() {
    var thisSat = getSaturdayOf(new Date());
    if (state.week === "last") { var p = new Date(thisSat); p.setDate(p.getDate() - 7); return p; }
    return thisSat;
  }

  function render() {
    var emp = state.emp;
    if (!emp) { el("tcSheet").innerHTML = '<div class="rp-loading">Choose an employee above.</div>'; return; }
    var start = weekStart();
    var end = new Date(start); end.setDate(end.getDate() + 6);
    document.title = "DCR Time Card — " + emp;

    var total = 0;
    var rows = "";
    for (var i = 0; i < 7; i++) {
      var d = new Date(start); d.setDate(d.getDate() + i);
      var key = d.toISOString().split("T")[0];
      var dayItems = state.items.filter(function (x) {
        return fmtDate(x.timeSheetDate) === key &&
          String(x.timeSheetEmployeeName || "").toLowerCase() === emp.toLowerCase();
      });
      var dayHours = 0;
      var cells = dayItems.map(function (x) {
        var hrs = num(x.timeSheetWorkHours); dayHours += hrs;
        var proj = x.timeSheetProjectName || "";
        var leave = LEAVE_TYPES.indexOf(proj) !== -1;
        var sched = "";
        if (!leave && x.timeSheetWorkStatTime) {
          sched = clock(x.timeSheetWorkStatTime) + "–" + clock(x.timeSheetWorkEndTime);
          if (num(x.timeSheetWorkLunchTime)) sched += " · lunch " + x.timeSheetWorkLunchTime + "h";
          if (x.timeSheetWorkStatTime2) sched += " · " + clock(x.timeSheetWorkStatTime2) + "–" + clock(x.timeSheetWorkEndTime2);
        }
        return (leave ? '<span class="leave">' + esc(proj) + "</span>" : esc(proj)) +
          (sched ? '<br><span class="sub">' + esc(sched) + "</span>" : "") +
          (x.timeSheetWorkCompleted ? '<br><span class="sub">' + esc(x.timeSheetWorkCompleted) + "</span>" : "");
      }).join("<hr style='border:none;border-top:1px dashed #bbb;margin:4px 0'>");
      total += dayHours;
      rows += "<tr><td style='width:120px'><b>" + niceDay(d) + "</b><br><span class='sub'>" + niceDate(d) + "</span></td>" +
        "<td>" + (cells || "") + "</td><td class='num'>" + (dayHours ? dayHours : "") + "</td></tr>";
    }

    el("tcSheet").innerHTML =
      '<div class="lh"><img src="' + LOGO + '" alt="' + esc(CO.name) + '" />' +
      '<div style="font-size:9.5px;color:#333;line-height:1.5;text-align:center">' + coBlock() + "</div>" +
      "<h1>TIME CARD</h1></div>" +
      '<div class="who"><div>Employee: <b>' + esc(emp) + "</b></div>" +
      "<div>Week: <b>" + niceDate(start) + " – " + niceDate(end) + ", " + end.getFullYear() + "</b></div></div>" +
      '<table class="tc"><thead><tr><th>Day</th><th>Project / schedule / work</th><th>Hours</th></tr></thead><tbody>' +
      rows +
      '<tr class="tot"><td colspan="2">WEEK TOTAL</td><td class="num">' + total + "</td></tr>" +
      "</tbody></table>" +
      '<div class="sig"><div>Employee signature / date</div><div>Supervisor signature / date</div></div>' +
      '<div class="foot">Generated ' + new Date().toLocaleDateString("en-US") + " · " + esc(CO.name) + "</div>";
  }

  function buildEmpSelect() {
    var sel = el("tcEmp");
    var names = {};
    state.employees.forEach(function (e) { if (e.name) names[e.name] = 1; });
    state.items.forEach(function (x) { if (x.timeSheetEmployeeName) names[x.timeSheetEmployeeName] = 1; });
    var list = Object.keys(names).sort();
    sel.innerHTML = '<option value="">— Choose employee —</option>' +
      list.map(function (n) { return '<option' + (n === state.emp ? " selected" : "") + ">" + esc(n) + "</option>"; }).join("");
    if (!state.emp && list.length === 1) { state.emp = list[0]; sel.value = list[0]; }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    el("tcEmp").onchange = function () { state.emp = this.value; render(); };
    el("tcWeek").onchange = function () { state.week = this.value; render(); };
    try {
      var results = await Promise.all([
        DCR.api("/api/portal?action=roster"),
        DCR.api("/api/portal?action=timesheets"),
      ]);
      state.employees = results[0].employees || [];
      state.items = results[1].items || [];
      buildEmpSelect();
      render();
    } catch (e) {
      el("tcSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load time data.") + "</div>";
    }
  });
})();
