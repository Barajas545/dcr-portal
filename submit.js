/* The public subcontractor form.

   Standalone on purpose: no common.js, no DCR.api, no token, nothing that
   assumes a portal session — the people using this page do not have one. It
   talks to exactly one endpoint, action=subform, and that endpoint refuses
   anything it does not recognise.

   The server validates all of this again. Everything here is to save the sub a
   round trip, never to decide anything. */
(function () {
  "use strict";
  var CFG = window.DCR_CONFIG || {};
  var API = String(CFG.API_BASE || "").replace(/\/$/, "");
  var el = function (id) { return document.getElementById(id); };
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var state = { kind: "Invoice", project: null, file: null, signed: false };

  // ── which kind ──────────────────────────────────────────────────────────
  function setKind(kind) {
    state.kind = kind;
    var inv = kind === "Invoice";
    el("sfKindInv").setAttribute("aria-pressed", String(inv));
    el("sfKindCo").setAttribute("aria-pressed", String(!inv));
    // The same fields mean different things for the two, so they are relabelled
    // rather than hidden — a change order still has a number and a date.
    el("sfMoneyHead").textContent = inv ? "The invoice" : "The change order";
    el("sfNumberLabel").innerHTML = inv
      ? 'Your invoice # <span class="opt">(optional)</span>'
      : 'Your reference # <span class="opt">(optional)</span>';
    el("sfDateLabel").innerHTML = inv
      ? 'Invoice date <span class="opt">(optional)</span>'
      : 'Date of the change <span class="opt">(optional)</span>';
    el("sfDescLabel").textContent = inv
      ? "What is this for?"
      : "What is the extra work, and why is it needed?";
    el("sfDesc").placeholder = inv
      ? "Describe the work you are billing for"
      : "Describe the extra work and what it covers";
  }
  el("sfKindInv").onclick = function () { setKind("Invoice"); };
  el("sfKindCo").onclick = function () { setKind("Change order"); };

  // ── finding the job ─────────────────────────────────────────────────────
  var searchTimer = null, searchSeq = 0;
  el("sfSearch").addEventListener("input", function () {
    clearTimeout(searchTimer);
    var q = this.value.trim();
    if (q.length < 3) { el("sfHits").hidden = true; return; }
    // Typing is faster than the network; only the last query may draw.
    searchTimer = setTimeout(function () { runSearch(q, ++searchSeq); }, 220);
  });

  async function runSearch(q, seq) {
    var box = el("sfHits");
    try {
      var r = await fetch(API + "/api/portal?action=subform&part=projects&q=" + encodeURIComponent(q));
      var d = await r.json();
      if (seq !== searchSeq) return;
      var list = (d && d.projects) || [];
      if (!list.length) {
        box.innerHTML = '<div style="cursor:default;color:var(--text-muted)">' +
          "No open job matches that. Try the street address or the job number." + "</div>";
        box.hidden = false;
        return;
      }
      box.innerHTML = list.map(function (p, i) {
        return '<div tabindex="0" data-i="' + i + '"><b>' +
          esc([p.number, p.name].filter(Boolean).join(" — ")) + "</b><span>" +
          esc([p.address, p.city].filter(Boolean).join(", ")) + "</span></div>";
      }).join("") + (d.more
        ? '<div style="cursor:default;color:var(--text-muted)">and ' + d.more +
          " more — add another word to narrow it</div>"
        : "");
      box.hidden = false;
      box.querySelectorAll("[data-i]").forEach(function (row) {
        var pick = function () { choose(list[Number(row.getAttribute("data-i"))]); };
        row.onclick = pick;
        row.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
      });
    } catch (e) {
      if (seq !== searchSeq) return;
      box.innerHTML = '<div style="cursor:default;color:var(--err)">Could not search just now. Check your connection.</div>';
      box.hidden = false;
    }
  }

  function choose(p) {
    state.project = p;
    el("sfPickedText").textContent = [p.number, p.name].filter(Boolean).join(" — ") +
      (p.address ? " · " + p.address : "");
    el("sfPicked").hidden = false;
    el("sfHits").hidden = true;
    el("sfSearch").value = "";
  }
  el("sfClearPick").onclick = function () {
    state.project = null;
    el("sfPicked").hidden = true;
    el("sfSearch").focus();
  };

  // ── the paperwork ───────────────────────────────────────────────────────
  var MAX_DOC = 25 * 1024 * 1024;
  var OK_TYPES = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf"];
  el("sfScan").onclick = function () { el("sfCam").click(); };
  el("sfPick").onclick = function () { el("sfFile").click(); };
  ["sfCam", "sfFile"].forEach(function (id) {
    el(id).addEventListener("change", function () { takeFile(this.files && this.files[0]); });
  });
  el("sfDocClear").onclick = function () {
    state.file = null; el("sfDoc").hidden = true;
    el("sfCam").value = ""; el("sfFile").value = "";
  };

  function takeFile(f) {
    if (!f) return;
    var type = String(f.type || "").toLowerCase();
    // A phone sometimes reports no type for a HEIC; fall back to the extension
    // rather than refusing a photograph the person just took.
    if (!type && /\.(jpe?g|png|heic|heif|webp|pdf)$/i.test(f.name || "")) {
      var ext = (/\.([a-z0-9]+)$/i.exec(f.name) || [0, ""])[1].toLowerCase();
      type = ext === "jpg" ? "image/jpeg" : ext === "pdf" ? "application/pdf" : "image/" + ext;
    }
    if (OK_TYPES.indexOf(type) === -1) {
      return say("That file type cannot be accepted. Send a photo, a scan or a PDF.", "err");
    }
    if (f.size > MAX_DOC) {
      return say("That file is larger than 25 MB. A photo of the invoice is usually enough.", "err");
    }
    state.file = { blob: f, type: type, size: f.size, name: f.name || "document" };
    el("sfDocName").textContent = (f.name || "document") + " · " + Math.round(f.size / 1024) + " KB";
    el("sfDoc").hidden = false;
    say("");
  }

  // ── the signature ───────────────────────────────────────────────────────
  /* Drawn at a fixed internal resolution and scaled by CSS, so a signature made
     on a phone and one made on a laptop produce the same size of PNG. Pointer
     events cover mouse, pen and touch in one path; touch-action:none in the CSS
     is what stops the page scrolling out from under the finger. */
  var cv = el("sfSig"), ctx = cv.getContext("2d");
  var drawing = false, last = null;
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#12243a";

  function at(ev) {
    var r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (cv.width / r.width),
             y: (ev.clientY - r.top) * (cv.height / r.height) };
  }
  cv.addEventListener("pointerdown", function (ev) {
    ev.preventDefault();
    cv.setPointerCapture(ev.pointerId);
    drawing = true; last = at(ev);
    // a tap with no movement should still leave a mark
    ctx.beginPath(); ctx.arc(last.x, last.y, 1.6, 0, Math.PI * 2); ctx.fill();
    marked();
  });
  cv.addEventListener("pointermove", function (ev) {
    if (!drawing) return;
    ev.preventDefault();
    var p = at(ev);
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
    cv.addEventListener(t, function () { drawing = false; });
  });

  function marked() {
    if (state.signed) return;
    state.signed = true;
    el("sfSigHint").hidden = true;
    el("sfSigState").textContent = "Signed";
    el("sfSigWrap").classList.add("signed");
  }
  el("sfSigClear").onclick = function () {
    ctx.clearRect(0, 0, cv.width, cv.height);
    state.signed = false;
    el("sfSigHint").hidden = false;
    el("sfSigState").textContent = "Not signed";
    el("sfSigWrap").classList.remove("signed");
  };

  // ── submitting ──────────────────────────────────────────────────────────
  function say(text, cls) {
    var m = el("sfMsg");
    m.textContent = text || "";
    m.className = "sf-msg" + (cls ? " " + cls : "");
  }

  el("sfForm").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    var go = el("sfGo");
    if (go.disabled) return;

    if (!state.project) return say("Search for the job this is about, and pick it from the list.", "err");
    if (!state.signed) return say("Sign in the box before submitting.", "err");
    if (!state.file) return say("Attach a photo, scan or PDF of the paperwork.", "err");

    var payload = {
      op: "submit",
      kind: state.kind,
      projectId: state.project.id,
      vendorCompany: el("sfCompany").value,
      contactName: el("sfContact").value,
      email: el("sfEmail").value,
      phone: el("sfPhone").value,
      invoiceNumber: el("sfNumber").value,
      amount: el("sfAmount").value,
      description: el("sfDesc").value,
      invoiceDate: el("sfDate").value,
      dueDate: el("sfDue").value,
      signatureName: el("sfSigName").value,
      signature: cv.toDataURL("image/png"),
      agree: el("sfAgree").checked,
      website: el("sfWebsite").value,       // the honeypot, always empty for a person
      document: { type: state.file.type, size: state.file.size },
    };

    go.disabled = true;
    say("Sending…", "busy");
    var out;
    try {
      var r = await fetch(API + "/api/portal?action=subform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      out = await r.json().catch(function () { return null; });
      if (!r.ok) throw new Error((out && out.error) || "That could not be submitted.");
    } catch (e) {
      go.disabled = false;
      return say(e.message || "That could not be submitted.", "err");
    }

    /* The row exists now. The document is a second step because a photograph is
       routinely bigger than a serverless request body is allowed to be, so it
       goes straight to storage on a URL the server just minted for this one
       file. If it fails the submission still stands — it simply shows as
       missing its paperwork, which is a thing somebody can chase. */
    var attached = false;
    if (out && out.upload && out.upload.url) {
      say("Uploading the document…", "busy");
      try {
        var put = await fetch(out.upload.url, {
          method: "PUT",
          headers: { "Content-Range": "bytes 0-" + (state.file.size - 1) + "/" + state.file.size },
          body: state.file.blob,
        });
        var saved = await put.json().catch(function () { return null; });
        if (saved && saved.id) {
          await fetch(API + "/api/portal?action=subform", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "attached", reference: out.reference,
                                   itemId: out.id, documentItemId: String(saved.id) }),
          });
          attached = true;
        }
      } catch (e) { attached = false; }
    }
    done(out.reference, attached);
  });

  function done(reference, attached) {
    el("sfForm").hidden = true;
    var d = el("sfDone");
    d.className = "sf-card sf-done";
    d.innerHTML =
      '<div class="tick">✓</div>' +
      "<h2>Received</h2>" +
      '<p style="color:var(--text-muted);font-size:14px;margin:0">' +
      "Keep this reference. Quote it if you call about this " +
      esc(state.kind.toLowerCase()) + ".</p>" +
      '<div class="sf-ref">' + esc(reference) + "</div>" +
      (attached
        ? '<p style="font-size:13.5px;color:var(--text-muted);margin:0">' +
          "Your document was received. Somebody at DCR will review this and be in touch." +
          "</p>"
        : '<p style="font-size:13.5px;color:var(--gold);font-weight:600;margin:0">' +
          "We could not receive your document. Your submission was saved — please email it " +
          "quoting the reference above, or it cannot be approved for payment.</p>") +
      '<p style="margin-top:18px"><a href="submit.html">Send another</a></p>';
    d.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── branding, from the same config the portal uses ───────────────────────
  var info = CFG.COMPANY || {};
  var logo = el("sfLogo");
  if (info.logo) logo.src = info.logo; else logo.hidden = true;
  el("sfFoot").textContent = [info.legalName || info.name || "", info.phone || "", info.license || ""]
    .filter(Boolean).join(" · ");
  document.title = "Submit an invoice or change order — " + (info.name || "DCR Framing");
  setKind("Invoice");
})();
