// Admin console: create users, assign roles, override per-table access, reset passwords.
(function () {
  const state = { profile: null, users: [], lists: [], roster: [], editing: null };
  const el = (id) => document.getElementById(id);

  const parseNames = (raw) =>
    String(raw || "").split(/[\n;,]+/).map((s) => s.trim()).filter(Boolean);

  async function init() {
    state.profile = await DCR.requireAuth();
    if (state.profile.role !== "Admin") {
      document.body.innerHTML =
        '<div class="empty"><h2>Access denied</h2><p class="muted">Admins only. ' +
        '<a href="dashboard.html">Back to dashboard</a></p></div>';
      return;
    }
    el("companyName").textContent = DCR.company + " Portal — Admin";
    el("userPill").textContent = `${state.profile.displayName || state.profile.email} · Admin`;
    el("logoutBtn").onclick = () => DCR.logout();
    el("newUserBtn").onclick = () => openEditor(null);
    el("cancelBtn").onclick = closeModal;
    el("saveBtn").onclick = saveUser;
    el("modal").addEventListener("click", (e) => {
      if (e.target === el("modal")) closeModal();
    });

    try {
      const { lists } = await DCR.api("/api/portal?action=lists");
      state.lists = lists;
    } catch (e) {
      /* non-fatal: overrides picker just won't populate */
    }
    try {
      const { employees } = await DCR.api("/api/portal?action=roster");
      state.roster = employees || [];
    } catch (e) {
      /* non-fatal: employee/crew pickers just won't populate */
    }
    await loadUsers();
  }

  async function loadUsers() {
    el("usersArea").innerHTML = '<div class="spinner">Loading…</div>';
    try {
      const { users } = await DCR.api("/api/portal?action=users");
      state.users = users;
      renderUsers();
    } catch (ex) {
      el("usersArea").innerHTML = `<div class="empty">${DCR.esc(ex.message)}</div>`;
    }
  }

  function renderUsers() {
    if (!state.users.length) {
      el("usersArea").innerHTML = '<div class="empty">No users yet.</div>';
      return;
    }
    const rows = state.users
      .map((u, i) => {
        const last = u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "—";
        return `<tr>
          <td>${DCR.esc(u.email)}</td>
          <td>${DCR.esc(u.displayName || "")}</td>
          <td>${DCR.esc(u.role)}</td>
          <td>${u.active ? '<span style="color:var(--ok)">Active</span>' : '<span class="muted">Disabled</span>'}</td>
          <td>${DCR.esc(last)}</td>
          <td class="row-actions">
            <button class="btn btn-ghost btn-sm" data-edit="${i}">Edit</button>
            <button class="btn btn-ghost btn-sm" data-toggle="${i}">${u.active ? "Disable" : "Enable"}</button>
          </td>
        </tr>`;
      })
      .join("");
    el("usersArea").innerHTML = `<div class="table-scroll"><table>
      <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;

    el("usersArea").querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = () => openEditor(state.users[Number(b.dataset.edit)]);
    });
    el("usersArea").querySelectorAll("[data-toggle]").forEach((b) => {
      b.onclick = () => toggleActive(state.users[Number(b.dataset.toggle)]);
    });
  }

  function buildPermGrid(overrides) {
    const grid = el("permGrid");
    if (!state.lists.length) {
      grid.innerHTML = '<span class="muted">Table list unavailable.</span>';
      return;
    }
    grid.innerHTML = "";
    for (const l of state.lists.sort((a, b) => a.displayName.localeCompare(b.displayName))) {
      const cur = overrides[l.key] || "";
      const label = document.createElement("div");
      label.className = "pk";
      label.textContent = l.displayName;
      const sel = document.createElement("select");
      sel.dataset.key = l.key;
      sel.innerHTML =
        `<option value="">Default</option>` +
        `<option value="read">View</option>` +
        `<option value="write">Edit</option>` +
        `<option value="none">No access</option>`;
      sel.value = ["read", "write", "none"].includes(cur) ? cur : "";
      grid.appendChild(label);
      grid.appendChild(sel);
    }
  }

  function buildRosterControls(user) {
    const names = (state.roster || []).map((e) => e.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
    el("rosterList").innerHTML = names.map((n) => `<option value="${DCR.esc(n)}">`).join("");
    el("uEmployee").value = user ? user.employeeName || "" : "";
    const managed = new Set(parseNames(user ? user.managedEmployees : "").map((n) => n.toLowerCase()));
    el("uManaged").innerHTML = names
      .map((n) => `<option value="${DCR.esc(n)}"${managed.has(n.toLowerCase()) ? " selected" : ""}>${DCR.esc(n)}</option>`)
      .join("");
  }

  function collectManaged() {
    return Array.from(el("uManaged").selectedOptions).map((o) => o.value);
  }

  function collectOverrides() {
    const out = {};
    el("permGrid")
      .querySelectorAll("select[data-key]")
      .forEach((s) => {
        if (s.value) out[s.dataset.key] = s.value;
      });
    // capability flags ride in the same overrides JSON under reserved keys
    if (el("uEstPrices").value) out["flag:estimatePrices"] = el("uEstPrices").value;
    if (el("uSalesEst").value) out["flag:salesEstimates"] = el("uSalesEst").value;
    if (el("uApprovePay").value) out["flag:approvePayments"] = el("uApprovePay").value;
    return out;
  }

  function openEditor(user) {
    state.editing = user;
    el("modalErr").classList.remove("show");
    el("modalTitle").textContent = user ? "Edit user" : "New user";
    el("uEmail").value = user ? user.email : "";
    el("uEmail").disabled = Boolean(user); // email is the key, not editable
    el("uName").value = user ? user.displayName || "" : "";
    el("uRole").value = user ? user.role : "ReadOnly";
    el("uActive").value = user ? String(user.active) : "true";
    el("uPass").value = "";
    el("passLabel").textContent = user ? "Reset password (leave blank to keep)" : "Temporary password";

    let overrides = {};
    if (user && user.permissions) {
      try {
        overrides = JSON.parse(user.permissions) || {};
      } catch {
        /* ignore */
      }
    }
    el("uEstPrices").value = ["on", "off"].includes(overrides["flag:estimatePrices"])
      ? overrides["flag:estimatePrices"] : "";
    el("uSalesEst").value = ["on", "off"].includes(overrides["flag:salesEstimates"])
      ? overrides["flag:salesEstimates"] : "";
    el("uApprovePay").value = ["on", "off"].includes(overrides["flag:approvePayments"])
      ? overrides["flag:approvePayments"] : "";
    buildPermGrid(overrides);
    buildRosterControls(user);
    el("modal").classList.add("show");
  }

  function closeModal() {
    el("modal").classList.remove("show");
    state.editing = null;
  }

  async function saveUser() {
    el("modalErr").classList.remove("show");
    const email = el("uEmail").value.trim();
    const password = el("uPass").value;
    const payload = {
      displayName: el("uName").value.trim(),
      role: el("uRole").value,
      active: el("uActive").value === "true",
      permissions: collectOverrides(),
      employeeName: el("uEmployee").value.trim(),
      managedEmployees: collectManaged(),
    };

    el("saveBtn").disabled = true;
    el("saveBtn").textContent = "Saving…";
    try {
      if (state.editing) {
        payload.id = state.editing.id;
        if (password) payload.password = password;
        await DCR.api("/api/portal?action=users", { method: "PATCH", body: payload });
      } else {
        if (!email) throw new Error("Email is required.");
        if (!password || password.length < 8) throw new Error("Temporary password (8+ chars) is required.");
        payload.email = email;
        payload.password = password;
        await DCR.api("/api/portal?action=users", { method: "POST", body: payload });
      }
      closeModal();
      await loadUsers();
    } catch (ex) {
      el("modalErr").textContent = ex.message || "Save failed.";
      el("modalErr").classList.add("show");
    } finally {
      el("saveBtn").disabled = false;
      el("saveBtn").textContent = "Save";
    }
  }

  async function toggleActive(user) {
    try {
      await DCR.api("/api/portal?action=users", {
        method: "PATCH",
        body: { id: user.id, active: !user.active },
      });
      await loadUsers();
    } catch (ex) {
      el("pageErr").textContent = ex.message;
      el("pageErr").classList.add("show");
    }
  }

  init().catch((e) => console.error(e));
})();
