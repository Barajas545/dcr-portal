/* Your settings — details, appearance, password.

   Three independent things on one page, each saving on its own. Deliberately
   not one big Save: changing your password and changing your phone number fail
   for different reasons, and a single button would make one failure look like
   the other. */
(function () {
  var el = function (id) { return document.getElementById(id); };
  var state = { profile: null };

  function say(node, text, cls) {
    node.textContent = text || "";
    node.className = "st-msg" + (cls ? " " + cls : "");
  }

  // ── your details ────────────────────────────────────────────────────────
  function fill(p) {
    state.profile = p;
    el("stName").value = p.displayName || "";
    el("stEmail").value = p.email || "";
    el("stRole").value = p.role || "";
    el("stPhone").value = p.phone || "";
    el("stAddress").value = p.address || "";
    el("stUnlinked").hidden = !!p.linked;
    el("stPhone").disabled = !p.linked;
    el("stAddress").disabled = !p.linked;
  }

  async function saveDetails() {
    var msg = el("stMsg"), btn = el("stSave");
    var p = state.profile || {};
    var body = {};
    /* Only what actually changed. Sending a field back unchanged is harmless but
       sending one that was never loaded is not — an unlinked account would ask
       the server to write a phone number it has nowhere to put. */
    if (el("stName").value.trim() !== (p.displayName || "")) body.displayName = el("stName").value;
    if (p.linked) {
      if (el("stPhone").value.trim() !== (p.phone || "")) body.phone = el("stPhone").value;
      if (el("stAddress").value.trim() !== (p.address || "")) body.address = el("stAddress").value;
    }
    if (!Object.keys(body).length) return say(msg, "Nothing has changed.", "");

    btn.disabled = true;
    say(msg, "Saving…", "");
    try {
      var r = await DCR.api("/api/portal?action=profile", { method: "POST", body: body });
      fill(r.profile);
      say(msg, "Saved.", "ok");
      var note = el("stNameNote");
      note.hidden = !r.nameNote;
      note.textContent = r.nameNote || "";
      var pill = el("userPill");
      if (pill && r.profile) pill.textContent = (r.profile.displayName || r.profile.email) + " · " + r.profile.role;
    } catch (e) {
      say(msg, e.message || "Could not save that.", "err");
    }
    btn.disabled = false;
  }

  // ── appearance ──────────────────────────────────────────────────────────
  function paintTheme() {
    var now = DCR.theme.get();
    document.querySelectorAll("#stTheme button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-theme") === now ? "true" : "false");
    });
  }

  // ── password ────────────────────────────────────────────────────────────
  async function savePassword() {
    var msg = el("stPwMsg"), btn = el("stPwSave");
    var cur = el("stCur").value, a = el("stNew").value, b = el("stNew2").value;

    /* Caught here so a typo does not cost a round trip. The server checks all of
       it again regardless — this is convenience, not the rule. */
    var bad = !cur ? "Enter your current password."
      : a.length < 8 ? "The new password must be at least 8 characters."
      : a !== b ? "The two new passwords don't match."
      : a === cur ? "That's already your password — pick a different one."
      : "";
    if (bad) return say(msg, bad, "err");

    btn.disabled = true;
    say(msg, "Changing…", "");
    try {
      await DCR.api("/api/portal?action=password", {
        method: "POST", body: { currentPassword: cur, newPassword: a },
      });
      el("stCur").value = el("stNew").value = el("stNew2").value = "";
      say(msg, "Changed. Use it next time you sign in.", "ok");
    } catch (e) {
      say(msg, e.message || "Could not change your password.", "err");
    }
    btn.disabled = false;
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function () { DCR.logout(); };

    document.querySelectorAll("#stTheme button").forEach(function (b) {
      b.onclick = function () { DCR.theme.set(b.getAttribute("data-theme")); paintTheme(); };
    });
    paintTheme();

    el("stSave").onclick = saveDetails;
    el("stPwSave").onclick = savePassword;

    try {
      var r = await DCR.api("/api/portal?action=profile");
      fill(r.profile);
    } catch (e) {
      say(el("stMsg"), e.message || "Could not load your details.", "err");
    }
  });
})();
