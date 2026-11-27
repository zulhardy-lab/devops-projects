// hpa-demo dashboard: polls /api/state every 2 s and draws it; the load slider sends /burn requests from this page.
// All text from the server is set with textContent (never innerHTML), so pod names can't inject markup.
"use strict";

const SVG = "http://www.w3.org/2000/svg";
const BURN_MS = 20;                 // CPU per /burn request (matches the server's BURN_MS)
const REQUEST_M = 100;              // each pod asks for 100m CPU: "100%" = 100m
const POLL_MS = 2000;
const POINTS = 150;                 // 150 x 2 s = 5 minutes of history
const BUCKETS = 30;                 // 30 x 10 s = 5 minutes of request counts
const LEVELS = [0, 50, 100, 200, 300];

const S = {
  level: 0, credit: 0, inflight: 0,
  cpuHist: [], podHist: [], buckets: Array(BUCKETS).fill(0), bucketAt: Date.now(),
  answers: {}, sentLastSec: [], state: null,
};

const $ = (id) => document.getElementById(id);
function svg(tag, attrs, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function html(tag, attrs, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "style") {  // through CSSOM: the page's CSP blocks style="" attributes
      for (const decl of v.split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    } else e.setAttribute(k, v);
  }
  if (text !== undefined) e.textContent = text;
  return e;
}
function smooth(pts) {
  return pts.map((p, i) => {
    if (i === 0) return `M${p[0]} ${p[1]}`;
    const a = pts[i - 1], mx = (a[0] + p[0]) / 2;
    return `C${mx} ${a[1]} ${mx} ${p[1]} ${p[0]} ${p[1]}`;
  }).join(" ");
}
const hex = (cx, cy, r) => {
  const pts = [0, 1, 2, 3, 4, 5].map((i) => {
    const a = Math.PI / 3 * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  });
  return `M${pts.join("L")}Z`;
};

// ---------- load generation (this page -> Service -> pods) ----------
function setLevel(v) {
  S.level = Math.max(0, Math.min(300, Number(v) || 0));
  $("level").value = S.level;
  $("level-out").textContent = `${S.level}%`;
  $("level").setAttribute("aria-valuetext", `${S.level}% of one pod's CPU`);
  for (const b of $("levels").children) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === S.level));
  hint();
}
function hint() {
  const a = S.state && S.state.autoscaler;
  const target = (a && a.targetPercent) || 50, max = (a && a.max) || 5;
  const want = Math.max(1, Math.min(max, Math.ceil(S.level / target)));
  let t;
  if (S.level === 0) t = "Off: the autoscaler keeps 1 pod.";
  else if (S.level > target * max) t = `More than ${max} pods can handle: it stops at ${max}, and CPU stays above ${target}%.`;
  else t = `${S.level}% of one pod's CPU: expect about ${want} pod${want > 1 ? "s" : ""} at about ${Math.round(S.level / want)}% each.`;
  $("load-hint").textContent = t;
}
function burnOnce() {
  S.inflight++;
  S.buckets[BUCKETS - 1]++;
  S.sentLastSec.push(Date.now());
  fetch("/burn", { cache: "no-store" })
    .then((r) => r.json())
    .then((j) => { if (j && typeof j.pod === "string") S.answers[j.pod] = (S.answers[j.pod] || 0) + 1; })
    .catch(() => {})
    .finally(() => { S.inflight--; });
}
setInterval(() => {
  // requests per second for level L% of 100m, at BURN_MS each: (L/100 * 0.1 core) / (BURN_MS/1000 s)
  const rate = (S.level / 100) * (REQUEST_M / 1000) / (BURN_MS / 1000);
  S.credit = Math.min(S.credit + rate / 10, 50);
  while (S.credit >= 1 && S.inflight < 40) { S.credit -= 1; burnOnce(); }
  if (Date.now() - S.bucketAt >= 10000) { S.buckets = S.buckets.slice(1).concat([0]); S.bucketAt = Date.now(); }
}, 100);

