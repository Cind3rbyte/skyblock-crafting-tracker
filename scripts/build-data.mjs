// Holt Rezepte aus dem NEU-Repo und baut data/items.json.
// Aufruf: node scripts/build-data.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEU = "https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items/";
const API = "https://api.hypixel.net/v2/resources/skyblock/items";

const targets = JSON.parse(await readFile(join(root, "data/targets.json"), "utf8"));
const hints = JSON.parse(await readFile(join(root, "data/hints.json"), "utf8"));

const apiItems = new Map();
{
  const res = await fetch(API);
  const json = await res.json();
  for (const it of json.items) apiItems.set(it.id, it);
}

const neuCache = new Map();
async function neu(id) {
  if (neuCache.has(id)) return neuCache.get(id);
  const res = await fetch(NEU + encodeURIComponent(id) + ".json");
  const data = res.ok ? await res.json() : null;
  neuCache.set(id, data);
  return data;
}

const strip = (s) => (s || "").replace(/§./g, "").trim();
const parseIn = (s) => {
  const [id, n] = String(s).split(":");
  return { id, n: Number(n ?? 1) };
};

// Liefert { kind, count, inputs[], duration?, hotm? } oder null, wenn Rohstoff.
function readRecipe(data) {
  if (!data) return null;
  const hotmMatch = /HotM (\d+)/.exec(data.crafttext || "");
  const hotm = hotmMatch ? Number(hotmMatch[1]) : null;
  const forge = (data.recipes || []).find((r) => r.type === "forge");
  if (forge) {
    return {
      kind: "forge",
      count: forge.count ?? 1,
      inputs: forge.inputs.map(parseIn),
      duration: forge.duration,
      hotm,
    };
  }
  const grid = data.recipe || (data.recipes || []).find((r) => r.type === "crafting");
  if (grid) {
    const sums = new Map();
    for (const [slot, v] of Object.entries(grid)) {
      if (!v || !/^[A-C][1-3]$/.test(slot)) continue;
      const { id, n } = parseIn(v);
      sums.set(id, (sums.get(id) || 0) + n);
    }
    // Nur Enchanted-Items auflösen; Vanilla-Items (Barren, Blöcke) bleiben Blätter, sonst Zyklen.
    if (sums.size && data.internalname?.startsWith("ENCHANTED_")) {
      return {
        kind: "craft",
        count: Number(grid.count ?? 1),
        inputs: [...sums].map(([id, n]) => ({ id, n })),
        hotm,
      };
    }
  }
  return null;
}

const meta = {};
async function describe(id) {
  if (meta[id]) return;
  const data = await neu(id);
  const api = apiItems.get(id);
  meta[id] = {
    name: strip(data?.displayname) || api?.name || id,
    tier: api?.tier || "COMMON",
    wiki: data?.info?.find((u) => u.includes("minecraft.wiki")) || null,
    req: strip(data?.crafttext).replace(/^Requires:\s*/, "") || null,
  };
}

// Baut Knoten rekursiv. need = benötigte Menge dieses Items.
async function node(id, need, path = []) {
  if (path.includes(id)) throw new Error("Zyklus: " + [...path, id].join(" > "));
  await describe(id);
  const recipe = readRecipe(await neu(id));
  const n = { id, need };
  if (!recipe) return n;
  const runs = Math.ceil(need / recipe.count);
  n.recipe = { kind: recipe.kind, runs, duration: recipe.duration ?? null, hotm: recipe.hotm };
  n.children = [];
  for (const inp of recipe.inputs) {
    n.children.push(await node(inp.id, inp.n * runs, [...path, id]));
  }
  return n;
}

function flatten(n, stop, out = new Map()) {
  const isLeaf = !n.children || stop(n);
  if (isLeaf) {
    out.set(n.id, (out.get(n.id) || 0) + n.need);
    return out;
  }
  for (const c of n.children) flatten(c, stop, out);
  return out;
}

const items = {};
for (const t of targets) {
  const tree = await node(t.id, t.amount ?? 1);
  const list = (m) => [...m].map(([id, need]) => ({ id, need }));
  const isEnch = (n) => n.id.startsWith("ENCHANTED_");
  items[t.id] = {
    id: t.id,
    tree,
    // Rohstoffe: alles bis auf Vanilla-Ebene (Erz, Barren, Redstone ...)
    raw: list(flatten(tree, () => false)),
    // Enchanted-Grundstufe (z. B. Enchanted Iron Ingot)
    ench: list(flatten(tree, (n) => isEnch(n) && n.children.every((c) => !isEnch(c)))),
    // Enchanted-Blöcke (erste Enchanted-Stufe unter dem Rezept)
    mid: list(flatten(tree, (n) => isEnch(n) && n.id !== t.id)),
  };
}

const out = { generated: new Date().toISOString(), meta, hints, items };
await writeFile(join(root, "data/items.json"), JSON.stringify(out, null, 1));
const missing = [...new Set(Object.values(items).flatMap((i) => i.raw.map((r) => r.id)))].filter((id) => !hints[id]);
console.log("Items:", Object.keys(items).join(", "));
console.log("Rohstoffe ohne Hinweis:", missing.join(", ") || "-");
