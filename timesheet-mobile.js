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

/* ── two-week calendar (last week + this week, Saturday first) ──
   The crew asked to SEE the fortnight rather than scroll a list: which days
   are logged, which are not, and the week's total at a glance. Each cell
   shows the hours and the job's street address, because on a phone the
   address is how a foreman recognises the job. The pure part (bounds, model)
   is exported on window.DCRTimesheetCalendar so it can be tested in node
   without a browser; everything that touches the DOM is in renderEntries. */
var DAY_NAMES=["Sat","Sun","Mon","Tue","Wed","Thu","Fri"];
var projectAddresses={};  // { "<project name as stored on rows>": "<short address>" } from the backend; {} on an old backend
var calDays={};           // day key -> [ids] of the entries drawn in that cell, for the tap handler
var dateNoticeTok=0;      // bumps on every "Date set to…" notice so only the latest timer may clear it

/* Same rule as the desktop page's getSaturdayOf: the company week starts on
   Saturday, so Saturday is its own week start and any other day walks back. */
function saturdayOf(date){ var d=new Date(date); d.setHours(0,0,0,0); var day=d.getDay(); d.setDate(d.getDate()-(day===6?0:day+1)); return d; }
function addDays(d,n){ var x=new Date(d); x.setDate(x.getDate()+n); return x; }
/* Local calendar day, not toISOString: at 8pm Pacific toISOString is already
   tomorrow, and a cell keyed that way would show Monday's hours on Tuesday. */
