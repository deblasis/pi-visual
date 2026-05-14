// spa/app.js — WebSocket client, block renderers, input handler

// ─── DOM refs ───
const blocksContainer = document.getElementById("blocks-container");
const emptyState = document.getElementById("empty-state");
const statusIndicator = document.getElementById("status-indicator");
const textInput = document.getElementById("text-input");
const sendBtn = document.getElementById("send-btn");
const pasteBtn = document.getElementById("paste-btn");
const imagePreview = document.getElementById("image-preview");
const previewFilename = document.getElementById("preview-filename");
const removeImageBtn = document.getElementById("remove-image");
const reconnectOverlay = document.getElementById("reconnect-overlay");

let ws = null;
let reconnectAttempts = 0;
const MAX_DELAY = 30000;
let pendingImage = null;

// ─── Helpers ───
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = typeof s === "string" ? s : JSON.stringify(s);
  return d.innerHTML;
}

function sendToServer(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendInteraction(blockId, action, value, values) {
  const msg = { type: "interaction", blockId, action };
  if (value !== undefined) msg.value = value;
  if (values !== undefined) msg.values = values;
  sendToServer(msg);
}

function sendTellMore(label) { sendToServer({ type: "text", text: "Tell me more about: " + label }); }
function sendProsCons(opts) {
  sendToServer({ type: "text", text: "Compare these options with pros and cons: " + opts.map(o => o.title || o.value).join(", ") });
}

function scrollToBottom() { blocksContainer.scrollTop = blocksContainer.scrollHeight; }

// ─── WebSocket ───
function wsUrl() {
  const l = window.location;
  return (l.protocol === "https:" ? "wss:" : "ws:") + "//" + l.host;
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => { reconnectAttempts = 0; reconnectOverlay.classList.add("hidden"); statusIndicator.textContent = "● Connected"; statusIndicator.className = "text-xs text-green-400"; };
  ws.onmessage = (e) => { try { handleMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { statusIndicator.textContent = "○ Disconnected"; statusIndicator.className = "text-xs text-zinc-500"; reconnectOverlay.classList.remove("hidden"); scheduleReconnect(); };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  const d = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_DELAY);
  reconnectAttempts++;
  setTimeout(connect, d);
}

// ─── Message handling ───
function handleMessage(msg) {
  switch (msg.type) {
    case "connected": break;
    case "history":
      if (msg.blocks?.length) { emptyState.classList.add("hidden"); msg.blocks.forEach(b => renderBlock(b)); }
      break;
    case "blocks":
      emptyState.classList.add("hidden");
      msg.blocks.forEach(b => renderBlock(b));
      scrollToBottom();
      break;
    case "update": updateBlock(msg.blockId, msg.patch); break;
    case "clear":
      blocksContainer.innerHTML = "";
      emptyState.classList.remove("hidden");
      blocksContainer.appendChild(emptyState);
      break;
  }
}

function updateBlock(id, patch) {
  const el = document.getElementById(id);
  if (!el) return;
  for (const [k, v] of Object.entries(patch)) el.dataset[k] = JSON.stringify(v);
}

// ─── Renderer dispatcher ───
const R = {};

async function renderBlock(block) {
  const wrap = document.createElement("div");
  wrap.id = block.id;
  wrap.className = "block-wrapper";
  const cls = block.style || "";
  try {
    const r = R[block.type];
    if (r) { const c = await r(block.content, block.id, cls); if (c) wrap.appendChild(c); }
    else {
      wrap.innerHTML = `<div class="block-card ${cls}"><p class="text-zinc-500 text-xs mb-2">Unknown block type: ${escapeHtml(block.type)}</p><pre class="text-xs text-zinc-600 overflow-auto">${escapeHtml(JSON.stringify(block.content, null, 2))}</pre></div>`;
    }
  } catch {
    wrap.innerHTML = `<div class="block-card border-red-900 ${cls}"><p class="text-red-400 text-xs mb-2">⚠ Rendering error</p><pre class="text-xs text-zinc-600 overflow-auto">${escapeHtml(JSON.stringify(block.content, null, 2))}</pre></div>`;
  }
  blocksContainer.appendChild(wrap);
}

// ─── RENDERERS ───

// explanation
R.explanation = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  d.innerHTML = `${c.title ? `<h3 class="text-lg font-semibold text-zinc-100 mb-2">${escapeHtml(c.title)}</h3>` : ""}${c.body ? `<p class="text-sm text-zinc-300 leading-relaxed">${escapeHtml(c.body)}</p>` : ""}`;
  return d;
};

// code
R.code = async (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  if (c.language) d.innerHTML = `<div class="text-xs text-zinc-500 mb-2">${escapeHtml(c.language)}</div>`;
  const pre = document.createElement("pre"); pre.className = "text-sm overflow-x-auto rounded-lg bg-zinc-950 p-3";
  try {
    if (window.shiki) {
      const h = await shiki.createHighlighter({ themes: ["github-dark"], langs: c.language ? [c.language] : ["text"] });
      pre.innerHTML = h.codeToHtml(c.code || "", { lang: c.language || "text", theme: "github-dark" });
    } else pre.textContent = c.code || "";
  } catch { pre.textContent = c.code || ""; }
  d.appendChild(pre); return d;
};

// markdown
R.markdown = (c, _id, cls) => {
  const t = c.content || c; const d = document.createElement("div");
  d.className = `block-card prose prose-invert prose-sm max-w-none ${cls}`;
  try { if (window.marked) d.innerHTML = marked.parse(t || ""); else d.textContent = t || ""; } catch { d.textContent = t || ""; }
  d.querySelectorAll("script").forEach(s => s.remove());
  return d;
};

// list
R.list = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  const ul = document.createElement("div"); ul.className = "space-y-1";
  for (const it of c.items || []) {
    const row = document.createElement("div"); row.className = "flex items-center gap-3 py-1.5 px-3 rounded-lg hover:bg-zinc-800/50";
    if (it.icon) row.innerHTML += `<span class="text-zinc-500">${escapeHtml(it.icon)}</span>`;
    row.innerHTML += `<span class="text-sm text-zinc-200">${escapeHtml(it.label)}</span>`;
    if (it.badge) row.innerHTML += `<span class="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full">${escapeHtml(it.badge)}</span>`;
    const b = document.createElement("button"); b.className = "tell-more-btn ml-auto"; b.textContent = "Tell me more →"; b.onclick = () => sendTellMore(it.label);
    row.appendChild(b); ul.appendChild(row);
  }
  d.appendChild(ul); return d;
};

