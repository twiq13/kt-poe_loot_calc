// scripts/scrape-poeninja-poe2.mjs
// PoE2 poe.ninja scraper (Playwright) -> data/prices.json
// - Scrape multiple sections (tabs) you prepared
// - For each row: name, icon, amount+unit (display like site), exaltedValue (from hover tooltip conversions when possible)
// - Also outputs baseIcon (Exalted Orb icon) + divineInEx (1 Divine = X Ex) when found

import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = (process.env.LEAGUE || "standard").toLowerCase();

const BASE = "https://poe.ninja";
const ECONOMY_BASE = `${BASE}/poe2/economy/${LEAGUE}`;

// Sections you asked (UI tabs)
// NOTE: poe.ninja paths can evolve; these are the most common "economy" endpoints style.
// If one 404s, the scraper will log and continue.
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

// Extract "amount + unit" from the Value cell text as shown on site (fallback)
// Example rowText: "Mirror of Kalandra WIKI 2.5k 1.0 0% 4.7k 2.5k 1.0"
// In many cases the Value cell contains "2.5k" and then an icon (unit implied).
async function getValueCellText(td) {
  const raw = (await td.innerText()).replace(/\s+/g, " ").trim();
  return raw;
}

// Find index of column named "Value" (case-insensitive)
async function findValueColIndex(page) {
  return await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    const idx = ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
    return idx;
  });
}

// Robust tooltip reader: wait for conversion tooltip that contains "⇆" and "Orb"
async function readConversionTooltip(page) {
  // Wait for any visible element that looks like conversion tooltip
  await page.waitForFunction(() => {
    const els = Array.from(document.querySelectorAll("body *"));
    const visible = els.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return false;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
      const t = (el.textContent || "").trim();
      return t.includes("⇆") && t.toLowerCase().includes("orb");
    });
    return visible.length > 0;
  }, { timeout: 2000 });

  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("body *"));
    const visible = els.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return false;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
      const t = (el.textContent || "").trim();
      return t.includes("⇆") && t.toLowerCase().includes("orb");
    });
    const el = visible[visible.length - 1];
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
  });
}

// Parse tooltip -> get "X Exalted Orb" (or Perfect Exalted Orb)
function parseExaltedFromTooltip(tip) {
  if (!tip) return null;
  const m = tip.match(/([0-9]+([.,][0-9]+)?(k|m)?)\s*(Perfect\s*)?Exalted\s*Orb/i);
  if (!m) return null;
  return parseCompactNumber(m[1]);
}

// Parse tooltip -> get "X Divine Orb"
function parseDivineFromTooltip(tip) {
  if (!tip) return null;
  const m = tip.match(/([0-9]+([.,][0-9]+)?(k|m)?)\s*Divine\s*Orb/i);
  if (!m) return null;
  return parseCompactNumber(m[1]);
}

// Try to hover correct target inside a Value cell (often icon)
async function hoverValueCell(page, td) {
  const hoverTarget =
    (await td.$("img")) ||
    (await td.$("svg")) ||
    (await td.$("span")) ||
    td;

  await hoverTarget.hover({ timeout: 5000 });
  await page.waitForTimeout(120);
}

