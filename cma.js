/* Alan Wang CMA — core logic.
 * Exposed as window globals so the inline onclick handlers in index.html still work.
 *
 * Two parallel measures per comp:
 *
 * 1) Comparability SCORE (0-100, for filtering — "Strong only" etc.)
 *    Beds 25 + Baths 20 + SqFt 25 + DOM 5 + School-zone 25.
 *    Same as before. Drives the filter toolbar; does NOT drive price.
 *
 * 2) ADJUSTED VALUE (dollars, for pricing — Alan's hand-pricing model)
 *    Per-comp:  adjusted = base + locationHaircut% + (compRemodel − subjRemodel)
 *      base       = sale price for Sold; list price for Pending/Contingent.
 *      remodel    = dollar cost remaining to bring up to Move-in ready
 *                   (Poor and Medium costs live in SETTINGS, editable).
 *    Per-comp WEIGHT (for the weighted average):
 *      starts at 1.0, multiplied by recency factor if older than the window,
 *      multiplied by divider factor (or excluded entirely) when across-divider.
 *    Recommended price = weighted average of adjusted values across valid
 *                        value comps (Sold + Pending/Contingent only).
 *    Supported range   = min..max of those same adjusted values.
 */
var VERSION = "2.1.0";
var DATA = null, CS = [];
var DISTRICTS = ["—","Cupertino Union SD","Sunnyvale SD","Santa Clara Unified","Fremont Union HSD","Mountain View Whisman SD","Los Altos SD","Campbell Union SD","San Jose Unified","Milpitas Unified","Palo Alto Unified","Other"];

/* Three-tier condition rubric per Alan. Default Medium.
 * Tier → dollar cost of remodel remaining lives in SETTINGS (editable). */
var CONDITION_TIERS = ["Move-in ready","Medium","Poor"];
var CONDITION_HINTS = {
  "Move-in ready": "Kitchen + baths updated · no major remodel needed",
  "Medium":        "Some updates · one major room (kitchen OR baths) still to redo",
  "Poor":          "Dated kitchen + baths · full remodel ahead"
};

/* ── Settings (editable, persisted to localStorage) ─────────────────── */
var SETTINGS_KEY = "alan_cma_settings_v1";
var SETTINGS_DEFAULTS = {
  conditionCosts: { poorToMoveIn: 80000, mediumToMoveIn: 25000 },
  divider:        { mode: "exclude", factor: 0.5 },     // mode: "exclude" | "downweight"
  recency:        { windowMonths: 6, factor: 0.5 },
  lotMismatchThreshold: 0.30,                            // 30%
  marketRead:     { softRatio: 0.5 },                    // (expired+cancelled+withdrawn) / sold ≥ this → "soft"
  dataQuality:    { minValueComps: 3, rangeSpread: 0.25 } // <3 value comps OR spread > 25% of rec → warn
};
var SETTINGS = loadSettings();

function loadSettings(){
  try{
    var raw=window.localStorage&&window.localStorage.getItem(SETTINGS_KEY);
    if(!raw)return cloneDefaults();
    var parsed=JSON.parse(raw);
    // Merge over defaults so missing keys (e.g. after a future version adds one) get sane fallbacks.
    return deepMerge(cloneDefaults(),parsed);
  }catch(e){return cloneDefaults()}
}
function saveSettings(){
  try{window.localStorage&&window.localStorage.setItem(SETTINGS_KEY,JSON.stringify(SETTINGS))}catch(e){}
}
function resetSettings(){SETTINGS=cloneDefaults();saveSettings();if(typeof updateScores==="function"&&DATA)updateScores();renderSettingsModal()}
function cloneDefaults(){return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS))}
function deepMerge(dst,src){
  for(var k in src){
    if(src[k]&&typeof src[k]==="object"&&!Array.isArray(src[k])){dst[k]=deepMerge(dst[k]||{},src[k])}
    else{dst[k]=src[k]}
  }
  return dst;
}

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
      // Best-effort lot size: explicit "(sf)" suffix or trailing " sf" token — typical
      // of MLSListings' Residential Summary export. Skip when not present (condo rows
      // usually have no lot). Negative-lookahead on `sft`/`sqft` avoids matching living-area.
      var lotMatch=line.match(/(\d[\d,]*)\s*\(sf\)/i)||line.match(/(\d[\d,]+)\s+sf\b(?![tq])/i);
      var lotSqft=lotMatch?parseInt(lotMatch[1].replace(/,/g,"")):null;
      curC.push({address:addr||"Unknown",mls:mls,subType:subT,sqft:sqft?parseInt(sqft):null,beds:beds,baths:baths,price:price,listPrice:listPrice,salePrice:salePrice,statusDt:sdt,dom:dom?parseInt(dom):null,lotSqft:lotSqft,status:curSt})}}
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
      CS.push({
        comp:comp, status:gr.status,
        score:sc.score, flags:sc.flags, included:true,
        zone:"—",
        condition:"Medium",         // default per Alan
        description:"",
        acrossDivider:false,        // Pass 1.2 — divider handling
        locationHaircut:0,          // Pass 1.3 — % adjustment (e.g. -15)
        zillowEstimate:null,        // Pass 2.7 — reference only
        // Computed by updateScores():
        adjustedValue:null, weight:0, valueIncluded:false, exclusionReason:null
      })}}
  renderReview();show('s2');
  // Map needs the container visible to compute its size, so init AFTER show().
  initMap();
}

/* Refresh pin styling without re-geocoding (called from toggleComp + selection helpers). */
function refreshMapPins(){
  if(!MAP)return;
  for(var i=0;i<MAP_MARKERS.length;i++){
    if(!MAP_MARKERS[i]||!CS[i])continue;
    MAP_MARKERS[i].setIcon(compIcon(CS[i]));
    MAP_MARKERS[i].setPopupContent(buildMapPopup(CS[i],i));
  }
}

