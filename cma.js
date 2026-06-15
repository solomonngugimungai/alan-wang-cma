/* Alan Wang CMA — core logic.
 * Exposed as window globals so the inline onclick handlers in index.html still work.
 *
 * Comp scoring weights (per TJ Hufanga, total = 100):
 *   School zone match  25
 *   SqFt variance      25
 *   Beds match         25
 *   Baths match        20
 *   DOM                 5
 *
 * Condition rating (per Alan) layers on top as a ±5 modifier, clamped to [0, 100]:
 *   exact match     +5
 *   1 tier off       0  (no flag)
 *   2 tiers off     -3
 *   3 tiers off     -5
 */
var VERSION = "1.5.0";
var DATA = null, CS = [];
var DISTRICTS = ["—","Cupertino Union SD","Sunnyvale SD","Santa Clara Unified","Fremont Union HSD","Mountain View Whisman SD","Los Altos SD","Campbell Union SD","San Jose Unified","Milpitas Unified","Palo Alto Unified","Other"];
var CONDITION_TIERS = ["—","High","Mid-High","Mid","Low"];
var CONDITION_HINTS = {
  "High":     "Move-in ready · kitchen + baths updated · current finishes",
  "Mid-High": "Updated kitchen or baths (not both) · mostly current",
  "Mid":      "Mixed updates · some original finishes",
  "Low":      "Dated throughout · needs renovation"
};

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
    if(curSt&&mlsRe.test(line)){
      var mls=line.match(mlsRe)[1];
      // Capture every $ amount; first = list price, second (if present) = sale price.
      var pm=line.match(/\$[\d,]+/g)||[];
      var priceVals=pm.map(function(p){return parseInt(p.replace(/[$,]/g,""))});
      var listPrice=priceVals.length>0?priceVals[0]:null;
      var salePrice=priceVals.length>=2?priceVals[1]:null;
      // "price" = the headline figure for this comp: sale price when sold, else list.
      var isSold=/sold/i.test(curSt);
      var price=isSold?(salePrice||listPrice):listPrice;
      var mi=line.indexOf(mls),addr=line.substring(0,mi).trim().replace(/\s+\d+\s*$/,"").trim();
      var subT="",tm=line.match(/Res\.\s*(Townhouse|Condominium|Single Family)/i);if(tm)subT="Res. "+tm[1];
      var after=tm?line.substring(line.indexOf(tm[0])+tm[0].length):line.substring(mi+mls.length);
      var bm=after.match(/(\d\/\d)/),baths=bm?bm[1]:"";
      var nm=after.match(/\b[\d,]+\b/g)||[],cn=nm.map(function(n){return n.replace(",","")});
      var sqft="",beds="";for(var j=0;j<cn.length;j++){var v=parseInt(cn[j]);if(v>=500&&v<=5000&&!sqft)sqft=cn[j];else if(v>=1&&v<=10&&sqft&&!beds)beds=cn[j]}
      var dom="",dm=after.match(/(\d+)\s*$/);if(dm&&parseInt(dm[1])<500)dom=dm[1];
      var dtm=line.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/),sdt=dtm?dtm[1]:"";
      curC.push({address:addr||"Unknown",mls:mls,subType:subT,sqft:sqft?parseInt(sqft):null,beds:beds,baths:baths,price:price,listPrice:listPrice,salePrice:salePrice,statusDt:sdt,dom:dom?parseInt(dom):null,status:curSt})}}
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
      CS.push({comp:comp,status:gr.status,score:sc.score,flags:sc.flags,included:true,zone:"—",condition:"—",description:""})}}
  renderReview();show('s2');
}

