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

  var CHUNK = 320 * 1024 * 24;          // 7.5 MiB, 320KiB-aligned (Graph requirement)
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
    jobs: [],          // upload jobs
    seq: 0,
    busy: false,
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

  function addFiles(files) {
    if (!files || !files.length) return;
    var now = new Date();
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || !f.size) continue;
      var isVid = String(f.type || "").indexOf("video/") === 0 || /\.(mov|mp4|m4v|avi|3gp)$/i.test(f.name || "");
      state.seq++;
      state.jobs.push({
        id: state.seq,
        file: f,
        // Sorts chronologically in SharePoint and never collides within a second.
        name: (isVid ? "VID " : "IMG ") + stamp(now) + (state.seq > 1 ? "-" + state.seq : "") + extOf(f),
        size: f.size,
        sent: 0,
        status: "queued",
        error: "",
        attempts: 0,
      });
    }
    renderJobs();
    pump();
  }

  function renderJobs() {
    var host = el("shootList");
    if (!state.jobs.length) { host.innerHTML = ""; el("shootRetryRow").classList.add("cp-hide"); return; }
    host.innerHTML = state.jobs.map(function (j) {
      var shown = j.live != null ? j.live : j.sent;
      var pct = j.status === "done" ? 100 : (j.size ? Math.round((shown / j.size) * 100) : 0);
      var cls = j.status === "done" ? " done" : (j.status === "failed" ? " err" : "");
      var txt = j.status === "done" ? "✓ Saved"
        : j.status === "failed" ? "✕ " + (j.error || "Failed")
        : j.status === "uploading" ? pct + "%"
        : j.status === "retrying" ? "No signal — retrying"
        : "Waiting";
      return '<div class="cp-up' + cls + '"><div class="cp-upt">' +
        '<span class="cp-upn">' + esc(j.name) + "</span>" +
        '<span class="cp-ups' + cls + '">' + esc(txt) + " · " + fmtSize(j.size) + "</span></div>" +
        '<div class="cp-bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join("");

    var failed = state.jobs.filter(function (j) { return j.status === "failed"; }).length;
    el("shootRetryRow").classList.toggle("cp-hide", !failed);

    var doneN = state.jobs.filter(function (j) { return j.status === "done"; }).length;
    var pending = state.jobs.length - doneN - failed;
    if (pending) msg("shootMsg", "", "Uploading " + pending + " file" + (pending === 1 ? "" : "s") + " — keep this screen open.");
    else if (failed) msg("shootMsg", "err", doneN + " saved, " + failed + " failed.");
    else if (doneN) msg("shootMsg", "ok", "✓ All " + doneN + " file" + (doneN === 1 ? "" : "s") + " saved to " + state.week + ".");
    else msg("shootMsg", "", "");
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
    } catch (e) { /* not supported / not allowed — the beforeunload warning still applies */ }
  }

  function nextJob() {
    for (var i = 0; i < state.jobs.length; i++) {
      var s = state.jobs[i].status;
      if (s === "queued" || s === "retrying") return state.jobs[i];
    }
    return null;
  }

  async function pump() {
    if (state.busy) return;
    var job = nextJob();
    if (!job) { holdScreen(false); return; }
    state.busy = true;
    holdScreen(true);
    try {
      await uploadJob(job);
      job.status = "done";
      job.sent = job.size;
      job.live = null;
    } catch (e) {
      // Anything network-shaped keeps trying: a van driving out of signal must
      // not turn into a lost photo. Only a refusal from the API is terminal.
      if (e && e.fatal) {
        job.status = "failed";
        job.error = e.message || "Upload failed";
      } else {
        job.attempts++;
        job.status = "retrying";
        job.error = "";
        var wait = Math.min(30000, 2000 * Math.pow(2, Math.min(4, job.attempts)));
        setTimeout(function () { state.busy = false; pump(); }, wait);
        renderJobs();
        return;
      }
    }
    state.busy = false;
    renderJobs();
    pump();
  }

  async function uploadJob(job) {
    if (!job.session) {
      var s;
      try {
        s = await DCR.api("/api/portal?action=drive", {
          method: "POST",
          body: {
            op: "uploadSession", projectId: state.project.id, target: "pictures",
            name: job.name, mimeType: job.file.type || "", weekFolder: state.week,
          },
        });
      } catch (e) {
        // A 4xx here is a real refusal (no access, bad name) — retrying won't help.
        var fatal = new Error(e.message || "Could not start the upload");
        fatal.fatal = /\b(400|401|403|404|409)\b/.test(String(e.message || ""));
        throw fatal;
      }
      job.session = s.uploadUrl;
      job.folder = s.folderName;
      job.sent = 0;
    }
    job.status = "uploading";
    renderJobs();

    var total = job.size;
    while (job.sent < total) {
      var start = job.sent, end = Math.min(start + CHUNK, total);
      await putChunk(job, start, end, total);
      job.sent = end;
      renderJobs();
    }
  }

  function putChunk(job, start, end, total) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open("PUT", job.session);
      x.setRequestHeader("Content-Range", "bytes " + start + "-" + (end - 1) + "/" + total);
      x.timeout = 180000;
      // job.sent is committed bytes; job.live is what the bar shows mid-chunk.
      // Only repaint when the whole-number percentage actually moves.
      var lastPct = -1;
      x.upload.onprogress = function (e) {
        if (!e.lengthComputable) return;
        job.live = start + e.loaded;
        var pct = total ? Math.round((job.live / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; renderJobs(); }
      };
      x.onload = function () {
        if (x.status === 200 || x.status === 201 || x.status === 202) return resolve();
        if (x.status === 404 || x.status === 410) {
          // The session expired — start it over on the next attempt.
          job.session = null; job.sent = 0; job.live = null;
          return reject(new Error("Upload session expired"));
        }
        if (x.status >= 400 && x.status < 500 && x.status !== 408 && x.status !== 429) {
          var f = new Error("Upload rejected (" + x.status + ")");
          f.fatal = true;
          return reject(f);
        }
        reject(new Error("Upload failed (" + x.status + ")"));
      };
      x.onerror = function () { reject(new Error("No connection")); };
      x.ontimeout = function () { reject(new Error("Timed out")); };
      x.send(job.file.slice(start, end));
    });
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
      "</b><br>Files upload as they are taken. Keep this screen open until each one says ✓ Saved.";
    show("stepShoot");

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
    el("shootDone").onclick = function () {
      var busy = state.jobs.some(function (j) { return j.status !== "done" && j.status !== "failed"; });
      if (busy && !confirm("Some files are still uploading. Leave anyway?")) return;
      state.jobs = []; renderJobs(); show("stepPick");
    };
    el("shootPhoto").onclick = function () { el("inPhoto").value = ""; el("inPhoto").click(); };
    el("shootVideo").onclick = function () { el("inVideo").value = ""; el("inVideo").click(); };
    el("shootPick").onclick = function () { el("inPick").value = ""; el("inPick").click(); };
    ["inPhoto", "inVideo", "inPick"].forEach(function (id) {
      el(id).onchange = function () { addFiles(this.files); };
    });
    el("shootRetry").onclick = function () {
      state.jobs.forEach(function (j) {
        if (j.status === "failed") { j.status = "queued"; j.attempts = 0; j.error = ""; j.session = null; j.sent = 0; }
      });
      renderJobs(); pump();
    };

    window.addEventListener("beforeunload", function (e) {
      if (state.jobs.some(function (j) { return j.status !== "done" && j.status !== "failed"; })) {
        e.preventDefault(); e.returnValue = "";
      }
    });
    // Coming back from the camera / another app: resume anything left hanging.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { holdScreen(true); pump(); }
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
