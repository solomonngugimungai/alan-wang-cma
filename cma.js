/* Alan Wang CMA — core logic.
 * Exposed as window globals so the inline onclick handlers in index.html still work.
 *
 * Comp scoring weights (per TJ Hufanga, total = 100):
 *   School zone match  25
 *   SqFt variance      25
 *   Beds match         25
 *   Baths match        20
 *   DOM                 5
 */
var VERSION = "1.2.0";
var DATA = null, CS = [];
var DISTRICTS = ["—","Cupertino Union SD","Sunnyvale SD","Santa Clara Unified","Fremont Union HSD","Mountain View Whisman SD","Los Altos SD","Campbell Union SD","San Jose Unified","Milpitas Unified","Palo Alto Unified","Other"];

/* ── Formatting helpers ─────────────────────────────────────────────── */
function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}
function fmt(n){if(n==null||isNaN(n))return"—";return"$"+Number(n).toLocaleString("en-US",{maximumFractionDigits:0})}
function fmtD(n){if(n==null||isNaN(n))return"—";return"$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
function med(a){if(!a.length)return 0;var s=a.slice().sort(function(x,y){return x-y}),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2}
function show(id){document.querySelectorAll('.screen').forEach(function(el){el.classList.remove('on')});document.getElementById(id).classList.add('on');window.scrollTo(0,0)}

/* ── Listing-source URL builders ────────────────────────────────────── */
/* Build a full address ("123 Main, City, ST ZIP") by borrowing city/state from the subject when the comp only has a street. */
function fullAddr(addr){
  if(!addr)return"";
  if(addr.indexOf(",")!==-1)return addr;
  var cityState="";
  if(DATA&&DATA.subjectAddress){var parts=DATA.subjectAddress.split(",");if(parts.length>=2)cityState=parts.slice(1).join(",").trim()}
  return cityState?addr+", "+cityState:addr;
}
function zillowURL(addr){var slug=fullAddr(addr).replace(/#/g,"").replace(/,/g,"").trim().replace(/\s+/g,"-");return"https://www.zillow.com/homes/"+encodeURIComponent(slug)+"_rb/"}
function redfinURL(addr){return"https://www.redfin.com/?q="+encodeURIComponent(fullAddr(addr))}
function addrLinks(addr){var safe=esc(addr);return'<a class="addr-link" href="'+zillowURL(addr)+'" target="_blank" rel="noopener">'+safe+'</a> <a class="rf-link" href="'+redfinURL(addr)+'" target="_blank" rel="noopener" title="View on Redfin">RF</a>'}

/* ── MLSListings PDF text parser ────────────────────────────────────── */
function parse(raw){
  var lines=raw.split("\n").map(function(l){return l.trim()}).filter(Boolean);
  var subAddr="",subSqFt=null,subBeds="",subBaths="",subCode="";
  for(var i=0;i<lines.length;i++){var sm=lines[i].match(/Subject Property:\s*(.+)/i);if(sm){subAddr=sm[1].trim();break}}
  var groups=[],curSt=null,curC=[],subF=false;
  var stRe=/^Status:\s*(.+)/i,mlsRe=/\b(ML\d{8,}|CC\d{8,})\b/;
  var skipRe=/^(Address|Average|Summary|Total|Brief|Comparative|A brief|A map|Property Loc|Researched|This represents|by Alan|KW Elevate|appraisal|MLS#|Sub Type|SqFt|Beds|Baths|L\/S|Status Dt|DOM|Avg Price|Avg \$|Median|Low|High|Avg DOM|County|Area|Class|Land Use|Orig Price|List Price|Sale Price|\$\/Primary|HOA|Zoning|Source|Public|Well-positioned|Featuring|Additional|community|an open|flow seamlessly|Stylish|Set within|updated fixtures|L\.Type|Special|Ownership|Fin Terms|Possession|Off Mrkt|Incorp|City Limit|Expires|COE|Original|List:|Sale:|LA:|LA Ph|Walk Score|Recent|Report Listing|\d+\s*\/\s*\d+|Previous|Next|Checked|Display|Agent|All\s*·|None|Page|per page|Listing|Tax|Photos|History|Parcel|Flood|Foreclosure|Actions|Refine|Save|Carts|Criteria|Email|Print|CMA|Directions|Stats|Export|Quick|Cloud|SYMBIUM|ADU|Market Trends)/i;
  for(var i=0;i<lines.length;i++){
    var line=lines[i],stm=line.match(stRe);
    if(stm){if(curSt&&curC.length>0)groups.push({status:curSt,comps:curC.slice()});curSt=stm[1].trim();curC=[];subF=false;continue}
    if(skipRe.test(line)||line.length<8)continue;
    if(curSt&&!subF&&subAddr){var ap=subAddr.split(",")[0].trim().split(" "),sa=ap.slice(0,3).join(" ");
      if(line.indexOf(sa)!==-1&&!mlsRe.test(line)){subF=true;var sqm=line.match(/(\d[,\d]*)\s+(\d)\s+(\d\/\d)/);if(sqm){subSqFt=parseInt(sqm[1].replace(",",""));subBeds=sqm[2];subBaths=sqm[3]}var cm=line.match(/\b(10[0-9])\b/);if(cm)subCode=cm[1];continue}}
    if(curSt&&mlsRe.test(line)){var mls=line.match(mlsRe)[1],pm=line.match(/\$[\d,]+/g),price=pm?parseInt(pm[0].replace(/[$,]/g,"")):null;
      var mi=line.indexOf(mls),addr=line.substring(0,mi).trim().replace(/\s+\d+\s*$/,"").trim();
      var subT="",tm=line.match(/Res\.\s*(Townhouse|Condominium|Single Family)/i);if(tm)subT="Res. "+tm[1];
      var after=tm?line.substring(line.indexOf(tm[0])+tm[0].length):line.substring(mi+mls.length);
      var bm=after.match(/(\d\/\d)/),baths=bm?bm[1]:"";
      var nm=after.match(/\b[\d,]+\b/g)||[],cn=nm.map(function(n){return n.replace(",","")});
      var sqft="",beds="";for(var j=0;j<cn.length;j++){var v=parseInt(cn[j]);if(v>=500&&v<=5000&&!sqft)sqft=cn[j];else if(v>=1&&v<=10&&sqft&&!beds)beds=cn[j]}
      var dom="",dm=after.match(/(\d+)\s*$/);if(dm&&parseInt(dm[1])<500)dom=dm[1];
      var dtm=line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/),sdt=dtm?dtm[1]:"";
      curC.push({address:addr||"Unknown",mls:mls,subType:subT,sqft:sqft?parseInt(sqft):null,beds:beds,baths:baths,price:price,statusDt:sdt,dom:dom?parseInt(dom):null,status:curSt})}}
  if(curSt&&curC.length>0)groups.push({status:curSt,comps:curC.slice()});
  return{subjectAddress:subAddr,subjectSqFt:subSqFt,subjectBeds:subBeds,subjectBaths:subBaths,subjectCode:subCode,statusGroups:groups}
}

/* ── Comp scoring (TJ's weights, total 100) ─────────────────────────── */
/* Base score sums to 75 (beds 25 + baths 20 + sqft 25 + dom 5); the
 * school-zone match adds the final 25 in updateZoneScores. */
function scoreComp(c,s){
  var sc=0,fl=[];
  var sBd=parseInt(s.subjectBeds)||0,sFb=parseInt((s.subjectBaths||"0/0").split("/")[0])||0;
  var cBd=parseInt(c.beds)||0,cFb=parseInt((c.baths||"0/0").split("/")[0])||0;

  // Beds — max 25
  var bd=Math.abs(cBd-sBd);
  if(bd===0){sc+=25;fl.push({t:"Beds match",c:"g"})}
  else if(bd===1){sc+=12;fl.push({t:"Beds ±1",c:"y"})}
  else{fl.push({t:"Beds ±"+bd,c:"r"})}

  // Baths — max 20
  var bt=Math.abs(cFb-sFb);
  if(bt===0)sc+=20;
  else if(bt===1){sc+=10;fl.push({t:"Bath ±1",c:"y"})}
  else fl.push({t:"Bath ±"+bt,c:"r"});

  // SqFt — max 25
  if(c.sqft&&s.subjectSqFt){
    var p=Math.abs(c.sqft-s.subjectSqFt)/s.subjectSqFt;
    if(p<=.10){sc+=25;fl.push({t:"SqFt within 10%",c:"g"})}
    else if(p<=.20){sc+=17;fl.push({t:"SqFt within 20%",c:"y"})}
    else if(p<=.30){sc+=8;fl.push({t:"SqFt ±"+Math.round(p*100)+"%",c:"y"})}
    else fl.push({t:"SqFt ±"+Math.round(p*100)+"%",c:"r"});
  }

  // DOM — max 5
  if(c.dom!=null){
    if(c.dom<=30)sc+=5;
    else if(c.dom<=60)sc+=3;
    else if(c.dom<=90){sc+=2;fl.push({t:"DOM "+c.dom,c:"y"})}
    else fl.push({t:"DOM "+c.dom+" (stale)",c:"r"});
  }

  return{score:Math.min(sc,100),flags:fl}
}

/* ── Census Geocoder: auto-detect school zones ──────────────────────── */
function autoDetectZones(){
  var statusEl=document.getElementById("detect-status");
  statusEl.textContent="Starting...";
  var allAddresses=[];
  allAddresses.push({idx:-1,addr:DATA.subjectAddress});
  var cityState="";
  var parts=DATA.subjectAddress.split(",");
  if(parts.length>=2)cityState=parts.slice(1).join(",").trim();
  for(var i=0;i<CS.length;i++){
    var a=CS[i].comp.address;
    if(a.indexOf(",")!==-1)allAddresses.push({idx:i,addr:a});
    else allAddresses.push({idx:i,addr:a+", "+cityState});
  }
  var done=0,total=allAddresses.length;
  function next(){
    if(done>=total){statusEl.textContent="Done! ("+total+" addresses)";updateZoneScores();return}
    var item=allAddresses[done];
    statusEl.textContent="Detecting "+(done+1)+"/"+total+"...";
    censusGeocode(item.addr,function(district){
      if(district){
        if(item.idx===-1){
          var sel=document.getElementById("subj-zone");
          setSelectValue(sel,district);
        }else{
          CS[item.idx].zone=district;
          if(DISTRICTS.indexOf(district)===-1){DISTRICTS.splice(DISTRICTS.length-1,0,district)}
        }
      }
      done++;
      setTimeout(next,300);
    });
  }
  next();
}

function censusGeocode(address,callback){
  var url="https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address="+
    encodeURIComponent(address)+"&benchmark=Public_AR_Current&vintage=Current_Current&layers=14,16&format=json";
  fetch(url).then(function(r){return r.json()}).then(function(data){
    var district="—";
    try{
      var geos=data.result.addressMatches[0].geographies;
      var keys=Object.keys(geos);
      for(var k=0;k<keys.length;k++){
        var layer=geos[keys[k]];
        if(layer&&layer.length>0&&layer[0].NAME){
          district=layer[0].NAME.replace(/ School District$/i,"").replace(/ Elementary$/i," SD").replace(/ Unified$/i," Unified");
          if(keys[k].toLowerCase().indexOf("elementary")!==-1)break;
        }
      }
    }catch(e){}
    callback(district==="—"?null:district);
  }).catch(function(){censusGeocodeJSONP(address,callback)});
}

function censusGeocodeJSONP(address,callback){
  var cbName="cb_"+Date.now()+"_"+Math.random().toString(36).substr(2,5);
  var timeout=setTimeout(function(){delete window[cbName];callback(null)},8000);
  window[cbName]=function(data){
    clearTimeout(timeout);delete window[cbName];
    var district=null;
    try{
      var geos=data.result.addressMatches[0].geographies;
      var keys=Object.keys(geos);
      for(var k=0;k<keys.length;k++){
        var layer=geos[keys[k]];
        if(layer&&layer.length>0&&layer[0].NAME){
          district=layer[0].NAME.replace(/ School District$/i,"").replace(/ Elementary$/i," SD").replace(/ Unified$/i," Unified");
          if(keys[k].toLowerCase().indexOf("elementary")!==-1)break;
        }
      }
    }catch(e){}
    callback(district);
  };
  var s=document.createElement("script");
  s.src="https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address="+
    encodeURIComponent(address)+"&benchmark=Public_AR_Current&vintage=Current_Current&layers=14,16&format=jsonp&callback="+cbName;
  s.onerror=function(){clearTimeout(timeout);delete window[cbName];callback(null)};
  document.head.appendChild(s);
}

function setSelectValue(sel,val){
  for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===val||sel.options[i].text===val){sel.selectedIndex=i;return}}
  var opt=document.createElement("option");opt.text=val;opt.value=val;sel.add(opt,sel.options.length-1);
  sel.value=val;
}

/* ── UI rendering ───────────────────────────────────────────────────── */
function doParse(){
  var raw=document.getElementById("paste-area").value;if(!raw.trim())return;
  DATA=parse(raw);if(DATA.statusGroups.length===0){alert("Could not parse comps. Make sure you copied all text from the CMA PDF.");return}
  CS=[];
  for(var g=0;g<DATA.statusGroups.length;g++){var gr=DATA.statusGroups[g];
    for(var c=0;c<gr.comps.length;c++){var comp=gr.comps[c],sc=scoreComp(comp,DATA);
      CS.push({comp:comp,status:gr.status,score:sc.score,flags:sc.flags,included:true,zone:"—"})}}
  renderReview();show('s2');
}

function renderReview(){
  var h='<div class="subj-card"><div><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:2px">Subject Property</div>';
  h+='<h3>'+esc(DATA.subjectAddress||"—")+'</h3></div>';
  h+='<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">';
  h+='<div class="stats"><div><div class="stat-v">'+(DATA.subjectBeds||"—")+'</div><div class="stat-l">Beds</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectBaths||"—")+'</div><div class="stat-l">Baths</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</div><div class="stat-l">Sq Ft</div></div></div>';
  h+='<div class="zone-row"><label>School Zone</label><select id="subj-zone" onchange="updateZoneScores()">';
  for(var i=0;i<DISTRICTS.length;i++)h+='<option>'+DISTRICTS[i]+'</option>';
  h+='</select>';
  h+='<button class="btn-detect" onclick="autoDetectZones()">&#9672; Auto-Detect All Zones</button>';
  h+='<span id="detect-status"></span>';
  h+='</div></div></div>';
  document.getElementById("subj-card-wrap").innerHTML=h;
  renderCompList();
}

function renderCompList(){
  var h="";
  for(var i=0;i<CS.length;i++){var cs=CS[i],c=cs.comp,cls=cs.included?"":"excluded",scCls=cs.score>=70?"hi":cs.score>=40?"md":"lo";
    h+='<div class="comp-card '+cls+'" id="cc-'+i+'"><div class="cc-body">';
    h+='<input type="checkbox" class="cc-check" '+(cs.included?"checked":"")+' onchange="toggleComp('+i+',this.checked)">';
    h+='<div class="cc-main"><div><div class="cc-addr">'+addrLinks(c.address)+'</div><div class="cc-mls">'+esc(c.mls)+' &middot; '+esc(cs.status)+'</div></div>';
    h+='<div>'+(c.sqft?c.sqft.toLocaleString():"—")+'</div><div>'+(c.beds||"—")+'</div><div>'+(c.baths||"—")+'</div>';
    h+='<div class="cc-fw">'+(c.price?fmt(c.price):"—")+'</div><div class="cc-dim">'+(c.statusDt||"—")+'</div><div>'+(c.dom!=null?c.dom:"—")+'</div></div>';
    h+='<div style="display:flex;align-items:center;gap:8px"><div class="score '+scCls+'">'+cs.score+'</div></div></div>';
    if(cs.flags.length){h+='<div class="flags">';for(var f=0;f<cs.flags.length;f++)h+='<span class="flag flag-'+cs.flags[f].c+'">'+cs.flags[f].t+'</span>';h+='</div>'}
    h+='<div class="cc-zone"><label>School Zone:</label><select onchange="setZone('+i+',this.value)">';
    for(var z=0;z<DISTRICTS.length;z++)h+='<option'+(cs.zone===DISTRICTS[z]?" selected":"")+'>'+DISTRICTS[z]+'</option>';
    if(cs.zone!=="—"&&DISTRICTS.indexOf(cs.zone)===-1)h+='<option selected>'+esc(cs.zone)+'</option>';
    h+='</select></div></div>'}
  document.getElementById("comp-list").innerHTML=h;renderSummary();
}

function renderSummary(){
  var inc=CS.filter(function(c){return c.included}),tot=CS.length;
  var h='<div class="rev-summary"><div class="left"><b>'+inc.length+' of '+tot+'</b> comps selected';
  var zm=0,subjZone=document.getElementById("subj-zone")?document.getElementById("subj-zone").value:"—";
  for(var i=0;i<CS.length;i++){if(CS[i].included&&CS[i].zone!=="—"&&subjZone!=="—"&&CS[i].zone!==subjZone)zm++}
  if(zm>0)h+=' &middot; <span style="color:var(--red);font-weight:600">'+zm+' in different school zone</span>';
  h+='</div><button class="btn btn-navy" onclick="doGenerate()">Generate Report &rarr;</button></div>';
  document.getElementById("rev-summary-wrap").innerHTML=h;
}

function toggleComp(i,ch){CS[i].included=ch;var el=document.getElementById("cc-"+i);if(ch)el.classList.remove("excluded");else el.classList.add("excluded");renderSummary()}
function setZone(i,v){CS[i].zone=v;updateZoneScores()}

/* School-zone match contributes the final 25 of the 100 total score. */
function updateZoneScores(){
  var subjZone=document.getElementById("subj-zone").value;
  for(var i=0;i<CS.length;i++){var cs=CS[i];
    cs.flags=cs.flags.filter(function(f){return f.t.indexOf("School")===-1&&f.t.indexOf("school")===-1});
    var base=scoreComp(cs.comp,DATA),bonus=0;
    if(subjZone!=="—"&&cs.zone!=="—"){
      if(cs.zone===subjZone){bonus=25;cs.flags.push({t:"School zone match",c:"g"})}
      else{cs.flags.push({t:"Different school zone",c:"r"})}
    }
    cs.score=Math.min(base.score+bonus,100);
    cs.flags=base.flags.concat(cs.flags.filter(function(f){return f.t.indexOf("School")!==-1||f.t.indexOf("school")!==-1}))
  }
  renderCompList();
}

/* ── Report generation ──────────────────────────────────────────────── */
function doGenerate(){
  var inc=CS.filter(function(c){return c.included});if(!inc.length){alert("Select at least one comp.");return}
  var gMap={},seen={},fGroups=[];
  for(var i=0;i<inc.length;i++){var st=inc[i].status;if(!gMap[st])gMap[st]=[];gMap[st].push(inc[i].comp)}
  for(var i=0;i<CS.length;i++){var st=CS[i].status;if(!seen[st]&&gMap[st]){fGroups.push({status:st,comps:gMap[st]});seen[st]=true}}
  var name=document.getElementById("f-name").value||"Alan Wang",brok=document.getElementById("f-brok").value||"KW Elevate";
  var phone=document.getElementById("f-phone").value||"",lic=document.getElementById("f-lic").value||"";
  var sp=document.getElementById("f-price").value||"",sn=document.getElementById("f-notes").value||"";
  var today=new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
  var h='<div class="rpt-hdr"><div class="dt">'+today+'</div><h1>Comparative Market Analysis</h1><div class="subj">Subject Property: '+esc(DATA.subjectAddress||"—")+'</div></div>';
  if(sp){h+='<div class="price-bar"><div><div class="lbl">Suggested List Price</div><div class="val">'+esc(sp)+'</div></div>';if(sn){h+='<div class="notes"><div class="lbl">Rationale</div><p>'+esc(sn)+'</p></div>'}h+='</div>'}
  h+='<div class="rpt-body"><h2>Brief Summary of Comparable Properties</h2><p class="desc">A brief summary of the subject and comparable properties in this market analysis.</p>';
  for(var g=0;g<fGroups.length;g++){var gr=fGroups[g];
    h+='<div class="st-label">Status: '+esc(gr.status)+'</div><table class="ct"><thead><tr>';
    ["Address","MLS#","Sub Type","SqFt Tot","Beds","Baths","L/S Price","Status Dt","DOM"].forEach(function(c,i){h+='<th'+(i<=2?' class="l"':'')+'>'+c+'</th>'});
    h+='</tr></thead><tbody><tr class="subj-row"><td><span class="subj-dot"></span>'+esc((DATA.subjectAddress||"Subject").split(",")[0])+'</td><td></td><td class="l">'+(DATA.subjectCode||"")+'</td><td>'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</td><td>'+(DATA.subjectBeds||"—")+'</td><td>'+(DATA.subjectBaths||"—")+'</td><td colspan="3"></td></tr>';
    var sS=0,cS=0,sB=0,cB=0,sP=0,cP=0,sD=0,cD=0;
    for(var c=0;c<gr.comps.length;c++){var comp=gr.comps[c];
      h+='<tr><td>'+addrLinks(comp.address)+'</td><td class="mls">'+esc(comp.mls)+'</td><td class="l dim">'+esc(comp.subType)+'</td><td>'+(comp.sqft?comp.sqft.toLocaleString():"—")+'</td><td>'+(comp.beds||"—")+'</td><td>'+(comp.baths||"—")+'</td><td class="fw">'+(comp.price?fmt(comp.price):"—")+'</td><td class="dim">'+(comp.statusDt||"—")+'</td><td>'+(comp.dom!=null?comp.dom:"—")+'</td></tr>';
      if(comp.sqft){sS+=comp.sqft;cS++}if(comp.beds){sB+=parseInt(comp.beds);cB++}if(comp.price){sP+=comp.price;cP++}if(comp.dom!=null){sD+=comp.dom;cD++}}
    h+='<tr class="avg-row"><td colspan="3" style="text-align:right;padding-right:10px">Average</td><td>'+(cS?Math.round(sS/cS).toLocaleString():"—")+'</td><td>'+(cB?Math.round(sB/cB):"—")+'</td><td></td><td class="fw">'+(cP?fmt(Math.round(sP/cP)):"—")+'</td><td></td><td>'+(cD?Math.round(sD/cD):"—")+'</td></tr></tbody></table>'}
  // Summary
  h+='<div class="sum-sec"><h3>Summary</h3><table class="st-tbl"><thead><tr>';
  ["Status","Total","Avg Price","Avg $ Per Sq.Ft.","Median","Low","High","Avg DOM"].forEach(function(s,i){h+='<th'+(i===0?' style="text-align:left"':'')+'>'+s+'</th>'});
  h+='</tr></thead><tbody>';
  var aP=[],aPsf=[],aD=[];
  for(var g=0;g<fGroups.length;g++){var gr=fGroups[g],pr=[],ps=[],dm=[];
    for(var c=0;c<gr.comps.length;c++){if(gr.comps[c].price){pr.push(gr.comps[c].price);aP.push(gr.comps[c].price)}if(gr.comps[c].price&&gr.comps[c].sqft){var v=gr.comps[c].price/gr.comps[c].sqft;ps.push(v);aPsf.push(v)}if(gr.comps[c].dom!=null){dm.push(gr.comps[c].dom);aD.push(gr.comps[c].dom)}}
    var ap=pr.length?pr.reduce(function(a,b){return a+b},0)/pr.length:0;
    h+='<tr><td>'+esc(gr.status)+'</td><td>'+gr.comps.length+'</td><td class="fw">'+fmt(Math.round(ap))+'</td><td>'+fmtD(ps.length?ps.reduce(function(a,b){return a+b},0)/ps.length:0)+'</td><td>'+fmt(med(pr))+'</td><td>'+fmt(pr.length?Math.min.apply(null,pr):0)+'</td><td>'+fmt(pr.length?Math.max.apply(null,pr):0)+'</td><td>'+(dm.length?Math.round(dm.reduce(function(a,b){return a+b},0)/dm.length):"—")+'</td></tr>'}
  var tAp=aP.length?aP.reduce(function(a,b){return a+b},0)/aP.length:0;
  h+='<tr class="total-row"><td>Total</td><td>'+aP.length+'</td><td>'+fmt(Math.round(tAp))+'</td><td>'+fmtD(aPsf.length?aPsf.reduce(function(a,b){return a+b},0)/aPsf.length:0)+'</td><td>'+fmt(med(aP))+'</td><td>'+fmt(aP.length?Math.min.apply(null,aP):0)+'</td><td>'+fmt(aP.length?Math.max.apply(null,aP):0)+'</td><td>'+(aD.length?Math.round(aD.reduce(function(a,b){return a+b},0)/aD.length):"—")+'</td></tr></tbody></table></div></div>';
  h+='<div class="rpt-foot"><div><div class="agent-lbl">Researched and prepared by</div><div class="agent-name">'+esc(name)+'</div><div class="agent-info">'+esc(brok);
  if(phone)h+=' &middot; '+esc(phone);if(lic)h+=' &middot; DRE# '+esc(lic);
  h+='</div></div><div class="disc">This represents an estimated sale price for this property. It is not the same as the opinion of value in an appraisal developed by a licensed appraiser under the Uniform Standards of Professional Appraisal Practice.</div></div>';
  document.getElementById("rpt").innerHTML=h;show('s3');
}

/* ── Download as standalone HTML ────────────────────────────────────── */
/* Embeds the current page styles inline so the saved file renders without
 * loading any external resources — agents can email it or archive it. */
function downloadReport(){
  var rpt=document.getElementById("rpt");
  if(!rpt||!rpt.innerHTML.trim()){alert("Generate a report first.");return}
  var styleNode=document.querySelector("style");
  var styles=styleNode?styleNode.textContent:"";
  var subj=(DATA&&DATA.subjectAddress)?DATA.subjectAddress.split(",")[0].trim():"report";
  var today=new Date().toISOString().slice(0,10);
  var safe=subj.replace(/[^a-zA-Z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"report";
  var fname="CMA_"+safe+"_"+today+".html";
  var doc='<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">'+
    '<title>CMA — '+esc(subj)+'</title>'+
    '<style>'+styles+'\nbody{background:#fff}.rpt{margin:24px auto;box-shadow:0 1px 4px rgba(0,0,0,.06)}</style>'+
    '</head><body><div class="rpt">'+rpt.innerHTML+'</div></body></html>';
  var blob=new Blob([doc],{type:"text/html;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;a.download=fname;document.body.appendChild(a);a.click();
  document.body.removeChild(a);
  setTimeout(function(){URL.revokeObjectURL(url)},100);
}

/* Display version on load (used by index.html footer + tests.html). */
if(typeof document!=="undefined"){
  document.addEventListener("DOMContentLoaded",function(){
    var v=document.getElementById("version-tag");if(v)v.textContent="v"+VERSION;
  });
}
