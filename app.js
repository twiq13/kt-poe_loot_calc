let currencies = [];
let currencyMap = new Map();      // nameLower -> currency
let exaltRates = new Map();       // nameLower -> value in Exalted Orb
let baseName = "Exalted Orb";     // currency de référence affichée
let baseIcon = "";               // icône exalt

function cleanName(name) {
  return String(name || "").replace(/\s*WIKI\s*$/i, "").trim();
}

function setStatus(msg) {
  const box = document.getElementById("fetchStatus");
  if (box) box.textContent = msg;
  console.log(msg);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function numInput(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  const v = Number(el.value);
  return Number.isFinite(v) ? v : 0;
}

// -----------------------
// LOAD prices.json
// -----------------------
async function loadCurrencies() {
  try {
    setStatus("Fetch status: lecture data/prices.json...");

    const res = await fetch("./data/prices.json?ts=" + Date.now(), { cache: "no-store" });
    const data = await res.json();

    currencies = (data.lines || []).map(c => ({
      name: cleanName(c.name),
      amount: Number(c.amount || 0),
      unit: c.unit || "",
      icon: c.icon || "",
      unitIcon: c.unitIcon || ""
    }));

    currencyMap = new Map(currencies.map(c => [c.name.toLowerCase(), c]));

    // trouver l'icône exalt si dispo
    const exalt = currencyMap.get(baseName.toLowerCase());
    baseIcon = exalt?.icon || exalt?.unitIcon || "";

    // construire les conversions vers Exalted
    buildExaltRates();

    setStatus(`Fetch status: OK ✅ currencies=${currencies.length} (maj: ${data.updatedAt || "?"})`);
    renderCurrencyPanel();
    fillDatalist();
    refreshAllLootPrices();  // recalcul après load
    calculerTout();

  } catch (e) {
    setStatus("Fetch status: ERREUR ❌ " + e.toString());
  }
}

// -----------------------
// Build conversion graph to Exalted
// Each row means: 1 "name" = amount * "unit"
// -----------------------
function buildExaltRates() {
  exaltRates = new Map();
  const start = baseName.toLowerCase();
  exaltRates.set(start, 1);

  // edges
  // A -> B with mult m : 1A = m B
  const list = currencies
    .filter(x => x.name && x.unit && x.amount > 0)
    .map(x => ({
      A: x.name.toLowerCase(),
      B: cleanName(x.unit).toLowerCase(),
      m: x.amount
    }));

  // BFS propagation
  let changed = true;
  for (let iter = 0; iter < 50 && changed; iter++) {
    changed = false;

    for (const e of list) {
      const a = exaltRates.get(e.A);
      const b = exaltRates.get(e.B);

      // if B known => A = m * B
      if (b !== undefined && a === undefined) {
        exaltRates.set(e.A, e.m * b);
        changed = true;
      }

      // if A known => B = (1/m) * A
      if (a !== undefined && b === undefined) {
        exaltRates.set(e.B, (1 / e.m) * a);
        changed = true;
      }
    }
  }
}

// -----------------------
// LEFT panel
// -----------------------
function renderCurrencyPanel() {
  const panel = document.getElementById("currencyList");
  if (!panel) return;

  const q = (document.getElementById("currencySearch")?.value || "").trim().toLowerCase();
  panel.innerHTML = "";

  if (!currencies.length) {
    panel.innerHTML = "<p style='color:#aaa'>Aucune donnée dans data/prices.json</p>";
    return;
  }

  const filtered = currencies
    .filter(c => c.name.toLowerCase().includes(q))
    .slice(0, 300);

  filtered.forEach(c => {
    const div = document.createElement("div");
    div.className = "currency-item";
    div.style.cursor = "pointer";

    div.innerHTML = `
      <span style="display:flex;gap:8px;align-items:center;">
        ${c.icon ? `<img src="${c.icon}" style="width:18px;height:18px;">` : ""}
        ${c.name}
      </span>
      <small>${c.amount} ${c.unit || ""}</small>
    `;

    div.addEventListener("click", () => addLootLineWithName(c.name));
    panel.appendChild(div);
  });
}

function fillDatalist() {
  const dl = document.getElementById("currencyDatalist");
  if (!dl) return;

  dl.innerHTML = "";
  currencies.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c.name;
    dl.appendChild(opt);
  });
}

