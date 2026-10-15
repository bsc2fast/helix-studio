// Helix Studio — front-end
const $ = s => document.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";
// Display only: a ruler on every side of the bed picture, so an equal margin
// all round. None of this reaches the laser — bed geometry comes from the
// machine config, and placement is always measured from the home corner.
const GUT = 34;   // mm margin on each side, for the rulers
const state = {
  materials: [], machine: null, laserHost: "192.168.1.6",
  docs: [],           // imported PDFs, in the order they arrived:
                      //   {id, name, pages, pd: {n -> page geometry}}
  items: [],          // pages on the bed: {uid, doc, page, pd, off:{x,y}, rot, els}
                      // the same page may be on the bed several times (copies)
  active: null,       // the item the Placement panel edits
  sheetOff: { x: 0, y: 0 },   // where the stock sheet sits on the bed (mm)
  laser: "checking",   // checking | online | busy | offline | scanning
  sending: false,
  vb: { w: 1, h: 1 }, page: { w: 0, h: 0 },
  prefs: {},          // last setup, kept in prefs.json next to the server
  finish: null,       // the material's colour ("Walnut", "Black acrylic"…) — picker.js knows the list
};

// ---------- last setup (server-side prefs.json, so it survives the browser) ----------
// Material, thickness, stock size and where the stock lies are remembered as
// they change; the next session opens on the same setup. The preset is NOT
// remembered — a new session starts on the material's first preset.
let prefsTimer = null;
function savePrefs(patch) {
  Object.assign(state.prefs, patch);
  clearTimeout(prefsTimer);   // dragging the sheet fires on every pointermove
  prefsTimer = setTimeout(() => {
    fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(state.prefs) }).catch(() => {});
  }, 400);
}
// set a <select> to a saved value, but only if that option still exists
function restore(sel, value) {
  if (value && [...sel.options].some(o => o.value === value)) { sel.value = value; return true; }
  return false;
}
// with nothing saved (or the saved option gone), start on the first real option
// rather than the "— placeholder —"
function firstOption(sel) {
  const o = [...sel.options].find(o => o.value !== "" && !o.disabled);
  if (o) sel.value = o.value;
}

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
  const [cfg, prefs] = await Promise.all([
    (await fetch("/api/config")).json(),
    fetch("/api/prefs").then(r => r.json()).catch(() => ({})),
  ]);
  state.prefs = prefs || {};
  state.units = state.prefs.units === "in" ? "in" : "mm";
  state.machine = cfg.machine;
  state.laserHost = cfg.laser_host;
  renderLaser();
  pollLaser();
  const msel = $("#machine");
  (cfg.machines || [cfg.machine]).forEach(mm => msel.appendChild(new Option(mm.name, mm.name)));
  msel.value = cfg.machine.name;
  restore(msel, state.prefs.machine);
  msel.onchange = () => savePrefs({ machine: msel.value });
  const m = cfg.machine;
  state.vb = { w: m.bed_w_mm + 2 * GUT, h: m.bed_h_mm + 2 * GUT };
  $("#bed").setAttribute("viewBox", `${-GUT} ${-GUT} ${state.vb.w} ${state.vb.h}`);
  renderSheetOptions();
  buildBed();
  fitBed();

  const mat = await (await fetch("/api/materials")).json();
  state.materials = mat.materials;
  const sel = $("#material");
  mat.materials.forEach(mm => sel.appendChild(new Option(mm.name, mm.name)));
  // pick up where the last session left off — presets are then listed for it,
  // but none is selected: that choice is made per job
  if (!restore(sel, state.prefs.material)) firstOption(sel);
  state.finish = state.prefs.finish || null;
  syncFinish();
  refreshSheets();   // the material is known now: offer its own sizes too
  if (!restore($("#thickness"), state.prefs.thickness)) firstOption($("#thickness"));
  renderPresets();
  drawSheet();   // the bed was drawn before the material was known: paint the stock now
  applyUnits();
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
  // the side cards line up with the bed: they start at its top edge and end at
  // its bottom edge, wherever centring put it
  const main = document.querySelector("main"), mr = main.getBoundingClientRect(), br = bed.getBoundingClientRect();
  const top = Math.round(br.top - mr.top), bottom = Math.round(br.bottom - mr.top);
  main.style.setProperty("--bed-top", top + "px");
  main.style.setProperty("--bed-h", bottom - top + "px");
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
// ---------- display units (Settings: mm ↔ in) ----------
// Display and entry only: every length is kept, saved and sent to the laser in
// mm; inches exist only on screen.
const INCH = 25.4;
const inches = () => state.units === "in";
const unit = () => inches() ? "in" : "mm";
// a length for reading: mm to 0.1, inches to 0.01 (trailing zeros dropped)
const len = mm => inches() ? String(+(mm / INCH).toFixed(2)) : mmTxt(mm);
const dims = (w, h) => `${len(w)}×${len(h)} ${unit()}`;
const fromLen = v => inches() ? v * INCH : v;   // what was typed → mm
// fill a number box from mm — but never while it's being typed in
function setLen(input, mm) {
  if (document.activeElement === input) return;
  input.value = inches() ? +(mm / INCH).toFixed(2) : Math.round(mm);
}
// switch units: labels, steps, rulers, every readout
function applyUnits() {
  document.querySelectorAll(".unitlbl").forEach(el => { el.textContent = unit(); });
  ["#sheetx", "#sheety", "#offx", "#offy"].forEach(sel => { $(sel).step = inches() ? "0.05" : "1"; });
  [...$("#thickness").options].forEach(o => {
    if (o.value) o.text = inches() ? `${+(o.value / INCH).toFixed(3)} in` : `${o.value} mm`;
  });
  fitSelect($("#thickness"));
  if (bedEls) { bedEls.rulers.innerHTML = ""; drawRulers(bedEls.rulers, state.machine); }
  refreshSheets(); drawSheet(); updatePlacement();
}
// the built-in sizes, plus the material's own (Settings → Your sizes), listed
// only while that material is chosen
function sheetGroups() {
  const look = window.HSLook, mine = look && look.sizesOf ? look.sizesOf($("#material").value) : [];
  return mine.length ? SHEETS.concat([["Your sizes", mine]]) : SHEETS;
}
function sheetChoices() {
  const m = state.machine, fits = (w, h) => w <= m.bed_w_mm + 0.5 && h <= m.bed_h_mm + 0.5;
  return sheetGroups().map(([group, list]) => [group, list.flatMap(([name, L, S]) => {
    const out = [];
    if (fits(L, S)) out.push({ id: name + "|L", name, w: L, h: S, label: `${name} · ${len(L)}×${len(S)}` });
    if (L !== S && fits(S, L)) out.push({ id: name + "|P", name, w: S, h: L, label: `${name} portrait · ${len(S)}×${len(L)}` });
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
  // the sheet used to live in localStorage; carry that over once, then forget it
  let old = null;
  try {
    if (localStorage.getItem("hs-sheet") && !state.prefs.sheet) {
      old = { sheet: localStorage.getItem("hs-sheet"),
              sheet_off: JSON.parse(localStorage.getItem("hs-sheet-off") || "null") || undefined };
      savePrefs(old);
      Object.assign(state.prefs, old);
    }
    localStorage.removeItem("hs-sheet"); localStorage.removeItem("hs-sheet-off");
  } catch (e) {}
  state.sheetWant = state.prefs.sheet;
  if (!restore(sel, state.prefs.sheet)) firstOption(sel);
  const off = state.prefs.sheet_off;
  if (off) Object.assign(state.sheetOff, { x: +off.x || 0, y: +off.y || 0 });
}
// rebuild the size list when the material (or your sizes) change. The size you
// last picked comes back if it's offered again — a size of your own reappears
// when you return to its material — else the current one stays, else the first.
// Only a pick of yours is saved; a fallback shown meanwhile is not.
function refreshSheets() {
  if (!state.machine) return;
  const sel = $("#sheet"), was = sel.value;
  sel.innerHTML = '<option value="">— material size —</option>';
  sheetChoices().forEach(([group, list]) => {
    const og = document.createElement("optgroup");
    og.label = group;
    list.forEach(s => og.appendChild(new Option(s.label, s.id)));
    sel.appendChild(og);
  });
  if (state.sheetWant === "") sel.value = "";   // "Clear": no stock, on purpose
  else if (!restore(sel, state.sheetWant) && !restore(sel, was)) firstOption(sel);
  fitSelect(sel);
  if (sel.value !== was) { drawSheet(); updatePlacement(); }
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
  // whole mm, and never past the far edge: round, then cap at the last whole
  // mm that still fits (a 609.6 bed takes a 125 sheet at x ≤ 484, not 485)
  o.x = Math.max(0, Math.min(Math.round(o.x), Math.floor(m.bed_w_mm - s.w)));
  o.y = Math.max(0, Math.min(Math.round(o.y), Math.floor(m.bed_h_mm - s.h)));
  return { ...s, x: o.x, y: o.y };
}
function saveSheet() {
  savePrefs({ sheet: $("#sheet").value, sheet_off: { ...state.sheetOff } });
}
function drawSheet() {
  if (!bedEls) return;
  const s = sheetBox();
  syncPanel();
  if (!s) { bedEls.sheet.setAttribute("hidden", "hidden"); return; }
  for (const [k, v] of Object.entries({ x: s.x, y: s.y, width: s.w, height: s.h }))
    bedEls.sheetRect.setAttribute(k, v);
  // the textures are tuned for ~200-unit swatches: draw at a third of a mm per unit
  const mat = $("#material").value, look = window.HSLook;
  if (look && mat) {
    for (const [k, v] of Object.entries({ x: s.x, y: s.y, width: s.w, height: s.h, viewBox: `0 0 ${s.w / 3} ${s.h / 3}` }))
      bedEls.sheetTex.setAttribute(k, v);
    bedEls.sheetTex.innerHTML = look.texture(mat, s.w / 3, s.h / 3, state.finish);
    bedEls.sheetTex.removeAttribute("hidden");
    // the stock shows as itself: no purple frame (a faint one on hover, to grab)
    // and no label on it — its name and size are on the Material card
    bedEls.sheetRect.setAttribute("fill", "transparent");
    bedEls.sheetRect.classList.add("tex");
  } else {
    bedEls.sheetTex.setAttribute("hidden", "hidden");
    bedEls.sheetRect.setAttribute("fill", "var(--sheet)");
    bedEls.sheetRect.classList.remove("tex");
  }
  bedEls.sheet.removeAttribute("hidden");
  $("#sheetWhich").textContent = "· " + s.name;
  setLen($("#sheetx"), s.x);
  setLen($("#sheety"), s.y);
  $("#sheetInfo").textContent = `${dims(s.w, s.h)} at (${len(s.x)}, ${len(s.y)}) · reaches (${len(s.x + s.w)}, ${len(s.y + s.h)})`;
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
    const lim = (axis, v) => v <= 0 ? `${axis} = 0` : `${axis} ≤ ${len(v)} ${unit()}`;
    if (overX > 0.01) need.push(lim("X", Math.floor(m.bed_w_mm - alt.w)));
    if (overY > 0.01) need.push(lim("Y", Math.floor(m.bed_h_mm - alt.h)));
    return { ok: false, alt, why: `turned, the ${name} would run off the bed at (${s.x}, ${s.y}). ` +
      `Move it to ${need.join(" and ")} first.` };
  }
  return { ok: true, alt };
}
const moveSheet = () => { drawSheet(); updatePlacement(); saveSheet(); };
$("#sheet").onchange = () => { state.sheetWant = $("#sheet").value; moveSheet(); };
$("#sheetx").oninput = e => { state.sheetOff.x = fromLen(+e.target.value || 0); moveSheet(); };
$("#sheety").oninput = e => { state.sheetOff.y = fromLen(+e.target.value || 0); moveSheet(); };
$("#sheetRotate").onclick = () => {
  const s = sheetBox(), rot = s && sheetTurn(s);
  if (rot && rot.ok) { $("#sheet").value = rot.alt.id; moveSheet(); }
};
$("#sheetCorner").onclick = () => cornerPick("sheet");
$("#sheetCenter").onclick = () => {
  const s = sheetBox(), m = state.machine;
  if (!s) return;
  state.sheetOff = { x: (m.bed_w_mm - s.w) / 2, y: (m.bed_h_mm - s.h) / 2 };
  moveSheet();
};

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
const DROP_IDLE = ["Drop PDFs", "or click to choose"];

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
// every page of every open file is worth seeing, even a one-page PDF
const showRail = () => state.docs.length > 0;
// copies of one page, in the order they were added
const copiesOf = (docId, n) => state.items.filter(it => it.doc === docId && it.page === n);
// what a page is called: "p3" on its own, "B3" once several files are open,
// and "B3·2" for the second copy of it
function pageTag(it) {
  const base = manyDocs() ? docLetter(it.doc) + it.page : "p" + it.page;
  const copies = copiesOf(it.doc, it.page);
  return copies.length > 1 ? `${base}·${copies.indexOf(it) + 1}` : base;
}
const pageName = it => manyDocs() || copiesOf(it.doc, it.page).length > 1
  ? pageTag(it) : "page " + it.page;
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
        <div class="tfoot"><span>Page ${n}</span>
          <button type="button" class="tbtn" data-act="add"></button>
          <div class="steps" hidden>
            <button type="button" data-act="less" title="One copy fewer">−</button>
            <b data-copies>1</b>
            <button type="button" data-act="more" title="One more copy">+</button>
          </div></div>`;
      card.onclick = e => {
        const act = e.target.closest("[data-act]"), copies = copiesOf(d.id, n);
        if (act) {
          const how = act.dataset.act;
          if (how === "less") copies.length && removeItem(copies[copies.length - 1]);
          else includePage(d.id, n, how === "more");   // "add" selects an existing copy
          return;
        }
        if (copies.length) select(state.active && copies.includes(state.active)
          ? state.active : copies[0]);
      };
      grp.appendChild(card);
    }
    list.appendChild(grp);
  });
  $("#includeAll").onclick = async () => {
    for (const d of state.docs)
      for (let n = 1; n <= d.pages; n++) if (!copiesOf(d.id, n).length) await includePage(d.id, n);
  };
  renderRail();
}
function renderRail() {
  if ($("#rail").hidden) return;
  document.querySelectorAll("#thumbs .thumb").forEach(card => {
    const copies = copiesOf(card.dataset.doc, +card.dataset.page);
    const spare = card.classList.contains("busy") || card.classList.contains("blank");
    card.classList.toggle("on", copies.length > 0);
    card.classList.toggle("active", copies.includes(state.active));
    card.classList.toggle("bad", copies.some(it => it.bad));
    // nothing on the bed yet: one button. Once it is there: − n +
    card.querySelector(".tbtn").hidden = copies.length > 0 || spare;
    card.querySelector(".steps").hidden = copies.length === 0 || spare;
    card.querySelector("[data-copies]").textContent = copies.length;
    if (!spare) card.querySelector(".tbtn").textContent = "Include";
  });
  const placed = state.items.length, pages = new Set(state.items.map(it => it.doc + "/" + it.page)).size;
  const all = allPages();
  $("#railCount").textContent = `${pages} of ${all} page${all === 1 ? "" : "s"}` +
    (manyDocs() ? ` · ${state.docs.length} files` : "") +
    (placed > pages ? ` · ${placed} on the bed` : "");
  $("#includeAll").hidden = pages === all;
}

// ---------- bed items: one per page placed on the bed ----------
const itemFor = (docId, n) => copiesOf(docId, n)[0] || null;
let lastUid = 0;

// `another` adds one more copy of a page that is already on the bed; without
// it, a page that is already there is simply selected
async function includePage(docId, n, another) {
  const have = copiesOf(docId, n);
  if (have.length && !another) return select(have[have.length - 1]);
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
  const it = { uid: ++lastUid, doc: docId, page: n, pd, off: { x: 0, y: 0 }, rot: 0 };
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

// Delete (or Backspace) takes the selected page off the bed — unless you're
// typing in a field or a picker panel is open
document.addEventListener("keydown", e => {
  if ((e.key !== "Delete" && e.key !== "Backspace") || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  const picker = document.getElementById("picker");
  if ((picker && !picker.hidden) || !state.active) return;
  e.preventDefault();
  removeItem(state.active);
});

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
  const pd = it.pd, id = `clip-${it.uid}`;
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
  const cutlines = mk("g", { class: "cutlines", fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round",
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
  // the stock drawn as the material itself, in its colour (picker.js paints it)
  const sheetTex = mk("svg", { "pointer-events": "none", preserveAspectRatio: "none", opacity: 0.9 });
  const sheetRect = mk("rect", { class: "sheetrect", rx: 2, fill: "var(--sheet)", stroke: "var(--sheetline)",
    "stroke-width": 1.2, "pointer-events": "all" });
  sheet.append(sheetTex, sheetRect);
  bed.appendChild(sheet);
  const B = bounds();  // dashed safety boundary = allowed placement area
  bed.appendChild(mk("rect", {
    x: B.minX, y: B.minY, width: B.maxX - B.minX, height: B.maxY - B.minY,
    fill: "none", stroke: "var(--warn, #ffb454)", "stroke-dasharray": "8 6", "stroke-width": 1.5,
  }));
  const rulers = mk("g", {});
  bed.appendChild(rulers);
  drawRulers(rulers, m);

  const items = mk("g", {});
  const overlaps = mk("g", { "pointer-events": "none" });   // red wash where pages collide
  bed.append(items, overlaps);
  bedEls = { defs, items, overlaps, sheet, sheetTex, sheetRect, rulers };
  dragWith(sheetRect, () => state.sheetOff, (x, y) => { state.sheetOff = { x, y }; moveSheet(); });
  drawSheet();
}

// Rulers on all four sides. Top and left count from the laser's home corner
// (top-left), as X/Y do everywhere else; bottom and right count from the
// opposite corner (bottom-right) — X leftwards, Y upwards — so a distance
// from either far edge can be read off directly.
function drawRulers(bed, m) {
  // mm: a tick every 50, labelled every 100. Inches: a tick every inch, labelled every 4
  const W = m.bed_w_mm, H = m.bed_h_mm, fs = 10, off = 13;
  const step = inches() ? INCH : 50, every = inches() ? 4 : 2;
  const tick = (x1, y1, x2, y2) => bed.appendChild(mk("line", { x1, y1, x2, y2, stroke: "var(--bedline)", "stroke-width": 1 }));
  const label = (x, y, anchor, v) => bed.appendChild(Object.assign(
    mk("text", { x, y, "font-size": fs, "text-anchor": anchor, fill: "var(--muted)" }), { textContent: v }));
  for (let i = 0; i * step <= W + 1; i++) {
    const v = i * step, big = i % every === 0, n = Math.round(inches() ? i : v), tl = big ? 10 : 6;
    tick(v, -tl, v, 0);                          // top: X from the left
    tick(W - v, H, W - v, H + tl);               // bottom: X from the right
    if (big) { label(v, -off, "middle", n); label(W - v, H + off + fs * 0.72, "middle", n); }
  }
  for (let i = 0; i * step <= H + 1; i++) {
    const v = i * step, big = i % every === 0, n = Math.round(inches() ? i : v), tl = big ? 10 : 6;
    tick(-tl, v, 0, v);                          // left: Y from the top
    tick(W, H - v, W + tl, H - v);               // right: Y from the bottom
    if (big) { label(-off, v + fs / 3, "end", n); label(W + off, H - v + fs / 3, "start", n); }
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
  const B = bounds(), S = sheetBox(), multi = state.items.length > 1 || manyDocs();
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
    else if (!it.inBounds) problems.push(`⚠ ${multi ? cap(pageName(it)) + " is i" : "I"}nside the ${len(B.s)} ${unit()} safety margin. Move it within the dashed boundary.`);
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
    // a dotted frame in its own colour: the page's extent. It shows only under the
    // pointer (or while dragging) so it never muddies the artwork — except a page
    // that's out of bounds or overlapping, whose red frame stays as the warning
    it.els.art.setAttribute("stroke", it.bad ? "var(--danger)" : "var(--artline)");
    it.els.art.classList.toggle("bad", !!it.bad);
    it.els.art.setAttribute("stroke-width", it === state.active ? 1.8 : 1.1);
    it.els.art.setAttribute("stroke-dasharray", it === state.active ? "0.1 3.2" : "0.1 2.6");
    it.els.art.setAttribute("stroke-linecap", "round");
  });

  // the Artwork card edits the selected page
  const it = state.active;
  const who = $("#placeWhich");
  who.textContent = it && multi ? "· " + pageTag(it) : "";
  who.title = it && manyDocs() ? `page ${it.page} of ${docFor(it.doc).name}` : "";
  ["#offx", "#offy", "#rotateBtn", "#centerBtn", "#artCorner"].forEach(s => { $(s).disabled = !it; });
  if (it) {
    const d = artDims(it);
    setLen($("#offx"), it.off.x);
    setLen($("#offy"), it.off.y);
    $("#rotLbl").textContent = it.rot + "°";
    $("#artChips").innerHTML = artChips(it.pd);
    const turn = artTurn(it);
    $("#rotateBtn").disabled = !turn.ok;
    $("#rotateBtn").title = turn.ok ? `Rotate to ${(it.rot + 90) % 360}°` : turn.why;
    $("#rotWhy").hidden = turn.ok;
    $("#rotWhy").textContent = turn.ok ? "" : "Can't rotate: " + turn.why;
    $("#placeInfo").textContent =
      `Artwork ${dims(d.w, d.h)} at (${len(it.off.x)}, ${len(it.off.y)}) · ` +
      `reaches (${len(it.off.x + d.w)}, ${len(it.off.y + d.h)}) · bed ${dims(state.machine.bed_w_mm, state.machine.bed_h_mm)}` +
      (multi ? ` · ${state.items.length} on the bed` +
        (manyDocs() ? ` from ${new Set(state.items.map(o => o.doc)).size} files` : "") : "");
  } else {
    $("#rotWhy").hidden = true;
    $("#placeInfo").textContent = "No pages on the bed — include one from the page list.";
    $("#artChips").innerHTML = "";
  }
  const warn = $("#boundsWarn");
  warn.hidden = !problems.length;
  warn.textContent = problems.join("\n") + (problems.length ? "\nSending disabled." : "");
  const note = $("#sheetNote");
  note.hidden = !notes.length;
  note.textContent = notes.join("\n");
  // the ⚠ in the Artwork title: red when Send is blocked, amber for advice
  const alert = $("#artAlert");
  alert.hidden = !problems.length && !notes.length;
  alert.classList.toggle("bad", problems.length > 0);
  alert.setAttribute("aria-label", [...problems, ...notes].join(" "));

  // Send says on hover what is holding it back — the first blocker, in order
  const why = state.sending ? "Sending…"
    : !state.items.length ? "Put a page on the bed first"
    : problems.length ? "Fix the placement first — see the Artwork card"
    : !currentOp() ? "Choose a preset first"
    : state.laser !== "online" ? `The laser isn't reachable at ${state.laserHost} — click Scan to find it`
    : "";
  $("#sendBtn").disabled = !!why;
  $("#sendBtn").title = why;
  renderRail();
}

// what the page is made of: vector paths, and/or pictures at their resolution as
// placed. Below 150 dpi a picture will burn visibly blocky, so it's flagged.
function artChips(pd) {
  const imgs = pd.images, vec = (pd.vectors || []).length > 0;
  if (!imgs) return "";   // pdfimages unavailable: say nothing rather than guess
  const chip = (t, cls, tip) => `<span class="pk-chip ${cls}" title="${tip}">${t}</span>`;
  let out = vec || !imgs.length ? chip("Vector", "eng", "Paths and text: sharp at any size") : "";
  if (imgs.length) {
    const ppi = Math.min(...imgs.map(i => i.ppi)), low = ppi < 150;
    out += chip(`${ppi} dpi`, low ? "warn" : "",
      `${imgs.length} picture${imgs.length > 1 ? "s" : ""} on this page; the lowest is ${ppi} dpi as placed` +
      (low ? " — expect it to burn blocky" : ""));
  }
  return out;
}
$("#offx").oninput = e => { if (state.active) { state.active.off.x = fromLen(+e.target.value || 0); updatePlacement(); } };
$("#offy").oninput = e => { if (state.active) { state.active.off.y = fromLen(+e.target.value || 0); updatePlacement(); } };
// the same rule as the material: a 90° turn about the artwork's top-left
// corner swaps its width and height, and is only offered when the turned
// artwork still sits inside the safety boundary from where it is now
function artTurn(it) {
  const d = artDims(it), B = bounds();
  if (!it.pd.content_mm) return { ok: false, why: "there is no artwork on this page" };
  if (d.h > B.maxX - B.minX + 0.01 || d.w > B.maxY - B.minY + 0.01)
    return { ok: false, why: `turned, the ${dims(d.h, d.w)} artwork is bigger than the safe area` };
  const need = [];
  if (it.off.x + d.h > B.maxX + 0.01) need.push(`X ≤ ${len(Math.floor(B.maxX - d.h))} ${unit()}`);
  if (it.off.y + d.w > B.maxY + 0.01) need.push(`Y ≤ ${len(Math.floor(B.maxY - d.w))} ${unit()}`);
  if (need.length)
    return { ok: false, why: `turned, it would cross the safety boundary at (${len(it.off.x)}, ${len(it.off.y)}). Move it to ${need.join(" and ")} first.` };
  return { ok: true };
}
$("#rotateBtn").onclick = () => {
  const it = state.active;
  if (!it || !artTurn(it).ok) return;
  it.rot = (it.rot + 90) % 360; updatePlacement();
};
$("#centerBtn").onclick = () => state.active && centerIn(state.active);
$("#artCorner").onclick = () => cornerPick("art");

// ---------- move to a corner: pick it on the bed ----------
// "Corner" shows a pulsing "Here" at each corner of the bed; hovering one
// previews where the piece lands, clicking snaps the piece's matching corner
// there. The stock goes to the bed's own corners; artwork to the corners of
// the safe area (the dashed boundary) — the bed's corner itself would be out
// of bounds. Esc, a click elsewhere or the button again cancels.
let picking = null, pickGhost = null;   // which card is picking, and its landing preview
const CORNERS = [["tl", "↖"], ["tr", "↗"], ["bl", "↙"], ["br", "↘"]];
function cornerTargets(kind) {
  const m = state.machine;
  if (kind === "sheet") {
    const s = sheetBox();
    if (!s) return null;
    return { w: s.w, h: s.h, box: { minX: 0, minY: 0, maxX: m.bed_w_mm, maxY: m.bed_h_mm } };
  }
  const it = state.active;
  if (!it || !it.pd.content_mm) return null;
  const d = artDims(it), B = bounds();
  if (d.w > B.maxX - B.minX + 0.01 || d.h > B.maxY - B.minY + 0.01) return null;
  return { w: d.w, h: d.h, box: B };
}
function cornerSpot(t, c) {   // top-left offset of the piece snapped into corner c
  return { x: c[1] === "l" ? t.box.minX : t.box.maxX - t.w,
           y: c[0] === "t" ? t.box.minY : t.box.maxY - t.h };
}
function cornerPick(kind) {
  if (picking) { const was = picking; endCornerPick(); if (was === kind) return; }
  const t = cornerTargets(kind);
  if (!t) return;
  picking = kind;
  $(kind === "sheet" ? "#sheetCorner" : "#artCorner").classList.add("on");
  // measure against the bed area (the marker layer itself is still hidden, so has no box yet)
  const wrap = $("#cornerPick"), bed = $("#bed"), wr = wrap.parentElement.getBoundingClientRect(), br = bed.getBoundingClientRect();
  const k = br.width / state.vb.w;   // px per mm
  const px = (x, y) => ({ left: br.left - wr.left + (x + GUT) * k, top: br.top - wr.top + (y + GUT) * k });
  const ghost = mk("rect", { class: "cornerghost", rx: 2, width: t.w, height: t.h, hidden: "hidden" });
  bedEls.items.appendChild(ghost);
  wrap.innerHTML = "";
  CORNERS.forEach(([c, arrow]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "here " + c;
    b.innerHTML = c[1] === "l" ? `<span>${arrow}</span> Here` : `Here <span>${arrow}</span>`;
    b.title = `Snap the ${kind === "sheet" ? "sheet" : "artwork"} to this corner`;
    // anchor each marker inside its corner of the bed (or safe area)
    const p = px(c[1] === "l" ? t.box.minX : t.box.maxX, c[0] === "t" ? t.box.minY : t.box.maxY);
    b.style.left = p.left + "px"; b.style.top = p.top + "px";
    b.style.translate = `${c[1] === "l" ? "8px" : "calc(-100% - 8px)"} ${c[0] === "t" ? "8px" : "calc(-100% - 8px)"}`;
    const spot = cornerSpot(t, c);
    b.onmouseenter = b.onfocus = () => { ghost.setAttribute("x", spot.x); ghost.setAttribute("y", spot.y); ghost.removeAttribute("hidden"); };
    b.onmouseleave = b.onblur = () => ghost.setAttribute("hidden", "hidden");
    b.onclick = e => {
      e.stopPropagation();
      if (kind === "sheet") { state.sheetOff = spot; endCornerPick(); moveSheet(); }
      else { const it = state.active; it.off = { ...spot }; endCornerPick(); updatePlacement(); }
    };
    wrap.appendChild(b);
  });
  wrap.hidden = false;
  pickGhost = ghost;
  wrap.querySelector(".here").focus({ preventScroll: true });
}
function endCornerPick() {
  if (!picking) return;
  picking = null;
  $("#cornerPick").hidden = true;
  $("#cornerPick").innerHTML = "";
  if (pickGhost) { pickGhost.remove(); pickGhost = null; }
  ["#sheetCorner", "#artCorner"].forEach(s => $(s).classList.remove("on"));
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && picking) endCornerPick(); });
document.addEventListener("pointerdown", e => {
  if (picking && !e.target.closest(".here, #sheetCorner, #artCorner")) endCornerPick();
}, true);
window.addEventListener("resize", endCornerPick);

