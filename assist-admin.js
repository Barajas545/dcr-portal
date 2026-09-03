/* The helper's side of guided assist.

   There is no view of their screen here, and that is deliberate rather than
   unfinished: streaming one would mean a realtime service, a monthly bill and
   their session passing through somebody else's servers. What this gives
   instead is enough to talk someone through a task on the phone - you can see
   which page they are on, send them to another, point at a spot, and put a
   sentence on their screen.

   The stand-in screen is proportional, not pixel-accurate. You click where you
   mean and it lands in the same RELATIVE place for them, which is the only
   thing that can work when you are on a monitor and they are on a phone. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  // The pages worth sending someone to, in the order they appear on Home.
  var PAGES = [
    ["dashboard.html", "Home"],
    ["timesheet.html", "Time Sheet"],
    ["timesheet-mobile.html", "Time Sheet (phone)"],
    ["capture.html", "Site Photos"],
    ["tasks-map.html", "Tasks on Map"],
    ["timesheet-manager.html", "Team Sheets"],
    ["board.html", "Project Board"],
    ["pm.html", "Progress Chart"],
    ["plans.html", "Floor Plans"],
    ["leads.html", "Leads"],
    ["estimates.html", "Sales Estimates"],
    ["logs.html", "Log History"],
  ];

  var session = null, watch = null, lastWhere = null, snapAt = null;

  function msg(where, kind, text) {
    var n = el(where);
    n.className = "as-msg" + (kind ? " " + kind : "");
    n.textContent = text || "";
  }

  async function loadPeople() {
    var sel = el("asWho");
    try {
      var d = await DCR.api("/api/portal?action=users");
      var mine = String((DCR.profile && DCR.profile.email) || "").toLowerCase();
      var rows = (d.users || []).filter(function (u) {
        return u.active !== false && String(u.email || "").toLowerCase() !== mine;
      });
      if (!rows.length) { sel.innerHTML = '<option value="">No other accounts</option>'; return; }
      sel.innerHTML = rows.map(function (u) {
        return '<option value="' + esc(u.email) + '" data-name="' + esc(u.displayName || "") + '">' +
               esc(u.displayName || u.email) + " — " + esc(u.email) + "</option>";
      }).join("");
    } catch (e) {
      sel.innerHTML = '<option value="">Could not load accounts</option>';
      msg("asStartMsg", "err", e.message || "Could not load accounts.");
    }
  }

  function fillPages() {
    el("asPage").innerHTML = PAGES.map(function (p) {
      return '<option value="' + esc(p[0]) + '">' + esc(p[1]) + "</option>";
    }).join("");
  }

  async function send(body, quiet) {
    if (!session) return;
    body.op = "command";
    body.sessionId = session.id;
    try {
      await DCR.api("/api/portal?action=assist", { method: "POST", body: body });
      if (!quiet) msg("asMsg", "ok", "Sent.");
    } catch (e) {
      if (!quiet) msg("asMsg", "err", e.message || "Could not send that.");
    }
  }

  async function startSession() {
    var sel = el("asWho");
    var email = sel.value;
    if (!email) { msg("asStartMsg", "err", "Choose who needs help."); return; }
    var name = sel.selectedOptions[0] ? sel.selectedOptions[0].getAttribute("data-name") : "";
    el("asGo").disabled = true;
    msg("asStartMsg", "", "Starting…");
    try {
      var d = await DCR.api("/api/portal?action=assist", {
        method: "POST", body: { op: "start", target: email, targetName: name },
      });
      session = { id: d.sessionId, email: email, name: name };
      el("asWhoLive").textContent = name || email;
      el("asPanel").hidden = false;
      msg("asStartMsg", "ok", "Session started. The banner appears on their screen within a few seconds.");
      pollWatch();
      watch = setInterval(pollWatch, 4000);
    } catch (e) {
      msg("asStartMsg", "err", e.message || "Could not start.");
    } finally {
      el("asGo").disabled = false;
    }
  }

  async function pollWatch() {
    if (!session) return;
    try {
      var d = await DCR.api("/api/portal?action=assist&op=watch&sessionId=" +
                            encodeURIComponent(session.id));
      if (!d.session) { stopWatching("They ended the session."); return; }
      var where = d.session.where || "";
      el("asWhere").textContent = where || "(not reported yet)";
      // Stale means their page has stopped checking in - closed tab, asleep,
      // no signal. Better to show that than to keep pretending it is live.
      el("asPip").className = "as-pip" + (d.session.stale ? " stale" : "");
      el("asPip").title = d.session.stale ? "Not checking in" : "Connected";

      // They moved: the view on screen is of a page they have left.
      if (where && where !== lastWhere) { lastWhere = where; askForLook(); }
      if (d.snapshot && d.snapshot.at !== snapAt) {
        snapAt = d.snapshot.at;
        drawSnapshot(d.snapshot);
      }
    } catch (e) { /* transient; the next tick will say */ }
  }

  function askForLook() { send({ kind: "look" }, true); }

  /* Draw what is actually on their screen: real positions, real labels, real
     scroll position. Not a picture of it - a picture would mean shipping their
     names, hours and rates into a support channel, and would not fit down this
     pipe anyway. This is enough to say "that one". */
  function drawSnapshot(snap) {
    var box = el("asScreen");
    box.style.aspectRatio = String(Math.max(0.2, Math.min(4, snap.ar || 0.5)));
    box.innerHTML = "";
    var els = snap.els || [];
    if (!els.length) {
      var empty = document.createElement("span");
      empty.className = "lbl";
      empty.textContent = "Nothing to show yet — press Refresh view";
      box.appendChild(empty);
      return;
    }
    els.forEach(function (e) {
      var n = document.createElement("span");
      n.className = "as-el as-" + (e.k || "text");
      n.style.left = e.x + "%"; n.style.top = e.y + "%";
      n.style.width = e.w + "%"; n.style.height = e.h + "%";
      n.textContent = e.t || "";
      n.title = (e.t || "") + "  —  click to point at this";
      n.onclick = function (ev) {
        ev.stopPropagation();
        markAt(e.x + e.w / 2, e.y + e.h / 2);
        // Point at the middle of the thing, and name it, so the caption on
        // their screen says what you are pointing at.
        send({ kind: "point", x: e.x + e.w / 2, y: e.y + e.h / 2, label: e.t || "" });
      };
      box.appendChild(n);
    });
    var foot = document.createElement("span");
    foot.className = "lbl";
    foot.textContent = "Their screen — click anything to point at it";
    box.appendChild(foot);
  }

  function markAt(x, y) {
    var box = el("asScreen");
    var old = box.querySelector(".mk");
    if (old) old.remove();
    var mk = document.createElement("span");
    mk.className = "mk";
    mk.style.left = x + "%"; mk.style.top = y + "%";
    box.appendChild(mk);
  }

  function stopWatching(text) {
    clearInterval(watch); watch = null; session = null;
    el("asPanel").hidden = true;
    msg("asStartMsg", "", text || "");
  }

  async function endSession() {
    if (!session) return;
    var id = session.id;
    try {
      await DCR.api("/api/portal?action=assist", { method: "POST", body: { op: "end", sessionId: id } });
      stopWatching("Session ended.");
    } catch (e) {
      msg("asMsg", "err", e.message || "Could not end the session.");
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    DCR.profile = profile;
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    if (profile.role !== "Admin") {
      document.querySelector(".as").innerHTML =
        '<div class="as-card"><h2>Admins only</h2>' +
        '<p class="hint">Guided assist is limited to administrators.</p></div>';
      return;
    }

    fillPages();
    await loadPeople();

    el("asGo").onclick = startSession;
    el("asEnd").onclick = endSession;
    el("asClear").onclick = function () { send({ kind: "clear" }); };
    el("asSend").onclick = function () { send({ kind: "goto", page: el("asPage").value }); };
    el("asSayBtn").onclick = function () {
      var t = el("asSay").value.trim();
      if (t) send({ kind: "say", text: t });
    };
    el("asSay").onkeydown = function (e) { if (e.key === "Enter") el("asSayBtn").click(); };

    el("asScreen").onclick = function (e) {
      var r = this.getBoundingClientRect();
      var x = ((e.clientX - r.left) / r.width) * 100;
      var y = ((e.clientY - r.top) / r.height) * 100;
      markAt(x, y);
      send({ kind: "point", x: x, y: y, label: el("asSay").value.trim().slice(0, 60) });
    };
    el("asLook").onclick = function () { askForLook(); msg("asMsg", "", "Asked for a fresh view…"); };
  });
})();
