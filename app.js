// Home launcher: global search + permission-gated app cards.
// (The old table browser now lives in data.html / data.js.)
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  function cards(profile) {
    var pp = profile.permissions || {};
    var ts = profile.tsScope;
    var isLeadOrMgr = ts === "*" || (ts && ts.managed && ts.managed.length);
    var sections = [];

    sections.push({ label: "Field & Time", cards: [
      { href: "timesheet.html", ic: "🕐", tt: "Time Sheet", ds: "Enter your daily hours, schedule, and leave days.", show: true },
      { href: "tasks-map.html", ic: "🗺️", tt: "Tasks on Map", ds: "Photo & site tasks on a map with directions.", show: true },
      { href: "timesheet-manager.html", ic: "📆", tt: "Team Sheets", ds: "Weekly grid of everyone's hours; edit any entry.", show: isLeadOrMgr },
      { href: "timesheet-batch.html", ic: "👥", tt: "Batch Entry", ds: "Submit time for a whole crew at once.", show: isLeadOrMgr },
    ]});

    sections.push({ label: "Projects & Sales", cards: [
      { href: "board.html", ic: "📋", tt: "Project Board", ds: "All projects by stage — drag to move, open details.", show: !!pp.project,
        links: [["Sales view","board.html?view=sales"],["Marketing view","board.html?view=marketing"],["Accounting view","board.html?view=accounting"]] },
      { href: "leads.html", ic: "📞", tt: "Leads", ds: "Sales pipeline: track contacts, convert to projects.", show: !!pp.leads },
      { href: "marketing.html", ic: "📣", tt: "Marketing Tasks", ds: "Billable marketing work — done, invoiced, paid.", show: !!pp.marketingTasks },
    ]});

    sections.push({ label: "Operations", cards: [
      { href: "vehicles.html", ic: "🚚", tt: "Vehicles", ds: "Fleet board: oil changes, services due, history.", show: !!pp.vehicleInformation },
      { href: "data.html", ic: "🗄️", tt: "Data Browser", ds: "Browse and edit any table you have access to.", show: true },
      { href: "admin.html", ic: "🔐", tt: "Admin", ds: "User accounts, roles, and permissions.", show: profile.role === "Admin" },
    ]});

    return sections;
  }

  function render(profile) {
    var html = "";
    cards(profile).forEach(function (sec) {
      var vis = sec.cards.filter(function (c) { return c.show; });
      if (!vis.length) return;
      html += '<div class="hm-sec">' + esc(sec.label) + '</div><div class="hm-cards">' +
        vis.map(function (c) {
          var links = c.links
            ? '<div class="links">' + c.links.map(function (l) {
                return '<a href="' + l[1] + '" onclick="event.stopPropagation()">' + esc(l[0]) + "</a>";
              }).join("") + "</div>"
            : "";
          return '<a class="hm-card" href="' + c.href + '">' +
            '<span class="ic">' + c.ic + '</span>' +
            '<span class="tt">' + esc(c.tt) + '</span>' +
            '<span class="ds">' + esc(c.ds) + '</span>' + links + "</a>";
        }).join("") + "</div>";
    });
    el("hmSections").innerHTML = html;
  }

  function goSearch() {
    var q = el("hmSearch").value.trim();
    if (q.length >= 2) location.href = "search.html?q=" + encodeURIComponent(q);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    var name = (profile.displayName || profile.email || "").split(" ")[0].split("@")[0];
    el("hmGreeting").textContent = "Welcome, " + name;
    el("hmLogo").src = DCR.companyInfo.logo;
    el("hmGo").onclick = goSearch;
    el("hmSearch").addEventListener("keydown", function (e) { if (e.key === "Enter") goSearch(); });
    render(profile);
  });
})();
