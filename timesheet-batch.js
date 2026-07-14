/* DCR portal — Batch Time Entry (manager / lead / office).
   Submits one timesheet per selected employee through the authenticated gateway
   (action=timesheets / action=roster). Roster is scope-limited, and every write is
   re-checked server-side. Same dateTime/number/leave handling as the other pages. */

var btEmployees = [];   // [{ name, employeeId, start1, end1, start2, end2, lunch }]
var btSelected = {};    // name -> { name, id }
var btScope = null;
var LEAVE_TYPES = ["Holiday","Vacation","Sick","Day Off"];
function isLeaveType(t){ return LEAVE_TYPES.indexOf(t)!==-1; }
function currentDayType(){ return document.getElementById("btDayType").value; }

function el(id){ return document.getElementById(id); }
function btEsc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function btInitials(name){ if(!name)return"?";var p=name.trim().split(/\s+/);if(p.length>=2)return(p[0][0]+p[p.length-1][0]).toUpperCase();return name.substring(0,2).toUpperCase(); }

/* ── time helpers (same conventions as the other pages) ── */
function btParseSpTime(iso){ if(!iso) return null; var d=new Date(iso); if(isNaN(d)) return null; var t=new Date(2000,0,1,0,0,0,0); t.setUTCHours(d.getUTCHours(),d.getUTCMinutes(),0,0); return {hours:t.getHours(),minutes:t.getMinutes()}; }
function btTimeToStr(h,m){ return String(h).padStart(2,"0")+":"+String(m||0).padStart(2,"0"); }
function btTimeToDisplay(h,m){ var a=h>=12?"PM":"AM";var h12=h%12||12;return h12+":"+String(m||0).padStart(2,"0")+" "+a; }
function btParseTimeInput(id){ var v=el(id).value; if(!v) return null; var p=v.split(":"); return {hours:parseInt(p[0]),minutes:parseInt(p[1]||0)}; }
function btTimeToMinutes(t){ return t? t.hours*60+t.minutes : 0; }
function btMinutesToTime(m){ return {hours:Math.floor(m/60),minutes:m%60}; }
function btTimeToISO(id,dateStr){ var t=btParseTimeInput(id); if(!t||!dateStr) return null; var p=String(dateStr).split("-"); if(p.length!==3) return null; var d=new Date(+p[0],+p[1]-1,+p[2],t.hours,t.minutes,0,0); return isNaN(d)?null:d.toISOString(); }

/* ── schedule defaults from the FIRST selected employee ── */
function btGetDefaults(){
  var names=Object.keys(btSelected); if(!names.length) return null;
  var e=btEmployees.find(function(x){return x.name===names[0];}); if(!e) return null;
  return { name:e.name, start1:btParseSpTime(e.start1), end1:btParseSpTime(e.end1), start2:btParseSpTime(e.start2), end2:btParseSpTime(e.end2), lunch:parseFloat(e.lunch)||1 };
}

function btAutoCalcSchedule(){
  if(isLeaveType(currentDayType())){ el("btScheduleSection").style.display="none"; return; }
  var hours=parseFloat(el("btHours").value)||0;
  var def=btGetDefaults();
  if(hours<=0 || !def || !def.start1){ el("btScheduleSection").style.display="none"; return; }
  el("btScheduleSection").style.display="";
  el("btSchedNote").textContent="(from "+def.name+"’s schedule — applies to everyone selected)";
  var s1=btTimeToMinutes(def.start1), e1=btTimeToMinutes(def.end1), s2=btTimeToMinutes(def.start2);
  var cap=(e1-s1)/60, total=hours*60;
  if(hours<=cap){
    el("btStart1").value=btTimeToStr(def.start1.hours,def.start1.minutes);
    var ce=btMinutesToTime(s1+total); el("btEnd1").value=btTimeToStr(ce.hours,ce.minutes);
    el("btLunch").value=0; el("btStart2").value=""; el("btEnd2").value="";
  } else {
    el("btStart1").value=btTimeToStr(def.start1.hours,def.start1.minutes);
    el("btEnd1").value=btTimeToStr(def.end1.hours,def.end1.minutes);
    el("btLunch").value=def.lunch;
    el("btStart2").value=btTimeToStr(def.start2.hours,def.start2.minutes);
    var rem=total-(e1-s1); var ce2=btMinutesToTime(s2+rem); el("btEnd2").value=btTimeToStr(ce2.hours,ce2.minutes);
  }
  btRecalc();
}

