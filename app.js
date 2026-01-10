// =======================
// PoE2 Farm Calculette - FINAL (GitHub Pages + prices.json)
// =======================

let currencies = [];          // [{name, amount, unit}, ...] depuis data/prices.json
let currencyMap = new Map();  // nameClean -> currency object

// ---------- utils ----------
function cleanName(name) {
  return String(name || "").replace(/\s*WIKI\s*$/i, "").trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

function setStatus(msg) {
  const box = document.getElementById("fetchStatus");
  if (box) box.textContent = msg;
  console.log(msg);
}

// =======================
// CHARGEMENT PRICES.JSON (local, same-domain)
// =======================
async function loadCurrencies() {
  try {
    setStatus("Fetch status: lecture data/prices.json...");

    const res = await fetch("./data/prices.json?ts=" + Date.now(), { cache: "no-store" });
    const data = await res.json();

    currencies = (data.lines || []).map(c => ({
      name: cleanName(c.name),
      amount: Number(c.amount || 0),
      unit: c.unit || ""
    }));

    currencyMap = new Map(currencies.map(c => [c.name.toLowerCase(), c]));

    setStatus(`Fetch status: OK ✅ currencies=${currencies.length} (maj: ${data.updatedAt || "?"})`);

    renderCurrencyPanel();
    fillDatalist();

  } catch (e) {
    setStatus("Fetch status: ERREUR ❌ " + e.toString());
  }
}

// =======================
// AFFICHAGE COLONNE GAUCHE + recherche
// =======================
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
      <span>${escapeHtml(c.name)}</span>
      <small>${c.amount} ${escapeHtml(c.unit)}</small>
    `;
    div.addEventListener("click", () => {
      addLootLineWithName(c.name);
    });
    panel.appendChild(div);
  });
}

// =======================
// DATALIST (autocomplete loot)
// =======================
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

// =======================
// AJOUT LIGNE LOOT (auto)
// =======================
function addLootLine() {
  const tr = document.createElement("tr");
  tr.className = "lootRow";

tr.innerHTML = `
  <td>
    <input class="lootItem" list="currencyDatalist" placeholder="Item">
  </td>
  <td class="price lootPrice">0</td>
  <td><input class="lootQty" type="number" value="0" min="0"></td>
  <td><button class="deleteBtn" title="Supprimer">✖</button></td>
`;

  document.getElementById("lootBody").appendChild(tr);

  const itemInput = tr.querySelector(".lootItem");
  const qtyInput = tr.querySelector(".lootQty");

  itemInput.addEventListener("input", () => {
    updatePrice(itemInput);
    saveState();
  });

  qtyInput.addEventListener("input", () => {
    calculerLoot();
    saveState();
  });

  tr.querySelector(".deleteBtn").addEventListener("click", () => {
  tr.remove();
  calculerLoot();
  saveState();
});


  return tr;
}

// Ajout ligne loot depuis clic colonne gauche
function addLootLineWithName(name) {
  const tr = addLootLine();
  tr.querySelector(".lootItem").value = name;
  updatePrice(tr.querySelector(".lootItem"));
  calculerLoot();
  saveState();
}

// =======================
// LIGNE MANUELLE (prix saisi)
// =======================
function addManualLine() {
  const tr = document.createElement("tr");
  tr.className = "lootRow manualRow";

tr.innerHTML = `
  <td><input class="lootItem" placeholder="Nom libre"></td>
  <td><input class="manualPrice" type="number" value="0" min="0" step="0.01"></td>
  <td><input class="lootQty" type="number" value="0" min="0"></td>
  <td><button class="deleteBtn" title="Supprimer">✖</button></td>
`;

  document.getElementById("lootBody").appendChild(tr);

  tr.querySelector(".manualPrice").addEventListener("input", () => {
    calculerLoot();
    saveState();
  });
  tr.querySelector(".lootQty").addEventListener("input", () => {
    calculerLoot();
    saveState();
  });
  tr.querySelector(".lootItem").addEventListener("input", () => {
    saveState();
  });

  tr.querySelector(".deleteBtn").addEventListener("click", () => {
  tr.remove();
  calculerLoot();
  saveState();
});


  return tr;
}

// =======================
// MISE À JOUR PRIX (auto depuis prices.json)
// =======================
function updatePrice(input) {
  const name = (input.value || "").trim().toLowerCase();
  const row = input.closest("tr");
  const priceCell = row.querySelector(".lootPrice");

  // Si ligne manuelle => on ne touche pas
  if (row.classList.contains("manualRow")) {
    calculerLoot();
    return;
  }

  const found = currencyMap.get(name);

  // On affiche "amount" tel quel (c'est la Value poe.ninja) + on garde l'unité en data
  if (found) {
    priceCell.textContent = Number(found.amount || 0).toFixed(2);
    priceCell.dataset.unit = found.unit || "";
  } else {
    priceCell.textContent = "0";
    priceCell.dataset.unit = "";
  }

  calculerLoot();
}

// =======================
// CALCUL TOTAL LOOT
// =======================
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

  const out = document.getElementById("totalLoot");
  if (out) out.textContent = total.toFixed(2);
}

// =======================
// LOCALSTORAGE (sauvegarde sans compte)
// =======================
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

  localStorage.setItem("poe2FarmState", JSON.stringify({ rows }));
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

    calculerLoot();
  } catch {
    // ignore
  }
}

// =======================
// EVENTS UI
// =======================
document.addEventListener("DOMContentLoaded", () => {
  // recherche colonne gauche
  const search = document.getElementById("currencySearch");
  if (search) {
    search.addEventListener("input", () => renderCurrencyPanel());
  }

  // boutons (si tu les as en onclick, ça marche aussi)
  window.addLootLine = addLootLine;
  window.addManualLine = addManualLine;
  window.loadCurrencies = loadCurrencies;

  // init
  loadCurrencies();
  loadState();

  // si aucune sauvegarde, on met une ligne par défaut
  if (!document.querySelector("#lootBody tr")) addLootLine();
});

function resetAll() {
  // efface sauvegarde
  localStorage.removeItem("poe2FarmState");

  // reset champs investissement si tu veux (optionnel)
  ["maps", "invest_tablets", "invest_omen", "invest_maps"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  // reset tableau loot
  clearLootRows();
  addLootLine();

  // reset résultats
  const totalLoot = document.getElementById("totalLoot");
  if (totalLoot) totalLoot.textContent = "0";

  const gain = document.getElementById("gain");
  if (gain) gain.textContent = "0";

  const roi = document.getElementById("roi");
  if (roi) roi.textContent = "0";

  setStatus("Fetch status: reset ✅");
}
window.resetAll = resetAll;