function renderReview(){
  var h='<div class="subj-card"><div class="subj-left"><div class="subj-label">Subject Property</div>';
  h+='<h3>'+esc(DATA.subjectAddress||"—")+'</h3>';
  h+='<div class="realist-note">Use the <b>realist profile</b> (official record) — not a prior listing, which may be outdated.</div>';
  h+='</div>';
  h+='<div class="subj-right">';
  h+='<div class="stats"><div><div class="stat-v">'+(DATA.subjectBeds||"—")+'</div><div class="stat-l">Beds</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectBaths||"—")+'</div><div class="stat-l">Baths</div></div>';
  h+='<div><div class="stat-v">'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</div><div class="stat-l">Sq Ft</div></div>';
  h+='<div><input type="number" id="subj-lot" class="stat-input" placeholder="—" value="'+(DATA.subjectLotSqft||"")+'" oninput="setSubjectLot(this.value)"><div class="stat-l">Lot SF</div></div>';
  h+='</div>';
  h+='<div class="zone-row">';
  h+='<label>Condition</label><select id="subj-condition" onchange="updateScores()">';
  for(var i=0;i<CONDITION_TIERS.length;i++)h+='<option'+((DATA.subjectCondition||"Medium")===CONDITION_TIERS[i]?" selected":"")+'>'+CONDITION_TIERS[i]+'</option>';
  h+='</select>';
  h+='<label>School Zone</label><select id="subj-zone" onchange="updateScores()">';
  for(var i=0;i<DISTRICTS.length;i++)h+='<option>'+DISTRICTS[i]+'</option>';
  h+='</select>';
  h+='<button class="btn-detect" onclick="autoDetectZones()">&#9672; Auto-Detect All Zones</button>';
  h+='<span id="detect-status"></span>';
  h+='<button class="btn-settings" onclick="openSettings()" title="Pricing settings">&#9881; Settings</button>';
  h+='</div></div></div>';
  document.getElementById("subj-card-wrap").innerHTML=h;
  renderCompList();
}
function setSubjectLot(v){DATA.subjectLotSqft=v===""?null:(parseInt(v)||null);updateScores()}

function renderCompList(){
  var h="";
  for(var i=0;i<CS.length;i++){
    var cs=CS[i],c=cs.comp,cls=cs.included?"":"excluded",scCls=cs.score>=70?"hi":cs.score>=40?"md":"lo";
    var basePrice=compBasePrice(cs);
    var adj=cs.adjustedValue;
    var adjDelta=(adj!=null&&basePrice!=null)?(adj-basePrice):0;
    h+='<div class="comp-card '+cls+'" id="cc-'+i+'"><div class="cc-body">';
    h+='<input type="checkbox" class="cc-check" '+(cs.included?"checked":"")+' onchange="toggleComp('+i+',this.checked)">';
    h+='<div class="cc-main"><div><div class="cc-addr">'+addrLinks(c.address)+'</div><div class="cc-mls">'+esc(c.mls)+' &middot; '+esc(cs.status)+'</div></div>';
    h+='<div>'+(c.sqft?c.sqft.toLocaleString():"—")+'</div><div>'+(c.beds||"—")+'</div><div>'+(c.baths||"—")+'</div>';
    h+='<div class="cc-fw">'+(c.price?fmt(c.price):"—")+'</div><div class="cc-dim">'+(c.statusDt||"—")+'</div><div>'+(c.dom!=null?c.dom:"—")+'</div></div>';
    h+='<div class="score-col"><div class="score '+scCls+'">'+cs.score+'</div>';
    if(adj!=null){
      var deltaStr=adjDelta===0?"":(' <span class="adj-delta '+(adjDelta>0?"pos":"neg")+'">'+(adjDelta>0?"+":"−")+'$'+Math.abs(adjDelta).toLocaleString()+'</span>');
      h+='<div class="adj-val" title="Adjusted value">'+fmt(adj)+deltaStr+'</div>';
      if(cs.valueIncluded&&cs.weight!==1)h+='<div class="adj-wt">weight ×'+cs.weight.toFixed(2)+'</div>';
      else if(!cs.valueIncluded)h+='<div class="adj-wt excluded-tag">'+esc(cs.exclusionReason||"excluded")+'</div>';
    }
    h+='</div></div>';
    if(cs.flags.length){h+='<div class="flags">';for(var f=0;f<cs.flags.length;f++)h+='<span class="flag flag-'+cs.flags[f].c+'">'+cs.flags[f].t+'</span>';h+='</div>'}
    // Condition + free-form description
    h+='<div class="cc-cond"><label>Condition:</label><select onchange="setCondition('+i+',this.value)">';
    for(var t=0;t<CONDITION_TIERS.length;t++)h+='<option'+(cs.condition===CONDITION_TIERS[t]?" selected":"")+'>'+CONDITION_TIERS[t]+'</option>';
    h+='</select>';
    var hint=CONDITION_HINTS[cs.condition]||"Notes (e.g., updated kitchen, original baths)";
    h+='<input type="text" maxlength="200" placeholder="'+esc(hint)+'" value="'+esc(cs.description||"")+'" oninput="setDescription('+i+',this.value)">';
    h+='</div>';
    // Geo adjustments: divider + location haircut
    h+='<div class="cc-geo">';
    h+='<label class="cc-check-label"><input type="checkbox" '+(cs.acrossDivider?"checked":"")+' onchange="setDivider('+i+',this.checked)"> Across divider</label>';
    h+='<label>Location adj:</label><input type="number" step="1" placeholder="0" value="'+(cs.locationHaircut||"")+'" onchange="setLocationHaircut('+i+',this.value)" class="loc-input"><span class="cc-pct">%</span>';
    h+='<label class="cc-rt">Zillow:</label><input type="text" placeholder="ref only" value="'+(cs.zillowEstimate!=null?cs.zillowEstimate:"")+'" oninput="setZillowEstimate('+i+',this.value)" class="zillow-input">';
    h+='</div>';
    // School zone
    h+='<div class="cc-zone"><label>School Zone:</label><select onchange="setZone('+i+',this.value)">';
    for(var z=0;z<DISTRICTS.length;z++)h+='<option'+(cs.zone===DISTRICTS[z]?" selected":"")+'>'+DISTRICTS[z]+'</option>';
    if(cs.zone!=="—"&&DISTRICTS.indexOf(cs.zone)===-1)h+='<option selected>'+esc(cs.zone)+'</option>';
    h+='</select></div></div>'}
  document.getElementById("comp-list").innerHTML=h;renderSummary();
}