function renderReview(){
  var h='<div class="subj-card"><div><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.5);margin-bottom:2px">Subject Property</div>';
  h+='<h3>'+esc(DATA.subjectAddress||"—")+'</h3></div>';
  h+='<div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">';
  h+='<div class="stats"><div><div class="stat-v">'+(DATA.subjectBeds||"—")+'</div><div class="stat-l">Beds</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectBaths||"—")+'</div><div class="stat-l">Baths</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</div><div class="stat-l">Sq Ft</div></div></div>';
  h+='<div class="zone-row">';
  h+='<label>Condition</label><select id="subj-condition" onchange="updateScores()">';
  for(var i=0;i<CONDITION_TIERS.length;i++)h+='<option>'+CONDITION_TIERS[i]+'</option>';
  h+='</select>';
  h+='<label>School Zone</label><select id="subj-zone" onchange="updateScores()">';
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
    h+='<div class="cc-cond"><label>Condition:</label><select onchange="setCondition('+i+',this.value)">';
    for(var t=0;t<CONDITION_TIERS.length;t++)h+='<option'+(cs.condition===CONDITION_TIERS[t]?" selected":"")+'>'+CONDITION_TIERS[t]+'</option>';
    h+='</select>';
    var hint=cs.condition&&CONDITION_HINTS[cs.condition]?CONDITION_HINTS[cs.condition]:"Optional notes (e.g., updated kitchen, original baths)";
    h+='<input type="text" maxlength="200" placeholder="'+esc(hint)+'" value="'+esc(cs.description||"")+'" oninput="setDescription('+i+',this.value)">';
    h+='</div>';
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
  var unrated=inc.filter(function(c){return !c.condition||c.condition==="—"}).length;
  if(unrated>0)h+=' &middot; <span style="color:var(--gray-text)">'+unrated+' without condition rating</span>';
  h+='</div><button class="btn btn-navy" onclick="doGenerate()">Generate Report &rarr;</button></div>';
  document.getElementById("rev-summary-wrap").innerHTML=h;
}

function toggleComp(i,ch){CS[i].included=ch;var el=document.getElementById("cc-"+i);if(ch)el.classList.remove("excluded");else el.classList.add("excluded");renderSummary()}
function setZone(i,v){CS[i].zone=v;updateScores()}

/* Bulk selection helpers — wired to the "Quick select" toolbar in S2. */
function selectStrongOnly(){
  for(var i=0;i<CS.length;i++)CS[i].included=(CS[i].score>=70);
  renderCompList();
}
function selectAll(){
  for(var i=0;i<CS.length;i++)CS[i].included=true;
  renderCompList();
}
function clearSelection(){
  for(var i=0;i<CS.length;i++)CS[i].included=false;
  renderCompList();
}
function setCondition(i,v){CS[i].condition=v;updateScores()}
/* Description updates shouldn't trigger a full re-render — that would steal
 * focus from the input mid-typing. Just persist the value. */
function setDescription(i,v){CS[i].description=v}

/* Recompute every comp's score from its base property score plus modifiers
 * for school-zone match (±25) and condition match (±5). Clamped to [0, 100]. */
function updateScores(){
  var sZ=document.getElementById("subj-zone"),sC=document.getElementById("subj-condition");
  var subjZone=sZ?sZ.value:"—",subjCond=sC?sC.value:"—";
  for(var i=0;i<CS.length;i++){
    var cs=CS[i];
    var base=scoreComp(cs.comp,DATA);
    var mod=0;
    var extra=[];
    // School zone — 25 of the 100 budget
    if(subjZone!=="—"&&cs.zone!=="—"){
      if(cs.zone===subjZone){mod+=25;extra.push({t:"School zone match",c:"g"})}
      else{extra.push({t:"Different school zone",c:"r"})}
    }
    // Condition — ±5 modifier
    if(subjCond!=="—"&&cs.condition&&cs.condition!=="—"){
      var diff=Math.abs(CONDITION_TIERS.indexOf(cs.condition)-CONDITION_TIERS.indexOf(subjCond));
      if(diff===0){mod+=5;extra.push({t:"Condition match",c:"g"})}
      else if(diff===2){mod-=3;extra.push({t:"Condition 2 tiers off",c:"y"})}
      else if(diff>=3){mod-=5;extra.push({t:"Condition mismatch",c:"r"})}
      // diff===1 is normal — no flag, no penalty
    }
    cs.score=Math.max(0,Math.min(base.score+mod,100));
    cs.flags=base.flags.concat(extra);
  }
  renderCompList();
}
/* Backward-compat alias for older inline handlers. */
function updateZoneScores(){updateScores()}

