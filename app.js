// app.js — PoE2 Farm Calculator (sections + correct Ex/Div totals)

let dataJson = null;

let sections = {};          // { currency: [...], fragments: [...], ... }
let activeTab = "currency";

let itemMap = new Map();    // nameLower -> item (from ALL sections)

let exaltIcon = "";
let divineIcon = "";
let divineInEx = null;      // 1 Divine = X Ex (exalted per divine)

function $(id){ return document.getElementById(id); }
function cleanName(name){ return String(name||"").replace(/\s*WIKI\s*$/i,"").trim(); }
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}
function setStatus(msg){
  const el = $("fetchStatus");
  if(el) el.textContent = msg;
  console.log(msg);
}
function num(id){
  const el = $(id);
  const v = el ? Number(el.value) : 0;
  return Number.isFinite(v) ? v : 0;
}

function formatDual(exValue){
  const ex = Number(exValue || 0);
  const div = (divineInEx && divineInEx > 0) ? (ex / divineInEx) : 0;

  return `
    <span class="tValue">
      <span>${ex.toFixed(2)}</span>${exaltIcon ? `<img class="pIcon" src="${exaltIcon}" alt="Ex">` : ""}
      <span class="sep">/</span>
      <span>${div.toFixed(2)}</span>${divineIcon ? `<img class="pIcon" src="${divineIcon}" alt="Div">` : ""}
    </span>
  `;
}

// -------------------- LOAD DATA --------------------
async function loadData(){
  try{
    setStatus("Status: loading data/prices.json...");
    const res = await fetch("./data/prices.json?ts=" + Date.now(), { cache: "no-store" });
    dataJson = await res.json();

    sections = dataJson.sections || {};
    exaltIcon = dataJson.baseIcon || "";

    // Build global map from ALL lines (all sections)
    const all = Array.isArray(dataJson.lines) ? dataJson.lines : Object.values(sections).flat();
    itemMap = new Map(
      all.map(x => [cleanName(x.name).toLowerCase(), {
        section: x.section || "",
        name: cleanName(x.name),
        icon: x.icon || "",
        amount: Number(x.amount ?? 0),
        unit: cleanName(x.unit || ""),
        unitIcon: x.unitIcon || "",
        exaltedValue: (x.exaltedValue === null || x.exaltedValue === undefined) ? null : Number(x.exaltedValue)
      }])
    );

    // Find Divine + Exalted info (for totals and icons)
    const div = itemMap.get("divine orb");
    const ex  = itemMap.get("exalted orb") || itemMap.get("perfect exalted orb");

    divineIcon = div?.icon || "";
    // divineInEx can come directly from tooltip (best)
    if (div?.exaltedValue && div.exaltedValue > 0) {
      divineInEx = div.exaltedValue;
    } else {
      divineInEx = null;
    }

    // If base icon missing, try from map
    if(!exaltIcon){
      exaltIcon = ex?.icon || "";
    }

    // Restore tab from storage if exists
    const saved = localStorage.getItem("poe2_activeTab");
    if (saved && sections[saved]) activeTab = saved;

    bindTabs();
    fillDatalistAll();
    renderLeftList();
    loadState();        // restore loot + invest
    refreshAllLootPrices();
    recalcAll();

    setStatus(`Status: OK ✅ sections=${Object.keys(sections).length} items=${itemMap.size} | 1 Div=${divineInEx ? divineInEx.toFixed(4) : "?"} Ex`);
  }catch(e){
    setStatus("Status: ERROR ❌ " + e.toString());
  }
}

// -------------------- TABS --------------------
function bindTabs(){
  // expects buttons with class .tab and data-tab="currency" etc.
  document.querySelectorAll(".tab").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
    btn.onclick = ()=>{
      const key = btn.dataset.tab;
      if(!sections[key]) return;
      activeTab = key;
      localStorage.setItem("poe2_activeTab", activeTab);

      document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");

      renderLeftList();
      saveState();
    };
  });

  $("currencySearch")?.addEventListener("input", renderLeftList);
}

