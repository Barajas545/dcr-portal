/* DCR portal — shared picture-gallery widget.
   One engine for every screen that manages item photos (Materials Library,
   Reference Projects, …). Entries are {id?, url?, name} — id = uploaded to
   SharePoint via action=sales&part=image (organized by pathParts), url = an
   external https image. Index 0 is the COVER.

   API:
     DCRGallery.parse(row)            -> entries[] (PicturesJson w/ legacy fallback)
     DCRGallery.srcInto(imgEl, entry) -> loads an <img> (authed blob or direct URL)
     DCRGallery.mount(container, { initial, getPathParts }) -> handle
       handle.get()       -> current entries (cover first)
       handle.uploading() -> true while uploads are in flight
       handle.destroy()   -> unmount + remove listeners
   Intake: multi-file upload, camera capture, URL, clipboard paste (button or
   Ctrl+V), drag & drop. Photos over 3 MB are downscaled client-side. */
(function () {
  var MAX_BYTES = 3 * 1024 * 1024;

  function injectStyles() {
    if (document.getElementById("dcrGalleryCss")) return;
    var css = document.createElement("style");
    css.id = "dcrGalleryCss";
    css.textContent =
      ".dg-wrap{border:2px dashed var(--border,#ccc);border-radius:12px;padding:12px;transition:border-color .12s,background .12s}" +
      ".dg-wrap.drag{border-color:var(--accent,#1f6fc8);background:rgba(47,128,216,.12)}" +
      ".dg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}" +
      ".dg-tile{position:relative;border:1px solid var(--border,#ccc);border-radius:10px;overflow:hidden;aspect-ratio:1;background:var(--surface-2,#eee);display:flex;align-items:center;justify-content:center}" +
      ".dg-tile img{width:100%;height:100%;object-fit:cover}" +
      ".dg-tile .dg-x{position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:#fff;font-size:12px;cursor:pointer;line-height:1}" +
      ".dg-tile .dg-star{position:absolute;top:4px;left:4px;width:22px;height:22px;border-radius:50%;border:none;background:rgba(0,0,0,.6);color:#ffd47f;font-size:12px;cursor:pointer;line-height:1}" +
      ".dg-tile.dg-cover{outline:3px solid #d6a13a;outline-offset:-3px}" +
      ".dg-cover-tag{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.6);color:#ffd47f;font-size:9.5px;font-weight:700;text-align:center;padding:2px 0;letter-spacing:.05em}" +
      ".dg-act{position:absolute;bottom:4px;right:4px;min-width:22px;height:22px;border-radius:11px;border:none;background:rgba(0,0,0,.65);color:#fff;font-size:11px;cursor:pointer;line-height:1;padding:0 6px}" +
      ".dg-act:hover{background:rgba(47,128,216,.9)}" +
      ".dg-add{display:flex;flex-direction:column;gap:5px;align-items:stretch;justify-content:center;padding:8px}" +
      ".dg-add button{font-size:11px;padding:5px 6px;border-radius:7px;border:1px solid var(--border,#ccc);background:var(--surface,#fff);color:var(--text,#111);cursor:pointer;white-space:nowrap}" +
      ".dg-add button:hover{border-color:var(--accent,#1f6fc8);color:var(--accent,#1f6fc8)}" +
      ".dg-hint{font-size:11px;color:var(--text-muted,#777);margin-top:8px}" +
      ".dg-urlrow{display:none;gap:8px;margin-top:8px}" +
      ".dg-urlrow.open{display:flex}" +
      ".dg-urlrow input{flex:1}";
    document.head.appendChild(css);
  }

  function parse(row) {
    if (row && row.picturesJson) {
      try {
        var g = JSON.parse(row.picturesJson);
        if (Array.isArray(g) && g.length) return g;
      } catch (e) {}
    }
    if (row && row.pictureItemId) return [{ id: row.pictureItemId, name: "photo" }];
    if (row && row.pictureUrl) return [{ url: row.pictureUrl, name: "photo" }];
    if (row && row.thumbnailUrl) return [{ url: row.thumbnailUrl, name: "photo" }];
    return [];
  }

  function srcInto(img, entry) {
    if (!entry) return;
    if (entry.id) {
      DCR.blobUrl("/api/portal?action=sales&part=image&id=" + encodeURIComponent(entry.id))
        .then(function (u) { img.src = u; })
        .catch(function () { if (entry.url) img.src = entry.url; });
    } else if (entry.url) img.src = entry.url;
  }

  // Downscale/compress anything big into a ≤3MB JPEG (keeps camera photos usable).
  function normalizeImage(file) {
    return new Promise(function (resolve, reject) {
      if (file.size <= MAX_BYTES) {
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

  function mount(container, opts) {
    injectStyles();
    var entries = (opts.initial || []).slice();
    var busy = 0;
    function changed() { if (opts.onChange) { try { opts.onChange(entries.slice()); } catch (e) {} } }

    container.innerHTML =
      '<div class="dg-wrap">' +
      '<div class="dg-grid"></div>' +
      '<div class="dg-urlrow"><input placeholder="https://…/photo.jpg" /><button type="button" class="btn btn-sm dg-urladd">Add</button></div>' +
      '<div class="dg-hint"></div>' +
      "</div>" +
      '<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple style="display:none" class="dg-file">' +
      '<input type="file" accept="image/*" capture="environment" style="display:none" class="dg-cam">';
    var wrap = container.querySelector(".dg-wrap");
    var grid = container.querySelector(".dg-grid");
    var urlRow = container.querySelector(".dg-urlrow");
    var urlInput = urlRow.querySelector("input");
    var hint = container.querySelector(".dg-hint");
    var fileInput = container.querySelector(".dg-file");
    var camInput = container.querySelector(".dg-cam");

    function setHint(t, isErr) {
      hint.style.color = isErr ? "var(--danger,#c8371f)" : "var(--text-muted,#777)";
      hint.textContent = t || "📥 Drag & drop images here · paste a screenshot with Ctrl+V · big photos are resized automatically";
    }

    function render() {
      var html = entries.map(function (p, i) {
        var act = "";
        if (opts.tileAction) {
          var label = opts.tileAction.badge ? opts.tileAction.badge(p) : "";
          act = '<button type="button" class="dg-act" data-act="' + i + '" title="' +
            (opts.tileAction.title || "") + '">' + (label || opts.tileAction.icon || "…") + "</button>";
        }
        return '<div class="dg-tile' + (i === 0 ? " dg-cover" : "") + '">' +
          '<img style="display:none" data-i="' + i + '" alt="">' +
          (i === 0 ? '<span class="dg-cover-tag">COVER</span>'
                   : '<button type="button" class="dg-star" data-star="' + i + '" title="Make cover">★</button>') +
          '<button type="button" class="dg-x" data-del="' + i + '" title="Remove">✕</button>' +
          act +
          "</div>";
      }).join("");
      html += '<div class="dg-tile dg-add">' +
        '<button type="button" class="dg-bfile">📁 Upload</button>' +
        '<button type="button" class="dg-bcam">📷 Camera</button>' +
        '<button type="button" class="dg-burl">🔗 URL</button>' +
        '<button type="button" class="dg-bpaste">📋 Paste</button>' +
        "</div>";
      grid.innerHTML = html;
      entries.forEach(function (p, i) {
        var img = grid.querySelector('img[data-i="' + i + '"]');
        if (!img) return;
        img.onload = function () { img.style.display = ""; };
        srcInto(img, p);
      });
      grid.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function () { entries.splice(Number(b.dataset.del), 1); render(); changed(); };
      });
      grid.querySelectorAll("[data-star]").forEach(function (b) {
        b.onclick = function () {
          var it = entries.splice(Number(b.dataset.star), 1)[0];
          entries.unshift(it);
          render();
          changed();
        };
      });
      grid.querySelectorAll("[data-act]").forEach(function (b) {
        b.onclick = function () {
          if (opts.tileAction && opts.tileAction.onClick) {
            opts.tileAction.onClick(entries[Number(b.dataset.act)], Number(b.dataset.act), render);
          }
        };
      });
      grid.querySelector(".dg-bfile").onclick = function () { fileInput.click(); };
      grid.querySelector(".dg-bcam").onclick = function () { camInput.click(); };
      grid.querySelector(".dg-burl").onclick = function () {
        urlRow.classList.toggle("open");
        if (urlRow.classList.contains("open")) urlInput.focus();
      };
      grid.querySelector(".dg-bpaste").onclick = pasteFromClipboard;
    }

    async function addFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
        return /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name);
      });
      if (!files.length) { setHint("No image files found.", true); return; }
      for (var i = 0; i < files.length; i++) {
        busy++;
        setHint("Uploading " + (i + 1) + " of " + files.length + "…");
        try {
          var norm = await normalizeImage(files[i]);
          var r = await DCR.api("/api/portal?action=sales&part=image", {
            method: "POST",
            body: { name: norm.name || "photo.jpg", dataBase64: norm.dataUrl, pathParts: opts.getPathParts ? opts.getPathParts() : [] },
          });
          entries.push({ id: r.image.id, name: r.image.name });
          render();
          changed();
        } catch (e) {
          setHint((e && e.message) || "Upload failed.", true);
          busy--;
          return;
        }
        busy--;
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

    function onPaste(e) {
      if (!container.isConnected || container.offsetParent === null) return;
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          e.preventDefault();
          addFiles([items[i].getAsFile()]);
          return;
        }
      }
    }
    document.addEventListener("paste", onPaste);

    fileInput.onchange = function () { if (this.files.length) { addFiles(this.files); this.value = ""; } };
    camInput.onchange = function () { if (this.files.length) { addFiles(this.files); this.value = ""; } };
    urlRow.querySelector(".dg-urladd").onclick = function () {
      var u = urlInput.value.trim();
      if (!u) return;
      if (!/^https:\/\//i.test(u)) { setHint("Picture links must start with https://", true); return; }
      entries.push({ url: u, name: "link" });
      urlInput.value = "";
      urlRow.classList.remove("open");
      render();
      changed();
      setHint("✓ Link added.");
    };
    urlInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); urlRow.querySelector(".dg-urladd").click(); }
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      wrap.addEventListener(ev, function (e) { e.preventDefault(); wrap.classList.add("drag"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      wrap.addEventListener(ev, function (e) { e.preventDefault(); wrap.classList.remove("drag"); });
    });
    wrap.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    render();
    setHint("");

    return {
      get: function () { return entries.slice(); },
      uploading: function () { return busy > 0; },
      destroy: function () {
        document.removeEventListener("paste", onPaste);
        container.innerHTML = "";
      },
    };
  }

  window.DCRGallery = { parse: parse, srcInto: srcInto, mount: mount };
})();
