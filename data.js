// Data Browser: browse and edit the SharePoint tables the signed-in user may access.
// (Moved from the old dashboard; the dashboard is now the Home launcher.)
(function () {
  // Fields the backend refuses to write — don't offer them as editable inputs.
  var NON_EDITABLE = new Set([
    "attachments", "contentType", "encodedAbsoluteURL", "encodedAbsoluteUR",
    "fileLeafRef", "fileType", "fileType0", "folderChildCount", "itemChildCount",
    "itemType", "path", "uRLPath", "workflowInstanceI", "workflowInstanceID", "oldID",
  ]);
  var HIDDEN_COLS = new Set(["sharePointId", "webUrl"]);

  var state = { profile: null, list: null, meta: null, rows: [], editing: null };

  var el = function (id) { return document.getElementById(id); };
  var prettify = function (key) {
    return key.replace(/([A-Z])/g, " $1").replace(/^./, function (c) { return c.toUpperCase(); }).trim();
  };

  async function init() {
    state.profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (state.profile.displayName || state.profile.email) + " · " + state.profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    buildNav(state.profile.permissions || {});

    el("reloadBtn").onclick = function () { loadList(state.list); };
    el("search").oninput = renderTable;
    el("addBtn").onclick = function () { openEditor(null); };
    el("cancelBtn").onclick = closeModal;
    el("saveBtn").onclick = saveRecord;
    el("modal").addEventListener("click", function (e) {
      if (e.target === el("modal")) closeModal();
    });
  }

  function buildNav(perms) {
    var nav = el("nav");
    var keys = Object.keys(perms).sort(function (a, b) { return prettify(a).localeCompare(prettify(b)); });
    if (!keys.length) {
      nav.innerHTML = '<p class="muted" style="padding:8px">No tables assigned yet. Ask an admin for access.</p>';
      return;
    }
    nav.innerHTML = "";
    keys.forEach(function (key) {
      var btn = document.createElement("button");
      btn.className = "nav-item";
      btn.dataset.key = key;
      btn.innerHTML = "<span>" + DCR.esc(prettify(key)) + '</span><span class="tag">' +
        (perms[key] === "write" ? "edit" : "view") + "</span>";
      btn.onclick = function () { loadList(key); };
      nav.appendChild(btn);
    });
  }

  async function loadList(key) {
    if (!key) return;
    state.list = key;
    document.querySelectorAll(".nav-item").forEach(function (n) {
      n.classList.toggle("active", n.dataset.key === key);
    });
    el("welcome").style.display = "none";
    el("tableView").style.display = "";
    el("search").value = "";
    el("tableArea").innerHTML = '<div class="spinner">Loading…</div>';
    try {
      var data = await DCR.api("/api/portal?action=data&list=" + encodeURIComponent(key) + "&top=500");
      state.meta = data;
      state.rows = data.value || [];
      el("tableTitle").textContent = data.displayName || prettify(key);
      el("addBtn").style.display = data.canWrite ? "" : "none";
      renderTable();
    } catch (ex) {
      el("tableArea").innerHTML = '<div class="empty">' + DCR.esc(ex.message) + "</div>";
    }
  }

  function visibleColumns() {
    var fields = (state.meta && state.meta.fields) || [];
    return fields.filter(function (f) { return !HIDDEN_COLS.has(f); });
  }

  function renderTable() {
    var term = el("search").value.trim().toLowerCase();
    var cols = visibleColumns();
    var rows = term
      ? state.rows.filter(function (r) {
          return cols.some(function (c) { return String(r[c] == null ? "" : r[c]).toLowerCase().indexOf(term) !== -1; });
        })
      : state.rows;

    if (!rows.length) {
      el("tableArea").innerHTML = '<div class="empty">' +
        (state.rows.length ? "No records match your search." : "This table has no records yet.") + "</div>";
      return;
    }

    var canWrite = state.meta.canWrite;
    var head = "<tr>" + cols.map(function (c) { return "<th>" + DCR.esc(prettify(c)) + "</th>"; }).join("") +
      (canWrite ? "<th>Actions</th>" : "") + "</tr>";

    var body = rows.map(function (r, i) {
      var cells = cols.map(function (c) {
        return '<td title="' + DCR.esc(r[c]) + '">' + DCR.esc(fmt(r[c])) + "</td>";
      }).join("");
      var actions = canWrite
        ? '<td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit="' + i + '">Edit</button></td>'
        : "";
      return "<tr>" + cells + actions + "</tr>";
    }).join("");

    el("tableArea").innerHTML = '<div class="table-scroll"><table><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>";

    el("tableArea").querySelectorAll("[data-edit]").forEach(function (b) {
      b.onclick = function () { openEditor(rows[Number(b.dataset.edit)]); };
    });
  }

  function fmt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    var s = String(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }

  function editableFields() {
    return visibleColumns().filter(function (f) { return !NON_EDITABLE.has(f); });
  }

  function openEditor(row) {
    state.editing = row; // null => new record
    el("modalTitle").textContent = row ? "Edit record" : "Add record";
    el("modalErr").classList.remove("show");
    var wrap = el("formFields");
    wrap.innerHTML = "";
    editableFields().forEach(function (f) {
      var val = row ? (row[f] == null ? "" : row[f]) : "";
      var id = "fld_" + f;
      var long = String(val).length > 60;
      var div = document.createElement("div");
      if (long) div.className = "full";
      div.innerHTML = '<label for="' + id + '">' + DCR.esc(prettify(f)) + "</label>" +
        (long ? '<textarea id="' + id + '" rows="3"></textarea>' : '<input id="' + id + '" type="text" />');
      wrap.appendChild(div);
      div.querySelector("textarea,input").value = val;
    });
    el("modal").classList.add("show");
  }

  function closeModal() {
    el("modal").classList.remove("show");
    state.editing = null;
  }

  async function saveRecord() {
    var fields = {};
    editableFields().forEach(function (f) {
      var node = el("fld_" + f);
      if (!node) return;
      var newVal = node.value;
      if (state.editing) {
        if (String(state.editing[f] == null ? "" : state.editing[f]) !== newVal) fields[f] = newVal;
      } else if (newVal !== "") {
        fields[f] = newVal;
      }
    });
    if (!Object.keys(fields).length) {
      el("modalErr").textContent = "No changes to save.";
      el("modalErr").classList.add("show");
      return;
    }

    el("saveBtn").disabled = true;
    el("saveBtn").textContent = "Saving…";
    try {
      if (state.editing) {
        await DCR.api("/api/portal?action=data", {
          method: "PATCH",
          body: { list: state.list, itemId: state.editing.id, fields: fields },
        });
      } else {
        await DCR.api("/api/portal?action=data", {
          method: "POST",
          body: { list: state.list, fields: fields },
        });
      }
      closeModal();
      await loadList(state.list);
    } catch (ex) {
      el("modalErr").textContent = ex.message || "Save failed.";
      el("modalErr").classList.add("show");
    } finally {
      el("saveBtn").disabled = false;
      el("saveBtn").textContent = "Save";
    }
  }

  init().catch(function (e) { console.error(e); });
})();
