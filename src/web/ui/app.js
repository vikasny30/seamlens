// SeamLens web UI. No frameworks, no network except this server. Repository content is only ever inserted as text.
(() => {
"use strict";

const SEV = { error: 3, warning: 2, info: 1 };
const SEV_LABEL = { error: "error", warning: "warning", info: "info" };
const NS = "http://www.w3.org/2000/svg";

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
function sv(tag, props, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.setAttribute("class", v);
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) if (c) e.append(c);
  return e;
}
const $ = (s, el = document) => el.querySelector(s);
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const toast = msg => { const t = h("div", { text: msg }); $("#toast").append(t); setTimeout(() => t.remove(), 3500); };
async function api(path) { const r = await fetch(path); let j = {}; try { j = await r.json(); } catch { /* not json */ } if (!r.ok) throw new Error(j.error || r.statusText); return j; }
const chip = (text, cls) => h("span", { class: "chip " + (cls || ""), text });
const pctText = v => (v * 100).toFixed(1) + "%";

// ---- state ----------------------------------------------------------------------------------------------------------
let R = null;
let view = (location.hash.slice(1) || "map");
const S = {
  sel: null, tf: { x: 20, y: 10, k: 1 }, q: "", issuesOnly: false, hideIsolated: true, minSev: "info",
  kinds: { operation: true, rpc: true, route: true, module: true, table: true, external: true },
  f: { sev: "all", cat: "all", q: "" },
  diffBase: "HEAD~1", sinceDays: 180, github: "",
};
let byNode = new Map(), nodeById = new Map(), outAdj = new Map(), inAdj = new Map();

function index() {
  byNode = new Map(); nodeById = new Map(); outAdj = new Map(); inAdj = new Map();
  for (const n of R.graph.nodes) nodeById.set(n.id, n);
  for (const f of R.findings) if (f.nodeId) (byNode.get(f.nodeId) || byNode.set(f.nodeId, []).get(f.nodeId)).push(f);
  for (const e of R.graph.edges) {
    if (e.kind === "references") continue;
    (outAdj.get(e.from) || outAdj.set(e.from, []).get(e.from)).push(e.to);
    (inAdj.get(e.to) || inAdj.set(e.to, []).get(e.to)).push(e.from);
  }
}
const worst = fs => fs && fs.length ? fs.reduce((a, f) => (SEV[f.severity] > SEV[a] ? f.severity : a), "info") : null;
const countsBy = fs => fs.reduce((m, f) => (m[f.severity]++, m), { error: 0, warning: 0, info: 0 });
function reach(start, adj) {
  const seen = new Set(), q = [start];
  while (q.length) { const n = q.shift(); for (const m of adj.get(n) || []) if (!seen.has(m) && m !== start) { seen.add(m); q.push(m); } }
  return seen;
}

// ---- header ---------------------------------------------------------------------------------------------------------
const TABS = [["map", "Map"], ["findings", "Findings"], ["contracts", "Contracts"], ["diff", "Diff"], ["impact", "Impact"], ["org", "Org"], ["rules", "Rules"]];
function renderHeader() {
  $("#repo").textContent = R.summary.root.split("/").slice(-2).join("/");
  const tabs = clear($("#tabs"));
  for (const [id, label] of TABS) tabs.append(h("button", { role: "tab", "aria-selected": String(view === id), text: label, onclick: () => go(id) }));
  const sm = R.summary, empty = !(sm.operations + sm.rpcs + sm.tables + sm.routes + sm.sourceFiles);
  const sc = R.score, col = empty ? "var(--mut)" : sc.overall >= 80 ? "var(--ok)" : sc.overall >= 60 ? "var(--warn)" : "var(--err)";
  const C = 2 * Math.PI * 14;
  const ring = sv("svg", { class: "ring", viewBox: "0 0 34 34" },
    sv("circle", { cx: 17, cy: 17, r: 14, fill: "none", stroke: "var(--line)", "stroke-width": 4 }),
    sv("circle", { cx: 17, cy: 17, r: 14, fill: "none", stroke: col, "stroke-width": 4, "stroke-dasharray": `${(C * sc.overall) / 100} ${C}`, transform: "rotate(-90 17 17)", "stroke-linecap": "round" }),
    sv("text", { x: 17, y: 21, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "var(--ink)", text: empty ? "–" : sc.grade }));
  clear($("#score")).append(ring, h("div", {}, h("b", { text: empty ? "Nothing to analyse" : `${sc.overall}/100` }), h("div", { class: "mut", text: empty ? "No contracts, routes or code found" : `${sc.counts.error} errors · ${sc.counts.warning} warnings` })));
}
function go(id) { view = id; location.hash = id; render(); }
window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (v && v !== view && TABS.some(t => t[0] === v)) { view = v; render(); } });