// -------------------- LEFT LIST --------------------
function renderLeftList(){
  const panel = $("currencyList");
  if(!panel) return;

  const q = ($("currencySearch")?.value || "").trim().toLowerCase();
  const arr = sections[activeTab] || [];

  panel.innerHTML = "";

  const filtered = arr
    .map(x => ({
      section: x.section || activeTab,
      name: cleanName(x.name),
      icon: x.icon || "",
      amount: Number(x.amount ?? 0),
      unit: cleanName(x.unit || ""),
      unitIcon: x.unitIcon || ""
    }))
    .filter(x => x.name.toLowerCase().includes(q))
    .slice(0, 400);

  if(!filtered.length){
    panel.innerHTML = `<div style="color:#bbb;padding:10px;">No items.</div>`;
    return;
  }

  filtered.forEach(x=>{
    const row = document.createElement("div");
    row.className = "currency-item";

    const rightText = x.unit ? `${x.amount} ${x.unit}` : `${x.amount}`;

    row.innerHTML = `
      <div class="cLeft">
        ${x.icon ? `<img class="cIcon" src="${x.icon}" alt="">` : ""}
        <span>${escapeHtml(x.name)}</span>
      </div>
      <small class="mRight">
        <span>${escapeHtml(rightText)}</span>
        ${x.unitIcon ? `<img class="mUnitIcon" src="${x.unitIcon}" alt="">` : ""}
      </small>
    `;

    row.addEventListener("click", ()=> addLootLineWithName(x.name));
    panel.appendChild(row);
  });
}

// datalist = all items (so you can type anything from any tab)
function fillDatalistAll(){
  const dl = $("currencyDatalist");
  if(!dl) return;
  dl.innerHTML = "";
  for (const it of itemMap.values()){
    const opt = document.createElement("option");
    opt.value = it.name;
    dl.appendChild(opt);
  }
}

// -------------------- LOOT ROWS --------------------
function addLootLine(){
  const tr = document.createElement("tr");
  tr.className = "lootRow";
  tr.innerHTML = `
    <td>
      <div class="lootItemWrap">
        <input class="lootItem" list="currencyDatalist" placeholder="Item">
        <img class="lootIcon" alt="">
      </div>
    </td>
    <td>
      <div class="priceCell">
        <span class="lootPrice">0</span>
        <img class="baseIcon" alt="">
      </div>
    </td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Delete">✖</button></td>
  `;

  $("lootBody").appendChild(tr);

  const baseImg = tr.querySelector(".baseIcon");
  if(exaltIcon){
    baseImg.src = exaltIcon;
    baseImg.style.display = "block";
  } else baseImg.style.display = "none";

  const itemInput = tr.querySelector(".lootItem");
  const qtyInput  = tr.querySelector(".lootQty");

  itemInput.addEventListener("input", ()=>{
    updatePrice(itemInput);
    saveState();
  });
  qtyInput.addEventListener("input", ()=>{
    recalcAll();
    saveState();
  });

  tr.querySelector(".deleteBtn").addEventListener("click", ()=>{
    tr.remove();
    recalcAll();
    saveState();
  });

  return tr;
}

function addLootLineWithName(name){
  const tr = addLootLine();
  tr.querySelector(".lootItem").value = name;
  updatePrice(tr.querySelector(".lootItem"));
  recalcAll();
  saveState();
}

function addManualLine(){
  const tr = document.createElement("tr");
  tr.className = "lootRow manualRow";
  tr.innerHTML = `
    <td><input class="lootItem" placeholder="Custom name"></td>
    <td><input class="manualPrice" type="number" value="0" min="0" step="0.01"></td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Delete">✖</button></td>
  `;
  $("lootBody").appendChild(tr);

  tr.querySelector(".deleteBtn").addEventListener("click", ()=>{
    tr.remove();
    recalcAll();
    saveState();
  });

  tr.querySelector(".manualPrice").addEventListener("input", ()=>{ recalcAll(); saveState(); });
  tr.querySelector(".lootQty").addEventListener("input", ()=>{ recalcAll(); saveState(); });
  tr.querySelector(".lootItem").addEventListener("input", saveState);

  return tr;
}

function updatePrice(input){
  const row = input.closest("tr");
  if(row.classList.contains("manualRow")){ recalcAll(); return; }

  const key = cleanName(input.value).toLowerCase();
  const found = itemMap.get(key);

  const priceEl = row.querySelector(".lootPrice");
  const iconEl  = row.querySelector(".lootIcon");

  if(found?.icon){
    iconEl.src = found.icon;
    iconEl.style.display = "block";
  }else{
    iconEl.style.display = "none";
  }

  // Right table MUST be Exalted prices
  const ex = (found?.exaltedValue && found.exaltedValue > 0) ? found.exaltedValue : 0;
  priceEl.textContent = Number(ex).toFixed(2);

  recalcAll();
}

