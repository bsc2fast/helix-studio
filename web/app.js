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
  $("#layersSection").hidden = !data.layers.length;
  // SVG elements have no .hidden IDL property — toggle the attribute instead
  if (bedEls) {
    bedEls.artimg.setAttributeNS("http://www.w3.org/1999/xlink", "href", data.preview + "?t=" + Date.now());
    bedEls.artimg.setAttribute("href", data.preview + "?t=" + Date.now());
    bedEls.artimg.setAttribute("width", state.page.w);
    bedEls.artimg.setAttribute("height", state.page.h);
    bedEls.artimg.removeAttribute("hidden");
    bedEls.art.removeAttribute("hidden");
  }
  centerArt();
  renderLayers();
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
function limits() {
  const m = state.machine;
  return { x: m.usable_w_mm - m.margin_mm, y: m.usable_h_mm - m.margin_mm };
}
function clampOff() {
  const d = artDims(), L = limits();
  state.off.x = Math.max(0, Math.min(state.off.x, L.x - d.w));
  state.off.y = Math.max(0, Math.min(state.off.y, L.y - d.h));
}
function centerArt() {
  const d = artDims(), m = state.machine;
  state.off.x = Math.max(0, (m.usable_w_mm - d.w) / 2);
  state.off.y = Math.max(0, (m.usable_h_mm - d.h) / 2);
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
  bed.appendChild(mk("rect", {
    x: m.margin_mm, y: m.margin_mm,
    width: m.usable_w_mm - 2 * m.margin_mm, height: m.usable_h_mm - 2 * m.margin_mm,
    fill: "none", stroke: "var(--bedline)", "stroke-dasharray": "7 5", "stroke-width": 1,
  }));
  drawRulers(bed, m);
  bed.appendChild(mk("circle", { cx: 0, cy: 0, r: 6, fill: "var(--accent2)" }));

  // artwork image (clipped to the content rect), then the coloured border on top
  const g = mk("g", { "clip-path": "url(#artclip)" });
  const artimg = mk("image", { id: "artimg", preserveAspectRatio: "none", hidden: "hidden" });
  g.appendChild(artimg); bed.appendChild(g);
  const art = mk("rect", { class: "art", rx: 1.5, fill: "none", "stroke-width": 2.5, hidden: "hidden" });
  bed.appendChild(art);

  bedEls = { art, artimg, clipR };
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
  const d = artDims(), L = limits();
  const ok = parsed && state.off.x >= 0 && state.off.y >= 0 &&
             state.off.x + d.w <= L.x + 0.01 && state.off.y + d.h <= L.y + 0.01;
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
  if (c) bedEls.artimg.setAttribute("transform", artTransform(state.rot, ox, oy, c.x0_mm, c.y0_mm, c.w_mm, c.h_mm));
  $("#offx").value = Math.round(state.off.x);
  $("#offy").value = Math.round(state.off.y);
  $("#rotLbl").textContent = state.rot + "°";
  $("#placeInfo").textContent =
    `Artwork ${d.w.toFixed(0)}×${d.h.toFixed(0)} mm at (${state.off.x.toFixed(0)}, ${state.off.y.toFixed(0)}) · ` +
    `reaches (${(state.off.x + d.w).toFixed(0)}, ${(state.off.y + d.h).toFixed(0)}) · bed ${state.machine.bed_w_mm}×${state.machine.bed_h_mm}`;
  const warn = $("#boundsWarn");
  warn.hidden = ok;
  if (!parsed) warn.textContent = "⚠ No printable artwork detected in this PDF.";
  else if (!ok) warn.textContent = `⚠ Out of bounds — exceeds usable ${L.x.toFixed(0)}×${L.y.toFixed(0)} mm. Sending disabled.`;
  $("#sendBtn").disabled = !ok;
}

$("#offx").oninput = e => { state.off.x = +e.target.value || 0; updatePlacement(); };
$("#offy").oninput = e => { state.off.y = +e.target.value || 0; updatePlacement(); };
$("#rotateBtn").onclick = () => { state.rot = (state.rot + 90) % 360; clampOff(); updatePlacement(); };
$("#centerBtn").onclick = () => centerArt();

// ---------- material + presets ----------
function currentMaterial() { return state.materials.find(m => m.name === $("#material").value) || null; }
$("#material").onchange = () => { renderPresets(); renderLayers(); };

