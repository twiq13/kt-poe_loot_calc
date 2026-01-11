// ==========================================================
// PoE2 Farm Calculator - FINAL app.js
// Base calculations in EXALTED (Ex)
// Display: Smart Ex/Div (Market + Loot) + Dual Ex/Div (Totals)
// Data source: ./data/prices.json (scraper forces Value Display = Exalted Orb)
// ==========================================================

let items = [];              // all lines from prices.json
let byName = new Map();      // nameLower -> item
let bySection = new Map();   // sectionId -> [items...]

// Icons & rates
let exaltIcon = "";
let divineIcon = "";
let divineInEx = null;       // 1 Divine = X Ex

// UI state
let activeSection = "currency";

// ==========================================================
// Helpers
// ==========================================================
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function setStatus(msg) {
  const el = document.getElementById("fetchStatus");
  if (el) el.textContent = msg;
  console.log(msg);
}

function num(id) {
  const el = document.getElementById(id);
  const v = el ? Number(el.value) : 0;
  return Number.isFinite(v) ? v : 0;
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function cleanName(name) {
  return String(name || "").replace(/\s*WIKI\s*$/i, "").trim();
}

// ==========================================================
// Formatting (display)
// ==========================================================

// Smart display: choose Div if >= 1 Divine in Ex, else Ex
function formatSmart(exValue) {
  const ex = Number(exValue || 0);

  if (!divineInEx || divineInEx <= 0) {
    return { value: ex.toFixed(2), icon: exaltIcon, mode: "ex" };
  }

  if (ex >= divineInEx) {
    const div = ex / divineInEx;
    return { value: div.toFixed(2), icon: divineIcon, mode: "div" };
  }

  return { value: ex.toFixed(2), icon: exaltIcon, mode: "ex" };
}

// Totals display: always show Ex / Div
function formatDual(exValue) {
  const ex = Number(exValue || 0);
  const div = (divineInEx && divineInEx > 0) ? (ex / divineInEx) : 0;

  return `
    <span class="dual">
      <span>${ex.toFixed(2)}</span>${exaltIcon ? `<img class="pIcon" src="${exaltIcon}" alt="Ex">` : ""}
      <span class="sep">/</span>
      <span>${div.toFixed(2)}</span>${divineIcon ? `<img class="pIcon" src="${divineIcon}" alt="Div">` : ""}
    </span>
  `;
}

// ==========================================================
// Load data (prices.json)
// ==========================================================
async function loadData() {
  try {
    setStatus("Status: loading data/prices.json...");

    const res = await fetch("./data/prices.json?ts=" + Date.now(), { cache: "no-store" });
    const data = await res.json();

    // Base info from json
    exaltIcon = data.baseIcon || "";
    divineIcon = data.divineIcon || "";
    divineInEx = (typeof data.divineInEx === "number") ? data.divineInEx : null;

    // Lines
    items = (data.lines || []).map(x => ({
      section: x.section || "currency",
      name: cleanName(x.name),
      icon: x.icon || "",
      exaltedValue: Number(x.exaltedValue ?? x.amount ?? 0), // base in Ex
      unitIcon: x.unitIcon || "" // optional
    })).filter(x => x.name);

    byName = new Map(items.map(it => [it.name.toLowerCase(), it]));

    // Group by section
    bySection = new Map();
    for (const it of items) {
      if (!bySection.has(it.section)) bySection.set(it.section, []);
      bySection.get(it.section).push(it);
    }

    // If divineInEx missing: try to get from currency "Divine Orb"
    if (!divineInEx || divineInEx <= 0) {
      const divRow = byName.get("divine orb");
      if (divRow && divRow.exaltedValue > 0) {
        divineInEx = divRow.exaltedValue;
      }
    }

    // If missing icons, fallback from rows
    if (!exaltIcon) exaltIcon = byName.get("exalted orb")?.icon || "";
    if (!divineIcon) divineIcon = byName.get("divine orb")?.icon || "";

    setStatus(`Status: OK ✅ sections=${bySection.size} items=${items.length} | 1 Div=${divineInEx ? divineInEx.toFixed(2) : "?"} Ex`);

    bindTabs();            // tabs click events
    bindSearch();          // search input event
    fillDatalist();        // for loot autocomplete
    loadState();           // restore previous state
    renderMarketList();    // render left panel
    refreshAllLootRows();  // update loot display
    recalcAll();           // totals

  } catch (e) {
    setStatus("Status: ERROR ❌ " + e.toString());
  }
}

// ==========================================================
// Tabs & Market List
// ==========================================================
function bindTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(btn => {
    btn.onclick = () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeSection = btn.dataset.tab || "currency";
      renderMarketList();
      saveState();
    };
  });

  // Ensure current section active after loadState
  tabs.forEach(b => b.classList.toggle("active", b.dataset.tab === activeSection));
}

