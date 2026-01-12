/* ==========================================
   PoE2 Build Assistant (client-side)
   - Cloudflare proxy (CORS)
   - Parse poe2db Skill Gems + Uniques
   - Group uniques by: Weapons / Jewellery / Gear
   - Filter skill gems by archetype + theme (scored)
   ========================================== */

const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
  console.log(msg);
}

/* ---------------- Cache ---------------- */
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/* ---------------- Proxy ---------------- */
const PROXY_BASE = "https://poe2-proxy-kt.datrise13.workers.dev/?url=";
const proxify = (url) => PROXY_BASE + encodeURIComponent(url);

/* ---------------- Sources ---------------- */
const SKILLS_URL  = "https://poe2db.tw/us/Skill_Gems";
const UNIQUES_URL = "https://poe2db.tw/us/Unique_item";

const CACHE_SKILLS  = "poe2_skills_v5";
const CACHE_UNIQUES = "poe2_uniques_v5";

/* ---------------- Fetch ---------------- */
async function fetchHtml(url) {
  const res = await fetch(proxify(url));
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  return await res.text();
}

const htmlToDoc = (html) =>
  new DOMParser().parseFromString(html, "text/html");

/* ---------------- Utils ---------------- */
function dedupeByKey(arr, keyFn) {
  const map = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!k) continue;
    if (!map.has(k)) map.set(k, x);
  }
  return Array.from(map.values());
}

function esc(s) {
  return (s || "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])
  );
}

function inferWeaponFromText(s) {
  const t = (s || "").toLowerCase();
  if (t.includes("bow")) return "bow";
  if (t.includes("crossbow")) return "crossbow";
  if (t.includes("staff")) return "staff";
  if (t.includes("sword")) return "sword";
  if (t.includes("axe")) return "axe";
  if (t.includes("mace")) return "mace";
  if (t.includes("dagger")) return "dagger";
  if (t.includes("shield") || t.includes("buckler")) return "shield";
  if (t.includes("quiver")) return "quiver";
  return "unknown";
}

function getSkillWantedTags(archetype, theme) {
  const tags = [];
  if (archetype === "Bow" || archetype === "Crossbow") tags.push("Projectile");
  if (archetype === "Melee") tags.push("Melee");
  if (archetype === "Spell") tags.push("Spell");
  if (archetype === "Minion") tags.push("Minion");
  if (theme) tags.push(theme);
  return tags;
}

function scoreTags(entityTags, wantedTags) {
  const set = new Set((entityTags || []).map(t => t.toLowerCase()));
  let score = 0;
  for (const w of wantedTags) {
    if (set.has(String(w).toLowerCase())) score++;
  }
  return score;
}

/* ---------------- Parsing: Skill Gems ---------------- */
function extractTagsLine(text) {
  const m = (text || "").match(/([A-Z][A-Za-z]+(?:,\s*[A-Z][A-Za-z]+)+)/);
  return m ? m[1].split(",").map(x => x.trim()) : [];
}

function parseSkillGems(html) {
  const doc = htmlToDoc(html);
  const out = [];

  const rows = Array.from(doc.querySelectorAll("table tr"));
  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 2) continue;

    const name = (tds[1].textContent || "").trim();
    if (!name) continue;

    const tags = extractTagsLine(tr.textContent || "");
    out.push({ name, tags });
  }

  return dedupeByKey(out, x => x.name?.toLowerCase());
}

/* ---------------- Parsing: Uniques (ANCHOR-BASED, ROBUST) ----------------
   poe2db uses anchors like:
   #WeaponUnique, #ArmourUnique, etc.
   We'll:
   - find these anchors by id
   - take the DOM content between anchor A and anchor B
   - extract unique names from links inside that segment
-------------------------------------------------------------------------- */