// ---- map ------------------------------------------------------------------------------------------------------------
const LANES = [
  { id: "contract", title: "CONTRACTS", kinds: ["operation", "rpc"] },
  { id: "entry", title: "ENTRY POINTS", kinds: ["route"] },
  { id: "module", title: "MODULES", kinds: ["module"] },
  { id: "data", title: "DATA AND EXTERNAL", kinds: ["table", "external"] },
];
const KIND_LABEL = { operation: "OP", rpc: "RPC", route: "ROUTE", module: "MOD", table: "TABLE", external: "EXT" };
const NODE_W = 250, NODE_H = 30, GAP_X = 96, GAP_Y = 12, TOP = 44;
const laneOf = n => LANES.findIndex(l => l.kinds.includes(n.kind));

function visibleNodes() {
  const q = S.q.trim().toLowerCase();
  let ns = R.graph.nodes.filter(n => S.kinds[n.kind] && (!q || n.label.toLowerCase().includes(q) || (n.file || "").toLowerCase().includes(q)));
  if (S.issuesOnly) ns = ns.filter(n => (byNode.get(n.id) || []).some(f => SEV[f.severity] >= SEV[S.minSev]));
  const ids = new Set(ns.map(n => n.id));
  if (S.hideIsolated) {
    const linked = new Set();
    for (const e of R.graph.edges) if (ids.has(e.from) && ids.has(e.to)) { linked.add(e.from); linked.add(e.to); }
    ns = ns.filter(n => linked.has(n.id) || (byNode.get(n.id) || []).length && n.kind !== "module");
  }
  return ns;
}

