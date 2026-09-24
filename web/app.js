// Helix Studio — front-end
const $ = s => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
const GUT = 40;   // mm gutter (top+left) for rulers
const PAD = 10;   // mm padding (right+bottom)
const state = {
  materials: [], machine: null, laserHost: "192.168.1.6",
  docs: [],           // imported PDFs, in the order they arrived:
                      //   {id, name, pages, pd: {n -> page geometry}}
  items: [],          // pages on the bed: {doc, page, pd, off:{x,y}, rot, els}
  active: null,       // the item the Placement panel edits
  sheetOff: { x: 0, y: 0 },   // where the stock sheet sits on the bed (mm)
  laser: "checking",   // checking | online | busy | offline | scanning
  sending: false,
  vb: { w: 1, h: 1 }, page: { w: 0, h: 0 },
};

// ---------- theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("#themeBtn").textContent = t === "dark" ? "☀" : "☾";
  try { localStorage.setItem("hs-theme", t); } catch (e) {}
}
$("#themeBtn").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

// ---------- app bar: size each dropdown to the text it has to show ----------
// Fixed widths truncated real labels ("Epilog Helix 24x18 (3…") while the bar
// still had spare room. Each select instead asks for the width of its WIDEST
// option (capped), so the text fits and the width never jumps as the selection
// changes; flex-shrink still squeezes them if the window gets narrow.
const FIT_CAP = { machine: 240, material: 190, thickness: 144, sheet: 210, preset: 340 };
// when the window is too narrow for all of them, they give up space in order of
// how often they are touched and how much they say: the machine (set once, and
// its name is guessable from a few letters) shrinks first, the preset last,
// and each stops at a floor that still shows something useful
const FIT_SHRINK = { machine: 4, material: 1, thickness: 0, sheet: 1.5, preset: 1.5 };
const FIT_MIN = { machine: 80, material: 92, thickness: 84, sheet: 110, preset: 140 };
let measureCtx = null;
function textWidth(el, text) {
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(el);
  measureCtx.font = `${cs.fontWeight} ${cs.fontSize}/${cs.lineHeight} ${cs.fontFamily}`;
  return measureCtx.measureText(text).width;
}
function fitSelect(sel) {
  if (!sel || !sel.options.length) return;
  const cs = getComputedStyle(sel);
  // padding (the right padding holds the chevron) + borders + a little slack
  const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + 4;
  const widest = [...sel.options].reduce((w, o) => Math.max(w, textWidth(sel, o.text)), 0);
  sel.style.flexBasis =
    Math.round(Math.max(96, Math.min(FIT_CAP[sel.id] || 200, widest + chrome))) + "px";
  sel.style.flexShrink = FIT_SHRINK[sel.id] != null ? FIT_SHRINK[sel.id] : 1;
  sel.style.minWidth = (FIT_MIN[sel.id] || 96) + "px";
}
function fitBar() { ["#machine", "#material", "#thickness", "#sheet", "#preset"].forEach(s => fitSelect($(s))); }

// ---------- boot ----------
async function boot() {
  try { applyTheme(localStorage.getItem("hs-theme") || "dark"); } catch (e) { applyTheme("dark"); }
  const cfg = await (await fetch("/api/config")).json();
  state.machine = cfg.machine;
  state.laserHost = cfg.laser_host;
  renderLaser();
  pollLaser();
  const msel = $("#machine");
  (cfg.machines || [cfg.machine]).forEach(mm => msel.appendChild(new Option(mm.name, mm.name)));
  msel.value = cfg.machine.name;
  const m = cfg.machine;
  state.vb = { w: m.bed_w_mm + GUT + PAD, h: m.bed_h_mm + GUT + PAD };
  $("#bed").setAttribute("viewBox", `${-GUT} ${-GUT} ${state.vb.w} ${state.vb.h}`);
  renderSheetOptions();
  buildBed();
  fitBed();

  const mat = await (await fetch("/api/materials")).json();
  state.materials = mat.materials;
  const sel = $("#material");
  mat.materials.forEach(mm => sel.appendChild(new Option(mm.name, mm.name)));
  fitBar();
}

// ---------- laser link: live status, and a network scan when it drops ----------
// The chip shows the IP with a live dot while the laser answers on LPD; once it
// stops answering the chip turns into a Scan button, and a scan also runs on
// its own — right away, then every SCAN_EVERY ms while the laser stays gone.
const POLL_EVERY = 4000, SCAN_EVERY = 30000;
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>';
let lastScan = 0, pollTimer = null;

function renderLaser() {
  const pill = $("#laserPill"), st = state.laser;
  pill.className = "pill " + st;
  if (st === "offline" || st === "scanning") {
    pill.innerHTML = (st === "scanning" ? ICON_SPIN : ICON_SEARCH) +
      `<span>${st === "scanning" ? "Scanning…" : "Scan"}</span>`;
    pill.classList.add("scan");
    pill.title = st === "scanning" ? "Looking for the laser on the local network…"
      : `Laser not reachable at ${state.laserHost} — click to scan the network`;
  } else {
    pill.innerHTML = `<span class="dot"></span><span>${state.laserHost}</span>`;
    pill.title = st === "online" ? `Laser online at ${state.laserHost}`
      : st === "busy" ? `Sending to ${state.laserHost}…` : "Checking the laser…";
  }
  pill.disabled = st === "scanning";
  updatePlacement();
}