function renderSummary(){
  var inc=CS.filter(function(c){return c.included}),tot=CS.length;
  var rec=recommendedPrice();
  var warnings=dataQualityWarnings(rec);

  var h='<div class="rec-panel">';
  if(rec.price){
    h+='<div class="rec-headline"><div class="rec-label">Recommended Price</div><div class="rec-value">'+fmt(rec.price)+'</div>';
    h+='<div class="rec-range">Supported range <b>'+fmt(rec.low)+'</b> – <b>'+fmt(rec.high)+'</b> &middot; '+rec.n+' value comp'+(rec.n===1?"":"s")+'</div>';
    h+='</div>';
  }else{
    h+='<div class="rec-headline rec-empty"><div class="rec-label">Recommended Price</div><div class="rec-value">—</div><div class="rec-range">Select at least one Sold or Pending comp with a price.</div></div>';
  }
  if(warnings.length){
    h+='<div class="rec-warnings">';
    for(var w=0;w<warnings.length;w++)h+='<div class="rec-warn">⚠ '+esc(warnings[w])+'</div>';
    h+='</div>';
  }
  // Market read (Pass 2.6)
  var mr=marketRead();
  if(mr){
    h+='<div class="rec-market">Market read: <b class="mr-'+mr.label.toLowerCase()+'">'+esc(mr.label)+'</b> <span class="rec-dim">('+esc(mr.detail)+')</span></div>';
  }
  h+='</div>';

  h+='<div class="rev-summary"><div class="left"><b>'+inc.length+' of '+tot+'</b> comps selected';
  var zm=0,subjZone=document.getElementById("subj-zone")?document.getElementById("subj-zone").value:"—";
  for(var i=0;i<CS.length;i++){if(CS[i].included&&CS[i].zone!=="—"&&subjZone!=="—"&&CS[i].zone!==subjZone)zm++}
  if(zm>0)h+=' &middot; <span style="color:var(--red);font-weight:600">'+zm+' in different school zone</span>';
  h+='</div><button class="btn btn-navy" onclick="doGenerate()">Generate Report &rarr;</button></div>';
  document.getElementById("rev-summary-wrap").innerHTML=h;
}

/* Data-quality warnings (Pass 2.8). */
function dataQualityWarnings(rec){
  var out=[];
  if(rec.n>0&&rec.n<SETTINGS.dataQuality.minValueComps){
    out.push("Only "+rec.n+" value comp"+(rec.n===1?"":"s")+" — pricing confidence is low. Aim for "+SETTINGS.dataQuality.minValueComps+"+.");
  }
  if(rec.price&&rec.spread>SETTINGS.dataQuality.rangeSpread){
    out.push("Adjusted range spread is "+Math.round(rec.spread*100)+"% of the recommended price — tighten comp selection (drop outliers or down-weight further).");
  }
  return out;
}

/* Market read (Pass 2.6): ratio of expired/cancelled/withdrawn to sold.
 * Editable threshold in SETTINGS.marketRead.softRatio. */
function marketRead(){
  var sold=0,fail=0;
  for(var i=0;i<CS.length;i++){
    var st=(CS[i].status||"").toLowerCase();
    if(/sold/.test(st))sold++;
    else if(/expired|cancel|withdraw/.test(st))fail++;
  }
  if(sold+fail===0)return null;
  if(sold===0)return{label:"Soft",detail:fail+" expired/cancelled, 0 sold"};
  var ratio=fail/sold;
  if(ratio>=SETTINGS.marketRead.softRatio)return{label:"Soft",detail:fail+" expired/cancelled vs "+sold+" sold (ratio "+ratio.toFixed(2)+")"};
  if(ratio<=SETTINGS.marketRead.softRatio*0.4)return{label:"Strong",detail:sold+" sold, "+fail+" expired/cancelled"};
  return{label:"Balanced",detail:sold+" sold, "+fail+" expired/cancelled"};
}

function toggleComp(i,ch){CS[i].included=ch;var el=document.getElementById("cc-"+i);if(ch)el.classList.remove("excluded");else el.classList.add("excluded");renderSummary();refreshMapPins()}
function setZone(i,v){CS[i].zone=v;updateScores()}

/* Bulk selection helpers — wired to the "Quick select" toolbar in S2. */
function selectStrongOnly(){
  for(var i=0;i<CS.length;i++)CS[i].included=(CS[i].score>=70);
  renderCompList();refreshMapPins();
}
function selectAll(){
  for(var i=0;i<CS.length;i++)CS[i].included=true;
  renderCompList();refreshMapPins();
}
function clearSelection(){
  for(var i=0;i<CS.length;i++)CS[i].included=false;
  renderCompList();refreshMapPins();
}
function setCondition(i,v){CS[i].condition=v;updateScores()}
/* Description updates shouldn't trigger a full re-render — that would steal
 * focus from the input mid-typing. Just persist the value. */