function dayKeyOf(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
function fmtHours(n){ return (Math.round((Number(n)||0)*100)/100)+"h"; }
function shortRange(a,b){ var mo=function(d){ return d.toLocaleDateString("en-US",{month:"short"}); }; return mo(a)+" "+a.getDate()+"–"+(mo(a)===mo(b)?"":mo(b)+" ")+b.getDate(); }

/* The window the calendar draws: last week's Saturday through this week's
   Friday. The page asks the backend for exactly this range instead of taking
   the default, because the server decides "today" in its own zone (UTC on
   Vercel): on a Friday evening here it is already Saturday there, its default
   window starts a week late, and last week would vanish from the calendar. */
function calendarBounds(today){ var thisSat=saturdayOf(today); return { from:dayKeyOf(addDays(thisSat,-7)), to:dayKeyOf(addDays(thisSat,6)) }; }

/* Rows in, two weeks out. Rows outside the window are ignored (an old backend
   may answer a wider range). Several entries on one day are STACKED, each
   with its own hours and address, rather than totalled with a count: the
   address is the point of the request, and at 45px a superscript "2" is
   easy to miss and says nothing about where the other hours went. */
function buildCalendarModel(items, today, addresses){
  addresses=addresses||{};
  var t=new Date(today); t.setHours(0,0,0,0); var todayKey=dayKeyOf(t);
  var thisSat=saturdayOf(t), prevSat=addDays(thisSat,-7);
  var byDay={};
  (items||[]).forEach(function(it){ var k=fmtDate(it.timeSheetDate); if(k) (byDay[k]=byDay[k]||[]).push(it); });
  return [{label:"Last week",start:prevSat},{label:"This week",start:thisSat}].map(function(w){
    var total=0, days=[];
    for(var i=0;i<7;i++){
      var d=addDays(w.start,i), key=dayKeyOf(d), hours=0;
      var entries=(byDay[key]||[]).map(function(it){
        var proj=String(it.timeSheetProjectName||""), leave=isLeaveType(proj), h=Number(it.timeSheetWorkHours)||0;
        hours+=h;
        return { id:String(it.id), hours:h, leave:leave, text: leave?proj:(addresses[proj]||proj||"—") };
      });
      total+=hours;
      days.push({ key:key, dow:DAY_NAMES[i], dayNum:d.getDate(), isToday:key===todayKey, isWeekend:i<2, hours:Math.round(hours*100)/100, entries:entries });
    }
    var end=addDays(w.start,6);
    return { label:w.label, from:dayKeyOf(w.start), to:dayKeyOf(end), range:shortRange(w.start,end), total:Math.round(total*100)/100, days:days };
  });
}

function renderCalendar(weeks){
  var html="";
  weeks.forEach(function(w){
    html+='<div class="m-cal-week"><div class="m-cal-label"><span>'+escHtml(w.label)+' · '+escHtml(w.range)+'</span><span class="tot">'+fmtHours(w.total)+'</span></div><div class="m-cal-grid">';
    w.days.forEach(function(d){ html+='<div class="m-cal-head'+(d.isWeekend?" weekend":"")+(d.isToday?" today":"")+'">'+d.dow+'<span class="dn">'+d.dayNum+'</span></div>'; });
    w.days.forEach(function(d){
      var n=d.entries.length;
      var label=niceDate(d.key)+(n?": "+fmtHours(d.hours)+", "+n+(n===1?" entry":" entries"):": no entry, tap to log this day");
      html+='<button type="button" class="m-cal-cell'+(d.isWeekend?" weekend":"")+(d.isToday?" today":"")+(n?" has":"")+'" data-day="'+d.key+'" aria-label="'+escHtml(label)+'">';
      if(!n) html+='<span class="m-cal-dot">·</span>';
      d.entries.forEach(function(e){ var hs=fmtHours(e.hours); html+='<span class="m-cal-ent'+(e.leave?" leave":"")+'"><span class="m-cal-h'+(hs.length>4?" long":"")+'">'+hs+'</span><span class="m-cal-a">'+escHtml(e.text)+'</span></span>'; });
      html+='</button>';
    });
    html+='</div></div>';
  });
  return html;
}

function renderEntries(){
  var area=el("listArea"); var cur=el("tsName").value.trim();
  el("listNote").textContent = cur ? ("Showing: "+cur) : "Showing all entries you can access.";
  var items=allItems.filter(function(x){ if(!cur) return true; return (x.timeSheetEmployeeName||"").toLowerCase()===cur.toLowerCase(); });
  var weeks=buildCalendarModel(items, new Date(), projectAddresses);
  calDays={};
  weeks.forEach(function(w){ w.days.forEach(function(d){ calDays[d.key]=d.entries.map(function(e){ return e.id; }); }); });
  area.innerHTML=renderCalendar(weeks);
  area.querySelectorAll("[data-day]").forEach(function(b){ b.onclick=function(){ onCalendarDay(b.getAttribute("data-day")); }; });
}

/* One entry: straight to its sheet (View has Edit and Delete). Several: a
   sheet to pick from. None: the form is pointed at that day and brought into
   view, so "tap Monday to log Monday" works - unless an edit is in progress,
   when silently moving the edited entry to another day would be the surprise
   nobody wants; then the form is only brought into view. */
function onCalendarDay(key){
  var ids=calDays[key]||[];
  if(ids.length===1) return viewEntry(ids[0]);
  if(ids.length>1){
    var rows=ids.map(function(id){ return allItems.find(function(x){ return String(x.id)===id; }); }).filter(Boolean);
    showSheet('<h3>'+escHtml(niceDate(key))+'</h3><div class="m-daylist">'+rows.map(function(it){
      var proj=String(it.timeSheetProjectName||""), leave=isLeaveType(proj);
      return '<button type="button" class="'+(leave?"leave":"")+'" onclick="closeSheet();viewEntry(\''+escHtml(String(it.id))+'\')"><span>'+escHtml(leave?proj:(projectAddresses[proj]||proj||"—"))+'</span><span class="hrs">'+fmtHours(it.timeSheetWorkHours)+'</span></button>';
    }).join("")+'</div><div class="m-sheet-actions"><button onclick="closeSheet()">Close</button></div>');
    return;
  }
  if(!editingId){
    el("tsDate").value=key; onDateChange(); showMsg("","Date set to "+niceDate(key)+".");
    /* The notice fades on its own, but only if it is still THE notice: if the
       crew has already pressed Submit and "Saving…" or a validation error has
       replaced it, that message must stay. The token also makes rapid taps on
       several empty days leave one live timer, not a stack. */
    var tok=++dateNoticeTok;
    setTimeout(function(){ var m=el("formMsg"); if(tok===dateNoticeTok && m.textContent.indexOf("Date set to")===0) m.className="m-msg"; },2500);
  }
  window.scrollTo({top:0,behavior:"smooth"});
}
if(typeof window!=="undefined") window.DCRTimesheetCalendar={ bounds:calendarBounds, model:buildCalendarModel, render:renderCalendar, saturdayOf:saturdayOf, dayKeyOf:dayKeyOf };

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
  catch(e){ DCR.alert("Error deleting: "+(e.message||"try again")); }
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
    // Exactly the fortnight the calendar draws; see calendarBounds for why not the default.
    var b=calendarBounds(new Date());
    var d=await DCR.api("/api/portal?action=timesheets&from="+b.from+"&to="+b.to);
    projectAddresses=(d.projectAddresses&&typeof d.projectAddresses==="object")?d.projectAddresses:{};
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
  /* A text message can link straight to a day: ?date=YYYY-MM-DD. Anything
     else is today, as before. */
  var wantDay=/[?&]date=(\d{4}-\d{2}-\d{2})(?:&|$)/.exec(location.search);
  el("tsDate").value=wantDay?wantDay[1]:todayStr();
  await loadEmployees();
  await loadData();
});
