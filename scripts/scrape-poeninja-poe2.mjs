import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = (process.env.LEAGUE || "standard").toLowerCase();
const BASE = "https://poe.ninja";

const SECTIONS = [
  { key: "currency",        slugs: ["currency"] },
  { key: "fragments",       slugs: ["fragments"] },
  { key: "abyssalBones",    slugs: ["abyssal-bones", "abyssalbones"] },
  { key: "uncutGems",       slugs: ["uncut-gems", "uncutgems"] },
  { key: "lineageGems",     slugs: ["lineage-gems", "lineagegems"] },
  { key: "essences",        slugs: ["essences"] },
  { key: "soulCores",       slugs: ["soul-cores", "soulcores"] },
  { key: "idols",           slugs: ["idols"] },
  { key: "runes",           slugs: ["runes"] },
  { key: "omens",           slugs: ["omens"] },
  { key: "expedition",      slugs: ["expedition"] },
  { key: "liquidEmotions",  slugs: ["liquid-emotions", "liquidemotions"] },
  { key: "catalyst",        slugs: ["catalyst", "catalysts"] },
];

// ---------------- utils ----------------
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

async function safeGoto(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const status = res?.status?.() ?? 0;
    if (status >= 400) return { ok: false, status };
    return { ok: true, status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Read visible amount + unit + unitIcon from the Value cell
async function extractValueCell(td) {
  return await td.evaluate(el => {
    // Grab visible text
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();

    // amount = first token starting with digit
    const tokens = txt.split(" ");
    const amountText = tokens.find(t => /^[0-9]/.test(t)) || "";

    // unit icon: often last img in the cell
    const imgs = Array.from(el.querySelectorAll("img"));
    const last = imgs[imgs.length - 1] || null;

    const unit =
      (last?.getAttribute("aria-label")
        || last?.getAttribute("alt")
        || last?.getAttribute("title")
        || "")?.trim();

    const unitIcon = last?.getAttribute("src") || "";

    return { amountText, unit, unitIcon };
  });
}

// Tooltip text (best effort)
async function getTooltipText(page) {
  return await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('[role="tooltip"], .tooltip, [data-popper-placement]')
    );
    const visible = candidates.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const el = visible[visible.length - 1] || null;
    return el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
}

// Parse "X Exalted Orb" from tooltip (we accept ANY number, even < 1)
function parseExaltedFromTooltip(tip) {
  if (!tip) return null;
  const m = tip.match(/([0-9]+([.,][0-9]+)?(k|m)?)\s*Exalted\s*Orb/i);
  if (!m) return null;
  return parseCompactNumber(m[1]);
}

// ---------------- scrape one section ----------------
async function scrapeSection(page, sectionKey, url) {
  console.log(`\n[${sectionKey}] Opening: ${url}`);

  const nav = await safeGoto(page, url);
  if (!nav.ok) {
    console.log(`[${sectionKey}] SKIP (HTTP ${nav.status})`);
    return { ok: false, lines: [], baseIcon: "" };
  }

  try {
    await page.waitForSelector("table thead th", { timeout: 60000 });
    await page.waitForSelector("table tbody tr", { timeout: 60000 });
    await page.waitForTimeout(2000);
  } catch {
    console.log(`[${sectionKey}] SKIP (table not found)`);
    return { ok: false, lines: [], baseIcon: "" };
  }

  // Find "Value" column index
  const valueColIndex = await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
  });

  if (valueColIndex < 0) {
    console.log(`[${sectionKey}] SKIP (Value column not found)`);
    return { ok: false, lines: [], baseIcon: "" };
  }

  const rowHandles = await page.$$("table tbody tr");
  if (!rowHandles.length) {
    console.log(`[${sectionKey}] SKIP (no rows)`);
    return { ok: false, lines: [], baseIcon: "" };
  }

  // Try to grab Exalted icon from this page (best effort, currency page usually)
  let exaltIcon = "";
  for (const tr of rowHandles.slice(0, 80)) {
    const txt = (await tr.innerText()).replace(/\s+/g, " ").trim().toLowerCase();
    if (txt.startsWith("exalted orb") || txt.startsWith("perfect exalted orb")) {
      const img = await tr.$("td img");
      if (img) exaltIcon = normalizeUrl((await img.getAttribute("src")) || "");
      break;
    }
  }

  const lines = [];
  const max = Math.min(rowHandles.length, 350);

  for (let i = 0; i < max; i++) {
    const tr = rowHandles[i];
    const tds = await tr.$$("td");
    if (!tds.length || tds.length <= valueColIndex) continue;

    const nameRaw = ((await tds[0].innerText()) || "").replace(/\s+/g, " ").trim();
    const name = cleanName(nameRaw);
    if (!name) continue;

    // item icon
    let icon = "";
    const img0 = await tds[0].$("img");
    if (img0) icon = normalizeUrl((await img0.getAttribute("src")) || "");

    // amount/unit/unitIcon from Value cell
    const { amountText, unit, unitIcon } = await extractValueCell(tds[valueColIndex]);
    const amount = parseCompactNumber(amountText);

    // store raw line (we'll compute exaltedValue later)
    lines.push({
      section: sectionKey,
      name,
      icon,
      amount: amount ?? null,
      unit: cleanName(unit || ""),
      unitIcon: normalizeUrl(unitIcon || ""),
      exaltedValue: null
    });
  }

  console.log(`[${sectionKey}] OK -> ${lines.length} lines`);
  return { ok: true, lines, baseIcon: exaltIcon };
}

