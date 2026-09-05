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

  var session = null, watch = null, lastWhere = null, snapAt = null, lastActAt = 0;

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
    /* Starting while a session is live used to leave the old watch interval
       running beside the new one and the old session row with nobody
       ending it. Finish the one in hand first, properly. */
    if (session) {
      await endSession();
      if (session) return;          // it could not be ended; the message says so
    }
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
      clearInterval(watch);           // never two watches for one panel
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
        /* "Sent" only ever meant the server stored it. This is what their
           screen actually did with it - including a refusal and the reason,
           which used to be silent. */
        var a = d.snapshot.act;
        if (a && a.at && a.at !== lastActAt) {
          lastActAt = a.at;
          msg("asMsg", a.ok ? "ok" : "err", a.text || (a.ok ? "Done." : "Nothing happened."));
        }
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
    // Their exact screen shape when the page reported it, else the ratio.
    var ar = (snap.vw && snap.vh) ? (snap.vw / snap.vh) : (snap.ar || 0.5);
    box.style.aspectRatio = String(Math.max(0.2, Math.min(4, ar)));
    box.innerHTML = "";
    var els = snap.els || [];
    var hasImg = !!snap.img;
    box.classList.toggle("has-img", hasImg);

    /* The picture of their screen, underneath everything. The wireframe goes
       on top as invisible hit targets, so a click still names the control it
       landed on - "tap this one - Submit time sheet" - rather than only a
       ring at a coordinate. */
    if (hasImg) {
      var img = document.createElement("img");
      img.src = snap.img;
      img.alt = "What is on their screen";
      img.draggable = false;
      box.appendChild(img);
    }
    if (!els.length && !hasImg) {
      var empty = document.createElement("span");
      empty.className = "lbl";
      empty.textContent = "Nothing to show yet — press Refresh view";
      box.appendChild(empty);
      return;
    }
    els.forEach(function (e, i) {
      var n = document.createElement("span");
      n.className = "as-el as-" + (e.k || "text");
      n.style.left = e.x + "%"; n.style.top = e.y + "%";
      n.style.width = e.w + "%"; n.style.height = e.h + "%";
      n.textContent = e.t || "";
      n.title = (e.t || "") + "  —  click to point at this";
      n.onclick = function (ev) {
        ev.stopPropagation();
        selectEl(i, e);
      };
      box.appendChild(n);
    });
    var foot = document.createElement("span");
    foot.className = "lbl";
    foot.textContent = hasImg
      ? "Their screen, " + ageText(snap.at) + " — click anything to point at it"
      : "Their screen — click anything to point at it";
    box.appendChild(foot);
  }

  // "just now" / "8s ago": the picture refreshes itself every few seconds,
  // and knowing how old it is stops anyone pointing at something that has
  // since scrolled away.
  function ageText(iso) {
    var s = Math.round((Date.now() - Date.parse(iso || "")) / 1000);
    if (!isFinite(s) || s < 3) return "just now";
    return s < 60 ? s + "s ago" : Math.round(s / 60) + "m ago";
  }

  /* Choosing a control and choosing what to do with it are two steps.

     Pressing something on someone else's account is not the same as pointing
     at it, and a single click that did both would make every mis-click an
     action. Clicking the picture selects; the buttons that appear act. */
  var picked = null;
  function selectEl(i, e) {
    picked = { i: i, sig: e.s || "", label: e.t || "", kind: e.k || "text",
               opts: Array.isArray(e.o) ? e.o : null };
    markAt(e.x + e.w / 2, e.y + e.h / 2);
    var bar = el("asAct");
    bar.hidden = false;
    el("asActWhat").textContent = (e.t || "(unlabelled)");
    el("asActKind").textContent = e.k || "";
    // Only a field can be typed into.
    var isField = (e.k === "field");
    el("asType").hidden = !isField;
    /* A dropdown is chosen, not typed into: assigning a value no option
       carries is silently ignored by the browser, which reads as the
       instruction doing nothing at all. Its choices come with the picture, so
       they are offered here. */
    var opts = Array.isArray(e.o) ? e.o : null;
    el("asTypeText").hidden = !isField || !!opts;
    el("asTypePick").hidden = !isField || !opts;
    if (opts) {
      el("asTypePick").innerHTML = opts.map(function (o) {
        return '<option value="' + esc(o) + '">' + esc(o) + "</option>";
      }).join("");
    }
    el("asType").textContent = opts ? "Choose it" : "Type it";
    msg("asMsg", "", "");
  }

  function actOnPicked(kind, extra) {
    if (!picked) { msg("asMsg", "err", "Choose something on their screen first."); return; }
    var body = { kind: kind, i: picked.i, sig: picked.sig };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    send(body);
  }

  var lastMark = { x: 50, y: 50 };
  function markAt(x, y) {
    lastMark = { x: x, y: y };
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
      picked = null;
      el("asAct").hidden = true;
      markAt(x, y);
      send({ kind: "point", x: x, y: y, label: el("asSay").value.trim().slice(0, 60) });
    };

    el("asPoint").onclick = function () {
      if (!picked) { msg("asMsg", "err", "Choose something on their screen first."); return; }
      // A caption you wrote beats the control's own text, which reads like a
      // run-on when a card's title and description are glued together.
      // point carries coordinates, not an element index - so it is sent
      // directly rather than through actOnPicked, which addresses a control.
      var written = el("asSay").value.trim();
      send({ kind: "point", x: lastMark.x, y: lastMark.y,
             label: (written || picked.label).slice(0, 60) });
    };
    el("asClick").onclick = function () { actOnPicked("click"); };
    el("asScrollTo").onclick = function () { actOnPicked("scroll"); };
    el("asType").onclick = function () {
      var usingPicker = picked && Array.isArray(picked.opts) && picked.opts.length;
      actOnPicked("type", { text: usingPicker ? el("asTypePick").value : el("asTypeText").value });
    };
    el("asTypeText").onkeydown = function (ev) { if (ev.key === "Enter") el("asType").click(); };
    el("asLook").onclick = function () { askForLook(); msg("asMsg", "", "Asked for a fresh view…"); };
  });
})();
