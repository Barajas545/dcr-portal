/* DCR portal — global search. Queries action=search (server filters to what the
   user can read); results deep-link into the right page/tab. */

(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var timer = null, seq = 0;

  function setQ(q) {
    var u = new URL(location.href);
    if (q) u.searchParams.set("q", q); else u.searchParams.delete("q");
    history.replaceState(null, "", u);
  }

  async function run(q) {
    var my = ++seq;
    if (q.length < 2) {
      el("seNote").textContent = "";
      el("seResults").innerHTML = '<div class="se-empty">Type at least 2 characters to search.</div>';
      return;
    }
    el("seNote").textContent = "Searching…";
    try {
      var d = await DCR.api("/api/portal?action=search&q=" + encodeURIComponent(q));
      if (my !== seq) return; // stale response
      var groups = d.groups || [];
      var total = groups.reduce(function (n, g) { return n + g.total; }, 0);
      el("seNote").textContent = total ? total + " result" + (total === 1 ? "" : "s") + ' for "' + q + '"' : "";
      if (!groups.length) {
        el("seResults").innerHTML = '<div class="se-empty">No results for "' + esc(q) + '".</div>';
        return;
      }
      el("seResults").innerHTML = groups.map(function (g) {
        var items = g.items.map(function (it) {
          var sub = it.sub ? '<div class="se-sub">' + esc(it.sub) + "</div>" : "";
          if (it.href) {
            return '<a class="se-item" href="' + esc(it.href) + '"><div class="se-title">' + esc(it.title) + "</div>" + sub + "</a>";
          }
          var contact = [];
          if (it.email) contact.push('<a href="mailto:' + esc(it.email) + '">' + esc(it.email) + "</a>");
          if (it.phone) contact.push('<a href="tel:' + esc(it.phone) + '">' + esc(it.phone) + "</a>");
          return '<div class="se-item"><div class="se-title">' + esc(it.title) + "</div>" +
            (it.sub || contact.length
              ? '<div class="se-sub">' + [esc(it.sub || "")].concat(contact).filter(Boolean).join(" · ") + "</div>"
              : "") + "</div>";
        }).join("");
        var more = g.more ? '<div class="se-more">…' + (g.total - g.items.length) + " more — refine your search</div>" : "";
        return '<div class="se-grp"><h3>' + esc(g.label) + ' <span class="se-count">' + g.total + "</span></h3>" + items + more + "</div>";
      }).join("");
    } catch (e) {
      if (my !== seq) return;
      el("seNote").textContent = "";
      el("seResults").innerHTML = '<div class="se-empty">' + esc(e.message || "Search failed.") + "</div>";
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    var q0 = new URLSearchParams(location.search).get("q") || "";
    el("seInput").value = q0;
    el("seInput").addEventListener("input", function () {
      var q = this.value.trim();
      setQ(q);
      clearTimeout(timer);
      timer = setTimeout(function () { run(q); }, 300);
    });
    if (q0) run(q0.trim());
    el("seInput").focus();
  });
})();
