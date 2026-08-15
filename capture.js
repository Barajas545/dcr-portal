/* DCR portal — Site Photos: photograph or film the job you're standing on.

   Flow: GPS finds the nearest open project → confirm it (or search by address)
   → shoot → every file lands in that project's Pictures / <company week> folder,
   e.g. "Pictures / 2026-Week #02" (weeks run Saturday–Friday, like the timesheets).

   Bytes never pass through the API: the server mints a resumable SharePoint
   upload session and the browser PUTs 7.5 MiB chunks straight to it, so a long
   4K video is no different from a photo. Files are uploaded exactly as the camera
   wrote them — no re-encoding — so the original EXIF (camera GPS, capture time)
   survives.

   Project coordinates are learned, not configured: standing on a site with a good
   fix teaches the portal where that job is (write-once), and addresses are
   geocoded in the background through the same Nominatim service tasks-map.html
   already uses. */

(function () {
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  // Finished work shouldn't compete to be the "nearest" job — that's the main way
  // photos end up filed against the wrong project.
  var HIDDEN_STATUS = { "closed": 1, "completed": 1 };

  var GEO_MAX_PER_VISIT = 40;           // Nominatim politeness: ~1 req/sec
  var GEO_GAP_MS = 1150;
  var NEAR_MI = 0.19;                   // ~1000 ft: close enough to call it "you're here"

  var state = {
    all: [],           // every project from the board
    pool: [],          // the ones eligible to be picked
    showAll: false,
    pos: null,         // {lat,lng,accuracy}
    project: null,
    week: DCR.weekFolder(),
    jobs: [],          // what is on screen; DCR.uploadQueue holds the bytes
    q: {},             // file name -> live queue record
    seq: 0,
    geoRun: 0,         // bumped to cancel an in-flight background geocode pass
    wakeLock: null,
  };

  /* ── steps ── */
  function show(name) {
    ["stepPick", "stepConfirm", "stepShoot"].forEach(function (id) {
      el(id).classList.toggle("on", id === name);
    });
    window.scrollTo(0, 0);
  }
  function msg(id, kind, text) {
    var m = el(id);
    m.className = "cp-msg" + (kind ? " " + kind : "");
    m.textContent = text || "";
  }

  /* ── project helpers ── */
  function statusOf(p) { return String(p.estimateStatus || "").trim(); }
  function eligible(p) { return !HIDDEN_STATUS[statusOf(p).toLowerCase()]; }
  function label(p) {
    return [p.internalIDNumber, p.projectName].filter(Boolean).join(" — ") || "(unnamed project)";
  }
  function addressOf(p) {
    return [p.projectAddress, p.projectCity].filter(Boolean).join(", ");
  }
  function coordsOf(p) { return DCR.parseCoords(p.projectCoordinates); }
  function distanceOf(p) {
    if (!state.pos) return null;
    var c = coordsOf(p);
    return c ? DCR.distanceMi(state.pos, c) : null;
  }
  function fmtMi(d) {
    if (d == null) return "";
    if (d < 0.19) return "you're here";
    if (d < 10) return d.toFixed(1) + " mi";
    return Math.round(d) + " mi";
  }

  // Nearest first; everything unlocated after, most recently touched first.
  function ranked(list) {
    var withD = [], without = [];
    list.forEach(function (p) {
      var d = distanceOf(p);
      if (d == null) without.push(p); else withD.push({ p: p, d: d });
    });
    withD.sort(function (a, b) { return a.d - b.d; });
    without.sort(function (a, b) {
      return String(b.projectDateLastModified || "").localeCompare(String(a.projectDateLastModified || ""));
    });
    return withD.map(function (x) { return x.p; }).concat(without);
  }

  function matches(p, q) {
    if (!q) return true;
    var hay = [p.internalIDNumber, p.projectName, p.projectAddress, p.projectCity,
      p.projectClientName].filter(Boolean).join(" ").toLowerCase();
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) !== -1; });
  }

  /* ── thumbnails (negative-cached: most projects have no Thumnail.png) ── */
  var thumbs = {};
  function paintThumb(box, p) {
    var id = p.id;
    if (thumbs[id] === "none") return;
    if (thumbs[id]) { box.innerHTML = '<img src="' + thumbs[id] + '" alt="">'; return; }
    DCR.blobUrl("/api/portal?action=thumb&projectId=" + encodeURIComponent(id))
      .then(function (url) {
        thumbs[id] = url;
        if (box.isConnected) box.innerHTML = '<img src="' + url + '" alt="">';
      })
      .catch(function () { thumbs[id] = "none"; });
  }

  function cardHtml(p, opts) {
    opts = opts || {};
    var d = distanceOf(p);
    var bits = [];
    if (d != null) bits.push('<span class="cp-dist">' + esc(fmtMi(d)) + "</span>");
    if (statusOf(p)) bits.push('<span class="cp-stat">' + esc(statusOf(p)) + "</span>");
    return '<' + (opts.static ? "div" : "button") + ' class="cp-card' + (opts.best ? " best" : "") + '"' +
      (opts.static ? "" : ' data-pick="' + esc(p.id) + '"') + ' type="button">' +
      '<span class="cp-thumb" data-thumb="' + esc(p.id) + '">🏠</span>' +
      '<span class="cp-info">' +
        '<span class="cp-nm">' + esc(label(p)) + "</span>" +
        '<span class="cp-ad">' + esc(addressOf(p) || "No address on file") + "</span>" +
        (bits.length ? '<span class="cp-meta">' + bits.join(" ") + "</span>" : "") +
      "</span></" + (opts.static ? "div" : "button") + ">";
  }

  function wireCards(scope) {
    scope.querySelectorAll("[data-thumb]").forEach(function (b) {
      var p = byId(b.getAttribute("data-thumb"));
      if (p) paintThumb(b, p);
    });
    scope.querySelectorAll("[data-pick]").forEach(function (b) {
      b.onclick = function () { pickProject(byId(b.getAttribute("data-pick"))); };
    });
  }
  function byId(id) {
    for (var i = 0; i < state.all.length; i++) if (String(state.all[i].id) === String(id)) return state.all[i];
    return null;
  }

  /* ── step 1: pick ── */
  function renderPick() {
    var q = (el("pickSearch").value || "").trim().toLowerCase();
    var pool = state.showAll ? state.all : state.pool;
    var list = ranked(pool.filter(function (p) { return matches(p, q); }));

    var best = el("pickBest"), rest = el("pickList");
    // The top hit only gets the spotlight when GPS actually put us next to it and
    // nothing else is nearly as close — otherwise it's just the first row.
    var top = list[0], second = list[1];
    var topD = top ? distanceOf(top) : null;
    var secondD = second ? distanceOf(second) : null;
    var confident = !q && topD != null && topD < NEAR_MI && (secondD == null || secondD > topD + 0.05);

    if (confident) {
      best.innerHTML = '<div class="cp-sub" style="margin:10px 0 6px"><b>Closest to you</b></div>' + cardHtml(top, { best: true });
      rest.innerHTML = list.slice(1, 40).map(function (p) { return cardHtml(p); }).join("");
    } else {
      best.innerHTML = "";
      rest.innerHTML = list.slice(0, 40).map(function (p) { return cardHtml(p); }).join("");
    }
    if (!list.length) {
      rest.innerHTML = '<div class="cp-note">No project matches “' + esc(q) + '”.' +
        (state.showAll ? "" : " Closed and completed jobs are hidden — tap “Show all projects” to include them.") + "</div>";
    }
    wireCards(best); wireCards(rest);
    el("pickMore").textContent = state.showAll ? "Hide closed / completed" : "Show all projects";

    var located = pool.filter(function (p) { return !!coordsOf(p); }).length;
    el("pickSub").innerHTML = state.pos
      ? "Nearest first. " + located + " of " + pool.length + " jobs have a known location."
      : "Search for the job below, or " +
        '<a href="#" id="pickGpsLink" style="color:#2f80d8">use my location</a>.';
    var lnk = el("pickGpsLink");
    if (lnk) lnk.onclick = function (e) { e.preventDefault(); locate(); };
  }

  function pickProject(p) {
    if (!p) return;
    state.project = p;
    var d = distanceOf(p);
    el("confirmCard").innerHTML = cardHtml(p, { static: true });
    wireCards(el("confirmCard"));
    el("confirmWhere").innerHTML =
      "Files will be saved to <b>" + esc(label(p)) + "</b> → Pictures → <b>" + esc(state.week) + "</b>" +
      (d != null ? "<br>" + esc(fmtMi(d)) + " from where you are now." : "");
    show("stepConfirm");
  }

  /* ── location ── */
  function locate() {
    if (!navigator.geolocation) {
      msg("pickMsg", "err", "This device can't share its location — search for the job instead.");
      return;
    }
    msg("pickMsg", "", "Getting your location… ");
    el("pickMsg").innerHTML = '<span class="cp-spin"></span> Getting your location…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.pos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 0 };
      msg("pickMsg", "", pos.coords.accuracy ? "Located to about " + Math.round(pos.coords.accuracy) + " m." : "");
      renderPick();
      geocodePass();
    }, function (err) {
      var why = err && err.code === 1
        ? "Location is turned off for this app. Search for the job below, or allow location in your browser settings."
        : "Couldn't get a location fix — search for the job below.";
      msg("pickMsg", "err", why);
      renderPick();
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  /* ── background geocoding ─────────────────────────────────────────────
     Day one no project has coordinates, so there is nothing to rank by. Rather
     than geocode 250 addresses, geocode the handful of distinct CITIES first,
     work out which are near, then resolve street addresses only in those. Each
     result is saved back to SharePoint (write-once), so the portal gets better
     at this every time somebody uses it. */
  function nominatim(q) {
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&email=" +
      encodeURIComponent("cristobal@dcrframing.com") + "&q=" + encodeURIComponent(q);
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.length) {
        var lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon);
        if (isFinite(lat) && isFinite(lng)) return { lat: lat, lng: lng };
      }
      return null;
    }).catch(function () { return null; });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function geocodePass() {
    var run = ++state.geoRun;
    var pool = state.pool.filter(function (p) { return !coordsOf(p) && (p.projectAddress || p.projectCity); });
    if (!pool.length || !state.pos) return;

    // 1) unique cities → distance from here
    var cities = {};
    pool.forEach(function (p) {
      var c = String(p.projectCity || "").trim();
      if (c) (cities[c.toLowerCase()] = cities[c.toLowerCase()] || { name: c, n: 0 }).n++;
    });
    var names = Object.keys(cities);
    var cityCache = {};
    try { cityCache = JSON.parse(localStorage.getItem("dcrCityGeo") || "{}"); } catch (e) {}

    for (var i = 0; i < names.length; i++) {
      if (run !== state.geoRun) return;
      var k = names[i];
      if (!cityCache[k]) {
        var hit = await nominatim(cities[k].name);
        if (hit) cityCache[k] = [hit.lat, hit.lng];
        await sleep(GEO_GAP_MS);
      }
      cities[k].c = cityCache[k] ? { lat: cityCache[k][0], lng: cityCache[k][1] } : null;
    }
    try { localStorage.setItem("dcrCityGeo", JSON.stringify(cityCache)); } catch (e) {}

    // 2) projects in the closest cities first, then anything with no city
    var order = pool.slice().sort(function (a, b) {
      var da = cityDist(a), db = cityDist(b);
      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;
      return da - db;
    });
    function cityDist(p) {
      var e = cities[String(p.projectCity || "").trim().toLowerCase()];
      return e && e.c ? DCR.distanceMi(state.pos, e.c) : null;
    }

    var done = 0;
    for (var j = 0; j < order.length && done < GEO_MAX_PER_VISIT; j++) {
      if (run !== state.geoRun) return;
      var p = order[j];
      var q = [p.projectAddress, p.projectCity].filter(Boolean).join(", ");
      if (!q) continue;
      var loc = await nominatim(q);
      done++;
      if (loc) {
        p.projectCoordinates = loc.lat.toFixed(6) + "," + loc.lng.toFixed(6) + "|geocode";
        saveGeo(p, loc, "geocode", 0);
        if (run === state.geoRun) renderPick();
      }
      await sleep(GEO_GAP_MS);
    }
  }

  // Write-once on the server; failures are silent by design (this is a nicety,
  // never something the crew should be interrupted by).
  function saveGeo(p, loc, src, accuracy) {
    DCR.api("/api/portal?action=board", {
      method: "POST",
      body: { op: "geo", projectId: p.id, lat: loc.lat, lng: loc.lng, src: src, accuracy: accuracy || 0 },
    }).catch(function () {});
  }

  /* ── step 3: capture + upload ── */
  function stamp(d) {
    var p2 = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
      " " + p2(d.getHours()) + "." + p2(d.getMinutes()) + "." + p2(d.getSeconds());
  }
  // Keep the camera's own extension — an iPhone HEIC must not be stored as .jpg.
  function extOf(file) {
    var m = /\.([A-Za-z0-9]{2,5})$/.exec(file.name || "");
    if (m) return "." + m[1].toLowerCase();
    var t = String(file.type || "");
    if (t.indexOf("video/") === 0) return "." + (t.split("/")[1] || "mp4").split(";")[0];
    if (t.indexOf("image/") === 0) return "." + (t.split("/")[1] || "jpg").split(";")[0];
    return "";
  }
  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  /* Every file is handed to DCR.uploadQueue, which writes the bytes to the
     device before it tries the network. That is what makes a photo taken with
     no bars safe: the tab can be closed, the phone can be rebooted, the van can
     drive out of range — the file is still there and still goes up the moment
     there is a connection. This list is only the display; the queue is the
     truth, and it is shared with the project Journal. */
  function addFiles(files, when) {
    if (!files || !files.length) return [];
    var now = when || new Date(), added = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.size) continue;
      var isVid = String(f.type || "").indexOf("video/") === 0 || /\.(mov|mp4|m4v|avi|3gp)$/i.test(f.name || "");
      state.seq++;
      var job = {
        id: state.seq,
        // Sorts chronologically in SharePoint and never collides within a second.
        name: (isVid ? "VID " : "IMG ") + stamp(now) + (state.seq > 1 ? "-" + state.seq : "") + extOf(f),
        size: f.size,
        qid: null,
        armed: false,          // true once the queue has been read back at least once
        video: isVid,
      };
      state.jobs.push(job);
      added.push(job);
      takeCustody(job, f);
    }
    renderJobs();
    return added;
  }

  // Kept apart from addFiles so the camera never waits on a disk write.
  async function takeCustody(job, file) {
    try {
      job.qid = await DCR.uploadQueue.add({
        pid: state.project.id, target: "pictures", weekFolder: state.week,
        name: job.name, mime: file.type || "", blob: file, tag: "site-photo",
      });
      await refreshQ();        // read back before trusting "it's gone, so it's done"
      job.armed = true;
    } catch (e) {
      job.diskError = e && e.message ? e.message : "Could not save it on this device";
    }
    renderJobs();
  }

  function statusOf_(j) {
    if (j.diskError) return "failed";
    var up = state.q[j.name];
    if (up) return up.state === "failed" ? "failed" : up.state === "uploading" ? "uploading" : "queued";
    return j.armed ? "done" : "queued";
  }

  var _qOff = null;
  function refreshQ() {
    return DCR.uploadQueue.listFor(state.project ? state.project.id : "").then(function (items) {
      var map = {};
      items.forEach(function (it) { map[it.name] = it; });
      state.q = map;
      renderJobs();
    }).catch(function () {});
  }
  function watchQ() {
    if (_qOff) return;
    _qOff = DCR.uploadQueue.on(function () { refreshQ(); });
    refreshQ();
  }

  // Anything this project still owes from a previous visit, back on the screen.
  async function adoptQueued() {
    var items = await DCR.uploadQueue.listFor(state.project.id).catch(function () { return []; });
    items.forEach(function (it) {
      if (state.jobs.some(function (j) { return j.name === it.name; })) return;
      state.seq++;
      state.jobs.push({ id: state.seq, name: it.name, size: it.size, qid: it.id,
        armed: true, video: /^VID /.test(it.name), earlier: true });
    });
    if (items.length) renderJobs();
  }

  function renderJobs() {
    var host = el("shootList");
    camPaintStrip();
    if (!state.jobs.length) {
      host.innerHTML = "";
      el("shootRetryRow").classList.add("cp-hide");
      msg("shootMsg", "", "");
      holdScreen(false);
      return;
    }
    host.innerHTML = state.jobs.map(function (j) {
      var st = statusOf_(j);
      var up = state.q[j.name];
      var pct = st === "done" ? 100 : (up ? up.pct : 0);
      var cls = st === "done" ? " done" : (st === "failed" ? " err" : "");
      var txt = st === "done" ? "✓ Saved"
        : st === "failed" ? "✕ " + (j.diskError || (up && up.error) || "Failed")
        : st === "uploading" ? pct + "%"
        : !DCR.uploadQueue.online() ? "Saved on this device"
        : j.armed ? "Waiting to upload" : "Saving on this device…";
      return '<div class="cp-up' + cls + '"><div class="cp-upt">' +
        '<span class="cp-upn">' + esc(j.name) + "</span>" +
        '<span class="cp-ups' + cls + '">' + esc(txt) + " · " + fmtSize(j.size) + "</span>" +
        // Remove sits at the far right of the row, on its own, away from every
        // other control — and it always asks first.
        (st === "done" ? "" : '<button class="cp-upx" data-drop="' + j.id + '" title="Don\'t upload this one">✕</button>') +
        "</div>" +
        '<div class="cp-bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");

    host.querySelectorAll("[data-drop]").forEach(function (b) {
      b.onclick = async function () {
        var id = +b.getAttribute("data-drop");
        var j = null;
        state.jobs.forEach(function (x) { if (x.id === id) j = x; });
        if (!j) return;
        var noun = j.video ? "video" : "photo";
        var ok = await DCR.confirm(
          "This " + noun + " has not been uploaded yet. If you remove it now it is gone — " +
          "it is not saved anywhere else.",
          { title: "Don't upload this " + noun + "?", danger: true, okText: "Remove" });
        if (!ok) return;
        if (j.qid) { try { await DCR.uploadQueue.remove(j.qid); } catch (e) {} }
        state.jobs = state.jobs.filter(function (x) { return x !== j; });
        var im = el("camStrip") && el("camStrip").querySelector('img[data-jid="' + j.id + '"]');
        if (im) im.remove();
        renderJobs();
      };
    });

    var statuses = state.jobs.map(statusOf_);
    var failed = statuses.filter(function (s) { return s === "failed"; }).length;
    var doneN = statuses.filter(function (s) { return s === "done"; }).length;
    var pending = state.jobs.length - doneN - failed;
    el("shootRetryRow").classList.toggle("cp-hide", !failed);
    holdScreen(pending > 0 && DCR.uploadQueue.online());

    // The browser refused to store the files. They are only in memory, so the
    // usual reassurance would be a lie — say what is actually true.
    if (pending && !DCR.uploadQueue.durable()) {
      msg("shootMsg", "err", "This browser will not let the app keep files on the device — " +
        pending + " file" + (pending === 1 ? " is" : "s are") + " only held while this screen is " +
        "open. Stay here until each one says ✓ Saved.");
    } else if (pending && !DCR.uploadQueue.online()) {
      msg("shootMsg", "", "No signal — " + pending + " file" + (pending === 1 ? " is" : "s are") +
        " saved on this device. They upload by themselves as soon as you have a connection, " +
        "even if you close the app.");
    } else if (pending) {
      msg("shootMsg", "", "Uploading " + pending + " file" + (pending === 1 ? "" : "s") +
        " — you can carry on, they finish on their own.");
    } else if (failed) {
      msg("shootMsg", "err", doneN + " saved, " + failed + " still on this device — tap retry.");
    } else if (doneN) {
      msg("shootMsg", "ok", "✓ All " + doneN + " file" + (doneN === 1 ? "" : "s") + " saved to " + state.week + ".");
    } else {
      msg("shootMsg", "", "");
    }
  }

  // The screen going dark suspends the upload on most phones; ask to keep it on
  // while anything is in flight.
  async function holdScreen(on) {
    try {
      if (on && !state.wakeLock && navigator.wakeLock) {
        state.wakeLock = await navigator.wakeLock.request("screen");
        state.wakeLock.addEventListener("release", function () { state.wakeLock = null; });
      } else if (!on && state.wakeLock) {
        state.wakeLock.release();
        state.wakeLock = null;
      }
    } catch (e) { /* not supported / not allowed — the queue survives either way */ }
  }

  /* ── in-app camera ─────────────────────────────────────────────────────
     The phone's own camera makes you approve every frame ("Retake / Use
     Photo"). Standing on a roof with gloves on that is one tap too many, so
     we shoot here instead: the shutter queues the photo and the upload starts
     immediately. A bad shot gets deleted later from the project's Files tab.

     What that costs, deliberately: a canvas frame is not the camera's own
     file, so the original EXIF (camera GPS, capture time) does not survive,
     and the frame is the preview stream's resolution rather than the full
     sensor. The capture time is in the filename and the project is the
     folder, and "Choose from gallery" still uploads untouched originals when
     something needs the real thing. */
  var cam = { stream: null, track: null, facing: "environment", torch: false, shots: 0, open: false,
    pending: [], draining: false };

  function camSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.File);
  }

  function camWhy(e) {
    var n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError")
      return "Camera access is blocked for this site. Allow the camera in your browser settings, then try again.";
    if (n === "NotFoundError" || n === "OverconstrainedError")
      return "No camera was found on this device.";
    if (n === "NotReadableError")
      return "The camera is busy — close any other app using it and try again.";
    return (e && e.message) || "The camera could not be opened.";
  }

  async function camStart(facing) {
    camStop();
    cam.facing = facing || cam.facing;
    // Ask for far more than the preview needs — the browser hands back the
    // closest mode the camera actually has, which is the best we can get.
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: cam.facing }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
    cam.track = cam.stream.getVideoTracks()[0] || null;
    var v = el("camVideo");
    v.muted = true;              // Safari checks the property, not just the attribute
    v.srcObject = cam.stream;
    try { await v.play(); } catch (e) { /* autoplay attrs cover this on iOS */ }

    // Torch exists on some rear cameras only; flipping is pointless with one.
    var caps = {};
    try { caps = cam.track && cam.track.getCapabilities ? cam.track.getCapabilities() : {}; } catch (e) {}
    cam.torch = false;
    el("camTorch").hidden = !caps.torch;
    el("camTorch").classList.remove("on");
    try {
      var devs = await navigator.mediaDevices.enumerateDevices();
      el("camFlip").hidden = devs.filter(function (d) { return d.kind === "videoinput"; }).length < 2;
    } catch (e) { el("camFlip").hidden = true; }
  }

  function camStop() {
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
    cam.stream = null;
    cam.track = null;
    el("camVideo").srcObject = null;
  }

  // `kind` lets a transient notice retract itself — the "still saving" warning
  // is a lie the moment the queue drains, and a stale warning on a camera
  // screen reads as "your photos didn't go".
  function camErr(text, kind) {
    var box = el("camErr");
    box.textContent = text || "";
    box.hidden = !text;
    box.dataset.kind = text ? kind || "" : "";
  }

  // Shots taken here, and how many SharePoint has actually got.
  function camCount() {
    if (!cam.open) return;
    var st = state.jobs.map(statusOf_);
    var done = st.filter(function (s) { return s === "done"; }).length;
    var failed = st.filter(function (s) { return s === "failed"; }).length;
    el("camCount").textContent = !cam.shots
      ? "Tap the button — each photo uploads on its own"
      : cam.shots + " taken · " + done + " saved" + (failed ? " · " + failed + " failed" : "");
  }

  // Green ring once it is safely in SharePoint, red if it gave up.
  function camPaintStrip() {
    if (!cam.open) return;
    state.jobs.forEach(function (j) {
      var im = el("camStrip").querySelector('img[data-jid="' + j.id + '"]');
      if (!im) return;
      var st = statusOf_(j);
      im.className = st === "done" ? "done" : st === "failed" ? "err" : "";
    });
    camCount();
  }

  function camThumb(src) {
    var s = 96, t = document.createElement("canvas");
    t.width = t.height = s;
    var k = Math.max(s / src.width, s / src.height), w = src.width * k, h = src.height * k;
    t.getContext("2d").drawImage(src, (s - w) / 2, (s - h) / 2, w, h);
    var img = new Image();
    img.src = t.toDataURL("image/jpeg", 0.6);
    var strip = el("camStrip");
    strip.appendChild(img);
    strip.scrollLeft = strip.scrollWidth;
    return img;
  }

  /* The shutter must never wait on the JPEG encoder. Grabbing the frame is a
     millisecond; encoding it was measured at a full second, and a shutter that
     sits dead that long silently eats the next tap — you think you took six
     photos and came home with two. So the tap grabs the pixels and re-arms
     straight away, and the encode happens behind it.

     Encodes run one at a time, in the order the shutter fired, so filenames
     stay in the order the shots were actually taken. Each queued frame holds a
     full-size canvas, so the queue is capped rather than allowed to eat the
     phone's memory. */
  var CAM_QUEUE_MAX = 6;

  function camShoot() {
    if (!cam.open) return;
    var v = el("camVideo"), w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) { camErr("The camera is still warming up — try again in a moment."); return; }
    if (cam.pending.length >= CAM_QUEUE_MAX) {
      camErr("Still saving the last few — give it a second.", "cap");
      return;
    }

    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);

    var flash = el("camFlash");
    flash.classList.remove("go");
    void flash.offsetWidth;            // restart the animation on every shot
    flash.classList.add("go");

    cam.shots++;
    cam.pending.push({ canvas: c, when: new Date(), img: camThumb(c) });
    camErr("");
    camCount();
    camDrain();
  }

  async function camDrain() {
    if (cam.draining) return;
    cam.draining = true;
    while (cam.pending.length) {
      var shot = cam.pending.shift();
      try {
        var blob = await new Promise(function (res) { shot.canvas.toBlob(res, "image/jpeg", 0.92); });
        if (!blob || !blob.size) throw new Error("empty frame");
        // addFiles names the file from its extension, so the placeholder is .jpg
        var job = addFiles(
          [new File([blob], "photo.jpg", { type: "image/jpeg", lastModified: shot.when.getTime() })],
          shot.when
        )[0];
        if (job && shot.img) shot.img.setAttribute("data-jid", job.id);
      } catch (e) {
        if (shot.img) shot.img.className = "err";
        camErr("One photo could not be saved — take it again.");
      }
      shot.canvas.width = shot.canvas.height = 0;   // release it now, not at GC's leisure
      camCount();
      // The queue has room again, so retract the "give it a second" notice.
      if (el("camErr").dataset.kind === "cap" && cam.pending.length < CAM_QUEUE_MAX) camErr("");
    }
    cam.draining = false;
  }

  async function camOpen() {
    if (!camSupported()) { camFallback("This browser can't open the camera inside the app."); return; }
    cam.shots = 0;
    cam.open = true;
    el("camStrip").innerHTML = "";
    el("camJob").textContent = label(state.project);
    el("shootNativeRow").classList.add("cp-hide");
    camErr("");
    camCount();
    el("camWrap").hidden = false;
    holdScreen(true);
    try {
      await camStart("environment");
      camCount();
    } catch (e) {
      camClose();
      camFallback(camWhy(e));
    }
  }

  function camClose() {
    cam.open = false;
    camStop();
    el("camWrap").hidden = true;
    renderJobs();          // back to the full upload list
  }

  // The rejection lands after the tap that opened the camera, so the gesture is
  // spent and a file input can't be clicked from here — offer the button.
  function camFallback(why) {
    msg("shootMsg", "err", why);
    el("shootNativeRow").classList.remove("cp-hide");
  }

  async function camToggleTorch() {
    if (!cam.track) return;
    cam.torch = !cam.torch;
    try {
      await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] });
      el("camTorch").classList.toggle("on", cam.torch);
    } catch (e) {
      cam.torch = false;
      el("camTorch").classList.remove("on");
      camErr("This camera's light can't be controlled from the browser.");
    }
  }

  async function camSwitch() {
    try { await camStart(cam.facing === "environment" ? "user" : "environment"); camErr(""); }
    catch (e) { camErr(camWhy(e)); }
  }

  function startShooting() {
    var p = state.project;
    state.week = DCR.weekFolder();   // a crew can be on site across midnight
    el("shootBanner").innerHTML =
      '<span class="cp-thumb" data-thumb="' + esc(p.id) + '">🏠</span>' +
      '<span class="cp-info"><span class="cp-nm">' + esc(label(p)) + "</span>" +
      '<span class="cp-ad">' + esc(addressOf(p)) + "</span></span>";
    wireCards(el("shootBanner"));
    el("shootWhere").innerHTML = "Saving to <b>Pictures → " + esc(state.week) +
      "</b><br>Photos are kept on this device the instant you take them and upload by themselves — " +
      "nothing to confirm, and nothing is lost if you have no signal or close the app. Delete any you " +
      "don't want later from the project's Files tab.";
    show("stepShoot");
    watchQ();
    adoptQueued();

    // Standing on the job with a good fix is the best pin we will ever get.
    if (state.pos && state.pos.accuracy && state.pos.accuracy <= 100) {
      saveGeo(p, state.pos, "gps", state.pos.accuracy);
      if (!coordsOf(p)) p.projectCoordinates = state.pos.lat.toFixed(6) + "," + state.pos.lng.toFixed(6) + "|gps";
    }
  }

  /* ── boot ── */
  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;

    // Wire everything BEFORE the project list arrives — on LTE that fetch is
    // ~300 KB and the search box must not be dead while it lands.
    el("pickSearch").oninput = function () { renderPick(); };
    el("pickMore").onclick = function () { state.showAll = !state.showAll; renderPick(); };
    el("pickRetryGps").onclick = locate;
    el("confirmNo").onclick = function () { show("stepPick"); };
    el("confirmYes").onclick = startShooting;
    el("shootDone").onclick = async function () {
      // Leaving is safe: whatever is left is on the device and the queue keeps
      // going. Say so rather than warning about something that cannot be lost.
      var left = state.jobs.filter(function (j) { return statusOf_(j) !== "done"; }).length;
      if (left) {
        var ok = await DCR.confirm(
          left + " file" + (left === 1 ? " is" : "s are") + " saved on this device and will " +
          "keep uploading on their own" + (DCR.uploadQueue.online() ? "" : " as soon as you have signal") + ".",
          { title: "Finish here?", okText: "Finish" });
        if (!ok) return;
      }
      state.jobs = []; renderJobs(); show("stepPick");
    };
    el("shootPhoto").onclick = camOpen;
    el("camClose").onclick = camClose;
    el("camDone").onclick = camClose;
    el("camShot").onclick = camShoot;
    el("camTorch").onclick = camToggleTorch;
    el("camFlip").onclick = camSwitch;
    el("shootNative").onclick = function () { el("inPhoto").value = ""; el("inPhoto").click(); };
    el("shootVideo").onclick = function () { el("inVideo").value = ""; el("inVideo").click(); };
    el("shootPick").onclick = function () { el("inPick").value = ""; el("inPick").click(); };
    ["inPhoto", "inVideo", "inPick"].forEach(function (id) {
      el(id).onchange = function () { addFiles(this.files); };
    });
    el("shootRetry").onclick = function () {
      DCR.uploadQueue.retryAll();
    };

    // Coming back from another app: resume anything left hanging. iOS also
    // freezes the camera stream while away, so nudge it back.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) return;
      DCR.uploadQueue.start();
      if (cam.open) el("camVideo").play().catch(function () {});
    });

    try {
      var d = await DCR.api("/api/portal?action=board");
      state.all = d.projects || [];
      state.pool = state.all.filter(eligible);
    } catch (e) {
      msg("pickMsg", "err", e.message || "Could not load the project list.");
      return;
    }
    renderPick();
    locate();
  });
})();