/* ── Report generation ──────────────────────────────────────────────── */
function doGenerate(){
  var inc=CS.filter(function(c){return c.included});if(!inc.length){alert("Select at least one comp.");return}
  // Group by status, preserving the full CS entry (so condition + description ride along).
  var gMap={},seen={},fGroups=[];
  for(var i=0;i<inc.length;i++){var st=inc[i].status;if(!gMap[st])gMap[st]=[];gMap[st].push(inc[i])}
  for(var i=0;i<CS.length;i++){var st=CS[i].status;if(!seen[st]&&gMap[st]){fGroups.push({status:st,entries:gMap[st]});seen[st]=true}}
  var name=document.getElementById("f-name").value||"Alan Wang",brok=document.getElementById("f-brok").value||"KW Elevate";
  var phone=document.getElementById("f-phone").value||"",lic=document.getElementById("f-lic").value||"";
  var sp=document.getElementById("f-price").value||"",sn=document.getElementById("f-notes").value||"";
  var today=new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"});
  var h='<div class="rpt-hdr"><div class="dt">'+today+'</div><h1>Comparative Market Analysis</h1><div class="subj">Subject Property: '+esc(DATA.subjectAddress||"—")+'</div></div>';
  if(sp){h+='<div class="price-bar"><div><div class="lbl">Suggested List Price</div><div class="val">'+esc(sp)+'</div></div>';if(sn){h+='<div class="notes"><div class="lbl">Rationale</div><p>'+esc(sn)+'</p></div>'}h+='</div>'}
  h+='<div class="rpt-body"><h2>Brief Summary of Comparable Properties</h2><p class="desc">A brief summary of the subject and comparable properties in this market analysis.</p>';
  for(var g=0;g<fGroups.length;g++){var gr=fGroups[g];
    h+='<div class="st-label">Status: '+esc(gr.status)+' <span class="st-count">('+gr.entries.length+' listing'+(gr.entries.length===1?"":"s")+')</span></div><table class="ct"><thead><tr>';
    ["Address","Bd","Ba","SqFt","$/SqFt","DOM","List Price","Sale Price","Date"].forEach(function(c,i){h+='<th'+(i===0?' class="l"':'')+'>'+c+'</th>'});
    h+='</tr></thead><tbody><tr class="subj-row"><td><span class="subj-dot"></span>'+esc((DATA.subjectAddress||"Subject").split(",")[0])+(DATA.subjectCode?' <span class="mls-inline">'+esc(DATA.subjectCode)+'</span>':'')+'</td><td>'+(DATA.subjectBeds||"—")+'</td><td>'+(DATA.subjectBaths||"—")+'</td><td>'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</td><td colspan="5"></td></tr>';
    var sSqft=0,cSqft=0,sBeds=0,cBeds=0,sList=0,cList=0,sSale=0,cSale=0,sDom=0,cDom=0,sPpsf=0,cPpsf=0;
    for(var c=0;c<gr.entries.length;c++){var entry=gr.entries[c],comp=entry.comp;
      var headlinePrice=comp.salePrice||comp.listPrice;
      var ppsf=(headlinePrice&&comp.sqft)?Math.round(headlinePrice/comp.sqft):null;
      var cellExtras='<div class="mls-line">'+esc(comp.mls)+(comp.subType?' &middot; '+esc(comp.subType):'')+'</div>';
      if(entry.condition&&entry.condition!=="—"){
        cellExtras+='<span class="cond-badge cond-'+entry.condition.toLowerCase().replace(/[^a-z]/g,"")+'">'+esc(entry.condition)+'</span>';
      }
      if(entry.description){cellExtras+='<span class="cond-desc">'+esc(entry.description)+'</span>'}
      h+='<tr><td>'+addrLinks(comp.address)+cellExtras+'</td>'+
        '<td>'+(comp.beds||"—")+'</td>'+
        '<td>'+(comp.baths||"—")+'</td>'+
        '<td>'+(comp.sqft?comp.sqft.toLocaleString():"—")+'</td>'+
        '<td>'+(ppsf?'$'+ppsf.toLocaleString():"—")+'</td>'+
        '<td>'+(comp.dom!=null?comp.dom:"—")+'</td>'+
        '<td class="fw">'+(comp.listPrice?fmt(comp.listPrice):"—")+'</td>'+
        '<td class="fw">'+(comp.salePrice?fmt(comp.salePrice):"—")+'</td>'+
        '<td class="dim">'+(comp.statusDt||"—")+'</td></tr>';
      if(comp.sqft){sSqft+=comp.sqft;cSqft++}
      if(comp.beds){sBeds+=parseInt(comp.beds);cBeds++}
      if(comp.listPrice){sList+=comp.listPrice;cList++}
      if(comp.salePrice){sSale+=comp.salePrice;cSale++}
      if(comp.dom!=null){sDom+=comp.dom;cDom++}
      if(ppsf){sPpsf+=ppsf;cPpsf++}
    }
    h+='<tr class="avg-row">'+
      '<td colspan="3" style="text-align:right;padding-right:10px">Average ('+gr.entries.length+')</td>'+
      '<td>'+(cSqft?Math.round(sSqft/cSqft).toLocaleString():"—")+'</td>'+
      '<td>'+(cPpsf?'$'+Math.round(sPpsf/cPpsf).toLocaleString():"—")+'</td>'+
      '<td>'+(cDom?Math.round(sDom/cDom):"—")+'</td>'+
      '<td class="fw">'+(cList?fmt(Math.round(sList/cList)):"—")+'</td>'+
      '<td class="fw">'+(cSale?fmt(Math.round(sSale/cSale)):"—")+'</td>'+
      '<td></td></tr></tbody></table>'}
  // Summary
  h+='<div class="sum-sec"><h3>Summary</h3><table class="st-tbl"><thead><tr>';
  ["Status","Total","Avg Price","Avg $ Per Sq.Ft.","Median","Low","High","Avg DOM"].forEach(function(s,i){h+='<th'+(i===0?' style="text-align:left"':'')+'>'+s+'</th>'});
  h+='</tr></thead><tbody>';
  var aP=[],aPsf=[],aD=[];
  for(var g=0;g<fGroups.length;g++){var gr=fGroups[g],pr=[],ps=[],dm=[];
    for(var c=0;c<gr.entries.length;c++){var comp=gr.entries[c].comp;if(comp.price){pr.push(comp.price);aP.push(comp.price)}if(comp.price&&comp.sqft){var v=comp.price/comp.sqft;ps.push(v);aPsf.push(v)}if(comp.dom!=null){dm.push(comp.dom);aD.push(comp.dom)}}
    var ap=pr.length?pr.reduce(function(a,b){return a+b},0)/pr.length:0;
    h+='<tr><td>'+esc(gr.status)+'</td><td>'+gr.entries.length+'</td><td class="fw">'+fmt(Math.round(ap))+'</td><td>'+fmtD(ps.length?ps.reduce(function(a,b){return a+b},0)/ps.length:0)+'</td><td>'+fmt(med(pr))+'</td><td>'+fmt(pr.length?Math.min.apply(null,pr):0)+'</td><td>'+fmt(pr.length?Math.max.apply(null,pr):0)+'</td><td>'+(dm.length?Math.round(dm.reduce(function(a,b){return a+b},0)/dm.length):"—")+'</td></tr>'}
  var tAp=aP.length?aP.reduce(function(a,b){return a+b},0)/aP.length:0;
  h+='<tr class="total-row"><td>Total</td><td>'+aP.length+'</td><td>'+fmt(Math.round(tAp))+'</td><td>'+fmtD(aPsf.length?aPsf.reduce(function(a,b){return a+b},0)/aPsf.length:0)+'</td><td>'+fmt(med(aP))+'</td><td>'+fmt(aP.length?Math.min.apply(null,aP):0)+'</td><td>'+fmt(aP.length?Math.max.apply(null,aP):0)+'</td><td>'+(aD.length?Math.round(aD.reduce(function(a,b){return a+b},0)/aD.length):"—")+'</td></tr></tbody></table></div>';

  // Quick Statistics — Min / Max / Median for List and Sale prices across all included comps.
  var allList=[],allSale=[];
  for(var g=0;g<fGroups.length;g++){
    for(var c=0;c<fGroups[g].entries.length;c++){
      var cp=fGroups[g].entries[c].comp;
      if(cp.listPrice)allList.push(cp.listPrice);
      if(cp.salePrice)allSale.push(cp.salePrice);
    }
  }
  if(allList.length||allSale.length){
    h+='<div class="quickstats"><h3>Quick Statistics <span class="qs-count">('+inc.length+' listing'+(inc.length===1?"":"s")+' total)</span></h3>';
    h+='<table class="qs-tbl"><thead><tr><th></th><th>Min</th><th>Max</th><th>Median</th></tr></thead><tbody>';
    function qsRow(label,arr){
      if(!arr.length)return"";
      return'<tr><td>'+label+'</td><td>'+fmt(Math.min.apply(null,arr))+'</td><td>'+fmt(Math.max.apply(null,arr))+'</td><td>'+fmt(med(arr))+'</td></tr>';
    }
    h+=qsRow("List Price",allList);
    h+=qsRow("Sale Price",allSale);
    h+='</tbody></table></div>';
  }
  h+='</div>';  // close .rpt-body
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
