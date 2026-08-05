/* Admin database backup.

   The browser is the job engine: the server exposes small resumable reads
   (plan / columns / chunk) and an upload session, and this page walks every
   list, assembles the snapshot, writes it into the tenant as per-list part
   files, and optionally hands the admin a single downloadable copy.

   Why here and not on the server: a Vercel Hobby invocation gets ~10 seconds,
   nowhere near enough to walk 41 lists. Splitting the loop this way also makes
   a failed run resumable instead of all-or-nothing. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { plan: null, snapshot: null, running: false, blobUrl: null };

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }
  function daysSince(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return null;
    return Math.floor((Date.now() - t) / 86400000);
  }
  function err(m) { var e = el("pageErr"); e.textContent = m || ""; e.style.display = m ? "block" : "none"; }
  function status(m) { el("bkStatus").textContent = m || ""; }

  /* ── the age indicator: this number IS the measure of protection ── */
  function renderHero(runs) {
    var last = runs && runs.length ? runs[0] : null;
    var d = last ? daysSince(last.modifiedTime) : null;
    var cls = d === null ? "bk-bad" : d <= 7 ? "bk-ok" : d <= 30 ? "bk-warn" : "bk-bad";
    var txt = d === null ? "Never" : d === 0 ? "Today" : d + (d === 1 ? " day" : " days");
    el("bkHero").innerHTML =
      '<span class="bk-dot ' + cls + '"></span>' +
      '<div><div class="bk-age">' + esc(txt) + '<span class="u">' +
        (last ? "since the last backup · " + esc(last.runId) : "no backup has ever been taken") + "</span></div></div>" +
      '<span style="flex:1"></span>' +
      (last && last.webUrl ? '<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener noreferrer" href="' +
        esc(last.webUrl) + '">Open in SharePoint ↗</a>' : "");
  }

  function renderWarn(plan) {
    var noReg = (plan.lists || []).filter(function (l) { return !l.registryKey; });
    var noRows = (plan.lists || []).filter(function (l) { return !l.rowRestorable; });
    el("bkWarn").innerHTML =
      "<b>What this backup does and does not cover.</b><br>" +
      "It captures every row and every column of <b>" + plan.lists.length +
      " lists</b>, exactly as SharePoint returns them, plus each list's full column definitions. " +
      "It does <b>not</b> capture: files attached to individual rows (Microsoft's API cannot read them), " +
      "the edit history behind each row, or the project files in OneDrive — those are inventoried separately, not copied.<br>" +
      (noRows.length ? "<br><b>Metadata only:</b> " + esc(noRows.map(function (l) { return l.displayName; }).join(", ")) +
        " is a document library — its rows describe files, so they are recorded but cannot be restored as rows." : "") +
      (noReg.length ? "<br><br><b>Note:</b> " + esc(noReg.map(function (l) { return l.displayName; }).join(", ")) +
        " are outside the app's own table list, so they are only ever captured by this tool." : "") +
      "<br><br>Try SharePoint's <b>Recycle Bin</b> first for anything deleted in the last 93 days — it restores rows " +
      "with their original row numbers, which keeps every link between tables intact. This backup is for after that window closes.";
  }

  function rowsHtml(plan, done) {
    return plan.lists.map(function (l) {
      var d = done[l.listId];
      return '<div class="bk-row"><span class="st">' + (d ? (d.error ? "⚠" : "✓") : "·") + "</span>" +
        '<span class="nm">' + esc(l.displayName) + (l.rowRestorable ? "" : ' <span class="ct">(metadata)</span>') + "</span>" +
        '<span class="ct">' + (d ? (d.error ? esc(d.error) : d.count + " rows") : "") + "</span></div>";
    }).join("");
  }

  /* ── the run ── */
  async function runBackup() {
    if (state.running) return;
    state.running = true;
    el("bkGo").disabled = true;
    el("bkDl").style.display = "none";
    el("bkRows").style.display = "block";
    err("");

    var plan = state.plan;
    var done = {};
    var snapshot = {
      format: "dcr-backup", version: 1,
      runId: plan.runId, takenAt: new Date().toISOString(),
      takenBy: plan.startedBy || "", site: plan.site,
      skippedLists: plan.skippedLists, lists: [],
    };

    try {
      for (var i = 0; i < plan.lists.length; i++) {
        var l = plan.lists[i];
        status("Reading " + l.displayName + " (" + (i + 1) + " of " + plan.lists.length + ")…");
        el("bkBar").style.width = Math.round((i / plan.lists.length) * 100) + "%";
        try {
          var cols = await DCR.api("/api/portal?action=backup&op=columns&listId=" + encodeURIComponent(l.listId));
          var items = [], attach = [], cursor = null, guard = 0;
          do {
            var q = "/api/portal?action=backup&op=chunk&listId=" + encodeURIComponent(l.listId) +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
            var page = await DCR.api(q);
            items = items.concat(page.items || []);
            attach = attach.concat(page.attachmentRowIds || []);
            cursor = page.nextCursor;
            el("bkRows").innerHTML = rowsHtml(plan, done);
            status("Reading " + l.displayName + " — " + items.length + " rows…");
          } while (cursor && ++guard < 400);

          snapshot.lists.push({
            listId: l.listId, displayName: l.displayName, name: l.name,
            registryKey: l.registryKey, rowRestorable: l.rowRestorable,
            listInfo: cols.listInfo, columns: cols.columns,
            writableColumns: cols.writableColumns, calculatedColumns: cols.calculatedColumns,
            rowsWithAttachments: attach, items: items,
          });
          done[l.listId] = { count: items.length };
        } catch (e) {
          done[l.listId] = { count: 0, error: (e.message || "failed").slice(0, 60) };
        }
        el("bkRows").innerHTML = rowsHtml(plan, done);
      }

      // ── write it into the tenant, one part file per list ──
      var manifest = {
        format: snapshot.format, version: snapshot.version, runId: snapshot.runId,
        takenAt: snapshot.takenAt, takenBy: snapshot.takenBy, site: snapshot.site,
        skippedLists: snapshot.skippedLists, lists: [],
      };
      for (var j = 0; j < snapshot.lists.length; j++) {
        var s = snapshot.lists[j];
        var partName = "part-" + String(j + 1).padStart(3, "0") + "-" +
          String(s.name || s.displayName).replace(/[^0-9A-Za-z._-]/g, "") .slice(0, 40) + ".json";
        status("Saving " + s.displayName + " to SharePoint…");
        el("bkBar").style.width = Math.round(((j + 1) / snapshot.lists.length) * 100) + "%";
        await uploadJson(plan.runId, partName, s);
        manifest.lists.push({
          listId: s.listId, displayName: s.displayName, name: s.name,
          registryKey: s.registryKey, rowRestorable: s.rowRestorable,
          itemCount: s.items.length, columnCount: (s.columns || []).length,
          rowsWithAttachments: s.rowsWithAttachments.length, part: partName,
          error: done[s.listId] && done[s.listId].error || null,
        });
      }
      await uploadJson(plan.runId, "manifest.json", manifest);
      await DCR.api("/api/portal?action=backup", { method: "POST", body: { op: "finalize", runId: plan.runId } });

      state.snapshot = snapshot;
      var totalRows = snapshot.lists.reduce(function (a, s) { return a + s.items.length; }, 0);
      var failed = Object.keys(done).filter(function (k) { return done[k].error; }).length;
      el("bkBar").style.width = "100%";
      status("✓ Backed up " + totalRows.toLocaleString() + " rows from " + snapshot.lists.length +
        " lists" + (failed ? " (" + failed + " had errors — see the list)" : "") + ".");
      el("bkDl").style.display = "";
      loadRuns();
    } catch (e) {
      err(e.message || "Backup failed.");
      status("");
    }
    state.running = false;
    el("bkGo").disabled = false;
  }

  // Chunked PUT straight to SharePoint's pre-authed URL — the same path the
  // photo uploads use, so a big list never touches the serverless size limit.
  async function uploadJson(runId, name, obj) {
    var blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
    var s = await DCR.api("/api/portal?action=backup", { method: "POST",
      body: { op: "beginUpload", runId: runId, name: name } });
    var CHUNK = 320 * 1024 * 16, pos = 0, total = blob.size;
    if (!total) return;
    while (pos < total) {
      var end = Math.min(pos + CHUNK, total);
      await new Promise(function (resolve, reject) {
        var x = new XMLHttpRequest();
        x.open("PUT", s.uploadUrl);
        x.setRequestHeader("Content-Range", "bytes " + pos + "-" + (end - 1) + "/" + total);
        x.onload = function () {
          if (x.status >= 200 && x.status < 300) resolve();
          else reject(new Error("Upload of " + name + " failed (" + x.status + ")"));
        };
        x.onerror = function () { reject(new Error("Upload of " + name + " failed — check your connection.")); };
        x.send(blob.slice(pos, end));
      });
      pos = end;
    }
  }

  function download() {
    if (!state.snapshot) return;
    var json = JSON.stringify(state.snapshot);
    var blob = new Blob([json], { type: "application/json" });
    if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = state.blobUrl;
    a.download = "dcr-backup-" + state.snapshot.runId + ".json";
    a.click();
    status("Downloaded " + fmtBytes(blob.size) + ". This file is unencrypted and contains " +
      "the Passwords list and client details — keep it somewhere you control.");
  }

  async function loadRuns() {
    try {
      var d = await DCR.api("/api/portal?action=backup&op=runs");
      renderHero(d.runs);
      el("bkRuns").innerHTML = d.runs.length
        ? '<table class="bk-runs"><thead><tr><th>Run</th><th>When</th><th>Lists</th><th>Size</th><th></th></tr></thead><tbody>' +
          d.runs.map(function (r) {
            var d2 = daysSince(r.modifiedTime);
            return "<tr><td>" + esc(r.runId) + (r.complete ? "" : ' <span style="color:var(--err,#d9614f)">incomplete</span>') + "</td>" +
              "<td>" + (d2 === null ? "" : d2 === 0 ? "today" : d2 + "d ago") + "</td>" +
              "<td>" + r.parts + "</td><td>" + fmtBytes(r.bytes) + "</td>" +
              '<td>' + (r.webUrl ? '<a target="_blank" rel="noopener noreferrer" href="' + esc(r.webUrl) + '">open ↗</a>' : "") + "</td></tr>";
          }).join("") + "</tbody></table>"
        : '<div class="bk-note">No backups yet.</div>';
    } catch (e) { el("bkRuns").innerHTML = '<div class="bk-note">' + esc(e.message) + "</div>"; }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal — Backup";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    if (profile.role !== "Admin") {
      err("Backups are available to administrators only.");
      el("bkHero").innerHTML = "";
      return;
    }
    el("bkGo").onclick = runBackup;
    el("bkDl").onclick = download;
    loadRuns();
    try {
      state.plan = await DCR.api("/api/portal?action=backup&op=plan");
      renderWarn(state.plan);
      el("bkPlanNote").innerHTML = "Ready to capture <b>" + state.plan.lists.length +
        "</b> lists. The snapshot is written into <b>SharePoint → Database Backups</b>, " +
        "and you can download a copy afterwards.";
      el("bkGo").disabled = false;
      el("bkRows").innerHTML = rowsHtml(state.plan, {});
    } catch (e) {
      err(e.message || "Could not read the list of tables.");
    }
  });
})();
