/* DCR portal — phone-optimized Time Sheet.
   Same backend as the desktop page (action=roster / action=timesheets), same auth,
   same crew-scope enforcement, same leave-day + dateTime/number handling. */

var allItems = [];
var employeeList = [];   // [{ name, employeeId, start1, end1, start2, end2, lunch }]
var tsScopeInfo = null;  // "*" or { self, managed:[...] }
var editingId = null;

var LEAVE_TYPES = ["Holiday", "Vacation", "Sick", "Day Off"];
function isLeaveType(t) { return LEAVE_TYPES.indexOf(t) !== -1; }
function currentDayType() { return document.getElementById("tsDayType").value; }

function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtDate(v) { if(!v) return ""; var d=new Date(v); return isNaN(d)?"":d.toISOString().split("T")[0]; }
function niceDate(d) { if(!d) return ""; return new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); }
function el(id){ return document.getElementById(id); }

/* ── time helpers (identical conventions to desktop) ── */
function tsParseSpTime(iso){ if(!iso) return null; var d=new Date(iso); if(isNaN(d)) return null; return {hours:d.getHours(),minutes:d.getMinutes()}; } // wall-clock time via the stored instant's own UTC offset (no DST re-anchoring — see timesheet.js)
function tsTimeToStr(h,m){ return String(h).padStart(2,"0")+":"+String(m||0).padStart(2,"0"); }
function tsTimeToDisplay(h,m){ var a=h>=12?"PM":"AM"; var h12=h%12||12; return h12+":"+String(m||0).padStart(2,"0")+" "+a; }
function tsParseTimeInput(id){ var v=el(id).value; if(!v) return null; var p=v.split(":"); return {hours:parseInt(p[0]),minutes:parseInt(p[1]||0)}; }
function tsTimeToMinutes(t){ return t? t.hours*60+t.minutes : 0; }
function tsMinutesToTime(m){ return {hours:Math.floor(m/60),minutes:m%60}; }
function tsTimeToISO(id,dateStr){ var t=tsParseTimeInput(id); if(!t||!dateStr) return null; var p=String(dateStr).split("-"); if(p.length!==3) return null; var d=new Date(+p[0],+p[1]-1,+p[2],t.hours,t.minutes,0,0); return isNaN(d)?null:d.toISOString(); }
function tsIsoToDisplay(iso){ var t=tsParseSpTime(iso); return t?tsTimeToDisplay(t.hours,t.minutes):""; }