function layout(ns) {
  const ids = new Set(ns.map(n => n.id));
  const lanes = LANES.map(() => []);
  for (const n of ns) lanes[laneOf(n)].push(n);
  const pos = new Map();
  const neighbours = n => [...(outAdj.get(n.id) || []), ...(inAdj.get(n.id) || [])].filter(x => ids.has(x));
  const place = () => lanes.forEach(l => l.forEach((n, i) => pos.set(n.id, i)));
  lanes.forEach(l => l.sort((a, b) => a.label.localeCompare(b.label)));
  place();
  for (let sweep = 0; sweep < 3; sweep++) {
    const order = sweep % 2 === 0 ? lanes.map((_, i) => i) : lanes.map((_, i) => lanes.length - 1 - i);
    for (const li of order) {
      const bary = new Map();
      for (const n of lanes[li]) {
        const nb = neighbours(n).filter(x => laneOf(nodeById.get(x)) !== li).map(x => pos.get(x)).filter(v => v !== undefined);
        bary.set(n.id, nb.length ? nb.reduce((a, b) => a + b, 0) / nb.length : pos.get(n.id));
      }
      lanes[li].sort((a, b) => bary.get(a.id) - bary.get(b.id) || a.label.localeCompare(b.label));
      lanes[li].forEach((n, i) => pos.set(n.id, i));
    }
  }
  const P = new Map();
  lanes.forEach((l, li) => l.forEach((n, i) => P.set(n.id, { x: 24 + li * (NODE_W + GAP_X), y: TOP + i * (NODE_H + GAP_Y), lane: li })));
  return { P, lanes, height: TOP + Math.max(1, ...lanes.map(l => l.length)) * (NODE_H + GAP_Y) + 40, width: 24 + LANES.length * (NODE_W + GAP_X) };
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderMap() {
  const ns = visibleNodes(), ids = new Set(ns.map(n => n.id));
  const L = layout(ns);
  const trace = S.sel ? { down: reach(S.sel, outAdj), up: reach(S.sel, inAdj) } : null;
  const lit = trace ? new Set([S.sel, ...trace.down, ...trace.up]) : null;

  const wrap = h("div", { class: "map" });
  const col = h("div", { class: "mapcol" });
  const kinds = h("div", { class: "row" }, Object.keys(S.kinds).map(k => h("label", {}, h("input", { type: "checkbox", checked: S.kinds[k], onchange: e => { S.kinds[k] = e.target.checked; renderMapKeep(); } }), KIND_LABEL[k].toLowerCase())));
  const tb = h("div", { class: "toolbar" },
    h("input", { type: "search", placeholder: "Search nodes", value: S.q, "aria-label": "Search nodes", oninput: e => { S.q = e.target.value; debounceMap(); } }),
    kinds,
    h("label", {}, h("input", { type: "checkbox", checked: S.issuesOnly, onchange: e => { S.issuesOnly = e.target.checked; renderMapKeep(); } }), "only nodes with findings"),
    h("select", { "aria-label": "Minimum severity", onchange: e => { S.minSev = e.target.value; renderMapKeep(); } }, ["info", "warning", "error"].map(s => h("option", { value: s, selected: S.minSev === s, text: `severity ≥ ${s}` }))),
    h("label", {}, h("input", { type: "checkbox", checked: S.hideIsolated, onchange: e => { S.hideIsolated = e.target.checked; renderMapKeep(); } }), "hide unconnected"),
    h("span", { class: "mut", text: `${ns.length} of ${R.graph.nodes.length} nodes` }));
  col.append(tb);

  const canvas = h("div", { id: "canvas" });
  const svg = sv("svg", { role: "img", "aria-label": "Flow map of contracts, entry points, modules and data" });
  const vp = sv("g", { id: "vp" });
  svg.append(vp);
  LANES.forEach((l, i) => vp.append(sv("text", { class: "lane-title", x: 24 + i * (NODE_W + GAP_X), y: 22, text: l.title })));

  // edges
  for (const e of R.graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const a = L.P.get(e.from), b = L.P.get(e.to);
    const y1 = a.y + NODE_H / 2, y2 = b.y + NODE_H / 2;
    let d;
    if (a.lane < b.lane) { const x1 = a.x + NODE_W, x2 = b.x, mx = (x2 - x1) / 2; d = `M${x1},${y1} C${x1 + mx},${y1} ${x2 - mx},${y2} ${x2},${y2}`; }
    else if (a.lane === b.lane) { const x = a.x + NODE_W, bulge = 50 + Math.min(60, Math.abs(y2 - y1) / 4); d = `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`; }
    else { const x1 = a.x, x2 = b.x + NODE_W, mx = (x1 - x2) / 2; d = `M${x1},${y1} C${x1 - mx},${y1} ${x2 + mx},${y2} ${x2},${y2}`; }
    const hot = lit && lit.has(e.from) && lit.has(e.to);
    vp.append(sv("path", { d, class: `edge ${e.kind}${hot ? " hot" : ""}${lit && !hot ? " dim" : ""}`, "stroke-width": Math.min(3, 1.2 + Math.log2(e.weight) * 0.5) }));
  }
  // nodes
  for (const n of ns) {
    const p = L.P.get(n.id), fs = byNode.get(n.id) || [], w = worst(fs);
    const g = sv("g", { class: `node ${w ? "sev-" + w : "clean"}${S.sel === n.id ? " sel" : ""}${lit && !lit.has(n.id) ? " dim" : ""}`, transform: `translate(${p.x},${p.y})`, tabindex: 0, role: "button", "aria-label": `${KIND_LABEL[n.kind]} ${n.label}${fs.length ? `, ${fs.length} findings` : ""}`,
      onclick: ev => { ev.stopPropagation(); S.sel = S.sel === n.id ? null : n.id; renderMapKeep(); },
      onkeydown: ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); S.sel = S.sel === n.id ? null : n.id; renderMapKeep(); } } },
      sv("title", { text: `${n.label}${n.file ? "\n" + n.file + (n.line ? ":" + n.line : "") : ""}` }),
      sv("rect", { class: "body", width: NODE_W, height: NODE_H, rx: 6 }),
      sv("rect", { class: "stripe", width: 5, height: NODE_H, rx: 2 }),
      sv("text", { class: "kind", x: 14, y: 19, text: KIND_LABEL[n.kind] }),
      sv("text", { x: 14 + ({ route: 46, operation: 30, table: 42, rpc: 32, module: 34, external: 30 }[n.kind] || 34), y: 19, text: trunc(n.label, 30) }));
    if (fs.length) g.append(sv("rect", { class: "bdg", x: NODE_W - 28, y: 7, width: 22, height: 16, rx: 8 }), sv("text", { class: "badge", x: NODE_W - 17, y: 19, "text-anchor": "middle", text: String(fs.length) }));
    vp.append(g);
  }
  svg.addEventListener("click", () => { if (S.sel) { S.sel = null; renderMapKeep(); } });
  canvas.append(svg,
    h("div", { class: "legend" }, [["imports", "imports"], ["implements", "implements / handles"], ["reads", "reads"], ["writes", "writes"], ["calls", "calls"]].map(([k, t]) => h("span", {}, h("i", { style: `border-color:var(--e-${k === "implements" ? "impl" : k === "imports" ? "imports" : k === "reads" ? "read" : k === "writes" ? "write" : "call"})` }), t))),
    h("div", { class: "zoom" }, h("button", { "aria-label": "Zoom in", text: "+", onclick: () => zoomBy(1.25) }), h("button", { "aria-label": "Zoom out", text: "−", onclick: () => zoomBy(0.8) }), h("button", { "aria-label": "Fit to view", text: "⤢", onclick: () => fit(L) })));
  col.append(canvas);
  wrap.append(col, renderPanel());
  clear($("#main")).append(wrap);
  setupPanZoom(svg, vp);
  applyTf(vp);
  if (!S._fitted) { S._fitted = true; requestAnimationFrame(() => fit(L)); }
  if (!ns.length) vp.append(sv("text", { x: 40, y: 80, fill: "var(--mut)", text: "Nothing to show with these filters." }));
}
let mapTimer = 0;
const debounceMap = () => { clearTimeout(mapTimer); mapTimer = setTimeout(() => { const pos = $("input[type=search]"); const start = pos ? pos.selectionStart : 0; renderMapKeep(); const el = $("input[type=search]"); if (el) { el.focus(); el.setSelectionRange(start, start); } }, 180); };
function renderMapKeep() { const vp = $("#vp"); renderMap(); void vp; }