function renderPresets() {
  const box = $("#presets"); box.innerHTML = "";
  const m = currentMaterial();
  if (!m) return;
  m.operations.forEach(op => {
    const icon = op.type === "cut" ? "✂" : "▦";
    const extra = op.type === "cut" ? ` · ${op.freq}Hz` : ` · ${op.dpi}dpi`;
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${icon} ${op.label} · <b>S${op.speed} P${op.power}</b>${extra}`;
    box.appendChild(chip);
  });
}

// ---------- layers ----------
function renderLayers() {
  const box = $("#layers"); box.innerHTML = "";
  if (!state.session) return;
  const m = currentMaterial();
  if (!m) { box.innerHTML = "<p class='hint'>Choose a material to assign settings.</p>"; return; }
  state.session.layers.forEach((L, i) => {
    const div = document.createElement("div");
    div.className = "layer"; div.dataset.i = i;
    div.innerHTML = `<div class="top"><div class="swatch" style="background:${L.hex}"></div>
      <div style="flex:1"><div>${L.hex}</div><div class="cov">${(L.coverage*100).toFixed(1)}% of art</div></div></div>`;

    const opSel = document.createElement("select");
    opSel.className = "opsel";
    opSel.appendChild(new Option("Ignore this colour", "ignore"));
    m.operations.forEach((op, oi) =>
      opSel.appendChild(new Option(`${op.type === "cut" ? "✂ Cut" : "▦ Engrave"} — ${op.label}`, oi)));
    div.appendChild(opSel);

    const grid = document.createElement("div");
    grid.className = "grid4";
    grid.innerHTML = `
      <div><label class="fld-l">Speed %</label><input type="number" class="sp" min="1" max="100"></div>
      <div><label class="fld-l">Power %</label><input type="number" class="pw" min="1" max="100"></div>
      <div class="dpiWrap"><label class="fld-l">DPI</label><input type="number" class="dpi"></div>
      <div class="freqWrap"><label class="fld-l">Freq Hz</label><input type="number" class="freq"></div>`;
    div.appendChild(grid);

    function apply() {
      if (opSel.value === "ignore") { div.classList.add("ignored"); grid.style.display = "none"; return; }
      div.classList.remove("ignored"); grid.style.display = "";
      const op = m.operations[+opSel.value];
      grid.querySelector(".sp").value = op.speed;
      grid.querySelector(".pw").value = op.power;
      grid.querySelector(".dpiWrap").style.display = op.type === "engrave" ? "" : "none";
      grid.querySelector(".freqWrap").style.display = op.type === "cut" ? "" : "none";
      grid.querySelector(".dpi").value = op.dpi || "";
      grid.querySelector(".freq").value = op.freq || "";
    }
    opSel.onchange = apply;
    const firstEng = m.operations.findIndex(o => o.type === "engrave");
    opSel.value = firstEng >= 0 ? String(firstEng) : "ignore";
    apply();
    box.appendChild(div);
  });
}

// ---------- send ----------
$("#sendBtn").onclick = async () => {
  const m = currentMaterial();
  if (!m) { alert("Choose a material first."); return; }
  const assignments = [];
  document.querySelectorAll(".layer").forEach(div => {
    const opSel = div.querySelector(".opsel");
    if (!opSel || opSel.value === "ignore") return;
    const op = m.operations[+opSel.value];
    const L = state.session.layers[+div.dataset.i];
    assignments.push({
      hex: L.hex, rgb: L.rgb, op: op.type, label: op.label,
      speed: +div.querySelector(".sp").value, power: +div.querySelector(".pw").value,
      dpi: +div.querySelector(".dpi").value || undefined,
      freq: +div.querySelector(".freq").value || undefined,
    });
  });
  if (!assignments.length) { alert("Assign at least one colour to cut or engrave."); return; }

  const btn = $("#sendBtn"); btn.disabled = true; btn.textContent = "Sending…";
  const out = $("#out"); out.classList.add("on"); out.textContent = "working…";
  try {
    const data = await (await fetch("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.session.id, host: state.laserHost, material: m.name,
        assignments, offset_mm: [state.off.x, state.off.y], rotation: state.rot,
        autofocus: false,
      }),
    })).json();
    if (data.error) out.textContent = "ERROR: " + data.error;
    else {
      const lines = data.jobs.map(j => j.skipped
        ? `· ${j.title}: SKIPPED (${j.skipped})`
        : `· ${j.title}: ${j.bytes} bytes → SENT`);
      out.textContent = "Sent to " + data.host + " — press GO on the machine per job\n" + lines.join("\n");
    }
  } catch (e) { out.textContent = "ERROR: " + e.message; }
  btn.disabled = false; btn.textContent = "Send to laser";
};

boot();