/* ── employee defaults / schedule auto-calc ── */
function tsGetDefaults(){
  var name=el("tsName").value.trim(); if(!name) return null;
  var e=employeeList.find(function(x){return (x.name||"").toLowerCase()===name.toLowerCase();});
  if(!e) return null;
  return { start1:tsParseSpTime(e.start1), end1:tsParseSpTime(e.end1), start2:tsParseSpTime(e.start2), end2:tsParseSpTime(e.end2), lunch:parseFloat(e.lunch)||1 };
}
function tsAutoCalcSchedule(){
  if(isLeaveType(currentDayType())){ el("tsScheduleSection").style.display="none"; return; }
  var hours=parseFloat(el("tsHours").value)||0;
  var def=tsGetDefaults();
  if(hours<=0 || !def || !def.start1){ el("tsScheduleSection").style.display="none"; return; }
  el("tsScheduleSection").style.display="";
  var s1=tsTimeToMinutes(def.start1), e1=tsTimeToMinutes(def.end1), s2=tsTimeToMinutes(def.start2);
  var cap=(e1-s1)/60, total=hours*60;
  if(hours<=cap){
    el("tsStart1").value=tsTimeToStr(def.start1.hours,def.start1.minutes);
    var ce1=tsMinutesToTime(s1+total); el("tsEnd1").value=tsTimeToStr(ce1.hours,ce1.minutes);
    el("tsLunch").value=0; el("tsStart2").value=""; el("tsEnd2").value="";
  } else {
    el("tsStart1").value=tsTimeToStr(def.start1.hours,def.start1.minutes);
    el("tsEnd1").value=tsTimeToStr(def.end1.hours,def.end1.minutes);
    el("tsLunch").value=def.lunch;
    el("tsStart2").value=tsTimeToStr(def.start2.hours,def.start2.minutes);
    var rem=total-(e1-s1); var ce2=tsMinutesToTime(s2+rem); el("tsEnd2").value=tsTimeToStr(ce2.hours,ce2.minutes);
  }
  tsRecalc();
}
function tsRecalc(){
  var s1=tsParseTimeInput("tsStart1"),e1=tsParseTimeInput("tsEnd1"),s2=tsParseTimeInput("tsStart2"),e2=tsParseTimeInput("tsEnd2");
  var lunch=parseFloat(el("tsLunch").value)||0, entered=parseFloat(el("tsHours").value)||0;
  var calc=0; if(s1&&e1) calc+=(tsTimeToMinutes(e1)-tsTimeToMinutes(s1))/60; if(s2&&e2) calc+=(tsTimeToMinutes(e2)-tsTimeToMinutes(s2))/60;
  var lr=el("tsLunchRange");
  if(e1&&lunch>0){ var le=tsMinutesToTime(tsTimeToMinutes(e1)+lunch*60); lr.textContent="Lunch "+tsTimeToDisplay(e1.hours,e1.minutes)+"–"+tsTimeToDisplay(le.hours,le.minutes); }
  else lr.textContent=lunch>0?"":"No lunch";
  var bar=el("tsCalcBar");
  if(entered<=0){ bar.innerHTML=""; return; }
  var match=Math.abs(calc-entered)<0.01;
  bar.innerHTML='<div class="m-calc '+(match?"match":"mismatch")+'"><span>Calculated: '+calc.toFixed(1)+'h</span><span>'+(match?"✓ Matches "+entered+"h":"⚠ Entered "+entered+"h")+'</span></div>';
}

/* ── hours stepper ── */
function adjustHours(d){ var i=el("tsHours"); var n=Math.round(((parseFloat(i.value)||0)+d)*2)/2; if(n<0)n=0; if(n>24)n=24; i.value=n; tsAutoCalcSchedule(); }
function syncHoursInput(){ var i=el("tsHours"); var v=i.value.replace(/[^0-9.]/g,""); if(v!==i.value)i.value=v; tsAutoCalcSchedule(); }
function cleanHoursInput(){ var i=el("tsHours"); var n=parseFloat(i.value); i.value=(isNaN(n)||n<0)?0:(n>24?24:n); tsAutoCalcSchedule(); }

/* ── day type (segmented) ── */
function setDayType(type){
  el("tsDayType").value=type;
  Array.prototype.forEach.call(document.querySelectorAll("#daySeg button"),function(b){ b.classList.toggle("active", b.getAttribute("data-type")===type); });
  var proj=el("tsProject");
  if(isLeaveType(type)){
    proj.value=type; el("projField").style.display="none";
    el("tsScheduleSection").style.display="none";
  } else {
    el("projField").style.display="";
    if(LEAVE_TYPES.indexOf(proj.value)!==-1) proj.value="";
    tsAutoCalcSchedule();
  }
}

/* ── employee scope ── */
function setEmployee(name,id){ el("tsName").value=name||""; el("tsEmployeeID").value=id||""; }
function onEmpChange(){ var s=el("tsEmpSelect"); var o=s.options[s.selectedIndex]; setEmployee(s.value,o?o.getAttribute("data-id"):""); renderEntries(); tsAutoCalcSchedule(); }
function onDateChange(){ tsAutoCalcSchedule(); }
function applyScopeUI(){
  var sel=el("tsEmpSelect"), ro=el("empReadonly"), note=el("empScopeNote");
  var self=(tsScopeInfo && tsScopeInfo.self)||"";
  sel.innerHTML='<option value="">Select employee…</option>'+employeeList.map(function(e){ return '<option value="'+escHtml(e.name)+'" data-id="'+escHtml(e.employeeId)+'">'+escHtml(e.name)+'</option>'; }).join("");
  if(tsScopeInfo!=="*" && employeeList.length<=1){
    var only=employeeList[0];
    if(only){ setEmployee(only.name,only.employeeId); ro.textContent=only.name; }
    else { setEmployee(self,""); ro.textContent=self||"—"; }
    ro.style.display=""; sel.style.display="none";
    note.textContent="Logging time for yourself.";
    if(!self && !only){ el("submitBtn").disabled=true; note.innerHTML='<span style="color:var(--err)">Your account isn’t linked to an employee yet — ask an admin.</span>'; }
  } else {
    ro.style.display="none"; sel.style.display="";
    if(self){ sel.value=self; onEmpChange(); }
    note.textContent=(tsScopeInfo==="*")?"You can log time for any employee.":("You and your crew ("+(((tsScopeInfo&&tsScopeInfo.managed)||[]).length)+").");
  }
}

