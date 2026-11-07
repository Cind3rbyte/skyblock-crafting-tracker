import { firebaseConfig } from "./firebase-config.js";

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

// ---------- Zustand: key -> { c: bool, h: number } ----------
let data, hash, backend;
let state = {};
let currentItem = null;
let view = store.get("view") === "blocks" ? "blocks" : "base";

function createLocalBackend(key) {
  const k = "state:" + key;
  let cur = {};
  try { cur = JSON.parse(store.get(k) || "{}"); } catch { cur = {}; }
  return {
    mode: "local",
    listen(cb) { cb(cur); setStatus("local"); },
    write(itemId, id, val) {
      cur[itemId] = cur[itemId] || {};
      if (val) cur[itemId][id] = val; else delete cur[itemId][id];
      store.set(k, JSON.stringify(cur));
    },
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
  return {
    mode: "firebase",
    listen(cb) {
      db.onValue(root, (snap) => cb(snap.val() || {}), () => setStatus("error"));
      db.onValue(db.ref(database, ".info/connected"), (s) => setStatus(s.val() ? "online" : "offline"));
    },
    write(itemId, id, val) {
      const r = db.child(root, `${itemId}/${id}`);
      return val ? db.set(r, val) : db.remove(r);
    },
  };
}

function setStatus(kind) {
  const map = {
    online: ["on", "Live synchronisiert"],
    offline: ["off", "Offline, Änderungen warten"],
    error: ["off", "Zugriff verweigert"],
    local: ["off", "Nur lokal (kein Sync eingerichtet)"],
  };
  const [cls, label] = map[kind];
  $("status").replaceChildren(h("span", { class: "dot " + cls }), label);
}

function entry(itemId, id) {
  return state[itemId]?.[id] || { c: false, h: 0 };
}
function setEntry(itemId, id, patch) {
  const next = { ...entry(itemId, id), ...patch };
  const val = next.c || next.h > 0 ? { c: !!next.c, h: Math.max(0, Math.floor(next.h || 0)) } : null;
  state[itemId] = state[itemId] || {};
  if (val) state[itemId][id] = val; else delete state[itemId][id];
  backend.write(itemId, id, val);
  render();
}

// ---------- Rendering ----------
function nameEl(id, extra = "") {
  const m = data.meta[id];
  return h("span", { class: `name t-${m.tier} ${extra}` }, m.name);
}

function howBlock(id) {
  const m = data.meta[id];
  const hint = data.hints[id];
  if (!hint && !m.wiki) return null;
  return h("details", { class: "how" },
    h("summary", {}, "Wie komme ich da ran?"),
    hint ? h("p", {}, hint.how) : null,
    m.wiki ? h("a", { class: "wikilink", href: m.wiki, target: "_blank", rel: "noopener" }, "Wiki-Seite ↗") : null);
}

function materialRow(itemId, mat) {
  const e = entry(itemId, mat.id);
  const done = e.c || e.h >= mat.need;
  const input = h("input", {
    type: "number", min: "0", inputmode: "numeric", value: String(e.h), "aria-label": `Gesammelt: ${data.meta[mat.id].name}`,
    onchange: (ev) => {
      const v = Math.max(0, Math.floor(Number(ev.target.value) || 0));
      setEntry(itemId, mat.id, { h: v, c: v >= mat.need ? true : e.c && v >= mat.need });
    },
  });
  const step = Math.max(1, Math.min(64, Math.ceil(mat.need / 20)));
  const frac = e.c ? 1 : Math.min(e.h / mat.need, 1);
  return h("li", { class: "row" + (done ? " done" : ""), "data-tier": data.meta[mat.id].tier },
    h("div", { class: "line" },
      h("input", {
        class: "chk", type: "checkbox", checked: done, "aria-label": `${data.meta[mat.id].name} abgehakt`,
        onchange: (ev) => setEntry(itemId, mat.id, ev.target.checked ? { c: true, h: mat.need } : { c: false, h: 0 }),
      }),
      nameEl(mat.id),
      h("span", { class: "need" }, `${fmt(Math.min(e.c ? mat.need : e.h, mat.need))} / ${fmt(mat.need)}`),
      h("span", { class: "counter" },
        h("button", { type: "button", "aria-label": "Weniger", onclick: () => setEntry(itemId, mat.id, { h: Math.max(0, e.h - step), c: false }) }, "−"),
        input,
        h("button", { type: "button", "aria-label": "Mehr", onclick: () => { const v = e.h + step; setEntry(itemId, mat.id, { h: v, c: v >= mat.need }); } }, "+"))),
    h("div", { class: "mbar" }, h("i", { style: `width:${Math.round(frac * 100)}%` })),
    howBlock(mat.id));
}

function treeNode(itemId, n) {
  const key = n.children ? "step:" + n.id : n.id;
  const e = entry(itemId, key);
  const done = n.children ? e.c : e.c || e.h >= n.need;
  const badges = [];
  if (n.recipe) {
    const dur = fmtDuration(n.recipe.duration);
    badges.push(h("span", { class: "badge " + n.recipe.kind }, n.recipe.kind === "forge"
      ? `Forge${dur ? " · " + dur : ""}${n.recipe.hotm ? " · HotM " + n.recipe.hotm : ""}` : "Craften"));
  }
  const li = h("li", {},
    h("div", { class: "node" + (done ? " done" : "") },
      h("input", {
        class: "chk", type: "checkbox", checked: done, "aria-label": `${data.meta[n.id].name} abgehakt`,
        onchange: (ev) => {
          if (n.children) setEntry(itemId, key, { c: ev.target.checked });
          else setEntry(itemId, key, ev.target.checked ? { c: true, h: n.need } : { c: false, h: 0 });
        },
      }),
      nameEl(n.id),
      h("span", { class: "need" }, `×${fmt(n.need)}`),
      badges),
    n.children ? h("ul", {}, n.children.map((c) => treeNode(itemId, c))) : null);
  return li;
}

function progress(item, list) {
  let sum = 0;
  for (const m of list) {
    const e = entry(item.id, m.id);
    sum += e.c ? 1 : Math.min(e.h / m.need, 1);
  }
  return list.length ? sum / list.length : 0;
}

function render() {
  const item = data.items[currentItem];
  const m = data.meta[item.id];
  const list = view === "base" ? item.raw : item.mid;
  const pct = Math.round(progress(item, list) * 100);
  const root = item.tree;

  const hotmNeeded = Math.max(0, ...(function walk(n) { return [n.recipe?.hotm || 0, ...(n.children || []).flatMap(walk)]; })(root));
  const forgeSec = (function walk(n) { return (n.recipe?.kind === "forge" ? n.recipe.duration * n.recipe.runs : 0) + (n.children || []).reduce((s, c) => s + walk(c), 0); })(root);
  const doneCount = list.filter((x) => entry(item.id, x.id).c || entry(item.id, x.id).h >= x.need).length;

  $("item").replaceChildren(
    h("div", { class: "hero" },
      h("div", { class: "hero-text" },
        h("span", { class: "eyebrow" }, "Ziel-Item"),
        h("h2", { class: `t-${m.tier}` }, m.name),
        h("div", { class: "chips" },
          h("span", { class: "chip" }, `HotM ${hotmNeeded}`),
          h("span", { class: "chip" }, `Forge ${fmtDuration(forgeSec)}`),
          h("span", { class: "chip" }, `${doneCount} / ${list.length} fertig`),
          m.wiki ? h("a", { class: "chip link", href: m.wiki, target: "_blank", rel: "noopener" }, "Wiki ↗") : null)),
      h("div", { class: "ring", style: `--p:${pct}`, role: "progressbar", "aria-valuenow": String(pct), "aria-valuemin": "0", "aria-valuemax": "100" },
        h("span", {}, pct + "%"))),
    h("div", { class: "sec-head" },
      h("h3", {}, "Materialien"),
      h("div", { class: "seg", role: "group", "aria-label": "Ansicht" },
        h("button", { type: "button", "aria-pressed": String(view === "base"), onclick: () => { view = "base"; store.set("view", view); render(); } }, "Bazaar-Ware"),
        h("button", { type: "button", "aria-pressed": String(view === "blocks"), onclick: () => { view = "blocks"; store.set("view", view); render(); } }, "Blöcke"))),
    h("ul", { class: "list" }, list.map((mat) => materialRow(item.id, mat))),
    h("div", { class: "sec-head" }, h("h3", {}, "Craft-Reihenfolge (von unten nach oben abarbeiten)")),
    h("ul", { class: "tree" }, treeNode(item.id, root)));
}

function renderTabs() {
  const ids = Object.keys(data.items);
  $("tabs").hidden = ids.length < 2;
  $("tabs").replaceChildren(...ids.map((id) => h("button", {
    class: "tab", role: "tab", "aria-selected": String(id === currentItem),
    onclick: () => { currentItem = id; store.set("item", id); renderTabs(); render(); },
  }, data.meta[id].name)));
}

// ---------- Start ----------
async function openList(key) {
  hash = key;
  backend = firebaseConfig.databaseURL ? await createFirebaseBackend(key) : createLocalBackend(key);
  $("gate").hidden = true;
  $("main").hidden = false;
  backend.listen((s) => { state = s; render(); });
}

async function main() {
  const theme = store.get("theme");
  if (theme) document.documentElement.dataset.theme = theme;

  data = await (await fetch("data/items.json", { cache: "no-cache" })).json();
  const ids = Object.keys(data.items);
  currentItem = ids.includes(store.get("item")) ? store.get("item") : ids[0];
  $("generated").textContent = "Rezeptdaten: " + new Date(data.generated).toLocaleDateString("de-DE") + " · Quelle NotEnoughUpdates-REPO, Hypixel API";
  renderTabs();

  $("logout").addEventListener("click", () => {
    store.del("hash");
    location.reload();
  });
  $("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const pw = $("gate-input").value.trim();
    if (!pw) return;
    const key = await sha256(pw);
    store.set("hash", key);
    openList(key);
  });

  const saved = store.get("hash");
  if (saved && /^[a-f0-9]{64}$/.test(saved)) openList(saved);
  else $("gate").hidden = false;
}

main().catch((err) => {
  $("app").append(h("p", {}, "Fehler beim Laden: " + err.message));
});