// ---------- console: kubectl get pods --watch, worked out from the difference between two polls ----------
const C = { started: false, prev: null, prevDesired: null, online: null, paused: false, held: [] };
const MAX_LINES = 300;
const pad = (v, n) => String(v).padEnd(n);
const clock = () => new Date().toLocaleTimeString([], { hour12: false });
function age(iso) {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}
function podRow(p) {
  return `${pad(p.name, 30)} ${pad(p.state === "Ready" ? "1/1" : "0/1", 6)} ${pad(p.state, 12)} ${pad(p.node || "-", 8)} ${age(p.created)}`;
}
// parts: [[text, class], ...]; classes: t time, p prompt, h header, add, del, chg, hpa, warn
function say(parts) {
  if (C.paused) { C.held.push(parts); return; }
  const box = $("console");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  const line = html("div");
  for (const [text, cls] of parts) line.append(cls ? html("span", { class: cls }, text) : document.createTextNode(text));
  box.append(line);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}
function consoleUpdate(st) {
  if (!st.available) {
    if (C.online !== false) say([[`${clock()}  `, "t"], [`# no cluster data: ${st.reason || "unknown"}`, "warn"]]);
    C.online = false;
    return;
  }
  if (C.online === false) say([[`${clock()}  `, "t"], ["# cluster data is back", "hpa"]]);
  C.online = true;
  const pods = st.pods || [], now = new Map(pods.map((p) => [p.name, p]));
  if (!C.started) {
    C.started = true;
    $("console-cmd").textContent = `kubectl get pods -n ${st.namespace || "?"} --watch`;
    say([["$ ", "p"], [`kubectl get pods -n ${st.namespace || "?"} --watch`]]);
    say([[`${pad("", 10)}${pad("NAME", 30)} ${pad("READY", 6)} ${pad("STATUS", 12)} ${pad("NODE", 8)} AGE`, "h"]]);
    for (const p of pods) say([[`${clock()}  `, "t"], ["  "], [podRow(p)]]);
  } else {
    for (const p of pods) {
      const old = C.prev.get(p.name);
      if (!old) say([[`${clock()}  `, "t"], ["+ ", "add"], [podRow(p), "add"], ["   created", "add"]]);
      else if (old.state !== p.state) say([[`${clock()}  `, "t"], ["~ ", "chg"], [podRow(p), p.state === "Terminating" ? "del" : "chg"]]);
    }
    for (const [name, old] of C.prev) {
      if (!now.has(name)) say([[`${clock()}  `, "t"], ["- ", "del"], [`${pad(name, 30)} ${pad("0/1", 6)} ${pad("Deleted", 12)} ${pad(old.node || "-", 8)} -`, "del"]]);
    }
  }
  C.prev = now;
  const a = st.autoscaler;
  if (a && a.desired !== undefined && a.desired !== null) {
    if (C.prevDesired !== null && a.desired !== C.prevDesired) {
      const why = a.cpuPercent !== null && a.cpuPercent !== undefined ? ` (CPU ${a.cpuPercent}%, target ${a.targetPercent}%)` : "";
      say([[`${clock()}  `, "t"], ["  "], [`horizontalpodautoscaler/hpa-demo: ${a.desired > C.prevDesired ? "scale out" : "scale in"} ${C.prevDesired} \u2192 ${a.desired} pods${why}`, "hpa"]]);
    }
    C.prevDesired = a.desired;
  }
}

// ---------- polling ----------
async function poll() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    S.state = await r.json();
  } catch (e) {
    S.state = { available: false, reason: "The app didn't answer" };
  }
  const st = S.state, a = st.autoscaler;
  const pods = st.pods || [];
  const measured = pods.filter((p) => p.cpuPercent !== null && p.state === "Ready");
  const avg = a && a.cpuPercent !== null && a.cpuPercent !== undefined ? a.cpuPercent
    : (measured.length ? Math.round(measured.reduce((s, p) => s + p.cpuPercent, 0) / measured.length) : null);
  S.cpuHist = S.cpuHist.concat([avg === null ? 0 : avg]).slice(-POINTS);
  S.podHist = S.podHist.concat([pods.filter((p) => p.state !== "Terminating").length]).slice(-POINTS);
  render(avg);
  consoleUpdate(S.state);
}

// ---------- drawing ----------
function render(avg) {
  const st = S.state || {}, a = st.autoscaler, pods = st.pods || [];
  const target = (a && a.targetPercent) || 50, max = (a && a.max) || 5, min = (a && a.min) || 1;
  const live = pods.filter((p) => p.state !== "Terminating");
  const ready = pods.filter((p) => p.state === "Ready");

  $("notice").hidden = !!st.available;
  if (!st.available) $("notice").textContent = `No cluster data: ${st.reason || "unknown"}. The load slider still works.`;
  $("live").className = st.available ? "chip live" : "chip off";
  $("live-text").textContent = st.available ? "Live" : "No cluster data";
  $("ns").textContent = st.namespace ? `Namespace ${st.namespace}` : "Not in a cluster";
  $("served").textContent = st.servedBy || "…";
  $("pod-count").textContent = String(live.length);
  $("pod-max").textContent = `of ${max} max`;
  $("pod-note").textContent = `min ${min} · the autoscaler decides the rest`;
  hint();

  drawMap(pods, target);
  drawPodChart(max);
  drawBars(pods, target);
  drawCpuChart(avg, target);
  drawRings(avg, live.length, ready.length, max);
  drawRps();
  drawAutoscaler(a, avg, target, live.length);
}