/* ── entries list ── */
function renderEntries(){
  var area=el("listArea"); var cur=el("tsName").value.trim();
  el("listNote").textContent = cur ? ("Showing: "+cur) : "Showing all entries you can access.";
  var items=allItems.filter(function(x){ if(!cur) return true; return (x.timeSheetEmployeeName||"").toLowerCase()===cur.toLowerCase(); });
  if(!items.length){ area.innerHTML='<div class="m-empty">No entries in the last two weeks.</div>'; return; }
  items.sort(function(a,b){ return new Date(b.timeSheetDate)-new Date(a.timeSheetDate); });
  var html="", last="";
  items.forEach(function(it){
    var d=fmtDate(it.timeSheetDate);
    if(d!==last){ last=d; html+='<div class="m-daylabel">'+escHtml(niceDate(d))+'</div>'; }
    html+=entryCard(it);
  });
  area.innerHTML=html;
  area.querySelectorAll("[data-view]").forEach(function(b){ b.onclick=function(){ viewEntry(b.getAttribute("data-view")); }; });
  area.querySelectorAll("[data-edit]").forEach(function(b){ b.onclick=function(){ editEntry(b.getAttribute("data-edit")); }; });
  area.querySelectorAll("[data-del]").forEach(function(b){ b.onclick=function(){ deleteEntry(b.getAttribute("data-del")); }; });
}
function entryCard(it){
  var proj=it.timeSheetProjectName||"—", leave=isLeaveType(proj);
  var work=it.timeSheetWorkCompleted||"";
  var h='<div class="m-entry">';
  h+='<div class="m-entry-top"><div><div class="m-entry-proj">'+escHtml(proj)+'</div>';
  if(work) h+='<div class="m-entry-work">'+escHtml(work.length>90?work.slice(0,90)+"…":work)+'</div>';
  h+='</div><span class="m-badge'+(leave?" leave":"")+'">'+(it.timeSheetWorkHours||0)+'h</span></div>';
  h+='<div class="m-entry-actions"><button data-view="'+it.id+'">View</button><button data-edit="'+it.id+'">Edit</button><button class="del" data-del="'+it.id+'">Delete</button></div>';
  h+='</div>';
  return h;
}