async function scrapeSection(page, section) {
  const url = `${ECONOMY_BASE}/${section.path}`;
  console.log(`\n=== Section: ${section.label} -> ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    console.log(`Skip (goto failed): ${section.key} -> ${String(e)}`);
    return { section, url, lines: [], ok: 0, skipped: 0 };
  }

  // some pages might not have a table
  try {
    await page.waitForSelector("table thead th", { timeout: 15000 });
    await page.waitForSelector("table tbody tr", { timeout: 15000 });
  } catch {
    console.log(`Skip (no table): ${section.key}`);
    return { section, url, lines: [], ok: 0, skipped: 0 };
  }

  await page.waitForTimeout(1200);

  const valueColIndex = await findValueColIndex(page);
  if (valueColIndex < 0) {
    console.log(`Skip (no Value column): ${section.key}`);
    return { section, url, lines: [], ok: 0, skipped: 0 };
  }

  const rowHandles = await page.$$("table tbody tr");
  if (!rowHandles.length) {
    console.log(`Skip (no rows): ${section.key}`);
    return { section, url, lines: [], ok: 0, skipped: 0 };
  }

  let ok = 0;
  let skipped = 0;
  const lines = [];

  // cap per section (avoid huge)
  const max = Math.min(rowHandles.length, 350);

  for (let i = 0; i < max; i++) {
    const tr = rowHandles[i];
    const tds = await tr.$$("td");
    if (!tds.length || tds.length <= valueColIndex) { skipped++; continue; }

    // Name cell is usually td[0]
    const nameRaw = ((await tds[0].innerText()) || "").replace(/\s+/g, " ").trim();
    const name = cleanName(nameRaw);
    if (!name) { skipped++; continue; }

    // Item icon (left)
    let icon = "";
    const img0 = await tds[0].$("img");
    if (img0) icon = normalizeUrl((await img0.getAttribute("src")) || "");

    // Value cell fallback text (amount is usually a first numeric token)
    const valueText = await getValueCellText(tds[valueColIndex]);
    const token = valueText.split(" ").find(x => /^[0-9]/.test(x)) || null;
    const amount = parseCompactNumber(token);

    // Tooltip conversion -> exaltedValue
    let exaltedValue = null;
    let tooltipText = "";

    try {
      await hoverValueCell(page, tds[valueColIndex]);
      tooltipText = await readConversionTooltip(page);
      exaltedValue = parseExaltedFromTooltip(tooltipText);
    } catch {
      exaltedValue = null;
    }

    if (exaltedValue !== null) ok++;

    // "unit" from tooltip: if tooltip contains "Divine Orb" or "Chaos Orb" etc
    // We keep it for LEFT list display. Priority: Divine / Chaos / Exalted.
    let unit = "";
    if (tooltipText) {
      if (/Divine\s*Orb/i.test(tooltipText)) unit = "Divine Orb";
      else if (/Chaos\s*Orb/i.test(tooltipText)) unit = "Chaos Orb";
      else if (/(Perfect\s*)?Exalted\s*Orb/i.test(tooltipText)) unit = "Exalted Orb";
    }

    lines.push({
      section: section.key,
      name,
      icon,
      amount: amount ?? null,
      unit,
      exaltedValue, // Ex value from tooltip (best)
      tooltip: tooltipText || "" // helpful debug, can remove later
    });
  }

  console.log(`Done: rows=${lines.length} exaltedFound=${ok} skipped=${skipped}`);
  return { section, url, lines, ok, skipped };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });

  // block heavy stuff (faster / more stable)
  await page.route("**/*", (route) => {
    const req = route.request();
    const type = req.resourceType();
    if (type === "font" || type === "media") return route.abort();
    return route.continue();
  });

  // Scrape all sections
  const allSections = [];
  let allLines = [];

  let baseIcon = "";
  let divineInEx = null;
  let divineIcon = "";

  for (const s of SECTIONS) {
    const result = await scrapeSection(page, s);
    allSections.push({
      key: s.key,
      label: s.label,
      url: result.url,
      count: result.lines.length,
    });
    allLines = allLines.concat(result.lines);
  }

  // Determine Exalted icon + Divine icon + DivineInEx from currency section if possible
  const currencyLines = allLines.filter(x => x.section === "currency");

  // Exalted icon: from "Exalted Orb" row
  const exRow = currencyLines.find(x => x.name.toLowerCase() === "exalted orb");
  if (exRow?.icon) baseIcon = exRow.icon;

  const divRow = currencyLines.find(x => x.name.toLowerCase() === "divine orb");
  if (divRow?.icon) divineIcon = divRow.icon;

  // divineInEx:
  // best: if divRow has exaltedValue parsed -> that is already in Ex
  if (divRow?.exaltedValue && divRow.exaltedValue > 0) {
    divineInEx = divRow.exaltedValue;
  } else {
    // fallback: if tooltip present, try parse "X Exalted Orb" specifically when hovering divine row might fail
    // Keep null if not found
    divineInEx = null;
  }

  await browser.close();

  // Clean output:
  // - remove tooltip text to keep file light (you can keep it if you want)
  const linesOut = allLines.map(x => ({
    section: x.section,
    name: x.name,
    icon: x.icon,
    amount: x.amount,
    unit: x.unit,
    exaltedValue: x.exaltedValue
  }));

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    sourceBase: ECONOMY_BASE,
    sections: allSections,
    base: "Exalted Orb",
    baseIcon: baseIcon || "",
    divineIcon: divineIcon || "",
    divineInEx: divineInEx,
    lines: linesOut
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const total = linesOut.length;
  const ok = linesOut.filter(x => x.exaltedValue !== null && x.exaltedValue !== undefined).length;
  console.log(`\nSAVED data/prices.json -> lines=${total} exaltedValueFound=${ok} sections=${allSections.length}`);
})();
