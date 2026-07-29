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
  var MAX_BYTES = 3 * 1024 * 1024;

  var state = {
    rows: [], editing: null, editingKind: "product", parentMaterialId: null,
    gallery: [],           // [{id?, url?, name}] — index 0 is the cover
    busyUploads: 0,
  };

  function products() { return state.rows.filter(function (r) { return r.itemKind === "product"; }); }
  function colorsOf(materialId) {
    return state.rows.filter(function (r) { return r.itemKind === "color" && r.materialId === materialId; });
  }
  function galleryOf(row) {
    if (row && row.picturesJson) {
      try {
        var g = JSON.parse(row.picturesJson);
        if (Array.isArray(g) && g.length) return g;
      } catch (e) {}
    }
    if (row && row.pictureItemId) return [{ id: row.pictureItemId, name: "photo" }];
    if (row && row.pictureUrl) return [{ url: row.pictureUrl, name: "photo" }];
    return [];
  }
  function picSrcInto(img, entry) {
    if (!entry) return;
    if (entry.id) {
      DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(entry.id))
        .then(function (u) { img.src = u; })
        .catch(function () { if (entry.url) img.src = entry.url; });
    } else if (entry.url) img.src = entry.url;
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
    state.gallery = galleryOf(row).slice();
    renderGallery();
    el("gUrlRow").classList.remove("open");
    el("mlModal").classList.add("open");
  }
  function closeModal() { el("mlModal").classList.remove("open"); state.editing = null; }

  /* ══ picture gallery ══ */
  function renderGallery() {
    var g = state.gallery;
    var html = g.map(function (p, i) {
      return '<div class="g-tile' + (i === 0 ? " cover" : "") + '">' +
        '<img style="display:none" data-gidx="' + i + '" alt="">' +
        (i === 0 ? '<span class="cover-tag">COVER</span>'
                 : '<button type="button" class="star" data-star="' + i + '" title="Make cover">★</button>') +
        '<button type="button" class="x" data-del="' + i + '" title="Remove">✕</button>' +
        "</div>";
    }).join("");
    html += '<div class="g-tile g-add">' +
      '<button type="button" id="gaFiles">📁 Upload</button>' +
      '<button type="button" id="gaCam">📷 Camera</button>' +
      '<button type="button" id="gaUrl">🔗 URL</button>' +
      '<button type="button" id="gaPaste">📋 Paste</button>' +
      "</div>";
    el("gGrid").innerHTML = html;

    g.forEach(function (p, i) {
      var img = el("gGrid").querySelector('img[data-gidx="' + i + '"]');
      if (!img) return;
      img.onload = function () { img.style.display = ""; };
      picSrcInto(img, p);
    });
    el("gGrid").querySelectorAll("[data-del]").forEach(function (b) {
      b.onclick = function () { state.gallery.splice(Number(b.dataset.del), 1); renderGallery(); };
    });
    el("gGrid").querySelectorAll("[data-star]").forEach(function (b) {
      b.onclick = function () {
        var i = Number(b.dataset.star);
        var it = state.gallery.splice(i, 1)[0];
        state.gallery.unshift(it);
        renderGallery();
      };
    });
    el("gaFiles").onclick = function () { el("gFile").click(); };
    el("gaCam").onclick = function () { el("gCam").click(); };
    el("gaUrl").onclick = function () {
      el("gUrlRow").classList.toggle("open");
      if (el("gUrlRow").classList.contains("open")) el("gUrlInput").focus();
    };
    el("gaPaste").onclick = pasteFromClipboard;
  }

  function setHint(t, isErr) {
    var h = el("gHint");
    h.style.color = isErr ? "var(--err)" : "var(--text-muted)";
    h.textContent = t || "📥 Drag & drop images here · paste a screenshot with Ctrl+V · big photos are resized automatically";
  }

  // Downscale/compress anything big into a ≤3MB JPEG (keeps camera photos usable).
  function normalizeImage(file) {
    return new Promise(function (resolve, reject) {
      if (file.size <= MAX_BYTES && file.type !== "image/heic") {
        var fr = new FileReader();
        fr.onload = function () { resolve({ dataUrl: String(fr.result), name: file.name }); };
        fr.onerror = reject;
        fr.readAsDataURL(file);
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var maxDim = 1600;
        var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        var cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        var q = 0.85, dataUrl = cv.toDataURL("image/jpeg", q);
        while (dataUrl.length * 0.75 > MAX_BYTES && q > 0.4) {
          q -= 0.1;
          dataUrl = cv.toDataURL("image/jpeg", q);
        }
        resolve({ dataUrl: dataUrl, name: file.name.replace(/\.[^.]+$/, "") + ".jpg" });
      };
      img.onerror = function () { reject(new Error("Could not read that image.")); };
      img.src = url;
    });
  }

  function currentPathParts() {
    return [el("mDivision").value, el("mCategory").value, el("mSubCat").value, el("mName").value || "Unnamed"];
  }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name); });
    if (!files.length) { setHint("No image files found.", true); return; }
    for (var i = 0; i < files.length; i++) {
      state.busyUploads++;
      setHint("Uploading " + (i + 1) + " of " + files.length + "…");
      try {
        var norm = await normalizeImage(files[i]);
        var r = await DCR.api("/api/portal?action=sales&part=image", {
          method: "POST",
          body: { name: norm.name || "photo.jpg", dataBase64: norm.dataUrl, pathParts: currentPathParts() },
        });
        state.gallery.push({ id: r.image.id, name: r.image.name });
        renderGallery();
      } catch (e) {
        setHint((e && e.message) || "Upload failed.", true);
        state.busyUploads--;
        return;
      }
      state.busyUploads--;
    }
    setHint("✓ " + files.length + " photo" + (files.length > 1 ? "s" : "") + " added.");
  }

  async function pasteFromClipboard() {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        var items = await navigator.clipboard.read();
        for (var it of items) {
          var type = it.types.find(function (t) { return t.indexOf("image/") === 0; });
          if (type) {
            var blob = await it.getType(type);
            await addFiles([new File([blob], "screenshot.png", { type: type })]);
            return;
          }
        }
      }
      setHint("Nothing on the clipboard — copy a screenshot, then press Ctrl+V here.", true);
    } catch (e) {
      setHint("Press Ctrl+V inside this window to paste your screenshot.", false);
    }
  }

  /* ══ save / delete / load ══ */
  async function save() {
    var kind = state.editingKind, row = state.editing;
    var name = el("mName").value.trim();
    if (!name) { el("mMsg").textContent = "Name is required."; return; }
    if (state.busyUploads > 0) { el("mMsg").textContent = "Still uploading photos — one moment…"; return; }
    var cover = state.gallery[0] || null;
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
      picturesJson: JSON.stringify(state.gallery),
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
    el("gFile").onchange = function () { if (this.files.length) { addFiles(this.files); this.value = ""; } };
    el("gCam").onchange = function () { if (this.files.length) { addFiles(this.files); this.value = ""; } };
    el("gUrlAdd").onclick = function () {
      var u = el("gUrlInput").value.trim();
      if (!u) return;
      if (!/^https:\/\//i.test(u)) { setHint("Picture links must start with https://", true); return; }
      state.gallery.push({ url: u, name: "link" });
      el("gUrlInput").value = "";
      el("gUrlRow").classList.remove("open");
      renderGallery();
      setHint("✓ Link added.");
    };
    el("gUrlInput").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); el("gUrlAdd").click(); } });

    // paste a screenshot anywhere in the open modal
    document.addEventListener("paste", function (e) {
      if (!el("mlModal").classList.contains("open")) return;
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          addFiles([items[i].getAsFile()]);
          return;
        }
      }
    });
    // drag & drop onto the gallery
    var gw = el("gWrap");
    ["dragenter", "dragover"].forEach(function (ev) {
      gw.addEventListener(ev, function (e) { e.preventDefault(); gw.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      gw.addEventListener(ev, function (e) { e.preventDefault(); gw.classList.remove("drag"); });
    });
    gw.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    await load();
  });
})();