function sectionLabelFromAnchorId(id) {
  const s = (id || "").toLowerCase();
  if (s.includes("weapon")) return "Weapons";
  if (s.includes("armour") || s.includes("armor")) return "Gear";
  if (s.includes("accessory") || s.includes("jewel") || s.includes("ring") || s.includes("amulet") || s.includes("belt"))
    return "Jewellery";
  return "Other";
}

function collectLinksUntil(startEl, stopEl) {
  const links = [];
  let cur = startEl;

  while (cur && cur !== stopEl) {
    if (cur.querySelectorAll) {
      const a = Array.from(cur.querySelectorAll("a"));
      links.push(...a);
    }
    cur = cur.nextElementSibling;
  }
  return links;
}

function isLikelyUniqueName(name) {
  if (!name) return false;
  if (name.length < 4 || name.length > 70) return false;
  if (!/^[A-Z]/.test(name)) return false;
  // filter obvious nav words
  const bad = ["home","build assistant","unique item","skill gems","login","register"];
  if (bad.includes(name.toLowerCase())) return false;
  return true;
}

function parseUniques(html) {
  const doc = htmlToDoc(html);
  const out = [];

  // Find all elements with id ending in "Unique" or containing "Unique"
  const anchors = Array.from(doc.querySelectorAll("[id]"))
    .filter(el => String(el.id).toLowerCase().includes("unique"));

  // Prefer known order if present
  const wantedIds = ["WeaponUnique", "AccessoryUnique", "ArmourUnique", "ArmorUnique", "JewelleryUnique", "JewelUnique"];
  const sorted = [];

  for (const wid of wantedIds) {
    const el = anchors.find(x => x.id === wid) || anchors.find(x => x.id.toLowerCase() === wid.toLowerCase());
    if (el) sorted.push(el);
  }

  // Also include any other unique anchors not already used
  for (const el of anchors) {
    if (!sorted.includes(el)) sorted.push(el);
  }

  // Traverse segments
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1] || null;
    const section = sectionLabelFromAnchorId(a.id);

    // if the anchor is inside a heading, use heading as start, else use element itself
    const start = a.closest("h1,h2,h3,h4") || a;

    const links = collectLinksUntil(start, b ? (b.closest("h1,h2,h3,h4") || b) : null);

    for (const link of links) {
      const name = (link.textContent || "").trim();
      if (!isLikelyUniqueName(name)) continue;

      const rowText =
        (link.closest("tr")?.textContent || "") +
        " " +
        (link.parentElement?.textContent || "");

      out.push({
        name,
        section,
        weapon: inferWeaponFromText(rowText + " " + name)
      });
    }
  }

  // If anchor parsing yields nothing (site structure changed), fallback to global link scan
  if (out.length < 10) {
    const allLinks = Array.from(doc.querySelectorAll("a"));
    for (const link of allLinks) {
      const name = (link.textContent || "").trim();
      if (!isLikelyUniqueName(name)) continue;

      const ctx = (link.closest("tr")?.textContent || "") + " " + (link.parentElement?.textContent || "");
      const weapon = inferWeaponFromText(ctx + " " + name);

      // heuristics: if it mentions a weapon keyword, put in Weapons
      const section = weapon !== "unknown" ? "Weapons" : "Other";

      out.push({ name, section, weapon });
    }
  }

  return dedupeByKey(out, x => x.name?.toLowerCase());
}

/* ---------------- Compatibility ---------------- */
function weaponCompatible(archetype, uniqueWeapon) {
  if (uniqueWeapon === "unknown") return false;

  if (archetype === "Bow") return uniqueWeapon === "bow";
  if (archetype === "Crossbow") return uniqueWeapon === "crossbow";

  if (archetype === "Melee") {
    return ["sword","axe","mace","dagger","staff"].includes(uniqueWeapon);
  }

  if (archetype === "Spell") {
    return ["staff","dagger"].includes(uniqueWeapon);
  }

  if (archetype === "Minion") return true;

  return false;
}

