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

  var thumbMiss = {}; // projectId -> true once we know the folder has no Thumnail.png

  // Fill in project thumbnails after the list renders — a few at a time so a
  // long result set doesn't fire a burst of folder lookups, and never blocking
  // the results themselves. Successful images are cached by DCR.blobUrl.
  async function loadThumbs(my) {
    var imgs = Array.prototype.slice.call(el("seResults").querySelectorAll("img[data-thumb]"))
      .filter(function (img) { return !thumbMiss[img.getAttribute("data-thumb")]; });
    var i = 0;
    async function worker() {
      while (i < imgs.length) {
        if (my !== seq) return; // a newer search replaced these results
        var img = imgs[i++];
        var id = img.getAttribute("data-thumb");
        try {
          var url = await DCR.blobUrl("/api/portal?action=thumb&projectId=" + encodeURIComponent(id));
          if (my !== seq) return;
          img.onload = function () {
            img.style.display = "";
            var ph = img.parentElement.querySelector(".ph");
            if (ph) ph.style.display = "none";
          };
          img.src = url;
        } catch (e) {
          thumbMiss[id] = true; // no thumbnail in that folder — keep the icon
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
  }

  async function run(q) {
    var my = ++seq;
    if (q.length < 2) {
      el("seNote").textContent = "";
      el("seResults").innerHTML = '<div class="se-empty">Type at least 2 characters to search.</div>';
      return;
    }
    el("seNote").textContent = "Searching…";
    // The "type at least 2 characters" hint has done its job by now — drop it
    // so it can't sit under a search that is already running. Any previous
    // results stay put until the new ones land, which keeps typing steady.
    var placeholder = el("seResults").querySelector(".se-empty");
    if (placeholder) placeholder.remove();
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
          if (it.href && it.thumbId) {
            // project hit — show the folder's Thumnail.png (loaded after render)
            return '<a class="se-item thumbed" href="' + esc(it.href) + '">' +
              '<span class="se-thumb"><img style="display:none" data-thumb="' + esc(it.thumbId) + '" alt="">' +
              '<span class="ph">🏠</span></span>' +
              '<span class="se-txt"><div class="se-title">' + esc(it.title) + "</div>" + sub + "</span></a>";
          }
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
      loadThumbs(my);
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