function bindSearch() {
  const search = document.getElementById("currencySearch");
  if (!search) return;
  search.addEventListener("input", renderMarketList);
}

function renderMarketList() {
  const panel = document.getElementById("currencyList");
  if (!panel) return;

  const q = (document.getElementById("currencySearch")?.value || "").trim().toLowerCase();
  panel.innerHTML = "";

  const list = bySection.get(activeSection) || [];
  const filtered = list
    .filter(it => it.name.toLowerCase().includes(q))
    .slice(0, 400);

  if (!filtered.length) {
    panel.innerHTML = `<div style="color:#bbb;padding:10px;">No items.</div>`;
    return;
  }

  for (const it of filtered) {
    const row = document.createElement("div");
    row.className = "currency-item";

    const smart = formatSmart(it.exaltedValue);

    row.innerHTML = `
      <div class="cLeft">
        ${it.icon ? `<img class="cIcon" src="${it.icon}" alt="">` : ""}
        <span>${esc(it.name)}</span>
      </div>
      <small class="mRight">
        <span>${esc(smart.value)}</span>
        ${smart.icon ? `<img class="mUnitIcon" src="${smart.icon}" alt="">` : ""}
      </small>
    `;

    row.addEventListener("click", () => addLootLineWithName(it.name));
    panel.appendChild(row);
  }
}

function fillDatalist() {
  const dl = document.getElementById("currencyDatalist");
  if (!dl) return;
  dl.innerHTML = "";

  // All items (not only currency) so user can search everything
  items.forEach(it => {
    const opt = document.createElement("option");
    opt.value = it.name;
    dl.appendChild(opt);
  });
}

// ==========================================================
// Loot Table
// ==========================================================
function addLootLine() {
  const body = document.getElementById("lootBody");
  if (!body) return null;

  const tr = document.createElement("tr");
  tr.className = "lootRow";
  tr.dataset.exPrice = "0"; // base calc

  tr.innerHTML = `
    <td>
      <div class="lootItemWrap">
        <input class="lootItem" list="currencyDatalist" placeholder="Item">
        <img class="lootIcon" alt="">
      </div>
    </td>
    <td>
      <div class="priceCell">
        <span class="lootPrice">0.00</span>
        <img class="baseIcon" alt="">
      </div>
    </td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Delete">✖</button></td>
  `;

  body.appendChild(tr);

  const itemInput = tr.querySelector(".lootItem");
  const qtyInput  = tr.querySelector(".lootQty");
  const delBtn    = tr.querySelector(".deleteBtn");

  itemInput.addEventListener("input", () => {
    updateLootRow(tr);
    saveState();
  });

  qtyInput.addEventListener("input", () => {
    recalcAll();
    saveState();
  });

  delBtn.addEventListener("click", () => {
    tr.remove();
    recalcAll();
    saveState();
  });

  // set default icon in price cell
  const baseImg = tr.querySelector(".baseIcon");
  if (exaltIcon) {
    baseImg.src = exaltIcon;
    baseImg.style.display = "block";
  } else {
    baseImg.style.display = "none";
  }

  return tr;
}

function addManualLine() {
  const body = document.getElementById("lootBody");
  if (!body) return null;

  const tr = document.createElement("tr");
  tr.className = "lootRow manualRow";
  tr.dataset.exPrice = "0";

  tr.innerHTML = `
    <td><input class="lootItem" placeholder="Custom name"></td>
    <td><input class="manualPrice" type="number" value="0" min="0" step="0.01"></td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Delete">✖</button></td>
  `;

  body.appendChild(tr);

  const priceInput = tr.querySelector(".manualPrice");
  const qtyInput   = tr.querySelector(".lootQty");
  const delBtn     = tr.querySelector(".deleteBtn");

  priceInput.addEventListener("input", () => {
    tr.dataset.exPrice = String(Number(priceInput.value || 0)); // manual is Ex
    recalcAll();
    saveState();
  });

  qtyInput.addEventListener("input", () => {
    recalcAll();
    saveState();
  });

  delBtn.addEventListener("click", () => {
    tr.remove();
    recalcAll();
    saveState();
  });

  return tr;
}

function addLootLineWithName(name) {
  const tr = addLootLine();
  if (!tr) return;
  tr.querySelector(".lootItem").value = name;
  updateLootRow(tr);
  recalcAll();
  saveState();
}

function updateLootRow(tr) {
  if (!tr) return;

  // manual row: exPrice already from input
  if (tr.classList.contains("manualRow")) {
    const price = Number(tr.querySelector(".manualPrice")?.value || 0);
    tr.dataset.exPrice = String(price);
    recalcAll();
    return;
  }

  const input = tr.querySelector(".lootItem");
  const name = (input?.value || "").trim().toLowerCase();
  const it = byName.get(name);

  const iconEl = tr.querySelector(".lootIcon");
  const priceEl = tr.querySelector(".lootPrice");
  const baseImg = tr.querySelector(".baseIcon");

  const ex = it ? Number(it.exaltedValue || 0) : 0;
  tr.dataset.exPrice = String(ex);

  // item icon
  if (it?.icon) {
    iconEl.src = it.icon;
    iconEl.style.display = "block";
  } else {
    iconEl.style.display = "none";
  }

  // smart display price (Ex or Div) but keep exPrice for calculations
  const smart = formatSmart(ex);
  priceEl.textContent = smart.value;

  if (smart.icon) {
    baseImg.src = smart.icon;
    baseImg.style.display = "block";
  } else {
    baseImg.style.display = "none";
  }

  recalcAll();
}