/* ── view / edit / delete ── */
function viewEntry(id){
  var it=allItems.find(function(x){return x.id==id;}); if(!it) return;
  var sched="";
  if(it.timeSheetWorkStatTime){ sched=it.timeSheetWorkStatTime+(it.timeSheetWorkEndTime?"–"+it.timeSheetWorkEndTime:""); if(it.timeSheetWorkStatTime2) sched+=" / "+it.timeSheetWorkStatTime2+(it.timeSheetWorkEndTime2?"–"+it.timeSheetWorkEndTime2:""); }
  var rows=[["Employee",it.timeSheetEmployeeName],["Project",it.timeSheetProjectName],["Date",niceDate(fmtDate(it.timeSheetDate))],["Hours",(it.timeSheetWorkHours||0)+" hrs"]];
  if(sched) rows.push(["Schedule",sched]);
  if(it.timeSheetWorkCompleted) rows.push(["Work",it.timeSheetWorkCompleted]);
  showSheet('<h3>Time entry</h3>'+rows.map(function(r){return '<div class="m-krow"><span>'+escHtml(r[0])+'</span><span>'+escHtml(r[1]||"—")+'</span></div>';}).join("")+
    '<div class="m-sheet-actions"><button onclick="closeSheet();editEntry(\''+id+'\')">Edit</button><button class="del" style="color:var(--err)" onclick="closeSheet();deleteEntry(\''+id+'\')">Delete</button><button onclick="closeSheet()">Close</button></div>');
}
function editEntry(id){
  var it=allItems.find(function(x){return x.id==id;}); if(!it) return;
  editingId=id;
  var proj=it.timeSheetProjectName||"";
  if(!el("tsName").disabled && el("tsEmpSelect").style.display!=="none"){ el("tsEmpSelect").value=it.timeSheetEmployeeName||""; setEmployee(it.timeSheetEmployeeName||"", it.timeSheetProployeeID||""); }
  setDayType(isLeaveType(proj)?proj:"Worked");
  el("tsProject").value=proj;
  el("tsDate").value=fmtDate(it.timeSheetDate);
  el("tsHours").value=it.timeSheetWorkHours||0;
  el("tsWork").value=it.timeSheetWorkCompleted||"";
  if(!isLeaveType(proj) && it.timeSheetWorkStatTime){
    el("tsScheduleSection").style.display="";
    el("tsStart1").value=dispToInput(it.timeSheetWorkStatTime);
    el("tsEnd1").value=dispToInput(it.timeSheetWorkEndTime);
    el("tsLunch").value=it.timeSheetWorkLunchTime||"0";
    el("tsStart2").value=dispToInput(it.timeSheetWorkStatTime2);
    el("tsEnd2").value=dispToInput(it.timeSheetWorkEndTime2);
    tsRecalc();
  }
  el("formTitle").textContent="Edit entry";
  el("submitBtn").textContent="✓ Save changes";
  el("cancelBtn").style.display="";
  window.scrollTo({top:0,behavior:"smooth"});
  renderEntries();
}
function dispToInput(v){ if(!v) return ""; v=String(v).trim().toUpperCase(); var m=v.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/); if(m){ var h=parseInt(m[1]); if(m[3]==="PM"&&h!==12)h+=12; if(m[3]==="AM"&&h===12)h=0; return tsTimeToStr(h,parseInt(m[2])); } if(v.match(/^\d{2}:\d{2}$/)) return v; return ""; }
function deleteEntry(id){
  showSheet('<h3>Delete this entry?</h3><p class="m-note">This cannot be undone.</p><div class="m-sheet-actions"><button onclick="closeSheet()">Cancel</button><button class="del" style="color:var(--err)" onclick="closeSheet();confirmDelete(\''+id+'\')">Delete</button></div>');
}
async function confirmDelete(id){
  try{ await DCR.api("/api/portal?action=timesheets",{method:"DELETE",body:{itemId:id}}); await loadData(); }
  catch(e){ alert("Error deleting: "+(e.message||"try again")); }
}