function applyTf(vp) { vp.setAttribute("transform", `translate(${S.tf.x},${S.tf.y}) scale(${S.tf.k})`); }
function zoomBy(f) { S.tf.k = Math.max(0.2, Math.min(2.5, S.tf.k * f)); applyTf($("#vp")); }
function fit(L) {
  const c = $("#canvas"); if (!c) return;
  const k = Math.max(0.25, Math.min(1, Math.min(c.clientWidth / L.width, c.clientHeight / L.height)));
  S.tf = { k, x: Math.max(8, (c.clientWidth - L.width * k) / 2), y: 8 }; applyTf($("#vp"));
}
function setupPanZoom(svg, vp) {
  let drag = null;
  svg.addEventListener("pointerdown", e => { if (e.target.closest(".node")) return; drag = { x: e.clientX, y: e.clientY, tx: S.tf.x, ty: S.tf.y, moved: false }; svg.setPointerCapture(e.pointerId); svg.classList.add("drag"); });
  svg.addEventListener("pointermove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; S.tf.x = drag.tx + dx; S.tf.y = drag.ty + dy; applyTf(vp); });
  svg.addEventListener("pointerup", e => { if (drag && drag.moved) svg.addEventListener("click", ev => ev.stopImmediatePropagation(), { capture: true, once: true }); drag = null; svg.classList.remove("drag"); });
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const k0 = S.tf.k, k1 = Math.max(0.2, Math.min(2.5, k0 * Math.exp(-e.deltaY * 0.0015)));
    S.tf.x = mx - ((mx - S.tf.x) / k0) * k1; S.tf.y = my - ((my - S.tf.y) / k0) * k1; S.tf.k = k1; applyTf(vp);
  }, { passive: false });
}

// checks shown as chips for the selected node. No finding for a rule on this node means it passed.
const CHECKS = {
  operation: [["API001", "operationId"], ["API002", "errors"], ["API003", "pagination"], ["API004", "idempotency"], ["API010", "validation"], ["API011", "status code"], ["API012", "no body"], ["X001", "implemented"]],
  rpc: [["PRO003", "own messages"], ["PRO005", "pagination"]],
  table: [["DB001", "primary key"], ["DB002", "fk index"], ["DB003", "money type"], ["DB004", "expand/contract"], ["DB005", "safe columns"]],
  route: [["X002", "documented"]],
  module: [["ARC001", "no cycle"], ["ARC002", "layers"], ["ARC003", "size"], ["RES001", "timeouts"], ["RES003", "errors handled"], ["RES004", "no N+1"]],
};

function findingBlock(f) {
  const meta = R.rules.find(r => r.id === f.ruleId);
  return h("div", { class: "finding" },
    h("div", { class: "row" }, chip(f.severity, f.severity), h("b", { text: f.ruleId }), meta && h("span", { class: "mut", text: meta.title })),
    h("div", { class: "msg", text: f.message }),
    f.evidence && h("div", { class: "code mut", text: f.evidence }),
    f.file && h("button", { class: "link", text: `${f.file}${f.line ? ":" + f.line : ""}`, onclick: () => openFile(f.file, f.line, f) }),
    f.confidence !== "high" && h("div", { class: "mut", text: `confidence: ${f.confidence}` }));
}

