/* ==========================================
   PoE2 Build Assistant (client-side)
   - Fetch + cache poe2db pages
   - Parse tags
   - Filter + compatibility rules
   ========================================== */

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
  console.log(msg);
}

// ---- Cache helpers (localStorage) ----
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function cacheSet(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- Config ----
// If CORS blocks poe2db, set PROXY_BASE to your proxy endpoint, e.g.
// const PROXY_BASE = "https://your-worker.example.com/?url=";
const PROXY_BASE = ""; // empty = direct fetch

function proxify(url) {
  return PROXY_BASE ? (PROXY_BASE + encodeURIComponent(url)) : url;
}

// Pages we scrape (can evolve)
// Skill gems page shows tags in list. :contentReference[oaicite:2]{index=2}
const SKILLS_URL = "https://poe2db.tw/us/Skill_Gems";
// Unique items listing page (long, but structured). :contentReference[oaicite:3]{index=3}
const UNIQUES_URL = "https://poe2db.tw/us/Unique_item";

// cache keys
const CACHE_SKILLS = "poe2_skills_v1";
const CACHE_UNIQUES = "poe2_uniques_v1";

// ---- Fetch HTML safely ----
async function fetchHtml(url) {
  const res = await fetch(proxify(url), {
    headers: {
      // polite UA hint (some sites appreciate it)
      "Accept": "text/html"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function htmlToDoc(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

// ---- Parsing ----
// Skill gems page has rows with: Name + tags line under it (based on visible listing). :contentReference[oaicite:4]{index=4}
function parseSkillGems(html) {
  const doc = htmlToDoc(html);

  // Heuristic: each gem entry is typically in a table row or list block.
  // We'll extract: name + tags by scanning for image alt/title and nearby text that looks like "Attack, AoE, ..."
  const text = doc.body.innerText;

  // Fallback quick parse: find lines with "Image" entries and next line with tags pattern.
  // More robust method: use DOM traversal. We'll do a DOM-based approach:
  const results = [];
  const rows = Array.from(doc.querySelectorAll("table tr"));

  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (!tds || tds.length < 2) continue;

    const name = (tds[1].textContent || "").trim();
    if (!name) continue;

    // Tags often appear in another cell/line; try to read all text from row
    const rowText = tr.textContent || "";
    const tags = extractTagsFromText(rowText);

    results.push({ name, tags });
  }

  // If table parsing failed, do a more generic scan: blocks with commas and tag-like words
  if (results.length < 10) {
    // Very simple: search for patterns ")\n\nTag, Tag, Tag"
    // but keep it minimal to avoid junk.
    // In practice, you'll refine once you see the real DOM of the page.
  }

  return dedupeByName(results);
}

// Uniques: page is categorized (Weapon Unique /.. etc) and each entry includes the item name and base.
// We extract name + inferred slot/type from nearby text and tags if present (some pages show craft tags elsewhere). :contentReference[oaicite:5]{index=5}
function parseUniques(html) {
  const doc = htmlToDoc(html);

  const results = [];
  // Many PoE2DB pages list items in tables.
  const rows = Array.from(doc.querySelectorAll("table tr"));

  for (const tr of rows) {
    const tds = tr.querySelectorAll("td");
    if (!tds || tds.length < 2) continue;

    const name = (tds[1].textContent || "").trim();
    if (!name) continue;

    const rowText = (tr.textContent || "").trim();
    const tags = extractTagsFromText(rowText);

    // Infer gear category from text (rough but useful)
    const gear = inferGearFromText(rowText);

    results.push({ name, tags, gear });
  }

  return dedupeByName(results);
}

// ---- Utilities ----
function dedupeByName(arr) {
  const map = new Map();
  for (const x of arr) {
    const k = (x.name || "").toLowerCase();
    if (!k) continue;
    if (!map.has(k)) map.set(k, x);
  }
  return Array.from(map.values());
}

function extractTagsFromText(s) {
  // tags appear like "Attack, AoE, Melee, Slam" on poe2db lists :contentReference[oaicite:6]{index=6}
  const m = s.match(/([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)*)\s*,\s*([A-Z][A-Za-z].+)/);
  if (!m) return [];
  // split by commas, trim, keep reasonable tokens
  return m[0].split(",").map(t => t.trim()).filter(t => t.length >= 3 && t.length <= 20);
}

function inferGearFromText(s) {
  const lower = s.toLowerCase();
  if (lower.includes("bow")) return { slot: "mainhand", weapon: "bow" };
  if (lower.includes("crossbow")) return { slot: "mainhand", weapon: "crossbow" };
  if (lower.includes("quarterstaff") || lower.includes("staff")) return { slot: "mainhand", weapon: "staff" };
  if (lower.includes("shield") || lower.includes("buckler")) return { slot: "offhand", weapon: "shield" };
  if (lower.includes("quiver")) return { slot: "offhand", weapon: "quiver" };
  // extend later...
  return { slot: "unknown", weapon: "unknown" };
}

// Compatibility rules (minimal starter)
function isCompatible(archetype, item, strict) {
  if (!strict) return true;

  if (archetype === "Bow") {
    // Bow build: do not propose shields/bucklers/foci as "paired" mainhand suggestions
    if (item.gear?.weapon === "shield" || item.gear?.weapon === "buckler" || item.gear?.weapon === "focus") return false;
  }
  if (archetype === "Crossbow") {
    if (item.gear?.weapon === "quiver") return false; // example: crossbow likely not using quiver
  }
  return true;
}

function hasAllTags(entityTags, requiredTags) {
  const set = new Set((entityTags || []).map(t => t.toLowerCase()));
  return requiredTags.every(t => set.has(t.toLowerCase()));
}

// ---- Data loading ----
async function loadData(force = false) {
  setStatus("Loading data…");

  let skills = !force ? cacheGet(CACHE_SKILLS) : null;
  let uniques = !force ? cacheGet(CACHE_UNIQUES) : null;

  try {
    if (!skills) {
      const html = await fetchHtml(SKILLS_URL);
      skills = parseSkillGems(html);
      cacheSet(CACHE_SKILLS, skills);
    }
    if (!uniques) {
      const html = await fetchHtml(UNIQUES_URL);
      uniques = parseUniques(html);
      cacheSet(CACHE_UNIQUES, uniques);
    }
  } catch (e) {
    console.error(e);
    setStatus("Error: fetch blocked (CORS?) or parse failed. See console.");
    return null;
  }

  setStatus(`Loaded: ${uniques.length} uniques, ${skills.length} skill gems`);
  return { skills, uniques };
}

// ---- Render ----
function renderList(el, items, formatter) {
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<div class="muted">No results</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 50)) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = formatter(it);
    frag.appendChild(div);
  }
  el.appendChild(frag);
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[c]));
}