function setDescription(i,v){CS[i].description=v}
function setDivider(i,checked){CS[i].acrossDivider=!!checked;updateScores()}
function setLocationHaircut(i,v){CS[i].locationHaircut=v===""?0:(parseFloat(v)||0);updateScores()}
function setZillowEstimate(i,v){CS[i].zillowEstimate=v===""?null:(parseFloat(String(v).replace(/[^0-9.\-]/g,""))||null)}

/* ── Dollar-adjustment helpers ──────────────────────────────────────── */
/* Base price for valuation:
 *   Sold        → sale price (fallback list)
 *   Pending     → list price (no sale price exists yet — per Alan)
 *   Contingent  → list price
 *   else        → null (Active/Expired/Cancelled/etc are NOT value comps) */
function compBasePrice(cs){
  var st=(cs.status||"").toLowerCase(),c=cs.comp;
  if(/sold/.test(st))return c.salePrice||c.listPrice||null;
  if(/pending|contingent/.test(st))return c.listPrice||null;
  return null;
}
/* Dollar cost remaining to bring a property up to Move-in ready. */
function remodelCost(condition){
  if(condition==="Poor")return SETTINGS.conditionCosts.poorToMoveIn||0;
  if(condition==="Medium")return SETTINGS.conditionCosts.mediumToMoveIn||0;
  return 0; // Move-in ready or unknown
}
/* Parse MLS date strings like "11/25/25" or "11/25/2025" or "2026-04-15". */
function parseCompDate(s){
  if(!s)return null;
  var m=String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(m){
    var mm=parseInt(m[1])-1,dd=parseInt(m[2]),yy=parseInt(m[3]);
    if(yy<100)yy+=2000;
    return new Date(yy,mm,dd);
  }
  m=String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if(m)return new Date(parseInt(m[1]),parseInt(m[2])-1,parseInt(m[3]));
  return null;
}
function monthsAgo(date,now){
  now=now||new Date();
  return ((now.getFullYear()-date.getFullYear())*12)+(now.getMonth()-date.getMonth())+(now.getDate()<date.getDate()?-1:0);
}

/* Recompute every comp's: (1) comparability score 0-100 for filtering,
 * (2) adjusted dollar value + weight for the recommended-price aggregate. */
function updateScores(){
  var sZ=document.getElementById("subj-zone"),sC=document.getElementById("subj-condition");
  var subjZone=sZ?sZ.value:"—",subjCond=sC?sC.value:"Medium";
  var subjRemodel=remodelCost(subjCond);
  var now=new Date();

  for(var i=0;i<CS.length;i++){
    var cs=CS[i],base=scoreComp(cs.comp,DATA);
    var matchMod=0,extra=[];

    // School-zone match contributes the final 25 of the 0-100 score.
    if(subjZone!=="—"&&cs.zone!=="—"){
      if(cs.zone===subjZone){matchMod+=25;extra.push({t:"School zone match",c:"g"})}
      else{extra.push({t:"Different school zone",c:"r"})}
    }
    cs.score=Math.max(0,Math.min(base.score+matchMod,100));
    cs.flags=base.flags.concat(extra);

    // ── Dollar-adjusted value ────────────────────────────────────────
    var basePrice=compBasePrice(cs);
    cs.exclusionReason=null;
    cs.valueIncluded=true;
    cs.weight=1.0;

    if(basePrice==null){
      cs.adjustedValue=null;cs.weight=0;cs.valueIncluded=false;
      cs.exclusionReason="not a value comp (status: "+cs.status+")";
      continue;
    }

    // Location haircut (% applied to base, negative = reduction).
    var haircut=parseFloat(cs.locationHaircut)||0;
    var locationAdj=basePrice*(haircut/100);

    // Condition: dollars of remodel comp needs minus dollars subject needs.
    // Comp needs more remodel than subject → comp's price is "discounted" for that
    // work → add the gap so we're comparing apples-to-apples at Move-in equivalence.
    var compRemodel=remodelCost(cs.condition);
    var conditionAdj=compRemodel-subjRemodel;

    cs.adjustedValue=Math.round(basePrice+locationAdj+conditionAdj);

    // Transparency flags for non-trivial adjustments.
    if(Math.abs(conditionAdj)>=1000){
      cs.flags.push({t:"Cond "+(conditionAdj>0?"+":"−")+"$"+Math.abs(conditionAdj).toLocaleString(),
                     c:conditionAdj>0?"g":"y"});
    }
    if(Math.abs(locationAdj)>=1000){
      cs.flags.push({t:"Loc "+haircut+"% ("+(locationAdj>0?"+":"−")+"$"+Math.abs(Math.round(locationAdj)).toLocaleString()+")",
                     c:haircut<0?"r":"y"});
    }

    // Recency weight.
    var d=parseCompDate(cs.comp.statusDt);
    if(d){
      var m=monthsAgo(d,now);
      if(m>SETTINGS.recency.windowMonths){
        cs.weight*=SETTINGS.recency.factor;
        cs.flags.push({t:m+"mo old (×"+SETTINGS.recency.factor+")",c:"y"});
      }
    }

    // Divider: exclude or down-weight.
    if(cs.acrossDivider){
      if(SETTINGS.divider.mode==="exclude"){
        cs.valueIncluded=false;
        cs.exclusionReason="across divider (excluded by setting)";
        cs.flags.push({t:"Across divider · excluded",c:"r"});
      }else{
        cs.weight*=SETTINGS.divider.factor;
        cs.flags.push({t:"Across divider (×"+SETTINGS.divider.factor+")",c:"y"});
      }
    }

    // Lot-size mismatch (Pass 2.5) — warning only, never excluded.
    if(cs.comp.lotSqft&&DATA.subjectLotSqft){
      var lotDiff=Math.abs(cs.comp.lotSqft-DATA.subjectLotSqft)/DATA.subjectLotSqft;
      if(lotDiff>SETTINGS.lotMismatchThreshold){
        cs.flags.push({t:"Lot mismatch "+Math.round(lotDiff*100)+"%",c:"r"});
      }
    }
  }
  renderCompList();refreshMapPins();
}
/* Backward-compat alias for older inline handlers. */
function updateZoneScores(){updateScores()}