// choice
R.choice = (c, id, cls) => {
  const w = document.createElement("div"); w.className = cls;
  if (c.prompt) w.innerHTML += `<p class="text-sm text-zinc-300 mb-3">${escapeHtml(c.prompt)}</p>`;
  const grid = document.createElement("div"); grid.className = c.multi ? "space-y-2" : "grid grid-cols-1 sm:grid-cols-2 gap-3";
  const sel = c.multi ? new Set() : null;
  for (const o of c.options || []) {
    const card = document.createElement("div"); card.className = "choice-card";
    card.innerHTML = `<h4 class="font-medium text-zinc-100">${escapeHtml(o.title)}</h4>${o.description ? `<p class="text-xs text-zinc-400 mt-1">${escapeHtml(o.description)}</p>` : ""}`;
    const mb = document.createElement("button"); mb.className = "tell-more-btn"; mb.textContent = "Tell me more →"; mb.onclick = e => { e.stopPropagation(); sendTellMore(o.title); };
    card.appendChild(mb);
    if (c.multi) {
      card.onclick = () => { if (sel.has(o.value)) { sel.delete(o.value); card.classList.remove("selected"); } else { sel.add(o.value); card.classList.add("selected"); } };
    } else {
      card.onclick = () => { grid.querySelectorAll(".choice-card").forEach(x => x.classList.remove("selected")); card.classList.add("selected"); sendInteraction(id, "select", o.value); };
    }
    grid.appendChild(card);
  }
  w.appendChild(grid);
  if (c.multi) {
    const sb = document.createElement("button"); sb.className = "mt-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"; sb.textContent = "Submit Selection";
    sb.onclick = () => sendInteraction(id, "submit", undefined, Object.fromEntries([...sel].map((v, i) => ["opt" + i, v])));
    w.appendChild(sb);
  }
  if (c.options?.length >= 2) { const pb = document.createElement("button"); pb.className = "pros-cons-btn"; pb.innerHTML = "⚖️ Pros/Cons Analysis"; pb.onclick = () => sendProsCons(c.options); w.appendChild(pb); }
  return w;
};

