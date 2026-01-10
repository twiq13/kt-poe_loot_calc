import fs from "fs";

const LEAGUE = "vaal"; // change à "standard" si besoin
const URL = `https://poe.ninja/poe2/economy/${LEAGUE}/currency`;

function findNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

function deepFindCurrencies(obj) {
  // On cherche un tableau d'objets qui ressemble à une liste de currencies
  // heuristique: objets avec name + price en exalt/divine ou équivalent
  const stack = [obj];
  let best = null;

  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;

    if (Array.isArray(cur)) {
      // candidat ?
      if (cur.length > 5 && typeof cur[0] === "object") {
        const sample = cur.slice(0, 10);
        const score = sample.reduce((s, it) => {
          if (!it || typeof it !== "object") return s;
          const keys = Object.keys(it);
          const hasName = keys.some(k => /name|currency/i.test(k));
          const hasPrice = keys.some(k => /exalt|divine|price|value|ratio/i.test(k));
          return s + (hasName ? 1 : 0) + (hasPrice ? 1 : 0);
        }, 0);
        if (score >= 12) best = cur; // bon signal
      }

      for (const v of cur) stack.push(v);
    } else if (typeof cur === "object") {
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
  }

  return best;
}

function normalize(lines) {
  // On fabrique un format stable: { name, exaltPrice, divinePrice } si trouvable
  return lines.map(it => {
    const name =
      it.currencyTypeName ||
      it.name ||
      it.itemName ||
      it.displayName ||
      it.currency ||
      it.type ||
      null;

    // On tente plusieurs champs possibles
    const exaltPrice =
      it.exaltedValue ??
      it.exalted ??
      it.exaltValue ??
      it.exalt ??
      it.ex ??
      null;

    const divinePrice =
      it.divineValue ??
      it.divine ??
      it.divineOrbValue ??
      null;

    // Sinon, on garde un "raw" utile
    return {
      name,
      exaltPrice,
      divinePrice,
      raw: it
    };
  }).filter(x => x.name);
}

const res = await fetch(URL, {
  headers: {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,*/*"
  }
});

const html = await res.text();

const nextDataText = findNextData(html);
if (!nextDataText) {
  console.error("Impossible de trouver __NEXT_DATA__ dans la page.");
  console.error("Premiers 500 chars:\n", html.slice(0, 500));
  process.exit(1);
}

let nextData;
try {
  nextData = JSON.parse(nextDataText);
} catch (e) {
  console.error("JSON.parse(__NEXT_DATA__) a échoué");
  process.exit(1);
}

const candidates = deepFindCurrencies(nextData);
if (!candidates) {
  console.error("Aucune liste de currencies détectée dans __NEXT_DATA__.");
  process.exit(1);
}

const lines = normalize(candidates);

if (!lines.length) {
  console.error("Liste currencies trouvée mais vide après normalisation.");
  process.exit(1);
}

const out = {
  updatedAt: new Date().toISOString(),
  source: URL,
  league: LEAGUE,
  lines
};

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/prices.json", JSON.stringify(out, null, 2), "utf8");

console.log(`OK -> ${lines.length} currencies écrites dans data/prices.json`);