/* ---------------- Render ---------------- */
function renderUniquesGrouped(uniquesEl, uniques, archetype, strictCompat) {
  const order = ["Weapons", "Jewellery", "Gear", "Other"];
  const grouped = new Map(order.map(k => [k, []]));

  for (const u of uniques) {
    const k = grouped.has(u.section) ? u.section : "Other";
    grouped.get(k).push(u);
  }

  if (strictCompat) {
    grouped.set("Weapons", grouped.get("Weapons").filter(u => weaponCompatible(archetype, u.weapon)));
  }

  for (const k of order) {
    grouped.get(k).sort((a,b) => a.name.localeCompare(b.name));
  }

  let html = "";
  for (const k of order) {
    const arr = grouped.get(k);
    if (!arr || arr.length === 0) continue;

    html += `<div class="section-title">${esc(k)} <small>(${arr.length})</small></div>`;

    for (const u of arr.slice(0, 80)) {
      const meta = (k === "Weapons") ? `weapon: ${esc(u.weapon)}` : "";
      html += `
        <div class="result-item">
          <div class="result-icon"></div>
          <div>
            <div class="result-title">${esc(u.name)}</div>
            <div class="result-meta">${meta || "—"}</div>
          </div>
        </div>
      `;
    }
  }

  if (!html) html = `<div class="muted">No results</div>`;
  uniquesEl.innerHTML = html;
}

function renderSkills(skillsEl, skills, archetype, theme) {
  const wanted = getSkillWantedTags(archetype, theme);

  const scored = skills
    .map(s => ({ ...s, score: scoreTags(s.tags, wanted) }))
    .filter(s => s.score > 0)
    .sort((a,b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 60);

  let html = "";
  if (!scored.length) {
    html = `<div class="muted">No results</div>`;
  } else {
    for (const s of scored) {
      html += `
        <div class="result-item">
          <div class="result-icon"></div>
          <div>
            <div class="result-title">${esc(s.name)}</div>
            <div class="result-meta">${esc((s.tags || []).join(", "))}</div>
          </div>
        </div>
      `;
    }
  }

  skillsEl.innerHTML = html;
}

/* ---------------- Load ---------------- */
async function loadData(force=false) {
  setStatus("Loading data…");

  let skills = !force ? cacheGet(CACHE_SKILLS) : null;
  let uniques = !force ? cacheGet(CACHE_UNIQUES) : null;

  try {
    if (!skills) {
      skills = parseSkillGems(await fetchHtml(SKILLS_URL));
      cacheSet(CACHE_SKILLS, skills);
    }
    if (!uniques) {
      uniques = parseUniques(await fetchHtml(UNIQUES_URL));
      cacheSet(CACHE_UNIQUES, uniques);
    }
  } catch (e) {
    console.error(e);
    setStatus("Error loading data. Check console.");
    return null;
  }

  setStatus(`Loaded: ${uniques.length} uniques, ${skills.length} skill gems`);
  return { skills, uniques };
}

/* ---------------- Main ---------------- */
let DATA = null;

async function runSearch() {
  if (!DATA) DATA = await loadData(false);
  if (!DATA) return;

  const archetype = $("tagArchetype")?.value || "Bow";
  const theme = $("tagTheme")?.value || "Chaos";
  const strictCompat = $("strictCompat")?.checked ?? true;

  renderUniquesGrouped($("uniquesList"), DATA.uniques, archetype, strictCompat);
  renderSkills($("skillsList"), DATA.skills, archetype, theme);
}

/* ---------------- Boot ---------------- */
document.addEventListener("DOMContentLoaded", async () => {
  $("btnSearch")?.addEventListener("click", runSearch);

  $("btnRefresh")?.addEventListener("click", async () => {
    localStorage.removeItem(CACHE_SKILLS);
    localStorage.removeItem(CACHE_UNIQUES);
    DATA = await loadData(true);
    await runSearch();
  });

  DATA = await loadData(false);
});
