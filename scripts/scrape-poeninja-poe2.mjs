// scripts/scrape-poeninja-poe2.mjs
import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = (process.env.LEAGUE || "vaal").toLowerCase();
const BASE = "https://poe.ninja";

const SECTIONS = [
  { id: "currency",       label: "Currency",        slug: "currency" },
  { id: "fragments",      label: "Fragments",       slug: "fragments" },
  { id: "abyssalBones",   label: "Abyssal Bones",   slug: "abyssal-bones" },
  { id: "uncutGems",      label: "Uncut Gems",      slug: "uncut-gems" },
  { id: "lineageGems",    label: "Lineage Gems",    slug: "lineage-support-gems" },
  { id: "essences",       label: "Essences",        slug: "essences" },
  { id: "soulCores",      label: "Soul Cores",      slug: "soul-cores" },
  { id: "idols",          label: "Idols",           slug: "idols" },
  { id: "runes",          label: "Runes",           slug: "runes" },
  { id: "omens",          label: "Omens",           slug: "omens" },
  { id: "expedition",     label: "Expedition",      slug: "expedition" },
  { id: "liquidEmotions", label: "Liquid Emotions", slug: "liquid-emotions" },
  { id: "catalyst",       label: "Catalyst",        slug: "breach-catalyst" }, // as in your JSON snippet
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

async function findValueColIndex(page) {
  return await page.evaluate(() => {
    const ths = Array.from(document.querySelectorAll("table thead th"));
    return ths.findIndex(th => (th.innerText || "").trim().toLowerCase() === "value");
  });
}

async function scrapeSection(page, sec) {
  const url = `${BASE}/poe2/economy/${LEAGUE}/${sec.slug}`;
  console.log(`=== ${sec.label} -> ${url}`);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("table thead th", { timeout: 60000 });
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page.waitForTimeout(700);

  const valueColIndex = await findValueColIndex(page);
  if (valueColIndex < 0) return { url, lines: [] };

  const lines = await page.evaluate(({ valueColIndex }) => {
    const normSpace = (s) => (s || "").replace(/\s+/g, " ").trim();

    const out = [];
    const trs = Array.from(document.querySelectorAll("table tbody tr"));

    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (!tds.length || tds.length <= valueColIndex) continue;

      const name = normSpace(tds[0].innerText);
      if (!name) continue;

      const icon = tds[0].querySelector("img")?.getAttribute("src") || "";

      const vCell = tds[valueColIndex];
      const vText = normSpace(vCell.innerText);

      // amount: first numeric token
      const tok = vText.split(" ").find(x => /^[0-9]/.test(x)) || "";
      const amount = tok || "";

      // unitIcon: last image inside value cell usually is the unit currency icon
      const imgs = Array.from(vCell.querySelectorAll("img"));
      const lastImg = imgs[imgs.length - 1] || null;

      const unitIcon = lastImg?.getAttribute("src") || "";
      const unit =
        lastImg?.getAttribute("alt")
        || lastImg?.getAttribute("title")
        || lastImg?.getAttribute("aria-label")
        || "";

      out.push({ name, icon, amount, unit, unitIcon });
    }

    return out;
  }, { valueColIndex });

  // normalize + parse numbers
  const parsed = lines.map(x => ({
    section: sec.id,
    name: cleanName(x.name),
    icon: normalizeUrl(x.icon),
    amount: parseCompactNumber(x.amount),
    unit: cleanName(x.unit || ""),
    unitIcon: normalizeUrl(x.unitIcon),
    exaltedValue: null
  })).filter(x => x.name && x.amount !== null);

  console.log(`Done: ${sec.id} rows=${parsed.length}`);
  return { url, lines: parsed };
}

function computeRatesAndFillEx(lines) {
  const currency = lines.filter(x => x.section === "currency");
  const byName = new Map(currency.map(x => [x.name.toLowerCase(), x]));

  const exRow = byName.get("exalted orb");
  const divRow = byName.get("divine orb");

  const baseIcon = exRow?.icon || "";
  const divineIcon = divRow?.icon || "";

  // 1 Ex = X Chaos (must be read from Exalted Orb row)
  let exChaos = null;
  if (exRow && exRow.unit.toLowerCase() === "chaos orb" && exRow.amount > 0) {
    exChaos = exRow.amount;
  }

  // 1 Div = X Ex (from Div Chaos / exChaos)
  let divineInEx = null;
  if (divRow) {
    if (divRow.unit.toLowerCase() === "exalted orb" && divRow.amount > 0) {
      divineInEx = divRow.amount;
    } else if (divRow.unit.toLowerCase() === "chaos orb" && divRow.amount > 0 && exChaos && exChaos > 0) {
      divineInEx = divRow.amount / exChaos;
    }
  }

  // Fill exaltedValue for all lines
  for (const it of lines) {
    const u = (it.unit || "").toLowerCase();

    if (u === "exalted orb") {
      it.exaltedValue = it.amount;
    } else if (u === "chaos orb" && exChaos && exChaos > 0) {
      it.exaltedValue = it.amount / exChaos;
    } else if (u === "divine orb" && divineInEx && divineInEx > 0) {
      it.exaltedValue = it.amount * divineInEx;
    } else {
      it.exaltedValue = null;
    }
  }

  return { baseIcon, divineIcon, exChaos, divineInEx };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    viewport: { width: 1400, height: 900 },
  });

  // speed: abort heavy
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "font" || t === "media") return route.abort();
    route.continue();
  });

  let all = [];
  let currencyUrl = `${BASE}/poe2/economy/${LEAGUE}/currency`;

  for (const s of SECTIONS) {
    const r = await scrapeSection(page, s);
    if (s.id === "currency") currencyUrl = r.url;
    all = all.concat(r.lines);
  }

  await browser.close();

  const rates = computeRatesAndFillEx(all);

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    source: currencyUrl,
    base: "Exalted Orb",
    baseIcon: rates.baseIcon,
    divineIcon: rates.divineIcon,
    exChaos: rates.exChaos,         // 1 Ex = X Chaos
    divineInEx: rates.divineInEx,   // 1 Div = X Ex
    sections: SECTIONS.map(s => ({ id: s.id, label: s.label, slug: s.slug })),
    lines: all
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  const exFound = all.filter(x => typeof x.exaltedValue === "number").length;
  console.log(`OK -> sections=${SECTIONS.length} items=${all.length} exaltedValue=${exFound} exChaos=${rates.exChaos} divineInEx=${rates.divineInEx}`);
})();