// ---------- material + preset dropdown ----------
function currentMaterial() { return state.materials.find(m => m.name === $("#material").value) || null; }
function currentOp() {
  const m = currentMaterial(), i = $("#preset").value;
  return (m && i !== "") ? m.operations[+i] : null;
}
// a preset's name for display: its "(300 DPI)" goes (the DPI is shown anyway),
// and an inch size keeps — or gains — its millimetres: Cutting 1/8" (3 mm)
function presetLabel(op) {
  const l = op.label.replace(/\s*\(\d+\s*DPI\)/i, "");
  if (/\(\s*[\d.]+\s*mm\s*\)/i.test(l)) return l;
  return l.replace(/(\d+\/\d+|\d*\.\d+|\d+)\s*(?:"|″|in\b)/g, (all, v) => {
    const [a, b] = v.split("/"), mm = (b ? a / b : +a) * 25.4;
    return `${all} (≈${mm < 10 ? Math.round(mm * 10) / 10 : Math.round(mm)} mm)`;
  });
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
    const label = presetLabel(op);
    const thk = (op.type === "cut" && op.thickness_mm && !/mm\)/.test(label)) ? ` · ≤${op.thickness_mm}mm` : "";
    sel.appendChild(new Option(`${icon} ${label} · S${op.speed} P${op.power} · ${extra}${thk}`, i));
  });
  // the value is an index into the material's own list: carrying it over to a
  // different material would land on an unrelated preset (Wood's #3 is an
  // engrave, Acrylic's #3 a cut) — so a new material starts on its first
  const same = m && sel.dataset.material === m.name;
  sel.dataset.material = m ? m.name : "";
  if (!(same && restore(sel, prev))) firstOption(sel);
  fitSelect(sel);
  highlight(); updatePlacement();
}
// the material's colour: keep it if the new material comes in it, else its first;
// the app bar shows it after the name ("Wood · Walnut")
function syncFinish() {
  const sel = $("#material"), look = window.HSLook;
  const fins = look && sel.value ? look.finishesOf(sel.value) : [];
  // until your own colours have loaded, a saved custom colour isn't in the list
  // yet — show the first, but don't forget the saved one
  if (fins.length && !fins.includes(state.finish) && look.ready) state.finish = fins[0];
  const shown = fins.includes(state.finish) ? state.finish : fins[0];
  // the bar shows the colour as a swatch inside the pill, its name on hover —
  // the option text stays the plain material name
  const chip = $("#finishChip"), on = fins.length > 1;
  chip.hidden = !on;
  sel.classList.toggle("has-chip", on);
  if (on) {
    chip.style.background = look.swatch(sel.value, shown);
    chip.title = shown;
    chip.setAttribute("aria-label", `Colour: ${shown}`);
  }
  sel.title = on ? `${sel.value} — ${shown}` : "";
  fitSelect(sel);
  // the Material card's title bar wears the stock's colour, its text in an ink
  // that reads on it
  const bar = $("#sheetSection h2");
  if (look && sel.value && fins.length) {
    bar.style.background = look.swatch(sel.value, shown);
    bar.style.color = look.look(sel.value, shown).text;
    bar.classList.add("matbar");
  } else { bar.style.background = bar.style.color = ""; bar.classList.remove("matbar"); }
}
// the swatch sits over the pill: a click on it is a click on the material
$("#finishChip").onmousedown = e => {
  e.preventDefault();
  $("#material").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
};
$("#material").onchange = () => {
  syncFinish();
  refreshSheets();
  savePrefs({ material: $("#material").value, finish: state.finish });
  renderPresets(); drawSheet();
};
$("#thickness").onchange = () => { savePrefs({ thickness: $("#thickness").value }); renderPresets(); };
$("#preset").onchange = () => { highlight(); updatePlacement(); };

