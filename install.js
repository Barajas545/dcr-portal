/* Small "Install app" hint. Shows a button ONLY when the portal can actually be
   installed and isn't already installed — and hides itself once installed.
     • Chrome/Edge/Android: one tap runs the native install prompt.
     • iOS Safari (no install API): shows the Add-to-Home-Screen steps.
   Mounts into an #installSlot element if present, else floats bottom-center.
   Include this only on the pages where the hint should appear (login + home). */
(function () {
  // Already running as the installed app? Then there's nothing to install.
  var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator.standalone === true;
  if (standalone) return;

  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 13+ reports as Mac

  var deferred = null;   // the saved beforeinstallprompt event (Chrome/Edge/Android)
  var domReady = false;
  var btnEl = null, toastEl = null;

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();            // stop the mini-infobar; we drive it from our button
    deferred = e;
    if (domReady) show();
  });
  window.addEventListener("appinstalled", function () {
    deferred = null;
    if (btnEl) btnEl.style.display = "none";
  });

  function ready() {
    domReady = true;
    if (deferred || isIOS) show();  // Android/desktop once eligible; iOS always offers the manual path
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();

  function show() {
    if (!btnEl) {
      btnEl = document.createElement("button");
      btnEl.type = "button";
      btnEl.id = "dcrInstallBtn";
      btnEl.className = "btn btn-ghost btn-sm";
      btnEl.textContent = "📲 Install app";
      btnEl.title = "Install this portal as an app on your device";
      btnEl.addEventListener("click", onClick);
      var slot = document.getElementById("installSlot");
      if (slot) {
        slot.appendChild(btnEl);
      } else {
        btnEl.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);" +
          "z-index:9999;box-shadow:0 3px 14px rgba(0,0,0,.28);";
        document.body.appendChild(btnEl);
      }
    }
    btnEl.style.display = "inline-flex";
  }

  function onClick() {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; if (btnEl) btnEl.style.display = "none"; });
    } else if (isIOS) {
      toast("To install: tap the <b>Share</b> button (the square with an ↑) at the bottom of Safari, then choose <b>“Add to Home Screen.”</b>");
    } else {
      toast("Open your browser menu and choose <b>“Install app”</b> or <b>“Add to Home screen.”</b>");
    }
  }

  function toast(html) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText = "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:330px;" +
        "background:#171d25;color:#e6ebf1;border:1px solid #2a333d;border-radius:12px;padding:12px 15px;" +
        "font-size:13px;line-height:1.5;box-shadow:0 6px 24px rgba(0,0,0,.45);z-index:10000;cursor:pointer;text-align:center;";
      toastEl.addEventListener("click", function () { toastEl.style.display = "none"; });
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = html;
    toastEl.style.display = "block";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.style.display = "none"; }, 9000);
  }
})();
