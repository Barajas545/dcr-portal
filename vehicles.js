/* DCR portal — Vehicle Board (web port of the Access VehicleBoard form).
   Data via action=vehicles: vehicleInformation + vehicleMaintenance lists.
   Due logic mirrors Access: oil due = lastOilChangeDate + oilChangeIntervalMonths
   ≤ end of current month; service due = OPEN maintenance rows (no completion
   date) with nextServiceDate ≤ end of current month. */

(function () {
  var state = { vehicles: [], maint: [], canMaint: false, canVehicle: false, selId: null, search: "", doneItem: null };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (v) { return DCR.esc(v); };

  function fmtDate(v){ if(!v)return "—"; var d=new Date(v); return isNaN(d)?String(v):d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}); }
  function endOfMonth(){ var d=new Date(); return new Date(d.getFullYear(), d.getMonth()+1, 0, 23,59,59); }
  function addMonths(date, m){ var d=new Date(date); if(isNaN(d))return null; d.setMonth(d.getMonth()+Number(m||0)); return d; }

  // Access-style label: Fleet# - Lic# … - Description
  function vLabel(v) {
    var parts = [];
    if (v.fleetNumber) parts.push(String(v.fleetNumber));
    if (v.licensePlateNumber) parts.push("Lic# " + v.licensePlateNumber);
    if (v.vehicleDescription) parts.push(v.vehicleDescription);
    return parts.join(" - ") || ("Vehicle " + v.id);
  }

  function oilDue(v) {
    if (!v.lastOilChangeDate || !v.oilChangeIntervalMonths) return null;
    var due = addMonths(v.lastOilChangeDate, v.oilChangeIntervalMonths);
    if (!due) return null;
    return due <= endOfMonth() ? due : null;
  }

  function isOpen(m){ return !m.serviceCompletionDate; }
  function openMaintFor(vid){ return state.maint.filter(function(m){ return isOpen(m) && String(m.vehicleID)===String(vid); }); }

  function svcDueRows() {
    var eom = endOfMonth();
    return state.maint.filter(function(m){
      return isOpen(m) && m.nextServiceDate && new Date(m.nextServiceDate) <= eom;
    }).sort(function(a,b){ return new Date(a.nextServiceDate)-new Date(b.nextServiceDate); });
  }

  function vehById(id){ return state.vehicles.find(function(v){ return String(v.id)===String(id); }); }

  /* ── render ── */
  function rowHtml(v, dueTxt, dueCls) {
    var sel = String(v.id)===String(state.selId) ? " sel" : "";
    return '<div class="vb-row'+sel+'" data-vid="'+esc(v.id)+'"><span>'+esc(vLabel(v))+'</span>' +
      (dueTxt?'<span class="due '+dueCls+'">'+esc(dueTxt)+'</span>':"")+'</div>';
  }

  function render() {
    var q = state.search.toLowerCase();
    var match = function(v){ return !q || vLabel(v).toLowerCase().indexOf(q)!==-1; };
    var today = new Date();

    var oil = state.vehicles.map(function(v){ return { v:v, due:oilDue(v) }; })
      .filter(function(x){ return x.due && match(x.v); })
      .sort(function(a,b){ return a.due-b.due; });
    el("vbOilCount").textContent = oil.length;
    el("vbOilList").innerHTML = oil.map(function(x){
      return rowHtml(x.v, fmtDate(x.due), x.due<today?"over":"soon");
    }).join("") || '<div class="vb-empty">No oil changes due this month.</div>';

    var svc = svcDueRows().filter(function(m){ var v=vehById(m.vehicleID); return v&&match(v); });
    el("vbSvcCount").textContent = svc.length;
    el("vbSvcList").innerHTML = svc.map(function(m){
      var v = vehById(m.vehicleID) || {};
      var due = new Date(m.nextServiceDate);
      return '<div class="vb-row'+(String(v.id)===String(state.selId)?" sel":"")+'" data-vid="'+esc(v.id||"")+'">' +
        '<span>'+esc(vLabel(v))+'<br><span class="vb-sub">'+esc(m.nextServiceRequirements||m.serviceDescription||"Service")+'</span></span>' +
        '<span class="due '+(due<today?"over":"soon")+'">'+fmtDate(m.nextServiceDate)+'</span></div>';
    }).join("") || '<div class="vb-empty">No services due this month.</div>';

    var all = state.vehicles.filter(match).sort(function(a,b){ return vLabel(a).localeCompare(vLabel(b)); });
    el("vbAllCount").textContent = all.length;
    el("vbAllList").innerHTML = all.map(function(v){
      var open = openMaintFor(v.id).length;
      return rowHtml(v, open?open+" open":"", "soon");
    }).join("") || '<div class="vb-empty">No vehicles.</div>';

    document.querySelectorAll("[data-vid]").forEach(function(r){
      r.addEventListener("click", function(){ selectVehicle(r.getAttribute("data-vid")); });
    });
  }

  /* ── panel ── */
  function selectVehicle(id) {
    state.selId = id;
    var v = vehById(id);
    if (!v) return;
    render();
    el("vbPanel").style.display = "";
    el("vpName").textContent = vLabel(v);
    el("vpSub").textContent = [v.vehicleYear, v.vehicleMake, v.vehicleModel].filter(Boolean).join(" ");
    var due = oilDue(v);
    var next = (v.lastOilChangeDate && v.oilChangeIntervalMonths) ? addMonths(v.lastOilChangeDate, v.oilChangeIntervalMonths) : null;
    el("vpInfo").innerHTML =
      kv("Driver", v.vehicleDriverInformation) + kv("Plate", v.licensePlateNumber) +
      kv("VIN", v.vehicleVIN) + kv("Mileage", v.currentMileage) +
      kv("Last oil change", v.lastOilChangeDate?fmtDate(v.lastOilChangeDate):null) +
      kv("Oil interval", v.oilChangeIntervalMonths?v.oilChangeIntervalMonths+" months":null) +
      kv("Next oil due", next?('<span style="font-weight:700;color:'+(due?"var(--err)":"var(--ok)")+'">'+fmtDate(next)+"</span>"):null, true) +
      kv("Registration exp.", v.registrationExpirationDate?fmtDate(v.registrationExpirationDate):null);

    var open = openMaintFor(id);
    el("vpOpen").innerHTML = open.map(function(m){
      return '<div class="vb-maint"><div class="d">'+(m.nextServiceDate?"Due "+fmtDate(m.nextServiceDate):"No date")+'</div>' +
        esc(m.nextServiceRequirements||m.serviceDescription||"Service") +
        (state.canMaint?'<div style="margin-top:7px"><button class="vb-btn vb-btn-sm" data-done="'+m.id+'">✓ Complete</button></div>':"")+'</div>';
    }).join("") || '<div class="vb-empty">Nothing scheduled.</div>';

    var hist = state.maint.filter(function(m){ return !isOpen(m) && String(m.vehicleID)===String(id); })
      .sort(function(a,b){ return new Date(b.serviceCompletionDate)-new Date(a.serviceCompletionDate); }).slice(0,10);
    el("vpHistory").innerHTML = hist.map(function(m){
      return '<div class="vb-maint"><div class="d">'+fmtDate(m.serviceCompletionDate)+'</div>' +
        esc(m.servicePerformed||m.serviceDescription||m.nextServiceRequirements||"Service")+'</div>';
    }).join("") || '<div class="vb-empty">No completed services.</div>';

    el("vpOpen").querySelectorAll("[data-done]").forEach(function(b){
      b.onclick = function(){ openDoneModal(b.getAttribute("data-done")); };
    });
    el("vpMsg").textContent = "";
  }

  function kv(k, v, raw) {
    if (v==null || v==="") return "";
    return '<div class="vb-kv"><span class="k">'+k+'</span><span>'+(raw?v:esc(v))+'</span></div>';
  }

  /* ── schedule modal ── */
  function openSchedModal() {
    el("smMsg").textContent = "";
    el("smVehicle").innerHTML = state.vehicles.slice().sort(function(a,b){ return vLabel(a).localeCompare(vLabel(b)); })
      .map(function(v){ return '<option value="'+esc(v.id)+'"'+(String(v.id)===String(state.selId)?" selected":"")+'>'+esc(vLabel(v))+'</option>'; }).join("");
    el("schedModal").classList.add("open");
  }

  async function saveSched() {
    el("smSave").disabled = true; el("smMsg").textContent = "";
    try {
      await DCR.api("/api/portal?action=vehicles", { method:"POST", body:{
        op:"maintAdd", vehicleId: el("smVehicle").value,
        nextServiceDate: el("smDate").value ? el("smDate").value + "T12:00:00Z" : "",
        nextServiceRequirements: el("smReq").value.trim(),
      }});
      el("schedModal").classList.remove("open");
      el("smReq").value=""; el("smDate").value="";
      await load(); if (state.selId) selectVehicle(state.selId);
    } catch (e) { el("smMsg").textContent = e.message || "Save failed"; }
    el("smSave").disabled = false;
  }

  /* ── complete modal ── */
  function openDoneModal(itemId) {
    state.doneItem = state.maint.find(function(m){ return String(m.id)===String(itemId); });
    if (!state.doneItem) return;
    el("dmWhat").textContent = state.doneItem.nextServiceRequirements || state.doneItem.serviceDescription || "Service";
    el("dmWork").value = ""; el("dmMiles").value = ""; el("dmOil").checked = false; el("dmMsg").textContent = "";
    el("doneModal").classList.add("open");
  }

  async function saveDone() {
    el("dmSave").disabled = true; el("dmMsg").textContent = "";
    try {
      await DCR.api("/api/portal?action=vehicles", { method:"POST", body:{
        op:"maintComplete", itemId: state.doneItem.id, vehicleId: state.doneItem.vehicleID,
        servicePerformed: el("dmWork").value.trim(),
        currentMileage: el("dmMiles").value.trim(),
        isOilChange: el("dmOil").checked,
      }});
      el("doneModal").classList.remove("open");
      await load(); if (state.selId) selectVehicle(state.selId);
    } catch (e) { el("dmMsg").textContent = e.message || "Save failed"; }
    el("dmSave").disabled = false;
  }

  /* ── data ── */
  async function load() {
    try {
      var d = await DCR.api("/api/portal?action=vehicles");
      state.vehicles = d.vehicles || [];
      state.maint = d.maintenance || [];
      state.canMaint = !!d.canMaint;
      el("vbSchedBtn").style.display = state.canMaint ? "" : "none";
      render();
    } catch (e) {
      el("vbAllList").innerHTML = '<div class="vb-empty">'+esc(e.message||"Error loading vehicles.")+'</div>';
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    var profile = await DCR.requireAuth();
    el("companyName").textContent = DCR.company + " Portal";
    el("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
    el("logoutBtn").onclick = function(){ DCR.logout(); };
    el("vbSearch").addEventListener("input", function(){ state.search = this.value; render(); });
    el("vbRefresh").onclick = function(){ load().then(function(){ if(state.selId) selectVehicle(state.selId); }); };
    el("vbSchedBtn").onclick = openSchedModal;
    el("smCancel").onclick = function(){ el("schedModal").classList.remove("open"); };
    el("smSave").onclick = saveSched;
    el("dmCancel").onclick = function(){ el("doneModal").classList.remove("open"); };
    el("dmSave").onclick = saveDone;
    [el("schedModal"), el("doneModal")].forEach(function(m){ m.addEventListener("click", function(e){ if(e.target===m) m.classList.remove("open"); }); });
    await load();
  });
})();