// ---------- the artwork as it will burn ----------
// A page isn't drawn as the PDF (white paper, colours) but as what the laser
// leaves on the stock: transparent where nothing burns, and the material's own
// burn colour where it does. The rule matches the driver exactly — an engrave
// burns every pixel that isn't near-white (pdfjob.raster_from_colors: any
// channel ≤ 245), 1-bit, at one power: there is no greyscale, so a pale grey
// burns as hard as black, and so does any colour. How dark, deep and charred
// that burn looks comes from the preset (power ÷ speed × DPI) on this material.
// A cut preset burns no raster at all — only the vector lines, as kerf.
const MASKS = new Map(), BURNS = new Map();
function burnMask(pd) {
  if (!MASKS.has(pd.preview)) MASKS.set(pd.preview, new Promise((ok, fail) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(im, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        const burn = p[i + 3] > 0 && !(p[i] > 245 && p[i + 1] > 245 && p[i + 2] > 245);
        p[i] = p[i + 1] = p[i + 2] = 255; p[i + 3] = burn ? 255 : 0;
      }
      x.putImageData(d, 0, 0);
      ok(c);
    };
    im.onerror = fail;
    im.src = pd.preview;
  }));
  return MASKS.get(pd.preview);
}
function tinted(mask, colour) {
  const c = document.createElement("canvas");
  c.width = mask.width; c.height = mask.height;
  const x = c.getContext("2d");
  x.drawImage(mask, 0, 0);
  x.globalCompositeOperation = "source-in";
  x.fillStyle = colour; x.fillRect(0, 0, c.width, c.height);
  return c;
}
function burnLook() {
  const look = window.HSLook, mat = $("#material").value, op = currentOp();
  const L = look && mat ? look.look(mat, state.finish)
                        : { mark: "#2a2a2a", frost: false, organic: false, dark: false };
  return { L, t: look && mat && op ? look.burn(mat, op) : 0.5 };
}
async function renderBurn(it) {
  const { L, t } = burnLook(), pd = it.pd;
  const key = `${pd.preview}|${L.mark}|${L.frost}|${L.organic}|${t.toFixed(3)}`;
  if (it.burnKey === key) return;
  it.burnKey = key;
  if (!BURNS.has(key)) BURNS.set(key, burnMask(pd).then(mask => new Promise(ok => {
    const pxmm = mask.width / pd.width_mm;
    const c = document.createElement("canvas");
    c.width = mask.width; c.height = mask.height;
    const x = c.getContext("2d");
    if (L.organic) {   // scorch: wood, leather, card… brown around a hard burn
      x.globalAlpha = 0.08 + 0.4 * t;
      x.filter = `blur(${((0.12 + 0.45 * t) * pxmm).toFixed(1)}px)`;
      x.drawImage(tinted(mask, L.mark), 0, 0);
      x.filter = "none";
    }
    x.globalAlpha = 0.12 + 0.25 * t;   // the lit lower lip of the recess: reads as depth
    x.drawImage(tinted(mask, "#fff"), 0, (0.04 + 0.2 * t) * pxmm);
    x.globalAlpha = L.frost ? 0.45 + 0.4 * t : 0.4 + 0.6 * t;
    x.drawImage(tinted(mask, L.mark), 0, 0);
    c.toBlob(b => ok(URL.createObjectURL(b)));
  })).catch(() => pd.preview));
  const url = await BURNS.get(key);
  if (it.burnKey === key) it.els.img.setAttribute("href", url);
}
// redraw every page for the current material, colour and preset
function highlight() {
  const op = currentOp(), isCut = op && op.type === "cut";
  const { L } = burnLook();
  // the Artwork card's title bar wears the colour the burn will leave
  const bar = $("#placeSection h2"), look = window.HSLook;
  if (look && $("#material").value) {
    bar.style.background = L.mark; bar.style.color = look.ink(L.mark); bar.classList.add("matbar");
    $("#placeSection").style.setProperty("--burn", L.mark);
    $("#placeSection").style.setProperty("--burn-ink", look.ink(L.mark));
  } else { bar.style.background = bar.style.color = ""; bar.classList.remove("matbar"); }
  state.items.forEach(it => {
    const els = it.els;
    els.engwash.setAttribute("hidden", "hidden");
    // a cut burns only the vectors: the raster isn't engraved, so it isn't shown
    if (isCut) els.img.setAttribute("visibility", "hidden"); else els.img.removeAttribute("visibility");
    // the cut path in the colour the laser leaves on this stock (a charred brown
    // edge on wood, frosted white on acrylic…), at a fixed on-screen width,
    // gently pulsing (index.html)
    els.cutlines.setAttribute("stroke", L.mark);
    if (isCut) els.cutlines.removeAttribute("hidden"); else els.cutlines.setAttribute("hidden", "hidden");
    if (!isCut) renderBurn(it);
  });
}
// picker.js calls this when your own colours load or change
window.hsFinishesChanged = () => {
  syncFinish();
  refreshSheets();
  if ($("#material").value && state.finish) savePrefs({ finish: state.finish });
  drawSheet(); highlight();
};

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
