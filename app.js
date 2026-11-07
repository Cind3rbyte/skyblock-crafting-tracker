import { firebaseConfig } from "./firebase-config.js";
import { buildItem } from "./lib/recipes.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignorieren */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignorieren */ } },
};

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fmt = (n) => n.toLocaleString("de-DE");
function fmtDuration(sec) {
  if (!sec) return "";
  const hrs = Math.floor(sec / 3600), min = Math.round((sec % 3600) / 60);
  return [hrs ? `${hrs} Std` : "", min ? `${min} Min` : ""].filter(Boolean).join(" ");
}

// ---------- Globaler Zustand ----------
const DEFAULT_TARGET = "MITHRIL_DRILL_1";
const CACHE_MS = 3 * 24 * 3600 * 1000;
let hints = {};
let index = [];
let indexMap = new Map();
let backend;
let state = {};      // itemId -> key -> { c, h }
let targets = [];    // Ziel-Items dieser Gruppe
let current = null;
const built = new Map();
const loading = new Set();
let indexReady = Promise.resolve();

// ---------- Backends ----------
function createLocalBackend(key) {
  const k = "state:" + key, tk = "targets:" + key;
  let cur = {};
  try { cur = JSON.parse(store.get(k) || "{}"); } catch { cur = {}; }
  let list = [];
  try { list = JSON.parse(store.get(tk) || "null") || [DEFAULT_TARGET]; } catch { list = [DEFAULT_TARGET]; }
  const saveTargets = () => store.set(tk, JSON.stringify(list));
  return {
    listen(cb) { cb(cur); setStatus("local"); },
    listenTargets(cb) { cb([...list]); },
    write(itemId, id, val) {
      cur[itemId] = cur[itemId] || {};
      if (val) cur[itemId][id] = val; else delete cur[itemId][id];
      store.set(k, JSON.stringify(cur));
    },
    addTarget(id) { if (!list.includes(id)) list.push(id); saveTargets(); this.cbT?.([...list]); },
    removeTarget(id) { list = list.filter((x) => x !== id); saveTargets(); this.cbT?.([...list]); },
    onTargets(cb) { this.cbT = cb; },
  };
}