function renderPanel() {
  const p = h("aside", { class: "panel" });
  if (!S.sel || !nodeById.has(S.sel)) {
    p.append(h("h2", { text: "Reading the map" }),
      h("p", { class: "sub", text: "Select a node to trace it end to end. Everything it depends on, and everything that depends on it, stays lit; the rest fades." }),
      h("p", { class: "mut", text: "Each node shows its worst finding as a coloured stripe and a count. Green means nothing was found. Heuristic detections (routes, calls) carry a confidence label in their findings." }),
      h("h3", { text: "Worst nodes" }),
      ...[...byNode].map(([id, fs]) => [id, fs]).sort((a, b) => SEV[worst(b[1])] - SEV[worst(a[1])] || b[1].length - a[1].length).slice(0, 8).map(([id, fs]) =>
        h("div", { class: "hop", onclick: () => { S.sel = id; renderMapKeep(); } }, h("span", { class: "dot " + worst(fs) }), h("div", {}, h("div", { class: "t", text: nodeById.get(id)?.label || id }), h("div", { class: "mut", text: `${fs.length} finding(s)` })))));
    return p;
  }
  const n = nodeById.get(S.sel), fs = byNode.get(n.id) || [];
  p.append(h("div", { class: "row" }, chip(KIND_LABEL[n.kind]), worst(fs) ? chip(worst(fs), worst(fs)) : chip("clean", "ok")), h("h2", { text: n.label }));
  if (n.file) p.append(h("button", { class: "link", text: `${n.file}${n.line ? ":" + n.line : ""}`, onclick: () => openFile(n.file, n.line) }));
  const checks = CHECKS[n.kind];
  if (checks) {
    p.append(h("h3", { text: "Contract checks (no finding means pass)" }), h("div", { class: "checks" }, checks.map(([rid, label]) => {
      const hit = fs.filter(f => f.ruleId === rid), w = worst(hit);
      return h("span", { class: "chip " + (w || "ok"), title: R.rules.find(r => r.id === rid)?.title || rid, text: `${w ? "✕" : "✓"} ${label}` });
    })));
  }
  const down = [...reach(n.id, outAdj)], up = [...reach(n.id, inAdj)];
  const hops = down.map(id => nodeById.get(id)).filter(Boolean).sort((a, b) => laneOf(a) - laneOf(b) || a.label.localeCompare(b.label));
  const bad = hops.filter(x => (byNode.get(x.id) || []).length).length + (fs.length ? 1 : 0);
  p.append(h("h3", { text: `End-to-end trace: ${hops.length + 1} hops, ${bad} with findings` }),
    h("p", { class: "mut", text: "Based on static imports and detected routes, so it is approximate. Follow each hop to see its own findings." }),
    hopRow(n, true), ...hops.slice(0, 60).map(x => hopRow(x)), hops.length > 60 && h("div", { class: "mut", text: `…and ${hops.length - 60} more` }));
  if (up.length) p.append(h("h3", { text: `Upstream: ${up.length} node(s) depend on this` }), ...up.slice(0, 12).map(id => nodeById.get(id)).filter(Boolean).map(x => hopRow(x)));
  if (fs.length) p.append(h("h3", { text: `Findings on this node (${fs.length})` }), ...fs.map(findingBlock));
  return p;
}
function hopRow(n, self) {
  const fs = byNode.get(n.id) || [], w = worst(fs);
  return h("div", { class: "hop", onclick: () => { if (!self) { S.sel = n.id; renderMapKeep(); } } },
    h("span", { class: "dot " + (w || "") }),
    h("div", {}, h("div", { class: "t" }, chip(KIND_LABEL[n.kind]), " ", n.label), fs.slice(0, 2).map(f => h("div", { class: "mut", text: `${f.ruleId}: ${f.message}` })), fs.length > 2 && h("div", { class: "mut", text: `+${fs.length - 2} more` })));
}

// ---- file drawer ----------------------------------------------------------------------------------------------------
async function openFile(path, line, finding) {
  const d = $("#drawer"); d.hidden = false;
  clear(d).append(h("header", {}, h("b", { class: "code", text: `${path}${line ? ":" + line : ""}` }), h("div", { class: "grow" }), h("button", { class: "btn", text: "Close", onclick: () => { d.hidden = true; } })), h("div", { class: "empty", text: "Loading…" }));
  try {
    const f = await api("/api/file?path=" + encodeURIComponent(path));
    const lines = f.text.split("\n");
    const lo = line ? Math.max(0, line - 400) : 0, hi = Math.min(lines.length, line ? line + 400 : 1500);
    const src = h("div", { class: "src code" });
    let hit;
    for (let i = lo; i < hi; i++) { const row = h("div", { class: "ln" + (line === i + 1 ? " hit" : "") }, h("span", { text: String(i + 1) }), h("pre", { text: lines[i] || " " })); if (line === i + 1) hit = row; src.append(row); }
    const top = finding && h("div", { style: "padding:10px 16px;border-bottom:1px solid var(--line)" }, h("div", { class: "row" }, chip(finding.severity, finding.severity), h("b", { text: finding.ruleId }), h("span", { text: finding.message })),
      (() => { const m = R.rules.find(r => r.id === finding.ruleId); return m ? h("div", { class: "mut", style: "margin-top:6px" }, h("b", { text: "Why: " }), m.why, h("br"), h("b", { text: "Fix: " }), m.fix) : null; })());
    clear(d).append(h("header", {}, h("b", { class: "code", text: `${path}${line ? ":" + line : ""}` }), h("div", { class: "grow" }), h("button", { class: "btn", text: "Close", onclick: () => { d.hidden = true; } })), top, src);
    if (hit) hit.scrollIntoView({ block: "center" });
  } catch (e) { clear(d).append(h("header", {}, h("b", { text: path }), h("div", { class: "grow" }), h("button", { class: "btn", text: "Close", onclick: () => { d.hidden = true; } })), h("div", { class: "empty", text: e.message })); }
}
document.addEventListener("keydown", e => { if (e.key === "Escape") $("#drawer").hidden = true; });

