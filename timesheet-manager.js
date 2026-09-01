/* DCR portal — Team Time Sheets (manager / lead / office).
   Runs through the authenticated gateway: action=timesheets (scoped read/write) and
   action=roster (safe employee list). A Manager/office sees everyone; a lead sees only
   their crew — enforced server-side. Same dateTime/number/leave handling as the other pages. */

var pmAllItems = [];
/* Every project name in scope, from the server, not derived from the rows on
   screen: the picker has to offer a job that has had no hours lately. */
var pmProjectNames = [];
// Guards against a slow answer for one week landing after a newer one.
var pmLoadSeq = 0;
var pmEmployeeList = [];   // [{ name, employeeId, start1, end1, start2, end2, lunch }]
var pmScope = null;        // "*" or { self, managed:[...] }
var pmWeekStart = null;
var pmDayNames = ["Sat","Sun","Mon","Tue","Wed","Thu","Fri"];
var pmDayKeys = [];
var PM_ORDER_KEY = "pm_employee_order_v1";
var pmDragSrcIndex = null;
var LEAVE_TYPES = ["Holiday","Vacation","Sick","Day Off"];
function isLeaveType(t){ return LEAVE_TYPES.indexOf(t)!==-1; }

function el(id){ return document.getElementById(id); }
function pmEsc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function pmFmtDate(v){ if(!v) return ""; var d=new Date(v); return isNaN(d)?"":d.toISOString().split("T")[0]; }
function pmGetSaturday(date){ var d=new Date(date);d.setHours(0,0,0,0);var day=d.getDay();d.setDate(d.getDate()-(day===6?0:day+1));return d; }
function pmInitials(name){ if(!name)return"?";var p=name.trim().split(/\s+/);if(p.length>=2)return(p[0][0]+p[p.length-1][0]).toUpperCase();return name.substring(0,2).toUpperCase(); }
function pmFormatDateShort(d){ return d.toLocaleDateString("en-US",{month:"short",day:"numeric"}); }
function pmFormatDateFull(d){ return d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"}); }
function pmFindEmpId(name){ var m=pmEmployeeList.find(function(e){return (e.name||"").toLowerCase()===(name||"").toLowerCase();}); return m?m.employeeId:""; }

/* ── time helpers (same conventions as the employee pages) ── */
function pmParseSpTime(iso){ if(!iso) return null; var d=new Date(iso); if(isNaN(d)) return null; return {hours:d.getHours(),minutes:d.getMinutes()}; } // wall-clock time via the stored instant's own UTC offset (no DST re-anchoring — see timesheet.js)
function pmTimeToStr(h,m){ return String(h).padStart(2,"0")+":"+String(m||0).padStart(2,"0"); }
function pmTimeToDisplay(h,m){ var a=h>=12?"PM":"AM";var h12=h%12||12;return h12+":"+String(m||0).padStart(2,"0")+" "+a; }
function pmTimeToMinutes(t){ return t? t.hours*60+t.minutes : 0; }
function pmMinutesToTime(m){ return {hours:Math.floor(m/60),minutes:m%60}; }
function pmParseTimeEl(id){ var e=el(id); if(!e||!e.value) return null; var p=e.value.split(":"); return {hours:parseInt(p[0]),minutes:parseInt(p[1]||0)}; }
function pmDisplayToTimeInput(val){ if(!val) return ""; val=String(val).trim().toUpperCase(); var m=val.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/); if(m){var h=parseInt(m[1]);if(m[3]==="PM"&&h!==12)h+=12;if(m[3]==="AM"&&h===12)h=0;return pmTimeToStr(h,parseInt(m[2]));} if(val.match(/^\d{2}:\d{2}$/)) return val; return ""; }
function pmTimeToISO(id,dateStr){ var t=pmParseTimeEl(id); if(!t||!dateStr) return null; var p=String(dateStr).split("-"); if(p.length!==3) return null; var d=new Date(+p[0],+p[1]-1,+p[2],t.hours,t.minutes,0,0); return isNaN(d)?null:d.toISOString(); }
function pmIsoToDisplay(iso){ var t=pmParseSpTime(iso); return t?pmTimeToDisplay(t.hours,t.minutes):""; }

function pmGetEmpDefaults(name){
  var e=pmEmployeeList.find(function(x){return (x.name||"").toLowerCase()===(name||"").toLowerCase();});
  if(!e) return null;
  return { start1:pmParseSpTime(e.start1), end1:pmParseSpTime(e.end1), start2:pmParseSpTime(e.start2), end2:pmParseSpTime(e.end2), lunch:parseFloat(e.lunch)||1 };
}