/* ── Aggregate output: weighted recommended price + supported range ─── */
function recommendedPrice(entries){
  entries=entries||CS;
  var pool=[];
  for(var i=0;i<entries.length;i++){
    var e=entries[i];
    if(!e.included||!e.valueIncluded||e.adjustedValue==null||e.weight<=0)continue;
    pool.push(e);
  }
  if(!pool.length)return{price:null,low:null,high:null,n:0,spread:0,pool:[]};
  var wSum=0,wTot=0,vals=[];
  for(var i=0;i<pool.length;i++){
    wSum+=pool[i].adjustedValue*pool[i].weight;
    wTot+=pool[i].weight;
    vals.push(pool[i].adjustedValue);
  }
  var price=Math.round(wSum/wTot);
  var low=Math.min.apply(null,vals),high=Math.max.apply(null,vals);
  return{
    price:price, low:low, high:high, n:pool.length,
    spread:price?(high-low)/price:0,
    pool:pool
  };
}

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
  // Computed recommended price + range (algorithmic) and the agent's suggested price (override / final call).
  var rec=recommendedPrice();
  if(sp||rec.price){
    h+='<div class="price-bar">';
    if(sp){
      h+='<div class="pb-block"><div class="lbl">Suggested List Price</div><div class="val">'+esc(sp)+'</div></div>';
    }
    if(rec.price){
      h+='<div class="pb-block'+(sp?' pb-secondary':'')+'"><div class="lbl">Recommended (Computed)</div><div class="val">'+fmt(rec.price)+'</div><div class="sub">Supported range '+fmt(rec.low)+' – '+fmt(rec.high)+' &middot; '+rec.n+' value comp'+(rec.n===1?"":"s")+'</div></div>';
    }
    if(sn){h+='<div class="notes"><div class="lbl">Rationale</div><p>'+esc(sn)+'</p></div>'}
    h+='</div>';
  }
  // Data-quality warnings, surfaced prominently in the report header area.
  var warnings=dataQualityWarnings(rec);
  var mr=marketRead();
  if(warnings.length||mr){
    h+='<div class="rpt-warnings">';
    for(var w=0;w<warnings.length;w++)h+='<div class="warn-line">⚠ '+esc(warnings[w])+'</div>';
    if(mr)h+='<div class="market-line">Market read: <b class="mr-'+mr.label.toLowerCase()+'">'+esc(mr.label)+'</b> <span class="warn-dim">('+esc(mr.detail)+')</span></div>';
    h+='</div>';
  }
  h+='<div class="rpt-body"><h2>Brief Summary of Comparable Properties</h2><p class="desc">A brief summary of the subject and comparable properties in this market analysis.</p>';
  for(var g=0;g<fGroups.length;g++){var gr=fGroups[g];
    h+='<div class="st-label">Status: '+esc(gr.status)+' <span class="st-count">('+gr.entries.length+' listing'+(gr.entries.length===1?"":"s")+')</span></div><table class="ct"><thead><tr>';
    ["Address","Bd","Ba","SqFt","$/SqFt","DOM","List Price","Sale Price","Adjusted","Date"].forEach(function(c,i){h+='<th'+(i===0?' class="l"':'')+'>'+c+'</th>'});
    h+='</tr></thead><tbody><tr class="subj-row"><td><span class="subj-dot"></span>'+esc((DATA.subjectAddress||"Subject").split(",")[0])+(DATA.subjectCode?' <span class="mls-inline">'+esc(DATA.subjectCode)+'</span>':'')+'</td><td>'+(DATA.subjectBeds||"—")+'</td><td>'+(DATA.subjectBaths||"—")+'</td><td>'+(DATA.subjectSqFt?DATA.subjectSqFt.toLocaleString():"—")+'</td><td colspan="6"></td></tr>';
    var sSqft=0,cSqft=0,sBeds=0,cBeds=0,sList=0,cList=0,sSale=0,cSale=0,sDom=0,cDom=0,sPpsf=0,cPpsf=0,sAdj=0,cAdj=0;
    for(var c=0;c<gr.entries.length;c++){var entry=gr.entries[c],comp=entry.comp;
      var headlinePrice=comp.salePrice||comp.listPrice;
      var ppsf=(headlinePrice&&comp.sqft)?Math.round(headlinePrice/comp.sqft):null;
      var cellExtras='<div class="mls-line">'+esc(comp.mls)+(comp.subType?' &middot; '+esc(comp.subType):'')+'</div>';
      if(entry.condition&&entry.condition!=="—"){
        cellExtras+='<span class="cond-badge cond-'+entry.condition.toLowerCase().replace(/[^a-z]/g,"")+'">'+esc(entry.condition)+'</span>';
      }
      if(entry.description){cellExtras+='<span class="cond-desc">'+esc(entry.description)+'</span>'}
      if(entry.zillowEstimate!=null){cellExtras+='<span class="zillow-ref" title="Reference only — not used in pricing">Zillow ref: '+fmt(entry.zillowEstimate)+'</span>'}
      if(entry.acrossDivider){cellExtras+='<span class="divider-ref">Across divider'+(SETTINGS.divider.mode==="exclude"?" · excluded":" · ×"+SETTINGS.divider.factor)+'</span>'}
      if(entry.locationHaircut){cellExtras+='<span class="loc-ref">Loc adj '+entry.locationHaircut+'%</span>'}
      var adjCell="—";
      if(entry.adjustedValue!=null){
        if(entry.valueIncluded){
          adjCell='<span class="adj-cell">'+fmt(entry.adjustedValue);
          if(entry.weight!==1)adjCell+='<br><span class="adj-weight">×'+entry.weight.toFixed(2)+'</span>';
          adjCell+='</span>';
        }else{
          adjCell='<span class="adj-cell adj-excluded">'+fmt(entry.adjustedValue)+'<br><span class="adj-weight">excluded</span></span>';
        }
      }
      h+='<tr><td>'+addrLinks(comp.address)+cellExtras+'</td>'+
        '<td>'+(comp.beds||"—")+'</td>'+
        '<td>'+(comp.baths||"—")+'</td>'+
        '<td>'+(comp.sqft?comp.sqft.toLocaleString():"—")+'</td>'+
        '<td>'+(ppsf?'$'+ppsf.toLocaleString():"—")+'</td>'+
        '<td>'+(comp.dom!=null?comp.dom:"—")+'</td>'+
        '<td class="fw">'+(comp.listPrice?fmt(comp.listPrice):"—")+'</td>'+
        '<td class="fw">'+(comp.salePrice?fmt(comp.salePrice):"—")+'</td>'+
        '<td class="fw">'+adjCell+'</td>'+
        '<td class="dim">'+(comp.statusDt||"—")+'</td></tr>';
      if(comp.sqft){sSqft+=comp.sqft;cSqft++}
      if(comp.beds){sBeds+=parseInt(comp.beds);cBeds++}
      if(comp.listPrice){sList+=comp.listPrice;cList++}
      if(comp.salePrice){sSale+=comp.salePrice;cSale++}
      if(comp.dom!=null){sDom+=comp.dom;cDom++}
      if(ppsf){sPpsf+=ppsf;cPpsf++}
      if(entry.valueIncluded&&entry.adjustedValue!=null){sAdj+=entry.adjustedValue;cAdj++}
    }
    h+='<tr class="avg-row">'+
      '<td colspan="3" style="text-align:right;padding-right:10px">Average ('+gr.entries.length+')</td>'+
      '<td>'+(cSqft?Math.round(sSqft/cSqft).toLocaleString():"—")+'</td>'+
      '<td>'+(cPpsf?'$'+Math.round(sPpsf/cPpsf).toLocaleString():"—")+'</td>'+
      '<td>'+(cDom?Math.round(sDom/cDom):"—")+'</td>'+
      '<td class="fw">'+(cList?fmt(Math.round(sList/cList)):"—")+'</td>'+
      '<td class="fw">'+(cSale?fmt(Math.round(sSale/cSale)):"—")+'</td>'+
      '<td class="fw">'+(cAdj?fmt(Math.round(sAdj/cAdj)):"—")+'</td>'+
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

/* ── Comp map (Leaflet + OSM, Census geocoder) ──────────────────────── */
/* Pure visual aid. Drawings are persisted in-memory until the user re-pastes
 * a new CMA. We DO NOT auto-apply drawings to scoring/exclusion — the agent
 * still toggles "Across divider" per comp. The map's job is to surface the
 * geography Alan's hand-pricing relies on (dividers, boundaries, distance). */
var MAP=null, MAP_MARKERS=[], SUBJ_MARKER=null, DRAW_LAYER=null;

function initMap(){
  if(typeof L==="undefined")return;             // Leaflet not loaded (tests.html, etc.)
  var el=document.getElementById("map");
  if(!el)return;
  if(MAP){try{MAP.remove()}catch(e){};MAP=null}
  MAP_MARKERS=[];SUBJ_MARKER=null;
  MAP=L.map(el,{scrollWheelZoom:true,zoomControl:true}).setView([37.3,-122.0],11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom:19
  }).addTo(MAP);
  // Drawing toolbar — polyline (dividers), polygon (area boundaries), rectangle.
  DRAW_LAYER=new L.FeatureGroup();MAP.addLayer(DRAW_LAYER);
  if(L.Control&&L.Control.Draw){
    var ctl=new L.Control.Draw({
      edit:{featureGroup:DRAW_LAYER},
      draw:{circle:false,circlemarker:false,marker:false,
            polyline:{shapeOptions:{color:"#cd1f3f",weight:4,opacity:.85}},
            polygon:{shapeOptions:{color:"#cd1f3f",weight:2,fillOpacity:.10}},
            rectangle:{shapeOptions:{color:"#cd1f3f",weight:2,fillOpacity:.10}}}
    });
    MAP.addControl(ctl);
    MAP.on(L.Draw.Event.CREATED,function(e){DRAW_LAYER.addLayer(e.layer)});
  }
  // Wait one frame for the container to size, then invalidate so OSM tiles render correctly.
  setTimeout(function(){MAP.invalidateSize();geocodeAllForMap()},50);
}