function refreshAllLootPrices(){
  document.querySelectorAll("#lootBody tr").forEach(tr=>{
    if(tr.classList.contains("manualRow")) return;
    const inp = tr.querySelector(".lootItem");
    if(inp) updatePrice(inp);
  });
}

// -------------------- CALCULATIONS --------------------
function calcInvestEx(){
  const maps = num("maps");
  const ppm  = num("costPerMap");
  return maps * ppm;
}

function calcLootEx(){
  let total = 0;
  document.querySelectorAll("#lootBody tr").forEach(row=>{
    const qty = Number(row.querySelector(".lootQty")?.value || 0);
    if(row.classList.contains("manualRow")){
      const p = Number(row.querySelector(".manualPrice")?.value || 0);
      total += p * qty;
    }else{
      const p = Number(row.querySelector(".lootPrice")?.textContent || 0);
      total += p * qty;
    }
  });
  return total;
}

function recalcAll(){
  const invest = calcInvestEx();
  const loot   = calcLootEx();
  const gain   = loot - invest;

  $("totalInvest").innerHTML = formatDual(invest);
  $("totalLoot").innerHTML   = formatDual(loot);
  $("gain").innerHTML        = formatDual(gain);
}

// -------------------- STORAGE --------------------
function saveState(){
  const rows = [...document.querySelectorAll("#lootBody tr")].map(r=>{
    const manual = r.classList.contains("manualRow");
    return {
      manual,
      item: r.querySelector(".lootItem")?.value || "",
      qty: Number(r.querySelector(".lootQty")?.value || 0),
      price: manual ? Number(r.querySelector(".manualPrice")?.value || 0) : null
    };
  });

  const invest = {
    maps: $("maps")?.value ?? "10",
    costPerMap: $("costPerMap")?.value ?? "0"
  };

  localStorage.setItem("poe2_state", JSON.stringify({ rows, invest, activeTab }));
}

function loadState(){
  const raw = localStorage.getItem("poe2_state");
  if(!raw){
    if(!document.querySelector("#lootBody tr")) addLootLine();
    return;
  }

  try{
    const st = JSON.parse(raw);

    if(st?.invest){
      if($("maps")) $("maps").value = st.invest.maps ?? "10";
      if($("costPerMap")) $("costPerMap").value = st.invest.costPerMap ?? "0";
    }

    if(st?.activeTab && sections[st.activeTab]){
      activeTab = st.activeTab;
      localStorage.setItem("poe2_activeTab", activeTab);
      document.querySelectorAll(".tab").forEach(b=>{
        b.classList.toggle("active", b.dataset.tab === activeTab);
      });
    }

    $("lootBody").innerHTML = "";
    if(Array.isArray(st?.rows) && st.rows.length){
      st.rows.forEach(r=>{
        if(r.manual){
          const tr = addManualLine();
          tr.querySelector(".lootItem").value = r.item || "";
          tr.querySelector(".lootQty").value  = r.qty ?? 0;
          tr.querySelector(".manualPrice").value = r.price ?? 0;
        }else{
          const tr = addLootLine();
          tr.querySelector(".lootItem").value = r.item || "";
          tr.querySelector(".lootQty").value  = r.qty ?? 0;
          updatePrice(tr.querySelector(".lootItem"));
        }
      });
    } else {
      addLootLine();
    }
  }catch{
    addLootLine();
  }
}

// -------------------- RESET --------------------
function resetAll(){
  localStorage.removeItem("poe2_state");
  localStorage.removeItem("poe2_activeTab");

  if($("maps")) $("maps").value = "10";
  if($("costPerMap")) $("costPerMap").value = "0";

  $("lootBody").innerHTML = "";
  addLootLine();

  activeTab = "currency";
  document.querySelectorAll(".tab").forEach(b=>{
    b.classList.toggle("active", b.dataset.tab === "currency");
  });

  renderLeftList();
  recalcAll();
  saveState();
  setStatus("Status: reset ✅");
}

// -------------------- INIT --------------------
document.addEventListener("DOMContentLoaded", ()=>{
  // expose buttons if you use onclick=""
  window.addLootLine = addLootLine;
  window.addManualLine = addManualLine;
  window.resetAll = resetAll;

  $("resetBtn")?.addEventListener("click", resetAll);

  ["maps","costPerMap"].forEach(id=>{
    $(id)?.addEventListener("input", ()=>{
      recalcAll();
      saveState();
    });
  });

  loadData().then(()=>{
    renderLeftList();
    recalcAll();
  });
});

console.log("DATA:", data);
console.log("LINES:", data.lines?.length);