/* ── schedule editor (in modals) ── */
function pmBuildScheduleHtml(prefix){
  var h='<div class="pm-form-full"><div class="pm-schedule" id="'+prefix+'SchedWrap">';
  h+='<div class="pm-schedule-title"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Work Schedule</div>';
  h+='<div class="pm-schedule-grid">';
  h+='<div class="pm-schedule-session"><div class="pm-schedule-session-title">Morning</div>';
  h+='<div class="pm-sched-row"><span class="pm-sched-label">Start</span><input type="time" class="pm-sched-time" id="'+prefix+'Start1" onchange="pmSchedRecalc(\''+prefix+'\')"></div>';
  h+='<div class="pm-sched-row"><span class="pm-sched-label">End</span><input type="time" class="pm-sched-time" id="'+prefix+'End1" onchange="pmSchedRecalc(\''+prefix+'\')"></div></div>';
  h+='<div class="pm-schedule-session"><div class="pm-schedule-session-title" style="color:var(--gold);">Lunch</div>';
  h+='<div class="pm-sched-row"><span class="pm-sched-label">Hours</span><input type="text" class="pm-sched-lunch" id="'+prefix+'Lunch" value="1" inputmode="decimal" onchange="pmSchedRecalc(\''+prefix+'\')" onblur="pmSchedRecalc(\''+prefix+'\')"></div>';
  h+='<div style="font-size:9px;color:var(--text-muted);margin-top:3px;" id="'+prefix+'LunchRange"></div></div>';
  h+='<div class="pm-schedule-session"><div class="pm-schedule-session-title">Afternoon</div>';
  h+='<div class="pm-sched-row"><span class="pm-sched-label">Start</span><input type="time" class="pm-sched-time" id="'+prefix+'Start2" onchange="pmSchedRecalc(\''+prefix+'\')"></div>';
  h+='<div class="pm-sched-row"><span class="pm-sched-label">End</span><input type="time" class="pm-sched-time" id="'+prefix+'End2" onchange="pmSchedRecalc(\''+prefix+'\')"></div></div>';
  h+='</div><div id="'+prefix+'CalcBar"></div></div></div>';
  return h;
}
function pmAutoCalcSchedule(prefix, empName, hours){
  var wrap=el(prefix+"SchedWrap"); if(!wrap) return;
  if(!hours||hours<=0){ wrap.style.display="none"; return; }
  var def=pmGetEmpDefaults(empName);
  if(!def||!def.start1){ wrap.style.display="none"; return; }
  wrap.style.display="";
  var s1=pmTimeToMinutes(def.start1), e1=pmTimeToMinutes(def.end1), s2=pmTimeToMinutes(def.start2);
  var cap=(e1-s1)/60, total=hours*60;
  if(hours<=cap){
    el(prefix+"Start1").value=pmTimeToStr(def.start1.hours,def.start1.minutes);
    var ce=pmMinutesToTime(s1+total); el(prefix+"End1").value=pmTimeToStr(ce.hours,ce.minutes);
    el(prefix+"Lunch").value=0; el(prefix+"Start2").value=""; el(prefix+"End2").value="";
  } else {
    el(prefix+"Start1").value=pmTimeToStr(def.start1.hours,def.start1.minutes);
    el(prefix+"End1").value=pmTimeToStr(def.end1.hours,def.end1.minutes);
    el(prefix+"Lunch").value=def.lunch;
    el(prefix+"Start2").value=pmTimeToStr(def.start2.hours,def.start2.minutes);
    var rem=total-(e1-s1); var ce2=pmMinutesToTime(s2+rem); el(prefix+"End2").value=pmTimeToStr(ce2.hours,ce2.minutes);
  }
  pmSchedRecalc(prefix);
}
function pmSchedRecalc(prefix){
  var s1=pmParseTimeEl(prefix+"Start1"),e1=pmParseTimeEl(prefix+"End1"),s2=pmParseTimeEl(prefix+"Start2"),e2=pmParseTimeEl(prefix+"End2");
  var lunch=parseFloat((el(prefix+"Lunch")||{}).value)||0;
  var hrsEl=el(prefix==="pmForm"?"pmFormHours":"pmEditHours");
  var entered=parseFloat(hrsEl?hrsEl.value:0)||0;
  var calc=0; if(s1&&e1) calc+=(pmTimeToMinutes(e1)-pmTimeToMinutes(s1))/60; if(s2&&e2) calc+=(pmTimeToMinutes(e2)-pmTimeToMinutes(s2))/60;
  var lr=el(prefix+"LunchRange");
  if(lr){ if(e1&&lunch>0){ var le=pmMinutesToTime(pmTimeToMinutes(e1)+lunch*60); lr.textContent=pmTimeToDisplay(e1.hours,e1.minutes)+" – "+pmTimeToDisplay(le.hours,le.minutes); } else lr.textContent=lunch>0?"":"No lunch"; }
  var bar=el(prefix+"CalcBar"); if(!bar||entered<=0){ if(bar) bar.innerHTML=""; return; }
  var match=Math.abs(calc-entered)<0.01;
  bar.innerHTML='<div class="pm-calc-bar '+(match?"pm-calc-match":"pm-calc-mismatch")+'"><div><b>Entered:</b> '+entered+'h</div><div><b>Calculated:</b> '+calc.toFixed(1)+'h</div><div><b>'+(match?"✓ Match":"⚠ "+((calc-entered)>0?"+":"")+(calc-entered).toFixed(1)+"h")+'</b></div></div>';
}
function pmBuildWriteFields(prefix, empName, empId, project, date, hours, work){
  var s1=pmParseTimeEl(prefix+"Start1"),e1=pmParseTimeEl(prefix+"End1"),s2=pmParseTimeEl(prefix+"Start2"),e2=pmParseTimeEl(prefix+"End2");
  var calc=0; if(s1&&e1) calc+=(pmTimeToMinutes(e1)-pmTimeToMinutes(s1))/60; if(s2&&e2) calc+=(pmTimeToMinutes(e2)-pmTimeToMinutes(s2))/60;
  var f={
    timeSheetEmployeeName:empName, timeSheetProjectName:project, timeSheetDate:date,
    timeSheetWorkHours:Number(hours)||0, timeSheetWorkCompleted:work,
    timeSheetWorkStatTime:pmTimeToISO(prefix+"Start1",date), timeSheetWorkEndTime:pmTimeToISO(prefix+"End1",date),
    timeSheetWorkLunchTime:Number((el(prefix+"Lunch")||{}).value)||0,
    timeSheetWorkStatTime2:pmTimeToISO(prefix+"Start2",date), timeSheetWorkEndTime2:pmTimeToISO(prefix+"End2",date),
    timeSheetWorkCalculatedHours:Number(calc)
  };
  if(empId) f.timeSheetProployeeID=Number(empId);
  return f;
}