async function createFirebaseBackend(key) {
  const V = "10.14.1";
  const [{ initializeApp }, db] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-database.js`),
  ]);
  const database = db.getDatabase(initializeApp(firebaseConfig));
  const root = db.ref(database, "lists/" + key);
  const troot = db.ref(database, "targets/" + key);
  return {
    listen(cb, denied) {
      db.onValue(root, (snap) => cb(snap.val() || {}), () => denied());
      db.onValue(db.ref(database, ".info/connected"), (s) => setStatus(s.val() ? "online" : "offline"));
    },
    listenTargets(cb) {
      db.onValue(troot, (snap) => {
        const v = snap.val();
        if (!v || !v._init) { db.update(troot, { _init: true, [DEFAULT_TARGET]: true }); return; }
        cb(Object.keys(v).filter((k) => k !== "_init"));
      });
    },
    write(itemId, id, val) {
      const r = db.child(root, `${itemId}/${id}`);
      return val ? db.set(r, val) : db.remove(r);
    },
    addTarget(id) { return db.set(db.child(troot, id), true); },
    removeTarget(id) { return db.remove(db.child(troot, id)); },
    onTargets() {},
  };
}

function setStatus(kind) {
  const map = {
    online: ["on", "Live synchronisiert"],
    offline: ["off", "Offline, Änderungen warten"],
    local: ["off", "Nur lokal (kein Sync eingerichtet)"],
  };
  const [cls, label] = map[kind];
  $("status").replaceChildren(h("span", { class: "dot " + cls }), label);
}

// ---------- Zustand lesen/schreiben ----------
function entry(itemId, id) { return state[itemId]?.[id] || { c: false, h: 0 }; }
function setEntry(itemId, id, patch) {
  const next = { ...entry(itemId, id), ...patch };
  const val = next.c || next.h > 0 ? { c: !!next.c, h: Math.max(0, Math.floor(next.h || 0)) } : null;
  state[itemId] = state[itemId] || {};
  if (val) state[itemId][id] = val; else delete state[itemId][id];
  backend.write(itemId, id, val);
  render();
}

// ---------- Rezepte laden ----------
async function ensureBuilt(id) {
  if (built.has(id) || loading.has(id)) return;
  loading.add(id);
  try {
    await indexReady;
    let item = null;
    try {
      const cached = JSON.parse(store.get("built2:" + id) || "null");
      if (cached && Date.now() - cached.built < CACHE_MS) item = cached;
    } catch { /* Cache kaputt */ }
    if (!item) {
      item = await buildItem(id, 1, new Map(index.map((x) => [x.i, { n: x.n, t: x.t }])));
      store.set("built2:" + id, JSON.stringify(item));
    }
    built.set(id, item);
  } catch (err) {
    built.set(id, { error: err.message });
  } finally {
    loading.delete(id);
    render();
  }
}

// ---------- Rendering ----------
function nameOf(item, id) { return item.meta[id]?.name || id; }
function nameEl(item, id) { return h("span", { class: `name t-${item.meta[id]?.tier || "COMMON"}` }, nameOf(item, id)); }

function usedBy(tree, rawId) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (c.id === rawId) out.push({ p: n, c });
      walk(c);
    }
  })(tree);
  return out;
}

// Erste Enchanted-Stufe direkt über den Rohstoffen: das sammelt man im Inventar, darunter steht der Rohstoff.
function isStop(n) {
  return !!n.children && n.id.startsWith("ENCHANTED_") && n.children.every((c) => !c.id.startsWith("ENCHANTED_"));
}

function matList(item) {
  const sums = new Map(), nodes = new Map();
  (function walk(n) {
    if (!n.children || isStop(n)) {
      sums.set(n.id, (sums.get(n.id) || 0) + n.need);
      if (!nodes.has(n.id)) nodes.set(n.id, n);
    } else n.children.forEach(walk);
  })(item.tree);
  return [...sums].map(([id, need]) => ({ id, need, node: nodes.get(id) }));
}

function howBlock(item, id, node) {
  const m = item.meta[id];
  const hint = hints[id] || (node && isStop(node) ? hints[node.children[0].id] : null);
  const uses = usedBy(item.tree, id);
  const useText = uses.length
    ? "Wird gebraucht für: " + uses.map(({ p, c }) => `${fmt(p.need)}× ${nameOf(item, p.id)} (je ${fmt(c.need / p.need)})`).join(", ") + "."
    : null;
  if (!hint && !useText && !m?.wiki) return null;
  return h("details", { class: "how" },
    h("summary", {}, "Wie komme ich da ran?"),
    useText ? h("p", {}, useText) : null,
    hint ? h("p", {}, hint.how) : null,
    m?.wiki ? h("a", { class: "wikilink", href: m.wiki, target: "_blank", rel: "noopener" }, "Wiki-Seite ↗") : null);
}

function materialRow(item, mat) {
  const e = entry(item.id, mat.id);
  const done = e.c || e.h >= mat.need;
  const frac = e.c ? 1 : Math.min(e.h / mat.need, 1);
  const input = h("input", {
    type: "number", min: "0", inputmode: "numeric", value: String(e.h), "aria-label": `Gesammelt: ${nameOf(item, mat.id)}`,
    onchange: (ev) => {
      const v = Math.max(0, Math.floor(Number(ev.target.value) || 0));
      setEntry(item.id, mat.id, { h: v, c: v >= mat.need });
    },
  });
  const step = mat.need >= 10000 ? 1000 : mat.need >= 1000 ? 100 : mat.need >= 100 ? 10 : 1;
  return h("li", { class: "row" + (done ? " done" : ""), "data-tier": item.meta[mat.id]?.tier || "COMMON" },
    h("div", { class: "line" },
      h("input", {
        class: "chk", type: "checkbox", checked: done, "aria-label": `${nameOf(item, mat.id)} abgehakt`,
        onchange: (ev) => setEntry(item.id, mat.id, ev.target.checked ? { c: true, h: mat.need } : { c: false, h: 0 }),
      }),
      h("span", { class: "namebox" }, nameEl(item, mat.id), eqLine(item, mat.node)),
      h("span", { class: "need" }, `${fmt(Math.min(e.c ? mat.need : e.h, mat.need))} / ${fmt(mat.need)}`),
      h("span", { class: "counter" },
        h("button", { type: "button", "aria-label": "Weniger", onclick: () => setEntry(item.id, mat.id, { h: Math.max(0, e.h - step), c: false }) }, "−"),
        input,
        h("button", { type: "button", "aria-label": "Mehr", onclick: () => { const v = e.h + step; setEntry(item.id, mat.id, { h: v, c: v >= mat.need }); } }, "+"))),
    h("div", { class: "mbar" }, h("i", { style: `width:${Math.round(frac * 100)}%` })),
    howBlock(item, mat.id, mat.node));
}

// "= 51.200 Diamond" unter dem Enchanted-Item
function eqLine(item, node) {
  if (!node || !isStop(node)) return null;
  const parts = node.children.map((c) => `${fmt(c.need)}× ${nameOf(item, c.id)}`).join(" + ");
  return h("span", { class: "eq" }, `= ${parts}`);
}

function treeNode(item, n) {
  const stop = isStop(n);
  const hasKids = !!n.children && !stop;
  const key = hasKids ? "step:" + n.id : n.id;
  const e = entry(item.id, key);
  const done = hasKids ? e.c : e.c || e.h >= n.need;
  const badges = [];
  if (n.recipe) {
    const dur = fmtDuration(n.recipe.duration);
    badges.push(h("span", { class: "badge " + n.recipe.kind }, n.recipe.kind === "forge"
      ? `Forge${dur ? " · " + dur : ""}${n.recipe.hotm ? " · HotM " + n.recipe.hotm : ""}` : "Craften"));
  }
  return h("li", {},
    h("div", { class: "node" + (done ? " done" : "") },
      h("input", {
        class: "chk", type: "checkbox", checked: done, "aria-label": `${nameOf(item, n.id)} abgehakt`,
        onchange: (ev) => {
          if (hasKids) setEntry(item.id, key, { c: ev.target.checked });
          else setEntry(item.id, key, ev.target.checked ? { c: true, h: n.need } : { c: false, h: 0 });
        },
      }),
      h("span", { class: "namebox" }, nameEl(item, n.id), eqLine(item, n)),
      h("span", { class: "need" }, `×${fmt(n.need)}`),
      badges),
    hasKids ? h("ul", {}, n.children.map((c) => treeNode(item, c))) : null);
}

function progress(item) {
  const mats = matList(item);
  let sum = 0;
  for (const m of mats) {
    const e = entry(item.id, m.id);
    sum += e.c ? 1 : Math.min(e.h / m.need, 1);
  }
  return mats.length ? sum / mats.length : 0;
}

function tabName(id) { return indexMap.get(id)?.n || built.get(id)?.meta?.[id]?.name || id; }

function renderTabs() {
  $("tabs").hidden = !targets.length;
  $("tabs").replaceChildren(...targets.map((id) => h("div", { class: "tab-wrap", "data-active": String(id === current) },
    h("button", {
      class: "tab", role: "tab", "aria-selected": String(id === current),
      onclick: () => { current = id; store.set("item", id); render(); },
    }, tabName(id)),
    h("button", {
      class: "tab-x", "aria-label": `${tabName(id)} entfernen`, title: "Entfernen",
      onclick: () => { if (confirm(`"${tabName(id)}" aus der Liste entfernen? Die Haken bleiben gespeichert.`)) backend.removeTarget(id); },
    }, "×"))));
}

function render() {
  renderTabs();
  if (!current) {
    $("item").replaceChildren(h("div", { class: "card empty" }, h("h2", {}, "Noch kein Item"), h("p", {}, "Such oben nach einem Item oder füge einen Wiki-Link ein.")));
    return;
  }
  const item = built.get(current);
  if (!item) {
    $("item").replaceChildren(h("p", { class: "loading" }, "Lade Rezept …"));
    ensureBuilt(current);
    return;
  }
  if (item.error) {
    $("item").replaceChildren(h("div", { class: "card empty" }, h("h2", {}, "Rezept konnte nicht geladen werden"), h("p", {}, item.error),
      h("button", { class: "btn", onclick: () => { built.delete(current); render(); } }, "Nochmal versuchen")));
    return;
  }

  const m = item.meta[item.id];
  const root = item.tree;
  const pct = Math.round(progress(item) * 100);
  const mats = matList(item);
  const doneCount = mats.filter((x) => entry(item.id, x.id).c || entry(item.id, x.id).h >= x.need).length;
  const noRecipe = !root.children;
  const hotmNeeded = Math.max(0, ...(function walk(n) { return [n.recipe?.hotm || 0, ...(n.children || []).flatMap(walk)]; })(root));
  const forgeSec = (function walk(n) { return (n.recipe?.kind === "forge" ? n.recipe.duration * n.recipe.runs : 0) + (n.children || []).reduce((s, c) => s + walk(c), 0); })(root);

  const hero = h("div", { class: "hero" },
    h("div", { class: "hero-text" },
      h("span", { class: "eyebrow" }, "Ziel-Item"),
      h("h2", { class: `t-${m.tier}` }, m.name),
      h("div", { class: "chips" },
        hotmNeeded ? h("span", { class: "chip" }, `HotM ${hotmNeeded}`) : null,
        forgeSec ? h("span", { class: "chip" }, `Forge ${fmtDuration(forgeSec)}`) : null,
        noRecipe ? null : h("span", { class: "chip" }, `${doneCount} / ${mats.length} fertig`),
        m.wiki ? h("a", { class: "chip link", href: m.wiki, target: "_blank", rel: "noopener" }, "Wiki ↗") : null)),
    h("div", { class: "ring", style: `--p:${pct}`, role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" },
      h("span", {}, pct + "%")));

  if (noRecipe) {
    $("item").replaceChildren(hero, h("div", { class: "card empty" }, h("h2", {}, "Kein Rezept gefunden"),
      h("p", {}, "Dieses Item hat im NEU-Repo kein Craft- oder Forge-Rezept (Drop, Kauf oder Spezialrezept). Schau im Wiki nach, wie man es bekommt."),
      m.wiki ? h("a", { class: "wikilink", href: m.wiki, target: "_blank", rel: "noopener" }, "Wiki-Seite ↗") : null));
    return;
  }

  $("item").replaceChildren(
    hero,
    h("div", { class: "sec-head" }, h("h3", {}, "Materialien")),
    h("ul", { class: "list" }, mats.map((mat) => materialRow(item, mat))),
    h("div", { class: "sec-head" }, h("h3", {}, "Craft-Reihenfolge (von unten nach oben abarbeiten)")),
    h("ul", { class: "tree" }, treeNode(item, root)));
}

// ---------- Suche ----------
function search(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const idq = q.replace(/\s+/g, "_");
  const starts = [], incl = [];
  for (const it of index) {
    const n = it.n.toLowerCase();
    if (n.startsWith(q)) starts.push(it);
    else if (n.includes(q) || it.i.toLowerCase().includes(idq)) incl.push(it);
    if (starts.length >= 8) break;
  }
  return starts.concat(incl).slice(0, 8);
}

function nameFromLink(text) {
  try {
    const u = new URL(text);
    const title = u.searchParams.get("title");
    const seg = title || u.pathname.split("/").filter(Boolean).pop();
    return seg ? decodeURIComponent(seg).replace(/_/g, " ") : null;
  } catch { return null; }
}

let results = [];
function showResults(list) {
  results = list;
  const ul = $("results");
  ul.hidden = false;
  ul.replaceChildren(...(list.length ? list.map((it) => h("li", { role: "option" },
    h("button", { type: "button", onclick: () => pick(it) },
      h("span", { class: `t-${it.t}` }, it.n),
      targets.includes(it.i) ? h("small", {}, "schon in der Liste") : null)))
    : [h("li", { class: "none" }, "Nichts gefunden")]));
}
function hideResults() { $("results").hidden = true; }

function pick(it) {
  if (!targets.includes(it.i)) backend.addTarget(it.i);
  current = it.i;
  store.set("item", it.i);
  $("search").value = "";
  hideResults();
  if (!targets.includes(it.i)) targets = [...targets, it.i];
  render();
}

function onSearchInput() {
  const text = $("search").value.trim();
  if (!text) { hideResults(); return; }
  if (/^https?:\/\//i.test(text)) {
    const name = nameFromLink(text);
    if (!name) { showResults([]); return; }
    const exact = index.filter((x) => x.n.toLowerCase() === name.toLowerCase());
    showResults(exact.length ? exact : search(name));
    return;
  }
  showResults(search(text));
}

// ---------- Start ----------
async function openList(key) {
  // ?local im Link = Testmodus ohne Sync
  backend = firebaseConfig.databaseURL && !location.search.includes("local") ? await createFirebaseBackend(key) : createLocalBackend(key);
  backend.onTargets((list) => applyTargets(list));
  backend.listen((s) => {
    state = s;
    $("gate").hidden = true;
    $("main").hidden = false;
    render();
  }, () => {
    store.del("hash");
    $("main").hidden = true;
    $("gate").hidden = false;
    $("gate-error").hidden = false;
    $("gate-input").select();
  });
  backend.listenTargets((list) => applyTargets(list));
}

function applyTargets(list) {
  targets = list;
  const saved = store.get("item");
  if (!current || !targets.includes(current)) current = targets.includes(saved) ? saved : targets[0] || null;
  render();
}

async function main() {
  fetch("data/hints.json").then((r) => r.json()).then((j) => { hints = j; render(); }).catch(() => {});
  indexReady = fetch("data/index.json").then((r) => r.json()).then((j) => {
    index = j;
    indexMap = new Map(j.map((x) => [x.i, x]));
    render();
  }).catch(() => {});

  $("logout").addEventListener("click", () => { store.del("hash"); location.reload(); });
  $("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pw = $("gate-input").value.trim();
    if (!pw) return;
    $("gate-error").hidden = true;
    const key = await sha256(pw);
    store.set("hash", key);
    openList(key);
  });

  $("search").addEventListener("input", onSearchInput);
  $("search").addEventListener("focus", () => { if ($("search").value.trim()) onSearchInput(); });
  $("search").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && results[0]) pick(results[0]);
    if (ev.key === "Escape") hideResults();
  });
  document.addEventListener("click", (ev) => { if (!ev.target.closest(".search")) hideResults(); });

  const saved = store.get("hash");
  if (saved && /^[a-f0-9]{64}$/.test(saved)) openList(saved);
  else $("gate").hidden = false;
}

main().catch((err) => {
  $("app").append(h("p", {}, "Fehler beim Laden: " + err.message));
});