function geocodeAllForMap(){
  if(!MAP||!DATA)return;
  var statusEl=document.getElementById("geo-status");
  if(statusEl)statusEl.textContent="Locating subject…";
  var subjAddr=DATA.subjectAddress;
  if(subjAddr){
    geocodeCoords(subjAddr,function(coords){
      if(coords){
        SUBJ_MARKER=L.marker([coords.lat,coords.lng],{icon:subjectIcon(),zIndexOffset:1000})
          .addTo(MAP).bindPopup('<div class="map-popup"><b>Subject Property</b><br>'+esc(subjAddr)+'</div>');
        MAP.setView([coords.lat,coords.lng],14);
      }
      geocodeCompsForMap(0);
    });
  }else{geocodeCompsForMap(0)}
}

function geocodeCompsForMap(idx){
  if(!MAP)return;
  var statusEl=document.getElementById("geo-status");
  if(idx>=CS.length){
    if(statusEl)statusEl.textContent=MAP_MARKERS.filter(Boolean).length+" of "+CS.length+" comps mapped";
    fitMapBounds();
    return;
  }
  if(statusEl)statusEl.textContent="Locating "+(idx+1)+" of "+CS.length+"…";
  var cs=CS[idx];
  // Skip re-geocode if we already have coords (cached on the CS entry).
  if(cs.coords){addCompMarker(cs,idx,cs.coords);setTimeout(function(){geocodeCompsForMap(idx+1)},0);return}
  var addr=cs.comp.address;
  if(addr.indexOf(",")===-1&&DATA.subjectAddress){
    var parts=DATA.subjectAddress.split(",");
    if(parts.length>=2)addr=addr+", "+parts.slice(1).join(",").trim();
  }
  geocodeCoords(addr,function(coords){
    if(coords){cs.coords=coords;addCompMarker(cs,idx,coords)}
    setTimeout(function(){geocodeCompsForMap(idx+1)},220);  // rate-limit the Census API
  });
}