// ---- findings -------------------------------------------------------------------------------------------------------
function renderFindings() {
  const cats = [...new Set(R.findings.map(f => f.category))];
  const rows = R.findings.filter(f => (S.f.sev === "all" || f.severity === S.f.sev) && (S.f.cat === "all" || f.category === S.f.cat) &&
    (!S.f.q || (f.message + f.ruleId + (f.file || "") + (f.evidence || "")).toLowerCase().includes(S.f.q.toLowerCase())));
  const page = h("div", { class: "page" }, h("h2", { text: "Findings" }), h("p", { class: "sub", text: `${rows.length} of ${R.findings.length}. Select a row to read the code, why it matters, and how to fix it.` }),
    h("div", { class: "row", style: "margin-bottom:12px" },
      h("input", { type: "search", class: "f", placeholder: "Filter", value: S.f.q, "aria-label": "Filter findings", oninput: e => { S.f.q = e.target.value; keepFocus(renderFindings); } }),
      h("select", { class: "f", "aria-label": "Severity", onchange: e => { S.f.sev = e.target.value; renderFindings(); } }, ["all", "error", "warning", "info"].map(s => h("option", { value: s, selected: S.f.sev === s, text: s === "all" ? "all severities" : s }))),
      h("select", { class: "f", "aria-label": "Category", onchange: e => { S.f.cat = e.target.value; renderFindings(); } }, ["all", ...cats].map(s => h("option", { value: s, selected: S.f.cat === s, text: s === "all" ? "all categories" : s })))),
    h("table", {}, h("thead", {}, h("tr", {}, ["Severity", "Rule", "Finding", "Location"].map(t => h("th", { text: t })))),
      h("tbody", {}, rows.slice(0, 400).map(f => h("tr", { class: "click", tabindex: 0, onclick: () => openFile(f.file, f.line, f), onkeydown: e => { if (e.key === "Enter") openFile(f.file, f.line, f); } },
        h("td", {}, chip(f.severity, f.severity)), h("td", {}, h("b", { text: f.ruleId })), h("td", {}, h("div", { text: f.message }), f.confidence !== "high" && h("span", { class: "mut", text: `confidence: ${f.confidence}` })),
        h("td", { class: "code mut", text: f.file ? `${f.file}${f.line ? ":" + f.line : ""}` : "" }))))),
    rows.length > 400 && h("p", { class: "mut", text: `Showing the first 400 of ${rows.length}.` }),
    !rows.length && h("div", { class: "empty", text: R.findings.length ? "No findings match these filters." : "No findings. Nothing in the detected contracts, routes, schema or imports broke a rule." }));
  clear($("#main")).append(page);
}
function keepFocus(fn) { const el = document.activeElement, start = el && el.selectionStart; fn(); const n = $("input[type=search]"); if (n) { n.focus(); n.setSelectionRange(start, start); } }

// ---- contracts ------------------------------------------------------------------------------------------------------
function renderContracts() {
  const group = (title, kind) => {
    const ns = R.graph.nodes.filter(n => n.kind === kind).sort((a, b) => a.label.localeCompare(b.label));
    return h("div", {}, h("h3", { text: `${title} (${ns.length})` }), ns.length ? h("table", {}, h("tbody", {}, ns.map(n => {
      const fs = byNode.get(n.id) || [], w = worst(fs), c = countsBy(fs);
      return h("tr", { class: "click", tabindex: 0, onclick: () => { S.sel = n.id; S._fitted = false; go("map"); } },
        h("td", {}, w ? chip(w, w) : chip("clean", "ok")), h("td", { class: "code", text: n.label }), h("td", { class: "mut", text: fs.length ? `${c.error} err · ${c.warning} warn · ${c.info} info` : "no findings" }), h("td", { class: "code mut", text: n.file ? `${n.file}${n.line ? ":" + n.line : ""}` : "" }));
    }))) : h("p", { class: "mut", text: `No ${title.toLowerCase()} found.` }));
  };
  clear($("#main")).append(h("div", { class: "page" }, h("h2", { text: "Contracts" }), h("p", { class: "sub", text: "Every API operation, gRPC method and table that was found, with its own health. Select one to trace it on the map." }),
    group("HTTP operations", "operation"), group("gRPC methods", "rpc"), group("Tables", "table"), group("HTTP routes found in code", "route")));
}