// -----------------------
// LOOT rows
// -----------------------
function addLootLine() {
  const tr = document.createElement("tr");
  tr.className = "lootRow";

  tr.innerHTML = `
    <td>
      <div style="display:flex;align-items:center;gap:8px;">
        <input class="lootItem" list="currencyDatalist" placeholder="Item">
        <img class="lootIcon" style="width:18px;height:18px;display:none;" alt="">
      </div>
    </td>
    <td class="priceCell">
      <span class="lootPrice">0</span>
      <img class="baseIcon" style="width:16px;height:16px;margin-left:6px;vertical-align:middle;display:none;" alt="">
    </td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Supprimer">✖</button></td>
  `;

  document.getElementById("lootBody").appendChild(tr);

  const itemInput = tr.querySelector(".lootItem");
  const qtyInput = tr.querySelector(".lootQty");

  itemInput.addEventListener("input", () => {
    updatePrice(itemInput);
    saveState();
  });

  qtyInput.addEventListener("input", () => {
    calculerTout();
    saveState();
  });

  tr.querySelector(".deleteBtn").addEventListener("click", () => {
    tr.remove();
    calculerTout();
    saveState();
  });

  // mettre l'icône de base (exalt) dans la cellule prix
  const baseImg = tr.querySelector(".baseIcon");
  if (baseIcon) {
    baseImg.src = baseIcon;
    baseImg.style.display = "inline-block";
  } else {
    baseImg.style.display = "none";
  }

  return tr;
}

function addLootLineWithName(name) {
  const tr = addLootLine();
  tr.querySelector(".lootItem").value = name;
  updatePrice(tr.querySelector(".lootItem"));
  calculerTout();
  saveState();
}

function addManualLine() {
  const tr = document.createElement("tr");
  tr.className = "lootRow manualRow";

  tr.innerHTML = `
    <td><input class="lootItem" placeholder="Nom libre"></td>
    <td><input class="manualPrice" type="number" value="0" min="0" step="0.01"></td>
    <td><input class="lootQty" type="number" value="0" min="0"></td>
    <td><button type="button" class="deleteBtn" title="Supprimer">✖</button></td>
  `;

  document.getElementById("lootBody").appendChild(tr);

  tr.querySelector(".deleteBtn").addEventListener("click", () => {
    tr.remove();
    calculerTout();
    saveState();
  });

  tr.querySelector(".manualPrice").addEventListener("input", () => {
    calculerTout();
    saveState();
  });

  tr.querySelector(".lootQty").addEventListener("input", () => {
    calculerTout();
    saveState();
  });

  tr.querySelector(".lootItem").addEventListener("input", () => saveState());

  return tr;
}

// Convert any currency to Exalted using rates graph
function getPriceInExalted(nameLower) {
  // If we know rate directly: 1 name = rate Exalted
  const r = exaltRates.get(nameLower);
  return (r !== undefined) ? r : null;
}

function updatePrice(input) {
  const name = (input.value || "").trim();
  const nameLower = name.toLowerCase();
  const row = input.closest("tr");

  if (row.classList.contains("manualRow")) {
    calculerTout();
    return;
  }

  const priceEl = row.querySelector(".lootPrice");
  const iconEl = row.querySelector(".lootIcon");

  const found = currencyMap.get(nameLower);

  // icon item
  if (found?.icon) {
    iconEl.src = found.icon;
    iconEl.style.display = "inline-block";
  } else {
    iconEl.style.display = "none";
  }

  // price in Exalted
  const ex = getPriceInExalted(nameLower);

  if (ex !== null) {
    priceEl.textContent = Number(ex).toFixed(2);
  } else {
    priceEl.textContent = "0";
  }

  calculerTout();
}

function refreshAllLootPrices() {
  document.querySelectorAll("#lootBody tr").forEach(tr => {
    if (tr.classList.contains("manualRow")) return;
    const inp = tr.querySelector(".lootItem");
    if (inp) updatePrice(inp);
  });
}