/* ── saved row order (per device) ── */
function loadSavedOrder(){ try{var s=localStorage.getItem(PM_ORDER_KEY);return s?JSON.parse(s):null;}catch(e){return null;} }
function saveOrder(names){ try{localStorage.setItem(PM_ORDER_KEY,JSON.stringify(names));}catch(e){} }
function resetOrder(){ try{localStorage.removeItem(PM_ORDER_KEY);}catch(e){} renderTable(); }
function sortEmployees(employees){
  var saved=loadSavedOrder(); if(!saved||!saved.length) return employees;
  var order={}; saved.forEach(function(n,i){order[n.toLowerCase()]=i;});
  var a=[],b=[];
  employees.forEach(function(emp){ var k=emp.name.toLowerCase(); if(order.hasOwnProperty(k)) a.push({emp:emp,i:order[k]}); else b.push(emp); });
  a.sort(function(x,y){return x.i-y.i;}); b.sort(function(x,y){return x.name.localeCompare(y.name);});
  return a.map(function(o){return o.emp;}).concat(b);
}

/* ── week nav ── */
/* Moving to another week has to ASK for that week.

   These used to move the label and re-filter the rows already in hand, and
   the server only ever sent back to the previous Saturday - so stepping back
   drew an empty grid whether or not anyone had worked. Hours older than a
   week or so were unreachable from every screen, which is exactly the stretch
   you need when you sit down to bill a fortnight. */
async function goToCurrentWeek(){ pmWeekStart=pmGetSaturday(new Date()); buildWeek(); await loadAllData(); }
async function changeWeek(delta){ var d=new Date(pmWeekStart); d.setDate(d.getDate()+delta*7); pmWeekStart=d; buildWeek(); await loadAllData(); }
function pmWeekRangeQS(){
  if(!pmWeekStart) return "";
  var end=new Date(pmWeekStart); end.setDate(end.getDate()+6);
  return "&from="+encodeURIComponent(pmFmtDate(pmWeekStart))+"&to="+encodeURIComponent(pmFmtDate(end));
}
function buildWeek(){
  pmDayKeys=[]; for(var i=0;i<7;i++){ var d=new Date(pmWeekStart); d.setDate(d.getDate()+i); pmDayKeys.push(d.toISOString().split("T")[0]); }
  var end=new Date(pmWeekStart); end.setDate(end.getDate()+6);
  el("pmWeekLabel").textContent=pmFormatDateShort(pmWeekStart)+" — "+pmFormatDateShort(end);
}