function addCompMarker(cs,idx,coords){
  var marker=L.marker([coords.lat,coords.lng],{icon:compIcon(cs)});
  marker.bindPopup(buildMapPopup(cs,idx));
  marker.on("click",function(){
    var card=document.getElementById("cc-"+idx);
    if(card){
      card.scrollIntoView({behavior:"smooth",block:"center"});
      card.classList.add("highlight");
      setTimeout(function(){card.classList.remove("highlight")},1600);
    }
  });
  marker.addTo(MAP);
  MAP_MARKERS[idx]=marker;
}

function subjectIcon(){
  return L.divIcon({
    className:"map-pin-subject-wrap",
    html:'<div class="subj-pulse"></div><div class="subj-pin">&#9733;</div><div class="subj-tag">SUBJECT</div>',
    iconSize:[44,44],iconAnchor:[22,22]
  });
}
function compIcon(cs){
  var s=(cs.status||"").toLowerCase();
  var cls=/sold/.test(s)?"sold":/pending|contingent/.test(s)?"pending":/expired|cancel|withdraw/.test(s)?"inactive":"active";
  var excl=cs.included?"":" excluded";
  var label=cs.score!=null?String(cs.score):"·";
  return L.divIcon({className:"map-pin map-pin-"+cls+excl,html:label,iconSize:[26,26],iconAnchor:[13,13]});
}

function buildMapPopup(cs,idx){
  var c=cs.comp;
  var h='<div class="map-popup"><b>'+esc(c.address)+'</b>';
  h+='<div style="color:#6b7280;font-size:11px">'+esc(cs.status)+' &middot; '+esc(c.mls||"")+'</div>';
  h+='<div class="pop-row"><span>Bd/Ba/SqFt</span><b>'+(c.beds||"?")+' / '+(c.baths||"?")+' / '+(c.sqft?c.sqft.toLocaleString():"?")+'</b></div>';
  var headline=c.salePrice||c.listPrice;
  if(headline)h+='<div class="pop-row"><span>'+(c.salePrice?"Sale":"List")+'</span><b>'+fmt(headline)+'</b></div>';
  if(cs.adjustedValue)h+='<div class="pop-row"><span>Adjusted</span><b>'+fmt(cs.adjustedValue)+'</b></div>';
  if(cs.score!=null)h+='<div class="pop-row"><span>Score</span><b>'+cs.score+'</b></div>';
  if(cs.acrossDivider)h+='<div style="color:#a8231b;font-size:10.5px;margin-top:4px">Across divider</div>';
  h+='</div>';
  return h;
}

function fitMapBounds(){
  if(!MAP)return;
  var b=L.latLngBounds([]);
  if(SUBJ_MARKER)b.extend(SUBJ_MARKER.getLatLng());
  for(var i=0;i<MAP_MARKERS.length;i++)if(MAP_MARKERS[i])b.extend(MAP_MARKERS[i].getLatLng());
  if(b.isValid())MAP.fitBounds(b,{padding:[36,36],maxZoom:16});
}

function clearMapDrawings(){if(DRAW_LAYER)DRAW_LAYER.clearLayers()}
function toggleMap(){
  var sec=document.getElementById("map-section"),btn=document.getElementById("map-toggle");
  if(!sec)return;
  sec.classList.toggle("collapsed");
  var collapsed=sec.classList.contains("collapsed");
  if(btn)btn.textContent=collapsed?"Show map":"Hide map";
  if(!collapsed&&MAP){setTimeout(function(){MAP.invalidateSize()},50)}
}

/* Reuses our Census-geocoder pattern (already used for school zones) — same
 * endpoint family, just the /locations/ flavor which returns lat/lng. Free,
 * no API key. JSONP fallback when CORS bites. */