async function pollLaser() {
  clearTimeout(pollTimer);
  if (state.laser !== "scanning") {
    try {
      const r = await (await fetch("/api/laser/status")).json();
      state.laserHost = r.host;
      state.laser = r.busy ? "busy" : r.online ? "online" : "offline";
    } catch (e) { state.laser = "offline"; }   // the server itself is gone
    renderLaser();
    if (state.laser === "offline" && Date.now() - lastScan > SCAN_EVERY) scanLaser();
  }
  pollTimer = setTimeout(pollLaser, POLL_EVERY);
}

async function scanLaser() {
  if (state.laser === "scanning") return;
  lastScan = Date.now();
  hidePick();
  state.laser = "scanning"; renderLaser();
  let r = null;
  try { r = await (await fetch("/api/laser/scan", { method: "POST", body: "{}" })).json(); } catch (e) {}
  lastScan = Date.now();
  if (r && r.online) { state.laserHost = r.host; state.laser = "online"; }
  else state.laser = "offline";
  renderLaser();
  // several LPD devices answered and none is the configured laser: ask which
  if (r && !r.online && r.found && r.found.length > 1) showPick(r.found);
}

async function adoptLaser(host) {
  hidePick();
  try {
    const r = await (await fetch("/api/laser/scan", { method: "POST", body: JSON.stringify({ host }) })).json();
    state.laserHost = r.host; state.laser = r.online ? "online" : "offline";
  } catch (e) { state.laser = "offline"; }
  renderLaser();
}

function showPick(hosts) {
  const pick = $("#laserPick"), r = $("#laserPill").getBoundingClientRect();
  pick.innerHTML = "<p>Several printers answered — which one is the laser?</p>";
  hosts.forEach(h => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = h; b.onclick = () => adoptLaser(h);
    pick.appendChild(b);
  });
  pick.style.left = r.left + "px"; pick.style.top = (r.bottom + 6) + "px";
  pick.hidden = false;
}
function hidePick() { $("#laserPick").hidden = true; }
document.addEventListener("click", e => { if (!e.target.closest(".laserwrap")) hidePick(); });

$("#laserPill").onclick = () => { if (state.laser === "offline") scanLaser(); };

// size the bed SVG to fill its container while preserving the bed aspect
// (exact 1:1 viewBox mapping keeps drag math simple)
function fitBed() {
  if (!state.machine) return;
  const wrap = document.querySelector(".bedwrap");
  // clientWidth includes the gutters, so take the padding off explicitly
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const A = state.vb.w / state.vb.h;
  let w = availW, h = w / A;
  if (h > availH) { h = availH; w = h * A; }
  const bed = $("#bed");
  bed.style.width = Math.max(50, w) + "px";
  bed.style.height = Math.max(50, h) + "px";
}
window.addEventListener("resize", fitBed);

