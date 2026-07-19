// Dashboard: browse and edit the SharePoint tables the signed-in user may access.
(function () {
  // Fields the backend refuses to write — don't offer them as editable inputs.
  const NON_EDITABLE = new Set([
    "attachments", "contentType", "encodedAbsoluteURL", "encodedAbsoluteUR",
    "fileLeafRef", "fileType", "fileType0", "folderChildCount", "itemChildCount",
    "itemType", "path", "uRLPath", "workflowInstanceI", "workflowInstanceID", "oldID",
  ]);
  const HIDDEN_COLS = new Set(["sharePointId", "webUrl"]);

  const state = { profile: null, list: null, meta: null, rows: [], editing: null };

  const el = (id) => document.getElementById(id);
  const prettify = (key) =>
    key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();

  async function init() {
    state.profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = `${state.profile.displayName || state.profile.email} · ${state.profile.role}`;
    if (state.profile.role === "Admin") el("adminLink").style.display = "";
    // "Team Sheets" is for managers/office (scope "*") and leads (have a crew).
    var ts = state.profile.tsScope;
    if (ts === "*" || (ts && ts.managed && ts.managed.length)) {
      el("teamLink").style.display = "";
      el("batchLink").style.display = "";
    }
    var pp = state.profile.permissions || {};
    if (pp.leads) el("leadsLink").style.display = "";
    if (pp.marketingTasks) el("marketingLink").style.display = "";
    el("logoutBtn").onclick = () => DCR.logout();

    buildNav(state.profile.permissions || {});

    el("reloadBtn").onclick = () => loadList(state.list);
    el("search").oninput = renderTable;
    el("addBtn").onclick = () => openEditor(null);
    el("cancelBtn").onclick = closeModal;
    el("saveBtn").onclick = saveRecord;
    el("modal").addEventListener("click", (e) => {
      if (e.target === el("modal")) closeModal();
    });
  }

  function buildNav(perms) {
    const nav = el("nav");
    const keys = Object.keys(perms).sort((a, b) => prettify(a).localeCompare(prettify(b)));
    if (!keys.length) {
      nav.innerHTML = '<p class="muted" style="padding:8px">No tables assigned yet. Ask an admin for access.</p>';
      return;
    }
    nav.innerHTML = "";
    for (const key of keys) {
      const btn = document.createElement("button");
      btn.className = "nav-item";
      btn.dataset.key = key;
      btn.innerHTML = `<span>${DCR.esc(prettify(key))}</span><span class="tag">${
        perms[key] === "write" ? "edit" : "view"
      }</span>`;
      btn.onclick = () => loadList(key);
      nav.appendChild(btn);
    }
  }

  async function loadList(key) {
    if (!key) return;
    state.list = key;
    document.querySelectorAll(".nav-item").forEach((n) =>
      n.classList.toggle("active", n.dataset.key === key)
    );
    el("welcome").style.display = "none";
    el("tableView").style.display = "";
    el("search").value = "";
    el("tableArea").innerHTML = '<div class="spinner">Loading…</div>';
    try {
      const data = await DCR.api(`/api/portal?action=data&list=${encodeURIComponent(key)}&top=500`);
      state.meta = data;
      state.rows = data.value || [];
      el("tableTitle").textContent = data.displayName || prettify(key);
      el("addBtn").style.display = data.canWrite ? "" : "none";
      renderTable();
    } catch (ex) {
      el("tableArea").innerHTML = `<div class="empty">${DCR.esc(ex.message)}</div>`;
    }
  }

  function visibleColumns() {
    const fields = (state.meta && state.meta.fields) || [];
    return fields.filter((f) => !HIDDEN_COLS.has(f));
  }

  function renderTable() {
    const term = el("search").value.trim().toLowerCase();
    const cols = visibleColumns();
    const rows = term
      ? state.rows.filter((r) =>
          cols.some((c) => String(r[c] ?? "").toLowerCase().includes(term))
        )
      : state.rows;

    if (!rows.length) {
      el("tableArea").innerHTML = `<div class="empty">${
        state.rows.length ? "No records match your search." : "This table has no records yet."
      }</div>`;
      return;
    }

    const canWrite = state.meta.canWrite;
    const head =
      "<tr>" +
      cols.map((c) => `<th>${DCR.esc(prettify(c))}</th>`).join("") +
      (canWrite ? "<th>Actions</th>" : "") +
      "</tr>";

    const body = rows
      .map((r, i) => {
        const cells = cols
          .map((c) => `<td title="${DCR.esc(r[c])}">${DCR.esc(fmt(r[c]))}</td>`)
          .join("");
        const actions = canWrite
          ? `<td class="row-actions"><button class="btn btn-ghost btn-sm" data-edit="${i}">Edit</button></td>`
          : "";
        return `<tr>${cells}${actions}</tr>`;
      })
      .join("");

    el("tableArea").innerHTML = `<div class="table-scroll"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;

    // wire edit buttons (indexes map into the *filtered* row set)
    el("tableArea").querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = () => openEditor(rows[Number(b.dataset.edit)]);
    });
  }

  function fmt(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "Yes" : "No";
    const s = String(v);
    return s.length > 80 ? s.slice(0, 80) + "…" : s;
  }

  function editableFields() {
    return visibleColumns().filter((f) => !NON_EDITABLE.has(f));
  }

  function openEditor(row) {
    state.editing = row; // null => new record
    el("modalTitle").textContent = row ? "Edit record" : "Add record";
    el("modalErr").classList.remove("show");
    const wrap = el("formFields");
    wrap.innerHTML = "";
    for (const f of editableFields()) {
      const val = row ? row[f] ?? "" : "";
      const id = "fld_" + f;
      const long = String(val).length > 60;
      const div = document.createElement("div");
      if (long) div.className = "full";
      div.innerHTML =
        `<label for="${id}">${DCR.esc(prettify(f))}</label>` +
        (long
          ? `<textarea id="${id}" rows="3"></textarea>`
          : `<input id="${id}" type="text" />`);
      wrap.appendChild(div);
      div.querySelector("textarea,input").value = val;
    }
    el("modal").classList.add("show");
  }

  function closeModal() {
    el("modal").classList.remove("show");
    state.editing = null;
  }

  async function saveRecord() {
    const fields = {};
    for (const f of editableFields()) {
      const node = el("fld_" + f);
      if (!node) continue;
      const newVal = node.value;
      if (state.editing) {
        // send only changed fields
        if (String(state.editing[f] ?? "") !== newVal) fields[f] = newVal;
      } else if (newVal !== "") {
        fields[f] = newVal;
      }
    }
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
          body: { list: state.list, itemId: state.editing.id, fields },
        });
      } else {
        await DCR.api("/api/portal?action=data", {
          method: "POST",
          body: { list: state.list, fields },
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

  init().catch((e) => console.error(e));
})();
