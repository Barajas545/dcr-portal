/* DCR portal — the Plans Library page (plans-library.html).

   Lists the .takeoff plan files saved on this device, grouped by project with
   the project's picture, and keeps them current: opening the page online asks
   SharePoint which saved copies have a newer version, resumes downloads that
   a closed window or a dropped connection interrupted, and offers Update.
   The owner decides; nothing is replaced on its own.

   It must open with no internet at all, so it never waits on the portal: who
   is signed in comes from the session token on this device, and the plans
   come from the device's own storage (plans-library.js). */
(function () {
  "use strict";
  var L = window.DCRPlansLibrary;
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var sess = null, thumbUrls = [], busyCheck = false, autoResumed = false, forcedWarm = false;
  var refocus = null;                             // {key, act}: where the keyboard goes back after a redraw
  var AUTO_CHECK_GAP = 2 * 60 * 1000;

  function setStatus(html) { el("plStatus").innerHTML = html || ""; }

  function netBanner() {
    var off = !navigator.onLine || (sess && sess.online === false);
    var b = el("plNet");
    b.hidden = !off;
    b.textContent = off ? "You're offline. Your saved plans still open; new versions are checked and downloaded when you're back online." : "";
    el("plCheck").disabled = off;
  }

  function stateLine(e) {
    var d = e.dl || {};
    var live = e.live, size = (live && live.size) || d.size || e.size || 0;
    var done = live ? live.done : d.done || 0;
    var pct = size ? Math.min(100, Math.floor((done / size) * 100)) : 0;
    var amount = L.fmtSize(done) + " of " + L.fmtSize(size);
    switch (e.status) {
      case "downloading": {
        var rate = live && live.rate ? " · " + L.fmtSize(live.rate) + "/s" : "";
        var what = e.hasFile ? "Updating to the new version" : "Downloading";
        var keep = e.hasFile ? " — your saved copy still opens" : "";
        return { cls: "s-new", text: what + " " + pct + "% · " + amount + rate + keep, pct: pct };
      }
      case "paused":
        return { cls: "s-warn", text: (e.hasFile ? "Update paused" : "Paused") + " at " + pct + "% (" + amount + ")" +
          (d.error ? " — " + d.error : "") + (navigator.onLine ? "" : " · resumes when you're back online"), pct: pct };
      case "failed":
        return { cls: "s-bad", text: "Stopped: " + (d.error || "the download did not finish") + (e.hasFile ? " Your saved copy still opens." : "") };
      case "outdated": {
        var l = e.latest || {};
        return { cls: "s-new", text: "New version in SharePoint: " + L.fmtWhen(l.modifiedTime) + (l.size ? " · " + L.fmtSize(l.size) : "") };
      }
      case "gone":
        return { cls: "s-warn", text: "No longer in SharePoint — your saved copy still opens." };
      case "denied":
        return { cls: "s-bad", text: "Your account can no longer open this plan file." };
      default: {
        var chk = e.latest && e.latest.checkedAt ? " · checked " + L.fmtAgo(e.latest.checkedAt) : " · not checked yet";
        return { cls: "s-ok", text: "✓ Up to date" + chk };
      }
    }
  }

  function buttons(e) {
    var b = [];
    var canOpen = e.hasFile && e.status !== "denied";
    // Each button says which plan it acts on, for a screen reader reading the
    // buttons on their own ("Open A249 - … .takeoff").
    function btn(act, label, cls, disabled) {
      return '<button type="button" class="pl-btn' + (cls ? " " + cls : "") + '" data-act="' + act + '"' +
        ' aria-label="' + esc(label + " " + e.name) + '"' + (disabled ? " disabled" : "") + ">" + esc(label) + "</button>";
    }
    b.push(btn("open", "Open", e.status === "ready" || e.status === "gone" ? "primary" : "", !canOpen));
    if (e.status === "outdated") b.push(btn("update", "Update", "primary"));
    if (e.status === "downloading") b.push(btn("pause", "Pause", ""));
    if (e.status === "paused") b.push(btn("resume", "Resume", "primary"));
    if (e.status === "failed") b.push(btn("resume", "Try again", ""));
    b.push(btn("remove", "Remove", "danger"));
    return b.join("");
  }

  function fileHtml(e) {
    var s = stateLine(e);
    var meta = [e.folder ? "📁 " + e.folder : "", e.hasFile ? L.fmtSize(e.size) : "",
      e.hasFile ? "version of " + L.fmtWhen(e.modifiedTime) : "", e.savedAt ? "saved " + L.fmtDay(e.savedAt) : ""]
      .filter(Boolean).join(" · ");
    var showBar = e.status === "downloading" || e.status === "paused";
    return '<div class="pl-file" data-key="' + esc(e.key) + '" data-id="' + esc(e.id) + '">' +
      '<div class="pl-fmain"><span class="pl-fic" aria-hidden="true">📐</span><div class="pl-ftxt">' +
        '<div class="pl-fname">' + esc(e.name) + "</div>" +
        (meta ? '<div class="pl-fmeta">' + esc(meta) + "</div>" : "") +
        '<div class="pl-fstate ' + s.cls + '">' + esc(s.text) + "</div>" +
        (showBar ? '<div class="pl-bar-track" aria-hidden="true"><div class="pl-bar-fill" style="width:' + (s.pct || 0) + '%"></div></div>' : "") +
      "</div></div>" +
      '<div class="pl-facts">' + buttons(e) + "</div></div>";
  }

  function projectHtml(group, proj) {
    var first = group[0];
    var code = (proj && proj.code) || first.projectCode || "";
    var title = (proj && proj.title) || first.projectTitle || "";
    var head = code && title ? code + " — " + title : (title || code || "Other plans");
    var sub = (proj && proj.sub) || first.projectSub || "";
    var img = "";
    if (proj && proj.thumb) {
      var u = URL.createObjectURL(proj.thumb);
      thumbUrls.push(u);
      img = '<img src="' + u + '" alt="">';
    }
    // A hint is only as good as the moment it was worked out: after an update
    // or another save it may no longer be newer than what is here, or may be
    // saved already. Judged again on every draw.
    var newestSaved = Math.max.apply(null, group.map(function (e) { return Date.parse(e.modifiedTime) || 0; }).concat([0]));
    var savedIds = {};
    group.forEach(function (e) { savedIds[e.id] = true; });
    var newer = ((proj && proj.newer) || []).filter(function (n) {
      return !savedIds[n.id] && (Date.parse(n.modifiedTime) || 0) > newestSaved;
    });
    var hint = newer.length && navigator.onLine
      ? newer.map(function (n) {
          return '<div class="pl-newer"><span>A newer plan file is in this project\'s archive: <b>' + esc(n.name) + "</b>" +
            (n.folder ? " (📁 " + esc(n.folder) + ")" : "") + " · " + esc(L.fmtWhen(n.modifiedTime)) + " · " + esc(L.fmtSize(n.size)) +
            '</span><button type="button" class="pl-btn" data-act="save-newer" data-pid="' + esc(first.projectId) +
            '" data-fid="' + esc(n.id) + '" data-name="' + esc(n.name) + '" data-folder="' + esc(n.folder || "") + '">Save it too</button></div>';
        }).join("")
      : "";
    return '<section class="pl-proj">' +
      '<div class="pl-ph"><span class="pl-thumb">' + (img || '<span aria-hidden="true">🏠</span>') + "</span>" +
        '<div class="pl-pt"><div class="pl-ptitle">' + esc(head) + "</div>" + (sub ? '<div class="pl-psub">' + esc(sub) + "</div>" : "") + "</div></div>" +
      '<div class="pl-files">' + group.map(fileHtml).join("") + "</div>" + hint + "</section>";
  }

  var renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(function () { renderQueued = false; render(); }, 120);
  }

  async function render() {
    var list = await L.list();
    var projs = await L.projects();
    thumbUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    thumbUrls = [];
    netBanner();
    if (!list.length) {
      el("plList").innerHTML = '<div class="pl-empty">Nothing saved on this device yet.<br>' +
        "Search a project, open its plan files with the floor-plan button, and press ⤓ next to a file to keep it here." +
        "</div>";
    } else {
      var groups = {}, order = [];
      list.forEach(function (e) {
        var g = e.projectId || ("code:" + (e.projectCode || ""));
        if (!groups[g]) { groups[g] = []; order.push(g); }
        groups[g].push(e);
      });
      el("plList").innerHTML = order.map(function (g) { return projectHtml(groups[g], projs[groups[g][0].projectId]); }).join("");
    }
    if (refocus) {
      var target = null;
      var row = document.querySelector('.pl-file[data-key="' + (window.CSS && CSS.escape ? CSS.escape(refocus.key) : refocus.key) + '"]');
      if (row) target = row.querySelector('button[data-act="' + refocus.act + '"]:not([disabled])') ||
        row.querySelector("button:not([disabled])");
      if (!target) target = document.querySelector(".pl-file button:not([disabled])") || el("plCheck");
      refocus = null;
      if (target) try { target.focus({ preventScroll: true }); } catch (x) { target.focus(); }
    }
    var outdated = list.filter(function (e) { return e.status === "outdated"; }).length;
    var ua = el("plUpdateAll");
    ua.hidden = outdated < 2 || !navigator.onLine;
    ua.textContent = "Update all (" + outdated + ")";
    paintUsage();
  }

  async function paintUsage() {
    var u = await L.usage();
    var parts = ["<b>" + u.plans + " plan" + (u.plans === 1 ? "" : "s") + "</b> · " + esc(L.fmtSize(u.libraryBytes)) + " on this device"];
    if (u.quota) parts.push(esc(L.fmtSize(u.free)) + " free for the portal");
    parts.push(u.persisted ? "kept safe from automatic cleanup" : "the browser may clear these files if the device runs low on space");
    el("plUsage").innerHTML = parts.join(" · ") +
      (!u.persisted && u.plans ? ' <button type="button" class="pl-btn" id="plProtect">Protect these files</button>' : "");
    var pb = el("plProtect");
    if (pb) pb.onclick = async function () {
      var ok = await L.protect();
      paintUsage();
      if (!ok) setStatus(esc("This browser decided not to protect the files yet. Installing the portal as an app " +
        "(the install button on the Home page) usually lets it keep them."));
    };
  }

  async function paintReadiness() {
    if (!navigator.onLine) return;
    var r = await L.offlineReady();
    var last = await L.lastChecked();
    var bits = [];
    if (last) bits.push("Last checked for new versions " + esc(L.fmtAgo(last)) + ".");
    if ((await L.list()).some(function (e) { return e.hasFile; })) {
      bits.push(r.tool
        ? '<span class="ok">Ready to open with no internet.</span>'
        : '<span class="warn">Getting the takeoff tool ready to work offline…</span>');
      // Not ready (a new device, or the tool was just updated): try once more
      // now rather than tomorrow.
      if (!r.tool && !forcedWarm) { forcedWarm = true; L.warmOffline(true); }
    }
    if (!busyCheck) setStatus(bits.join(" "));
  }

  function paintProgress(m) {
    var row = document.querySelector('.pl-file[data-key="' + (window.CSS && CSS.escape ? CSS.escape(m.key) : m.key) + '"]');
    if (!row) { queueRender(); return; }
    var st = row.querySelector(".pl-fstate"), fill = row.querySelector(".pl-bar-fill");
    if (!st || !fill || st.className.indexOf("s-new") === -1) { queueRender(); return; }
    var pct = m.size ? Math.min(100, Math.floor((m.done / m.size) * 100)) : 0;
    var hasFile = /Updating/.test(st.textContent);
    st.textContent = (hasFile ? "Updating to the new version " : "Downloading ") + pct + "% · " + L.fmtSize(m.done) + " of " +
      L.fmtSize(m.size) + (m.rate ? " · " + L.fmtSize(m.rate) + "/s" : "") + (hasFile ? " — your saved copy still opens" : "");
    fill.style.width = pct + "%";
  }

  /* ── actions ───────────────────────────────────────────────────────────── */
  function reportError(e, title) {
    if (e && e.code === "paused") return;        // the row already says so
    DCR.alert((e && e.message) || "Something went wrong.", { title: title || "Plans Library" });
  }

  async function act(btn) {
    var row = btn.closest(".pl-file");
    var id = row ? row.getAttribute("data-id") : "";
    var what = btn.getAttribute("data-act");
    if (row && document.activeElement === btn) {
      refocus = { key: row.getAttribute("data-key"), act: what === "pause" ? "resume" : what === "resume" || what === "update" ? "pause" : "open" };
    }
    if (what === "open") {
      var e = await L.entry(id);
      if (!e) return;
      if (e.status === "outdated" && navigator.onLine) {
        var go = await DCR.confirm("SharePoint has a newer version of this plan (" + L.fmtWhen(e.latest.modifiedTime) +
          "). Your saved copy is from " + L.fmtWhen(e.modifiedTime) + ". Open the saved copy anyway?",
          { title: "Newer version available", okText: "Open saved copy", cancelText: "Cancel" });
        if (!go) return;
      }
      try { await L.open(id); } catch (x) { reportError(x, "Could not open"); }
      return;
    }
    if (what === "update" || what === "resume") {
      btn.disabled = true;
      L[what](id).then(function (r) {
        if (r && r.already) setStatus("That saved copy was already the newest version.");
      }).catch(function (x) { reportError(x, what === "update" ? "Could not update" : "Could not resume"); });
      queueRender();
      return;
    }
    if (what === "pause") { L.pause(id); return; }
    if (what === "remove") {
      var en = await L.entry(id);
      if (!en) return;
      var freed = (en.hasFile ? Number(en.size) || 0 : 0) + (en.dl ? Number(en.dl.done) || 0 : 0);
      var inTool = await L.openInTool(id);
      var ok = await DCR.confirm("Remove “" + en.name + "” from this device? " + L.fmtSize(freed) +
        " will be freed" + (inTool ? " once you close it in Professional Takeoff Tools, where it is open now" : "") +
        ". The file stays in SharePoint, and you can save it again any time.",
        { title: "Remove saved plan", okText: "Remove", cancelText: "Keep it", danger: true });
      if (!ok) return;
      try { await L.remove(id); } catch (x) { reportError(x, "Could not remove"); }
      return;
    }
    if (what === "save-newer") {
      btn.disabled = true;
      var pid = btn.getAttribute("data-pid");
      var projs = await L.projects();
      var p = projs[pid] || {};
      L.save({
        id: btn.getAttribute("data-fid"), name: btn.getAttribute("data-name"), source: "archive",
        projectId: pid, projectCode: p.code || "", projectTitle: p.title || "", projectSub: p.sub || "",
        folder: btn.getAttribute("data-folder") || "",
      }).catch(function (x) { reportError(x, "Could not save"); });
      queueRender();
    }
  }

  async function checkNow(quiet) {
    if (busyCheck || !navigator.onLine) return;
    busyCheck = true;
    el("plCheck").disabled = true;
    if (!quiet) setStatus("Checking SharePoint for new versions…");
    try {
      var s = await L.checkUpdates({ hints: true });
      var bits = [];
      if (s.unsupported) bits.push("The portal cannot check versions yet.");
      else if (!s.checked) bits.push("Nothing to check.");
      else {
        bits.push("Checked " + s.checked + " plan" + (s.checked === 1 ? "" : "s") + ":");
        bits.push(s.updates ? s.updates + " with a new version." : "all up to date.");
        if (s.gone) bits.push(s.gone + " no longer in SharePoint.");
        if (s.denied) bits.push(s.denied + " no longer open to your account.");
        if (s.errors) bits.push(s.errors + " could not be checked just now.");
      }
      busyCheck = false;
      setStatus(esc(bits.join(" ")));
    } catch (x) {
      busyCheck = false;
      setStatus(esc((x && x.message) || "Could not check for new versions."));
    } finally {
      el("plCheck").disabled = !navigator.onLine;
      queueRender();
    }
  }

  /* Downloads a closed window or a dropped connection interrupted carry on by
     themselves; one the owner paused stays paused. One at a time, oldest
     first, so a phone is not asked for three big files at once. */
  async function autoResume() {
    if (!navigator.onLine) return;
    var list = await L.list();
    var todo = list.filter(function (e) { return e.status === "paused" && e.dl && !e.dl.userPaused; });
    for (var i = 0; i < todo.length; i++) {
      if (!navigator.onLine) return;
      try { await L.resume(todo[i].id); } catch (x) { /* the row shows why */ }
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    el("companyName").textContent = DCR.company + " Portal";
    el("logoutBtn").onclick = function () { DCR.logout(); };
    el("plCheck").onclick = function () { checkNow(false); };
    el("plUpdateAll").onclick = async function () {
      var list = await L.list();
      var todo = list.filter(function (e) { return e.status === "outdated"; });
      var total = todo.reduce(function (n, e) { return n + (Number(e.latest && e.latest.size) || 0); }, 0);
      var ok = await DCR.confirm("Download the new version of " + todo.length + " plans (" + L.fmtSize(total) +
        ")? Each saved copy keeps opening until its new version has finished.", { title: "Update all", okText: "Update all" });
      if (!ok) return;
      for (var i = 0; i < todo.length; i++) {
        try { await L.update(todo[i].id); } catch (x) { reportError(x, "Could not update"); break; }
      }
    };
    el("plList").addEventListener("click", function (ev) {
      var b = ev.target.closest("button[data-act]");
      if (b && !b.disabled) act(b);
    });

    // Only the storage itself decides whether the list shows. Whether this
    // browser can also DOWNLOAD here is asked when a download starts: that
    // check fetches a script, and a weak signal must not hide saved plans.
    if (!L.supported()) {
      el("plList").innerHTML = '<div class="pl-empty">This browser cannot keep plan files on the device. ' +
        "Use Chrome or Edge on a computer or Android phone, or Safari 16.4 or newer on an iPhone or iPad.</div>";
      el("plCheck").disabled = true;
      return;
    }

    /* Who is signed in comes from the session token on this device, so the
       saved plans draw at once. On a weak signal the portal can take many
       seconds to answer, and that must not keep the plans out of reach; it is
       asked afterwards, for the name on the pill and to know whether this
       page is online. */
    if (!L.owner()) {
      if (navigator.onLine) { location.href = "index.html?next=" + encodeURIComponent("plans-library.html"); return; }
      el("plList").innerHTML = '<div class="pl-empty">Sign in to the portal while you are online to use your Plans Library on this device.</div>';
      el("plCheck").disabled = true;
      return;
    }
    sess = { signedIn: true };                     // online unknown until the portal answers

    L.onChange(function (m) {
      if (m.t === "progress") paintProgress(m);
      else if (m.key === "warm") paintReadiness();
      else queueRender();
    });
    window.addEventListener("online", function () { netBanner(); checkNow(true); autoResume(); queueRender(); });
    window.addEventListener("offline", function () { netBanner(); queueRender(); });

    try { await L.sweep(); } catch (x) { /* leftovers can wait for the next visit */ }
    try { await L.verifyFiles(); } catch (x) { /* checked again on the next visit */ }
    await render();

    sess = await L.session();
    if (!sess.signedIn) {
      if (sess.expired) return;                    // already on the way to the sign-in page
      if (navigator.onLine) { location.href = "index.html?next=" + encodeURIComponent("plans-library.html"); return; }
    }
    el("userPill").textContent = (sess.online && sess.me && sess.me.displayName) || sess.name || "Signed in";
    netBanner();

    // With nothing saved there is nothing to keep current or ready offline.
    if (sess.online && (await L.list()).length) {
      L.warmOffline();
      var last = await L.lastChecked();
      if (!last || Date.now() - Date.parse(last) > AUTO_CHECK_GAP) await checkNow(true);
      else paintReadiness();
      if (!autoResumed) { autoResumed = true; autoResume(); }
      setTimeout(paintReadiness, 9000);           // the tool's worker takes a few seconds to install
    }
  });
})();