/* ── build employee rows for the week ── */
function getWeekData(){
  var fProj=el("pmFilterProject").value.toLowerCase();
  var fEmp=el("pmFilterEmployee").value.trim().toLowerCase();
  var filtered=pmAllItems.filter(function(it){ if(pmDayKeys.indexOf(pmFmtDate(it.timeSheetDate))===-1) return false; if(fProj&&(it.timeSheetProjectName||"").toLowerCase()!==fProj) return false; return true; });
  var map={};
  filtered.forEach(function(it){
    var name=it.timeSheetEmployeeName||"Unknown";
    if(!map[name]) map[name]={name:name,id:it.timeSheetProployeeID||"",days:{},entries:[],total:0};
    var k=pmFmtDate(it.timeSheetDate); var hrs=parseFloat(it.timeSheetWorkHours)||0;
    map[name].days[k]=(map[name].days[k]||0)+hrs; map[name].total+=hrs; map[name].entries.push(it);
  });
  // include roster employees with no entries this week (managers see the full team)
  pmEmployeeList.forEach(function(e){ if(e.name&&!map[e.name]) map[e.name]={name:e.name,id:e.employeeId||"",days:{},entries:[],total:0}; });
  var employees=Object.keys(map).map(function(k){return map[k];});
  if(fEmp) employees=employees.filter(function(emp){return emp.name.toLowerCase().indexOf(fEmp)!==-1;});
  employees.sort(function(a,b){return a.name.localeCompare(b.name);});
  return sortEmployees(employees);
}

