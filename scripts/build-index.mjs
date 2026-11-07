// Baut data/index.json (Suchindex): alle Items der Hypixel API, für die das NEU-Repo eine Datei hat.
// Aufruf: node scripts/build-index.mjs
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const api = await (await fetch("https://api.hypixel.net/v2/resources/skyblock/items")).json();
const tree = await (await fetch("https://api.github.com/repos/NotEnoughUpdates/NotEnoughUpdates-REPO/git/trees/master?recursive=1")).json();
const neu = new Set(tree.tree.filter((f) => f.path.startsWith("items/") && f.path.endsWith(".json")).map((f) => f.path.slice(6, -5)));

const items = api.items
  .filter((it) => neu.has(it.id) && it.name)
  .map((it) => ({ i: it.id, n: it.name, t: it.tier || "COMMON" }));

await writeFile(join(root, "data/index.json"), JSON.stringify(items));
console.log("Items im Index:", items.length);