// ---- diff / impact / org --------------------------------------------------------------------------------------------
function asyncView(title, sub, controls, runFn) {
  const out = h("div", {}, h("div", { class: "empty", text: "Choose options and run." }));
  const page = h("div", { class: "page" }, h("h2", { text: title }), h("p", { class: "sub", text: sub }), controls(() => run()), h("div", { style: "margin-top:18px" }, out));
  async function run() { clear(out).append(h("div", { class: "mut", text: "Working…" })); try { clear(out).append(await runFn()); } catch (e) { clear(out).append(h("div", { class: "finding" }, chip("could not run", "error"), h("p", { text: e.message }))); } }
  clear($("#main")).append(page);
  return run;
}
function renderDiff() {
  const run = asyncView("Contract diff", "Compares the contracts in your working tree with an earlier git ref and classifies every change.",
    go => h("div", { class: "row" }, h("input", { type: "text", value: S.diffBase, "aria-label": "Base git ref", placeholder: "main, HEAD~1, v1.2.0", oninput: e => { S.diffBase = e.target.value; } }), h("button", { class: "btn primary", text: "Compare", onclick: go })),
    async () => {
      const r = await api("/api/diff?base=" + encodeURIComponent(S.diffBase));
      const box = h("div", {}, h("div", { class: "cards" }, [["breaking", "Breaking", r.breaking], ["potentially-breaking", "Potentially breaking", r.potentially], ["safe", "Safe", r.safe]].map(([k, t, n]) => h("div", { class: "card" }, chip(t, k), h("b", { text: String(n) })))));
      for (const [lvl, t] of [["breaking", "Breaking"], ["potentially-breaking", "Potentially breaking"], ["safe", "Safe"]]) {
        const cs = r.changes.filter(c => c.level === lvl); if (!cs.length) continue;
        box.append(h("h3", { text: `${t} (${cs.length})` }), h("table", {}, h("tbody", {}, cs.map(c => h("tr", {}, h("td", {}, chip(c.kind, lvl)), h("td", { class: "code", text: c.subject }), h("td", { text: c.message }))))));
      }
      if (!r.changes.length) box.append(h("div", { class: "empty", text: `No contract changes compared with ${r.base}. Compared: ${r.filesCompared.join(", ") || "no contract files"}.` }));
      return box;
    });
  void run;
}
function ciBar(r) { return h("div", { class: "ci", title: `${(r.lo * 100).toFixed(0)}% to ${(r.hi * 100).toFixed(0)}%` }, h("i", { style: `left:${r.lo * 100}%;width:${(r.hi - r.lo) * 100}%` }), h("u", { style: `left:${r.rate * 100}%` })); }
function renderImpact() {
  const run = asyncView("Agent impact", "Compares AI-assisted commits with everything else in this repository's git history. All analysis is local.",
    go => h("div", { class: "row" }, h("label", { class: "row" }, "Last ", h("input", { type: "text", style: "width:70px", value: String(S.sinceDays), "aria-label": "Days of history", oninput: e => { S.sinceDays = Number(e.target.value) || 0; } }), " days"), h("button", { class: "btn primary", text: "Analyze", onclick: go })),
    async () => {
      const r = await api("/api/impact?since=" + S.sinceDays);
      const c = r.cohorts;
      return h("div", {}, h("div", { class: "cards" },
        h("div", { class: "card" }, h("span", { class: "mut", text: "Agent-assisted commits" }), h("b", { text: String(c.agent.commits) })),
        h("div", { class: "card" }, h("span", { class: "mut", text: "Other commits" }), h("b", { text: String(c.other.commits) })),
        h("div", { class: "card" }, h("span", { class: "mut", text: "Median lines changed" }), h("b", { text: `${c.agent.medianLines} vs ${c.other.medianLines}` }), h("span", { class: "mut", text: "agent vs other" }))),
      h("table", {}, h("thead", {}, h("tr", {}, ["Metric", "Agent-assisted", "Other", "Pooled reading", "Size-adjusted reading"].map(t => h("th", { text: t })))),
        h("tbody", {}, r.comparison.map(m => h("tr", {}, h("td", {}, h("b", { text: m.metric }), h("div", { class: "mut", text: `${m.better} is better` })),
          h("td", {}, h("div", { text: `${pctText(m.agent.rate)}  (${m.agent.k}/${m.agent.n})` }), ciBar(m.agent)), h("td", {}, h("div", { text: `${pctText(m.other.rate)}  (${m.other.k}/${m.other.n})` }), ciBar(m.other)),
          h("td", {}, chip(m.verdict, m.verdict === "agent-assisted is worse" ? "error" : m.verdict === "agent-assisted is better" ? "ok" : "info")), h("td", { class: "mut", text: m.sizeAdjusted || "" }))))),
      h("h3", { text: "Test-touch rate by commit size (agent commits are usually bigger, and size drives every metric)" }),
      h("table", {}, h("thead", {}, h("tr", {}, ["Size", "Agent-assisted", "Other", "Reading"].map(t => h("th", { text: t })))), h("tbody", {}, (r.stratified || []).map(st => { const m = st.comparison[0]; return h("tr", {}, h("td", { text: st.band }), h("td", { text: `${pctText(m.agent.rate)}  (${m.agent.k}/${m.agent.n})` }), h("td", { text: `${pctText(m.other.rate)}  (${m.other.k}/${m.other.n})` }), h("td", {}, chip(m.verdict, m.verdict === "no detectable difference" || m.verdict === "insufficient data" ? "info" : "ok"))); }))),
      h("h3", { text: "How to read this" }), h("ul", {}, r.caveats.map(t => h("li", { text: t }))));
    });
  void run;
}
function renderOrg() {
  const run = asyncView("Organization", "Knowledge concentration, change hotspots and cadence from git history. Authors are pseudonymised.",
    go => h("div", { class: "row" }, h("input", { type: "text", placeholder: "owner/repo (optional, uses your gh login)", style: "width:280px", value: S.github, "aria-label": "GitHub repository", oninput: e => { S.github = e.target.value; } }), h("button", { class: "btn primary", text: "Analyze", onclick: go })),
    async () => {
      const r = await api("/api/org?github=" + encodeURIComponent(S.github));
      const max = Math.max(1, ...r.cadence.weeks.map(w => w.commits));
      const spark = sv("svg", { viewBox: "0 0 240 50", width: 240, height: 50, role: "img", "aria-label": "Weekly commits" }, r.cadence.weeks.map((w, i) => sv("rect", { x: i * 20 + 2, y: 48 - (w.commits / max) * 44, width: 15, height: Math.max(1, (w.commits / max) * 44), rx: 2, fill: "var(--accent)" }, sv("title", { text: `${w.start}: ${w.commits}` }))));
      const box = h("div", {}, h("div", { class: "cards" },
        h("div", { class: "card" }, h("span", { class: "mut", text: "Overall bus factor" }), h("b", { text: String(r.busFactor.overall) })),
        h("div", { class: "card" }, h("span", { class: "mut", text: "Commit trend (last 4 vs prior 4 weeks)" }), h("b", { text: r.cadence.trend })), h("div", { class: "card" }, h("span", { class: "mut", text: "Weekly commits" }), spark),
        h("div", { class: "card" }, h("span", { class: "mut", text: "Tags" }), h("b", { text: String(r.releases.total) }), r.releases.medianGapDays && h("span", { class: "mut", text: `median gap ${r.releases.medianGapDays} days` }))),
      h("h3", { text: "Knowledge concentration by area (lowest bus factor first)" }),
      r.busFactor.dirs.length ? h("table", {}, h("thead", {}, h("tr", {}, ["Area", "Bus factor", "Top author share", "Commits"].map(t => h("th", { text: t })))), h("tbody", {}, r.busFactor.dirs.map(d => h("tr", {}, h("td", { class: "code", text: d.dir }), h("td", {}, chip(String(d.busFactor), d.busFactor <= 1 ? "error" : d.busFactor === 2 ? "warning" : "ok")), h("td", { text: pctText(d.topShare) }), h("td", { text: String(d.commits) }))))) : h("p", { class: "mut", text: "Not enough history per area (needs 10 or more commits)." }),
      h("h3", { text: "Hotspots, last 90 days" }), h("table", {}, h("tbody", {}, r.hotspots.map(x => h("tr", {}, h("td", { class: "code", text: x.file }), h("td", { class: "mut", text: `${x.commits} commits, ${x.lines} lines` }))))));
      if (r.github) box.append(h("h3", { text: "GitHub pull requests" }), r.github.error ? h("p", { class: "mut", text: r.github.error }) : h("div", { class: "cards" },
        h("div", { class: "card" }, h("span", { class: "mut", text: "Time to merge (median / p90)" }), h("b", { text: `${r.github.hoursToMerge.median}h / ${r.github.hoursToMerge.p90}h` })),
        r.github.hoursToFirstReview && h("div", { class: "card" }, h("span", { class: "mut", text: "First review (median)" }), h("b", { text: `${r.github.hoursToFirstReview.median}h` })),
        h("div", { class: "card" }, h("span", { class: "mut", text: "PR size (median lines)" }), h("b", { text: String(r.github.sizeLines.median) })),
        h("div", { class: "card" }, h("span", { class: "mut", text: "Merged / open" }), h("b", { text: `${r.github.mergedPrs} / ${r.github.openPrs}` }))));
      box.append(h("ul", { class: "mut" }, r.notes.map(n => h("li", { text: n }))));
      return box;
    });
  void run;
}