/* ── render grid ── */
function renderTable(){
  var area=el("pmTableArea"); var employees=getWeekData();
  if(!employees.length){ area.innerHTML='<div class="pm-no-data">No employees found for this week.</div>'; updateStats(employees); return; }
  var h='<table class="pm-table"><thead><tr><th>Employee</th>';
  for(var i=0;i<7;i++){ var d=new Date(pmWeekStart); d.setDate(d.getDate()+i); var cls=(i===0||i===1)?"weekend":""; h+='<th class="'+cls+'">'+pmDayNames[i]+'<br><span style="font-weight:400;font-size:10px;">'+pmFormatDateShort(d)+'</span></th>'; }
  h+='<th class="col-total">Total</th></tr></thead><tbody>';
  employees.forEach(function(emp,rowIdx){
    var safeName=pmEsc(emp.name).replace(/'/g,"\\'"); var safeId=pmEsc(emp.id).replace(/'/g,"\\'");
    h+='<tr data-emp="'+pmEsc(emp.name)+'" data-idx="'+rowIdx+'" draggable="true" ondragstart="pmDragStart(event,'+rowIdx+')" ondragover="pmDragOver(event,'+rowIdx+')" ondragleave="pmDragLeave(event)" ondrop="pmDrop(event,'+rowIdx+')" ondragend="pmDragEnd(event)">';
    h+='<td><div class="pm-emp-cell"><span class="pm-drag-handle" title="Drag to reorder">&#9776;</span><div class="pm-emp-name"><div class="pm-emp-avatar">'+pmInitials(emp.name)+'</div><div class="pm-emp-details"><div>'+pmEsc(emp.name)+'</div>';
    if(emp.id) h+='<div class="pm-emp-id">ID: '+pmEsc(emp.id)+'</div>';
    h+='</div></div></div></td>';
    for(var i=0;i<7;i++){ var key=pmDayKeys[i]; var hrs=emp.days[key]||0; var wknd=(i===0||i===1); var c="pm-cell-hrs"; if(hrs>8)c+=" overtime"; else if(hrs>0&&wknd)c+=" weekend-hrs"; else if(hrs>0)c+=" has-hours"; else c+=" zero"; var content=hrs>0?hrs:'<span class="pm-missing-dot"></span>'; h+='<td><span class="'+c+'" onclick="showDayDetail(\''+safeName+'\',\''+safeId+'\',\''+key+'\')">'+content+'</span></td>'; }
    var tc="pm-cell-total"; if(emp.total>=40)tc+=" over"; else if(emp.total>=39.5)tc+=" good"; else if(emp.total>0)tc+=" low";
    h+='<td><span class="'+tc+'">'+emp.total+'</span></td></tr>';
  });
  h+='</tbody>';
  var dayTotals=[],grand=0; for(var i=0;i<7;i++){ var s=0; employees.forEach(function(emp){s+=emp.days[pmDayKeys[i]]||0;}); dayTotals.push(s); grand+=s; }
  h+='<tfoot><tr><td>All Employees</td>'; for(var i=0;i<7;i++) h+='<td>'+dayTotals[i]+'</td>'; h+='<td>'+grand+'</td></tr></tfoot></table>';
  area.innerHTML=h; updateStats(employees);
}

/* ── drag & drop ── */
function pmDragStart(e,idx){ pmDragSrcIndex=idx; e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain",idx); setTimeout(function(){e.target.closest("tr").classList.add("dragging");},0); }
function pmDragOver(e,idx){ e.preventDefault(); e.dataTransfer.dropEffect="move"; var tr=e.target.closest("tr"); if(!tr)return; document.querySelectorAll(".pm-table tbody tr").forEach(function(r){r.classList.remove("drag-over-top","drag-over-bottom");}); if(idx<pmDragSrcIndex)tr.classList.add("drag-over-top"); else if(idx>pmDragSrcIndex)tr.classList.add("drag-over-bottom"); }
function pmDragLeave(e){ var tr=e.target.closest("tr"); if(tr)tr.classList.remove("drag-over-top","drag-over-bottom"); }
function pmDrop(e,targetIdx){ e.preventDefault(); document.querySelectorAll(".pm-table tbody tr").forEach(function(r){r.classList.remove("drag-over-top","drag-over-bottom","dragging");}); if(pmDragSrcIndex===null||pmDragSrcIndex===targetIdx)return; var rows=document.querySelectorAll(".pm-table tbody tr[data-emp]"); var names=[]; rows.forEach(function(r){names.push(r.getAttribute("data-emp"));}); var moved=names.splice(pmDragSrcIndex,1)[0]; names.splice(targetIdx,0,moved); saveOrder(names); pmDragSrcIndex=null; renderTable(); }
function pmDragEnd(e){ pmDragSrcIndex=null; document.querySelectorAll(".pm-table tbody tr").forEach(function(r){r.classList.remove("drag-over-top","drag-over-bottom","dragging");}); }

/* ── stats ── */
function updateStats(employees){
  var totalHours=0,totalEntries=0,proj={},active=0;
  employees.forEach(function(emp){ totalHours+=emp.total; totalEntries+=emp.entries.length; if(emp.total>0)active++; emp.entries.forEach(function(e){ if(e.timeSheetProjectName)proj[e.timeSheetProjectName]=true; }); });
  var c=el("pmStats").children;
  c[0].innerHTML='<div class="pm-stat-value">'+totalHours+'</div><div class="pm-stat-label">Total Hours</div>';
  c[1].className="pm-stat-card"+(active<employees.length?" warn":" success");
  c[1].innerHTML='<div class="pm-stat-value">'+active+' / '+employees.length+'</div><div class="pm-stat-label">Employees Reporting</div>';
  c[2].innerHTML='<div class="pm-stat-value">'+totalEntries+'</div><div class="pm-stat-label">Time Entries</div>';
  c[3].innerHTML='<div class="pm-stat-value">'+Object.keys(proj).length+'</div><div class="pm-stat-label">Active Projects</div>';
}

/* ── modals ── */
function showPmModal(html){ el("pmModalContainer").innerHTML='<div class="pm-detail-overlay" onclick="if(event.target===this)closePmModal()">'+html+'</div>'; }
function closePmModal(){ el("pmModalContainer").innerHTML=""; }
function buildEmpOptions(sel){ return '<option value="">-- Select employee --</option>'+pmEmployeeList.map(function(e){ return '<option value="'+pmEsc(e.name)+'"'+((e.name||"")===sel?" selected":"")+'>'+pmEsc(e.name)+'</option>'; }).join(""); }
function buildProjectOptions(sel){ var p={}; pmProjectNames.forEach(function(n){ p[n]=true; }); LEAVE_TYPES.forEach(function(t){p[t]=true;}); return '<option value="">-- Select project --</option>'+Object.keys(p).sort().map(function(x){ return '<option value="'+pmEsc(x)+'"'+(x===sel?" selected":"")+'>'+pmEsc(x)+'</option>'; }).join(""); }

/* ── day detail ── */
function showDayDetail(empName,empId,dateKey){
  var entries=pmAllItems.filter(function(it){ return (it.timeSheetEmployeeName||"")===empName && pmFmtDate(it.timeSheetDate)===dateKey; });
  var d=new Date(dateKey+"T12:00:00"); var dayTotal=0;
  var h='<div class="pm-detail-box"><div class="pm-detail-header"><h3>'+pmEsc(empName)+' — '+pmFormatDateFull(d)+'</h3><button class="pm-detail-close" onclick="closePmModal()">&times;</button></div>';
  if(!entries.length){ h+='<div class="pm-no-data" style="padding:1rem;">No entries for this day.</div>'; }
  else {
    entries.forEach(function(it){
      var hrs=parseFloat(it.timeSheetWorkHours)||0; dayTotal+=hrs;
      var sched="";
      if(it.timeSheetWorkStatTime){ sched=it.timeSheetWorkStatTime; if(it.timeSheetWorkEndTime)sched+=" – "+it.timeSheetWorkEndTime; if(it.timeSheetWorkLunchTime&&parseFloat(it.timeSheetWorkLunchTime)>0)sched+=" | Lunch: "+it.timeSheetWorkLunchTime+"h"; if(it.timeSheetWorkStatTime2)sched+=" | "+it.timeSheetWorkStatTime2; if(it.timeSheetWorkEndTime2)sched+=" – "+it.timeSheetWorkEndTime2; }
      h+='<div class="pm-entry-row"><div class="pm-entry-info"><div class="pm-entry-project">'+pmEsc(it.timeSheetProjectName||"No project")+'</div>';
      h+='<div class="pm-entry-work">'+pmEsc(it.timeSheetWorkCompleted||"No description")+'</div>';
      if(sched) h+='<div class="pm-entry-schedule">&#128339; '+pmEsc(sched)+'</div>';
      h+='</div><div class="pm-entry-hrs"><span class="hrs-badge" style="font-size:12px;padding:3px 8px;">'+hrs+' hrs</span></div>';
      h+='<div class="pm-entry-actions"><button class="pm-btn-edit" onclick="openEditForm(\''+it.id+'\')">&#9998; Edit</button>';
      h+='<button class="pm-btn-delete" onclick="confirmDeleteEntry(\''+it.id+'\',\''+pmEsc(empName).replace(/'/g,"\\'")+'\',\''+pmEsc(empId).replace(/'/g,"\\'")+'\',\''+dateKey+'\')">&#128465;</button></div></div>';
    });
    h+='<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 4px;border-top:1px solid var(--border);margin-top:4px;"><span style="font-weight:700;color:var(--text-muted);font-size:13px;">Day Total</span><span style="font-weight:700;color:var(--acc);font-size:15px;">'+dayTotal+' hrs</span></div>';
  }
  h+='<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border);"><button class="pm-btn-add" onclick="closePmModal();openAddForm(\''+pmEsc(empName).replace(/'/g,"\\'")+'\',\''+pmEsc(empId).replace(/'/g,"\\'")+'\',\''+dateKey+'\')">&#43; Add entry for this day</button></div></div>';
  showPmModal(h);
}

/* ── add ── */
function openAddForm(prefillName,prefillId,prefillDate){
  var h='<div class="pm-detail-box"><div class="pm-detail-header"><h3>Add Time Entry</h3><button class="pm-detail-close" onclick="closePmModal()">&times;</button></div><div class="pm-form-grid">';
  h+='<div><label class="pm-form-label">Employee *</label><select class="pm-form-input" id="pmFormEmp" onchange="pmFormEmpChanged()">'+buildEmpOptions(prefillName||"")+'</select><input type="hidden" id="pmFormEmpId" value="'+pmEsc(prefillId||"")+'"></div>';
  h+='<div><label class="pm-form-label">Project / type *</label><select class="pm-form-input" id="pmFormProject">'+buildProjectOptions("")+'</select></div>';
  h+='<div><label class="pm-form-label">Date *</label><input type="date" class="pm-form-input" id="pmFormDate" value="'+(prefillDate||"")+'"></div>';
  h+='<div><label class="pm-form-label">Hours *</label><input type="text" class="pm-form-input" id="pmFormHours" inputmode="decimal" placeholder="0" onchange="pmFormHoursChanged()" onblur="pmFormHoursChanged()"></div>';
  h+=pmBuildScheduleHtml("pmForm");
  h+='<div class="pm-form-full"><label class="pm-form-label">Work completed</label><textarea class="pm-form-input" id="pmFormWork" rows="3" placeholder="Describe the work…"></textarea></div>';
  h+='</div><div id="pmFormMsg" class="pm-form-msg"></div><div class="pm-form-actions"><button class="pm-btn-cancel" onclick="closePmModal()">Cancel</button><button class="pm-btn-save" id="pmFormSaveBtn" onclick="saveNewEntry()">&#10003; Save entry</button></div></div>';
  showPmModal(h);
  var w=el("pmFormSchedWrap"); if(w) w.style.display="none";
  if(prefillName){ var hrs=parseFloat((el("pmFormHours")||{}).value)||0; if(hrs>0) pmAutoCalcSchedule("pmForm",prefillName,hrs); }
}
function pmFormEmpChanged(){ el("pmFormEmpId").value=pmFindEmpId(el("pmFormEmp").value); pmFormHoursChanged(); }
function pmFormHoursChanged(){ pmAutoCalcSchedule("pmForm", el("pmFormEmp").value, parseFloat(el("pmFormHours").value)||0); }

async function saveNewEntry(){
  var msg=el("pmFormMsg");
  var empName=el("pmFormEmp").value, empId=el("pmFormEmpId").value||pmFindEmpId(empName);
  var project=el("pmFormProject").value, date=el("pmFormDate").value, hours=el("pmFormHours").value, work=el("pmFormWork").value.trim();
  var leave=isLeaveType(project);
  if(!empName||!project||!date||(!leave&&(!hours||parseFloat(hours)<=0))){ return pmMsg(msg,"Fill the required fields"+(leave?".":" and set hours above 0.")); }
  el("pmFormSaveBtn").disabled=true; pmMsg(msg,"Saving…",1);
  try{ await DCR.api("/api/portal?action=timesheets",{method:"POST",body:{fields:pmBuildWriteFields("pmForm",empName,empId,project,date,hours,work)}}); closePmModal(); await loadAllData(); }
  catch(e){ pmMsg(msg,e.message||"Save failed."); el("pmFormSaveBtn").disabled=false; }
}

/* ── edit ── */
function openEditForm(itemId){
  var it=pmAllItems.find(function(x){return x.id==itemId;}); if(!it) return; closePmModal();
  var h='<div class="pm-detail-box"><div class="pm-detail-header"><h3>Edit Time Entry</h3><button class="pm-detail-close" onclick="closePmModal()">&times;</button></div><div class="pm-form-grid">';
  h+='<div><label class="pm-form-label">Employee *</label><select class="pm-form-input" id="pmEditEmp" onchange="pmEditEmpChanged()">'+buildEmpOptions(it.timeSheetEmployeeName||"")+'</select><input type="hidden" id="pmEditEmpId" value="'+pmEsc(it.timeSheetProployeeID||"")+'"></div>';
  h+='<div><label class="pm-form-label">Project / type *</label><select class="pm-form-input" id="pmEditProject">'+buildProjectOptions(it.timeSheetProjectName||"")+'</select></div>';
  h+='<div><label class="pm-form-label">Date *</label><input type="date" class="pm-form-input" id="pmEditDate" value="'+pmFmtDate(it.timeSheetDate)+'"></div>';
  h+='<div><label class="pm-form-label">Hours *</label><input type="text" class="pm-form-input" id="pmEditHours" inputmode="decimal" value="'+(it.timeSheetWorkHours||0)+'" onchange="pmEditHoursChanged()" onblur="pmEditHoursChanged()"></div>';
  h+=pmBuildScheduleHtml("pmEdit");
  h+='<div class="pm-form-full"><label class="pm-form-label">Work completed</label><textarea class="pm-form-input" id="pmEditWork" rows="3">'+pmEsc(it.timeSheetWorkCompleted||"")+'</textarea></div>';
  h+='</div><div id="pmEditMsg" class="pm-form-msg"></div><div class="pm-form-actions"><button class="pm-btn-danger" onclick="confirmDeleteEntry(\''+it.id+'\')">&#128465; Delete</button><div style="flex:1;"></div><button class="pm-btn-cancel" onclick="closePmModal()">Cancel</button><button class="pm-btn-save" id="pmEditSaveBtn" onclick="saveEditEntry(\''+it.id+'\')">&#10003; Save changes</button></div></div>';
  showPmModal(h);
  if(!isLeaveType(it.timeSheetProjectName) && it.timeSheetWorkStatTime){
    el("pmEditSchedWrap").style.display="";
    el("pmEditStart1").value=pmDisplayToTimeInput(it.timeSheetWorkStatTime);
    el("pmEditEnd1").value=pmDisplayToTimeInput(it.timeSheetWorkEndTime);
    el("pmEditLunch").value=it.timeSheetWorkLunchTime||"0";
    el("pmEditStart2").value=pmDisplayToTimeInput(it.timeSheetWorkStatTime2);
    el("pmEditEnd2").value=pmDisplayToTimeInput(it.timeSheetWorkEndTime2);
    pmSchedRecalc("pmEdit");
  } else {
    pmAutoCalcSchedule("pmEdit", it.timeSheetEmployeeName, parseFloat(it.timeSheetWorkHours)||0);
  }
}
function pmEditEmpChanged(){ el("pmEditEmpId").value=pmFindEmpId(el("pmEditEmp").value); pmEditHoursChanged(); }
function pmEditHoursChanged(){ pmAutoCalcSchedule("pmEdit", el("pmEditEmp").value, parseFloat(el("pmEditHours").value)||0); }

async function saveEditEntry(itemId){
  var msg=el("pmEditMsg");
  var empName=el("pmEditEmp").value, empId=el("pmEditEmpId").value||pmFindEmpId(empName);
  var project=el("pmEditProject").value, date=el("pmEditDate").value, hours=el("pmEditHours").value, work=el("pmEditWork").value.trim();
  var leave=isLeaveType(project);
  if(!empName||!project||!date||(!leave&&(!hours||parseFloat(hours)<=0))){ return pmMsg(msg,"Fill the required fields"+(leave?".":" and set hours above 0.")); }
  el("pmEditSaveBtn").disabled=true; pmMsg(msg,"Saving…",1);
  try{ await DCR.api("/api/portal?action=timesheets",{method:"PATCH",body:{itemId:itemId,fields:pmBuildWriteFields("pmEdit",empName,empId,project,date,hours,work)}}); closePmModal(); await loadAllData(); }
  catch(e){ pmMsg(msg,e.message||"Update failed."); el("pmEditSaveBtn").disabled=false; }
}

function pmMsg(node,text,busy){ node.innerHTML='<span style="color:'+(busy?"var(--text-muted)":"var(--err)")+';">'+pmEsc(text)+'</span>'; }

/* ── delete ── */
function confirmDeleteEntry(itemId,empName,empId,dateKey){
  closePmModal();
  var h='<div class="pm-detail-box" style="width:400px;"><h3 style="margin:0 0 0.75rem;">Delete this entry?</h3><p style="font-size:14px;color:var(--text-muted);margin:0 0 1rem;">This time entry will be permanently deleted.</p><div id="pmDeleteMsg" class="pm-form-msg"></div><div class="pm-form-actions"><button class="pm-btn-cancel" onclick="closePmModal()">Cancel</button><button class="pm-btn-danger" id="pmDeleteBtn" onclick="doDeleteEntry(\''+itemId+'\'';
  if(empName) h+=',\''+empName.replace(/'/g,"\\'")+'\',\''+(empId||"").replace(/'/g,"\\'")+'\',\''+(dateKey||"")+'\'';
  h+=')">&#128465; Yes, delete</button></div></div>';
  showPmModal(h);
}
async function doDeleteEntry(itemId,empName,empId,dateKey){
  var msg=el("pmDeleteMsg"); el("pmDeleteBtn").disabled=true; pmMsg(msg,"Deleting…",1);
  try{ await DCR.api("/api/portal?action=timesheets",{method:"DELETE",body:{itemId:itemId}}); closePmModal(); await loadAllData(); if(empName&&dateKey) showDayDetail(empName,empId||"",dateKey); }
  catch(e){ pmMsg(msg,e.message||"Delete failed."); el("pmDeleteBtn").disabled=false; }
}

/* ── CSV export ── */
function exportCSV(){
  var employees=getWeekData(); if(!employees.length){ DCR.alert("No data to export."); return; }
  var rows=[], header=["Employee","Employee ID"];
  for(var i=0;i<7;i++){ var d=new Date(pmWeekStart); d.setDate(d.getDate()+i); header.push(pmDayNames[i]+" "+pmFormatDateShort(d)); } header.push("Total"); rows.push(header);
  employees.forEach(function(emp){ var row=[emp.name,emp.id]; for(var i=0;i<7;i++) row.push(emp.days[pmDayKeys[i]]||0); row.push(emp.total); rows.push(row); });
  var csv=rows.map(function(r){ return r.map(function(c){ return '"'+String(c).replace(/"/g,'""')+'"'; }).join(","); }).join("\n");
  var blob=new Blob([csv],{type:"text/csv"}); var url=URL.createObjectURL(blob); var a=document.createElement("a"); a.href=url; a.download="timesheets_"+pmWeekStart.toISOString().split("T")[0]+".csv"; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

/* ── load ── */
async function loadAllData(){
  el("pmTableArea").innerHTML='<div class="pm-no-data">Loading time sheets…</div>';
  var seq=++pmLoadSeq;
  try{
    var results=await Promise.all([ DCR.api("/api/portal?action=timesheets"+pmWeekRangeQS()), DCR.api("/api/portal?action=roster") ]);
    if(seq!==pmLoadSeq) return;   // a newer week was asked for while this was in flight
    var ts=results[0], roster=results[1];
    pmScope=ts.scope;
    pmProjectNames=ts.projectNames||[];
    pmAllItems=(ts.items||[]).map(function(it){
      it.timeSheetWorkStatTime=pmIsoToDisplay(it.timeSheetWorkStatTime);
      it.timeSheetWorkEndTime=pmIsoToDisplay(it.timeSheetWorkEndTime);
      it.timeSheetWorkStatTime2=pmIsoToDisplay(it.timeSheetWorkStatTime2);
      it.timeSheetWorkEndTime2=pmIsoToDisplay(it.timeSheetWorkEndTime2);
      return it;
    });
    pmEmployeeList=roster.employees||[];
    var note=el("pmScopeNote");
    if(pmScope==="*") note.textContent="Viewing all employees.";
    else if(pmScope&&pmScope.managed&&pmScope.managed.length) note.textContent="Viewing your crew: "+[pmScope.self].concat(pmScope.managed).filter(Boolean).join(", ")+".";
    else note.innerHTML='<span style="color:var(--gold)">You only manage your own timesheets. Use the Time Sheet page for your own entries.</span>';
    var sel=el("pmFilterProject"); var cur=sel.value; sel.innerHTML='<option value="">All projects</option>';
    pmProjectNames.forEach(function(p){ var o=document.createElement("option"); o.value=p.toLowerCase(); o.textContent=p; sel.appendChild(o); }); sel.value=cur;
    renderTable();
  }catch(e){
    /* A failure from a week the user has already moved off must not paint over
       the week they are now looking at - otherwise clicking through weeks
       quickly leaves an error sitting on top of good data. */
    if(seq!==pmLoadSeq) return;
    el("pmTableArea").innerHTML='<div class="pm-no-data" style="color:var(--err);">'+pmEsc(e.message||"Error loading data.")+'</div>';
  }
}

document.addEventListener("DOMContentLoaded", async function(){
  var profile=await DCR.requireAuth();
  el("companyName").textContent=DCR.company+" Portal";
  el("userPill").textContent=(profile.displayName||profile.email)+" · "+profile.role;
  el("logoutBtn").onclick=function(){ DCR.logout(); };
  pmWeekStart=pmGetSaturday(new Date()); buildWeek();
  await loadAllData();
});
