import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = (process.env.LEAGUE || "vaal").toLowerCase();
const BASE = "https://poe.ninja";

const SECTIONS = [
  { id: "currency",       label: "Currency",         slug: "currency" },
  { id: "fragments",      label: "Fragments",        slug: "fragments" },
  { id: "abyssalBones",   label: "Abyssal Bones",    slug: "abyssal-bones" },
  { id: "uncutGems",      label: "Uncut Gems",       slug: "uncut-gems" },
  { id: "lineageGems",    label: "Lineage Gems",     slug: "lineage-support-gems" },
  { id: "essences",       label: "Essences",         slug: "essences" },
  { id: "soulCores",      label: "Soul Cores",       slug: "soul-cores" },
  { id: "idols",          label: "Idols",            slug: "idols" },
  { id: "runes",          label: "Runes",            slug: "runes" },
  { id: "omens",          label: "Omens",            slug: "omens" },
  { id: "expedition",     label: "Expedition",       slug: "expedition" },
  { id: "liquidEmotions", label: "Liquid Emotions",  slug: "liquid-emotions" },
  { id: "catalyst",       label: "Catalyst",         slug: "breach-catalyst" },
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

async function getValueColumnIndex(page) {
  return await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
  });
}

async function divineTokenFromTable(page) {
  return await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    const row = rows.find(r => (r.innerText || "").toLowerCase().includes("divine orb"));
    if (!row) return null;

    const ths = Array.from(document.querySelectorAll("table thead th"));
    const idx = ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
    if (idx < 0) return null;

    const tds = Array.from(row.querySelectorAll("td"));
    const cell = tds[idx];
    if (!cell) return null;

    const txt = (cell.innerText || "").replace(/\s+/g, " ").trim();
    const token = txt.split(" ").find(x => /^[0-9]/.test(x));
    return token || null;
  });
}

/**
 * ✅ Force Value Display -> Exalted Orb (robust)
 * - Find "Value Display" label
 * - Find next combobox/listbox/button used by react-select
 * - Click
 * - Focus internal input + type + Enter
 */
async function forceValueDisplayExalted(page, { verifyOnCurrency = false } = {}) {
  const desired = "Exalted Orb";

  for (let attempt = 1; attempt <= 6; attempt++) {
    // Scroll top to ensure controls visible
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // Locate the "Value Display" text node
    const label = page.locator("text=Value Display").first();
    await label.waitFor({ timeout: 10000 });

    // Grab the nearest interactive select after the label (ARIA roles)
    // We try multiple patterns because poe.ninja UI can change:
    const combo = page.locator(
      `xpath=//div[contains(.,'Value Display')][1]/following::*[@role='combobox' or @aria-haspopup='listbox' or self::button][1]`
    ).first();

    // Ensure it is in view + click
    await combo.scrollIntoViewIfNeeded().catch(() => {});
    await combo.click({ timeout: 5000 }).catch(() => {});

    // React-select usually spawns an input somewhere (often in the dropdown)
    // Try to focus any visible input with aria-autocomplete
    const input = page.locator("input[aria-autocomplete='list']").first();
    if (await input.count().catch(() => 0)) {
      await input.fill("").catch(() => {});
      await input.type(desired, { delay: 25 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    } else {
      // Fallback: just type globally (works if menu captured focus)
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.type(desired, { delay: 25 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
    }

    // Wait for table to update
    await page.waitForTimeout(900);

    // Verify only on Currency section (Divine must be > 100 Ex typically)
    if (verifyOnCurrency) {
      const tok = await divineTokenFromTable(page);
      const val = parseCompactNumber(tok);
      if (val && val > 100) {
        console.log(`Value Display OK ✅ (Divine ~ ${val} Ex)`);
        return true;
      }
      console.log(`Value Display retry ${attempt}/6 (Divine token="${tok}" parsed=${val})`);
    } else {
      // If no verification needed, we assume ok
      return true;
    }
  }

  console.log("⚠️ Could not force Value Display to Exalted.");
  return false;
}

async function getBaseExaltedIconFromValueCell(page, valueColIndex) {
  try {
    const src = await page.evaluate((idx) => {
      const tr = document.querySelector("table tbody tr");
      if (!tr) return "";
      const td = tr.querySelectorAll("td")[idx];
      if (!td) return "";
      const imgs = td.querySelectorAll("img");
      const last = imgs[imgs.length - 1];
      return last ? (last.getAttribute("src") || "") : "";
    }, valueColIndex);
    return normalizeUrl(src);
  } catch {
    return "";
  }
}

async function scrapeSection(page, section) {
  const url = `https://poe.ninja/poe2/economy/${LEAGUE}/${section.slug}`;
  console.log(`=== Section: ${section.label} -> ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("table thead th", { timeout: 60000 });
  await page.waitForSelector("table tbody tr", { timeout: 60000 });

  // Force Exalted display (verify only for currency)
  await forceValueDisplayExalted(page, { verifyOnCurrency: section.id === "currency" });

  const valueColIndex = await getValueColumnIndex(page);
  if (valueColIndex < 0) throw new Error(`Value column not found in section ${section.id}`);

  const baseIcon = await getBaseExaltedIconFromValueCell(page, valueColIndex);

  const rows = await page.$$("table tbody tr");
  const max = Math.min(rows.length, 450);

  const lines = [];
  for (let i = 0; i < max; i++) {
    const tr = rows[i];
    const tds = await tr.$$("td");
    if (!tds.length || tds.length <= valueColIndex) continue;

    const nameRaw = ((await tds[0].innerText()) || "").replace(/\s+/g, " ").trim();
    const name = cleanName(nameRaw);
    if (!name) continue;

    let icon = "";
    const img0 = await tds[0].$("img");
    if (img0) icon = normalizeUrl((await img0.getAttribute("src")) || "");

    const valueText = ((await tds[valueColIndex].innerText()) || "").replace(/\s+/g, " ").trim();
    const token = valueText.split(" ").find(x => /^[0-9]/.test(x)) || null;
    const exVal = parseCompactNumber(token);

    if (exVal === null) continue;

    lines.push({
      section: section.id,
      name,
      icon,
      amount: exVal,
      unit: "Exalted Orb",
      unitIcon: baseIcon,
      exaltedValue: exVal,
    });
  }

  console.log(`Done: rows=${rows.length} kept=${lines.length}`);
  return { lines, baseIcon };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  let allLines = [];
  let globalBaseIcon = "";

  try {
    for (const section of SECTIONS) {
      const { lines, baseIcon } = await scrapeSection(page, section);
      allLines.push(...lines);
      if (!globalBaseIcon && baseIcon) globalBaseIcon = baseIcon;
    }
  } finally {
    await browser.close();
  }

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    sourceBase: `https://poe.ninja/poe2/economy/${LEAGUE}/`,
    base: "Exalted Orb",
    baseIcon: globalBaseIcon,
    sections: SECTIONS.map(s => ({ id: s.id, label: s.label, slug: s.slug })),
    lines: allLines
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const divine = allLines.find(x => x.section === "currency" && x.name.toLowerCase() === "divine orb");
  console.log(`TOTAL lines=${allLines.length}`);
  console.log(`Divine Orb exaltedValue = ${divine?.exaltedValue ?? "NOT FOUND"}`);
})();