// -----------------------
// CALCULS
// -----------------------
function calculerInvest() {
  const maps = numInput("maps");
  const costPerMap = numInput("costPerMap"); // en EXALTED
  const total = maps * costPerMap;
  setText("totalInvest", total.toFixed(2));
  return total;
}

function calculerLoot() {
  let total = 0;

  document.querySelectorAll("#lootBody tr").forEach(row => {
    let price = 0;
    let qty = 0;

    if (row.classList.contains("manualRow")) {
      price = Number(row.querySelector(".manualPrice")?.value) || 0;
      qty = Number(row.querySelector(".lootQty")?.value) || 0;
    } else {
      price = Number(row.querySelector(".lootPrice")?.textContent) || 0;
      qty = Number(row.querySelector(".lootQty")?.value) || 0;
    }

    total += price * qty;
  });

  setText("totalLoot", total.toFixed(2));
  return total;
}

function calculerTout() {
  const invest = calculerInvest();
  const loot = calculerLoot();
  const gains = loot - invest;
  setText("gain", gains.toFixed(2));
}

// -----------------------
// STORAGE
// -----------------------
function saveState() {
  const rows = [...document.querySelectorAll("#lootBody tr")].map(r => {
    const isManual = r.classList.contains("manualRow");
    return {
      manual: isManual,
      item: r.querySelector(".lootItem")?.value || "",
      qty: Number(r.querySelector(".lootQty")?.value || 0),
      price: isManual ? Number(r.querySelector(".manualPrice")?.value || 0) : null
    };
  });

  const invest = {
    maps: document.getElementById("maps")?.value ?? "",
    costPerMap: document.getElementById("costPerMap")?.value ?? ""
  };

  localStorage.setItem("poe2FarmState", JSON.stringify({ rows, invest }));
}

function clearLootRows() {
  const body = document.getElementById("lootBody");
  if (body) body.innerHTML = "";
}

function loadState() {
  const raw = localStorage.getItem("poe2FarmState");
  if (!raw) return;

  try {
    const state = JSON.parse(raw);

    if (state?.invest) {
      Object.keys(state.invest).forEach(k => {
        const el = document.getElementById(k);
        if (el) el.value = state.invest[k];
      });
    }

    if (!state?.rows) return;

    clearLootRows();

    state.rows.forEach(r => {
      if (r.manual) {
        const tr = addManualLine();
        tr.querySelector(".lootItem").value = r.item || "";
        tr.querySelector(".lootQty").value = r.qty ?? 0;
        tr.querySelector(".manualPrice").value = r.price ?? 0;
      } else {
        const tr = addLootLine();
        tr.querySelector(".lootItem").value = r.item || "";
        tr.querySelector(".lootQty").value = r.qty ?? 0;
        updatePrice(tr.querySelector(".lootItem"));
      }
    });

    calculerTout();
  } catch {}
}

// -----------------------
// RESET TEMPLATE
// -----------------------
function resetAll() {
  localStorage.removeItem("poe2FarmState");

  ["maps", "costPerMap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  clearLootRows();
  const tr = addLootLine();
  tr.querySelector(".lootItem").value = "";
  tr.querySelector(".lootQty").value = 0;
  tr.querySelector(".lootPrice").textContent = "0";

  setText("totalInvest", "0");
  setText("totalLoot", "0");
  setText("gain", "0");

  setStatus("Fetch status: reset ✅");
  saveState();
}
window.resetAll = resetAll;

// -----------------------
// INIT
// -----------------------
document.addEventListener("DOMContentLoaded", () => {
  const search = document.getElementById("currencySearch");
  if (search) search.addEventListener("input", renderCurrencyPanel);

  ["maps", "costPerMap"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", () => { calculerTout(); saveState(); });
  });

  window.addLootLine = addLootLine;
  window.addManualLine = addManualLine;
  window.loadCurrencies = loadCurrencies;

  loadCurrencies();
  currencies = (data.lines || []).map(c => ({
  name: cleanName(c.name),
  exaltedValue: Number(c.exaltedValue ?? 0),
  icon: c.icon || ""
}));

currencyMap = new Map(currencies.map(c => [c.name.toLowerCase(), c]));
baseIcon = data.baseIcon || "";

  loadState();

  if (!document.querySelector("#lootBody tr")) addLootLine();
  calculerTout();
});