function btRecalc(){
  var s1=btParseTimeInput("btStart1"),e1=btParseTimeInput("btEnd1"),s2=btParseTimeInput("btStart2"),e2=btParseTimeInput("btEnd2");
  var lunch=parseFloat(el("btLunch").value)||0, entered=parseFloat(el("btHours").value)||0;
  var calc=0; if(s1&&e1) calc+=(btTimeToMinutes(e1)-btTimeToMinutes(s1))/60; if(s2&&e2) calc+=(btTimeToMinutes(e2)-btTimeToMinutes(s2))/60;
  var lr=el("btLunchRange");
  if(e1&&lunch>0){ var le=btMinutesToTime(btTimeToMinutes(e1)+lunch*60); lr.textContent=btTimeToDisplay(e1.hours,e1.minutes)+" – "+btTimeToDisplay(le.hours,le.minutes); }
  else lr.textContent=lunch>0?"":"No lunch";
  btRenderTimeline(s1,e1,lunch,s2,e2);
  var bar=el("btCalcBar");
  if(entered>0){
    var match=Math.abs(calc-entered)<0.01;
    var h='<div class="bt-calc-bar '+(match?"bt-calc-match":"bt-calc-mismatch")+'">';
    h+='<div><span class="bt-calc-label">Entered:</span> <span class="bt-calc-value">'+entered+'</span></div>';
    h+='<div><span class="bt-calc-label">Calculated:</span> <span class="bt-calc-value">'+calc.toFixed(1)+'</span></div>';
    h+='<div style="font-weight:700;">'+(match?"✓ Match":"⚠ "+((calc-entered)>0?"+":"")+(calc-entered).toFixed(1)+"h")+'</div></div>';
    bar.innerHTML=h;
  } else bar.innerHTML="";
  btUpdatePreview();
}

function btRenderTimeline(s1,e1,lunch,s2,e2){
  var c=el("btTimeline"); if(!s1||!e1){ c.innerHTML=""; return; }
  var s1m=btTimeToMinutes(s1),e1m=btTimeToMinutes(e1),lm=(lunch||0)*60,s2m=s2?btTimeToMinutes(s2):0,e2m=e2?btTimeToMinutes(e2):0;
  var start=s1m, end=(s2&&e2)?e2m:(lm>0?e1m+lm:e1m); var span=end-start; if(span<=0){ c.innerHTML=""; return; }
  var w1=((e1m-s1m)/span*100).toFixed(1), wl=(lm/span*100).toFixed(1), w2=(s2&&e2)?(((e2m-s2m)/span*100).toFixed(1)):0;
  var h='<div class="bt-timeline"><div class="bt-timeline-block bt-timeline-work" style="width:'+w1+'%">'+((e1m-s1m)/60)+'h</div>';
  if(lm>0) h+='<div class="bt-timeline-block bt-timeline-lunch" style="width:'+wl+'%">'+lunch+'h</div>';
  if(s2&&e2&&e2m>s2m) h+='<div class="bt-timeline-block bt-timeline-work" style="width:'+w2+'%">'+((e2m-s2m)/60)+'h</div>';
  h+='</div><div class="bt-timeline-labels"><span>'+btTimeToDisplay(s1.hours,s1.minutes)+'</span><span>'+btTimeToDisplay((s2&&e2?e2:e1).hours,(s2&&e2?e2:e1).minutes)+'</span></div>';
  c.innerHTML=h;
}

/* ── day type ── */
function btDayTypeChange(){
  var type=currentDayType(), proj=el("btProject");
  if(isLeaveType(type)){
    proj.value=type; el("btProjField").style.display="none";
    el("btScheduleSection").style.display="none"; el("btTimeline").innerHTML=""; el("btCalcBar").innerHTML="";
  } else {
    el("btProjField").style.display="";
    if(LEAVE_TYPES.indexOf(proj.value)!==-1) proj.value="";
    btAutoCalcSchedule();
  }
  btUpdatePreview();
}

