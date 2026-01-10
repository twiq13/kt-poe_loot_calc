import fs from "fs";
import { chromium } from "playwright";

const LEAGUE = process.env.LEAGUE || "standard";
const URL = `https://poe.ninja/poe2/economy/${LEAGUE}/currency`;

function firstNumber(str) {
  if (!str) return null;
  const m = String(str).replace(",", ".").match(/[0-9]+(\.[0-9]+)?/);
  return m ? Number(m[0]) : null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  });

  console.log("Opening:", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Attendre que le tableau se charge (SPA)
  await page.waitForSelector("table", { timeout: 60000 });
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll("table tbody tr"));
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td"));
      const name = (tds[0]?.innerText || "").trim();
      const rowText = (tr.innerText || "").replace(/\s+/g, " ").trim();
      return { name, rowText };
    }).filter(x => x.name);
  });

  await browser.close();

  if (!rows.length) {
    console.error("Aucune ligne trouvée dans le tableau.");
    process.exit(1);
  }

  // Exemple de parsing : on cherche "x Divine" et "y Exalted"
  const parsed = rows.map(r => {
    const divineMatch = r.rowText.match(/([0-9]+([.,][0-9]+)?)\s*Divine/i);
    const exaltMatch  = r.rowText.match(/([0-9]+([.,][0-9]+)?)\s*Exalted/i);

    return {
      name: r.name,
      divinePrice: firstNumber(divineMatch?.[1]),
      exaltPrice: firstNumber(exaltMatch?.[1]),
    };
  }).filter(x => x.divinePrice !== null || x.exaltPrice !== null);

  if (!parsed.length) {
    console.error("Lignes trouvées mais aucun prix parsé.");
    console.error("Exemple rowText:", rows[0]?.rowText);
    process.exit(1);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    league: LEAGUE,
    source: URL,
    lines: parsed
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

  console.log(`OK -> ${parsed.length} currencies écrites dans data/prices.json`);
})();
