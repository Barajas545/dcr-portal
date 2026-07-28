/* DCR portal — Materials Library.
   Manages the SalesMaterials SharePoint list: one row per product line, one row
   per color (ItemKind). Pictures: paste any https image URL, or upload a photo
   (stored in the SalesMaterialImages drive folder, streamed back via
   action=sales&part=image and rendered through DCR.blobUrl). The deck estimate
   wizard reads this same list, so edits and photos show up there immediately. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };
  var state = { rows: [], editing: null, editingKind: "product", parentMaterialId: null, uploadedItemId: null };

  function products() { return state.rows.filter(function (r) { return r.itemKind === "product"; }); }
  function colorsOf(materialId) {
    return state.rows.filter(function (r) { return r.itemKind === "color" && r.materialId === materialId; });
  }

  // Fill an <img> from pictureItemId (authenticated blob) or pictureUrl (direct).
  function setPic(img, row, fallbackText) {
    img.removeAttribute("src");
    img.alt = fallbackText || "";
    if (row && row.pictureItemId) {
      DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(row.pictureItemId))
        .then(function (u) { img.src = u; })
        .catch(function () { if (row.pictureUrl) img.src = row.pictureUrl; });
    } else if (row && row.pictureUrl) {
      img.src = row.pictureUrl;
    }
  }

  function render() {
    var q = (el("mlSearch").value || "").trim().toLowerCase();
    var list = products().filter(function (p) {
      if (!q) return true;
      var hay = [p.itemName, p.brandName, p.description, p.marketTier]
        .concat(colorsOf(p.materialId).map(function (c) { return c.itemName; })).join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!list.length) {
      el("mlGrid").innerHTML = '<div class="ml-empty" style="grid-column:1/-1">' +
        (state.rows.length ? "Nothing matches your search." : "No materials yet — add your first product line.") + "</div>";
      return;
    }
    el("mlGrid").innerHTML = list.map(function (p) {
      var cols = colorsOf(p.materialId);
      return '<div class="ml-card" data-id="' + esc(p.id) + '">' +
        '<div class="ml-pic" data-edit="' + esc(p.id) + '">' +
        '<img style="display:none" data-picfor="' + esc(p.id) + '" alt="">' +
        '<span class="ph">🪵</span>' +
        (p.marketTier ? '<span class="tier">' + esc(p.marketTier) + "</span>" : "") +
        (p.itemStatus !== "active" ? '<span class="stat">' + esc(String(p.itemStatus || "").replace(/_/g, " ")) + "</span>" : "") +
        "</div>" +
        '<div class="ml-body">' +
        '<div class="ml-name">' + esc(p.itemName) + "</div>" +
        '<div class="ml-desc">' + esc(p.description || "") + "</div>" +
        '<div style="font-size:11px;color:var(--text-muted)">' +
        [p.warrantySummary, (p.selectable === false ? "not offered" : "offered in estimates")].filter(Boolean).map(esc).join(" · ") + "</div>" +
        '<div class="ml-colors">' +
        cols.map(function (c) {
          return '<span class="ml-swatch" title="' + esc(c.itemName) + '" data-editcolor="' + esc(c.id) + '">' +
            '<img style="display:none" data-picfor="' + esc(c.id) + '" alt=""><span class="cn">' + esc((c.itemName || "").slice(0, 10)) + "</span></span>";
        }).join("") +
        '<span class="ml-swatch addc" title="Add color" data-addcolor="' + esc(p.materialId) + '">＋</span>' +
        "</div>" +
        '<div class="ml-actions"><button class="btn btn-ghost btn-sm" data-edit="' + esc(p.id) + '">✏️ Edit</button></div>' +
        "</div></div>";
    }).join("");

    // hydrate pictures
    state.rows.forEach(function (r) {
      if (!r.pictureItemId && !r.pictureUrl) return;
      var img = el("mlGrid").querySelector('img[data-picfor="' + CSS.escape(r.id) + '"]');
      if (!img) return;
      img.onload = function () {
        img.style.display = "";
        var ph = img.parentElement.querySelector(".ph, .cn");
        if (ph) ph.style.display = "none";
      };
      setPic(img, r);
    });

    el("mlGrid").querySelectorAll("[data-edit]").forEach(function (n) {
      n.onclick = function () {
        var row = state.rows.find(function (r) { return r.id === n.dataset.edit; });
        if (row) openModal(row, "product");
      };
    });
    el("mlGrid").querySelectorAll("[data-editcolor]").forEach(function (n) {
      n.onclick = function (ev) {
        ev.stopPropagation();
        var row = state.rows.find(function (r) { return r.id === n.dataset.editcolor; });
        if (row) openModal(row, "color");
      };
    });
    el("mlGrid").querySelectorAll("[data-addcolor]").forEach(function (n) {
      n.onclick = function (ev) {
        ev.stopPropagation();
        state.parentMaterialId = n.dataset.addcolor;
        openModal(null, "color");
      };
    });
  }

  function openModal(row, kind) {
    state.editing = row;
    state.editingKind = kind;
    state.uploadedItemId = null;
    if (row && kind === "color") state.parentMaterialId = row.materialId;
    el("mTitle").textContent = kind === "color"
      ? (row ? "Edit color — " + row.itemName : "Add color")
      : (row ? "Edit material" : "Add material");
    el("mName").value = row ? row.itemName || "" : "";
    el("mBrand").value = row ? row.brandName || "" : "";
    el("mTier").value = row && row.marketTier ? row.marketTier : "Mid";
    el("mStatus").value = row && row.itemStatus ? row.itemStatus : "active";
    el("mSelectable").value = row && row.selectable === false ? "false" : "true";
    el("mDesc").value = row ? row.description || "" : "";
    el("mHigh").value = row ? row.salesHighlights || "" : "";
    el("mWarranty").value = row ? row.warrantySummary || "" : "";
    el("mManUrl").value = row ? row.manufacturerUrl || "" : "";
    el("mPicUrl").value = row ? row.pictureUrl || "" : "";
    el("mPicFile").value = "";
    el("mPicMsg").textContent = row && row.pictureItemId ? "Using an uploaded photo." : "";
    el("mMsg").textContent = "";
    el("mDelete").style.display = row ? "" : "none";
    // product-only fields hidden for colors
    ["mTierWrap", "mDescWrap", "mHighWrap"].forEach(function (id) {
      el(id).style.display = kind === "color" ? "none" : "";
    });
    var prev = el("mPicPrev");
    prev.removeAttribute("src");
    setPic(prev, row);
    el("mlModal").classList.add("open");
  }
  function closeModal() { el("mlModal").classList.remove("open"); state.editing = null; }

  async function uploadPicked(file) {
    var msg = el("mPicMsg");
    if (file.size > 3 * 1024 * 1024) { msg.textContent = "That photo is over 3 MB — please resize it."; return; }
    msg.textContent = "Uploading…";
    var b64 = await new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result)); };
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    var r = await DCR.api("/api/portal?action=sales&part=image", {
      method: "POST", body: { name: file.name, dataBase64: b64 },
    });
    state.uploadedItemId = r.image.id;
    msg.textContent = "✓ Photo uploaded — will attach on Save.";
    el("mPicPrev").src = b64;
  }

  async function save() {
    var kind = state.editingKind, row = state.editing;
    var name = el("mName").value.trim();
    if (!name) { el("mMsg").textContent = "Name is required."; return; }
    var fields = {
      itemKind: kind, trade: "deck",
      itemName: name,
      brandName: el("mBrand").value.trim(),
      itemStatus: el("mStatus").value,
      selectable: el("mSelectable").value === "true",
      warrantySummary: el("mWarranty").value.trim(),
      manufacturerUrl: el("mManUrl").value.trim(),
      pictureUrl: el("mPicUrl").value.trim(),
    };
    if (kind === "product") {
      fields.marketTier = el("mTier").value;
      fields.description = el("mDesc").value;
      fields.salesHighlights = el("mHigh").value;
      fields.materialId = row ? row.materialId
        : name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!row) fields.itemId = fields.materialId;
    } else {
      fields.materialId = state.parentMaterialId;
      if (!row) fields.itemId = state.parentMaterialId + "-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    }
    if (state.uploadedItemId) {
      fields.pictureItemId = state.uploadedItemId;
      if (!fields.pictureUrl) fields.pictureUrl = "";
    }
    el("mSave").disabled = true;
    el("mMsg").textContent = "Saving…";
    try {
      await DCR.api("/api/portal?action=sales&part=materials", {
        method: "POST",
        body: row ? { id: row.id, fields: fields } : { fields: fields },
      });
      closeModal();
      await load();
    } catch (e) { el("mMsg").textContent = e.message || "Save failed."; }
    el("mSave").disabled = false;
  }

  async function remove() {
    var row = state.editing;
    if (!row) return;
    var isProduct = state.editingKind === "product";
    var warn = isProduct
      ? "Delete this material AND leave its colors orphaned? Colors should be deleted first. Continue?"
      : "Delete this color?";
    if (!confirm(warn)) return;
    try {
      await DCR.api("/api/portal?action=sales&part=materials", { method: "DELETE", body: { id: row.id } });
      closeModal();
      await load();
    } catch (e) { el("mMsg").textContent = e.message || "Delete failed."; }
  }

  async function load() {
    try {
      var d = await DCR.api("/api/portal?action=sales&part=materials&trade=deck");
      state.rows = d.materials || [];
      render();
    } catch (e) {
      el("mlGrid").innerHTML = '<div class="ml-empty" style="grid-column:1/-1">' + esc(e.message || "Could not load the library.") + "</div>";
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };
    el("mlSearch").oninput = render;
    el("mlAdd").onclick = function () { state.parentMaterialId = null; openModal(null, "product"); };
    el("mCancel").onclick = closeModal;
    el("mlModal").onclick = function (e) { if (e.target === el("mlModal")) closeModal(); };
    el("mSave").onclick = save;
    el("mDelete").onclick = remove;
    el("mPicFile").onchange = function () {
      if (this.files && this.files[0]) uploadPicked(this.files[0]).catch(function (e) {
        el("mPicMsg").textContent = e.message || "Upload failed.";
      });
    };
    el("mPicUrl").oninput = function () {
      if (this.value.trim()) { el("mPicPrev").src = this.value.trim(); state.uploadedItemId = null; el("mPicMsg").textContent = ""; }
    };
    await load();
  });
})();