/* ── employee picker ── */
function btRenderList(){
  var q=el("btEmpSearch").value.trim().toLowerCase(), list=el("btEmpList");
  var f=btEmployees.filter(function(e){ return !q || (e.name||"").toLowerCase().indexOf(q)!==-1; });
  if(!f.length){ list.innerHTML='<div style="padding:12px;color:var(--text-muted);font-size:13px;font-style:italic;">No employees found</div>'; return; }
  list.innerHTML=f.map(function(e){
    var name=e.name||"", sel=btSelected[name]?" selected":"";
    return '<div class="bt-emp-item'+sel+'" onclick="btToggleEmp(\''+btEsc(name).replace(/'/g,"\\'")+'\')">'+
      '<div class="bt-emp-checkbox"><span class="bt-emp-checkmark">&#10003;</span></div>'+
      '<div class="bt-emp-avatar">'+btInitials(name)+'</div>'+
      '<span class="bt-emp-name-text">'+btEsc(name)+'</span></div>';
  }).join("");
}
function btToggleEmp(name){
  if(btSelected[name]) delete btSelected[name];
  else { var e=btEmployees.find(function(x){return x.name===name;}); btSelected[name]={name:name,id:e?e.employeeId:""}; }
  btRenderList(); btRenderSelected(); btAutoCalcSchedule();
}
function btSelectAll(){
  var q=el("btEmpSearch").value.trim().toLowerCase();
  btEmployees.forEach(function(e){ var name=e.name||""; if(!name) return; if(q&&name.toLowerCase().indexOf(q)===-1) return; btSelected[name]={name:name,id:e.employeeId||""}; });
  btRenderList(); btRenderSelected(); btAutoCalcSchedule();
}
function btDeselectAll(){ btSelected={}; btRenderList(); btRenderSelected(); btAutoCalcSchedule(); }
function btRemoveChip(name){ delete btSelected[name]; btRenderList(); btRenderSelected(); btAutoCalcSchedule(); }
function btRenderSelected(){
  var bar=el("btSelectedBar"), names=Object.keys(btSelected);
  if(!names.length){ bar.innerHTML='<span style="font-size:12px;color:var(--text-muted);font-style:italic;">No employees selected</span>'; btUpdatePreview(); return; }
  bar.innerHTML='<span class="bt-selected-count">'+names.length+' selected:</span> '+names.map(function(name){
    return '<span class="bt-selected-chip">'+btEsc(name)+'<span class="bt-selected-chip-remove" onclick="event.stopPropagation();btRemoveChip(\''+btEsc(name).replace(/'/g,"\\'")+'\')">&times;</span></span>';
  }).join("");
  btUpdatePreview();
}
function btFilterList(){ btRenderList(); }

/* ── hours ── */
function btAdjustHrs(d){ var i=el("btHours"); var n=Math.round(((parseFloat(i.value)||0)+d)*2)/2; if(n<0)n=0; if(n>24)n=24; i.value=n; btAutoCalcSchedule(); }
function btSyncHrs(){ var i=el("btHours"); var v=i.value.replace(/[^0-9.]/g,""); if(v!==i.value)i.value=v; btAutoCalcSchedule(); }
function btCleanHrs(){ var i=el("btHours"); var n=parseFloat(i.value); i.value=(isNaN(n)||n<0)?0:(n>24?24:n); btAutoCalcSchedule(); }

/* ── preview ── */
function btUpdatePreview(){
  var section=el("btPreviewSection"), list=el("btPreviewList");
  var names=Object.keys(btSelected), leave=isLeaveType(currentDayType());
  var project=leave?currentDayType():el("btProject").value.trim();
  var date=el("btDate").value, hours=parseFloat(el("btHours").value)||0;
  if(!names.length){ section.style.display="none"; return; }
  section.style.display="";
  var dateLabel=""; if(date){ dateLabel=new Date(date+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); }
  var s1v=el("btStart1").value, e1v=el("btEnd1").value, e2v=el("btEnd2").value, timeRange="";
  if(!leave && s1v){ var endV=e2v||e1v; if(endV){ var sp=s1v.split(":"),ep=endV.split(":"); timeRange=btTimeToDisplay(parseInt(sp[0]),parseInt(sp[1]))+" – "+btTimeToDisplay(parseInt(ep[0]),parseInt(ep[1])); } }
  var h=names.map(function(name){
    var r='<div class="bt-preview-row"><span class="bt-preview-emp">'+btEsc(name)+'</span>';
    r+='<span class="bt-preview-detail">'+btEsc(project||"—")+'</span>';
    r+='<span class="bt-preview-detail">'+(dateLabel||"—")+'</span>';
    if(timeRange) r+='<span class="bt-preview-detail">'+timeRange+'</span>';
    r+='<span class="bt-preview-badge">'+hours+' hrs</span></div>';
    return r;
  }).join("");
  h+='<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">';
  h+='<span style="font-size:12px;color:var(--text-muted);font-weight:600;">'+names.length+' entries × '+hours+' hrs</span>';
  h+='<span style="font-size:14px;font-weight:700;color:var(--acc);">'+(names.length*hours)+' total hours</span></div>';
  list.innerHTML=h;
}

/* ── submit (one entry per employee) ── */
async function btSubmit(){
  var msg=el("btMsg"), result=el("btResult");
  var names=Object.keys(btSelected);
  var leave=isLeaveType(currentDayType());
  var project=leave?currentDayType():el("btProject").value.trim();
  var date=el("btDate").value, hours=el("btHours").value, work=el("btWork").value.trim();
  result.innerHTML="";
  if(!names.length){ return btErr(msg,"Please select at least one employee."); }
  if(!project){ return btErr(msg,"Please enter a project name."); }
  if(!date){ return btErr(msg,"Please select a date."); }
  if(!leave && (!hours||parseFloat(hours)<=0)){ return btErr(msg,"Please set hours above 0."); }

  // schedule (same for everyone); calc hours
  var s1=btParseTimeInput("btStart1"),e1=btParseTimeInput("btEnd1"),s2=btParseTimeInput("btStart2"),e2=btParseTimeInput("btEnd2");
  var calc=0; if(s1&&e1) calc+=(btTimeToMinutes(e1)-btTimeToMinutes(s1))/60; if(s2&&e2) calc+=(btTimeToMinutes(e2)-btTimeToMinutes(s2))/60;
  var iso={ st1:btTimeToISO("btStart1",date), en1:btTimeToISO("btEnd1",date), st2:btTimeToISO("btStart2",date), en2:btTimeToISO("btEnd2",date) };
  var lunch=Number(el("btLunch").value)||0;

  var btn=el("btSubmitBtn"); btn.disabled=true;
  msg.innerHTML='<span style="color:var(--text-muted);">Submitting '+names.length+' entries…</span>';

  var ok=[], fail=[];
  for(var i=0;i<names.length;i++){
    var name=names[i], empId=btSelected[name].id||"";
    var fields={
      timeSheetEmployeeName:name, timeSheetProjectName:project, timeSheetDate:date,
      timeSheetWorkHours:Number(hours)||0, timeSheetWorkCompleted:work,
      timeSheetWorkStatTime:iso.st1, timeSheetWorkEndTime:iso.en1, timeSheetWorkLunchTime:lunch,
      timeSheetWorkStatTime2:iso.st2, timeSheetWorkEndTime2:iso.en2, timeSheetWorkCalculatedHours:Number(calc)
    };
    if(empId) fields.timeSheetProployeeID=Number(empId);
    try{ await DCR.api("/api/portal?action=timesheets",{method:"POST",body:{fields:fields}}); ok.push(name); }
    catch(e){ fail.push({name:name,error:e.message||"Failed"}); }
    msg.innerHTML='<span style="color:var(--text-muted);">Submitting… '+(i+1)+' / '+names.length+'</span>';
  }
  btn.disabled=false;

  var rh="";
  if(ok.length){
    rh+='<div class="bt-result bt-result-success"><div style="font-weight:700;margin-bottom:6px;">&#10003; '+ok.length+' entries created</div>';
    ok.forEach(function(n){ rh+='<div class="bt-result-item"><span class="bt-preview-check">&#10003;</span> '+btEsc(n)+'</div>'; });
    rh+='</div>';
  }
  if(fail.length){
    rh+='<div class="bt-result bt-result-error" style="margin-top:8px;"><div style="font-weight:700;margin-bottom:6px;">&#10007; '+fail.length+' failed</div>';
    fail.forEach(function(f){ rh+='<div class="bt-result-item">&#10007; '+btEsc(f.name)+' — '+btEsc(f.error)+'</div>'; });
    rh+='</div>';
  }
  result.innerHTML=rh; msg.innerHTML="";
  if(ok.length && !fail.length){
    btDeselectAll();
    el("btHours").value=0; el("btWork").value="";
    el("btPreviewSection").style.display="none"; el("btScheduleSection").style.display="none";
  }
}
function btErr(node,text){ node.innerHTML='<span style="color:var(--err);">'+btEsc(text)+'</span>'; }

/* ── load (scoped roster + project names) ── */
async function btLoadData(){
  try{
    var results=await Promise.all([ DCR.api("/api/portal?action=roster"), DCR.api("/api/portal?action=timesheets") ]);
    btEmployees=(results[0].employees||[]).slice().sort(function(a,b){ return (a.name||"").localeCompare(b.name||""); });
    btScope=results[0].scope;
    btRenderList(); btRenderSelected();
    var proj={}; (results[1].items||[]).forEach(function(it){ if(it.timeSheetProjectName)proj[it.timeSheetProjectName]=true; });
    var dl=el("btProjList"); dl.innerHTML=""; Object.keys(proj).sort().forEach(function(p){ var o=document.createElement("option"); o.value=p; dl.appendChild(o); });
  }catch(e){ el("btEmpList").innerHTML='<div style="padding:12px;color:var(--err);font-size:13px;">'+btEsc(e.message||"Error loading employees.")+'</div>'; }
}

document.addEventListener("DOMContentLoaded", async function(){
  var profile=await DCR.requireAuth();
  el("companyName").textContent=DCR.company+" Portal";
  el("userPill").textContent=(profile.displayName||profile.email)+" · "+profile.role;
  el("logoutBtn").onclick=function(){ DCR.logout(); };
  el("btDate").value=(function(){ var d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); })();
  ["btProject","btDate","btWork"].forEach(function(id){ var e=el(id); if(e){ e.addEventListener("input",btUpdatePreview); e.addEventListener("change",btUpdatePreview); } });
  await btLoadData();
});