function podColour(p, target) {
  if (p.state === "Starting") return { fill: "#FFFFFF", stroke: "#1F5EFF", dash: "4 3" };
  if (p.state === "Terminating") return { fill: "#E4E9F2", stroke: "#C9D2E3", dash: "0" };
  const busy = p.cpuPercent !== null && p.cpuPercent > target;
  return { fill: busy ? "#FFB81C" : "#17C9A1", stroke: "#FFFFFF", dash: "0" };
}

function drawMap(pods, target) {
  const m = $("map");
  m.replaceChildren();
  const nodes = [...new Set(pods.map((p) => p.node).filter(Boolean))].sort().slice(0, 3);
  $("node-count").textContent = nodes.length ? `${nodes.length} app node${nodes.length > 1 ? "s" : ""}` : "no pods yet";
  const lines = svg("g", { stroke: "#C9D2E3", "stroke-width": "1.5", fill: "none" });
  m.append(lines);
  m.append(svg("path", { d: hex(180, 70, 58), fill: "#F4F6FA", stroke: "#10264F", "stroke-width": "1.5" }));
  m.append(svg("text", { x: 180, y: 68, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: "#10264F" }, "control plane"));
  m.append(svg("text", { x: 180, y: 83, "text-anchor": "middle", "font-size": 9, fill: "#5B6B86" }, "API · metrics · HPA"));

  const layout = { 1: [[180, 64]], 2: [[96, 60], [264, 60]], 3: [[64, 54], [180, 54], [296, 54]] }[nodes.length || 1];
  const slots = [[-22, -10], [22, -10], [0, 10], [-20, 30], [20, 30], [0, -30]];
  const dots = [];
  (nodes.length ? nodes : [""]).forEach((node, i) => {
    const [cx, r] = layout[i], cy = 274;
    m.append(svg("path", { d: hex(cx, cy, r), fill: "#FFF8E6", stroke: "#FFB81C", "stroke-width": "2" }));
    m.append(svg("text", { x: cx, y: cy - r + 22, "text-anchor": "middle", "font-size": 12, "font-weight": 600, fill: "#10264F" }, node || "no pods yet"));
    pods.filter((p) => p.node === node).slice(0, 6).forEach((p, j) => {
      const k = r / 64, x = cx + slots[j][0] * k, y = cy + 6 + slots[j][1] * k;
      lines.append(svg("path", { d: `M180 162L${x.toFixed(1)} ${y.toFixed(1)}`, "stroke-dasharray": p.state === "Ready" ? "0" : "4 4" }));
      const c = podColour(p, target);
      const dot = svg("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: (11 * Math.max(k, 0.8)).toFixed(1), fill: c.fill, stroke: c.stroke, "stroke-width": 2, "stroke-dasharray": c.dash });
      dot.append(svg("title", {}, `${p.name}: ${p.state}${p.cpuPercent !== null ? `, CPU ${p.cpuPercent}%` : ""}`));
      dots.push(dot);
    });
  });
  m.append(...dots);
  m.append(svg("circle", { cx: 180, cy: 162, r: 28, fill: "#10264F" }));
  m.append(svg("text", { x: 180, y: 159, "text-anchor": "middle", "font-size": 9, fill: "#FFFFFF" }, "Service"));
  m.append(svg("text", { x: 180, y: 172, "text-anchor": "middle", "font-size": 9, fill: "#FFB81C" }, `${rpsNow()}/s`));
  const live = pods.filter((p) => p.state !== "Terminating").length;
  m.setAttribute("aria-label", `Cluster map: ${live} pods on ${nodes.join(", ") || "no node yet"}, behind one Service`);
}

function drawPodChart(max) {
  const c = $("pod-chart");
  c.replaceChildren();
  if (S.podHist.length < 2) return;
  const step = 300 / (POINTS - 1), off = 300 - (S.podHist.length - 1) * step;
  const pts = S.podHist.map((v, i) => [off + i * step, 92 - (v / max) * 80]);
  const d = smooth(pts);
  const g = svg("linearGradient", { id: "pg", x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(svg("stop", { offset: 0, "stop-color": "#17C9A1" }), svg("stop", { offset: 1, "stop-color": "#17C9A1", "stop-opacity": "0.08" }));
  const defs = svg("defs"); defs.append(g);
  c.append(defs, svg("path", { d: `${d} L300 100 L${off} 100 Z`, fill: "url(#pg)" }), svg("path", { d, fill: "none", stroke: "#10264F", "stroke-width": 3 }));
}

function drawBars(pods, target) {
  const ul = $("pod-bars");
  ul.replaceChildren();
  if (!pods.length) { ul.append(html("li", { class: "muted small" }, "No pods to show.")); return; }
  for (const p of pods.slice(0, 6)) {
    const v = p.cpuPercent, busy = v !== null && v > target;
    const li = html("li");
    li.append(html("span", { class: "muted small" }, `${p.name}${p.state !== "Ready" ? ` · ${p.state.toLowerCase()}` : ""}`));
    const row = html("div", { class: "bar-row" }), track = html("div", { class: "track" });
    track.append(html("div", { class: "fill", style: `width:${Math.min(v || 0, 100)}%;background:${busy ? "#FFB81C" : "#17C9A1"}` }));
    row.append(track, html("span", { class: "pct", style: `color:${busy ? "#B7791F" : "#0B7A60"}` }, v === null ? "…" : `${v}%`));
    li.append(row);
    ul.append(li);
  }
}

function drawCpuChart(avg, target) {
  const c = $("cpu-chart");
  c.replaceChildren();
  const y = (v) => 180 - Math.min(v, 150) * (160 / 150);
  const defs = svg("defs"), g = svg("linearGradient", { id: "cg", x1: 0, y1: 0, x2: 0, y2: 1 });
  g.append(svg("stop", { offset: 0, "stop-color": "#FFB81C", "stop-opacity": "0.9" }), svg("stop", { offset: 1, "stop-color": "#FFB81C", "stop-opacity": "0.05" }));
  defs.append(g); c.append(defs);
  for (const [t, v] of [["150%", 150], ["0%", 0]]) c.append(svg("text", { x: 0, y: y(v) + 4, "font-size": 11, fill: "#5B6B86" }, t));
  c.append(svg("path", { d: "M44 20H700M44 180H700", stroke: "#E4E9F2" }));
  c.append(svg("path", { d: `M44 ${y(target)}H700`, stroke: "#1F5EFF", "stroke-width": 1.5, "stroke-dasharray": "6 6" }));
  c.append(svg("text", { x: 0, y: y(target) + 4, "font-size": 11, fill: "#1F5EFF" }, `${target}%`));
  c.append(svg("text", { x: 44, y: 210, "font-size": 11, fill: "#5B6B86" }, "5 min ago"));
  c.append(svg("text", { x: 672, y: 210, "text-anchor": "end", "font-size": 11, fill: "#5B6B86" }, "now"));
  if (S.cpuHist.length < 2) return;
  const step = 628 / (POINTS - 1), off = 672 - (S.cpuHist.length - 1) * step;
  const pts = S.cpuHist.map((v, i) => [off + i * step, y(v)]);
  const d = smooth(pts);
  c.append(svg("path", { d: `${d} L672 180 L${off} 180 Z`, fill: "url(#cg)" }), svg("path", { d, fill: "none", stroke: "#10264F", "stroke-width": 3 }));
  if (avg === null) return;
  const ny = y(avg);
  c.append(svg("circle", { cx: 672, cy: ny, r: 6, fill: "#1F5EFF", stroke: "#FFFFFF", "stroke-width": 2 }));
  const ty = ny < 60 ? ny + 16 : ny - 44;
  c.append(svg("rect", { x: 600, y: ty, width: 92, height: 28, rx: 14, fill: "#FFFFFF", stroke: "#10264F", "stroke-width": 1.5 }));
  c.append(svg("text", { x: 646, y: ty + 19, "text-anchor": "middle", "font-size": 13, "font-weight": 600, fill: "#10264F" }, `${avg}% now`));
  c.setAttribute("aria-label", `Average CPU is ${avg}% of each pod's request; the target is ${target}%`);
}

function drawRings(avg, live, ready, max) {
  const recent = Object.keys(S.answers).length;
  const items = [
    [avg === null ? 0 : avg, "#FFB81C", "#B7791F", avg === null ? "…" : `${avg}%`, "Average CPU"],
    [live / max * 100, "#17C9A1", "#0B7A60", `${live} / ${max}`, "Pods in use"],
    [live ? ready / live * 100 : 0, "#1F5EFF", "#1F5EFF", `${ready} / ${live}`, "Pods ready"],
    [live ? Math.min(recent / live, 1) * 100 : 0, "#10264F", "#10264F", String(recent), "Pods that answered you"],
  ];
  const box = $("rings");
  box.replaceChildren();
  for (const [v, col, txt, value, label] of items) {
    const card = html("div", { class: "card ring" });
    const r = svg("svg", { width: 52, height: 52, viewBox: "0 0 52 52", "aria-hidden": "true" });
    r.append(svg("circle", { cx: 26, cy: 26, r: 21, fill: "none", stroke: "#E4E9F2", "stroke-width": 6 }));
    r.append(svg("circle", { cx: 26, cy: 26, r: 21, fill: "none", stroke: col, "stroke-width": 6, "stroke-linecap": "round", "stroke-dasharray": `${(Math.min(v, 100) / 100 * 131.9).toFixed(1)} 131.9`, transform: "rotate(-90 26 26)" }));
    const t = html("div");
    t.append(html("strong", { style: `color:${txt}` }, value), html("span", { class: "muted small" }, label));
    card.append(r, t);
    box.append(card);
  }
}

function rpsNow() {
  const now = Date.now();
  S.sentLastSec = S.sentLastSec.filter((t) => now - t < 1000);
  return S.sentLastSec.length;
}

function drawRps() {
  const box = $("rps"), top = Math.max(10, ...S.buckets);
  box.replaceChildren();
  for (const v of S.buckets) box.append(html("div", { style: `height:${Math.max(1, Math.round(v / top * 100))}%`, title: `${v} requests in 10 s` }));
  $("rps-now").textContent = `${rpsNow()}/s`;
  const parts = Object.entries(S.answers).sort().map(([pod, n]) => `${pod.split("-").pop()} ×${n}`);
  $("answers").textContent = parts.length ? `Answered by: ${parts.join(" · ")}` : "Answered by: nobody yet";
}

function drawAutoscaler(a, avg, target, live) {
  let state = "Unknown", note = "No autoscaler data yet.", colour = "#5B6B86";
  if (a) {
    if (a.desired > a.current) { state = `Scaling out to ${a.desired}`; note = `CPU above ${target}%: adding pods.`; colour = "#B7791F"; }
    else if (a.desired < a.current) { state = `Scaling in to ${a.desired}`; note = "Quiet for a minute: removing pods."; colour = "#B7791F"; }
    else if (avg !== null && avg > target && live >= a.max) { state = `At the maximum (${a.max})`; note = `It can't add more pods, so CPU stays above ${target}%.`; colour = "#B7791F"; }
    else if (avg !== null && avg < target && live > a.min) { state = "Waiting to scale in"; note = `Below ${target}%: it removes pods after 60 s.`; colour = "#1F5EFF"; }
    else { state = "Steady"; note = `CPU is at or below ${target}%.`; colour = "#0B7A60"; }
  }
  $("hpa-state").textContent = state;
  $("hpa-state").style.color = colour;
  $("hpa-note").textContent = note;
}

// ---------- start ----------
document.addEventListener("DOMContentLoaded", () => {
  for (const v of LEVELS) {
    const b = html("button", { type: "button", "data-v": String(v), "aria-pressed": String(v === 0) }, v === 0 ? "Off" : `${v}%`);
    b.addEventListener("click", () => setLevel(v));
    $("levels").append(b);
  }
  $("level").addEventListener("input", (e) => setLevel(e.target.value));
  $("console-pause").addEventListener("click", (e) => {
    C.paused = !C.paused;
    e.currentTarget.setAttribute("aria-pressed", String(C.paused));
    e.currentTarget.textContent = C.paused ? `Resume${C.held.length ? ` (${C.held.length})` : ""}` : "Pause";
    if (!C.paused) { const held = C.held; C.held = []; held.forEach(say); }
  });
  $("console-clear").addEventListener("click", () => { $("console").replaceChildren(); C.held = []; });
  setLevel(0);
  poll();
  setInterval(poll, POLL_MS);
});
