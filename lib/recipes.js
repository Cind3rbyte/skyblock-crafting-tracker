// Baut den Rezeptbaum eines Items live aus dem NEU-Repo (CORS-fähig, läuft im Browser).
const NEU = "https://raw.githubusercontent.com/NotEnoughUpdates/NotEnoughUpdates-REPO/master/items/";
const MAX_NODES = 250;
const NAME_OVERRIDES = { SKYBLOCK_COIN: "Coins" };

const strip = (s) => (s || "").replace(/§./g, "").trim();
const parseIn = (s) => {
  const [id, n] = String(s).split(":");
  return { id, n: Number(n ?? 1) };
};
const titleCase = (id) => id.toLowerCase().split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

const neuCache = new Map();
export function neu(id) {
  if (!neuCache.has(id)) {
    neuCache.set(id, fetch(NEU + encodeURIComponent(id) + ".json").then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return neuCache.get(id);
}

// Liefert { kind, count, inputs[], duration?, hotm } oder null, wenn Rohstoff.
function readRecipe(id, data) {
  if (!data) return null;
  const hotmMatch = /HotM (\d+)/.exec(data.crafttext || "");
  const hotm = hotmMatch ? Number(hotmMatch[1]) : null;
  const forge = (data.recipes || []).find((r) => r.type === "forge");
  if (forge) {
    return { kind: "forge", count: forge.count ?? 1, inputs: forge.inputs.map(parseIn), duration: forge.duration, hotm };
  }
  const grid = data.recipe || (data.recipes || []).find((r) => r.type === "crafting");
  if (!grid) return null;
  const sums = new Map();
  for (const [slot, v] of Object.entries(grid)) {
    if (!v || !/^[A-C][1-3]$/.test(slot)) continue;
    const { id: inId, n } = parseIn(v);
    sums.set(inId, (sums.get(inId) || 0) + n);
  }
  // Vanilla-Items (Barren <-> Blöcke) nicht auflösen, sonst Kreise.
  const expandable = id.startsWith("ENCHANTED_") || [...sums.keys()].some((k) => k.startsWith("ENCHANTED_"));
  if (!sums.size || !expandable) return null;
  return { kind: "craft", count: Number(grid.count ?? 1), inputs: [...sums].map(([i, n]) => ({ id: i, n })), hotm };
}

function tierFromLore(data) {
  const last = strip((data?.lore || []).at(-1)).toUpperCase();
  for (const t of ["MYTHIC", "LEGENDARY", "EPIC", "RARE", "UNCOMMON", "COMMON"]) if (last.includes(t)) return t;
  return "COMMON";
}

// index: Map id -> { n, t } (Name und Seltenheit aus der Hypixel API)
export async function buildItem(id, amount, index) {
  const meta = {};
  const ctx = { count: 0 };

  async function describe(nid, data) {
    if (meta[nid]) return;
    const idx = index.get(nid);
    meta[nid] = {
      name: NAME_OVERRIDES[nid] || idx?.n || strip(data?.displayname) || titleCase(nid),
      tier: idx?.t || tierFromLore(data),
      wiki: data?.info?.find((u) => u.includes("minecraft.wiki")) || null,
      req: strip(data?.crafttext).replace(/^Requires:\s*/, "") || null,
    };
  }

  async function node(nid, need, path) {
    const data = await neu(nid);
    await describe(nid, data);
    const n = { id: nid, need };
    if (path.includes(nid) || ctx.count++ > MAX_NODES) return n;
    const r = readRecipe(nid, data);
    if (!r) return n;
    const runs = Math.ceil(need / r.count);
    n.recipe = { kind: r.kind, runs, duration: r.duration ?? null, hotm: r.hotm };
    n.children = await Promise.all(r.inputs.map((inp) => node(inp.id, inp.n * runs, [...path, nid])));
    return n;
  }

  const tree = await node(id, amount, []);
  const sums = new Map();
  (function walk(n) {
    if (!n.children) sums.set(n.id, (sums.get(n.id) || 0) + n.need);
    else n.children.forEach(walk);
  })(tree);
  return { id, tree, meta, raw: [...sums].map(([rid, need]) => ({ id: rid, need })), built: Date.now() };
}