// form
R.form = (c, id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  const f = document.createElement("div"); f.className = "space-y-4";
  for (const fl of c.fields || []) {
    const fd = document.createElement("div");
    const lb = document.createElement("label"); lb.className = "block text-sm font-medium text-zinc-300 mb-1"; lb.textContent = fl.label + (fl.required ? " *" : "");
    fd.appendChild(lb);
    let inp;
    if (fl.type === "select" && fl.options) {
      inp = document.createElement("select"); inp.className = "form-select";
      for (const o of fl.options) { const op = document.createElement("option"); op.value = typeof o === "string" ? o : o.value; op.textContent = typeof o === "string" ? o : (o.label || o.value); inp.appendChild(op); }
    } else if (fl.type === "textarea") { inp = document.createElement("textarea"); inp.className = "form-input"; inp.rows = 3; }
    else { inp = document.createElement("input"); inp.className = "form-input"; inp.type = fl.type || "text"; }
    inp.name = fl.name; inp.required = !!fl.required; fd.appendChild(inp); f.appendChild(fd);
  }
  const sb = document.createElement("button"); sb.className = "bg-blue-600 hover:bg-blue-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"; sb.textContent = "Submit";
  sb.onclick = () => { const v = {}; f.querySelectorAll("input,select,textarea").forEach(e => v[e.name] = e.value); sendInteraction(id, "submit", undefined, v); };
  f.appendChild(sb); d.appendChild(f); return d;
};

// checklist
R.checklist = (c, id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  const ul = document.createElement("div"); ul.className = "space-y-1";
  for (const it of c.items || []) {
    const row = document.createElement("div"); row.className = `checklist-item ${it.checked ? "checked" : ""}`;
    const ch = document.createElement("span"); ch.className = it.checked ? "text-green-400" : "text-zinc-600"; ch.textContent = it.checked ? "✓" : "○";
    const lb = document.createElement("span"); lb.className = "checklist-label text-sm text-zinc-200"; lb.textContent = it.label;
    row.appendChild(ch); row.appendChild(lb);
    row.onclick = () => { it.checked = !it.checked; ch.textContent = it.checked ? "✓" : "○"; ch.className = it.checked ? "text-green-400" : "text-zinc-600"; row.classList.toggle("checked", it.checked); sendInteraction(id, "toggle", it.label); };
    ul.appendChild(row);
  }
  d.appendChild(ul); return d;
};

// tree
R.tree = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  function render(items, container) {
    for (const it of items || []) {
      const node = document.createElement("div"); const has = it.children?.length > 0;
      const label = document.createElement("div"); label.className = "flex items-center gap-2 py-1 cursor-pointer hover:bg-zinc-800/50 rounded px-2";
      if (has) { const tg = document.createElement("span"); tg.className = "tree-toggle text-xs"; tg.textContent = "▼ "; label.appendChild(tg); }
      else { const sp = document.createElement("span"); sp.textContent = "  "; label.appendChild(sp); }
      if (it.icon) label.innerHTML += `<span class="text-zinc-500">${escapeHtml(it.icon)}</span>`;
      label.innerHTML += `<span class="text-sm text-zinc-200">${escapeHtml(it.label)}</span>`;
      const mb = document.createElement("button"); mb.className = "tell-more-btn ml-auto"; mb.textContent = "Tell me more →"; mb.onclick = e => { e.stopPropagation(); sendTellMore(it.label); }; label.appendChild(mb);
      node.appendChild(label);
      if (has) {
        const cc = document.createElement("div"); cc.className = "tree-node"; render(it.children, cc); node.appendChild(cc);
        label.onclick = () => { cc.classList.toggle("hidden"); const t = label.querySelector(".tree-toggle"); if (t) t.textContent = cc.classList.contains("hidden") ? "▶ " : "▼ "; };
      }
      container.appendChild(node);
    }
  }
  render(c.items || [], d); return d;
};

