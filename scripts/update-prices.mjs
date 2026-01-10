import fs from "fs";

const URL = "https://poe2scout.com/economy/currency";

function clean(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function parsePriceCell(t) {
  // exemples vus sur ces pages : "302.77 ex." ou "8.7 Divine Orb"
  const s = clean(t).toLowerCase();

  // ex
  let m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*ex/);
  if (m) return { amount: Number(m[1]), unit: "ex" };

  // div
  m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*div/);
  if (m) return { amount: Number(m[1]), unit: "div" };

  // fallback
  return { amount: null, unit: null, raw: clean(t) };
}

const res = await fetch(URL, {
  headers: {
    // évite certains blocages “bot”
    "User-Agent": "Mozilla/5.0 (GitHub Actions) price-bot",
    "Accept": "text/html,*/*"
  }
});

const html = await res.text();
if (!html || html.length < 5000) {
  console.error("HTML trop petit, probablement bloqué.");
  console.error("First 500 chars:\n", html.slice(0, 500));
  process.exit(1);
}

// Scraping très simple : on récupère les lignes <tr> du tableau
// POE2Scout rend un tableau HTML (server-side), donc ça marche sans navigateur.
const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => r[1]);

const items = [];
for (const row of rows) {
  const cols = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);

  if (cols.length < 2) continue;

  const name = clean(cols[0].replace(/<[^>]+>/g, ""));
  const priceText = clean(cols[1].replace(/<[^>]+>/g, ""));

  // on ignore les entêtes / lignes vides
  if (!name || name.toLowerCase() === "item") continue;

  const price = parsePriceCell(priceText);
  if (price.amount === null) continue;

  items.push({
    name,
    price: price.amount,
    unit: price.unit
  });
}

const out = {
  updatedAt: new Date().toISOString(),
  source: URL,
  lines: items
};

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

console.log(`OK -> ${items.length} currencies écrites dans data/prices.json`);