// ---- rules ----------------------------------------------------------------------------------------------------------
function renderRules() {
  const counts = new Map(); for (const f of R.findings) counts.set(f.ruleId, (counts.get(f.ruleId) || 0) + 1);
  const cats = [...new Set(R.rules.map(r => r.category))];
  clear($("#main")).append(h("div", { class: "page" }, h("h2", { text: "Rules" }), h("p", { class: "sub", text: `${R.rules.length} checks. Disable any of them with "disabledRules" in .seamlens.json.` }),
    cats.map(c => h("div", {}, h("h3", { text: c }), R.rules.filter(r => r.category === c).map(r => h("div", { class: "finding" }, h("div", { class: "row" }, chip(r.severity, r.severity), h("b", { text: r.id }), h("span", { text: r.title }), counts.get(r.id) ? chip(`${counts.get(r.id)} now`, "warning") : chip("passing", "ok")),
      h("div", { class: "mut", style: "margin-top:4px" }, h("b", { text: "Why: " }), r.why), h("div", { class: "mut" }, h("b", { text: "Fix: " }), r.fix)))))));
}

// ---- shell ----------------------------------------------------------------------------------------------------------
function render() {
  if (!R) return;
  renderHeader();
  ({ map: renderMap, findings: renderFindings, contracts: renderContracts, diff: renderDiff, impact: renderImpact, org: renderOrg, rules: renderRules }[view] || renderMap)();
}
async function load(refresh) {
  try {
    R = await api("/api/report" + (refresh ? "?refresh=1" : ""));
    index(); S._fitted = false; render();
    if (refresh) toast("Scan complete");
  } catch (e) { clear($("#main")).append(h("div", { class: "empty", text: "Could not load the report: " + e.message })); }
}
$("#rescan").addEventListener("click", () => load(true));
load(false);
})();