/* ── submit ── */
async function submitEntry(){
  var msg=el("formMsg"); msg.className="m-msg";
  var type=currentDayType(), leave=isLeaveType(type);
  var name=el("tsName").value.trim();
  var employeeID=el("tsEmployeeID").value.trim();
  var project=leave?type:el("tsProject").value.trim();
  var date=el("tsDate").value, hours=el("tsHours").value, work=el("tsWork").value.trim();

  if(leave){ if(!name||!date){ return showMsg("err","Please choose an employee and a date."); } }
  else if(!name||!project||!date||!hours||parseFloat(hours)<=0){ return showMsg("err","Complete the fields and set hours above 0."); }

  var s1=tsParseTimeInput("tsStart1"),e1=tsParseTimeInput("tsEnd1"),s2=tsParseTimeInput("tsStart2"),e2=tsParseTimeInput("tsEnd2");
  var calc=0; if(s1&&e1) calc+=(tsTimeToMinutes(e1)-tsTimeToMinutes(s1))/60; if(s2&&e2) calc+=(tsTimeToMinutes(e2)-tsTimeToMinutes(s2))/60;

  var fields={
    timeSheetEmployeeName:name, timeSheetProjectName:project, timeSheetDate:date,
    timeSheetWorkHours:Number(hours), timeSheetWorkCompleted:work,
    timeSheetWorkStatTime:tsTimeToISO("tsStart1",date), timeSheetWorkEndTime:tsTimeToISO("tsEnd1",date),
    timeSheetWorkLunchTime:Number(el("tsLunch").value)||0,
    timeSheetWorkStatTime2:tsTimeToISO("tsStart2",date), timeSheetWorkEndTime2:tsTimeToISO("tsEnd2",date),
    timeSheetWorkCalculatedHours:Number(calc)
  };
  if(employeeID) fields.timeSheetProployeeID=Number(employeeID);

  showMsg("", "Saving…"); el("submitBtn").disabled=true;
  try{
    var opts=editingId?{method:"PATCH",body:{itemId:editingId,fields:fields}}:{method:"POST",body:{fields:fields}};
    await DCR.api("/api/portal?action=timesheets",opts);
    showMsg("ok","✓ Saved."); clearForm(); await loadData(); setTimeout(function(){msg.className="m-msg";},3500);
  }catch(e){ showMsg("err",e.message||"Save failed."); }
  el("submitBtn").disabled=false;
}
function showMsg(kind,text){ var m=el("formMsg"); m.textContent=text; m.className="m-msg show"+(kind?" "+kind:""); }
function clearForm(){
  editingId=null; setDayType("Worked");
  el("tsProject").value=""; el("tsDate").value=todayStr(); el("tsHours").value=0; el("tsWork").value="";
  el("tsStart1").value=""; el("tsEnd1").value=""; el("tsLunch").value="1"; el("tsStart2").value=""; el("tsEnd2").value="";
  el("tsScheduleSection").style.display="none"; el("tsCalcBar").innerHTML="";
  el("formTitle").textContent="New entry"; el("submitBtn").textContent="✓ Submit time sheet"; el("cancelBtn").style.display="none";
}
function cancelEdit(){ clearForm(); el("formMsg").className="m-msg"; }
function todayStr(){ var d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }

/* ── bottom sheet modal ── */
function showSheet(html){ el("modalContainer").innerHTML='<div class="m-overlay" onclick="if(event.target===this)closeSheet()"><div class="m-sheet">'+html+'</div></div>'; }
function closeSheet(){ el("modalContainer").innerHTML=""; }

/* ── data ── */
async function loadEmployees(){ try{ var d=await DCR.api("/api/portal?action=roster"); employeeList=d.employees||[]; tsScopeInfo=d.scope; applyScopeUI(); }catch(e){ console.error("roster:",e.message); } }
async function loadData(){
  el("listArea").innerHTML='<div class="m-empty">Loading…</div>';
  try{
    var d=await DCR.api("/api/portal?action=timesheets");
    allItems=(d.items||[]).map(function(it){
      it.timeSheetWorkStatTime=tsIsoToDisplay(it.timeSheetWorkStatTime);
      it.timeSheetWorkEndTime=tsIsoToDisplay(it.timeSheetWorkEndTime);
      it.timeSheetWorkStatTime2=tsIsoToDisplay(it.timeSheetWorkStatTime2);
      it.timeSheetWorkEndTime2=tsIsoToDisplay(it.timeSheetWorkEndTime2);
      return it;
    });
    if(d.scope) tsScopeInfo=d.scope;
    var dl=el("tsProjList"); dl.innerHTML=""; (d.projectNames||[]).forEach(function(n){ var o=document.createElement("option"); o.value=n; dl.appendChild(o); });
    renderEntries();
  }catch(e){ el("listArea").innerHTML='<div class="m-empty">'+escHtml(e.message||"Error loading.")+'</div>'; }
}

document.addEventListener("DOMContentLoaded", async function(){
  var profile=await DCR.requireAuth();
  el("userPill").textContent=(profile.displayName||profile.email);
  el("logoutBtn").onclick=function(){ DCR.logout(); };
  document.querySelectorAll("#daySeg button").forEach(function(b){ b.onclick=function(){ setDayType(b.getAttribute("data-type")); }; });
  el("tsDate").value=todayStr();
  await loadEmployees();
  await loadData();
});