// ---------- material size (the stock sheet on the bed) ----------
// Common stock sizes, long side first. Each is offered landscape (long side
// along X, the bed's long axis) and portrait, but only in the orientations
// that fit the selected machine's bed. The sheet starts in the bed's origin
// corner (top-left) and can be dragged / typed to where the stock really sits.
const SHEETS = [
  ["ISO", [["A1", 841, 594], ["A2", 594, 420], ["A3", 420, 297], ["A4", 297, 210],
           ["A5", 210, 148], ["A6", 148, 105]]],
  ["Architectural", [["Arch A", 304.8, 228.6], ["Arch B", 457.2, 304.8],
                     ["Arch C", 609.6, 457.2], ["Arch D", 914.4, 609.6]]],
  ["ANSI", [["Letter", 279.4, 215.9], ["Legal", 355.6, 215.9], ["Tabloid", 431.8, 279.4]]],
];
const mmTxt = v => (Math.round(v * 10) / 10).toString();
function sheetChoices() {
  const m = state.machine, fits = (w, h) => w <= m.bed_w_mm + 0.5 && h <= m.bed_h_mm + 0.5;
  return SHEETS.map(([group, list]) => [group, list.flatMap(([name, L, S]) => {
    const out = [];
    if (fits(L, S)) out.push({ id: name + "|L", name, w: L, h: S, label: `${name} · ${mmTxt(L)}×${mmTxt(S)}` });
    if (L !== S && fits(S, L)) out.push({ id: name + "|P", name, w: S, h: L, label: `${name} portrait · ${mmTxt(S)}×${mmTxt(L)}` });
    return out;
  })]).filter(([, list]) => list.length);
}
function renderSheetOptions() {
  const sel = $("#sheet");
  sel.innerHTML = '<option value="">— material size —</option>';
  sheetChoices().forEach(([group, list]) => {
    const og = document.createElement("optgroup");
    og.label = group;
    list.forEach(s => og.appendChild(new Option(s.label, s.id)));
    sel.appendChild(og);
  });
  let saved = "";
  try { saved = localStorage.getItem("hs-sheet") || ""; } catch (e) {}
  sel.value = [...sel.options].some(o => o.value === saved) ? saved : "";
  try { Object.assign(state.sheetOff, JSON.parse(localStorage.getItem("hs-sheet-off")) || {}); } catch (e) {}
}
function currentSheet() {
  const v = $("#sheet").value;
  if (!v) return null;
  for (const [, list] of sheetChoices()) for (const s of list) if (s.id === v) return s;
  return null;
}
// the sheet as placed: size + offset, kept on the bed, whole millimetres
function sheetBox() {
  const s = currentSheet();
  if (!s) return null;
  const m = state.machine, o = state.sheetOff;
  o.x = Math.round(Math.max(0, Math.min(o.x, m.bed_w_mm - s.w)));
  o.y = Math.round(Math.max(0, Math.min(o.y, m.bed_h_mm - s.h)));
  return { ...s, x: o.x, y: o.y };
}
function saveSheet() {
  try {
    localStorage.setItem("hs-sheet", $("#sheet").value);
    localStorage.setItem("hs-sheet-off", JSON.stringify(state.sheetOff));
  } catch (e) {}
}
function drawSheet() {
  if (!bedEls) return;
  const s = sheetBox();
  syncPanel();
  if (!s) { bedEls.sheet.setAttribute("hidden", "hidden"); return; }
  for (const [k, v] of Object.entries({ x: s.x, y: s.y, width: s.w, height: s.h }))
    bedEls.sheetRect.setAttribute(k, v);
  bedEls.sheetLbl.setAttribute("x", s.x + s.w - 6);
  bedEls.sheetLbl.setAttribute("y", s.y + s.h - 7);
  bedEls.sheetLbl.textContent = `${s.name} · ${mmTxt(s.w)} × ${mmTxt(s.h)} mm`;
  bedEls.sheet.removeAttribute("hidden");
  $("#sheetWhich").textContent = "· " + s.name;
  $("#sheetx").value = s.x;
  $("#sheety").value = s.y;
  $("#sheetInfo").textContent = `${mmTxt(s.w)}×${mmTxt(s.h)} mm at (${s.x}, ${s.y}) · reaches (${mmTxt(s.x + s.w)}, ${mmTxt(s.y + s.h)})`;
  const rot = sheetTurn(s), btn = $("#sheetRotate");
  $("#sheetOrient").textContent = s.id.endsWith("|P") ? "portrait" : "landscape";
  btn.disabled = !rot.ok;
  btn.title = rot.ok ? `Turn to ${rot.alt.label}` : rot.why;
  $("#sheetRotWhy").hidden = rot.ok;
  $("#sheetRotWhy").textContent = rot.ok ? "" : "Can't rotate: " + rot.why;
}

// the same sheet turned 90° about its corner at the current offset: only
// possible when that orientation fits the bed at all, and — from where the
// sheet sits now — doesn't run off the bed's far edges
function sheetTurn(s) {
  const [name, o] = s.id.split("|"), m = state.machine;
  const want = name + "|" + (o === "L" ? "P" : "L");
  let alt = null;
  for (const [, list] of sheetChoices()) for (const c of list) if (c.id === want) alt = c;
  if (!alt) return { ok: false, why: `${name} ${o === "L" ? "portrait" : "landscape"} doesn't fit this bed` };
  const overX = s.x + alt.w - m.bed_w_mm, overY = s.y + alt.h - m.bed_h_mm;
  if (overX > 0.01 || overY > 0.01) {
    const need = [];
    const lim = (axis, v) => v <= 0 ? `${axis} = 0` : `${axis} ≤ ${v}`;
    if (overX > 0.01) need.push(lim("X", Math.floor(m.bed_w_mm - alt.w)));
    if (overY > 0.01) need.push(lim("Y", Math.floor(m.bed_h_mm - alt.h)));
    return { ok: false, alt, why: `turned, the ${name} would run off the bed at (${s.x}, ${s.y}). ` +
      `Move it to ${need.join(" and ")} first.` };
  }
  return { ok: true, alt };
}
const moveSheet = () => { drawSheet(); updatePlacement(); saveSheet(); };
$("#sheet").onchange = moveSheet;
$("#sheetx").oninput = e => { state.sheetOff.x = +e.target.value || 0; moveSheet(); };
$("#sheety").oninput = e => { state.sheetOff.y = +e.target.value || 0; moveSheet(); };
$("#sheetRotate").onclick = () => {
  const s = sheetBox(), rot = s && sheetTurn(s);
  if (rot && rot.ok) { $("#sheet").value = rot.alt.id; moveSheet(); }
};
$("#sheetHome").onclick = () => { state.sheetOff = { x: 0, y: 0 }; moveSheet(); };

// the floating panel: Material while a sheet is chosen, Placement once a PDF is in
function syncPanel() {
  $("#sheetSection").hidden = !currentSheet();
  $("#placeSection").hidden = !state.docs.length;
  $("#controls").hidden = !state.docs.length && !currentSheet();
}

// ---------- import ----------
// Any number of PDFs can be open at once: drop more on at any time, and pick
// pages from any of them onto the same bed. Each import is its own server-side
// session; an item on the bed remembers which one it came from.
const drop = $("#drop"), fileInput = $("#file"), addHint = $("#addHint");
const isPdf = f => f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name));
const hasFiles = e => [...(e.dataTransfer ? e.dataTransfer.types : [])].includes("Files");

