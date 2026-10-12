/* DCR Agents console — the Settings tab (settings.get / settings.save /
   settings.test / settings.test_claude).

   Only the settings that are safe to change from the web, as the DCR server
   lists them (settings_model.SECTIONS, the fields marked remote): company
   and office details, quiet hours, the digest and report times, email (the
   backend choice and the From line — never a password), the Claude model
   choices, Photo & Video, the personal assistants and the training switch.
   A secret is only ever shown as set / not set / unreadable, with "Change it
   on the DCR server computer"; the portal sign-in, Twilio, SMTP and Graph
   are shown read-only for the same reason, and so is whether WhatsApp on the
   DCR server computer sends by itself (that risk to the number is answered
   at the server's keyboard; the other WhatsApp settings are changed here). Each section saves on its own
   with the `rev` it was read at, and sends only what was changed; the server
   checks every value again and answers in the desktop's words, ending
   "Nothing was saved." when it refuses. The tests are health checks only —
   nothing is sent — and the Claude test uses the key saved on the server. */
(function () {
  "use strict";
  var C = window.DCRConsole;
  if (!C) return;

  var TITLES = { general: "General", email: "Email", wadesktop: "WhatsApp on the DCR server computer", claude: "Claude", photo: "Photo & Video",
    assistant: "Personal assistants", training: "Training" };
  var ORDER = ["general", "email", "wadesktop", "claude", "photo", "assistant", "training"];
  /* a Save button whose title would not read lower-cased */
  var SAVE_WORDS = { wadesktop: "Save the WhatsApp settings" };
  var SECRET_WORDS = {
    "portal.password_enc": "The portal password (the DCR Agents account)",
    "llm.api_key_enc": "The Claude key",
    "email.smtp.password_enc": "The SMTP password",
    "email.graph.client_secret_enc": "The Microsoft Graph client secret",
    "twilio.auth_token_enc": "The Twilio auth token",
  };
  var READONLY_WORDS = [["portal_url", "Portal address"], ["portal_site", "Portal site"], ["portal_email", "Signs in to the portal as"],
    ["twilio", "Twilio (texts and WhatsApp)"], ["email_smtp_host", "SMTP server"], ["email_graph_sender", "Microsoft Graph sender"],
    ["email_from_address", "Email is sent from"], ["email_outlook_mailbox", "Replies are read from the Inbox of"],
    ["wadesktop_mode", "WhatsApp on the DCR server computer: how messages go"]];
  /* The copies' groups, when the server's field does not list them
     (photo/copies.py KIND_GROUPS). */
  var CC_KINDS = [{ key: "heads_up", label: "Heads-up and date changes" }, { key: "followups", label: "Follow-ups and the escalation" },
    { key: "day_before", label: "The evening-before reminder" }, { key: "agenda", label: "The Monday list" }];
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var CC_MAX = 25;

  var S = null;

  C.register({ id: "settings", title: "Settings", order: 110, render: render, leave: function () { S = null; } });

  function $(id) { return document.getElementById(id); }
  function esc(v) { return DCR.esc(v); }
  function text(v) { return v === null || v === undefined ? "" : String(v); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function idOf(section, key) { return "cs-" + section + "-" + String(key).replace(/[^A-Za-z0-9]/g, "_"); }

  function render(el, ctx) {
    el.innerHTML = '<div class="c-head"><h2>Settings</h2></div><div class="c-skel"></div><div class="c-skel"></div>';
    return ctx.rpc("settings.get", {}, { quiet: true }).then(function (d) {
      draw(el, ctx, d || {});
    }, function (e) {
      el.innerHTML = '<div class="c-head"><h2>Settings</h2></div>' + ctx.ui.failed(e);
    });
  }

  /* ── one field ──────────────────────────────────────────────────────── */

  function control(section, f, v) {
    var id = idOf(section, f.key);
    var lab = '<label class="c-label" for="' + id + '">' + esc(f.label) + "</label>";
    var help = f.help ? '<div class="c-help">' + esc(f.help) + "</div>" : "";
    var max = Number(f.max) || 200;
    switch (f.type) {
      case "bool":
        return '<div class="c-field"><label class="c-check"><input type="checkbox" id="' + id + '"' + (v ? " checked" : "") + "> " +
          esc(f.label) + "</label>" + help + "</div>";
      case "int":
        return '<div class="c-field">' + lab + '<input type="number" inputmode="numeric" step="1" id="' + id + '"' +
          (f.lo !== undefined ? ' min="' + esc(f.lo) + '"' : "") + (f.hi !== undefined ? ' max="' + esc(f.hi) + '"' : "") +
          ' value="' + esc(v === null || v === undefined ? "" : v) + '" class="cs-num">' + help + "</div>";
      case "enum":
      case "backend":
        var choices = f.choices || [];
        var known = choices.some(function (c) { return c.key === v; });
        return '<div class="c-field">' + lab + '<select id="' + id + '">' +
          (known ? "" : '<option value="' + esc(v) + '" selected>' + esc(text(v) || "(not set)") + "</option>") +
          choices.map(function (c) {
            return '<option value="' + esc(c.key) + '"' + (c.key === v ? " selected" : "") + ">" + esc(c.label) + "</option>";
          }).join("") + "</select>" + help + "</div>";
      case "hhmm":
      case "briefing":
        return '<div class="c-field">' + lab + '<input type="time" id="' + id + '" value="' + esc(text(v)) + '" class="cs-time">' + help + "</div>";
      case "quiet":
        var q = Array.isArray(v) ? v : ["", ""];
        return '<div class="c-field"><span class="c-label">' + esc(f.label) + '</span><div class="c-inline">' +
          '<input type="time" id="' + id + '-0" value="' + esc(text(q[0])) + '" aria-label="Quiet hours start">' +
          '<span>to</span><input type="time" id="' + id + '-1" value="' + esc(text(q[1])) + '" aria-label="Quiet hours end"></div>' +
          '<div class="c-help">Both empty = no quiet hours of our own.</div>' + help + "</div>";
      case "days":
        var on = Array.isArray(v) ? v.map(Number) : [];
        return '<div class="c-field cs-wide"><span class="c-label">' + esc(f.label) + '</span><div class="c-days" role="group" aria-label="' +
          esc(f.label) + '">' + DAY_NAMES.map(function (n, i) {
            return '<label><input type="checkbox" id="' + id + "-" + i + '"' + (on.indexOf(i) >= 0 ? " checked" : "") + "> " + n + "</label>";
          }).join("") + "</div>" + help + "</div>";
      case "cc_kinds":
        var kinds = f.choices && f.choices.length ? f.choices : CC_KINDS;
        var picked = Array.isArray(v) ? v : [];
        return '<div class="c-field cs-wide"><span class="c-label">' + esc(f.label) + "</span>" + kinds.map(function (k, i) {
          return '<div><label class="c-check"><input type="checkbox" id="' + id + "-" + i + '" data-kind="' + esc(k.key) + '"' +
            (picked.indexOf(k.key) >= 0 ? " checked" : "") + "> " + esc(k.label) + "</label></div>";
        }).join("") + help + "</div>";
      case "cc":
        return '<div class="c-field cs-wide"><span class="c-label">' + esc(f.label) + '</span><div id="' + id + '">' + ccRows(id, v) + "</div>" +
          '<button type="button" class="c-btn ghost sm" data-do="ccadd" data-for="' + id + '">Add a person</button>' + help + "</div>";
      default:
        /* text, link, mailbox, zone, person — and anything newer, as text */
        return '<div class="c-field">' + lab + '<input type="text" id="' + id + '" maxlength="' + max + '" value="' + esc(text(v)) + '"' +
          (f.type === "link" ? ' placeholder="https://…" inputmode="url"' : f.type === "zone" ? ' placeholder="America/Los_Angeles"' :
            f.type === "mailbox" ? ' inputmode="email"' : f.type === "person" ? ' placeholder="a name from the People tab"' : "") + ">" +
          help + "</div>";
    }
  }

  function ccRows(id, list) {
    var rows = Array.isArray(list) ? list : [];
    if (!rows.length) return '<p class="c-help" id="' + id + '-none">Nobody yet.</p>';
    return rows.map(function (p, i) {
      return '<div class="cs-cc" id="' + id + "-row" + i + '"><input type="text" id="' + id + "-n" + i + '" maxlength="80" placeholder="Name" value="' +
        esc(p && p.name) + '" aria-label="Name"><input type="text" id="' + id + "-e" + i + '" maxlength="120" inputmode="email" placeholder="Email" value="' +
        esc(p && p.email) + '" aria-label="Email"><button type="button" class="c-btn ghost sm" data-do="ccdel" data-for="' + id + '" data-i="' + i +
        '" aria-label="Remove this person">Remove</button></div>';
    }).join("");
  }

  function readField(section, f) {
    var id = idOf(section, f.key);
    var el = $(id);
    switch (f.type) {
      case "bool": return !!(el && el.checked);
      case "int":
        var s = el ? text(el.value).trim() : "";
        return s === "" ? s : /^-?\d+$/.test(s) ? Number(s) : s;
      case "quiet":
        return [text(($(id + "-0") || {}).value), text(($(id + "-1") || {}).value)];
      case "days":
        var out = [];
        for (var i = 0; i < 7; i++) { var b = $(id + "-" + i); if (b && b.checked) out.push(i); }
        return out;
      case "cc_kinds":
        var kinds = f.choices && f.choices.length ? f.choices : CC_KINDS;
        return kinds.filter(function (k, j) { var b = $(id + "-" + j); return b && b.checked; }).map(function (k) { return k.key; });
      case "cc":
        return ccRead(id);
      default:
        return el ? text(el.value) : "";
    }
  }
  function ccRead(id) {
    var out = [];
    for (var i = 0; i < CC_MAX + 5; i++) {
      var n = $(id + "-n" + i), e = $(id + "-e" + i);
      if (!n && !e) continue;
      var name = text(n && n.value).trim(), email = text(e && e.value).trim();
      if (name || email) out.push({ name: name, email: email });
    }
    return out;
  }

  /* ── the page ───────────────────────────────────────────────────────── */

  /* A setting the server lists in two sections is shown once: the Photo &
     Video planner's model lives with the other Photo & Video settings, not
     under Claude as well (two copies of one value, each with its own change
     check, made the second save answer "someone changed this"). */
  function shownFields(name, sections) {
    var fields = (sections[name] && sections[name].fields) || [];
    if (name !== "claude" || !sections.photo) return fields;
    var inPhoto = {};
    (sections.photo.fields || []).forEach(function (f) { inPhoto[f.key] = true; });
    return fields.filter(function (f) { return !inPhoto[f.key]; });
  }

  function fieldsHtml(name, fields, values) {
    return fields.map(function (f) { return control(name, f, values[f.key]); }).join("");
  }

  function sectionHtml(ctx, name, sec, d) {
    var fields = shownFields(name, d.sections || {});
    var values = sec.values || {};
    var tools = "";
    if (name === "general") {
      tools = '<button type="button" class="c-btn ghost sm" data-do="test" data-what="portal" data-act data-method="settings.test">Test the portal</button>' +
        '<button type="button" class="c-btn ghost sm" data-do="test" data-what="app" data-act data-method="settings.test">Test the DCR app</button>';
    } else if (name === "email") {
      tools = '<button type="button" class="c-btn ghost sm" data-do="test" data-what="email" data-act data-method="settings.test">Test email</button>';
    } else if (name === "claude") {
      tools = '<button type="button" class="c-btn ghost sm" data-do="claude" data-act data-method="settings.test_claude">Test the Claude key</button>';
    } else if (name === "wadesktop" && (!ctx.has || ctx.has("wadesktop.test"))) {
      tools = '<button type="button" class="c-btn ghost sm" data-do="watest" data-act data-method="wadesktop.test">Test WhatsApp on the server</button>';
    }
    var cw = name === "claude" && Array.isArray(d.claude_words) ?
      '<p class="cs-claude">' + ctx.ui.chip(d.claude_words[0], d.claude_words[1]) + "</p>" : "";
    if (name === "wadesktop") cw = waModeHtml(ctx, d);
    return '<section class="c-card cs-sec" id="cs-sec-' + esc(name) + '"><div class="c-head"><h3>' + esc(TITLES[name] || name) + "</h3></div>" +
      cw + '<div class="cs-fields" id="cs-f-' + esc(name) + '">' + fieldsHtml(name, fields, values) + "</div>" +
      (fields.length < (sec.fields || []).length ? '<p class="c-help">The Photo &amp; Video planner\'s model is in the Photo &amp; Video section.</p>' : "") +
      '<div class="cs-msg" id="cs-msg-' + esc(name) + '" role="status" aria-live="polite"></div>' +
      '<div class="c-actions"><button type="button" class="c-btn" data-do="save" data-section="' + esc(name) + '" data-act data-method="settings.save">' +
      esc(SAVE_WORDS[name] || "Save " + (TITLES[name] || name).toLowerCase()) + "</button>" + tools + "</div></section>";
  }

  /* WhatsApp on this computer: whether it sends by itself is shown, never
     changed here — "Send automatically" can get the company's number
     restricted or banned, so it is switched at the DCR server computer. */
  function waModeHtml(ctx, d) {
    var ro = d.readonly || {};
    var label = text(ro.wadesktop_mode);
    if (!label) return "";
    var auto = /^Send automatically/.test(label);
    return '<p class="cs-wa-mode" id="cs-wa-mode"><span class="c-label">How messages go</span>' + ctx.ui.chip(label, auto ? "warn" : "good") +
      '<span class="c-help">Changed only at the DCR server computer: sending automatically can get the company\'s number restricted or banned by WhatsApp. ' +
      "Messages that wait for someone to press Send are on the Dashboard.</span></p>";
  }

  function draw(el, ctx, d) {
    var ui = ctx.ui;
    var sections = d.sections || {};
    S = { sections: {}, dirty: {}, d: d };
    var names = ORDER.filter(function (n) { return sections[n]; })
      .concat(Object.keys(sections).filter(function (n) { return ORDER.indexOf(n) < 0; }));
    names.forEach(function (n) {
      S.sections[n] = { rev: text(sections[n].rev), fields: shownFields(n, sections), base: JSON.parse(JSON.stringify(sections[n].values || {})) };
    });
    var secrets = d.secrets || {};
    var secretRows = Object.keys(SECRET_WORDS).filter(function (k) { return k in secrets; }).concat(
      Object.keys(secrets).filter(function (k) { return !(k in SECRET_WORDS); })).map(function (k) {
      var st = text(secrets[k]);
      return [SECRET_WORDS[k] || k, { html: ui.chip(st || "not set", st === "set" ? "good" : st === "unreadable" ? "bad" : "dim") +
        (st === "unreadable" ? ' <span class="c-muted c-small">this computer cannot read it — enter it again there</span>' : "") }];
    });
    var ro = d.readonly || {};
    var roRows = READONLY_WORDS.filter(function (r) { return r[0] in ro; }).map(function (r) { return [r[1], text(ro[r[0]]) || "—"]; });
    var missing = d.missing_setup || [];
    el.innerHTML =
      '<div class="c-head"><div><h2>Settings</h2><p class="c-sub">The settings that are safe to change from here. Passwords, keys and the ' +
        "portal sign-in are changed on the DCR server computer.</p></div>" +
        '<div class="c-actions"><button type="button" class="c-btn ghost sm" id="csReload">Reload</button></div></div>' +
      (missing.length ? '<div class="c-banner warn"><span>' + esc("Still to set up on the DCR server: " + missing.join("; ") + ".") + "</span></div>" : "") +
      names.map(function (n) { return sectionHtml(ctx, n, sections[n], d); }).join("") +
      '<section class="c-card" id="cs-secrets"><h3>Passwords and keys</h3><p class="c-sub">' + esc(text(d.server_note) || "Change it on the DCR server computer.") +
        " They are never shown or changed on the web.</p>" + ui.kv(secretRows) + "</section>" +
      '<section class="c-card" id="cs-readonly"><h3>On the DCR server computer only</h3>' + ui.kv(roRows) + "</section>";
    ctx.guard(function () {
      return S && Object.keys(S.dirty).some(function (k) { return S.dirty[k]; }) ? "Leave without saving your settings?" : "";
    });
    wire(el, ctx);
  }

  function sectionOf(node) {
    while (node && node.id !== undefined) {
      if (node.id && /^cs-sec-/.test(node.id)) return node.id.slice(7);
      node = node.parentNode;
    }
    return "";
  }

  function say(name, words, tone) {
    var m = $("cs-msg-" + name);
    if (!m) return;
    m.className = "cs-msg" + (tone ? " " + tone : "");
    m.textContent = text(words);
  }

  function wire(el, ctx) {
    var mark = function (e) {
      var n = sectionOf(e.target);
      if (n && S) S.dirty[n] = true;
    };
    el.addEventListener("input", mark);
    el.addEventListener("change", mark);
    el.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest("button") : null;
      if (!t || t.disabled) return;
      if (t.id === "csReload") { ctx.refresh(); return; }
      var what = t.getAttribute("data-do");
      if (what === "save") save(ctx, t.getAttribute("data-section"), t);
      else if (what === "test") test(ctx, t);
      else if (what === "claude") testClaude(ctx, t);
      else if (what === "watest") testWa(ctx, t);
      else if (what === "ccadd" || what === "ccdel") editCc(t, what);
    });
  }

  function editCc(btn, what) {
    var id = btn.getAttribute("data-for");
    var box = $(id);
    if (!box) return;
    var rows = ccRead(id);
    if (what === "ccdel") {
      var i = Number(btn.getAttribute("data-i"));
      var all = [];
      for (var k = 0; k < CC_MAX + 5; k++) {
        var n = $(id + "-n" + k), e = $(id + "-e" + k);
        if (n || e) all.push({ name: text(n && n.value), email: text(e && e.value), k: k });
      }
      rows = all.filter(function (r) { return r.k !== i; }).map(function (r) { return { name: r.name, email: r.email }; });
    } else {
      if (rows.length >= CC_MAX) return;
      rows.push({ name: "", email: "" });
    }
    box.innerHTML = ccRows(id, rows);
    var sec = sectionOf(box);
    if (sec && S) S.dirty[sec] = true;
  }

  function save(ctx, name, btn) {
    var sec = S && S.sections[name];
    if (!sec) return Promise.resolve(null);
    var values = {};
    sec.fields.forEach(function (f) {
      var v = readField(name, f);
      if (!same(v, sec.base[f.key])) values[f.key] = v;
    });
    if (!Object.keys(values).length) {
      say(name, "Nothing changed.", "");
      S.dirty[name] = false;
      return Promise.resolve(null);
    }
    say(name, "", "");
    return ctx.press(btn, function () {
      return ctx.rpc("settings.save", { section: name, values: values, rev: sec.rev }, { quiet: true }).then(function (r) {
        r = r || {};
        sec.rev = text(r.rev) || sec.rev;
        for (var k in values) if (Object.prototype.hasOwnProperty.call(values, k)) sec.base[k] = values[k];
        S.dirty[name] = false;
        say(name, r.words || "Saved.", "good");
        ctx.toast((TITLES[name] || name) + ": " + (r.words || "Saved."));
        refreshOthers(ctx, name);
        if ((r.effects || []).indexOf("offer_tell_pages") >= 0 && ctx.has("assistants.tell_pages")) {
          return ctx.act("assistants.tell_pages", { reads: !!values["assistant.office_reads"] }).then(function (t) {
            if (t && t.words) ctx.toast(t.words);
          }, function () {});
        }
      }, function (e) {
        if (e.code === "changed") {
          say(name, e.message + " Your changes are still here — Reload loses them.", "bad");
        } else {
          say(name, e.message, "bad");
        }
      });
    }, "Saving…");
  }

  /* After a save, the other sections nobody is editing are read again: a
     value two sections share (or one the Photo & Video or Assistants tab
     shows too) changed, and so did their change check — without this the
     next save there answered "someone changed this". A section with
     unsaved edits is left alone (its save says so, and Reload refreshes). */
  function refreshOthers(ctx, saved) {
    var mine = S;
    return ctx.rpc("settings.get", {}, { quiet: true }).then(function (d) {
      if (S !== mine || !d || !d.sections) return;
      Object.keys(S.sections).forEach(function (n) {
        var fresh = d.sections[n];
        if (n === saved || S.dirty[n] || !fresh) return;
        var sec = S.sections[n];
        sec.rev = text(fresh.rev) || sec.rev;
        sec.base = JSON.parse(JSON.stringify(fresh.values || {}));
        var box = $("cs-f-" + n);
        if (box) box.innerHTML = fieldsHtml(n, sec.fields, fresh.values || {});
      });
    }, function () { /* the next save of another section may say "changed"; Reload mends it */ });
  }

  function test(ctx, btn) {
    var what = btn.getAttribute("data-what");
    var name = sectionOf(btn);
    say(name, "", "");
    return ctx.press(btn, function () {
      return ctx.rpc("settings.test", { what: what }, { quiet: true }).then(function (r) {
        r = r || {};
        say(name, (r.ok ? "OK — " : "PROBLEM — ") + text(r.detail), r.ok ? "good" : "bad");
      }, function (e) { say(name, e.message, "bad"); });
    }, "Testing…");
  }

  function testClaude(ctx, btn) {
    var name = sectionOf(btn);
    say(name, "", "");
    return ctx.press(btn, function () {
      return ctx.rpc("settings.test_claude", {}, { quiet: true }).then(function (r) {
        r = r || {};
        say(name, (r.ok ? "OK — " : "PROBLEM — ") + text(r.words), r.ok ? "good" : "bad");
      }, function (e) { say(name, e.message, "bad"); });
    }, "Testing…");
  }

  /* The read-only questions the server's own Test asks Windows (installed,
     running, its window found; the screen unlocked when it sends by itself).
     Nothing is opened, pressed or sent. One line per check. */
  function testWa(ctx, btn) {
    var name = sectionOf(btn);
    say(name, "", "");
    return ctx.press(btn, function () {
      return ctx.rpc("wadesktop.test", {}, { quiet: true }).then(function (r) {
        r = r || {};
        var lines = (r.lines || []).map(function (x) { return (x && x.ok ? "✓ " : "✗ ") + text(x && x.text); });
        say(name, (r.ok ? "OK — every check passed" : "PROBLEM — something still needs doing") + (lines.length ? "\n" + lines.join("\n") : ""),
          r.ok ? "good" : "bad");
      }, function (e) { say(name, e.message, "bad"); });
    }, "Testing…");
  }

  if (window.__DCR_CONSOLE_TEST__) C._settings = { state: function () { return S; }, readField: readField, control: control };
})();
