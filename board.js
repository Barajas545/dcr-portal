/* DCR portal — Project Board (web port of the Access "Board" form).
   Data via the authenticated gateway: GET /api/portal?action=board (+ &logs=<id>),
   POST ops: status / log / create. Thumbnails via action=thumb (blob fetch with auth).
   Read = anyone with `project` read; move/create = Managers/Admin (server-enforced). */

(function () {
  var state = {
    profile: null,
    projects: [],
    statuses: [],
    canWrite: false,
    canLog: false,
    driveReady: false,
    search: "",
    selectedId: null,
    dragging: false,
  };
  var thumbCache = {}; // projectId -> object URL (or "none")

  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  // Column definitions. Each view mirrors its Access board form exactly
  // (statuses, sort fields, and Completed time-windows).
  function col(status, label, acc, opts) {
    var c = { key: status.toLowerCase().replace(/\s/g, ""), label: label, status: status, acc: acc };
    if (opts) for (var k in opts) c[k] = opts[k];
    return c;
  }
  var C = {
    onhold:  function(){ return col("On Hold","On Hold","#d9614f"); },
    estim:   function(){ return col("Estimating","Estimating","#d6a13a"); },
    recived: function(){ return col("Recived","New Request","#2f80d8"); },
    sent:    function(o){ return col("Sent","Sent","#8e6fd8", o||{desc:true}); },
    aproved: function(){ return col("Aproved","Aproved","#2fa679"); },
    inprog:  function(){ return col("In Progress","In Progress","#1f6fc8"); },
    completed: function(months, o){ var c=col("Completed","Completed","#6b7c6f",o||{}); c.recentMonths=months; return c; },
  };
  var VIEWS = {
    main: { label: "Main Board", cols: [C.onhold(), C.estim(), C.recived(), C.sent(), C.aproved(), C.inprog(), C.completed(2)] },
    sales: { label: "Sales", cols: [C.estim(), C.sent({desc:true, sortField:"projectDateLastModified"}), C.aproved(), C.inprog(), C.completed(24, {desc:true, sortField:"projectCompletedDate"})] },
    marketing: { label: "Marketing", cols: [C.aproved(), C.inprog(), C.completed(5, {desc:true, sortField:"projectCompletedDate"})] },
    accounting: { label: "Accounting", cols: [C.aproved(), C.inprog(), C.completed(2, {desc:true, sortField:"projectCompletedDate"})] },
  };
  state.view = (function(){ var v = new URLSearchParams(location.search).get("view"); return VIEWS[v] ? v : "main"; })();
  function activeColumns(){ return VIEWS[state.view].cols; }

  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    if (isNaN(d)) return "";
    var m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    return m + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDateFull(v) {
    if (!v) return "—";
    var d = new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function monthsAgo(m) { var d = new Date(); d.setMonth(d.getMonth() - m); return d; }

  function matchesSearch(p, q) {
    if (!q) return true;
    var hay = [p.internalIDNumber, p.projectName, p.projectAddress, p.projectCity,
      p.projectClientName, p.estimateStatus, p.estimateStatusDescription].join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function columnProjects(col) {
    var q = state.search.trim().toLowerCase();
    var cutoff = col.recentMonths ? monthsAgo(col.recentMonths) : null;
    var winField = col.sortField || "projectDate";
    var rows = state.projects.filter(function (p) {
      if ((p.estimateStatus || "") !== col.status) return false;
      if (cutoff) {
        var wd = p[winField] || p.projectDate;
        if (!wd || new Date(wd) < cutoff) return false;
      }
      return matchesSearch(p, q);
    });
    var sf = col.sortField || "projectDate";
    rows.sort(function (a, b) {
      var da = new Date(a[sf] || a.projectDate || 0), db = new Date(b[sf] || b.projectDate || 0);
      return col.desc ? db - da : da - db;
    });
    return rows;
  }

  /* ── render ── */
  function render() {
    var wrap = el("bdCols");
    wrap.innerHTML = activeColumns().map(function (col) {
      var rows = columnProjects(col);
      var cards = rows.map(function (p) { return cardHtml(p, col); }).join("");
      return '<div class="bd-col" data-status="' + esc(col.status) + '" style="--col-acc:' + col.acc + '">' +
        '<div class="bd-col-head"><span>' + esc(col.label) + '</span><span class="bd-col-count">' + rows.length + '</span></div>' +
        '<div class="bd-col-body">' + (cards || '<div class="bd-empty-col">No projects</div>') + '</div></div>';
    }).join("");

    // wire cards
    wrap.querySelectorAll(".bd-card").forEach(function (c) {
      c.addEventListener("click", function () { selectProject(c.getAttribute("data-id")); });
      c.addEventListener("dblclick", function () { location.href = "project.html?id=" + encodeURIComponent(c.getAttribute("data-id")); });
      if (state.canWrite) {
        c.addEventListener("dragstart", function (e) {
          state.dragging = true;
          c.classList.add("dragging");
          e.dataTransfer.setData("text/plain", c.getAttribute("data-id"));
          e.dataTransfer.effectAllowed = "move";
        });
        c.addEventListener("dragend", function () {
          state.dragging = false;
          c.classList.remove("dragging");
          wrap.querySelectorAll(".bd-col").forEach(function (x) { x.classList.remove("drag-over"); });
        });
      }
    });
    if (state.canWrite) {
      wrap.querySelectorAll(".bd-col").forEach(function (colEl) {
        colEl.addEventListener("dragover", function (e) { e.preventDefault(); colEl.classList.add("drag-over"); });
        colEl.addEventListener("dragleave", function () { colEl.classList.remove("drag-over"); });
        colEl.addEventListener("drop", function (e) {
          e.preventDefault();
          colEl.classList.remove("drag-over");
          var id = e.dataTransfer.getData("text/plain");
          if (id) changeStatus(id, colEl.getAttribute("data-status"));
        });
      });
    }
  }

  function cardHtml(p, col) {
    var sel = String(p.id) === String(state.selectedId) ? " selected" : "";
    var flag = p.checkScopeAndProjectFeatures ? ' <span class="bd-flag" title="Scope & features checked">⚑</span>' : "";
    var addr = [p.projectAddress, p.projectCity].filter(Boolean).join(" · ");
    return '<div class="bd-card' + sel + '" data-id="' + esc(p.id) + '"' + (state.canWrite ? ' draggable="true"' : "") + '>' +
      '<div class="bd-card-top"><span class="bd-card-id">' + esc(p.internalIDNumber || "—") + flag + '</span>' +
      '<span class="bd-card-date">' + fmtDate(p.projectDate) + '</span></div>' +
      '<div class="bd-card-name">' + esc(p.projectName || "(no name)") + '</div>' +
      (addr ? '<div class="bd-card-addr">' + esc(addr) + '</div>' : "") +
      (p.estimateStatusDescription ? '<div class="bd-card-desc">' + esc(p.estimateStatusDescription) + '</div>' : "") +
      '</div>';
  }

  /* ── selection panel ── */
  function findProject(id) {
    return state.projects.find(function (p) { return String(p.id) === String(id); });
  }

  async function selectProject(id) {
    state.selectedId = id;
    var p = findProject(id);
    if (!p) return;
    render();
    el("bdPanel").classList.add("open");
    el("bdOpenProject").href = "project.html?id=" + encodeURIComponent(p.id);
    el("bdPTitle").textContent = (p.internalIDNumber ? p.internalIDNumber + " — " : "") + (p.projectName || "");
    el("bdPSub").textContent = [p.projectAddress, p.projectCity].filter(Boolean).join(", ");
    el("bdPClient").textContent = p.projectClientName || "—";
    el("bdPDate").textContent = fmtDateFull(p.projectDate);
    el("bdPDesc").textContent = p.estimateStatusDescription || "—";
    el("bdPMsg").textContent = ""; el("bdPMsg").className = "bd-msg";

    if (state.canWrite) {
      el("bdStatusRow").style.display = "";
      el("bdStatusSel").innerHTML = state.statuses.map(function (s) {
        return '<option value="' + esc(s) + '"' + (s === p.estimateStatus ? " selected" : "") + '>' + esc(s) + "</option>";
      }).join("");
    }
    el("bdAddLogWrap").style.display = state.canLog ? "" : "none";

    loadThumb(p);
    loadLogs(id);
  }

  async function loadThumb(p) {
    var box = el("bdThumb");
    if (!state.driveReady) { box.innerHTML = "No preview (Drive not connected)"; return; }
    if (thumbCache[p.id] === "none") { box.innerHTML = "No preview available"; return; }
    if (thumbCache[p.id]) { box.innerHTML = '<img src="' + thumbCache[p.id] + '" alt="">'; return; }
    box.innerHTML = "Loading preview…";
    try {
      var r = await fetch(DCR.API_BASE + "/api/portal?action=thumb&projectId=" + encodeURIComponent(p.id), {
        headers: { Authorization: "Bearer " + DCR.getToken() },
      });
      if (!r.ok) throw new Error("no thumb");
      var url = URL.createObjectURL(await r.blob());
      thumbCache[p.id] = url;
      if (String(state.selectedId) === String(p.id)) box.innerHTML = '<img src="' + url + '" alt="">';
    } catch (e) {
      thumbCache[p.id] = "none";
      if (String(state.selectedId) === String(p.id)) box.innerHTML = "No preview available";
    }
  }

  async function loadLogs(id) {
    var box = el("bdLogs");
    box.innerHTML = '<div class="bd-note">Loading…</div>';
    try {
      var d = await DCR.api("/api/portal?action=board&logs=" + encodeURIComponent(id));
      if (String(state.selectedId) !== String(id)) return;
      if (!d.logs.length) { box.innerHTML = '<div class="bd-note">No log entries yet.</div>'; return; }
      box.innerHTML = d.logs.map(function (l) {
        return '<div class="bd-log"><div class="bd-log-date">' + fmtDateFull(l.logDate) + '</div>' +
          '<div class="bd-log-text">' + esc(l.logDescription || "") + '</div>' +
          (l.logUserName ? '<div class="bd-log-user">— ' + esc(l.logUserName) + '</div>' : "") + '</div>';
      }).join("");
    } catch (e) {
      box.innerHTML = '<div class="bd-note">' + esc(e.message || "Could not load logs.") + '</div>';
    }
  }

  /* ── actions ── */
  async function changeStatus(id, newStatus) {
    var p = findProject(id);
    if (!p || p.estimateStatus === newStatus) return;
    var old = p.estimateStatus;
    p.estimateStatus = newStatus; // optimistic
    render();
    try {
      await DCR.api("/api/portal?action=board", { method: "POST", body: { op: "status", projectId: id, newStatus: newStatus } });
      if (String(state.selectedId) === String(id)) selectProject(id); // refresh panel + logs
    } catch (e) {
      p.estimateStatus = old;
      render();
      alert("Could not move project: " + (e.message || "error"));
    }
  }

  async function panelStatusUpdate() {
    var id = state.selectedId;
    if (!id) return;
    var newStatus = el("bdStatusSel").value;
    var msg = el("bdPMsg");
    msg.textContent = "Updating…"; msg.className = "bd-msg";
    try {
      await changeStatus(id, newStatus);
      msg.textContent = "✓ Status updated"; msg.className = "bd-msg ok";
    } catch (e) {
      msg.textContent = e.message || "Update failed"; msg.className = "bd-msg err";
    }
  }

  async function addLogEntry() {
    var id = state.selectedId;
    var text = el("bdAddLog").value.trim();
    var msg = el("bdPMsg");
    if (!id || !text) { msg.textContent = "Write something first."; msg.className = "bd-msg err"; return; }
    msg.textContent = "Saving…"; msg.className = "bd-msg";
    try {
      await DCR.api("/api/portal?action=board", { method: "POST", body: { op: "log", projectId: id, text: text } });
      el("bdAddLog").value = "";
      msg.textContent = "✓ Log entry saved"; msg.className = "bd-msg ok";
      loadLogs(id);
    } catch (e) {
      msg.textContent = e.message || "Save failed"; msg.className = "bd-msg err";
    }
  }

  async function createProject() {
    var msg = el("npMsg");
    msg.textContent = "";
    var body = {
      op: "create",
      internalIDNumber: el("npId").value.trim(),
      projectName: el("npName").value.trim(),
      projectAddress: el("npAddr").value.trim(),
      projectCity: el("npCity").value.trim(),
    };
    if (!body.internalIDNumber || !body.projectName) { msg.textContent = "ID number and name are required."; return; }
    el("npCreate").disabled = true;
    try {
      await DCR.api("/api/portal?action=board", { method: "POST", body: body });
      el("bdNewModal").classList.remove("open");
      ["npId","npName","npAddr","npCity"].forEach(function (i) { el(i).value = ""; });
      await load();
    } catch (e) {
      msg.textContent = e.message || "Create failed.";
    }
    el("npCreate").disabled = false;
  }

  /* ── data ── */
  async function load() {
    try {
      var d = await DCR.api("/api/portal?action=board");
      state.projects = d.projects || [];
      state.statuses = d.statuses || [];
      state.canWrite = !!d.canWrite;
      state.canLog = !!d.canLog;
      state.driveReady = !!d.driveReady;
      el("bdNewBtn").style.display = state.canWrite ? "" : "none";
      el("bdNote").textContent = state.canWrite ? "Drag projects between stages" : "Read-only view";
      render();
    } catch (e) {
      el("bdCols").innerHTML = '<div class="bd-empty-col" style="margin:auto">' + esc(e.message || "Error loading board.") + "</div>";
    }
  }

  /* ── init ── */
  document.addEventListener("DOMContentLoaded", async function () {
    state.profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (state.profile.displayName || state.profile.email) + " · " + state.profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    var vs = el("bdView");
    vs.innerHTML = Object.keys(VIEWS).map(function(k){ return '<option value="'+k+'"'+(k===state.view?" selected":"")+'>'+VIEWS[k].label+'</option>'; }).join("");
    vs.onchange = function(){
      state.view = this.value;
      var u = new URL(location.href); u.searchParams.set("view", state.view); history.replaceState(null, "", u);
      render();
    };
    el("bdSearch").addEventListener("input", function () { state.search = this.value; render(); });
    el("bdRefreshBtn").onclick = function () { load(); if (state.selectedId) loadLogs(state.selectedId); };
    el("bdPClose").onclick = function () { el("bdPanel").classList.remove("open"); state.selectedId = null; render(); };
    el("bdStatusGo").onclick = panelStatusUpdate;
    el("bdAddLogGo").onclick = addLogEntry;
    el("bdNewBtn").onclick = function () { el("bdNewModal").classList.add("open"); el("npId").focus(); };
    el("npCancel").onclick = function () { el("bdNewModal").classList.remove("open"); };
    el("npCreate").onclick = createProject;
    el("bdNewModal").addEventListener("click", function (e) { if (e.target === this) this.classList.remove("open"); });

    await load();
    // auto-refresh every 5 minutes (paused while dragging or the modal is open)
    setInterval(function () {
      if (state.dragging || el("bdNewModal").classList.contains("open")) return;
      load();
    }, 300000);
  });
})();
