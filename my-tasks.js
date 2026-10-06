/* My Tasks — your open tasks, and the place to send an update on one.

   A reminder about a quiet task (from DCR Agents, by email, text or the app)
   links here as my-tasks.html?task=<id>, and so does the new-task email: the
   task opens straight away with a box to say what was done. The map is still
   one tap away for anyone who wants directions to every pin.

   The server does the writing (?action=tasks, op addNote / complete): it reads
   the task fresh, stamps the note in company time and appends it, so nothing
   here builds the Completed Work field and nobody's note is overwritten.

   What is typed is kept on this phone, per account and per task, until the
   server says it is saved — a dropped signal or a sign-in that expired in the
   truck loses nothing. Everything drawn from a task goes through DCR.esc.

   A shoot the Photo & Video Agent announced (the server marks it with
   `photo: {shootDate, ref}`) shows as a brief: a camera badge and the shoot
   day, the description's sections as small headings, its shot list as a
   checklist the photographer ticks on site (kept on this phone only),
   photo-specific quick phrases, Maps, and an upload link that opens the
   photo page on this job. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var EP = "/api/portal?action=tasks";
  var WIDE = window.matchMedia("(min-width: 960px)");
  var FINE = window.matchMedia("(pointer: fine)");
  var VIEW_KEY = "dcr.myTasks.view";
  var DRAFT_KEY = "dcr.myTasks.draft.v1";
  var SHOTS_KEY = "dcr.myTasks.shots.v1";
  var PHRASES = ["Started today", "Waiting on materials", "Waiting on the client"];
  /* On a shoot these replace the phrases above. "Shoot done" is not a note:
     the agent reads the task being closed, so it closes it (see renderDetail). */
  var PHOTO_PHRASES = ["On site now", "Weather — need a new day", "Can't make it — please move it", "Drone not possible today"];
  var SHOOT_DONE = "Shoot done — photos uploaded";
  var UNLINKED = "Your account isn’t linked to an employee yet — ask an admin.";

  var S = {
    profile: null, me: "", scope: null, today: "", needsDays: 5,
    tasks: [], view: "mine", sel: "", pushed: false, loaded: false,
    /* The tasks with a request still out, by id: "send" or "complete". Kept
       per task, not for the whole page: on a slow signal a person sends on
       one task and moves on to the next, and that one's Send must go. */
    busy: {},
  };

  /* ── small helpers ───────────────────────────────────────────────────── */

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function store(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private window */ }
  }

  /* Whose phone this is, from the session token, so a draft typed by one
     person never shows up for another on a shared phone. */
  function account() {
    try {
      var p = DCR.getToken().split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      var c = JSON.parse(atob(p));
      return String(c.email || c.sub || "");
    } catch (e) { return ""; }
  }
  function draftKey(id) { return DRAFT_KEY + ":" + account() + ":" + id; }
  function getDraft(id) {
    var raw = read(draftKey(id));
    if (!raw) return "";
    try {
      var d = JSON.parse(raw);
      if (!d || Date.now() - d.at > 30 * 86400000) { store(draftKey(id), null); return ""; }
      return String(d.t || "");
    } catch (e) { return ""; }
  }
  function setDraft(id, t) {
    store(draftKey(id), t && t.trim() ? JSON.stringify({ t: t, at: Date.now() }) : null);
  }

  /* The shots ticked on a shoot's checklist, by their words (so a brief the
     agent rewrites keeps the ticks of the shots it kept). Only a convenience
     on this phone: nothing is sent. */
  function shotsKey(id) { return SHOTS_KEY + ":" + account() + ":" + id; }
  function getShots(id) {
    try {
      var d = JSON.parse(read(shotsKey(id)) || "null");
      var out = {};
      ((d && d.done) || []).forEach(function (s) { out[String(s)] = true; });
      return out;
    } catch (e) { return {}; }
  }
  function setShot(id, shot, on) {
    var done = getShots(id);
    if (on) done[shot] = true; else delete done[shot];
    var list = Object.keys(done);
    store(shotsKey(id), list.length ? JSON.stringify({ done: list, at: Date.now() }) : null);
  }

  var WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  /* A YYYY-MM-DD from the server, read at UTC noon so the phone's own zone
     can never move it a day. "Today" is the server's company day too. */
  function dayText(key) {
    if (!DAY_RE.test(key || "")) return "";
    var d = new Date(key + "T12:00:00Z");
    var s = WD[d.getUTCDay()] + " " + MO[d.getUTCMonth()] + " " + d.getUTCDate();
    return key.slice(0, 4) !== String(S.today).slice(0, 4) ? s + ", " + key.slice(0, 4) : s;
  }
  function daysAgo(key) {
    if (!DAY_RE.test(key || "") || !DAY_RE.test(S.today || "")) return null;
    return Math.round((Date.parse(S.today + "T12:00:00Z") - Date.parse(key + "T12:00:00Z")) / 86400000);
  }
  function agoText(n) { return n === 0 ? "today" : n === 1 ? "yesterday" : n + " days ago"; }

  function priKey(p) {
    var l = String(p || "").toLowerCase();
    if (!l) return "";
    if (l.indexOf("urgent") !== -1 || l.indexOf("high") !== -1) return "urgent";
    if (l.indexOf("medium") !== -1 || l.indexOf("normal") !== -1) return "medium";
    return "low";
  }
  var PRI_RANK = { urgent: 0, medium: 1, "": 1, low: 2 };

  function nameOf(t) { return t.TaskName || t.Title || "(untitled task)"; }
  function find(id) { for (var i = 0; i < S.tasks.length; i++) if (String(S.tasks[i].id) === String(id)) return S.tasks[i]; return null; }
  function ownerOf(t) { return t.owner || t.TaskAssignedPerson || "Nobody"; }

  /* How long a task has been quiet, in the words a crew member would use.
     A task nobody ever wrote on says "no update yet" — "no update for 12
     days" would read as if they had ignored it. */
  function whenText(t) {
    var d = t.daysSinceUpdate;
    if (d === null || d === undefined) return "";
    if (t.lastUpdateSource === "requested") {
      if (!t.needsUpdate) return "New · requested " + agoText(d);
      return t.notes && t.notes.length ? "No update for " + d + " days" : "No update yet · requested " + agoText(d);
    }
    if (t.needsUpdate) return "No update for " + d + " days";
    return d === 0 ? "Updated today" : d === 1 ? "Updated yesterday" : "Updated " + d + " days ago";
  }
  function previewText(t) { return t.lastNote ? "Last: " + t.lastNote : "No updates yet"; }

  function placeOf(t) {
    var addr = String(t.TaskProjectAddress || "").replace(/[\r\n]+/g, ", ").trim();
    var city = String(t.TaskProjectCity || "").trim();
    return { project: String(t.TaskProjectName || "").trim(), addr: addr, city: city };
  }
  function dirUrl(pl) {
    if (!pl.addr) return "";
    return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent([pl.addr, pl.city].filter(Boolean).join(", "));
  }
  function dirLink(pl) {
    if (!pl.addr) return "";
    var q = [pl.addr, pl.city].filter(Boolean).join(", ");
    return '<a class="mt-dir" target="_blank" rel="noopener" href="' + dirUrl(pl) +
      '" aria-label="Directions to ' + esc(q) + ' (opens maps)">' + esc(pl.addr) + " ↗</a>";
  }
  function chip(t) {
    var k = priKey(t.TaskPrioraty);
    return k ? '<span class="mt-chip ' + k + '">' + esc(t.TaskPrioraty) + "</span>" : "";
  }
  /* A shoot's badge and its day, against the server's company day: "Shoot:
     Thu Oct 15", "Shoot: Today", "Shoot was Tue Oct 13". */
  function photoChips(t) {
    if (!t.photo) return "";
    var s = '<span class="mt-chip photo">📷 Photo &amp; Video</span>';
    var d = String(t.photo.shootDate || "");
    if (!DAY_RE.test(d)) return s;
    var n = daysAgo(d);
    var past = n !== null && n > 0;
    var label = n === 0 ? "Shoot: Today" : past ? "Shoot was " + dayText(d) : "Shoot: " + dayText(d);
    return s + '<span class="mt-chip shoot' + (n === 0 ? " today" : past ? " late" : "") + '">' + esc(label) + "</span>";
  }
  function chips(t) { return t.photo ? '<span class="mt-chips">' + photoChips(t) + chip(t) + "</span>" : chip(t); }
  /* Access descriptions can carry <br>, stray tags and entities (a rich-text
     rewrite stores "·" as &middot; and "&" as &amp;); shown as plain text
     with the line breaks kept. The entities are exactly the ones the
     server's reader decodes (lib/photo-agent.js normalise), so a shoot's
     footer the server found is hidden here too; &amp; goes last, and &lt;
     / &gt; are not among them, so "&lt;script&gt;" still shows as typed.
     The words then go through esc() like any other. */
  function plain(s) {
    return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ").replace(/&#183;|&middot;/gi, "·").replace(/&quot;|&#34;/g, '"')
      .replace(/&#39;/g, "'").replace(/&#58;/g, ":").replace(/&#123;/g, "{").replace(/&#125;/g, "}")
      .replace(/&#10;/g, "\n").replace(/&amp;/g, "&").trim();
  }

  /* A shoot brief, from the description the agent wrote: its sections
     (WHEN, SHOT LIST, …) on lines of their own, optionally with words after
     a colon; "• " lines as list items, the ones under SHOT LIST as
     checkboxes; anything else as a line of text. The footer ("Shoot date: …
     · Ref: PV-…") is the agent's bookkeeping and is not shown. Parsed from
     plain(), the way every description is read here (a rich-text line from
     Access ends with </div> or </p>, so those end a line first); every word
     goes through esc(). Answers the markup and the shot list, in order, for
     the checkboxes' data-shot index. */
  var BRIEF_HEAD = /^(WHEN|WHERE|SHOT LIST|TIPS|SAMPLE SHOT|BRING|SAFETY|CAPTION IDEAS|DRONE CHECK)(?:\s*:\s*(.*)|\s*)$/;
  var BRIEF_FOOT = /^Shoot date: \d{4}-\d{2}-\d{2} · Ref: PV-/;
  function brief(t) {
    var lines = plain(String(t.TaskDescription || "").replace(/<\/(?:div|p)>/gi, "\n")).split(/\r?\n/);
    var done = getShots(t.id);
    var html = "", open = false, head = "", shots = [];
    function close() { if (open) { html += "</ul>"; open = false; } }
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) { close(); return; }
      if (BRIEF_FOOT.test(line)) return;
      var h = BRIEF_HEAD.exec(line);
      if (h) {
        close();
        head = h[1];
        html += '<h4 class="mt-bh">' + esc(head) + "</h4>" + (h[2] ? '<p class="mt-bp">' + esc(h[2]) + "</p>" : "");
        return;
      }
      var b = /^•\s*(.+)$/.exec(line);
      if (!b) { close(); html += '<p class="mt-bp">' + esc(line) + "</p>"; return; }
      var shot = head === "SHOT LIST";
      if (!open) { html += '<ul class="mt-blist' + (shot ? " shots" : "") + '">'; open = true; }
      /* the agent's "Map: <Google Maps search>" line: a tap, not a web address
         to read; only that exact https prefix becomes a link */
      var map = shot ? null : /^Map:\s*(https:\/\/www\.google\.com\/maps\/search\/\?\S+)$/.exec(b[1]);
      if (map) { html += '<li><a href="' + esc(map[1]) + '" target="_blank" rel="noopener">Open in Maps ↗</a></li>'; return; }
      if (!shot) { html += "<li>" + esc(b[1]) + "</li>"; return; }
      html += '<li><label class="mt-shot"><input type="checkbox" data-shot="' + shots.length + '"' + (done[b[1]] ? " checked" : "") +
        " /> <span>" + esc(b[1]) + "</span></label></li>";
      shots.push(b[1]);
    });
    close();
    return { html: html, shots: shots };
  }

  var byDays = function (a, b) { return (b.daysSinceUpdate || 0) - (a.daysSinceUpdate || 0); };
  var byPriority = function (a, b) {
    return (PRI_RANK[priKey(a.TaskPrioraty)] - PRI_RANK[priKey(b.TaskPrioraty)]) ||
      String(a.requested || "").localeCompare(String(b.requested || ""));
  };
  /* Inside each group the shoots come first, the soonest first: a shoot has
     a day it happens on, every other task only an age. */
  function photoFirst(rest) {
    return function (a, b) {
      var pa = a.photo ? 1 : 0, pb = b.photo ? 1 : 0;
      if (pa !== pb) return pb - pa;
      var c = pa ? String(a.photo.shootDate || "9999").localeCompare(String(b.photo.shootDate || "9999")) : 0;
      return c || rest(a, b);
    };
  }

  /* ── who is looking ──────────────────────────────────────────────────── */

  function crewScope() { return S.scope && typeof S.scope === "object" && S.scope.managed && S.scope.managed.length; }
  /* An account with no employee name and nobody to manage has no tasks of
     its own to show — say why, not "nothing open". */
  function unlinked() { return !S.me && S.scope !== "*" && !crewScope(); }
  function othersLabel() { return S.scope === "*" ? "Everyone's tasks" : "My crew's tasks"; }
  function canToggle() { return !!S.me && (S.scope === "*" || crewScope()); }
  function visible() { return S.view === "mine" ? S.tasks.filter(function (t) { return t.mine; }) : S.tasks.slice(); }

  function setView(v, remember) {
    S.view = v === "all" ? "all" : "mine";
    if (!S.me) S.view = "all";
    if (remember) store(VIEW_KEY, S.view);
    renderList();
  }

  /* ── the list ────────────────────────────────────────────────────────── */

  function card(t) {
    var pl = placeOf(t);
    var place = pl.project || pl.addr
      ? '<div class="mt-place">' + (pl.project ? '<span class="proj">' + esc(pl.project) + "</span>" : "") + dirLink(pl) + "</div>"
      : '<div class="mt-place"></div>';
    return '<article class="mt-card' + (t.needsUpdate ? " needs" : "") + (String(S.sel) === String(t.id) ? " sel" : "") + '">' +
      '<button type="button" class="mt-open" data-open="' + esc(t.id) + '">' +
        '<span class="mt-row1"><span class="mt-name">' + esc(nameOf(t)) + "</span>" + chips(t) + "</span>" +
        '<span class="mt-when' + (t.needsUpdate ? " warn" : "") + '">' + esc(whenText(t)) + "</span>" +
        '<span class="mt-last">' + esc(previewText(t)) + "</span>" +
      "</button>" + place + "</article>";
  }

  function group(label, list, warn) {
    if (!list.length) return "";
    return '<h3 class="mt-grp">' + esc(label) + ' <span class="mt-n' + (warn ? " warn" : "") + '">' + list.length + "</span></h3>" +
      list.map(card).join("");
  }

  function renderHeader(tasks) {
    var needs = tasks.filter(function (t) { return t.needsUpdate; }).length;
    el("mtTitle").textContent = S.view === "mine" ? "My tasks" : othersLabel();
    var sub = el("mtSub");
    if (unlinked()) { sub.textContent = ""; return; }
    if (!tasks.length) { sub.textContent = S.view === "mine" ? "Nothing open on your list right now." : "Nothing open right now."; return; }
    sub.innerHTML = (needs
      ? "<b>" + needs + (needs === 1 ? " needs" : " need") + " an update</b> · "
      : "All up to date · ") +
      tasks.length + " open" + (S.view === "mine" ? "" : " across " + countPeople(tasks) + (countPeople(tasks) === 1 ? " person" : " people")) +
      ". Tap a task to send an update.";
  }
  function countPeople(tasks) {
    var seen = {};
    tasks.forEach(function (t) { seen[ownerOf(t).toLowerCase()] = 1; });
    return Object.keys(seen).length;
  }

  function renderSeg() {
    var seg = el("mtSeg");
    seg.hidden = !canToggle();
    if (seg.hidden) return;
    var mine = S.tasks.filter(function (t) { return t.mine; }).length;
    el("mtSegMine").textContent = "Mine (" + mine + ")";
    el("mtSegAll").textContent = othersLabel() + " (" + S.tasks.length + ")";
    el("mtSegMine").setAttribute("aria-pressed", String(S.view === "mine"));
    el("mtSegAll").setAttribute("aria-pressed", String(S.view === "all"));
  }

  function renderList() {
    if (!S.loaded) return;
    var list = el("mtList");
    list.removeAttribute("aria-busy");
    var tasks = visible();
    renderSeg();
    renderHeader(tasks);
    if (unlinked()) {
      list.innerHTML = '<div class="mt-empty"><b>' + esc(UNLINKED) + "</b>Once it is, the tasks assigned to you show up here.</div>";
      return;
    }
    if (!tasks.length) {
      list.innerHTML = '<div class="mt-empty"><b>Nothing to update.</b>' +
        (S.view === "mine" && canToggle() ? "No open tasks are assigned to you. " : "") +
        'New tasks show up here as soon as the office adds them.</div>';
      return;
    }
    var html = "";
    if (S.view === "mine") {
      html = group("Needs an update", tasks.filter(function (t) { return t.needsUpdate; }).sort(photoFirst(byDays)), true) +
        group("Up to date", tasks.filter(function (t) { return !t.needsUpdate; }).sort(photoFirst(byPriority)), false);
    } else {
      /* Grouped by person, under the roster name the reminders use (a task
         typed as "Luis" sits with Luis Martinez's). The caller's own first. */
      var groups = {}, order = [];
      tasks.forEach(function (t) {
        var k = ownerOf(t).toLowerCase();
        if (!groups[k]) { groups[k] = { name: ownerOf(t), note: t.ownerNote || "", mine: !!t.mine, list: [] }; order.push(k); }
        groups[k].list.push(t);
      });
      order.sort(function (a, b) {
        return (groups[b].mine - groups[a].mine) || groups[a].name.localeCompare(groups[b].name);
      });
      html = order.map(function (k) {
        var g = groups[k];
        var needs = g.list.filter(function (t) { return t.needsUpdate; }).sort(photoFirst(byDays));
        var fine = g.list.filter(function (t) { return !t.needsUpdate; }).sort(photoFirst(byPriority));
        return '<h3 class="mt-grp"><span class="who">' + esc(g.mine ? "You (" + g.name + ")" : g.name) + "</span>" +
          '<span class="mt-n">' + g.list.length + "</span>" +
          (needs.length ? '<span class="mt-n warn">' + needs.length + " need" + (needs.length === 1 ? "s" : "") + " an update</span>" : "") +
          (g.note ? '<span class="why">' + esc(g.note) + "</span>" : "") + "</h3>" +
          needs.concat(fine).map(card).join("");
      }).join("");
    }
    list.innerHTML = html;
  }

  /* A message above the list: a link to a task finished since, a task that
     moved, a task just closed. `action` is a button label; it clears the
     message and puts focus back on the list. */
  function notice(kind, title, text, action) {
    var box = el("mtNotice");
    if (!title) { box.innerHTML = ""; return; }
    box.innerHTML = '<div class="mt-notice ' + kind + '"><b>' + esc(title) + "</b>" +
      (text ? "<span>" + esc(text) + "</span>" : "") +
      (action ? '<button type="button" class="mt-nbtn" id="mtNoticeBtn">' + esc(action) + "</button>" : "") + "</div>";
    var b = el("mtNoticeBtn");
    if (b) b.onclick = function () {
      notice();
      var first = document.querySelector("#mtList .mt-open");
      if (first) first.focus(); else el("mtTitle").focus();
    };
  }

  /* ── the task ────────────────────────────────────────────────────────── */

  function historyHtml(t, freshFirst) {
    var notes = (t.notes || []).slice().reverse();
    if (!notes.length) return '<li class="mt-none">No updates yet. Yours will be the first.</li>';
    return notes.map(function (n, i) {
      var label = n.day ? dayText(n.day) : (n.label || "Earlier note");
      var ago = n.day ? daysAgo(n.day) : null;
      if (ago !== null && ago >= 0 && ago <= 1) label += " · " + agoText(ago);
      return '<li class="mt-note' + (freshFirst && i === 0 ? " fresh" : "") + '">' +
        '<div class="mt-nday">' + esc(label) + "</div>" +
        '<div class="mt-ntext">' + (n.text ? esc(n.text) : "—") + "</div></li>";
    }).join("");
  }

  function renderDetail(t) {
    var pl = placeOf(t);
    var req = t.requested ? dayText(t.requested) : "";
    var reqAgo = t.requested ? daysAgo(t.requested) : null;
    var desc = plain(t.TaskDescription);
    var cat = [t.TaskCategory, t.TaskSubCategory].filter(Boolean).join(" / ");
    var facts =
      (req ? "<dt>Requested</dt><dd>" + esc(req + (reqAgo !== null && reqAgo >= 0 ? " (" + agoText(reqAgo) + ")" : "")) + "</dd>" : "") +
      "<dt>Assigned to</dt><dd>" + esc(ownerOf(t)) + (t.mine ? " (you)" : "") + "</dd>" +
      (cat ? "<dt>Category</dt><dd>" + esc(cat) + "</dd>" : "") +
      (t.TaskWebSiteDetails ? "<dt>Details</dt><dd>" + esc(plain(t.TaskWebSiteDetails)) + "</dd>" : "");
    /* A shoot: the description is a brief, the phrases are the
       photographer's, Maps is one tap, and the photo page opens on this job. */
    var shoot = t.photo ? brief(t) : null;
    var phrases = shoot ? PHOTO_PHRASES.concat([SHOOT_DONE]) : PHRASES;
    var maps = shoot ? dirUrl(pl) : "";
    var pid = t.ProjectID === null || t.ProjectID === undefined ? "" : String(t.ProjectID).trim();
    var upload = shoot
      ? '<a class="mt-photo" href="' + esc("capture.html" + (pid ? "?project=" + encodeURIComponent(pid) : "")) + '">📷 Upload photos &amp; videos</a>'
      : '<a class="mt-photo" href="capture.html">📷 Site photos</a>';
    el("mtDScroll").innerHTML =
      '<div class="mt-dtop">' + chip(t) + photoChips(t) + "</div>" +
      '<h2 class="mt-dtitle" id="mtDTitle" tabindex="-1">' + esc(nameOf(t)) + "</h2>" +
      ((pl.project || pl.addr) ? '<div class="mt-dplace">' + esc(pl.project) + (pl.project && pl.addr ? " · " : "") + dirLink(pl) + "</div>" : "") +
      '<div class="mt-dwhen' + (t.needsUpdate ? " warn" : "") + '" id="mtDWhen">' + esc(whenText(t)) + "</div>" +
      (shoot ? (shoot.html ? '<div class="mt-brief" role="group" aria-label="Shoot brief">' + shoot.html + "</div>" : "")
        : desc ? '<p class="mt-desc">' + esc(desc) + "</p>" : "") +
      '<dl class="mt-facts">' + facts + "</dl>" +
      '<form class="mt-compose" id="mtCompose" novalidate>' +
        '<label class="mt-label" for="mtText">Add an update</label>' +
        '<div class="mt-quick" role="group" aria-label="Quick phrases — each adds its words to your update">' +
          phrases.map(function (p) {
            return '<button type="button"' + (p === SHOOT_DONE ? ' class="done"' : "") + ' data-phrase="' + esc(p) + '">' + esc(p) + "</button>";
          }).join("") +
          '<button type="button" id="mtSchedBtn" aria-controls="mtDatePick" aria-expanded="false">Scheduled for…</button>' +
          '<button type="button" class="done" id="mtDoneBtn">Done ✓</button>' +
        "</div>" +
        '<div class="mt-datepick" id="mtDatePick" hidden>' +
          '<label for="mtDate">Scheduled for</label><input type="date" id="mtDate"' +
            (DAY_RE.test(S.today || "") ? ' min="' + esc(S.today) + '"' : "") + " />" +
          '<button type="button" class="mt-dateadd" id="mtDateAdd">Add</button>' +
        "</div>" +
        '<textarea class="mt-text" id="mtText" rows="3" maxlength="2000" ' +
          'placeholder="What was done? What is next? Anything the office should know?"></textarea>' +
        '<div class="mt-row">' +
          '<span class="mt-status" id="mtStatus" role="status" aria-live="polite"></span>' +
          '<button type="submit" class="mt-send" id="mtSend">Send update</button>' +
        "</div>" +
        '<div class="mt-next" id="mtNext" hidden></div>' +
      "</form>" +
      '<h3 class="mt-h3">Updates <span class="mt-n" id="mtHCount">' + (t.notes || []).length + "</span></h3>" +
      '<ol class="mt-history" id="mtHistory">' + historyHtml(t, false) + "</ol>" +
      '<div class="mt-dactions">' +
        '<button type="button" class="mt-complete" id="mtComplete">Mark complete</button>' +
        (maps ? '<a class="mt-photo" target="_blank" rel="noopener" href="' + esc(maps) + '">🗺️ Open in Maps</a>' : "") +
        upload +
      "</div>";

    var ta = el("mtText");
    var draft = getDraft(t.id);
    if (draft) { ta.value = draft; status("", "Draft restored — it hasn't been sent yet."); }
    /* A task opened again while its own request is still out shows it, so
       its buttons are not ready to tap while they would do nothing. */
    var busy = S.busy[String(t.id)];
    if (busy === "send") { el("mtSend").disabled = true; el("mtSend").textContent = "Sending…"; status("", "Sending…"); }
    if (busy === "complete") {
      el("mtComplete").disabled = true;
      el("mtComplete").textContent = "Marking complete…";
      status("", "Marking complete…");
    }
    var timer = null;
    ta.addEventListener("input", function () {
      clearTimeout(timer);
      var id = t.id;
      timer = setTimeout(function () { setDraft(id, ta.value); }, 350);
      if (el("mtStatus").className.indexOf("ok") !== -1) status("", "");
    });
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });
    /* On a phone the keyboard covers half the screen: bring the box into
       the part that is left. */
    ta.addEventListener("focus", function () {
      if (WIDE.matches) return;
      setTimeout(function () { try { ta.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {} }, 250);
    });
    el("mtCompose").addEventListener("submit", function (e) { e.preventDefault(); send(); });
    /* "Shoot done — photos uploaded" puts its words in the box and then asks
       the same question as Done ✓, with them as the closing note: the agent
       reads the task being closed, and a note alone would leave its
       follow-ups running. */
    Array.prototype.forEach.call(document.querySelectorAll("#mtCompose [data-phrase]"), function (b) {
      b.onclick = function () {
        var p = b.getAttribute("data-phrase");
        addPhrase(p);
        if (shoot && p === SHOOT_DONE) complete();
      };
    });
    if (shoot) {
      Array.prototype.forEach.call(document.querySelectorAll("#mtDScroll [data-shot]"), function (c) {
        c.onchange = function () {
          var words = shoot.shots[Number(c.getAttribute("data-shot"))];
          if (words !== undefined) setShot(t.id, words, !!c.checked);
        };
      });
    }
    el("mtSchedBtn").onclick = function () {
      var box = el("mtDatePick"), input = el("mtDate");
      box.hidden = !box.hidden;
      el("mtSchedBtn").setAttribute("aria-expanded", String(!box.hidden));
      if (box.hidden) return;
      try { input.focus(); if (input.showPicker) input.showPicker(); } catch (e) { /* not every browser opens it from script */ }
    };
    /* The day is added only when the person says so, with Add or Enter, not
       on every change: each arrow key or digit in one part of the date is
       already a whole new date to the browser, and picking a day that is
       already in the box (today, or the last one picked) changes nothing.
       Enter would otherwise send the update before the day was in it. */
    function addDay() {
      var input = el("mtDate"), key = input.value;
      if (!DAY_RE.test(key)) { status("err", "Pick a day first."); input.focus(); return; }
      if (DAY_RE.test(S.today || "") && key < S.today) { status("err", "Pick today or a later day."); input.focus(); return; }
      addPhrase("Scheduled for " + dayText(key));
      input.value = "";
      el("mtDatePick").hidden = true;
      el("mtSchedBtn").setAttribute("aria-expanded", "false");
      if (!FINE.matches) el("mtSchedBtn").focus();
    }
    el("mtDateAdd").onclick = addDay;
    el("mtDate").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addDay(); }
    });
    /* "Done" is not a note — it is closing the task, so it opens the same
       question Mark complete asks, with whatever was typed as the closing
       note. A "Done" note on an open task would leave the person wondering
       whether they were meant to close it. */
    el("mtDoneBtn").onclick = complete;
    el("mtComplete").onclick = complete;
  }

  /* A quick phrase is added to the end of what is there, never in place of
     it. On a phone the keyboard is not opened for it: most of the time the
     phrase is the whole update and the next tap is Send. */
  function addPhrase(p) {
    var ta = el("mtText");
    var cur = ta.value.replace(/\s+$/, "");
    ta.value = cur ? cur + (/[.!?]$/.test(cur) ? " " : ". ") + p : p;
    if (S.sel) setDraft(S.sel, ta.value);
    if (FINE.matches) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    status("", "");
  }

  function status(kind, text) {
    var s = el("mtStatus");
    if (!s) return;
    s.className = "mt-status" + (kind ? " " + kind : "");
    s.textContent = text || "";
  }

  function refreshDetailParts(t, fresh) {
    if (String(S.sel) !== String(t.id)) return;
    var w = el("mtDWhen");
    if (w) { w.textContent = whenText(t); w.className = "mt-dwhen" + (t.needsUpdate ? " warn" : ""); }
    var h = el("mtHistory");
    if (h) h.innerHTML = historyHtml(t, fresh);
    var c = el("mtHCount");
    if (c) c.textContent = String((t.notes || []).length);
  }

  function replaceTask(t) {
    for (var i = 0; i < S.tasks.length; i++) {
      if (String(S.tasks[i].id) === String(t.id)) { S.tasks[i] = t; return; }
    }
    S.tasks.push(t);
  }

  /* After "Saved", the next task that needs an update is one tap away. */
  function showNext(afterId) {
    var box = el("mtNext");
    if (!box) return;
    var next = visible().filter(function (x) { return String(x.id) !== String(afterId) && x.needsUpdate; }).sort(byDays)[0];
    if (!next) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = '<button type="button" class="mt-nextbtn" id="mtNextBtn"><span>Next:</span> <b>' + esc(nameOf(next)) +
      "</b> <small>" + esc(whenText(next)) + "</small></button>";
    box.hidden = false;
    el("mtNextBtn").onclick = function () { openTask(next.id); };
  }

  /* What should stay in the box once an update is saved. The box stays open
     while it sends, so on a slow signal a person may type a second sentence
     or tap a phrase meanwhile: only the words that were sent leave, and
     what was added after them stays as the next draft. If the sent words
     themselves were changed (a correction, even "wall" to "walls"), the
     whole box stays, so the person can see it and decide. */
  function leftAfterSend(now, sent) {
    var cur = String(now || "").replace(/^\s+/, "");
    if (cur.indexOf(sent) !== 0) return now;
    var rest = cur.slice(sent.length);
    if (rest && !/^[\s.,;:!?]/.test(rest)) return now;
    return rest.replace(/^\s*[.,;]?\s*/, "");
  }

  /* What a tap on Send or Mark complete says while that task's own request
     is still out (Ctrl+Enter reaches Send even with the button held). It
     never just does nothing: the person would think the tap had worked. */
  function busyText(id) {
    var b = S.busy[String(id)];
    return b === "send" ? "Still sending your last update — one moment." :
      b === "complete" ? "Still marking this task complete — one moment." : "";
  }

  function sendError(e) {
    if (!e || !e.status) return "No signal - your update is kept on this phone. Tap Send again when you have signal.";
    if (e.status === 404) return "This task isn't on your list any more. Your words are kept here.";
    if (e.status === 429) return "SharePoint is busy - your update is kept here. Try again in a moment.";
    return (e.message || "That didn't save.") + " Your update is kept here.";
  }

  async function send() {
    var t = find(S.sel);
    if (!t) return;
    if (S.busy[String(t.id)]) { status("", busyText(t.id)); return; }
    var ta = el("mtText"), btn = el("mtSend");
    var text = ta.value.trim();
    if (!text) {
      status("err", "Write an update first — or tap one of the phrases above.");
      ta.focus();
      return;
    }
    setDraft(t.id, ta.value);   // flushed before the send, in case the page is left mid-flight
    S.busy[String(t.id)] = "send";
    btn.disabled = true;
    btn.textContent = "Sending…";
    status("", "Sending…");
    try {
      var r = await DCR.api(EP, { method: "POST", body: { op: "addNote", itemId: t.id, text: text } });
      /* The box on screen now, which is a new one if the task was closed and
         opened again while this was sending. */
      var shown = String(S.sel) === String(t.id) && el("mtText") ? el("mtText") : ta;
      var left = leftAfterSend(shown.value, text);
      setDraft(t.id, left);
      if (r && r.task) replaceTask(r.task);
      var now = find(t.id) || t;
      if (String(S.sel) === String(t.id)) {
        shown.value = left;
        refreshDetailParts(now, true);
        status("ok", (r && r.already ? "Saved ✓ — that update was already on the task." : "Saved ✓ The office can see it now.") +
          (left.trim() ? " What you typed while it was sending is still in the box." : ""));
        showNext(t.id);
      }
      renderList();
    } catch (e) {
      if (e && e.status === 409 && /already complete/i.test(e.message || "")) {
        /* Finished elsewhere after it was opened (the office, Access, another
           phone). Left open, its Send and Mark complete would find no task and
           do nothing, and its draft could never be read or cleared again, as
           the task cannot be reopened. So it closes the way refreshOne closes
           a finished task, and the words that were not added — the box as it
           is now, or the draft if the task was closed meanwhile — are shown
           in the notice instead of kept. */
        var onScreen = String(S.sel) === String(t.id) && el("mtText");
        var unsent = ((onScreen ? el("mtText").value : getDraft(t.id)) || text).trim();
        if (onScreen) el("mtText").value = "";
        setDraft(t.id, "");
        S.tasks = S.tasks.filter(function (x) { return String(x.id) !== String(t.id); });
        if (String(S.sel) === String(t.id)) closeTask();
        notice("warn", "This task is already complete",
          "“" + nameOf(t) + "” was marked complete before your update reached it, so it was not added. What you wrote: “" + unsent + "”");
        renderList();
      } else if (String(S.sel) === String(t.id)) {
        status("err", sendError(e));
      } else {
        /* The person has moved on to another task, so the failure is said
           above the list, not on that task's line. */
        notice("warn", "Your update on “" + nameOf(t) + "” was not saved",
          "It is kept on this phone. Open the task and tap Send again.");
      }
    } finally {
      delete S.busy[String(t.id)];
      /* Only this task's button: the one on screen may belong to another
         task with its own update still sending. */
      var b = String(S.sel) === String(t.id) ? el("mtSend") : null;
      if (b) { b.disabled = false; b.textContent = "Send update"; }
    }
  }

  /* A close that did not go through keeps its closing note — back in the
     box and as the task's draft — so Mark complete offers the same words
     again. The note replaces the box only if the box still holds what it
     held when the question was asked; words typed there while it was
     sending stay, after the note. A task closed meanwhile, or another one
     opened, gets the note in its draft only, never in the box on screen. */
  function keepClosingNote(t, note, typed) {
    if (!note) return false;
    var ta = String(S.sel) === String(t.id) ? el("mtText") : null;
    var now = (ta ? ta.value : getDraft(t.id)).trim();
    var kept = !now || now === typed ? note : now.indexOf(note) !== -1 ? now : note + "\n" + now;
    if (ta) ta.value = kept;
    setDraft(t.id, kept);
    return !!ta;
  }

  async function complete() {
    var t = find(S.sel);
    if (!t) return;
    if (S.busy[String(t.id)]) { status("", busyText(t.id)); return; }
    var typed = el("mtText") ? el("mtText").value.trim() : "";
    var v = await DCR.modal({
      title: "Mark this task complete?",
      message: "“" + nameOf(t) + "” will leave the list. Add a closing note if there is anything the office should know.",
      okText: "Mark complete",
      fields: [{ name: "note", type: "textarea", rows: 3, label: "Closing note (optional)", value: typed,
        placeholder: "e.g. All framed, photos taken" }],
      validate: function (x) {
        return String(x.note || "").trim().length > 2000 ? "Keep the closing note under 2,000 characters." : "";
      },
    });
    if (!v) return;
    var note = String(v.note || "").trim();
    var btn = el("mtComplete");
    S.busy[String(t.id)] = "complete";
    if (btn) { btn.disabled = true; btn.textContent = "Marking complete…"; }
    /* The dialog forgets its words once it closes, so the closing note is
       kept as the draft before it is sent, as Send does, in case the page is
       left while it is in flight. A success below clears it. */
    if (note) setDraft(t.id, note);
    try {
      var r = await DCR.api(EP, { method: "POST", body: { op: "complete", itemId: t.id, note: note } });
      /* Emptied before closing, or closing would keep it as a draft for a
         task that is finished. Only if it is still the task on screen: one
         opened meanwhile keeps its box and stays open. */
      if (String(S.sel) === String(t.id)) {
        if (el("mtText")) el("mtText").value = "";
        closeTask();
      }
      setDraft(t.id, "");
      store(shotsKey(t.id), null);   // a finished shoot's checklist is not needed again
      S.tasks = S.tasks.filter(function (x) { return String(x.id) !== String(t.id); });
      notice("ok", "“" + nameOf(t) + "” is marked complete.",
        r && r.already ? "It had already been completed." : "It has left your list, and the office can see it.");
      renderList();
    } catch (e) {
      var inBox = keepClosingNote(t, note, typed);
      var why = e && e.status ? (e.message || "That didn't save.") : "No signal - the task is still open. Try again when you have signal.";
      if (String(S.sel) === String(t.id)) {
        status("err", why + (inBox ? " Your closing note is kept in the box." : ""));
        var b = el("mtComplete");
        if (b) { b.disabled = false; b.textContent = "Mark complete"; }
      } else {
        notice("warn", "“" + nameOf(t) + "” was not marked complete",
          why + (note ? " Your closing note is kept with the task." : ""));
      }
    } finally {
      delete S.busy[String(t.id)];
    }
  }

  /* ── opening and closing, with the Back button ───────────────────────── */

  function urlFor(id) {
    var u = new URL(location.href);
    if (id) u.searchParams.set("task", id); else u.searchParams.delete("task");
    return u.pathname + u.search + u.hash;
  }
  function stateWith(id) {
    var s = Object.assign({}, history.state || {});
    if (id) s.mtTask = String(id); else delete s.mtTask;
    return s;
  }

  /* On a phone the task covers the list, so the rest of the page is made
     inert (not reachable by Tab or a screen reader) while it is open. */
  function setModal(on) {
    var modal = !!on && !WIDE.matches;
    var d = el("mtDetail");
    d.setAttribute("role", modal ? "dialog" : "region");
    if (modal) d.setAttribute("aria-modal", "true"); else d.removeAttribute("aria-modal");
    if (on) d.setAttribute("aria-labelledby", "mtDTitle"); else d.removeAttribute("aria-labelledby");
    [el("mtListCol"), document.querySelector(".topbar")].forEach(function (n) {
      if (!n) return;
      if (modal) n.setAttribute("inert", ""); else n.removeAttribute("inert");
    });
    document.documentElement.classList.toggle("mt-locked", modal);
  }

  /* Opening a task is a step in the browser's history (?task=<id>), so the
     phone's Back gesture closes the task instead of leaving the page — on a
     link from a text message, leaving would drop the person back in their
     messages. */
  function openTask(id, opts) {
    opts = opts || {};
    var t = find(id);
    if (!t) return false;
    var wasOpen = !!S.sel;
    if (opts.history !== false) {
      if (wasOpen && history.state && history.state.mtTask) {
        history.replaceState(stateWith(t.id), "", urlFor(t.id));
      } else {
        history.pushState(stateWith(t.id), "", urlFor(t.id));
        S.pushed = true;
      }
    }
    S.sel = String(t.id);
    renderDetail(t);
    el("mtDetail").classList.add("open");
    el("mtDScroll").scrollTop = 0;
    setModal(true);
    renderList();
    /* The keyboard is opened only where there is a real pointer: on a phone
       it would cover the task before the person has read it. */
    if (FINE.matches && opts.focusText !== false) el("mtText").focus({ preventScroll: true });
    else el("mtDTitle").focus({ preventScroll: true });
    refreshOne(t.id);
    return true;
  }

  function closeTask(opts) {
    opts = opts || {};
    if (!S.sel) return;
    if (!opts.fromPop) {
      if (S.pushed && history.state && history.state.mtTask) {
        S.pushed = false;
        history.back();               // popstate closes it
        return;
      }
      history.replaceState(stateWith(""), "", urlFor(""));
    }
    var ta = el("mtText");
    if (ta && ta.value.trim()) setDraft(S.sel, ta.value);
    var id = S.sel;
    S.sel = "";
    S.pushed = false;
    el("mtDetail").classList.remove("open");
    el("mtDScroll").innerHTML = '<div class="mt-ph">Pick a task to see its updates and send one.</div>';
    setModal(false);
    renderList();
    var back = document.querySelector('#mtList [data-open="' + String(id).replace(/"/g, "") + '"]');
    if (back) back.focus({ preventScroll: false }); else el("mtTitle").focus();
  }

  window.addEventListener("popstate", function (e) {
    var want = e.state && e.state.mtTask;
    if (want && find(want)) {
      S.pushed = true;
      if (String(want) !== String(S.sel)) openTask(want, { history: false, focusText: false });
    } else if (S.sel) {
      closeTask({ fromPop: true });
    }
  });

  /* The app dialog (DCR.modal) hears Escape first, in the capture phase, and
     has already closed by the time it gets here, so the open-dialog check
     alone would let one Escape close both the question and the task. A key
     it handled arrives marked defaultPrevented. */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !S.sel || e.defaultPrevented) return;
    if (document.querySelector(".dcr-mo.open")) return;   // a dialog still open owns the key
    e.preventDefault();
    closeTask();
  });

  WIDE.addEventListener && WIDE.addEventListener("change", function () { if (S.sel) setModal(true); });

  /* Somebody else may have written on the task since the list loaded (the
     office, Access, a texted reply): fetch it fresh when it is opened. */
  async function refreshOne(id) {
    try {
      var r = await DCR.api(EP + "&task=" + encodeURIComponent(id));
      var t = r && r.task;
      if (!t) return;
      if (t.TaskCheckComplete) {
        S.tasks = S.tasks.filter(function (x) { return String(x.id) !== String(id); });
        if (String(S.sel) === String(id)) closeTask();
        notice("ok", "This task is already complete", "“" + nameOf(t) + "” was marked complete. Nothing more to do here.");
        renderList();
        return;
      }
      var old = find(id);
      if (old && old.TaskCompletedWork === t.TaskCompletedWork) return;
      replaceTask(t);
      refreshDetailParts(t, false);
      renderList();
    } catch (e) { /* the list's copy is still shown; a send reads fresh anyway */ }
  }

  /* ── loading ─────────────────────────────────────────────────────────── */

  async function load() {
    var d = await DCR.api(EP);
    S.tasks = (d && d.tasks) || [];
    S.scope = d ? d.scope : null;
    S.me = String((d && d.employeeName) || "");
    S.today = String((d && d.today) || "");
    S.needsDays = (d && d.needsUpdateDays) || 5;
    S.loaded = true;
    var saved = read(VIEW_KEY);
    var mine = S.tasks.filter(function (t) { return t.mine; }).length;
    if (!canToggle()) S.view = S.me ? "mine" : "all";
    else if (saved === "mine" || saved === "all") S.view = saved;
    else S.view = mine ? "mine" : "all";
  }

  function loadFailed(e) {
    el("mtList").removeAttribute("aria-busy");
    el("mtSub").textContent = "";
    el("mtList").innerHTML = '<div class="mt-empty"><b>' +
      esc(e && e.status ? "Couldn't load your tasks." : "No signal — your tasks will load when you're back online.") + "</b>" +
      (e && e.status && e.message ? esc(e.message) + " " : "") +
      '<div style="margin-top:10px"><button type="button" class="mt-nbtn btn btn-ghost" id="mtRetry">Try again</button></div></div>';
    el("mtRetry").onclick = function () { location.reload(); };
  }

  /* A link opens its task on top of the list, as if the person had tapped
     it there: the list goes under it in the browser's history, so the
     phone's Back gesture closes the task instead of leaving the page (from
     a text message, leaving would drop them back in Messages). An entry
     that already holds this task (a reload, or Back from another page) has
     the list under it already, and pushing again would add a second list
     for Back to step through. */
  function openLinked(want) {
    if (history.state && history.state.mtTask === String(want)) {
      openTask(want, { history: false });
      S.pushed = true;
      return;
    }
    history.replaceState(stateWith(""), "", urlFor(""));
    openTask(want);
  }

  /* A link to one task: open it; if it is someone else's task in your view
     (an admin following up), switch to the view that has it; if it was
     finished since, say so kindly; if it is not yours, say that and show
     the list. */
  async function openFromLink(want) {
    if (!/^\d{1,10}$/.test(want)) {
      history.replaceState(stateWith(""), "", urlFor(""));
      notice("warn", "That link doesn't name a task", "Here are your open tasks.");
      return;
    }
    var t = find(want);
    if (t) {
      if (S.view === "mine" && !t.mine) S.view = "all";
      renderList();
      openLinked(want);
      return;
    }
    try {
      var r = await DCR.api(EP + "&task=" + encodeURIComponent(want));
      var one = r && r.task;
      if (one && one.TaskCheckComplete) {
        history.replaceState(stateWith(""), "", urlFor(""));
        notice("ok", "This task is already complete",
          "“" + nameOf(one) + "” was marked complete. Nothing more to do here.", visible().length ? "See my other tasks" : "");
        return;
      }
      if (one) {
        replaceTask(one);
        if (!one.mine) S.view = "all";
        renderList();
        openLinked(want);
        return;
      }
    } catch (e) {
      history.replaceState(stateWith(""), "", urlFor(""));
      if (e && e.status === 404) {
        if (unlinked()) notice("warn", UNLINKED, "");
        else notice("warn", "This task isn't on your list", "It may have been moved to someone else or removed. Your open tasks are below.");
      } else {
        notice("warn", "Couldn't open that task", e && e.status ? e.message : "No signal — try the link again when you're back online.");
      }
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    S.profile = profile;
    el("userPill").textContent = (profile.displayName || profile.email || "") + " · " + (profile.role || "");

    el("mtList").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-open]") : null;
      if (b) openTask(b.getAttribute("data-open"));
    });
    el("mtSegMine").onclick = function () { setView("mine", true); };
    el("mtSegAll").onclick = function () { setView("all", true); };
    el("mtBack").onclick = function () { closeTask(); };
    el("mtClose").onclick = function () { closeTask(); };

    /* The part of the screen the keyboard leaves, for the full-screen task
       view on a phone. */
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var fit = function () { document.documentElement.style.setProperty("--vvh", Math.round(vv.height) + "px"); };
      vv.addEventListener("resize", fit);
      fit();
    }

    try {
      await load();
    } catch (e) {
      loadFailed(e);
      return;
    }
    renderList();
    var want = new URLSearchParams(location.search).get("task");
    if (want !== null) await openFromLink(want);
  });
})();