drop.onclick = () => fileInput.click();
$("#addPdf").onclick = () => fileInput.click();
fileInput.onchange = e => { importFiles(e.target.files); e.target.value = ""; };

// one drop handler for the whole window: the empty state highlights its box,
// and once pages are on the bed a hint says the file will be added
document.addEventListener("dragover", e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (state.docs.length) addHint.hidden = false; else drop.classList.add("hot");
});
document.addEventListener("dragleave", e => { if (!e.relatedTarget) endDrag(); });
document.addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); endDrag();
  importFiles(e.dataTransfer.files);
});
function endDrag() { addHint.hidden = true; drop.classList.remove("hot"); }

// imported one after another so the page rail (and the bed) fill in order
function importFiles(list) {
  const pdfs = [...list].filter(isPdf);
  if (pdfs.length) pdfs.reduce((p, f) => p.then(() => importPdf(f)), Promise.resolve());
}

function dropMsg(big, hint, bad) {
  $("#dropBig").textContent = big;
  $("#dropHint").textContent = hint;
  $("#dropHint").className = bad ? "warn" : "hint";
}
const DROP_IDLE = ["Drop PDFs here", "or click to choose · one file or several"];

async function importPdf(file) {
  const first = !state.docs.length;
  if (first) dropMsg("Importing…", file.name);
  let data;
  try {
    const buf = await file.arrayBuffer();
    data = await (await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
      body: buf,
    })).json();
  } catch (e) { data = { error: e.message }; }
  if (data.error) {
    if (first) dropMsg("Couldn't read that PDF", data.error, true);
    else alert(`${file.name}: ${data.error}`);
    return;
  }
  const doc = { id: data.id, name: data.name || file.name, pages: data.pages || 1, pd: { 1: data } };
  state.docs.push(doc);   // import answers with page 1 already loaded
  drop.hidden = true;
  dropMsg(...DROP_IDLE);
  syncPanel();
  buildRail();
  fitBed();
  await includePage(doc.id, 1);
}

function artTransform(R, ox, oy, x0, y0, cw, ch) {
  if (R === 90)  return `translate(${ox} ${oy}) translate(${ch} 0) rotate(90) translate(${-x0} ${-y0})`;
  if (R === 180) return `translate(${ox} ${oy}) translate(${cw} ${ch}) rotate(180) translate(${-x0} ${-y0})`;
  if (R === 270) return `translate(${ox} ${oy}) translate(0 ${cw}) rotate(270) translate(${-x0} ${-y0})`;
  return `translate(${ox - x0} ${oy - y0})`;
}
$("#brand").onclick = () => location.reload();

// ---------- documents and their pages ----------
const docFor = id => state.docs.find(d => d.id === id) || null;
// files are lettered in the order they were dropped: page 2 of the second file
// is "B2" on the bed and in the rail
const docLetter = id => String.fromCharCode(65 + state.docs.findIndex(d => d.id === id));
const manyDocs = () => state.docs.length > 1;
const allPages = () => state.docs.reduce((n, d) => n + d.pages, 0);
// the rail is worth showing as soon as there is a choice to make
const showRail = () => manyDocs() || allPages() > 1;
// what a page is called: "p3" on its own, "B3" once several files are open
const pageTag = it => manyDocs() ? docLetter(it.doc) + it.page : "p" + it.page;
const pageName = it => manyDocs() ? pageTag(it) : "page " + it.page;
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

// ---------- page rail ----------
// Every page of every open PDF as a thumbnail down the left, grouped by file;
// pages on the bed are highlighted and the one being placed is ringed. Include
// puts a page on the bed in the first free spot; Remove takes it off.
function buildRail() {
  const rail = $("#rail"), list = $("#thumbs");
  rail.hidden = !showRail();
  list.innerHTML = "";
  if (rail.hidden) return;
  state.docs.forEach(d => {
    const grp = document.createElement("div");
    grp.className = "docgrp";
    grp.innerHTML = `<div class="dochead">${manyDocs() ? `<b class="letter">${docLetter(d.id)}</b>` : ""}` +
      `<b title="${esc(d.name)}">${esc(d.name)}</b>` +
      `<button type="button" class="docx" title="Remove ${esc(d.name)}">✕</button></div>`;
    grp.querySelector(".docx").onclick = () => removeDoc(d);
    for (let n = 1; n <= d.pages; n++) {
      const card = document.createElement("div");
      card.className = "thumb";
      card.dataset.doc = d.id; card.dataset.page = n;
      card.innerHTML = `<div class="tframe"><img loading="lazy" alt="Page ${n}" src="/thumb/${d.id}/${n}.png"></div>
        <div class="tfoot"><span>Page ${n}</span><button type="button" class="tbtn"></button></div>`;
      card.onclick = e => {
        const it = itemFor(d.id, n);
        if (e.target.closest(".tbtn")) { it ? removeItem(it) : includePage(d.id, n); return; }
        if (it) select(it);
      };
      grp.appendChild(card);
    }
    list.appendChild(grp);
  });
  $("#includeAll").onclick = async () => {
    for (const d of state.docs)
      for (let n = 1; n <= d.pages; n++) if (!itemFor(d.id, n)) await includePage(d.id, n);
  };
  renderRail();
}
function renderRail() {
  if ($("#rail").hidden) return;
  document.querySelectorAll("#thumbs .thumb").forEach(card => {
    const it = itemFor(card.dataset.doc, +card.dataset.page), btn = card.querySelector(".tbtn");
    card.classList.toggle("on", !!it);
    card.classList.toggle("active", !!it && it === state.active);
    card.classList.toggle("bad", !!it && it.bad);
    if (!card.classList.contains("busy") && !card.classList.contains("blank"))
      btn.textContent = it ? "Remove" : "Include";
  });
  const on = state.items.length, all = allPages();
  $("#railCount").textContent = manyDocs()
    ? `${on} of ${all} · ${state.docs.length} files`
    : `${on} of ${all} on the bed`;
  $("#includeAll").hidden = on === all;
}