function refreshAllLootRows() {
  document.querySelectorAll("#lootBody tr").forEach(tr => updateLootRow(tr));
}

// ==========================================================
// Calculations (always in EX)
// ==========================================================
function calcInvestEx() {
  const maps = num("maps");
  const costPerMap = num("costPerMap"); // user enters in Ex
  return maps * costPerMap;
}

function calcLootEx() {
  let total = 0;
  document.querySelectorAll("#lootBody tr").forEach(tr => {
    const qty = Number(tr.querySelector(".lootQty")?.value || 0);
    const exPrice = Number(tr.dataset.exPrice || 0);
    total += exPrice * qty;
  });
  return total;
}

function recalcAll() {
  const invest = calcInvestEx();
  const loot = calcLootEx();
  const gain = loot - invest;

  setHTML("totalInvest", formatDual(invest));
  setHTML("totalLoot", formatDual(loot));
  setHTML("gain", formatDual(gain));
}

// ==========================================================
// Storage (local)
// ==========================================================
function saveState() {
  const rows = [...document.querySelectorAll("#lootBody tr")].map(tr => {
    const manual = tr.classList.contains("manualRow");
    return {
      manual,
      item: tr.querySelector(".lootItem")?.value || "",
      qty: Number(tr.querySelector(".lootQty")?.value || 0),
      price: manual ? Number(tr.querySelector(".manualPrice")?.value || 0) : null
    };
  });

  const state = {
    section: activeSection,
    invest: {
      maps: document.getElementById("maps")?.value ?? "10",
      costPerMap: document.getElementById("costPerMap")?.value ?? "0"
    },
    rows
  };

  localStorage.setItem("poe2FarmState", JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem("poe2FarmState");
  if (!raw) return;

  try {
    const s = JSON.parse(raw);

    if (s?.section) activeSection = s.section;

    if (s?.invest) {
      const maps = document.getElementById("maps");
      const cost = document.getElementById("costPerMap");
      if (maps) maps.value = s.invest.maps ?? "10";
      if (cost) cost.value = s.invest.costPerMap ?? "0";
    }

    if (Array.isArray(s?.rows)) {
      const body = document.getElementById("lootBody");
      if (body) body.innerHTML = "";

      s.rows.forEach(r => {
        if (r.manual) {
          const tr = addManualLine();
          tr.querySelector(".lootItem").value = r.item || "";
          tr.querySelector(".lootQty").value = r.qty ?? 0;
          tr.querySelector(".manualPrice").value = r.price ?? 0;
          tr.dataset.exPrice = String(Number(r.price ?? 0));
        } else {
          const tr = addLootLine();
          tr.querySelector(".lootItem").value = r.item || "";
          tr.querySelector(".lootQty").value = r.qty ?? 0;
          updateLootRow(tr);
        }
      });
    }

  } catch {
    // ignore
  }
}

// ==========================================================
// Reset
// ==========================================================
function resetAll() {
  localStorage.removeItem("poe2FarmState");

  const maps = document.getElementById("maps");
  const cost = document.getElementById("costPerMap");
  if (maps) maps.value = "10";
  if (cost) cost.value = "0";

  activeSection = "currency";
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === "currency");
  });

  const body = document.getElementById("lootBody");
  if (body) body.innerHTML = "";
  addLootLine();

  document.getElementById("currencySearch").value = "";

  renderMarketList();
  recalcAll();
  setStatus("Status: reset ✅");
}

// ==========================================================
// Init
// ==========================================================
document.addEventListener("DOMContentLoaded", () => {
  // inputs invest
  ["maps", "costPerMap"].forEach(id => {
    document.getElementById(id)?.addEventListener("input", () => {
      recalcAll();
      saveState();
    });
  });

  // reset button
  document.getElementById("resetBtn")?.addEventListener("click", resetAll);

  // expose buttons used in HTML onclick
  window.addLootLine = addLootLine;
  window.addManualLine = addManualLine;
  window.resetAll = resetAll;

  loadData().then(() => {
    // if no rows -> one empty row
    if (!document.querySelector("#lootBody tr")) addLootLine();

    // ensure tabs reflect loaded state
    document.querySelectorAll(".tab").forEach(b => {
      b.classList.toggle("active", b.dataset.tab === activeSection);
    });

    renderMarketList();
    recalcAll();
  });
});