// ---------------- main ----------------
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  const outSections = {};
  let baseIcon = "";

  // scrape all sections
  for (const sec of SECTIONS) {
    let done = false;

    for (const slug of sec.slugs) {
      const url = `${BASE}/poe2/economy/${LEAGUE}/${slug}`;
      const res = await scrapeSection(page, sec.key, url);

      if (res.ok && res.lines.length) {
        outSections[sec.key] = res.lines;
        if (!baseIcon && res.baseIcon) baseIcon = res.baseIcon;
        done = true;
        break;
      }
    }

    if (!done) outSections[sec.key] = [];
  }

  // Flatten
  const allLines = Object.values(outSections).flat();

  // ---------------- compute rates from Currency page ----------------
  // We need:
  // - divineChaos: Divine Orb expressed in Chaos
  // - divineInEx: Divine Orb expressed in Exalted (from tooltip)
  // Then:
  // - exChaos = divineChaos / divineInEx
  let divineChaos = null;
  let divineInEx = null;
  let exChaos = null;

  // find Divine row in scraped currency lines
  const divineRow = (outSections.currency || []).find(
    x => (x.name || "").toLowerCase() === "divine orb"
  );

  // divineChaos from visible value
  if (divineRow && divineRow.amount && divineRow.unit.toLowerCase() === "chaos orb") {
    divineChaos = divineRow.amount;
  }

  // divineInEx from tooltip (visit currency page and hover Divine value)
  const currencyUrl = `${BASE}/poe2/economy/${LEAGUE}/currency`;
  const nav = await safeGoto(page, currencyUrl);

  if (nav.ok) {
    try {
      await page.waitForSelector("table tbody tr", { timeout: 60000 });
      await page.waitForTimeout(2000);

      // find row that starts with "Divine Orb"
      const rows = await page.$$("table tbody tr");
      for (const tr of rows.slice(0, 200)) {
        const txt = (await tr.innerText()).replace(/\s+/g, " ").trim().toLowerCase();
        if (txt.startsWith("divine orb")) {
          const tds = await tr.$$("td");
          // find value column index on this page
          const valueColIndex = await page.evaluate(() => {
            const ths = Array.from(document.querySelectorAll("table thead th"));
            return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
          });

          if (valueColIndex >= 0 && tds[valueColIndex]) {
            // hover on last img in value cell if exists
            const imgs = await tds[valueColIndex].$$("img");
            if (imgs.length) await imgs[imgs.length - 1].hover({ timeout: 5000 });
            else await tds[valueColIndex].hover({ timeout: 5000 });

            await page.waitForTimeout(140);
            const tip = await getTooltipText(page);
            divineInEx = parseExaltedFromTooltip(tip);
          }
          break;
        }
      }
    } catch {}
  }

  if (divineChaos && divineInEx && divineInEx > 0) {
    exChaos = divineChaos / divineInEx;
  }

  // ---------------- fill exaltedValue for ALL lines ----------------
  // Rules:
  // - if unit Chaos: exaltedValue = amount / exChaos
  // - if unit Divine: exaltedValue = amount * divineInEx
  // - if unit Exalted: exaltedValue = amount
  // - if name is Exalted Orb: exaltedValue = 1
  // - if name is Divine Orb: exaltedValue = divineInEx (if known)
  for (const l of allLines) {
    const nameL = (l.name || "").toLowerCase();
    const unitL = (l.unit || "").toLowerCase();
    const amt = Number(l.amount ?? 0);

    if (nameL === "exalted orb" || nameL === "perfect exalted orb") {
      l.exaltedValue = 1;
      continue;
    }

    if (nameL === "divine orb" && divineInEx && divineInEx > 0) {
      l.exaltedValue = divineInEx;
      continue;
    }

    if (!amt || amt <= 0) {
      l.exaltedValue = null;
      continue;
    }

    if (unitL === "exalted orb") {
      l.exaltedValue = amt;
      continue;
    }

    if (unitL === "divine orb") {
      l.exaltedValue = (divineInEx && divineInEx > 0) ? (amt * divineInEx) : null;
      continue;
    }

    if (unitL === "chaos orb") {
      l.exaltedValue = (exChaos && exChaos > 0) ? (amt / exChaos) : null;
      continue;
    }

    l.exaltedValue = null;
  }

  await browser.close();

  // output
  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    sourceBase: `${BASE}/poe2/economy/${LEAGUE}/`,
    base: "Exalted Orb",
    baseIcon,
    rates: {
      divineChaos: divineChaos ?? null,
      divineInEx: divineInEx ?? null,
      exChaos: exChaos ?? null
    },
    sections: outSections,
    lines: allLines
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const countEx = allLines.filter(x => x.exaltedValue !== null).length;
  console.log(`\nDONE ✅ sections=${Object.keys(outSections).length} totalLines=${allLines.length} exaltedValueFilled=${countEx}`);
  console.log(`RATES ✅ divineChaos=${out.rates.divineChaos} | divineInEx=${out.rates.divineInEx} | exChaos=${out.rates.exChaos}`);
})();