// ---- Main ----
let DATA = null;

async function runSearch() {
  if (!DATA) DATA = await loadData(false);
  if (!DATA) return;

  const archetype = $("tagArchetype").value;
  const theme = $("tagTheme").value;
  const onlyUniques = $("onlyUniques").checked;
  const strict = $("strictCompat").checked;

  // Required tags set
  // For skills, archetype like "Bow" might not be an official tag everywhere, so you’ll likely map it:
  const reqSkillTags = [];
  if (archetype === "Bow") reqSkillTags.push("Projectile"); // adjust later to match real tags
  reqSkillTags.push(theme);

  const reqItemTags = [theme]; // items might not carry same tag line; this will evolve

  const skills = DATA.skills
    .filter(s => hasAllTags(s.tags, reqSkillTags))
    .slice(0, 200);

  const uniques = DATA.uniques
    .filter(u => hasAllTags(u.tags, reqItemTags))
    .filter(u => isCompatible(archetype, u, strict))
    .slice(0, 200);

  renderList($("skillsList"), skills, (s) => `
    <div class="title">${escapeHtml(s.name)}</div>
    <div class="muted">${escapeHtml((s.tags || []).join(", "))}</div>
  `);

  renderList($("uniquesList"), uniques, (u) => `
    <div class="title">${escapeHtml(u.name)}</div>
    <div class="muted">${escapeHtml((u.tags || []).join(", "))}</div>
    <div class="muted">gear: ${escapeHtml(u.gear?.weapon || "unknown")}</div>
  `);
}

document.addEventListener("DOMContentLoaded", async () => {
  $("btnSearch").addEventListener("click", runSearch);

  $("btnRefresh").addEventListener("click", async () => {
    localStorage.removeItem(CACHE_SKILLS);
    localStorage.removeItem(CACHE_UNIQUES);
    DATA = await loadData(true);
  });

  // pre-load once
  DATA = await loadData(false);
});
