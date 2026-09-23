// Helix Studio — front-end
const $ = s => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
const GUT = 40;   // mm gutter (top+left) for rulers
const PAD = 10;   // mm padding (right+bottom)
const state = {
  materials: [], session: null, machine: null, laserHost: "192.168.1.6",
  off: { x: 0, y: 0 }, rot: 0, vb: { w: 1, h: 1 }, page: { w: 0, h: 0 },
};

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☀" : "☾";
  try { localStorage.setItem("hs-theme", t); } catch (e) {}
}
$("#themeBtn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

// ---------- boot ----------
async function boot() {
  try { applyTheme(localStorage.getItem("hs-theme") || "dark"); } catch (e) { applyTheme("dark"); }
  const cfg = await (await fetch("/api/config")).json();
  state.machine = cfg.machine;
  state.laserHost = cfg.laser_host;
  $("#laserPill").innerHTML = "laser <b>" + cfg.laser_host + "</b>";
  const msel = $("#machine");
  (cfg.machines || [cfg.machine]).forEach(mm => msel.appendChild(new Option(mm.name, mm.name)));
  msel.value = cfg.machine.name;
  const m = cfg.machine;
  state.vb = { w: m.bed_w_mm + GUT + PAD, h: m.bed_h_mm + GUT + PAD };
  $("#bed").setAttribute("viewBox", `${-GUT} ${-GUT} ${state.vb.w} ${state.vb.h}`);
  buildBed();
  fitBed();

  const mat = await (await fetch("/api/materials")).json();
  state.materials = mat.materials;
  const sel = $("#material");
  mat.materials.forEach(mm => sel.appendChild(new Option(mm.name, mm.name)));
}

// size the bed SVG to fill its container while preserving the bed aspect
// (exact 1:1 viewBox mapping keeps drag math simple)
function fitBed() {
  if (!state.machine) return;
  const wrap = document.querySelector(".bedwrap");
  const pad = 40;
  const availW = wrap.clientWidth - pad, availH = wrap.clientHeight - pad;
  const A = state.vb.w / state.vb.h;
  let w = availW, h = w / A;
  if (h > availH) { h = availH; w = h * A; }
  const bed = $("#bed");
  bed.style.width = Math.max(50, w) + "px";
  bed.style.height = Math.max(50, h) + "px";
}
window.addEventListener("resize", fitBed);

// ---------- import ----------
const drop = $("#drop"), fileInput = $("#file");
drop.onclick = () => fileInput.click();
fileInput.onchange = e => e.target.files[0] && importPdf(e.target.files[0]);
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
drop.addEventListener("drop", e => {
  const f = e.dataTransfer.files[0];
  if (f && f.type === "application/pdf") importPdf(f);
});

async function importPdf(file) {
  drop.innerHTML = "<p class='hint'>importing " + file.name + "…</p>";
  const buf = await file.arrayBuffer();
  const data = await (await fetch("/api/import", {
    method: "POST", headers: { "Content-Type": "application/pdf" }, body: buf,
  })).json();
  if (data.error) { drop.innerHTML = "<p class='warn'>" + data.error + "</p>"; return; }
  state.session = data;
  state.rot = 0;
  state.page = { w: data.info.width_mm, h: data.info.height_mm };
  $("#drop").hidden = true;
  $("#controls").hidden = false;
  $("#resetBtn").hidden = false;
  // SVG elements have no .hidden IDL property — toggle the attribute instead
  if (bedEls) {
    bedEls.artimg.setAttribute("href", data.preview + "?t=" + Date.now());
    bedEls.artimg.setAttribute("width", state.page.w);
    bedEls.artimg.setAttribute("height", state.page.h);
    bedEls.artimg.removeAttribute("hidden");
    bedEls.art.removeAttribute("hidden");
    buildCutlines(data.vectors || []);
  }
  centerArt();
  highlight();
}

// draw the extracted vector geometry (page-mm coords) into the cut overlay
function buildCutlines(vectors) {
  const g = bedEls.cutlines; g.innerHTML = "";
  vectors.forEach(pl => {
    const pts = pl.map(p => p[0] + "," + p[1]).join(" ");
    g.appendChild(mk("polyline", { points: pts, fill: "none" }));
  });
}

function artTransform(R, ox, oy, x0, y0, cw, ch) {
  if (R === 90)  return `translate(${ox} ${oy}) translate(${ch} 0) rotate(90) translate(${-x0} ${-y0})`;
  if (R === 180) return `translate(${ox} ${oy}) translate(${cw} ${ch}) rotate(180) translate(${-x0} ${-y0})`;
  if (R === 270) return `translate(${ox} ${oy}) translate(0 ${cw}) rotate(270) translate(${-x0} ${-y0})`;
  return `translate(${ox - x0} ${oy - y0})`;
}
$("#resetBtn").onclick = () => location.reload();

// ---------- placement helpers ----------
function artDims() {
  const c = state.session && state.session.content_mm;
  if (!c) return { w: 0, h: 0 };
  return (state.rot % 180 === 0) ? { w: c.w_mm, h: c.h_mm } : { w: c.h_mm, h: c.w_mm };
}
function bounds() {
  const m = state.machine, s = m.safety_mm != null ? m.safety_mm : (m.margin_mm || 3);
  return { minX: s, minY: s,
           maxX: Math.min(m.usable_w_mm, m.bed_w_mm - s),
           maxY: Math.min(m.usable_h_mm, m.bed_h_mm - s), s };
}
function clampOff() {
  const d = artDims(), B = bounds();
  state.off.x = Math.max(B.minX, Math.min(state.off.x, B.maxX - d.w));
  state.off.y = Math.max(B.minY, Math.min(state.off.y, B.maxY - d.h));
}
function centerArt() {
  const d = artDims(), B = bounds();
  state.off.x = Math.max(B.minX, (B.minX + B.maxX - d.w) / 2);
  state.off.y = Math.max(B.minY, (B.minY + B.maxY - d.h) / 2);
  updatePlacement();
}

// ---------- bed (built once, updated in place) ----------
let bedEls = null;
const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

function buildBed() {
  const bed = $("#bed"), m = state.machine;
  bed.innerHTML = "";

  // clip for the artwork image
  const defs = mk("defs", {});
  const cp = mk("clipPath", { id: "artclip", clipPathUnits: "userSpaceOnUse" });
  const clipR = mk("rect", { x: 0, y: 0, width: 1, height: 1 });
  cp.appendChild(clipR); defs.appendChild(cp); bed.appendChild(defs);

  bed.appendChild(mk("rect", { x: 0, y: 0, width: m.bed_w_mm, height: m.bed_h_mm, fill: "var(--bed)", stroke: "var(--line)", "stroke-width": 1 }));
  const B = bounds();  // dashed safety boundary = allowed placement area
  bed.appendChild(mk("rect", {
    x: B.minX, y: B.minY, width: B.maxX - B.minX, height: B.maxY - B.minY,
    fill: "none", stroke: "var(--warn, #ffb454)", "stroke-dasharray": "8 6", "stroke-width": 1.5,
  }));
  drawRulers(bed, m);
  bed.appendChild(mk("circle", { cx: 0, cy: 0, r: 6, fill: "var(--accent2)" }));

  // artwork image (clipped to the content rect)
  const g = mk("g", { "clip-path": "url(#artclip)" });
  const artimg = mk("image", { id: "artimg", preserveAspectRatio: "none", hidden: "hidden" });
  g.appendChild(artimg); bed.appendChild(g);
  // engrave wash (green) + cut-line overlay (red vectors)
  const engwash = mk("rect", { fill: "rgba(123,216,143,.28)", "pointer-events": "none", hidden: "hidden" });
  bed.appendChild(engwash);
  const cutlines = mk("g", { id: "cutlines", fill: "none", "stroke-width": 0.9,
    "stroke-linejoin": "round", "pointer-events": "none", hidden: "hidden" });
  bed.appendChild(cutlines);
  // coloured border on top — pointer-events:all so the whole box is draggable despite fill:none
  const art = mk("rect", { class: "art", rx: 1.5, fill: "none", "stroke-width": 2.5,
    "pointer-events": "all", hidden: "hidden" });
  bed.appendChild(art);

  bedEls = { art, artimg, clipR, engwash, cutlines };
  attachDrag(art);
}

function drawRulers(bed, m) {
  const majorX = 100, majorY = 100, minor = 50, fs = 11;
  for (let x = 0; x <= m.bed_w_mm + 1; x += minor) {
    const major = x % majorX === 0;
    bed.appendChild(mk("line", { x1: x, y1: major ? -12 : -7, x2: x, y2: 0, stroke: "var(--bedline)", "stroke-width": 1 }));
    if (major) bed.appendChild(Object.assign(mk("text", { x: x, y: -16, "font-size": fs, "text-anchor": "middle", fill: "var(--muted)" }), { textContent: x }));
  }
  for (let y = 0; y <= m.bed_h_mm + 1; y += minor) {
    const major = y % majorY === 0;
    bed.appendChild(mk("line", { x1: major ? -12 : -7, y1: y, x2: 0, y2: y, stroke: "var(--bedline)", "stroke-width": 1 }));
    if (major) bed.appendChild(Object.assign(mk("text", { x: -16, y: y + fs / 3, "font-size": fs, "text-anchor": "end", fill: "var(--muted)" }), { textContent: y }));
  }
}

function attachDrag(art) {
  let start = null;
  art.addEventListener("pointerdown", e => {
    const bed = $("#bed");
    const r = bed.getBoundingClientRect();
    const scale = state.vb.w / r.width;  // mm per px (uniform; viewBox incl. gutters)
    start = { px: e.clientX, py: e.clientY, ox: state.off.x, oy: state.off.y, scale };
    art.classList.add("drag");
    art.setPointerCapture(e.pointerId);
  });
  art.addEventListener("pointermove", e => {
    if (!start) return;
    state.off.x = start.ox + (e.clientX - start.px) * start.scale;
    state.off.y = start.oy + (e.clientY - start.py) * start.scale;
    clampOff();
    updatePlacement();
  });
  const end = e => { start = null; art.classList.remove("drag"); };
  art.addEventListener("pointerup", end);
  art.addEventListener("pointercancel", end);
}

function updatePlacement() {
  if (!bedEls || !state.session) return;
  const parsed = !!state.session.content_mm;
  clampOff();
  const d = artDims(), B = bounds();
  const ok = parsed && state.off.x >= B.minX - 0.01 && state.off.y >= B.minY - 0.01 &&
             state.off.x + d.w <= B.maxX + 0.01 && state.off.y + d.h <= B.maxY + 0.01;
  const stroke = ok ? "var(--accent)" : "var(--danger)";
  const ox = state.off.x, oy = state.off.y;
  // border
  bedEls.art.setAttribute("x", ox);
  bedEls.art.setAttribute("y", oy);
  bedEls.art.setAttribute("width", Math.max(d.w, 0.1));
  bedEls.art.setAttribute("height", Math.max(d.h, 0.1));
  bedEls.art.setAttribute("stroke", stroke);
  // clip window + artwork image transform (crop page to content, rotate, place)
  bedEls.clipR.setAttribute("x", ox);
  bedEls.clipR.setAttribute("y", oy);
  bedEls.clipR.setAttribute("width", Math.max(d.w, 0.1));
  bedEls.clipR.setAttribute("height", Math.max(d.h, 0.1));
  const c = state.session.content_mm;
  if (c) {
    const tf = artTransform(state.rot, ox, oy, c.x0_mm, c.y0_mm, c.w_mm, c.h_mm);
    bedEls.artimg.setAttribute("transform", tf);
    bedEls.cutlines.setAttribute("transform", tf);
  }
  bedEls.engwash.setAttribute("x", ox);
  bedEls.engwash.setAttribute("y", oy);
  bedEls.engwash.setAttribute("width", Math.max(d.w, 0.1));
  bedEls.engwash.setAttribute("height", Math.max(d.h, 0.1));
  $("#offx").value = Math.round(state.off.x);
  $("#offy").value = Math.round(state.off.y);
  $("#rotLbl").textContent = state.rot + "°";
  $("#placeInfo").textContent =
    `Artwork ${d.w.toFixed(0)}×${d.h.toFixed(0)} mm at (${state.off.x.toFixed(0)}, ${state.off.y.toFixed(0)}) · ` +
    `reaches (${(state.off.x + d.w).toFixed(0)}, ${(state.off.y + d.h).toFixed(0)}) · bed ${state.machine.bed_w_mm}×${state.machine.bed_h_mm}`;
  const warn = $("#boundsWarn");
  warn.hidden = ok;
  if (!parsed) warn.textContent = "⚠ No printable artwork detected in this PDF.";
  else if (!ok) warn.textContent = `⚠ Inside the ${B.s} mm safety margin. Move the artwork within the dashed boundary. Sending disabled.`;
  $("#sendBtn").disabled = !(ok && currentOp());
}

$("#offx").oninput = e => { state.off.x = +e.target.value || 0; updatePlacement(); };
$("#offy").oninput = e => { state.off.y = +e.target.value || 0; updatePlacement(); };
$("#rotateBtn").onclick = () => { state.rot = (state.rot + 90) % 360; clampOff(); updatePlacement(); };
$("#centerBtn").onclick = () => centerArt();

// ---------- material + preset dropdown ----------
function currentMaterial() { return state.materials.find(m => m.name === $("#material").value) || null; }
function currentOp() {
  const m = currentMaterial(), i = $("#preset").value;
  return (m && i !== "") ? m.operations[+i] : null;
}
function renderPresets() {
  const m = currentMaterial(), sel = $("#preset");
  const T = parseFloat($("#thickness").value) || null;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— preset —</option>';
  sel.disabled = !m;
  if (m) m.operations.forEach((op, i) => {
    // hide cut presets that can't cut through the chosen thickness
    if (op.type === "cut" && T != null && op.thickness_mm != null && op.thickness_mm < T) return;
    const icon = op.type === "cut" ? "✂" : "▦";
    const extra = op.type === "cut" ? `${op.freq}Hz` : `${op.dpi}dpi`;
    const thk = (op.type === "cut" && op.thickness_mm) ? ` · ≤${op.thickness_mm}mm` : "";
    sel.appendChild(new Option(`${icon} ${op.label} · S${op.speed} P${op.power} · ${extra}${thk}`, i));
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  highlight(); updatePlacement();
}
$("#material").onchange = renderPresets;
$("#thickness").onchange = renderPresets;
$("#preset").onchange = () => { highlight(); updatePlacement(); };

// highlight artwork by selected preset: cut → red vector lines, engrave → green wash
function highlight() {
  if (!bedEls) return;
  const op = currentOp();
  const isCut = op && op.type === "cut";
  const isEng = op && op.type === "engrave";
  bedEls.cutlines.setAttribute("stroke", isCut ? "var(--danger)" : "transparent");
  if (isCut) bedEls.cutlines.removeAttribute("hidden"); else bedEls.cutlines.setAttribute("hidden", "hidden");
  if (isEng) bedEls.engwash.removeAttribute("hidden"); else bedEls.engwash.setAttribute("hidden", "hidden");
}

// ---------- send (single operation over the whole artwork) ----------
$("#sendBtn").onclick = async () => {
  const op = currentOp();
  if (!op) { alert("Choose a material and preset first."); return; }
  const operation = { type: op.type, speed: op.speed, power: op.power, dpi: op.dpi, freq: op.freq };
  const btn = $("#sendBtn"); btn.disabled = true; btn.textContent = "Sending…";
  const out = $("#out"); out.classList.add("on"); out.textContent = "working…";
  try {
    const data = await (await fetch("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.session.id, host: state.laserHost, operation,
        offset_mm: [state.off.x, state.off.y], rotation: state.rot, autofocus: false,
      }),
    })).json();
    if (data.error) out.textContent = "ERROR: " + data.error;
    else out.textContent = `Sent to ${data.host} — press GO on the machine\n· ${data.jobs[0].title}: ${data.jobs[0].bytes} bytes → SENT`;
  } catch (e) { out.textContent = "ERROR: " + e.message; }
  btn.disabled = false; btn.textContent = "Send";
};

boot();