// ---------- bed items: one per page placed on the bed ----------
const itemFor = (docId, n) => state.items.find(it => it.doc === docId && it.page === n) || null;

async function includePage(docId, n) {
  const have = itemFor(docId, n);
  if (have) return select(have);
  const d = docFor(docId);
  if (!d) return;
  const card = document.querySelector(`#thumbs .thumb[data-doc="${docId}"][data-page="${n}"]`);
  let pd = d.pd[n];
  if (!pd) {
    if (card) { card.classList.add("busy"); card.querySelector(".tbtn").textContent = "Loading…"; }
    try { pd = await (await fetch(`/api/page/${docId}/${n}`)).json(); }
    catch (e) { pd = { error: e.message }; }
    if (card) card.classList.remove("busy");
    if (pd.error) { renderRail(); alert(`${d.name} page ${n}: ${pd.error}`); return; }
    d.pd[n] = pd;
  }
  // a blank page has nothing to place — except the first page of the first
  // file, which keeps the single-page behaviour of landing on the bed with a
  // "no artwork" warning
  if (!pd.content_mm && !(n === 1 && state.docs.length === 1)) {
    if (card) { card.classList.add("blank"); card.querySelector(".tbtn").textContent = "Blank"; }
    renderRail();
    return;
  }
  const it = { doc: docId, page: n, pd, off: { x: 0, y: 0 }, rot: 0 };
  it.els = buildItemEls(it);
  state.items.push(it);
  // the first page centres on the stock; later ones take the first free spot
  if (state.items.length === 1 || !placeFree(it)) centerIn(it);
  select(it);
}

function removeItem(it) {
  it.els.g.remove(); it.els.cp.remove();
  state.items = state.items.filter(o => o !== it);
  if (state.active === it) state.active = state.items[state.items.length - 1] || null;
  if (state.active) select(state.active); else { updatePlacement(); renderRail(); }
}

// closing a file takes its pages off the bed with it; with the last one gone
// the app is back to its empty state, ready for a fresh drop
function removeDoc(d) {
  state.items.filter(it => it.doc === d.id).forEach(it => { it.els.g.remove(); it.els.cp.remove(); });
  state.items = state.items.filter(it => it.doc !== d.id);
  state.docs = state.docs.filter(o => o !== d);
  if (state.active && !state.items.includes(state.active))
    state.active = state.items[state.items.length - 1] || null;
  if (!state.docs.length) { drop.hidden = false; dropMsg(...DROP_IDLE); }
  syncPanel();
  buildRail();
  fitBed();
  updatePlacement();
}

function select(it) {
  state.active = it;
  bedEls.items.appendChild(it.els.g);   // draw (and hit-test) the selected page on top
  highlight(); updatePlacement(); renderRail();
}

function buildItemEls(it) {
  const pd = it.pd, id = `clip-${it.doc}-${it.page}`;
  const cp = mk("clipPath", { id, clipPathUnits: "userSpaceOnUse" });
  const clipR = mk("rect", { x: 0, y: 0, width: 1, height: 1 });
  cp.appendChild(clipR); bedEls.defs.appendChild(cp);
  const g = mk("g", {});
  const ig = mk("g", { "clip-path": `url(#${id})` });
  const img = mk("image", { preserveAspectRatio: "none", href: pd.preview + "?t=" + Date.now(),
    width: pd.width_mm, height: pd.height_mm });
  ig.appendChild(img); g.appendChild(ig);
  // engrave wash (green) + cut-line overlay (red vectors)
  const engwash = mk("rect", { fill: "rgba(123,216,143,.28)", "pointer-events": "none", hidden: "hidden" });
  const cutlines = mk("g", { fill: "none", "stroke-width": 0.9, "stroke-linejoin": "round",
    "pointer-events": "none", hidden: "hidden" });
  (pd.vectors || []).forEach(pl =>
    cutlines.appendChild(mk("polyline", { points: pl.map(p => p[0] + "," + p[1]).join(" "), fill: "none" })));
  // coloured border on top — pointer-events:all so the whole box is draggable despite fill:none
  const art = mk("rect", { class: "art", rx: 1.5, fill: "none", "pointer-events": "all" });
  // the label is set in updatePlacement: it changes as files come and go
  const tag = mk("text", { class: "ptag", "font-size": 9, "pointer-events": "none" });
  g.append(engwash, cutlines, art, tag);
  bedEls.items.appendChild(g);
  attachDrag(art, it);
  return { g, cp, clipR, img, engwash, cutlines, art, tag };
}