// table
R.table = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card overflow-x-auto ${cls}`;
  const t = document.createElement("table"); t.className = "data-table";
  const thead = document.createElement("thead"); const hr = document.createElement("tr");
  for (const h of c.headers || []) { const th = document.createElement("th"); th.textContent = h; hr.appendChild(th); }
  thead.appendChild(hr); t.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const row of c.rows || []) {
    const tr = document.createElement("tr"); tr.style.cursor = "pointer"; tr.onclick = () => sendTellMore(row.join(" "));
    for (const cell of row) { const td = document.createElement("td"); td.textContent = typeof cell === "string" ? cell : JSON.stringify(cell); tr.appendChild(td); }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody); d.appendChild(t); return d;
};

// steps
R.steps = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls} space-y-4`;
  for (let i = 0; i < (c.items || []).length; i++) {
    const it = c.items[i]; const st = it.status || (i === 0 ? "current" : "pending");
    const sd = document.createElement("div"); sd.className = "step-item";
    const ind = document.createElement("div"); ind.className = `step-indicator ${st}`; ind.textContent = st === "done" ? "✓" : String(i + 1);
    const tx = document.createElement("div");
    tx.innerHTML = `<div class="text-sm font-medium text-zinc-200">${escapeHtml(it.title)}</div>${it.description ? `<div class="text-xs text-zinc-400 mt-1">${escapeHtml(it.description)}</div>` : ""}`;
    sd.appendChild(ind); sd.appendChild(tx); d.appendChild(sd);
  }
  return d;
};

