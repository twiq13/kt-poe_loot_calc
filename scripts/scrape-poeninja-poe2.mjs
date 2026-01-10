// scripts/scrape-poeninja-poe2.mjs
import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = (process.env.LEAGUE || "vaal").toLowerCase();
const BASE = "https://poe.ninja";
const ECONOMY_BASE = `${BASE}/poe2/economy/${LEAGUE}`;

// --- Sections UI (tabs) ---
const SECTIONS = [
  { key: "currency",       label: "Currency",        path: "currency" },
  { key: "fragments",      label: "Fragments",       path: "fragments" },
  { key: "abyssalBones",   label: "Abyssal Bones",   path: "abyssal-bones" },
  { key: "uncutGems",      label: "Uncut Gems",      path: "uncut-gems" },
  { key: "lineageGems",    label: "Lineage Gems",    path: "lineage-support-gems" },
  { key: "essences",       label: "Essences",        path: "essences" },
  { key: "soulCores",      label: "Soul Cores",      path: "soul-cores" },
  { key: "idols",          label: "Idols",           path: "idols" },
  { key: "runes",          label: "Runes",           path: "runes" },
  { key: "omens",          label: "Omens",           path: "omens" },
  { key: "expedition",     label: "Expedition",      path: "expedition" },
  { key: "liquidEmotions", label: "Liquid Emotions", path: "liquid-emotions" },
  { key: "catalyst",       label: "Catalyst",        path: "breach-catalyst" },
];

// ---------- utils ----------
function cleanName(name) {
  return String(name || "").replace(/\s*WIKI\s*$/i, "").trim();
}
function normalizeUrl(u) {
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return BASE + u;
  return u;
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
async function findValueColIndex(page) {
  return await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
  });
}

// Detect unit quickly from value cell (text + icons)
function detectUnitFromText(txt) {
  const t = (txt || "").toLowerCase();
  if (t.includes("divine")) return "Divine Orb";
  if (t.includes("chaos")) return "Chaos Orb";
  if (t.includes("exalted")) return "Exalted Orb";
  return "";
}

// ---------- scrape one section ----------
async function scrapeSection(page, sec) {
  const url = `${ECONOMY_BASE}/${sec.path}`;
  console.log(`=== Section: ${sec.label} -> ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  await page.waitForSelector("table thead th", { timeout: 20000 });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  const valueColIndex = await findValueColIndex(page);
  if (valueColIndex < 0) {
    console.log(`Skip ${sec.key}: cannot find Value column.`);
    return { url, lines: [] };
  }

  const rows = await page.$$("table tbody tr");
  const max = Math.min(rows.length, 400);

  const lines = [];
  for (let i = 0; i < max; i++) {
    const tr = rows[i];
    const tds = await tr.$$("td");
    if (!tds.length || tds.length <= valueColIndex) continue;

    // Name + item icon
    const nameRaw = ((await tds[0].innerText()) || "").replace(/\s+/g, " ").trim();
    const name = cleanName(nameRaw);
    if (!name) continue;

    let icon = "";
    const img0 = await tds[0].$("img");
    if (img0) icon = normalizeUrl((await img0.getAttribute("src")) || "");

    // Value cell: amount + unit text
    const valueText = ((await tds[valueColIndex].innerText()) || "").replace(/\s+/g, " ").trim();
    const token = valueText.split(" ").find(x => /^[0-9]/.test(x)) || null;
    const amount = parseCompactNumber(token);

    const unit = detectUnitFromText(valueText);

    // Value cell: unit icon (usually there is an <img> for currency)
    let unitIcon = "";
    const imgs = await tds[valueColIndex].$$("img");
    if (imgs?.length) {
      // often first/second img corresponds to the unit currency icon
      const src = await imgs[0].getAttribute("src");
      unitIcon = normalizeUrl(src || "");
    }

    lines.push({
      section: sec.key,
      name,
      icon,
      amount: amount ?? null,
      unit: unit || "",
      unitIcon: unitIcon || "",
      exaltedValue: null, // will be computed after
    });
  }

  console.log(`Done: ${sec.key} rows=${lines.length}`);
  return { url, lines };
}

// ---------- compute conversions ----------
function computeRatesAndExalted(allLines) {
  // We only trust rates from "currency" section
  const cur = allLines.filter(x => x.section === "currency");

  const byName = new Map(cur.map(x => [x.name.toLowerCase(), x]));

  // Base icon
  const exRow = byName.get("exalted orb");
  const divineRow = byName.get("divine orb");

  // exRow amount is usually in Chaos (meaning: 1 Exalted = X Chaos)
  let chaosPerEx = null;
  if (exRow?.unit?.toLowerCase() === "chaos orb" && exRow.amount > 0) {
    chaosPerEx = exRow.amount;
  }

  // divineRow usually in Chaos (meaning: 1 Divine = X Chaos)
  // then exPerDivine = divineChaos / chaosPerEx
  let exPerDivine = null;
  if (divineRow?.unit?.toLowerCase() === "chaos orb" && chaosPerEx && chaosPerEx > 0 && divineRow.amount > 0) {
    exPerDivine = divineRow.amount / chaosPerEx;
  }
  // if poe.ninja ever shows Divine in Ex directly:
  if (divineRow?.unit?.toLowerCase() === "exalted orb" && divineRow.amount > 0) {
    exPerDivine = divineRow.amount;
  }

  // Compute exaltedValue for every line
  for (const it of allLines) {
    const u = (it.unit || "").toLowerCase();

    if (u === "exalted orb") {
      it.exaltedValue = it.amount ?? null;
      continue;
    }

    if (u === "chaos orb" && chaosPerEx && chaosPerEx > 0) {
      it.exaltedValue = (it.amount ?? 0) / chaosPerEx;
      continue;
    }

    if (u === "divine orb" && exPerDivine && exPerDivine > 0) {
      it.exaltedValue = (it.amount ?? 0) * exPerDivine;
      continue;
    }

    it.exaltedValue = null;
  }

  return {
    chaosPerEx,
    exPerDivine,
    baseIcon: exRow?.icon || "",
    divineIcon: divineRow?.icon || "",
  };
}

// ---------- main ----------
(async () => {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });

  // Speed: block heavy types
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "font" || type === "media") return route.abort();
    route.continue();
  });

  const sectionsOut = [];
  let allLines = [];

  for (const sec of SECTIONS) {
    const r = await scrapeSection(page, sec);
    sectionsOut.push({
      key: sec.key,
      label: sec.label,
      url: r.url,
      count: r.lines.length,
    });
    allLines = allLines.concat(r.lines);
  }

  await browser.close();

  const rates = computeRatesAndExalted(allLines);

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    sourceBase: ECONOMY_BASE,
    base: "Exalted Orb",
    baseIcon: rates.baseIcon,
    divineIcon: rates.divineIcon,
    chaosPerEx: rates.chaosPerEx,     // 1 Ex = X Chaos
    divineInEx: rates.exPerDivine,    // 1 Div = X Ex
    sections: sectionsOut,
    lines: allLines,
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const total = allLines.length;
  const ok = allLines.filter(x => typeof x.exaltedValue === "number").length;

  console.log(`SAVED data/prices.json -> sections=${sectionsOut.length} items=${total} exaltedComputed=${ok}`);
  console.log(`Rates: 1 Ex = ${rates.chaosPerEx ?? "?"} Chaos | 1 Div = ${rates.exPerDivine ?? "?"} Ex`);
})();
