/* DCR portal — desktop Time Sheet page.
   Data comes through the authenticated portal gateway:
     GET    /api/portal?action=roster       -> employees the user may pick (+ scope)
     GET    /api/portal?action=timesheets   -> { items, projectNames, scope }
     POST/PATCH/DELETE /api/portal?action=timesheets
   The server re-checks every write against the user's crew scope; the UI mirrors it. */

var allItems = [];
var employeeList = [];        // [{ name, employeeId, start1, end1, start2, end2, lunch }]
var tsScopeInfo = null;       // "*"  OR  { self, managed:[...] }
var editingId = null;
var empHighlightIndex = -1;

function escHtml(s) { return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function fmtDate(v) { if(!v)return""; return new Date(v).toISOString().split("T")[0]; }
function getSaturdayOf(date) { var d=new Date(date);d.setHours(0,0,0,0);var day=d.getDay();d.setDate(d.getDate()-(day===6?0:day+1));return d; }

/* ── Time helpers ── */
function tsParseSpTime(isoStr) {
  if (!isoStr) return null;
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  var utcH = d.getUTCHours(), utcM = d.getUTCMinutes();
  var now = new Date();
  var temp = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  temp.setUTCHours(utcH, utcM, 0, 0);
  return { hours: temp.getHours(), minutes: temp.getMinutes() };
}
function tsTimeToStr(h, m) { return String(h).padStart(2,"0") + ":" + String(m||0).padStart(2,"0"); }
function tsTimeToDisplay(h, m) { var ampm=h>=12?"PM":"AM"; var h12=h%12||12; return h12+":"+String(m||0).padStart(2,"0")+" "+ampm; }
function tsParseTimeInput(id) { var val=document.getElementById(id).value; if(!val)return null; var p=val.split(":"); return {hours:parseInt(p[0]),minutes:parseInt(p[1]||0)}; }
function tsTimeToMinutes(t) { if(!t)return 0; return t.hours*60+t.minutes; }
function tsMinutesToTime(m) { return { hours: Math.floor(m/60), minutes: m%60 }; }

/* ── Selected employee's schedule defaults (from roster) ── */
function tsGetDefaults() {
  var name = document.getElementById("tsName").value.trim();
  if (!name) return null;
  var emp = employeeList.find(function(e){ return (e.name||"").toLowerCase() === name.toLowerCase(); });
  if (!emp) return null;
  return {
    start1: tsParseSpTime(emp.start1),
    end1: tsParseSpTime(emp.end1),
    start2: tsParseSpTime(emp.start2),
    end2: tsParseSpTime(emp.end2),
    lunch: parseFloat(emp.lunch) || 1
  };
}

/* ── Auto-calculate schedule from hours ── */
function tsAutoCalcSchedule() {
  var hours = parseFloat(document.getElementById("tsHours").value) || 0;
  if (hours <= 0) { document.getElementById("tsScheduleSection").style.display = "none"; return; }
  var defaults = tsGetDefaults();
  if (!defaults || !defaults.start1) { document.getElementById("tsScheduleSection").style.display = "none"; return; }
  document.getElementById("tsScheduleSection").style.display = "";

  var s1min = tsTimeToMinutes(defaults.start1);
  var e1min = tsTimeToMinutes(defaults.end1);
  var s2min = tsTimeToMinutes(defaults.start2);
  var session1cap = (e1min - s1min) / 60;
  var totalMinutes = hours * 60;

  if (hours <= session1cap) {
    document.getElementById("tsStart1").value = tsTimeToStr(defaults.start1.hours, defaults.start1.minutes);
    var calcEnd1 = tsMinutesToTime(s1min + totalMinutes);
    document.getElementById("tsEnd1").value = tsTimeToStr(calcEnd1.hours, calcEnd1.minutes);
    document.getElementById("tsLunch").value = 0;
    document.getElementById("tsStart2").value = "";
    document.getElementById("tsEnd2").value = "";
  } else {
    document.getElementById("tsStart1").value = tsTimeToStr(defaults.start1.hours, defaults.start1.minutes);
    document.getElementById("tsEnd1").value = tsTimeToStr(defaults.end1.hours, defaults.end1.minutes);
    document.getElementById("tsLunch").value = defaults.lunch;
    document.getElementById("tsStart2").value = tsTimeToStr(defaults.start2.hours, defaults.start2.minutes);
    var remainingMin = totalMinutes - (e1min - s1min);
    var calcEnd2 = tsMinutesToTime(s2min + remainingMin);
    document.getElementById("tsEnd2").value = tsTimeToStr(calcEnd2.hours, calcEnd2.minutes);
  }
  tsRecalc();
}

/* ── Recalculate from time inputs ── */
function tsRecalc() {
  var s1 = tsParseTimeInput("tsStart1"), e1 = tsParseTimeInput("tsEnd1");
  var s2 = tsParseTimeInput("tsStart2"), e2 = tsParseTimeInput("tsEnd2");
  var lunch = parseFloat(document.getElementById("tsLunch").value) || 0;
  var enteredHours = parseFloat(document.getElementById("tsHours").value) || 0;

  var session1 = 0, session2 = 0;
  if (s1 && e1) session1 = (tsTimeToMinutes(e1) - tsTimeToMinutes(s1)) / 60;
  if (s2 && e2) session2 = (tsTimeToMinutes(e2) - tsTimeToMinutes(s2)) / 60;
  var calculated = session1 + session2;

  var lunchDisplay = document.getElementById("tsLunchRange");
  if (e1 && lunch > 0) {
    var lunchStart = tsTimeToDisplay(e1.hours, e1.minutes);
    var lunchEnd = tsMinutesToTime(tsTimeToMinutes(e1) + lunch * 60);
    lunchDisplay.textContent = lunchStart + " – " + tsTimeToDisplay(lunchEnd.hours, lunchEnd.minutes);
  } else { lunchDisplay.textContent = lunch > 0 ? "" : "No lunch"; }

  tsRenderTimeline(s1, e1, lunch, s2, e2);

  var calcBar = document.getElementById("tsCalcBar");
  if (enteredHours <= 0) { calcBar.innerHTML = ""; return; }
  var match = Math.abs(calculated - enteredHours) < 0.01;
  var cls = match ? "ts-calc-bar ts-calc-match" : "ts-calc-bar ts-calc-mismatch";
  var h = '<div class="' + cls + '">';
  h += '<div><span class="ts-calc-label">Entered:</span> <span class="ts-calc-value">' + enteredHours + ' hrs</span></div>';
  h += '<div><span class="ts-calc-label">Calculated:</span> <span class="ts-calc-value">' + calculated.toFixed(1) + ' hrs</span></div>';
  if (match) { h += '<div style="font-weight:700;">&#10003; Match</div>'; }
  else { var diff = calculated - enteredHours; h += '<div style="font-weight:700;">&#9888; Diff: ' + (diff>0?"+":"") + diff.toFixed(1) + 'h</div>'; }
  h += '</div>';
  calcBar.innerHTML = h;
}

/* ── Visual timeline ── */
function tsRenderTimeline(s1, e1, lunch, s2, e2) {
  var container = document.getElementById("tsTimeline");
  if (!s1 || !e1) { container.innerHTML = ""; return; }
  var s1m = tsTimeToMinutes(s1), e1m = tsTimeToMinutes(e1);
  var lunchMin = (lunch||0)*60;
  var s2m = s2 ? tsTimeToMinutes(s2) : 0, e2m = e2 ? tsTimeToMinutes(e2) : 0;
  var dayStart = s1m;
  var dayEnd = (s2 && e2) ? e2m : (lunchMin > 0 ? e1m + lunchMin : e1m);
  var totalSpan = dayEnd - dayStart;
  if (totalSpan <= 0) { container.innerHTML = ""; return; }
  var w1 = ((e1m-s1m)/totalSpan*100).toFixed(1);
  var wL = (lunchMin/totalSpan*100).toFixed(1);
  var w2 = (s2&&e2) ? (((e2m-s2m)/totalSpan*100).toFixed(1)) : 0;
  var h = '<div class="ts-timeline">';
  h += '<div class="ts-timeline-block ts-timeline-work" style="width:'+w1+'%">'+((e1m-s1m)/60)+'h</div>';
  if (lunchMin > 0) h += '<div class="ts-timeline-block ts-timeline-lunch" style="width:'+wL+'%">'+lunch+'h</div>';
  if (s2 && e2 && e2m > s2m) h += '<div class="ts-timeline-block ts-timeline-work" style="width:'+w2+'%">'+((e2m-s2m)/60)+'h</div>';
  h += '</div>';
  h += '<div class="ts-timeline-labels"><span>'+tsTimeToDisplay(s1.hours,s1.minutes)+'</span>';
  h += '<span>'+tsTimeToDisplay((s2&&e2?e2:e1).hours,(s2&&e2?e2:e1).minutes)+'</span></div>';
  container.innerHTML = h;
}

/* ── Employee combo box ── */
function filterEmployees() {
  var input = document.getElementById("tsName");
  if (input.disabled) return;
  var dropdown = document.getElementById("empDropdown");
  var query = input.value.trim().toLowerCase();
  document.getElementById("tsEmployeeID").value = "";
  var matches = employeeList.filter(function(emp){ if(!query)return true; return (emp.name||"").toLowerCase().indexOf(query)!==-1; });
  if (matches.length === 0) { dropdown.innerHTML='<div class="emp-no-match">No employees found</div>'; dropdown.classList.add("open"); empHighlightIndex=-1; buildCalendar(); return; }
  var html = "";
  matches.forEach(function(emp){
    var safeName=escHtml(emp.name).replace(/'/g,"\\'");
    var safeId=escHtml(emp.employeeId).replace(/'/g,"\\'");
    html+='<div class="emp-option" data-name="'+escHtml(emp.name)+'" data-id="'+escHtml(emp.employeeId)+'" onmousedown="selectEmployee(\''+safeName+'\',\''+safeId+'\')">';
    html+='<span class="emp-option-name">'+escHtml(emp.name)+'</span></div>';
  });
  dropdown.innerHTML=html; dropdown.classList.add("open"); empHighlightIndex=-1; buildCalendar();
}
function selectEmployee(name, id) {
  document.getElementById("tsName").value=name;
  document.getElementById("tsEmployeeID").value=id;
  document.getElementById("empDropdown").classList.remove("open");
  empHighlightIndex=-1; buildCalendar(); tsAutoCalcSchedule();
}
function empKeydown(e) {
  var dropdown=document.getElementById("empDropdown");var options=dropdown.querySelectorAll(".emp-option");
  if(!dropdown.classList.contains("open")||options.length===0)return;
  if(e.key==="ArrowDown"){e.preventDefault();empHighlightIndex=Math.min(empHighlightIndex+1,options.length-1);updateEmpHighlight(options);}
  else if(e.key==="ArrowUp"){e.preventDefault();empHighlightIndex=Math.max(empHighlightIndex-1,0);updateEmpHighlight(options);}
  else if(e.key==="Enter"){e.preventDefault();if(empHighlightIndex>=0&&empHighlightIndex<options.length){var opt=options[empHighlightIndex];selectEmployee(opt.getAttribute("data-name"),opt.getAttribute("data-id"));}}
  else if(e.key==="Escape"){dropdown.classList.remove("open");empHighlightIndex=-1;}
}
function updateEmpHighlight(options){ options.forEach(function(opt,i){if(i===empHighlightIndex){opt.classList.add("highlighted");opt.scrollIntoView({block:"nearest"});}else{opt.classList.remove("highlighted");}}); }
document.addEventListener("click",function(e){var combo=document.getElementById("empCombo");if(combo&&!combo.contains(e.target))document.getElementById("empDropdown").classList.remove("open");});

/* ── Hours +/- control ── */
function adjustHours(delta){var input=document.getElementById("tsHours");var current=parseFloat(input.value)||0;var next=Math.round((current+delta)*2)/2;if(next<0)next=0;if(next>24)next=24;input.value=next;tsAutoCalcSchedule();}
function syncHoursInput(){var input=document.getElementById("tsHours");var val=input.value.replace(/[^0-9.]/g,"");if(val!==input.value)input.value=val;tsAutoCalcSchedule();}
function cleanHoursInput(){var input=document.getElementById("tsHours");var num=parseFloat(input.value);if(isNaN(num)||num<0){input.value=0;}else if(num>24){input.value=24;}else{input.value=num;}tsAutoCalcSchedule();}

/* ── Calendar ── */
function buildDayCard(item) {
  var work=item.timeSheetWorkCompleted||"";
  var h='<div class="cal-card" onclick="event.stopPropagation();viewCard(\''+item.id+'\')">';
  h+='<div class="cal-card-project">'+escHtml(item.timeSheetProjectName||"No project")+'</div>';
  h+='<div class="cal-card-work">'+escHtml(work.substring(0,45))+(work.length>45?"&hellip;":"")+'</div>';
  h+='<div class="cal-card-hrs"><span class="hrs-badge">'+(item.timeSheetWorkHours||0)+' hrs</span></div>';
  h+='<div class="card-actions">';
  h+='<button class="card-action" onclick="event.stopPropagation();viewCard(\''+item.id+'\')">&#128065; View</button>';
  h+='<button class="card-action" onclick="event.stopPropagation();editCard(\''+item.id+'\')">&#9998; Edit</button>';
  h+='<button class="card-action del" onclick="event.stopPropagation();deleteCard(\''+item.id+'\')">&#128465; Delete</button>';
  h+='</div></div>';
  return h;
}
function buildDayCell(d, key, isToday, isWeekend, dayItems) {
  var hasEntry=dayItems.length>0;
  var classes=["cal-day",hasEntry?"has-entry":"",isToday?"today":"",isWeekend?"weekend":""].filter(Boolean).join(" ");
  var h='<div class="'+classes+'" onclick="selectDate(\''+key+'\',this)" title="Add entry for '+d.toLocaleDateString("en-US",{month:"short",day:"numeric"})+'">';
  h+='<div class="cal-day-header">'+d.toLocaleDateString("en-US",{month:"short"})+'</div>';
  h+='<div class="cal-day-num" style="'+(isWeekend&&!isToday&&!hasEntry?"color:#aaa;":"")+'">'+d.getDate()+'</div>';
  if(dayItems.length===0){h+='<div class="cal-add-btn">+ Add entry</div>';}
  else{dayItems.forEach(function(item){h+=buildDayCard(item);});h+='<div class="cal-add-btn">+ Add another</div>';}
  h+='</div>';return h;
}
function buildCalendar() {
  var area=document.getElementById("calArea");if(!area)return;
  var today=new Date();today.setHours(0,0,0,0);var thisSat=getSaturdayOf(today);var prevSat=new Date(thisSat);prevSat.setDate(prevSat.getDate()-7);
  var currentEmployee=document.getElementById("tsName").value.trim();
  var filterNote=document.getElementById("calFilterNote");
  filterNote.textContent=currentEmployee?"Showing entries for: "+currentEmployee:"Showing all entries you can access.";
  var weeks=[{label:"Last week",start:prevSat},{label:"This week",start:thisSat}];
  var html="";
  weeks.forEach(function(week,wi){
    if(wi>0)html+='<div class="week-sep"></div>';
    html+='<div class="ts-week-label">'+week.label+'</div>';
    var weekendCells="",weekdayCells="";
    for(var i=0;i<7;i++){
      var d=new Date(week.start);d.setDate(d.getDate()+i);var key=d.toISOString().split("T")[0];
      var isToday=d.getTime()===today.getTime();var isWeekend=i===0||i===1;
      var dayItems=allItems.filter(function(x){if(fmtDate(x.timeSheetDate)!==key)return false;if(currentEmployee)return(x.timeSheetEmployeeName||"").toLowerCase()===currentEmployee.toLowerCase();return true;});
      var cell=buildDayCell(d,key,isToday,isWeekend,dayItems);
      if(isWeekend)weekendCells+=cell;else weekdayCells+=cell;
    }
    html+='<div style="display:grid;grid-template-columns:2fr 5fr;gap:0;align-items:start;">';
    html+='<div style="padding-right:12px;"><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px;">';
    html+='<div class="cal-day-name weekend-label">Sat</div><div class="cal-day-name weekend-label">Sun</div></div>';
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'+weekendCells+'</div></div>';
    html+='<div style="border-left:2px solid #185FA5;padding-left:12px;">';
    html+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-size:10px;font-weight:700;color:#185FA5;text-transform:uppercase;letter-spacing:0.06em;">&#8212; Work week</span></div>';
    html+='<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:4px;">';
    ["Mon","Tue","Wed","Thu","Fri"].forEach(function(n){html+='<div class="cal-day-name workweek-label">'+n+'</div>';});
    html+='</div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;">'+weekdayCells+'</div></div></div>';
  });
  area.innerHTML=html;
}
function selectDate(dateStr, el) {
  document.getElementById("tsDate").value=dateStr;
  document.querySelectorAll(".cal-day").forEach(function(d){d.classList.remove("selected");});
  el.classList.add("selected");
  if (!document.getElementById("tsName").disabled) document.getElementById("tsName").focus();
  document.getElementById("timesheetApp").scrollIntoView({behavior:"smooth",block:"start"});
}

function clearForm(keepEmployee) {
  editingId=null;
  var locked=document.getElementById("tsName").disabled;
  if(!keepEmployee && !locked){document.getElementById("tsName").value="";document.getElementById("tsEmployeeID").value="";}
  document.getElementById("tsDate").value="";
  document.getElementById("tsHours").value=0;
  document.getElementById("tsWork").value="";
  document.getElementById("tsProject").value="";
  document.getElementById("formMsg").innerHTML="";
  document.getElementById("submitBtn").textContent="✓ Submit time sheet";
  document.getElementById("cancelBtn").style.display="none";
  document.getElementById("tsScheduleSection").style.display="none";
  document.getElementById("tsStart1").value="";document.getElementById("tsEnd1").value="";
  document.getElementById("tsLunch").value="1";document.getElementById("tsStart2").value="";document.getElementById("tsEnd2").value="";
  document.getElementById("tsTimeline").innerHTML="";document.getElementById("tsCalcBar").innerHTML="";
  document.querySelectorAll(".cal-day").forEach(function(d){d.classList.remove("selected");});
}
function cancelEdit() { clearForm(false); }

function viewCard(id) {
  var item=allItems.find(function(x){return x.id==id;});if(!item)return;
  var d=fmtDate(item.timeSheetDate);
  var dateDisp=d?new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"}):"—";
  var scheduleRow="";
  if(item.timeSheetWorkStatTime){
    var sched=item.timeSheetWorkStatTime;
    if(item.timeSheetWorkEndTime) sched+=" – "+item.timeSheetWorkEndTime;
    if(item.timeSheetWorkLunchTime && parseFloat(item.timeSheetWorkLunchTime)>0) sched+=" | Lunch: "+item.timeSheetWorkLunchTime+"h";
    if(item.timeSheetWorkStatTime2) sched+=" | "+item.timeSheetWorkStatTime2;
    if(item.timeSheetWorkEndTime2) sched+=" – "+item.timeSheetWorkEndTime2;
    scheduleRow='<tr><td>Schedule</td><td>'+escHtml(sched)+'</td></tr>';
  }
  showModal(
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem;">'+
    '<h3 style="margin:0;font-size:17px;">Time Entry</h3>'+
    '<button class="btn-secondary" onclick="closeModal()" style="padding:4px 12px;font-size:15px;">&times;</button></div>'+
    '<table class="modal-table">'+
    '<tr><td>Employee</td><td>'+escHtml(item.timeSheetEmployeeName||"—")+'</td></tr>'+
    '<tr><td>Project</td><td>'+escHtml(item.timeSheetProjectName||"—")+'</td></tr>'+
    '<tr><td>Date</td><td>'+dateDisp+'</td></tr>'+
    '<tr><td>Hours</td><td><span class="hrs-badge" style="font-size:13px;padding:3px 8px;">'+(item.timeSheetWorkHours||0)+' hrs</span></td></tr>'+
    scheduleRow+
    '<tr><td>Work completed</td><td>'+escHtml(item.timeSheetWorkCompleted||"—")+'</td></tr>'+
    '</table>'+
    '<div class="modal-actions">'+
    '<button class="btn-danger" onclick="closeModal();deleteCard(\''+id+'\')">&#128465; Delete</button>'+
    '<button class="btn-secondary" onclick="closeModal();editCard(\''+id+'\')">&#9998; Edit</button>'+
    '<button class="btn-primary" onclick="closeModal()">Close</button></div>'
  );
}

function editCard(id) {
  var item=allItems.find(function(x){return x.id==id;});if(!item)return;
  editingId=id;
  if (!document.getElementById("tsName").disabled) {
    document.getElementById("tsName").value=item.timeSheetEmployeeName||"";
    document.getElementById("tsEmployeeID").value=item.timeSheetProployeeID||"";
  }
  document.getElementById("tsProject").value=item.timeSheetProjectName||"";
  document.getElementById("tsDate").value=fmtDate(item.timeSheetDate);
  document.getElementById("tsHours").value=item.timeSheetWorkHours||0;
  document.getElementById("tsWork").value=item.timeSheetWorkCompleted||"";
  if (item.timeSheetWorkStatTime) {
    document.getElementById("tsScheduleSection").style.display="";
    document.getElementById("tsStart1").value=tsDisplayToTimeInput(item.timeSheetWorkStatTime);
    document.getElementById("tsEnd1").value=tsDisplayToTimeInput(item.timeSheetWorkEndTime);
    document.getElementById("tsLunch").value=item.timeSheetWorkLunchTime||"0";
    document.getElementById("tsStart2").value=tsDisplayToTimeInput(item.timeSheetWorkStatTime2);
    document.getElementById("tsEnd2").value=tsDisplayToTimeInput(item.timeSheetWorkEndTime2);
    tsRecalc();
  } else { tsAutoCalcSchedule(); }
  document.getElementById("submitBtn").textContent="✓ Save changes";
  document.getElementById("cancelBtn").style.display="";
  document.getElementById("timesheetApp").scrollIntoView({behavior:"smooth",block:"start"});
  buildCalendar();
}
function tsDisplayToTimeInput(val) {
  if (!val) return "";
  val = String(val).trim().toUpperCase();
  var match = val.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (match) { var h=parseInt(match[1]); var ampm=match[3]; if(ampm==="PM"&&h!==12)h+=12; if(ampm==="AM"&&h===12)h=0; return tsTimeToStr(h,parseInt(match[2])); }
  if (val.match(/^\d{2}:\d{2}$/)) return val;
  return "";
}

function deleteCard(id) {
  showModal('<h3 style="margin:0 0 0.75rem;">Delete this entry?</h3>'+
    '<p style="font-size:14px;color:#666;margin:0 0 0.5rem;">This time entry will be permanently deleted and cannot be recovered.</p>'+
    '<div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancel</button>'+
    '<button class="btn-danger" onclick="closeModal();confirmDelete(\''+id+'\')">&#128465; Yes, delete</button></div>');
}
async function confirmDelete(id) {
  try { await DCR.api("/api/portal?action=timesheets", { method:"DELETE", body:{ itemId:id } }); await loadData(); }
  catch(e){ alert("Error deleting entry: "+(e.message||"try again")); }
}

async function submitEntry() {
  var msg=document.getElementById("formMsg");
  var name=document.getElementById("tsName").value.trim();
  var employeeID=document.getElementById("tsEmployeeID").value.trim();
  var project=document.getElementById("tsProject").value.trim();
  var date=document.getElementById("tsDate").value;
  var hours=document.getElementById("tsHours").value;
  var work=document.getElementById("tsWork").value.trim();

  if(!name||!project||!date||!hours||parseFloat(hours)<=0){msg.innerHTML='<span class="msg-error">Please complete all required fields (*) and set hours above 0.</span>';return;}
  if(!employeeID){var m=employeeList.find(function(emp){return(emp.name||"").toLowerCase()===name.toLowerCase();});if(m){employeeID=m.employeeId;document.getElementById("tsEmployeeID").value=employeeID;}}

  function fmtSave(id){var t=tsParseTimeInput(id);if(!t)return"";return tsTimeToDisplay(t.hours,t.minutes);}
  var s1=tsParseTimeInput("tsStart1"),e1=tsParseTimeInput("tsEnd1"),s2=tsParseTimeInput("tsStart2"),e2=tsParseTimeInput("tsEnd2");
  var session1=0,session2=0;
  if(s1&&e1)session1=(tsTimeToMinutes(e1)-tsTimeToMinutes(s1))/60;
  if(s2&&e2)session2=(tsTimeToMinutes(e2)-tsTimeToMinutes(s2))/60;
  var calculatedHours=session1+session2;

  var fields={
    timeSheetEmployeeName:name,
    timeSheetProployeeID:employeeID,
    timeSheetProjectName:project,
    timeSheetDate:date,
    timeSheetWorkHours:Number(hours),
    timeSheetWorkCompleted:work,
    timeSheetWorkStatTime:fmtSave("tsStart1"),
    timeSheetWorkEndTime:fmtSave("tsEnd1"),
    timeSheetWorkLunchTime:document.getElementById("tsLunch").value||"0",
    timeSheetWorkStatTime2:fmtSave("tsStart2"),
    timeSheetWorkEndTime2:fmtSave("tsEnd2"),
    timeSheetWorkCalculatedHours:Number(calculatedHours)
  };

  msg.innerHTML='<span style="color:#888;font-size:13px;">Saving&hellip;</span>';
  document.getElementById("submitBtn").disabled=true;
  try{
    var opts = editingId ? { method:"PATCH", body:{ itemId:editingId, fields:fields } } : { method:"POST", body:{ fields:fields } };
    await DCR.api("/api/portal?action=timesheets", opts);
    msg.innerHTML='<span class="msg-success">&#10003; Time sheet saved successfully.</span>';
    clearForm(true); await loadData(); setTimeout(function(){msg.innerHTML="";},4000);
  }catch(e){ msg.innerHTML='<span class="msg-error">'+escHtml(e.message||"Save failed. Try again.")+'</span>'; }
  document.getElementById("submitBtn").disabled=false;
}

function showModal(html){document.getElementById("modalContainer").innerHTML='<div class="modal-overlay" onclick="if(event.target===this)closeModal()"><div class="modal-box">'+html+'</div></div>';}
function closeModal(){document.getElementById("modalContainer").innerHTML="";}

/* ── Scope-aware employee field ── */
function applyScopeUI() {
  var note=document.getElementById("empScopeNote");
  var input=document.getElementById("tsName");
  var submit=document.getElementById("submitBtn");
  submit.disabled=false;

  if (tsScopeInfo === "*") { input.disabled=false; note.textContent="You can log time for any employee."; return; }

  var self=(tsScopeInfo && tsScopeInfo.self) || "";
  var managed=(tsScopeInfo && tsScopeInfo.managed) || [];

  function setSelf(){ input.value=self; var e=employeeList.find(function(x){return (x.name||"").toLowerCase()===self.toLowerCase();}); document.getElementById("tsEmployeeID").value=e?e.employeeId:""; }

  if (!self && managed.length===0) {
    input.disabled=true; submit.disabled=true;
    note.innerHTML='<span style="color:#A32D2D;">Your account isn’t linked to an employee yet. Ask an admin to set your employee name.</span>';
    return;
  }
  if (managed.length === 0) {
    setSelf(); input.disabled=true;
    note.textContent="Logging time for yourself.";
  } else {
    input.disabled=false;
    if(!input.value) setSelf();
    note.textContent="You can log time for yourself and your crew ("+managed.length+" assigned).";
  }
}

/* ── Data loading ── */
async function loadEmployees() {
  try {
    var data = await DCR.api("/api/portal?action=roster");
    employeeList = data.employees || [];
    tsScopeInfo = data.scope;
    applyScopeUI();
  } catch(e) { console.error("Failed to load roster:", e.message); }
}
async function loadData() {
  document.getElementById("calArea").innerHTML='<div style="color:#888;font-size:14px;">Loading&hellip;</div>';
  try {
    var data = await DCR.api("/api/portal?action=timesheets");
    allItems = data.items || [];
    if (data.scope) tsScopeInfo = data.scope;
    var dl=document.getElementById("tsProjList");dl.innerHTML="";
    (data.projectNames||[]).forEach(function(name){var o=document.createElement("option");o.value=name;dl.appendChild(o);});
    buildCalendar();
  } catch(e) { document.getElementById("calArea").innerHTML='<span class="msg-error">'+escHtml(e.message||"Error loading time sheets.")+'</span>'; }
}

document.addEventListener("DOMContentLoaded", async function() {
  var profile = await DCR.requireAuth();
  document.getElementById("companyName").textContent = DCR.company + " Portal";
  document.getElementById("userPill").textContent = (profile.displayName || profile.email) + " · " + profile.role;
  document.getElementById("logoutBtn").onclick = function(){ DCR.logout(); };
  await loadEmployees();
  await loadData();
});
