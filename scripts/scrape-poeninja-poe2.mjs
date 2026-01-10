// scripts/scrape-poeninja-poe2.mjs
import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = process.env.LEAGUE || "standard";
const URL = `https://poe.ninja/poe2/economy/${LEAGUE}/currency`;
const BASE = "https://poe.ninja";

function cleanName(name) {
  return String(name || "").replace(/\s*WIKI\s*$/i, "").trim();
}

function parseCompactNumber(s) {
  if (!s) return null;
  const t = String(s).trim().toLowerCase().replace(/,/g, ".");
  const m = t.match(/^([0-9]+(\.[0-9]+)?)(k|m)?$/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[3] === "k") n *= 1000;
  if (m[3] === "m") n *= 1000000;
  return Number.isFinite(n) ? n : null;
}

function normalizeUrl(u) {
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  return u;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  console.log("Opening:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.waitForSelector("table thead th", { timeout: 60000 });
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page.waitForTimeout(4000);

  // index colonne Value
  const valueColIndex = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
  });

  console.log("Value column index =", valueColIndex);

  if (valueColIndex < 0) {
    console.error('Impossible de trouver la colonne "Value".');
    await browser.close();
    process.exit(1);
  }

  // Récup lignes avec handles (pour hover)
  const rowHandles = await page.$$("table tbody tr");
  if (!rowHandles.length) {
    console.error("Aucune ligne tr.");
    await browser.close();
    process.exit(1);
  }

  // Trouver l’icône Exalted (pour l’UI)
  let exaltIcon = "";
  for (const tr of rowHandles) {
    const txt = (await tr.innerText()).replace(/\s+/g, " ").trim().toLowerCase();
    if (txt.startsWith("exalted orb")) {
      const img = await tr.$("td img");
      if (img) {
        const src = await img.getAttribute("src");
        exaltIcon = normalizeUrl(src || "");
      }
      break;
    }
  }

  // Fonction pour lire le tooltip visible (après hover)
  async function getTooltipText() {
    return await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[role="tooltip"], .tooltip, [data-popper-placement]'));
      // on prend le dernier élément visible
      const visible = candidates.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const el = visible[visible.length - 1] || null;
      return el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
    });
  }

  const lines = [];
  const max = Math.min(rowHandles.length, 250); // limite raisonnable

  for (let i = 0; i < max; i++) {
    const tr = rowHandles[i];

    // colonnes
    const tds = await tr.$$("td");
    if (!tds.length || tds.length <= valueColIndex) continue;

    const nameRaw = ((await tds[0].innerText()) || "").replace(/\s+/g, " ").trim();
    const name = cleanName(nameRaw);
    if (!name) continue;

    // icon item
    let icon = "";
    const img0 = await tds[0].$("img");
    if (img0) icon = normalizeUrl((await img0.getAttribute("src")) || "");

    // value cell info (fallback)
    const valueText = ((await tds[valueColIndex].innerText()) || "").replace(/\s+/g, " ").trim();
    const token = valueText.split(" ").find(x => /^[0-9]/.test(x)) || null;
    const amount = parseCompactNumber(token);

    // hover pour tooltip (sur la cellule Value)
    let exaltedValue = null;
    try {
      await tds[valueColIndex].hover({ timeout: 5000 });
      await page.waitForTimeout(120);

      const tip = await getTooltipText();

      // chercher "Exalted Orb"
      // ex: "... 3.1M Chaos Orb ⇆ 1.0 Exalted Orb ..."
      const m = tip.match(/([0-9]+([.,][0-9]+)?(k|m)?)\s*Exalted\s*Orb/i);
      if (m) exaltedValue = parseCompactNumber(m[1]);

    } catch {
      exaltedValue = null;
    }

    lines.push({
      name,
      icon,
      amount: amount ?? null,
      unit: "",               // pas indispensable maintenant
      exaltedValue,           // ✅ valeur en Exalted depuis tooltip
    });
  }

  await browser.close();

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    source: URL,
    base: "Exalted Orb",
    baseIcon: exaltIcon,
    lines
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const ok = lines.filter(x => x.exaltedValue !== null).length;
  console.log(`OK -> ${lines.length} lines, exaltedValue found for ${ok}`);
})();
