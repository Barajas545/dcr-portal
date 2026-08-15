/* DCR portal — the daily report off the project journal.

   What went out to site today, in the order it happened, with the pictures.
   Print it to PDF at the end of the day and send it on.

   About "email this report": the portal cannot send mail itself — the Graph
   app registration holds no Mail.Send, and the tenant the SharePoint site
   lives in has no mailboxes at all (see lib/handlers.js taskNotifyText). So
   the button opens a draft in the sender's own mail client, already addressed
   and written, and they attach the PDF they just saved. If a Power Automate
   flow is ever wired up (FLOW_NOTIFY_URL), this is the place to send it from
   instead. */
(function () {
  var qs = new URLSearchParams(location.search);
  var PID = qs.get("id");
  var CO = DCR.companyInfo;
  var LOGO = CO.logo;

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { project: null, rows: [], files: {} };

  function coBlock() {
    var lines = ["<b>" + esc(CO.legalName || CO.name) + "</b>"];
    if (CO.address) lines.push(esc(CO.address));
    var pf = [CO.phone ? "Ph " + CO.phone : "", CO.fax ? "Fax " + CO.fax : ""].filter(Boolean).join(" · ");
    if (pf) lines.push(esc(pf));
    if (CO.license) lines.push(esc(CO.license));
    return lines.join("<br>");
  }
  function localToday() {
    var d = new Date(), p2 = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
  }
  function dayOf(v) { return String(v || "").slice(0, 10); }
  function longDay(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
    if (!m) return String(ymd || "");
    // built from parts, not Date(string) — parsing "2026-08-14" as UTC then
    // rendering it locally shows the day before west of Greenwich
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.toLocaleDateString("en-US",
      { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // Media is JSON now; the newline list is what the column held first and is
  // still read, so an early entry keeps its pictures.
  function mediaOf(row) {
    var raw = String((row && row.journalMedia) || "").trim();
    if (!raw) return [];
    if (raw.charAt(0) === "[") {
      try {
        var a = JSON.parse(raw);
        if (Object.prototype.toString.call(a) === "[object Array]") {
          return a.filter(Boolean).map(function (m) {
            return typeof m === "string" ? { name: m, desc: "", thumb: "" } : m;
          });
        }
      } catch (e) {}
    }
    return raw.split("\n").map(function (s) { return s.trim(); }).filter(Boolean)
      .map(function (n) { return { name: n, desc: "", thumb: "" }; });
  }

  function entryHtml(r) {
    var pics = mediaOf(r).map(function (m) {
      var f = state.files[m.thumb] || state.files[m.name];
      return '<figure class="dr-pic">' +
        (f && f.url ? '<img src="' + esc(f.url) + '" alt="">' : '<img alt="">') +
        (m.desc ? "<figcaption>" + esc(m.desc) + "</figcaption>" : "") +
        "</figure>";
    }).join("");
    var facts = [];
    if (r.journalWeather) facts.push(esc(r.journalWeather));
    if (num(r.journalCrewSize)) facts.push(num(r.journalCrewSize) + " on site");
    if (num(r.journalHours)) facts.push(num(r.journalHours) + " hours");
    return '<div class="dr-e">' +
      '<div class="dr-e-top">' +
        (r.journalCategory ? '<span class="dr-cat">' + esc(r.journalCategory) + "</span>" : "") +
        (r.journalFollowUp ? '<span class="dr-cat dr-flag">Follow up</span>' : "") +
        '<span class="dr-who">' + esc(r.journalAuthor || "") + "</span>" +
      "</div>" +
      (r.title ? '<div class="dr-h">' + esc(r.title) + "</div>" : "") +
      (r.journalEntry ? '<div class="dr-body">' + esc(r.journalEntry) + "</div>" : "") +
      (facts.length ? '<div class="dr-facts">' + facts.join(" &middot; ") + "</div>" : "") +
      (pics ? '<div class="dr-pics">' + pics + "</div>" : "") +
      "</div>";
  }

  function inRange(r, from, to) {
    var d = dayOf(r.journalDate);
    return d && d >= from && d <= to;
  }

  function render(from, to) {
    var p = state.project || {};
    var rows = state.rows.filter(function (r) { return inRange(r, from, to); })
      // oldest first inside the report: a day reads forwards
      .sort(function (a, b) { return String(a.journalDate).localeCompare(String(b.journalDate)) || Number(a.id) - Number(b.id); });
    document.title = "DCR Daily Report — " + (p.internalIDNumber || "") + " " + from;

    var byDay = {};
    rows.forEach(function (r) { (byDay[dayOf(r.journalDate)] = byDay[dayOf(r.journalDate)] || []).push(r); });
    var days = Object.keys(byDay).sort();

    var crew = 0, hrs = 0, pics = 0, flags = 0;
    rows.forEach(function (r) {
      crew = Math.max(crew, num(r.journalCrewSize));
      hrs += num(r.journalHours);
      pics += mediaOf(r).length;
      if (r.journalFollowUp) flags++;
    });

    el("rpSheet").innerHTML =
      '<div class="dr-top"><div class="dr-topl">' +
        '<div class="dr-h1">Daily Report</div>' +
        '<div class="dr-meta"><b>Project:</b> ' +
          esc("#" + (p.internalIDNumber || "") + (p.projectName ? " - " + p.projectName : "")) + "<br>" +
          "<b>Address:</b> " + esc([p.projectAddress, p.projectCity].filter(Boolean).join(" - ") || "—") + "<br>" +
          "<b>" + (from === to ? "Date:" : "Dates:") + "</b> " +
          esc(from === to ? longDay(from) : longDay(from) + "  —  " + longDay(to)) +
        "</div></div>" +
        '<div class="dr-logo"><div class="dr-co">' + coBlock() + "</div>" +
        '<img src="' + LOGO + '" alt="' + esc(CO.name) + '"></div>' +
      "</div>" +
      (rows.length
        ? '<div class="dr-sum">' +
            "<div><span>Entries</span><b>" + rows.length + "</b></div>" +
            "<div><span>Most on site</span><b>" + (crew || "—") + "</b></div>" +
            "<div><span>Hours</span><b>" + (hrs ? hrs : "—") + "</b></div>" +
            "<div><span>Photos</span><b>" + (pics || "—") + "</b></div>" +
            "<div><span>Needs follow-up</span><b>" + (flags || "—") + "</b></div>" +
          "</div>" +
          days.map(function (d) {
            return (days.length > 1 ? '<div class="dr-day">' + esc(longDay(d)) + "</div>" : "") +
              byDay[d].map(entryHtml).join("");
          }).join("")
        : '<div class="dr-none">Nothing was written in the journal for ' +
          esc(from === to ? longDay(from) : "this range") + ".</div>") +
      '<div class="foot"><span>' + esc(CO.name) + " &middot; generated " +
        esc(new Date().toLocaleString("en-US")) + "</span>" +
        "<span>" + esc((p.internalIDNumber || "") + " — " + (p.projectName || "")) + "</span></div>";
  }

  function mailIt(from, to) {
    var p = state.project || {};
    var rows = state.rows.filter(function (r) { return inRange(r, from, to); });
    var subj = "Daily report — " + (p.internalIDNumber || "") +
      (p.projectName ? " " + p.projectName : "") + " — " + longDay(from);
    var lines = ["", (p.projectClientName ? p.projectClientName + "," : "Hello,"), "",
      "Here is the daily report for " + (p.internalIDNumber || "") +
        (p.projectName ? " - " + p.projectName : "") + ".", ""];
    if (from !== to) lines.push("Covering " + longDay(from) + " through " + longDay(to), "");
    rows.slice().sort(function (a, b) { return String(a.journalDate).localeCompare(String(b.journalDate)); })
      .forEach(function (r) {
        // an entry can be a photo and nothing else — then the caption IS the
        // line, or the bullet reads "[Delivery]" and just stops
        var mm = mediaOf(r);
        var caps = mm.map(function (m) { return m.desc; }).filter(Boolean);
        var what = r.title ||
          (String(r.journalEntry || "").split("\n")[0] || "").slice(0, 70) ||
          caps[0] || (mm.length ? mm.length + " photo" + (mm.length === 1 ? "" : "s") : "(no detail)");
        lines.push("• " + (r.journalCategory ? "[" + r.journalCategory + "] " : "") + what);
      });
    if (!rows.length) lines.push("(no entries for this day)");
    lines.push("", "The full report with photos is attached as a PDF.", "",
      (CO.name || ""), (CO.phone || ""));
    var body = lines.join("\r\n");
    // A detached anchor, not location.href: navigating the window to a mailto:
    // can take the page with it, and this page holds the report you just made.
    var a = document.createElement("a");
    a.href = "mailto:?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(body);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 0);
  }

  document.addEventListener("DOMContentLoaded", async function () {
    await DCR.requireAuth();
    if (!PID) { el("rpSheet").innerHTML = '<div class="rp-loading">No project selected.</div>'; return; }
    el("rpBack").href = "project.html?id=" + encodeURIComponent(PID) + "&tab=journal";
    el("rpHow").innerHTML =
      "<b>To send this:</b> press <b>Save as PDF</b> (choose “Save as PDF” as the printer), " +
      "then press <b>Email this report</b> — your mail app opens with the message written, " +
      "and you attach the PDF you just saved. " +
      "<span style='opacity:.8'>The portal cannot send mail on its own; ask for the Power " +
      "Automate flow if you want this to go out automatically.</span>";

    var from = qs.get("from") || localToday();
    var to = qs.get("to") || from;
    el("rpDay").value = from;
    el("rpTo").value = to;

    try {
      var res = await Promise.all([
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID)),
        DCR.api("/api/portal?action=project&id=" + encodeURIComponent(PID) + "&part=journal"),
      ]);
      state.project = res[0].project;
      state.rows = res[1].rows || [];
    } catch (e) {
      el("rpSheet").innerHTML = '<div class="rp-loading">' + esc(e.message || "Could not load the journal.") + "</div>";
      return;
    }
    render(from, to);
    // pictures after the text, so the report is readable while they arrive
    try {
      var d = await DCR.api("/api/portal?action=drive&journalFor=" + encodeURIComponent(PID));
      state.files = d.files || {};
      render(el("rpDay").value, el("rpTo").value || el("rpDay").value);
    } catch (e) { /* no pictures is still a report */ }

    el("rpApply").onclick = function () {
      var f = el("rpDay").value || localToday();
      var t = el("rpTo").value || f;
      if (t < f) { t = f; el("rpTo").value = t; }
      render(f, t);
    };
    el("rpMail").onclick = function () {
      mailIt(el("rpDay").value || localToday(), el("rpTo").value || el("rpDay").value || localToday());
    };
  });
})();