// ---------- placement helpers ----------
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function artDims(it) {
  const c = it && it.pd.content_mm;
  if (!c) return { w: 0, h: 0 };
  return (it.rot % 180 === 0) ? { w: c.w_mm, h: c.h_mm } : { w: c.h_mm, h: c.w_mm };
}
function bounds() {
  const m = state.machine, s = m.safety_mm != null ? m.safety_mm : (m.margin_mm || 3);
  return { minX: s, minY: s,
           maxX: Math.min(m.usable_w_mm, m.bed_w_mm - s),
           maxY: Math.min(m.usable_h_mm, m.bed_h_mm - s), s };
}
// where pages should go: on the stock sheet (inside the safety margin) first,
// then anywhere on the bed
function areas() {
  const B = bounds(), S = sheetBox(), out = [];
  if (S) out.push({ minX: Math.max(B.minX, S.x), minY: Math.max(B.minY, S.y),
                    maxX: Math.min(B.maxX, S.x + S.w), maxY: Math.min(B.maxY, S.y + S.h) });
  out.push(B);
  return out;
}
const rectOf = it => { const d = artDims(it); return { x: it.off.x, y: it.off.y, w: d.w, h: d.h }; };
function hit(a, b) {   // overlapping area (touching edges don't count), or null
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return (x1 - x0 > 0.01 && y1 - y0 > 0.01) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
function clampOff(it) {
  const d = artDims(it), B = bounds();
  it.off.x = Math.max(B.minX, Math.min(it.off.x, B.maxX - d.w));
  it.off.y = Math.max(B.minY, Math.min(it.off.y, B.maxY - d.h));
}
function centerIn(it) {
  const d = artDims(it);
  const A = areas().find(a => a.maxX - a.minX >= d.w && a.maxY - a.minY >= d.h) || bounds();
  it.off.x = Math.max(A.minX, (A.minX + A.maxX - d.w) / 2);
  it.off.y = Math.max(A.minY, (A.minY + A.maxY - d.h) / 2);
  updatePlacement();
}
// first spot (top-down, then left-right, 5 mm steps) that keeps a 3 mm gap to
// every other page; false when the bed is too full
function placeFree(it) {
  const d = artDims(it), GAP = 3, STEP = 5;
  const others = state.items.filter(o => o !== it && o.pd.content_mm).map(rectOf)
    .map(r => ({ x: r.x - GAP, y: r.y - GAP, w: r.w + 2 * GAP, h: r.h + 2 * GAP }));
  for (const A of areas())
    for (let y = A.minY; y + d.h <= A.maxY + 0.01; y += STEP)
      for (let x = A.minX; x + d.w <= A.maxX + 0.01; x += STEP)
        if (!others.some(o => hit({ x, y, w: d.w, h: d.h }, o))) { it.off = { x, y }; return true; }
  return false;
}

// ---------- bed (built once; pages are added to bedEls.items) ----------
let bedEls = null;
const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

function buildBed() {
  const bed = $("#bed"), m = state.machine;
  bed.innerHTML = "";
  const defs = mk("defs", {});
  bed.appendChild(defs);

  bed.appendChild(mk("rect", { x: 0, y: 0, width: m.bed_w_mm, height: m.bed_h_mm, fill: "var(--bed)", stroke: "var(--line)", "stroke-width": 1 }));
  // the stock sheet — draggable; pages sit above it, so they still win the click
  const sheet = mk("g", { hidden: "hidden" });
  const sheetRect = mk("rect", { class: "sheetrect", rx: 2, fill: "var(--sheet)", stroke: "var(--sheetline)",
    "stroke-width": 1.2, "pointer-events": "all" });
  const sheetLbl = mk("text", { "font-size": 10, "text-anchor": "end", fill: "var(--sheetline)", "pointer-events": "none" });
  sheet.append(sheetRect, sheetLbl);
  bed.appendChild(sheet);
  const B = bounds();  // dashed safety boundary = allowed placement area
  bed.appendChild(mk("rect", {
    x: B.minX, y: B.minY, width: B.maxX - B.minX, height: B.maxY - B.minY,
    fill: "none", stroke: "var(--warn, #ffb454)", "stroke-dasharray": "8 6", "stroke-width": 1.5,
  }));
  drawRulers(bed, m);
  bed.appendChild(mk("circle", { cx: 0, cy: 0, r: 6, fill: "var(--accent2)" }));

  const items = mk("g", {});
  const overlaps = mk("g", { "pointer-events": "none" });   // red wash where pages collide
  bed.append(items, overlaps);
  bedEls = { defs, items, overlaps, sheet, sheetRect, sheetLbl };
  dragWith(sheetRect, () => state.sheetOff, (x, y) => { state.sheetOff = { x, y }; moveSheet(); });
  drawSheet();
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

// drag an SVG element in bed mm: getOff() gives the starting {x, y},
// setOff(x, y) receives the new one on every move
function dragWith(el, getOff, setOff, onStart) {
  let start = null;
  el.addEventListener("pointerdown", e => {
    if (onStart) onStart();
    const r = $("#bed").getBoundingClientRect();
    const scale = state.vb.w / r.width;  // mm per px (uniform; viewBox incl. gutters)
    const o = getOff();
    start = { px: e.clientX, py: e.clientY, ox: o.x, oy: o.y, scale };
    el.classList.add("drag");
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", e => {
    if (!start) return;
    setOff(start.ox + (e.clientX - start.px) * start.scale, start.oy + (e.clientY - start.py) * start.scale);
  });
  const end = () => { start = null; el.classList.remove("drag"); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
function attachDrag(art, it) {
  dragWith(art, () => it.off, (x, y) => { it.off = { x, y }; clampOff(it); updatePlacement(); },
    () => { if (state.active !== it) select(it); });
}

function updatePlacement() {
  if (!bedEls || !state.docs.length) return;
  const B = bounds(), S = sheetBox(), multi = showRail();
  const problems = [], notes = [];

  // each page: in bounds? then draw it
  state.items.forEach(it => {
    const c = it.pd.content_mm;
    clampOff(it);
    const d = artDims(it), ox = it.off.x, oy = it.off.y, E = it.els;
    it.inBounds = !!c && ox >= B.minX - 0.01 && oy >= B.minY - 0.01 &&
                  ox + d.w <= B.maxX + 0.01 && oy + d.h <= B.maxY + 0.01;
    for (const el of [E.art, E.clipR, E.engwash]) {
      el.setAttribute("x", ox); el.setAttribute("y", oy);
      el.setAttribute("width", Math.max(d.w, 0.1)); el.setAttribute("height", Math.max(d.h, 0.1));
    }
    if (c) {
      const tf = artTransform(it.rot, ox, oy, c.x0_mm, c.y0_mm, c.w_mm, c.h_mm);
      E.img.setAttribute("transform", tf);
      E.cutlines.setAttribute("transform", tf);
    }
    E.tag.setAttribute("x", ox + 1); E.tag.setAttribute("y", oy - 3);
    E.tag.textContent = pageTag(it);
    if (multi) E.tag.removeAttribute("hidden"); else E.tag.setAttribute("hidden", "hidden");
    if (!c) problems.push(`⚠ No printable artwork detected on ${pageName(it)}.`);
    else if (!it.inBounds) problems.push(`⚠ ${multi ? cap(pageName(it)) + " is i" : "I"}nside the ${B.s} mm safety margin. Move it within the dashed boundary.`);
    if (S && c && (ox < S.x - 0.01 || oy < S.y - 0.01 ||
                   ox + d.w > S.x + S.w + 0.01 || oy + d.h > S.y + S.h + 0.01))
      notes.push(`${multi ? cap(pageName(it)) : "The artwork"} runs past the ${S.name} sheet.`);
  });

  // overlaps between pages: red wash over the shared area, both borders red
  bedEls.overlaps.innerHTML = "";
  state.items.forEach(it => { it.bad = !it.inBounds; });
  for (let i = 0; i < state.items.length; i++)
    for (let j = i + 1; j < state.items.length; j++) {
      const a = state.items[i], b = state.items[j];
      if (!a.pd.content_mm || !b.pd.content_mm) continue;
      const o = hit(rectOf(a), rectOf(b));
      if (!o) continue;
      a.bad = b.bad = true;
      bedEls.overlaps.appendChild(mk("rect", { x: o.x, y: o.y, width: o.w, height: o.h,
        fill: "var(--danger)", "fill-opacity": 0.35, stroke: "var(--danger)", "stroke-width": 1 }));
      problems.push(`⚠ ${cap(pageName(a))} and ${pageName(b)} overlap — drag them apart.`);
    }
  state.items.forEach(it => {
    it.els.art.setAttribute("stroke", it.bad ? "var(--danger)" : "var(--accent)");
    it.els.art.setAttribute("stroke-width", it === state.active ? 2.5 : 1.3);
  });

  // the Artwork card edits the selected page
  const it = state.active;
  const who = $("#placeWhich");
  who.textContent = it && multi ? "· " + (manyDocs() ? pageTag(it) : "page " + it.page) : "";
  who.title = it && manyDocs() ? `page ${it.page} of ${docFor(it.doc).name}` : "";
  ["#offx", "#offy", "#rotateBtn", "#centerBtn"].forEach(s => { $(s).disabled = !it; });
  if (it) {
    const d = artDims(it);
    $("#offx").value = Math.round(it.off.x);
    $("#offy").value = Math.round(it.off.y);
    $("#rotLbl").textContent = it.rot + "°";
    const turn = artTurn(it);
    $("#rotateBtn").disabled = !turn.ok;
    $("#rotateBtn").title = turn.ok ? `Rotate to ${(it.rot + 90) % 360}°` : turn.why;
    $("#rotWhy").hidden = turn.ok;
    $("#rotWhy").textContent = turn.ok ? "" : "Can't rotate: " + turn.why;
    $("#placeInfo").textContent =
      `Artwork ${d.w.toFixed(0)}×${d.h.toFixed(0)} mm at (${it.off.x.toFixed(0)}, ${it.off.y.toFixed(0)}) · ` +
      `reaches (${(it.off.x + d.w).toFixed(0)}, ${(it.off.y + d.h).toFixed(0)}) · bed ${state.machine.bed_w_mm}×${state.machine.bed_h_mm}` +
      (multi ? ` · ${state.items.length} page${state.items.length === 1 ? "" : "s"} on the bed` +
        (manyDocs() ? ` from ${new Set(state.items.map(o => o.doc)).size} files` : "") : "");
  } else {
    $("#rotWhy").hidden = true;
    $("#placeInfo").textContent = "No pages on the bed — include one from the page list.";
  }
  const warn = $("#boundsWarn");
  warn.hidden = !problems.length;
  warn.textContent = problems.join("\n") + (problems.length ? "\nSending disabled." : "");
  const note = $("#sheetNote");
  note.hidden = !notes.length;
  note.textContent = notes.join("\n");

  const reachable = state.laser === "online";
  $("#sendBtn").disabled = state.sending || !state.items.length || problems.length > 0 ||
    !currentOp() || !reachable;
  $("#sendBtn").title = reachable ? "" : "The laser isn't reachable — scan for it first";
  renderRail();
}

$("#offx").oninput = e => { if (state.active) { state.active.off.x = +e.target.value || 0; updatePlacement(); } };
$("#offy").oninput = e => { if (state.active) { state.active.off.y = +e.target.value || 0; updatePlacement(); } };
// the same rule as the material: a 90° turn about the artwork's top-left
// corner swaps its width and height, and is only offered when the turned
// artwork still sits inside the safety boundary from where it is now
function artTurn(it) {
  const d = artDims(it), B = bounds();
  if (!it.pd.content_mm) return { ok: false, why: "there is no artwork on this page" };
  if (d.h > B.maxX - B.minX + 0.01 || d.w > B.maxY - B.minY + 0.01)
    return { ok: false, why: `turned, the ${d.h.toFixed(0)}×${d.w.toFixed(0)} mm artwork is bigger than the safe area` };
  const need = [];
  if (it.off.x + d.h > B.maxX + 0.01) need.push(`X ≤ ${Math.floor(B.maxX - d.h)}`);
  if (it.off.y + d.w > B.maxY + 0.01) need.push(`Y ≤ ${Math.floor(B.maxY - d.w)}`);
  if (need.length)
    return { ok: false, why: `turned, it would cross the safety boundary at (${Math.round(it.off.x)}, ${Math.round(it.off.y)}). Move it to ${need.join(" and ")} first.` };
  return { ok: true };
}
$("#rotateBtn").onclick = () => {
  const it = state.active;
  if (!it || !artTurn(it).ok) return;
  it.rot = (it.rot + 90) % 360; updatePlacement();
};
$("#centerBtn").onclick = () => state.active && centerIn(state.active);

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
    // the preset labels carry their own "(300 DPI)" / "(3 mm)" which we append
    // anyway — drop the parenthetical so the option text stays readable
    const label = op.label.replace(/\s*\((?:\d+\s*DPI|[\d.]+\s*mm)\)/i, "");
    sel.appendChild(new Option(`${icon} ${label} · S${op.speed} P${op.power} · ${extra}${thk}`, i));
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  fitSelect(sel);
  highlight(); updatePlacement();
}
$("#material").onchange = renderPresets;
$("#thickness").onchange = renderPresets;
$("#preset").onchange = () => { highlight(); updatePlacement(); };

// highlight artwork by selected preset: cut → red vector lines, engrave → green wash
function highlight() {
  const op = currentOp();
  const isCut = op && op.type === "cut", isEng = op && op.type === "engrave";
  state.items.forEach(({ els }) => {
    els.cutlines.setAttribute("stroke", isCut ? "var(--danger)" : "transparent");
    if (isCut) els.cutlines.removeAttribute("hidden"); else els.cutlines.setAttribute("hidden", "hidden");
    if (isEng) els.engwash.removeAttribute("hidden"); else els.engwash.setAttribute("hidden", "hidden");
  });
}

// ---------- send (one operation over every page on the bed, as one job) ----------
$("#sendBtn").onclick = async () => {
  const op = currentOp();
  if (!op) { alert("Choose a material and preset first."); return; }
  const operation = { type: op.type, speed: op.speed, power: op.power, dpi: op.dpi, freq: op.freq };
  const btn = $("#sendBtn"); btn.disabled = true; state.sending = true; $("#sendLbl").textContent = "Sending…";
  const out = $("#out"); out.classList.add("on"); out.textContent = "working…";
  const items = state.items.map(it => ({ doc: it.doc, page: it.page,
                                         offset_mm: [it.off.x, it.off.y], rotation: it.rot }));
  const files = new Set(items.map(i => i.doc)).size;
  try {
    const data = await (await fetch("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: state.docs[0].id, host: state.laserHost, operation, items, autofocus: false }),
    })).json();
    if (data.error) out.textContent = "ERROR: " + data.error;
    else out.textContent = `Sent to ${data.host} — press GO on the machine\n· ${data.jobs[0].title}` +
      (items.length > 1 ? ` (${items.length} pages${files > 1 ? ` from ${files} files` : ""})` : "") +
      `: ${data.jobs[0].bytes} bytes → SENT`;
  } catch (e) { out.textContent = "ERROR: " + e.message; }
  state.sending = false; $("#sendLbl").textContent = "Send";
  updatePlacement();
  pollLaser();   // re-check now: a failed send usually means the laser dropped
};

boot();