function geocodeCoords(address,callback){
  var url="https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address="+
    encodeURIComponent(address)+"&benchmark=Public_AR_Current&format=json";
  fetch(url).then(function(r){return r.json()}).then(function(data){
    try{var c=data.result.addressMatches[0].coordinates;callback({lng:c.x,lat:c.y})}
    catch(e){callback(null)}
  }).catch(function(){geocodeCoordsJSONP(address,callback)});
}
function geocodeCoordsJSONP(address,callback){
  var cbName="gc_"+Date.now()+"_"+Math.random().toString(36).substr(2,5);
  var timeout=setTimeout(function(){delete window[cbName];callback(null)},8000);
  window[cbName]=function(data){
    clearTimeout(timeout);delete window[cbName];
    try{var c=data.result.addressMatches[0].coordinates;callback({lng:c.x,lat:c.y})}
    catch(e){callback(null)}
  };
  var s=document.createElement("script");
  s.src="https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address="+
    encodeURIComponent(address)+"&benchmark=Public_AR_Current&format=jsonp&callback="+cbName;
  s.onerror=function(){clearTimeout(timeout);delete window[cbName];callback(null)};
  document.head.appendChild(s);
}

/* ── Settings modal ─────────────────────────────────────────────────── */
function openSettings(){
  var modal=document.getElementById("settings-modal");
  if(!modal){
    modal=document.createElement("div");
    modal.id="settings-modal";
    modal.className="modal";
    modal.onclick=function(e){if(e.target===modal)closeSettings()};
    document.body.appendChild(modal);
  }
  modal.style.display="flex";
  renderSettingsModal();
}
function closeSettings(){var m=document.getElementById("settings-modal");if(m)m.style.display="none"}
function renderSettingsModal(){
  var modal=document.getElementById("settings-modal");if(!modal)return;
  var s=SETTINGS;
  var h='<div class="modal-card">';
  h+='<div class="modal-head"><h2>Pricing settings</h2><button class="modal-x" onclick="closeSettings()">&times;</button></div>';
  h+='<p class="modal-help">All values below are user-editable. Saved to your browser; click <b>Save</b> to apply.</p>';

  h+='<h3>Condition · remodel cost remaining ($)</h3>';
  h+='<div class="set-row"><label>Poor → Move-in</label><input type="number" step="1000" value="'+s.conditionCosts.poorToMoveIn+'" oninput="SETTINGS.conditionCosts.poorToMoveIn=parseFloat(this.value)||0"></div>';
  h+='<div class="set-row"><label>Medium → Move-in</label><input type="number" step="1000" value="'+s.conditionCosts.mediumToMoveIn+'" oninput="SETTINGS.conditionCosts.mediumToMoveIn=parseFloat(this.value)||0"></div>';

  h+='<h3>Divider (El Camino, Willow, tracks, downtown edge)</h3>';
  h+='<div class="set-row"><label>Mode</label><select onchange="SETTINGS.divider.mode=this.value"><option value="exclude"'+(s.divider.mode==="exclude"?" selected":"")+'>Exclude across-divider comps</option><option value="downweight"'+(s.divider.mode==="downweight"?" selected":"")+'>Down-weight (multiplier)</option></select></div>';
  h+='<div class="set-row"><label>Down-weight factor</label><input type="number" step="0.05" min="0" max="1" value="'+s.divider.factor+'" oninput="SETTINGS.divider.factor=parseFloat(this.value)||0"></div>';

  h+='<h3>Recency weighting</h3>';
  h+='<div class="set-row"><label>Window (months)</label><input type="number" step="1" min="1" value="'+s.recency.windowMonths+'" oninput="SETTINGS.recency.windowMonths=parseInt(this.value)||6"></div>';
  h+='<div class="set-row"><label>Older-than weight factor</label><input type="number" step="0.05" min="0" max="1" value="'+s.recency.factor+'" oninput="SETTINGS.recency.factor=parseFloat(this.value)||0"></div>';

  h+='<h3>Lot-size mismatch warning</h3>';
  h+='<div class="set-row"><label>Threshold (% difference)</label><input type="number" step="5" min="0" max="100" value="'+Math.round(s.lotMismatchThreshold*100)+'" oninput="SETTINGS.lotMismatchThreshold=(parseFloat(this.value)||0)/100"></div>';

  h+='<h3>Market read</h3>';
  h+='<div class="set-row"><label>"Soft" if (expired+cancelled)/sold ≥</label><input type="number" step="0.05" min="0" max="3" value="'+s.marketRead.softRatio+'" oninput="SETTINGS.marketRead.softRatio=parseFloat(this.value)||0.5"></div>';

  h+='<h3>Data-quality warnings</h3>';
  h+='<div class="set-row"><label>Warn if fewer than N value comps</label><input type="number" step="1" min="1" value="'+s.dataQuality.minValueComps+'" oninput="SETTINGS.dataQuality.minValueComps=parseInt(this.value)||3"></div>';
  h+='<div class="set-row"><label>Warn if range spread ≥ (% of rec price)</label><input type="number" step="5" min="0" max="100" value="'+Math.round(s.dataQuality.rangeSpread*100)+'" oninput="SETTINGS.dataQuality.rangeSpread=(parseFloat(this.value)||0)/100"></div>';

  h+='<div class="modal-actions">';
  h+='<button class="btn btn-navy" onclick="saveSettings();updateScores();closeSettings()">Save</button>';
  h+='<button class="qa-btn" onclick="resetSettings()">Reset to defaults</button>';
  h+='<button class="qa-btn" onclick="closeSettings()">Cancel</button>';
  h+='</div>';
  h+='</div>';
  modal.innerHTML=h;
}

/* Display version on load (used by index.html footer + tests.html). */
if(typeof document!=="undefined"){
  document.addEventListener("DOMContentLoaded",function(){
    var v=document.getElementById("version-tag");if(v)v.textContent="v"+VERSION;
  });
}