// flowchart
R.flowchart = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card graph-container ${cls}`;
  const nodes = c.nodes || [], edges = c.edges || [];
  const h = Math.max(nodes.length * 60 + 40, 200);
  const svg = d3.select(d).append("svg").attr("width", "100%").attr("height", h);
  const w = 600;
  const nm = {}; nodes.forEach((n, i) => nm[n.id] = { ...n, x: w / 2, y: 40 + i * 70 });
  for (const e of edges) {
    const f = nm[e.from], t = nm[e.to]; if (!f || !t) continue;
    svg.append("line").attr("x1", f.x).attr("y1", f.y + 20).attr("x2", t.x).attr("y2", t.y - 20).attr("stroke", "#52525b").attr("stroke-width", 1.5);
    if (e.label) svg.append("text").attr("x", (f.x + t.x) / 2 + 5).attr("y", (f.y + t.y) / 2 + 4).attr("fill", "#a1a1aa").style("font-size", "11px").text(e.label);
  }
  for (const n of Object.values(nm)) {
    const g = svg.append("g").attr("transform", `translate(${n.x},${n.y})`);
    g.append("rect").attr("x", -60).attr("y", -15).attr("width", 120).attr("height", 30).attr("rx", 6).attr("fill", "#18181b").attr("stroke", "#3b82f6").attr("stroke-width", 1.5);
    g.append("text").attr("text-anchor", "middle").attr("dy", 5).attr("fill", "#f4f4f5").style("font-size", "12px").text(n.label);
  }
  return d;
};

// state_machine
R.state_machine = (c, id, cls) => {
  const nodes = (c.states || []).map(s => ({ ...s }));
  const edges = (c.transitions || []).map(t => ({ from: t.from, to: t.to, label: t.trigger }));
  return R.flowchart({ nodes, edges }, id, cls);
};

// comparison
R.comparison = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = cls;
  const g = document.createElement("div"); g.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3";
  for (const it of c.items || []) {
    const card = document.createElement("div"); card.className = "block-card";
    let h = `<h4 class="font-medium text-zinc-100 mb-3">${escapeHtml(it.title)}</h4>`;
    if (it.attributes) { h += '<div class="space-y-1.5">'; for (const [k, v] of Object.entries(it.attributes)) h += `<div class="flex justify-between text-sm"><span class="text-zinc-400">${escapeHtml(k)}</span><span class="text-zinc-200">${escapeHtml(String(v))}</span></div>`; h += "</div>"; }
    card.innerHTML = h;
    const mb = document.createElement("button"); mb.className = "tell-more-btn mt-3"; mb.textContent = "Tell me more →"; mb.onclick = () => sendTellMore(it.title);
    card.appendChild(mb); g.appendChild(card);
  }
  d.appendChild(g); return d;
};

// pros_cons
R.pros_cons = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  if (c.topic) d.innerHTML += `<h4 class="font-medium text-zinc-100 mb-4">${escapeHtml(c.topic)}</h4>`;
  const g = document.createElement("div"); g.className = "grid grid-cols-1 sm:grid-cols-2 gap-4";
  const pd = document.createElement("div"); pd.innerHTML = '<h5 class="text-green-400 text-sm font-medium mb-2">✓ Pros</h5>';
  const pl = document.createElement("ul"); pl.className = "space-y-1.5";
  for (const p of c.pros || []) { const li = document.createElement("li"); li.className = "text-sm text-zinc-300"; li.innerHTML = `<span class="text-green-400 mr-1">+</span> ${escapeHtml(p)}`; pl.appendChild(li); }
  pd.appendChild(pl); g.appendChild(pd);
  const cd = document.createElement("div"); cd.innerHTML = '<h5 class="text-red-400 text-sm font-medium mb-2">✗ Cons</h5>';
  const cl = document.createElement("ul"); cl.className = "space-y-1.5";
  for (const co of c.cons || []) { const li = document.createElement("li"); li.className = "text-sm text-zinc-300"; li.innerHTML = `<span class="text-red-400 mr-1">-</span> ${escapeHtml(co)}`; cl.appendChild(li); }
  cd.appendChild(cl); g.appendChild(cd);
  d.appendChild(g); return d;
};

// diff
R.diff = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = cls;
  if (customElements.get("diffs-container")) {
    const el = document.createElement("diffs-container");
    el.setAttribute("old", c.old || ""); el.setAttribute("new", c.new || "");
    if (c.language) el.setAttribute("language", c.language);
    d.appendChild(el); return d;
  }
  d.className += " block-card";
  const g = document.createElement("div"); g.className = "grid grid-cols-2 gap-0 text-xs font-mono";
  const l = document.createElement("div"); l.className = "bg-zinc-950 p-3 rounded-l-lg border border-zinc-800 overflow-x-auto";
  l.innerHTML = `<div class="text-zinc-500 mb-2">Original</div><pre class="text-red-300">${escapeHtml(c.old || "")}</pre>`;
  const r = document.createElement("div"); r.className = "bg-zinc-950 p-3 rounded-r-lg border border-zinc-800 border-l-0 overflow-x-auto";
  r.innerHTML = `<div class="text-zinc-500 mb-2">Modified</div><pre class="text-green-300">${escapeHtml(c.new || "")}</pre>`;
  g.appendChild(l); g.appendChild(r); d.appendChild(g); return d;
};

// chart
R.chart = (c, id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  const canvas = document.createElement("canvas"); canvas.id = id + "-chart"; d.appendChild(canvas);
  setTimeout(() => {
    try {
      new Chart(canvas, {
        type: c.chartType || "bar",
        data: { labels: c.labels || [], datasets: (c.datasets || []).map((ds, i) => ({ label: ds.label || "Dataset " + (i + 1), data: ds.data || [], backgroundColor: ["rgba(59,130,246,0.5)", "rgba(16,185,129,0.5)", "rgba(245,158,11,0.5)", "rgba(239,68,68,0.5)", "rgba(139,92,246,0.5)"], borderColor: ["rgba(59,130,246,1)", "rgba(16,185,129,1)", "rgba(245,158,11,1)", "rgba(239,68,68,1)", "rgba(139,92,246,1)"], borderWidth: 1 })) },
        options: { responsive: true, plugins: { legend: { labels: { color: "#a1a1aa" } } }, scales: c.chartType === "pie" || c.chartType === "radar" ? {} : { x: { ticks: { color: "#71717a" }, grid: { color: "#27272a" } }, y: { ticks: { color: "#71717a" }, grid: { color: "#27272a" } } } }
      });
    } catch {}
  }, 50);
  return d;
};

// timeline
R.timeline = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  for (const e of c.events || []) {
    const ev = document.createElement("div"); ev.className = "timeline-event";
    ev.innerHTML = `<div class="text-xs text-zinc-500 mb-1">${escapeHtml(e.date)}</div><div class="text-sm font-medium text-zinc-200">${escapeHtml(e.title)}</div>${e.description ? `<div class="text-xs text-zinc-400 mt-1">${escapeHtml(e.description)}</div>` : ""}`;
    const mb = document.createElement("button"); mb.className = "tell-more-btn mt-1"; mb.textContent = "Tell me more →"; mb.onclick = () => sendTellMore(e.title);
    ev.appendChild(mb); d.appendChild(ev);
  }
  return d;
};

// heatmap
R.heatmap = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card ${cls}`;
  const data = c.data || [], xL = c.xLabels || [], yL = c.yLabels || [];
  const tbl = document.createElement("div"); tbl.className = "overflow-x-auto";
  tbl.style.display = "grid";
  tbl.style.gridTemplateColumns = `auto repeat(${xL.length}, 2.5rem)`;
  tbl.style.gap = "2px";
  tbl.innerHTML = `<div></div>${xL.map(x => `<div class="text-xs text-zinc-500 text-center">${escapeHtml(x)}</div>`).join("")}`;
  for (let y = 0; y < yL.length; y++) {
    tbl.innerHTML += `<div class="text-xs text-zinc-500 pr-2 flex items-center">${escapeHtml(yL[y])}</div>`;
    for (let x = 0; x < xL.length; x++) {
      const v = data[y]?.[x] ?? 0;
      const intensity = Math.min(Math.abs(v) / 100, 1);
      const bg = `rgba(59,130,246,${intensity * 0.8})`;
      tbl.innerHTML += `<div class="rounded text-xs text-center flex items-center justify-center" style="background:${bg};min-height:2rem">${v}</div>`;
    }
  }
  d.appendChild(tbl); return d;
};

