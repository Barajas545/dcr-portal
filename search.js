/* DCR portal — global search. Queries action=search (server filters to what the
   user can read); results deep-link into the right page/tab. Project tiles
   with a plans-archive folder also offer its .takeoff files (see below). */

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

  /* ── plan files (.takeoff) ───────────────────────────────────────────────
     A project whose ID has a folder in the plans archive in SharePoint carries
     planFolder (that folder's name) in its search hit. Its tile gets a
     floor-plan button that opens a menu of the .takeoff files in that folder
     and its sub-folders, and picking one opens it in Professional Takeoff
     Tools through takeoff-open.js. The server only sends planFolder to people
     allowed to open them, since plan files carry estimate prices. */

  // A plan outline with an interior wall, a doorway in it and the door's swing.
  var PLAN_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<rect x="3" y="3" width="18" height="18" rx="1.5"/>' +
    '<path d="M12 3v8M12 16v5M3 14h5"/>' +
    '<path d="M12 16h5M12 11a5 5 0 0 1 5 5"/></svg>';

  var planReq = {};   // projectId -> the takeoffsFor answer (a promise), asked once per page load
  var planFail = {};  // projectId -> when its last answer failed (Date.now())
  // projectId -> true once an answer showed no .takeoff to open. Kept for the
  // tab's session, so a folder found empty stays dimmed after a reload rather
  // than looking full of plans again until someone points at it.
  var NONE_KEY = "dcr.search.planNone";
  var planNone = (function () {
    try {
      var o = JSON.parse(window.sessionStorage.getItem(NONE_KEY));
      return o && typeof o === "object" ? o : {};
    } catch (e) { return {}; }
  })();
  var TITLE_PLANS = "Plan files (.takeoff) — open in Professional Takeoff Tools";
  var TITLE_NONE = "No plan files in the archive folder";
  // After a failure, pointing at the button leaves the server alone this long.
  // A failure is usually SharePoint throttling or a slow folder walk, and
  // asking again straight away only adds to it. A click still asks at once.
  var PREFETCH_WAIT_MS = 30000;
  // The one open menu: { btn, panel, scrim, projectId, onDoc, onKey, onFocus, opening }.
  // opening is set while a file from it is on its way to the tool, so a second
  // pick cannot race it. It lives on the menu, not the page, so a menu opened
  // later is never locked by a trip that did not happen.
  var menu = null;
  // A real trip to the tool unloads this page long before this. If the page
  // is still here after it, the trip was stopped (the Stop button, or the
  // iPhone app showing the tool in a sheet over this page), so the menu that
  // sent it works again instead of staying locked until a reload.
  var STILL_HERE_MS = 10000;

  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return "";
    // Eight archived jobs are over a gigabyte; "2355.2 MB" reads badly.
    if (n >= 1073741824) return (n / 1073741824).toFixed(1) + " GB";
    if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n > 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }
  function fmtDay(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function countFiles(node) {
    return (node.files || []).length + (node.folders || []).reduce(function (n, f) { return n + countFiles(f); }, 0);
  }
  function anyTruncated(node) {
    return !!node.truncated || (node.folders || []).some(anyTruncated);
  }

  // Ask the server once per project and share the answer between the hover
  // prefetch and the click. A failed answer is dropped so the next click can
  // try again rather than repeating an old error, and its time is kept so the
  // hover prefetch holds off for a while (see PREFETCH_WAIT_MS).
  function plansFor(projectId) {
    if (!planReq[projectId]) {
      planReq[projectId] = DCR.api("/api/portal?action=drive&takeoffsFor=" + encodeURIComponent(projectId))
        .then(function (d) {
          delete planFail[projectId];
          var n = d && d.folder ? (d.count != null ? d.count : (d.tree ? countFiles(d.tree) : 0)) : 0;
          // A folder dimmed earlier in the session may have plans in it now.
          if (!n) setNone(projectId, true);
          else if (planNone[projectId]) setNone(projectId, false);
          return d;
        }, function (e) {
          delete planReq[projectId];
          planFail[projectId] = Date.now();
          throw e;
        });
    }
    return planReq[projectId];
  }

  // A folder that turned out to hold no .takeoff keeps its button, dimmed, so
  // the owner can still see why, but it no longer looks like plans are there.
  // (The server leaves the button off altogether once it knows, but only for
  // a few minutes and only on the server that looked.)
  function setNone(projectId, none) {
    if (none) planNone[projectId] = true; else delete planNone[projectId];
    try { window.sessionStorage.setItem(NONE_KEY, JSON.stringify(planNone)); } catch (e) { /* private window: this page only */ }
    document.querySelectorAll(".se-plans").forEach(function (b) {
      if (b.getAttribute("data-plans") !== String(projectId)) return;
      b.classList.toggle("none", none);
      b.title = none ? TITLE_NONE : TITLE_PLANS;
    });
  }

  function plansButton(projectId, folderName) {
    var none = planNone[projectId];
    return '<button type="button" class="se-plans' + (none ? " none" : "") + '" data-plans="' + esc(projectId) +
      '" data-folder="' + esc(folderName) + '" aria-haspopup="dialog" aria-expanded="false"' +
      ' aria-label="Plan files (.takeoff) for ' + esc(folderName) + '" title="' +
      (none ? TITLE_NONE : TITLE_PLANS) + '">' + PLAN_SVG + "</button>";
  }

  function fileRow(f) {
    var meta = [fmtSize(f.size), fmtDay(f.modifiedTime)].filter(Boolean).join(" · ");
    // The icon is the same 📐 the project page shows for a takeoff, as text,
    // so the opener's ⏳ swap can put it back exactly if the open fails.
    return '<button type="button" class="se-pm-file" data-fid="' + esc(f.id) + '" data-name="' + esc(f.name) + '">' +
      '<span class="se-pf-ic" aria-hidden="true">📐</span>' +
      '<span class="se-pf-txt"><span class="se-pf-name">' + esc(f.name) + "</span>" +
      (meta ? '<span class="se-pf-meta">' + esc(meta) + "</span>" : "") + "</span></button>";
  }

  // Files at this level first, then each sub-folder as a heading that folds.
  // Sub-folders start folded when there are files above them (the Backups
  // folder is usually the older copies) and open when there are none.
  function nodeHtml(node) {
    var files = node.files || [], folders = node.folders || [];
    var open = !files.length;
    return files.map(fileRow).join("") + folders.map(function (f) {
      var n = f.count != null ? f.count : countFiles(f);
      return '<div class="se-pm-grp"><button type="button" class="se-pm-fold" aria-expanded="' + open + '">' +
        '<span class="se-pm-car" aria-hidden="true"></span><span class="se-pm-fname">📁 ' + esc(f.name) + " · " + n + "</span></button>" +
        '<div class="se-pm-kids"' + (open ? "" : " hidden") + ">" + nodeHtml(f) + "</div></div>";
    }).join("");
  }

  function menuRows(panel) {
    return Array.prototype.filter.call(panel.querySelectorAll(".se-pm-file, .se-pm-fold"), function (b) {
      return !b.closest("[hidden]");
    });
  }

  function renderPlans(m, d) {
    var panel = m.panel, body = panel.querySelector(".se-pm-body");
    var label = (d && d.folder && d.folder.name) || m.btn.getAttribute("data-folder") || "";
    panel.querySelector(".se-pm-title").textContent = "Plan files — " + label;
    panel.setAttribute("aria-label", "Plan files — " + label);
    if (!d || !d.folder) {
      body.innerHTML = '<div class="se-pm-msg">' + esc((d && d.reason) || "This project has no plans archive folder.") + "</div>";
      return;
    }
    var tree = d.tree || {};
    var shown = countFiles(tree);
    if (!shown) {
      body.innerHTML = '<div class="se-pm-msg">No .takeoff files in the ' + esc(label) + " archive folder.</div>";
      return;
    }
    body.innerHTML = nodeHtml(tree) +
      (d.truncated || anyTruncated(tree) ? '<div class="se-pm-msg se-pm-trunc">Showing the first ' + shown + " files.</div>" : "");
    // Only now is there a file to open, so only now does the note on how it
    // opens belong under the list.
    panel.querySelector(".se-pm-foot").hidden = false;
    // Hand the keyboard to the first file, unless the owner has already moved
    // on (clicked back into the search box) while the list was loading.
    var active = document.activeElement;
    if (active === panel || active === m.btn) {
      var first = menuRows(panel)[0];
      if (first) first.focus();
    }
    fitOnScreen(panel);
  }

  // When the menu is a sheet along the bottom rather than a panel under the
  // tile: a narrow screen, or a short one such as a phone held sideways. It
  // must match the @media rule for the sheet in search.html.
  var SHEET_MQ = "(max-width:599px), (max-height:500px)";

  // On a wide screen the menu hangs under its tile; if that runs past the
  // bottom of the window, scroll just enough to show all of it. (On a phone it
  // is a sheet fixed to the bottom, so there is nothing to do.)
  function fitOnScreen(panel) {
    if (window.matchMedia(SHEET_MQ).matches) return;
    var r = panel.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) panel.scrollIntoView({ block: "nearest" });
  }

  function setBusy(m, on, row) {
    if (on) m.panel.setAttribute("aria-busy", "true"); else m.panel.removeAttribute("aria-busy");
    // aria-disabled rather than disabled: a disabled button drops the keyboard
    // focus, and the failure alert then has nowhere to hand it back to.
    m.panel.querySelectorAll(".se-pm-file, .se-pm-fold").forEach(function (b) {
      if (on) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled");
    });
    if (row) row.classList.toggle("picked", on);
  }

  async function pick(m, row) {
    if (m.opening) return;
    if (!window.DCRTakeoff) {
      DCR.alert("The plan opener did not load — reload the page.", { title: "Could not open" });
      return;
    }
    // The menu stays open while the link is fetched (a cold server can take a
    // few seconds), showing ⏳ on the picked file, so a tap that seems to do
    // nothing is not followed by a second pick and a second trip to the tool.
    m.opening = true;
    setBusy(m, true, row);
    var icon = row.querySelector(".se-pf-ic");
    var was = icon ? icon.textContent : "";
    // Close, Escape, a click outside, tabbing out, a new search and another
    // menu all end this menu. The opener asks once the link is back, so a file
    // the owner walked away from does not send the page to the tool seconds
    // later.
    var ok = await window.DCRTakeoff.open(row.getAttribute("data-fid"), row.getAttribute("data-name"), icon,
      { proceed: function () { return menu === m; } });
    if (ok) {
      // The page is on its way to the tool and normally unloads before this
      // runs. The opener leaves ⏳ showing on success, so put the icon back too.
      setTimeout(function () {
        m.opening = false;
        if (menu !== m) return;
        setBusy(m, false, row);
        if (icon) icon.textContent = was;
      }, STILL_HERE_MS);
      return;
    }
    m.opening = false;
    if (menu === m) setBusy(m, false, row);
  }

  function openMenu(btn) {
    var projectId = btn.getAttribute("data-plans");
    var label = btn.getAttribute("data-folder") || "";
    var wrap = btn.parentElement;

    // On a phone the menu is a sheet at the bottom, and the rest of the screen
    // is project links. The scrim takes the tap that closes the sheet, so that
    // tap cannot also open whichever project was under the finger. It is
    // hidden on a wide screen, where the menu is a small panel.
    var scrim = document.createElement("div");
    scrim.className = "se-scrim";
    var panel = document.createElement("div");
    panel.className = "se-pm";
    panel.id = "sePlansMenu";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Plan files — " + label);
    panel.tabIndex = -1;
    // The footer says how a file opens, so it starts hidden and renderPlans
    // shows it once there are files. While loading, and under "no folder",
    // "no .takeoff files" or an error, there is nothing for it to describe.
    panel.innerHTML =
      '<div class="se-pm-head"><b class="se-pm-title">Plan files — ' + esc(label) + "</b>" +
        '<button type="button" class="se-pm-close">Close</button></div>' +
      '<div class="se-pm-body"><div class="se-pm-msg">Loading…</div></div>' +
      '<div class="se-pm-foot" hidden>Opens in Professional Takeoff Tools without downloading the file — ' +
        "each sheet loads as you view it.</div>";
    wrap.appendChild(scrim);
    wrap.appendChild(panel);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", panel.id);

    var m = { btn: btn, panel: panel, scrim: scrim, projectId: projectId };
    m.onDoc = function (e) {
      var t = e.target;
      // Clicks inside the menu are its own; its button toggles it (see the
      // results click handler), and this listener also hears the very click
      // that opened the menu. A DCR alert over the menu is not "outside".
      if (panel.contains(t) || btn.contains(t)) return;
      if (t.closest && t.closest("#dcrModalHost")) return;
      closeMenu(false);
    };
    m.onKey = function (e) {
      // A DCR alert on top handles its own Escape first and marks it handled.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeMenu(true);
    };
    m.onFocus = function (e) {
      // Tab past the last row lands on the next tile's link and plan button,
      // which sit under this menu (under the sheet on a phone), so the owner
      // would be on a control they cannot see. Focus leaving the menu closes
      // it and stays where it went. Its own button and a DCR alert over the
      // menu (a failed open) are not "leaving".
      var t = e.target;
      if (panel.contains(t) || btn.contains(t)) return;
      if (t.closest && t.closest("#dcrModalHost")) return;
      closeMenu(false);
    };
    document.addEventListener("click", m.onDoc);
    document.addEventListener("keydown", m.onKey);
    document.addEventListener("focusin", m.onFocus);
    scrim.addEventListener("click", function () { closeMenu(false); });

    panel.addEventListener("click", function (e) {
      var t = e.target;
      if (t.closest(".se-pm-close")) { closeMenu(true); return; }
      if (m.opening) return;
      var fold = t.closest(".se-pm-fold");
      if (fold) {
        var open = fold.getAttribute("aria-expanded") !== "true";
        fold.setAttribute("aria-expanded", String(open));
        fold.nextElementSibling.hidden = !open;
        return;
      }
      var row = t.closest(".se-pm-file");
      if (row) pick(m, row);
    });
    // Up and Down move between the files and folder headings; Tab still
    // walks through everything in order (and out of the menu, which closes
    // it), and Enter opens.
    panel.addEventListener("keydown", function (e) {
      var k = e.key;
      if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "Home" && k !== "End") return;
      var list = menuRows(panel);
      if (!list.length) return;
      e.preventDefault();
      var i = list.indexOf(document.activeElement);
      var next = k === "Home" ? 0 : k === "End" ? list.length - 1
        : k === "ArrowDown" ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0);
      list[next].focus();
    });

    menu = m;
    panel.focus();
    fitOnScreen(panel);
    plansFor(projectId).then(function (d) {
      // The menu may have been closed, or the results replaced, meanwhile.
      if (menu !== m || !panel.isConnected) return;
      renderPlans(m, d);
    }, function (e) {
      if (menu !== m || !panel.isConnected) return;
      panel.querySelector(".se-pm-body").innerHTML =
        '<div class="se-pm-msg">' + esc((e && e.message) || "Could not load the plan files.") + "</div>";
    });
  }

  function closeMenu(returnFocus) {
    var m = menu;
    if (!m) return;
    menu = null;
    document.removeEventListener("click", m.onDoc);
    document.removeEventListener("keydown", m.onKey);
    document.removeEventListener("focusin", m.onFocus);
    m.panel.remove();
    m.scrim.remove();
    m.btn.setAttribute("aria-expanded", "false");
    m.btn.removeAttribute("aria-controls");
    if (returnFocus && m.btn.isConnected) m.btn.focus();
  }

  // Every replacement of the results goes through here. The open menu lives
  // inside a tile, so it is closed properly first (its page-wide listeners
  // go with it) rather than left behind on a tile that no longer exists.
  function setResults(html) {
    closeMenu(false);
    el("seResults").innerHTML = html;
  }

  async function run(q) {
    // A new search closes the menu straight away, before its results land.
    closeMenu(false);
    var my = ++seq;
    if (q.length < 2) {
      el("seNote").textContent = "";
      setResults('<div class="se-empty">Type at least 2 characters to search.</div>');
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
        setResults('<div class="se-empty">No results for "' + esc(q) + '".</div>');
        return;
      }
      setResults(groups.map(function (g) {
        var items = g.items.map(function (it) {
          var sub = it.sub ? '<div class="se-sub">' + esc(it.sub) + "</div>" : "";
          if (it.href && it.thumbId) {
            // project hit — show the folder's Thumnail.png (loaded after render)
            var planFolder = it.planFolder || "";
            var tile = '<a class="se-item thumbed' + (planFolder ? " has-plans" : "") + '" href="' + esc(it.href) + '">' +
              '<span class="se-thumb"><img style="display:none" data-thumb="' + esc(it.thumbId) + '" alt="">' +
              '<span class="ph">🏠</span></span>' +
              '<span class="se-txt"><div class="se-title">' + esc(it.title) + "</div>" + sub + "</span></a>";
            if (!planFolder) return tile;
            // A button may not sit inside a link, so the floor-plan button is
            // the link's neighbour in a wrapper, and CSS lays it over the
            // tile's right edge. The whole tile still opens the project.
            return '<div class="se-proj">' + tile + plansButton(it.projectId || it.thumbId, planFolder) + "</div>";
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
      }).join(""));
      loadThumbs(my);
    } catch (e) {
      if (my !== seq) return;
      el("seNote").textContent = "";
      setResults('<div class="se-empty">' + esc(e.message || "Search failed.") + "</div>");
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
    // The floor-plan buttons are redrawn with every search, so their clicks
    // are handled here once. Pointing at one (or tabbing to it) starts the
    // file list loading, so the click usually finds it already there.
    el("seResults").addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".se-plans");
      if (!btn) return;
      e.preventDefault();
      if (menu && menu.btn === btn) { closeMenu(true); return; }
      closeMenu(false);
      openMenu(btn);
    });
    function prefetch(e) {
      if (e.pointerType === "touch") return; // a tap is about to click anyway
      var btn = e.target.closest && e.target.closest(".se-plans");
      if (!btn) return;
      // The icon is drawn in outline, so each of its lines takes the pointer
      // as it passes and pointerover fires again inside the same button. Only
      // coming onto the button from outside it counts as pointing at it.
      if (e.relatedTarget && btn.contains(e.relatedTarget)) return;
      var projectId = btn.getAttribute("data-plans");
      if (Date.now() - (planFail[projectId] || 0) < PREFETCH_WAIT_MS) return;
      plansFor(projectId).catch(function () {});
    }
    el("seResults").addEventListener("pointerover", prefetch);
    el("seResults").addEventListener("focusin", prefetch);
    // Coming Back from the takeoff tool can restore this page exactly as it
    // was left, menu open and ⏳ showing. Show a clean list instead.
    window.addEventListener("pageshow", function (e) {
      if (!e.persisted) return;
      closeMenu(false);
    });

    if (q0) run(q0.trim());
    el("seInput").focus();
  });
})();
