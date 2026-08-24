/* Opens the Construction Modeling Engine over the estimate.

   Deliberately the same shape as DCRCad.open({entry, title, getPathParts,
   onNumbers, onSave}), so the estimate page swaps one for the other instead of
   being rewritten around a new idea.

   An overlay iframe rather than a navigation: the estimate holds unsaved form
   state, and sending a rep away from it to draw and then back would either
   lose that or need a whole save-and-restore dance. */
(function () {
  var DCR = window.DCR || {};
  var HANDOFF_PREFIX = "cmeHandoff:";

  function el(id) { return document.getElementById(id); }

  function ensureShell() {
    var shell = el("cmeShell");
    if (shell) return shell;
    shell = document.createElement("div");
    shell.id = "cmeShell";
    shell.innerHTML =
      '<div class="cme-backdrop"></div>' +
      '<div class="cme-frame-wrap">' +
        '<div class="cme-bar">' +
          '<span class="cme-title" id="cmeTitle"></span>' +
          '<span class="cme-hint">Save from inside the drawing to bring the numbers back.</span>' +
          '<button type="button" class="cme-close" id="cmeClose">✕ Close</button>' +
        "</div>" +
        '<iframe id="cmeFrame" title="Drawing" allow="fullscreen"></iframe>' +
      "</div>";
    document.body.appendChild(shell);

    var style = document.createElement("style");
    style.textContent =
      "#cmeShell{position:fixed;inset:0;z-index:4000;display:none;}" +
      "#cmeShell.open{display:block;}" +
      "#cmeShell .cme-backdrop{position:absolute;inset:0;background:rgba(5,8,10,.72);}" +
      "#cmeShell .cme-frame-wrap{position:absolute;inset:0;display:flex;flex-direction:column;}" +
      "#cmeShell .cme-bar{display:flex;align-items:center;gap:12px;padding:8px 12px;" +
        "background:#0d1114;color:#e6edf3;border-bottom:1px solid #223038;font:600 13px system-ui,Segoe UI,Arial;}" +
      "#cmeShell .cme-title{font-weight:800;}" +
      "#cmeShell .cme-hint{font-weight:400;color:#8aa0ad;margin-left:auto;}" +
      "@media (max-width:700px){#cmeShell .cme-hint{display:none;}}" +
      "#cmeShell .cme-close{background:#1b2733;color:#e6edf3;border:1px solid #33454f;border-radius:8px;" +
        "padding:6px 12px;font-weight:700;cursor:pointer;}" +
      "#cmeShell .cme-close:hover{background:#243544;}" +
      "#cmeShell iframe{flex:1;width:100%;border:0;background:#0d1114;}";
    document.head.appendChild(style);
    return shell;
  }

  var active = null;

  function close() {
    var shell = el("cmeShell");
    if (shell) {
      shell.classList.remove("open");
      el("cmeFrame").src = "about:blank";
    }
    document.body.style.overflow = "";
    if (active && active._handoffKey) {
      try { sessionStorage.removeItem(active._handoffKey); } catch (e) {}
    }
    active = null;
  }

  /* One listener for the lifetime of the page. Origin is checked because a
     message handler on the estimate page is reachable by any frame. */
  window.addEventListener("message", async function (event) {
    if (event.origin !== location.origin) return;
    var data = event.data || {};
    if (data.type !== "dcr.cme.save" || !active) return;

    var payload = data.payload || {};
    var handlers = active;
    try {
      /* One drawing, one file. Naming the PNG after the project id means a
         re-save replaces it rather than stranding the previous render, and it
         keeps the image and its saved model addressable as a pair. */
      var projectId = payload.project && payload.project.id;
      var stable = Boolean(projectId) && /^[0-9a-zA-Z-]{8,64}$/.test(String(projectId));
      var name = stable ? "cme-" + projectId + ".png" : "drawing-" + Date.now() + ".png";

      var up = await DCR.api("/api/portal?action=sales&part=image", {
        method: "POST",
        body: {
          name: name,
          stableName: stable,
          dataBase64: payload.png,
          pathParts: handlers.getPathParts ? handlers.getPathParts() : [],
        },
      });

      /* Written to `cme`, never to `cad`.

         `cad` holds drawings made by the tool this replaces, in a format this
         one cannot read. Overwriting it would leave those drawings unopenable
         by EITHER tool — the single most destructive thing available here — so
         the assertion below is deliberate rather than defensive. */
      var patch = {
        id: up.image.id,
        url: "",
        name: up.image.name,
        cme: {
          version: 1,
          project: payload.project,
          numbers: payload.numbers,
          takeoff: payload.takeoff,
          breakdown: payload.breakdown,
          savedAt: new Date().toISOString(),
        },
      };
      if ("cad" in patch) throw new Error("refusing to overwrite a legacy drawing");

      if (payload.removedRecordings) {
        console.warn("[CME] " + payload.removedRecordings + " voice recording(s) were not saved with the drawing.");
      }
      /* Numbers land only AFTER the upload succeeded - applying them first put
         quantities on the estimate for a drawing whose save then failed. */
      if (payload.numbers && handlers.onNumbers) handlers.onNumbers(payload.numbers);
      if (handlers.onSave) handlers.onSave(patch);
      /* Close only the session this save belongs to. A slow save finishing
         after the user closed and opened a SECOND drawing used to tear the
         second session down mid-edit. */
      if (active === handlers) close();
    } catch (error) {
      console.error("[CME] could not save the drawing", error);
      if (DCR.alert) {
        await DCR.alert(
          (error && error.message) || "The drawing could not be saved.",
          { title: "Not saved" }
        );
      }
    }
  });

  window.DCRCme = {
    open: function (options) {
      options = options || {};
      var shell = ensureShell();
      active = options;

      var entry = options.entry;
      var params = new URLSearchParams();
      if (options.estimateId) params.set("estimateId", options.estimateId);
      if (options.fresh) params.set("cmeFresh", "1");
      if (options.clientName) params.set("clientName", options.clientName);
      if (entry && entry.id) params.set("entryId", String(entry.id));

      /* An existing drawing travels through sessionStorage. It is same-origin,
         survives the iframe load, has no length limit, and is read once and
         deleted — none of which is true of a URL or a race-prone message. */
      if (entry && entry.cme && entry.cme.project) {
        var key = HANDOFF_PREFIX + Date.now();
        try {
          /* Sweep strays first: a key left by an open-then-close (the iframe
             never consumed it) would sit forever, and stale handoffs quietly
             beat fresher saved copies on later opens. */
          for (var i = sessionStorage.length - 1; i >= 0; i--) {
            var k = sessionStorage.key(i);
            if (k && k.indexOf(HANDOFF_PREFIX) === 0) sessionStorage.removeItem(k);
          }
          sessionStorage.setItem(key, JSON.stringify(entry.cme.project));
          params.set("cmeHandoff", key);
          options._handoffKey = key;
        } catch (e) {
          console.warn("[CME] could not hand over the existing drawing", e);
        }
      }

      el("cmeTitle").textContent = options.title || "Drawing";
      el("cmeFrame").src = "cme.html?" + params.toString();
      shell.classList.add("open");
      document.body.style.overflow = "hidden";

      el("cmeClose").onclick = async function () {
        var leave = DCR.confirm
          ? await DCR.confirm(
              "Anything you have not saved to the estimate stays in the drawing on this device, " +
              "but it will not reach the estimate until you save.",
              { title: "Close the drawing?", okText: "Close" })
          : true;
        if (leave) close();
      };
    },
    close: close,
  };
})();