// graph (D3 force-directed)
R.graph = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card graph-container ${cls}`;
  const w = 600, h = 400;
  const svg = d3.select(d).append("svg").attr("width", "100%").attr("height", h).attr("viewBox", `0 0 ${w} ${h}`);
  const nodes = (c.nodes || []).map(n => ({ ...n }));
  const links = (c.edges || []).map(e => ({ source: e.from, target: e.to, label: e.label }));
  const sim = d3.forceSimulation(nodes).force("link", d3.forceLink(links).id(d => d.id).distance(100)).force("charge", d3.forceManyBody().strength(-200)).force("center", d3.forceCenter(w / 2, h / 2));
  const link = svg.append("g").selectAll("line").data(links).join("line").attr("stroke", "#52525b").attr("stroke-width", 1.5);
  const linkLabel = svg.append("g").selectAll("text").data(links.filter(l => l.label)).join("text").attr("fill", "#a1a1aa").style("font-size", "10px").text(d => d.label);
  const node = svg.append("g").selectAll("g").data(nodes).join("g").call(d3.drag().on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }).on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; }).on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  node.append("circle").attr("r", 20).attr("fill", "#18181b").attr("stroke", "#3b82f6").attr("stroke-width", 1.5);
  node.append("text").attr("text-anchor", "middle").attr("dy", 4).attr("fill", "#f4f4f5").style("font-size", "10px").text(d => d.label);
  sim.on("tick", () => { link.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    linkLabel.attr("x", d => (d.source.x + d.target.x) / 2).attr("y", d => (d.source.y + d.target.y) / 2);
    node.attr("transform", d => `translate(${d.x},${d.y})`); });
  return d;
};

// mind_map
R.mind_map = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card graph-container ${cls}`;
  const w = 600, h = 400;
  const svg = d3.select(d).append("svg").attr("width", "100%").attr("height", h).attr("viewBox", `0 0 ${w} ${h}`);
  const root = { label: c.center, children: c.branches || [] };
  const hierarchy = d3.hierarchy(root);
  const tree = d3.tree().size([2 * Math.PI, Math.min(w, h) / 2 - 60]);
  const treeData = tree(hierarchy);
  const g = svg.append("g").attr("transform", `translate(${w / 2},${h / 2})`);
  g.selectAll("path").data(treeData.links()).join("path").attr("d", d3.linkRadial().angle(d => d.x).radius(d => d.y)).attr("fill", "none").attr("stroke", "#52525b").attr("stroke-width", 1);
  const nd = g.selectAll("g").data(treeData.descendants()).join("g").attr("transform", d => `rotate(${d.x * 180 / Math.PI - 90})translate(${d.y},0)`);
  nd.append("circle").attr("r", 4).attr("fill", d => d.depth === 0 ? "#3b82f6" : "#18181b").attr("stroke", "#3b82f6").attr("stroke-width", 1.5);
  nd.append("text").attr("dy", "0.31em").attr("x", d => d.x < Math.PI === !d.children ? 8 : -8).attr("text-anchor", d => d.x < Math.PI === !d.children ? "start" : "end").attr("transform", d => d.x >= Math.PI ? "rotate(180)" : null).attr("fill", "#f4f4f5").style("font-size", "11px").text(d => d.data.label);
  return d;
};

