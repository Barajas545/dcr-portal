/* Compare live SharePoint data against a stored backup.

   Strictly read-only, and deliberately so: it reuses the two backup ops that
   already exist (op=part reads a stored snapshot, op=chunk reads live rows)
   and does the diff here in the browser. No new server-side capability is
   introduced, so this screen structurally cannot alter anything.

   Only the columns SharePoint actually stores are compared. Calculated
   columns are excluded — they recompute from their inputs, so reporting them
   would mean every changed price shows up twice. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { runs: [], manifest: null, results: null };

  function err(m) { var e = el("pageErr"); e.textContent = m || ""; e.style.display = m ? "block" : "none"; }
  function status(m) { el("rsStatus").textContent = m || ""; }

  // A value is "the same" if it round-trips to the same text. Absent, null and
  // "" all mean empty in SharePoint, so they must not read as a change.
  function norm(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  }

  // Columns worth comparing: what the backup recorded as writable, minus the
  // ones SharePoint stamps on every save (they always differ and mean nothing).
  var STAMP = { Modified: 1, Created: 1, Editor: 1, Author: 1, Modified_x0020_By: 1, Created_x0020_By: 1 };
  function compareCols(part) {
    var w = part.writableColumns || [];
    return w.filter(function (c) { return !STAMP[c]; });
  }

  async function liveRows(listId, onProgress) {
    var rows = [], cursor = null, guard = 0;
    do {
      var q = "/api/portal?action=backup&op=chunk&listId=" + encodeURIComponent(listId) +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
      var page = await DCR.api(q);
      rows = rows.concat(page.items || []);
      cursor = page.nextCursor;
      if (onProgress) onProgress(rows.length);
    } while (cursor && ++guard < 400);
    return rows;
  }

  function diffList(part, live) {
    var cols = compareCols(part);
    var byId = {}, out = { identical: 0, changed: [], deleted: [], created: 0, cols: cols.length };
    live.forEach(function (r) { byId[String(r.id)] = r; });
    var seen = {};
    (part.items || []).forEach(function (b) {
      var id = String(b.id);
      seen[id] = 1;
      var l = byId[id];
      if (!l) {
        out.deleted.push({ id: id, title: b.fields && (b.fields.Title || b.fields.FileLeafRef) || "",
          lastBy: b.lastModifiedBy, lastAt: b.lastModifiedDateTime });
        return;
      }
      var fields = [];
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        var was = norm(b.fields ? b.fields[c] : undefined);
        var is = norm(l.fields ? l.fields[c] : undefined);
        if (was !== is) fields.push({ col: c, was: was, is: is });
      }
      if (fields.length) {
        out.changed.push({ id: id, title: (l.fields && l.fields.Title) || (b.fields && b.fields.Title) || "",
          fields: fields, lastBy: l.lastModifiedBy, lastAt: l.lastModifiedDateTime });
      } else out.identical++;
    });
    live.forEach(function (r) { if (!seen[String(r.id)]) out.created++; });
    return out;
  }

  async function runCompare() {
    var runId = el("rsRun").value;
    if (!runId) return;
    el("rsGo").disabled = true;
    err(""); state.results = null;
    el("rsSummary").innerHTML = ""; el("rsTable").innerHTML = "";

    try {
      status("Reading the backup…");
      var manifest = await DCR.api("/api/portal?action=backup&op=part&runId=" +
        encodeURIComponent(runId) + "&name=manifest.json");
      state.manifest = manifest;

      var wantFiles = el("rsFiles").checked;
      var entries = (manifest.lists || []).filter(function (m) {
        return wantFiles || m.rowRestorable !== false;
      });

      var results = [];
      for (var i = 0; i < entries.length; i++) {
        var m = entries[i];
        el("rsBar").style.width = Math.round((i / entries.length) * 100) + "%";
        status("Comparing " + m.displayName + " (" + (i + 1) + " of " + entries.length + ")…");
        try {
          var part = await DCR.api("/api/portal?action=backup&op=part&runId=" +
            encodeURIComponent(runId) + "&name=" + encodeURIComponent(m.part));
          var live = await liveRows(m.listId, function (n) {
            status("Comparing " + m.displayName + " — " + n + " live rows…");
          });
          var d = diffList(part, live);
          d.displayName = m.displayName; d.listId = m.listId;
          d.backupCount = (part.items || []).length; d.liveCount = live.length;
          results.push(d);
        } catch (e) {
          results.push({ displayName: m.displayName, listId: m.listId, error: (e.message || "failed").slice(0, 70),
            identical: 0, changed: [], deleted: [], created: 0 });
        }
        render(results, entries.length);
      }
      el("rsBar").style.width = "100%";
      state.results = results;
      status("Done.");
    } catch (e) {
      err(e.message || "Compare failed.");
      status("");
    }
    el("rsGo").disabled = false;
  }

  function render(results, total) {
    var del = 0, chg = 0, add = 0, same = 0, errs = 0;
    results.forEach(function (r) {
      del += r.deleted.length; chg += r.changed.length; add += r.created; same += r.identical;
      if (r.error) errs++;
    });
    el("rsSummary").innerHTML =
      '<div class="rs-cards">' +
      '<div class="rs-card ' + (del ? "bad" : "ok") + '"><div class="k">Rows deleted</div><div class="v">' + del + "</div></div>" +
      '<div class="rs-card ' + (chg ? "warn" : "ok") + '"><div class="k">Rows altered</div><div class="v">' + chg + "</div></div>" +
      '<div class="rs-card"><div class="k">Added since</div><div class="v">' + add + "</div></div>" +
      '<div class="rs-card ok"><div class="k">Unchanged</div><div class="v">' + same.toLocaleString() + "</div></div>" +
      (errs ? '<div class="rs-card bad"><div class="k">Lists failed</div><div class="v">' + errs + "</div></div>" : "") +
      "</div>" +
      '<div class="rs-note">' + results.length + " of " + total + " lists compared." +
      (del ? " <b>Rows present in the backup and missing now are the ones to investigate.</b>" : "") + "</div>";

    el("rsTable").innerHTML =
      '<table class="rs"><thead><tr><th>List</th><th class="n">In backup</th><th class="n">Live now</th>' +
      '<th class="n">Deleted</th><th class="n">Altered</th><th class="n">Added</th><th></th></tr></thead><tbody>' +
      results.map(function (r, i) {
        if (r.error) {
          return "<tr><td>" + esc(r.displayName) + '</td><td colspan="6" class="rs-del">' + esc(r.error) + "</td></tr>";
        }
        var interesting = r.deleted.length || r.changed.length;
        return "<tr><td>" + esc(r.displayName) + "</td>" +
          '<td class="n">' + r.backupCount + '</td><td class="n">' + r.liveCount + "</td>" +
          '<td class="n' + (r.deleted.length ? " rs-del" : "") + '">' + r.deleted.length + "</td>" +
          '<td class="n' + (r.changed.length ? " rs-chg" : "") + '">' + r.changed.length + "</td>" +
          '<td class="n rs-new">' + r.created + "</td>" +
          "<td>" + (interesting ? '<span class="rs-open" data-i="' + i + '">show</span>' : "") + "</td></tr>" +
          '<tr id="rsD' + i + '" style="display:none"><td colspan="7" class="rs-detail">' +
            detailHtml(r) + "</td></tr>";
      }).join("") + "</tbody></table>";

    el("rsTable").querySelectorAll("[data-i]").forEach(function (b) {
      b.onclick = function () {
        var row = el("rsD" + b.dataset.i);
        var open = row.style.display !== "none";
        row.style.display = open ? "none" : "";
        b.textContent = open ? "show" : "hide";
      };
    });
  }

  function detailHtml(r) {
    var h = "";
    if (r.deleted.length) {
      h += '<div style="margin:6px 0"><b class="rs-del">Deleted since the backup (' + r.deleted.length + ")</b>" +
        "<table>" + r.deleted.slice(0, 40).map(function (d) {
          return "<tr><td>row " + esc(d.id) + "</td><td>" + esc(d.title || "") + "</td>" +
            '<td class="rs-note">last touched by ' + esc(d.lastBy || "?") + " " + esc(String(d.lastAt || "").slice(0, 10)) + "</td></tr>";
        }).join("") + "</table>" +
        (r.deleted.length > 40 ? '<div class="rs-note">…and ' + (r.deleted.length - 40) + " more</div>" : "") + "</div>";
    }
    if (r.changed.length) {
      h += '<div style="margin:6px 0"><b class="rs-chg">Altered since the backup (' + r.changed.length + ")</b>" +
        "<table>" + r.changed.slice(0, 30).map(function (c) {
          return "<tr><td>row " + esc(c.id) + "</td><td>" + esc(c.title || "") + "</td><td>" +
            c.fields.slice(0, 6).map(function (f) {
              return "<div><b>" + esc(f.col) + "</b>: " +
                '<span class="rs-was">' + esc(f.was.slice(0, 60) || "(empty)") + "</span> → " +
                '<span class="rs-is">' + esc(f.is.slice(0, 60) || "(empty)") + "</span></div>";
            }).join("") +
            (c.fields.length > 6 ? '<div class="rs-note">+' + (c.fields.length - 6) + " more fields</div>" : "") +
            '</td><td class="rs-note">by ' + esc(c.lastBy || "?") + " " + esc(String(c.lastAt || "").slice(0, 10)) + "</td></tr>";
        }).join("") + "</table>" +
        (r.changed.length > 30 ? '<div class="rs-note">…and ' + (r.changed.length - 30) + " more</div>" : "") + "</div>";
    }
    return h || '<div class="rs-note">No differences.</div>';
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal — Compare";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    if (profile.role !== "Admin") { err("This screen is available to administrators only."); return; }
    el("rsGo").onclick = runCompare;
    try {
      var d = await DCR.api("/api/portal?action=backup&op=runs");
      state.runs = (d.runs || []).filter(function (r) { return r.complete; });
      if (!state.runs.length) {
        err("There are no completed backups to compare against yet — take one first.");
        return;
      }
      el("rsRun").innerHTML = state.runs.map(function (r) {
        return '<option value="' + esc(r.runId) + '">' + esc(r.runId) + " · " + r.parts + " lists</option>";
      }).join("");
      el("rsGo").disabled = false;
    } catch (e) { err(e.message || "Could not load the backup list."); }
  });
})();
