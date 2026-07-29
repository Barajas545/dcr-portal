/* DCR portal — Materials Library.
   SalesMaterials list organized Division → Category → Sub-category → name.
   Every item (product or color) carries a picture GALLERY (PicturesJson):
   entries are {id} (uploaded to SharePoint, organized under
   SalesMaterialImages/<Division>/<Category>/<SubCat>/<Item>/) or {url}
   (external link). First entry = cover (shown on cards + in the estimate
   wizard). Intake: multi-file upload, camera, URL, clipboard paste
   (screenshots), drag & drop — oversized photos are downscaled client-side. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  var CSI_DIVISIONS = [
    "01 - General Requirements", "02 - Existing Conditions", "03 - Concrete",
    "04 - Masonry", "05 - Metals", "06 - Wood, Plastics & Composites",
    "07 - Thermal & Moisture Protection", "08 - Openings", "09 - Finishes",
    "10 - Specialties", "11 - Equipment", "12 - Furnishings",
    "13 - Special Construction", "14 - Conveying Equipment", "22 - Plumbing",
    "23 - HVAC", "26 - Electrical", "27 - Communications",
    "28 - Electronic Safety & Security", "31 - Earthwork",
    "32 - Exterior Improvements", "33 - Utilities",
  ];

  var state = {
    rows: [], editing: null, editingKind: "product", parentMaterialId: null,
    galleryHandle: null,   // shared DCRGallery widget (gallery.js)
  };
  var galleryOf = DCRGallery.parse;
  var picSrcInto = DCRGallery.srcInto;

  function products() { return state.rows.filter(function (r) { return r.itemKind === "product"; }); }
  function colorsOf(materialId) {
    return state.rows.filter(function (r) { return r.itemKind === "color" && r.materialId === materialId; });
  }

  /* ══ grouped catalog view ══ */
  function render() {
    var q = (el("mlSearch").value || "").trim().toLowerCase();
    var list = products().filter(function (p) {
      if (!q) return true;
      var hay = [p.itemName, p.brandName, p.description, p.marketTier, p.division, p.category, p.subCategory]
        .concat(colorsOf(p.materialId).map(function (c) { return c.itemName; })).join(" ").toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    if (!list.length) {
      el("mlGroups").innerHTML = '<div class="ml-empty">' +
        (state.rows.length ? "Nothing matches your search." : "No materials yet — add your first one.") + "</div>";
      return;
    }

    // Division → Category → SubCategory (alphabetical at each level, names within)
    var tree = {};
    list.forEach(function (p) {
      var d = p.division || "Unassigned division";
      var c = p.category || "Uncategorized";
      var s = p.subCategory || "General";
      ((tree[d] = tree[d] || {})[c] = tree[d][c] || {})[s] = (tree[d][c][s] || []).concat([p]);
    });

    var html = "";
    Object.keys(tree).sort().forEach(function (d) {
      html += '<div class="ml-div">' + esc(d) + "</div>";
      Object.keys(tree[d]).sort().forEach(function (c) {
        html += '<div class="ml-cat">' + esc(c) + "</div>";
        Object.keys(tree[d][c]).sort().forEach(function (s) {
          html += '<div class="ml-subcat">' + esc(s) + "</div>" + '<div class="ml-grid">';
          tree[d][c][s]
            .sort(function (a, b) { return String(a.itemName).localeCompare(b.itemName); })
            .forEach(function (p) { html += productCard(p); });
          html += "</div>";
        });
      });
    });
    el("mlGroups").innerHTML = html;
    hydrateCards();
    wireCards();
  }

  function productCard(p) {
    var cols = colorsOf(p.materialId);
    var g = galleryOf(p);
    return '<div class="ml-card">' +
      '<div class="ml-pic" data-edit="' + esc(p.id) + '">' +
      '<img style="display:none" data-picfor="' + esc(p.id) + '" alt=""><span class="ph">🪵</span>' +
      (p.marketTier ? '<span class="tier">' + esc(p.marketTier) + "</span>" : "") +
      (p.itemStatus !== "active" ? '<span class="stat">' + esc(String(p.itemStatus || "").replace(/_/g, " ")) + "</span>" : "") +
      (g.length > 1 ? '<span class="pcount">📷 ' + g.length + "</span>" : "") +
      "</div>" +
      '<div class="ml-body">' +
      '<div class="ml-name">' + esc(p.itemName) + "</div>" +
      '<div class="ml-desc">' + esc(p.description || "") + "</div>" +
      '<div style="font-size:11px;color:var(--text-muted)">' +
      [p.brandName, p.warrantySummary, (p.selectable === false ? "not offered" : "offered in estimates")].filter(Boolean).map(esc).join(" · ") + "</div>" +
      '<div class="ml-colors">' +
      cols.map(function (cc) {
        return '<span class="ml-swatch" title="' + esc(cc.itemName) + '" data-editcolor="' + esc(cc.id) + '">' +
          '<img style="display:none" data-picfor="' + esc(cc.id) + '" alt=""><span class="cn">' + esc((cc.itemName || "").slice(0, 10)) + "</span></span>";
      }).join("") +
      '<span class="ml-swatch addc" title="Add color" data-addcolor="' + esc(p.materialId) + '">＋</span>' +
      "</div>" +
      '<div class="ml-actions"><button class="btn btn-ghost btn-sm" data-edit="' + esc(p.id) + '">✏️ Edit</button></div>' +
      "</div></div>";
  }

  function hydrateCards() {
    state.rows.forEach(function (r) {
      var g = galleryOf(r);
      if (!g.length) return;
      var img = el("mlGroups").querySelector('img[data-picfor="' + CSS.escape(r.id) + '"]');
      if (!img) return;
      img.onload = function () {
        img.style.display = "";
        var ph = img.parentElement.querySelector(".ph, .cn");
        if (ph) ph.style.display = "none";
      };
      picSrcInto(img, g[0]);
    });
  }

  function wireCards() {
    el("mlGroups").querySelectorAll("[data-edit]").forEach(function (n) {
      n.onclick = function () {
        var row = state.rows.find(function (r) { return r.id === n.dataset.edit; });
        if (row) openModal(row, "product");
      };
    });
    el("mlGroups").querySelectorAll("[data-editcolor]").forEach(function (n) {
      n.onclick = function (ev) {
        ev.stopPropagation();
        var row = state.rows.find(function (r) { return r.id === n.dataset.editcolor; });
        if (row) openModal(row, "color");
      };
    });
    el("mlGroups").querySelectorAll("[data-addcolor]").forEach(function (n) {
      n.onclick = function (ev) {
        ev.stopPropagation();
        state.parentMaterialId = n.dataset.addcolor;
        openModal(null, "color");
      };
    });
  }

  /* ══ editor modal ══ */
  function buildDatalists() {
    var divs = {}, cats = {}, subs = {};
    CSI_DIVISIONS.forEach(function (d) { divs[d] = 1; });
    state.rows.forEach(function (r) {
      if (r.division) divs[r.division] = 1;
      if (r.category) cats[r.category] = 1;
      if (r.subCategory) subs[r.subCategory] = 1;
    });
    function fill(id, obj) {
      el(id).innerHTML = Object.keys(obj).sort().map(function (v) { return '<option value="' + esc(v) + '">'; }).join("");
    }
    fill("dlDivisions", divs); fill("dlCategories", cats); fill("dlSubCats", subs);
  }

  function openModal(row, kind) {
    state.editing = row;
    state.editingKind = kind;
    if (row && kind === "color") state.parentMaterialId = row.materialId;
    var parent = kind === "color"
      ? products().find(function (p) { return p.materialId === state.parentMaterialId; })
      : null;
    el("mTitle").textContent = kind === "color"
      ? (row ? "Edit color — " + row.itemName : "Add color" + (parent ? " — " + parent.itemName : ""))
      : (row ? "Edit material" : "Add material");
    el("mName").value = row ? row.itemName || "" : "";
    el("mDivision").value = row ? row.division || "" : (parent ? parent.division || "" : "06 - Wood, Plastics & Composites");
    el("mCategory").value = row ? row.category || "" : (parent ? parent.category || "" : "");
    el("mSubCat").value = row ? row.subCategory || "" : (parent ? parent.subCategory || "" : "");
    el("mBrand").value = row ? row.brandName || "" : (parent ? parent.brandName || "" : "");
    el("mTier").value = row && row.marketTier ? row.marketTier : "Mid";
    el("mStatus").value = row && row.itemStatus ? row.itemStatus : "active";
    el("mSelectable").value = row && row.selectable === false ? "false" : "true";
    el("mDesc").value = row ? row.description || "" : "";
    el("mHigh").value = row ? row.salesHighlights || "" : "";
    el("mWarranty").value = row ? row.warrantySummary || "" : "";
    el("mManUrl").value = row ? row.manufacturerUrl || "" : "";
    el("mMsg").textContent = "";
    el("mDelete").style.display = row ? "" : "none";
    ["mTierWrap", "mDescWrap", "mHighWrap", "mWarrWrap"].forEach(function (id) {
      el(id).style.display = kind === "color" ? "none" : "";
    });
    if (state.galleryHandle) state.galleryHandle.destroy();
    state.galleryHandle = DCRGallery.mount(el("mGallery"), {
      initial: galleryOf(row),
      getPathParts: currentPathParts,
    });
    el("mlModal").classList.add("open");
  }
  function closeModal() {
    el("mlModal").classList.remove("open");
    if (state.galleryHandle) { state.galleryHandle.destroy(); state.galleryHandle = null; }
    state.editing = null;
  }

  // Where uploads for the item being edited get organized in SharePoint.
  function currentPathParts() {
    return [el("mDivision").value, el("mCategory").value, el("mSubCat").value, el("mName").value || "Unnamed"];
  }

  /* ══ save / delete / load ══ */
  async function save() {
    var kind = state.editingKind, row = state.editing;
    var name = el("mName").value.trim();
    if (!name) { el("mMsg").textContent = "Name is required."; return; }
    if (state.galleryHandle && state.galleryHandle.uploading()) {
      el("mMsg").textContent = "Still uploading photos — one moment…";
      return;
    }
    var gallery = state.galleryHandle ? state.galleryHandle.get() : [];
    var cover = gallery[0] || null;
    var fields = {
      itemKind: kind, trade: "deck",
      itemName: name,
      division: el("mDivision").value.trim(),
      category: el("mCategory").value.trim(),
      subCategory: el("mSubCat").value.trim(),
      brandName: el("mBrand").value.trim(),
      itemStatus: el("mStatus").value,
      selectable: el("mSelectable").value === "true",
      warrantySummary: el("mWarranty").value.trim(),
      manufacturerUrl: el("mManUrl").value.trim(),
      picturesJson: JSON.stringify(gallery),
      pictureItemId: cover && cover.id ? cover.id : "",
      pictureUrl: cover && !cover.id && cover.url ? cover.url : "",
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
    var warn = state.editingKind === "product"
      ? "Delete this material? Its colors will remain and should be deleted too. Continue?"
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
      var d = await DCR.api("/api/portal?action=sales&part=materials");
      state.rows = d.materials || [];
      buildDatalists();
      render();
    } catch (e) {
      el("mlGroups").innerHTML = '<div class="ml-empty">' + esc(e.message || "Could not load the library.") + "</div>";
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
    // gallery intake (upload/camera/URL/paste/drag&drop) is handled by the
    // shared DCRGallery widget mounted in openModal().
    await load();
  });
})();
