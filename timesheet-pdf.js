/* Timesheet → PDF, matching the DCR Framing paper timesheet form.
   The user picks a single day or the whole week; we build a real PDF (one page
   per date + job) and share it via the OS share sheet (phone) or download it
   (desktop). jsPDF + autoTable are loaded lazily from CDN on first use.
   Wire-up: a #tsPdfBtn button on the page opens the chooser. */
(function () {
  var CDN = {
    jspdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
    autotable: "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
  };
  var BLUE = [37, 99, 175];    // template blue for filled-in values
  var BLACK = [20, 20, 20];
  var LINE = [140, 140, 140];

  var libPromise = null, profile = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load the PDF tool. Check your internet connection.")); };
      document.head.appendChild(s);
    });
  }
  function loadLibs() {
    if (!libPromise) libPromise = loadScript(CDN.jspdf).then(function () { return loadScript(CDN.autotable); });
    return libPromise;
  }

  /* ── formatting (DST-correct wall-clock time, same convention as timesheet.js) ── */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function clock(iso) {
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d)) return "";
    var h = d.getHours(), m = d.getMinutes(), ap = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12;
    return h12 + ":" + String(m).padStart(2, "0") + ":00 " + ap;
  }
  function dateKey(v) { if (!v) return ""; var d = new Date(v); return isNaN(d) ? "" : d.toISOString().split("T")[0]; }
  function longDate(key) {
    var p = String(key).split("-"); if (p.length !== 3) return key;
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function getSaturdayOf(date) { var d = new Date(date); d.setHours(0, 0, 0, 0); var day = d.getDay(); d.setDate(d.getDate() - (day === 6 ? 0 : day + 1)); return d; }

  /* ── group entries into template sheets (one per date + job) ── */
  function buildSheets(items, scopeMode, anchorKey) {
    var days;
    if (scopeMode === "week") {
      var start = getSaturdayOf(new Date(anchorKey + "T12:00:00"));
      days = [];
      for (var i = 0; i < 7; i++) { var d = new Date(start); d.setDate(d.getDate() + i); days.push(d.toISOString().split("T")[0]); }
    } else {
      days = [anchorKey];
    }
    var groups = {}, order = [];
    items.forEach(function (x) {
      var dk = dateKey(x.timeSheetDate);
      if (days.indexOf(dk) === -1) return;
      var job = x.timeSheetProjectName || "";
      var k = dk + "||" + job;
      if (!groups[k]) { groups[k] = { dateKey: dk, job: job, rows: [] }; order.push(k); }
      groups[k].rows.push(x);
    });
    order.sort();
    return order.map(function (k) { return groups[k]; });
  }

  /* ── draw one form page ── */
  function renderSheet(doc, sheet, company) {
    var M = 40, y = M + 6;
    doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(BLACK[0], BLACK[1], BLACK[2]);
    doc.text(company.toUpperCase() + " TIMESHEET", M, y); y += 34;

    function labelValue(label, value) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.setTextColor(BLACK[0], BLACK[1], BLACK[2]);
      doc.text(label, M, y);
      doc.setFont("helvetica", "bold"); doc.setTextColor(BLUE[0], BLUE[1], BLUE[2]);
      doc.text(value || "", M + doc.getTextWidth(label) + 8, y);
      y += 22;
    }
    labelValue("Job Name / Nombre del trabajo:", sheet.job || "—");
    labelValue("Today's date / Fecha:", longDate(sheet.dateKey));
    y += 4;

    var body = [], total = 0, workTexts = [];
    sheet.rows.forEach(function (x) {
      total += num(x.timeSheetWorkHours);
      body.push([
        x.timeSheetEmployeeName || "",
        clock(x.timeSheetWorkStatTime),
        clock(x.timeSheetWorkEndTime2 || x.timeSheetWorkEndTime),
        num(x.timeSheetWorkHours) ? String(num(x.timeSheetWorkHours)) : "",
      ]);
      if (x.timeSheetWorkCompleted) {
        workTexts.push((sheet.rows.length > 1 ? (x.timeSheetEmployeeName + ": ") : "") + x.timeSheetWorkCompleted);
      }
    });
    for (var p = Math.max(0, 10 - body.length); p > 0; p--) body.push(["", "", "", ""]);

    // Work Completed — with the date added, per request.
    var workContent = longDate(sheet.dateKey) + (workTexts.length ? "\n" + workTexts.join("\n") : "");
    body.push([{ content: "Work Completed / trabajo completado:", colSpan: 4,
      styles: { fontStyle: "bold", textColor: BLACK, halign: "left" } }]);
    body.push([{ content: workContent, colSpan: 4,
      styles: { textColor: BLUE, minCellHeight: 86, valign: "top", halign: "left" } }]);
    body.push([{ content: "TOTAL DIARIO", colSpan: 3, styles: { fontStyle: "bold", textColor: BLACK } },
      { content: total ? String(total) : "", styles: { fontStyle: "bold", textColor: BLUE, halign: "center" } }]);

    doc.autoTable({
      startY: y,
      head: [["Nombre", "Hora de Inicio", "Hora de finalización", "Horas trabajadas"]],
      body: body,
      theme: "grid",
      styles: { fontSize: 11, cellPadding: 5, lineColor: LINE, lineWidth: 0.7, textColor: BLUE, overflow: "linebreak" },
      headStyles: { fillColor: [255, 255, 255], textColor: BLACK, fontStyle: "normal", lineColor: LINE, lineWidth: 0.7, halign: "left" },
      bodyStyles: { minCellHeight: 24 },
      columnStyles: { 1: { halign: "center" }, 2: { halign: "center" }, 3: { halign: "center" } },
      margin: { left: M, right: M },
    });
  }

  // Pure: given already-grouped sheets, produce the PDF blob (no network).
  function renderToBlob(sheets, company) {
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    var co = company || DCR.company || "DCR";
    sheets.forEach(function (sheet, i) { if (i > 0) doc.addPage(); renderSheet(doc, sheet, co); });
    return doc.output("blob");
  }

  async function buildBlob(scopeMode, anchorKey) {
    await loadLibs();
    var data = await DCR.api("/api/portal?action=timesheets");
    var sheets = buildSheets(data.items || [], scopeMode, anchorKey);
    if (!sheets.length) throw new Error("No timesheet entries were found for the selected " + (scopeMode === "week" ? "week" : "day") + ".");
    var blob = renderToBlob(sheets, DCR.company || "DCR");
    var who = ((profile && (profile.displayName || profile.email)) || "timesheet").split("@")[0].trim().replace(/\s+/g, "-");
    var stamp = scopeMode === "week" ? ("Week-" + sheets[0].dateKey) : anchorKey;
    return { blob: blob, name: "Timesheet-" + who + "-" + stamp + ".pdf", pages: sheets.length };
  }

  async function shareOrDownload(scopeMode, anchorKey) {
    var out = await buildBlob(scopeMode, anchorKey);
    var file = new File([out.blob], out.name, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Timesheet", text: "My timesheet" }); return "shared"; }
      catch (e) { if (e && e.name === "AbortError") return "cancelled"; }
    }
    var url = URL.createObjectURL(out.blob);
    var a = document.createElement("a"); a.href = url; a.download = out.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    return "downloaded";
  }

  /* ── chooser modal ── */
  function openModal() {
    var todayKey = (function () { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;";
    ov.innerHTML =
      '<div style="background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border,#ccc);border-radius:14px;max-width:380px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.4)">' +
      '<h3 style="margin:0 0 4px;font-size:17px">📄 Send timesheet as PDF</h3>' +
      '<p style="margin:0 0 14px;font-size:13px;color:var(--text-muted,#777)">Creates a PDF in the DCR form and opens your share options (email, text…).</p>' +
      '<label style="display:block;font-size:12px;font-weight:600;margin:0 0 6px">What to send</label>' +
      '<div id="tpScope" style="display:flex;gap:8px;margin-bottom:14px">' +
        '<button type="button" data-scope="day" class="btn btn-sm" style="flex:1">Just this day</button>' +
        '<button type="button" data-scope="week" class="btn btn-ghost btn-sm" style="flex:1">The whole week</button>' +
      '</div>' +
      '<label style="display:block;font-size:12px;font-weight:600;margin:0 0 6px" id="tpDateLabel">Date</label>' +
      '<input id="tpDate" type="date" value="' + todayKey + '" style="width:100%;box-sizing:border-box;padding:9px 11px;font-size:15px;border:1px solid var(--border,#ccc);border-radius:8px;background:var(--surface,#fff);color:var(--text,#111)">' +
      '<div id="tpNote" style="font-size:11px;color:var(--text-muted,#888);margin-top:6px">The whole Saturday–Friday week that contains this date.</div>' +
      '<div id="tpMsg" style="font-size:13px;margin-top:12px;min-height:16px"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px">' +
        '<button type="button" id="tpCancel" class="btn btn-ghost btn-sm">Cancel</button>' +
        '<button type="button" id="tpGo" class="btn btn-sm">📄 Generate &amp; Send</button>' +
      '</div></div>';
    document.body.appendChild(ov);

    var scope = "day";
    var note = ov.querySelector("#tpNote");
    note.style.display = "none";
    ov.querySelectorAll("#tpScope [data-scope]").forEach(function (b) {
      b.onclick = function () {
        scope = b.getAttribute("data-scope");
        ov.querySelectorAll("#tpScope [data-scope]").forEach(function (x) {
          x.className = (x === b) ? "btn btn-sm" : "btn btn-ghost btn-sm";
          x.style.flex = "1";
        });
        ov.querySelector("#tpDateLabel").textContent = scope === "week" ? "Any date in the week" : "Date";
        note.style.display = scope === "week" ? "block" : "none";
      };
    });
    function close() { ov.remove(); }
    ov.onclick = function (e) { if (e.target === ov) close(); };
    ov.querySelector("#tpCancel").onclick = close;
    ov.querySelector("#tpGo").onclick = async function () {
      var msg = ov.querySelector("#tpMsg"), go = ov.querySelector("#tpGo");
      var anchor = ov.querySelector("#tpDate").value;
      if (!anchor) { msg.style.color = "#c8371f"; msg.textContent = "Pick a date first."; return; }
      go.disabled = true; msg.style.color = "var(--text-muted,#777)"; msg.textContent = "Building your PDF…";
      try {
        var res = await shareOrDownload(scope, anchor);
        if (res === "cancelled") { go.disabled = false; msg.textContent = ""; return; }
        msg.style.color = "#1f9d55";
        msg.textContent = res === "shared" ? "✓ Opened your share options." : "✓ PDF downloaded — attach it to your email/text.";
        setTimeout(close, 1400);
      } catch (e) {
        go.disabled = false; msg.style.color = "#c8371f"; msg.textContent = e.message || "Could not create the PDF.";
      }
    };
  }

  // Expose a small API (also handy for verification: renderToBlob is pure).
  if (window.DCR) DCR.timesheetPdf = { open: openModal, buildSheets: buildSheets, renderToBlob: renderToBlob, loadLibs: loadLibs };

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("tsPdfBtn");
    if (!btn) return;
    // grab the display name for the filename (best-effort)
    DCR.api("/api/portal?action=me").then(function (p) { profile = p; }).catch(function () {});
    btn.addEventListener("click", openModal);
  });
})();