// entity_relation
R.entity_relation = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = `block-card graph-container ${cls}`;
  const w = 600, h = 400;
  const svg = d3.select(d).append("svg").attr("width", "100%").attr("height", h).attr("viewBox", `0 0 ${w} ${h}`);
  const ents = c.entities || [], rels = c.relations || [];
  const em = {}; ents.forEach((e, i) => em[e.id] = { ...e, x: 80 + (i % 3) * 200, y: 60 + Math.floor(i / 3) * 160 });
  for (const r of rels) {
    const f = em[r.from], t = em[r.to]; if (!f || !t) continue;
    svg.append("line").attr("x1", f.x).attr("y1", f.y).attr("x2", t.x).attr("y2", t.y).attr("stroke", "#52525b").attr("stroke-width", 1);
    if (r.type) svg.append("text").attr("x", (f.x + t.x) / 2 + 4).attr("y", (f.y + t.y) / 2 - 4).attr("fill", "#a1a1aa").style("font-size", "10px").text(r.type);
  }
  for (const e of Object.values(em)) {
    const g = svg.append("g").attr("transform", `translate(${e.x},${e.y})`);
    g.append("rect").attr("x", -50).attr("y", -20).attr("width", 100).attr("height", 40).attr("rx", 4).attr("fill", "#18181b").attr("stroke", "#3b82f6").attr("stroke-width", 1);
    g.append("text").attr("text-anchor", "middle").attr("dy", 4).attr("fill", "#f4f4f5").style("font-size", "11px").text(e.label);
  }
  return d;
};

// image
R.image = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = cls;
  const img = document.createElement("img");
  img.src = c.src; if (c.alt) img.alt = c.alt;
  img.className = "rounded-lg max-w-full"; img.style.maxHeight = "400px";
  d.appendChild(img);
  if (c.caption) { const cap = document.createElement("p"); cap.className = "text-xs text-zinc-500 mt-2"; cap.textContent = c.caption; d.appendChild(cap); }
  return d;
};

// svg
R.svg = (c, _id, cls) => {
  const d = document.createElement("div"); d.className = cls;
  const iframe = document.createElement("iframe");
  iframe.style.width = "100%"; iframe.style.minHeight = "200px"; iframe.style.border = "none"; iframe.style.borderRadius = "0.5rem";
  iframe.srcdoc = `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;align-items:center;justify-content:center;background:#18181b;}</style></head><body>${c.content || ""}</body></html>`;
  iframe.sandbox = "allow-same-origin";
  d.appendChild(iframe); return d;
};

// ─── Text input ───
function sendTextInput() {
  const t = textInput.value.trim(); if (!t && !pendingImage) return;
  const msg = { type: "text", text: t || "" };
  if (pendingImage) msg.images = [{ mediaType: pendingImage.mediaType, data: pendingImage.data }];
  sendToServer(msg); textInput.value = ""; clearPendingImage();
  textInput.style.height = "auto"; textInput.style.height = "38px";
}
sendBtn.addEventListener("click", sendTextInput);
textInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextInput(); } });
textInput.addEventListener("input", () => { textInput.style.height = "auto"; textInput.style.height = Math.min(textInput.scrollHeight, 120) + "px"; });

// ─── Image paste ───
document.addEventListener("paste", e => {
  for (const it of e.clipboardData?.items || []) {
    if (it.type.startsWith("image/")) {
      e.preventDefault(); const f = it.getAsFile();
      const r = new FileReader();
      r.onload = () => { pendingImage = { mediaType: it.type, data: r.result.split(",")[1], name: f?.name || "pasted-image.png" }; previewFilename.textContent = pendingImage.name; imagePreview.classList.remove("hidden"); };
      r.readAsDataURL(f); return;
    }
  }
});
pasteBtn.addEventListener("click", () => { textInput.focus(); document.execCommand("paste"); });
function clearPendingImage() { pendingImage = null; imagePreview.classList.add("hidden"); }
removeImageBtn.addEventListener("click", clearPendingImage);

// ─── Start ───
connect();
