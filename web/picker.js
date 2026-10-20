// Helix Studio — visual picker
// Every app-bar dropdown opens a full-window panel of cards instead of a native
// list: materials as textured swatches, thicknesses as edge-on slabs at real
// size, stock sizes drawn on the bed, presets as a sample burn with their power
// and speed, the machine as a picture. The <select>s stay the source of truth —
// picking a card sets the select's value and fires its "change", so app.js is
// none the wiser.
(() => {
const PICKED = ["machine", "material", "thickness", "sheet", "preset"];
const TITLES = { machine: "Machine", material: "Material", thickness: "Thickness",
                 sheet: "Material size", preset: "Preset" };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------- material looks ----------
// Each texture is SVG noise mapped onto a few colours: `f` is the noise
// frequency (x y — a long, low x frequency streaks it into grain or brushing),
// `stops` the colours the noise runs through, `weave` overlays a fabric
// pattern, `gloss` makes it a sheet of acrylic/glass (`opaque` if you can't see
// through it). Every material comes in the colours it is really sold in — its
// `finishes` — and each finish says what a laser mark looks like on it
// (`mark`): a burn on wood, a frost on acrylic, the white core of 2-layer
// plastic, bare aluminium under anodizing. A finish overrides the base fields.
const LOOKS = {
  "acrylic": { frost: true, finishes: [
    { n: "Clear", gloss: "#a9dcff", mark: "#ffffff" },
    { n: "Black", gloss: "#141418", opaque: true, mark: "#c9c9cc" },
    { n: "White", gloss: "#f3f3f1", opaque: true, mark: "#c7c7c2" },
    { n: "Red", gloss: "#e02a36", mark: "#ffd6d8" },
    { n: "Blue", gloss: "#2a6fe0", mark: "#d8e6ff" },
    { n: "Fluoro green", gloss: "#7ff03a", mark: "#efffdc" },
    { n: "Smoke", gloss: "#4b4a48", mark: "#e6e3de" }] },
  "alumamark": { f: ".0025 .7", oct: 2, finishes: [
    { n: "Gold", stops: ["#b48c38", "#e8c870", "#c79f4a", "#f2da8e"], mark: "#1a1712" },
    { n: "Silver", stops: ["#9aa1a8", "#d3d7db", "#b3b9bf", "#e2e5e8"], mark: "#16181a" }] },
  "anodized": { f: ".0025 .7", oct: 2, finishes: [
    { n: "Blue", stops: ["#1a4a88", "#2f6fbf", "#215494", "#3d82d4"], mark: "#e9eef5" },
    { n: "Black", stops: ["#18191c", "#2a2c30", "#202226", "#33363b"], mark: "#dfe3e8" },
    { n: "Red", stops: ["#7e141c", "#b3232e", "#951a24", "#c7313c"], mark: "#f1e7e8" },
    { n: "Gold", stops: ["#9a7424", "#d1a645", "#b38a32", "#e0bb5e"], mark: "#f4efe2" },
    { n: "Green", stops: ["#145a32", "#238a4f", "#1a6e3e", "#2f9c5c"], mark: "#e6f1ea" },
    { n: "Purple", stops: ["#40206a", "#6a3aa6", "#532c86", "#7b49b8"], mark: "#ece6f4" },
    { n: "Silver", stops: ["#9ea5ac", "#cfd4d8", "#b4bac0", "#dfe2e5"], mark: "#f7f8f9" }] },
  "cork": { f: ".32", oct: 4, seed: 7, finishes: [
    { n: "Natural", stops: ["#6e4522", "#b07a45", "#c99560", "#8d5e33", "#d9ab74"], mark: "#3d220e" },
    { n: "Dark", stops: ["#2e1d10", "#5a3a20", "#6e4a2a", "#432a16", "#7a5332"], mark: "#120a04" }] },
  "cotton": { f: ".9", oct: 2, weave: "weave", finishes: [
    { n: "White", stops: ["#e9e4d8", "#f6f2ea"], mark: "#a8946e" },
    { n: "Natural", stops: ["#d9ccad", "#e8dcc0"], mark: "#8a7246" },
    { n: "Black", stops: ["#1b1b1d", "#262628"], mark: "#7a7068" },
    { n: "Navy", stops: ["#1b2747", "#25345c"], mark: "#7d86a0" }] },
  "denim": { f: ".8", oct: 2, weave: "twill", finishes: [
    { n: "Indigo", stops: ["#22395f", "#33518a", "#2a4675", "#3e5f9d"], mark: "#9db2d3" },
    { n: "Light wash", stops: ["#5f80ad", "#7d9cc4", "#6b8bb7", "#90acd0"], mark: "#dde6f1" },
    { n: "Black", stops: ["#1f1f23", "#2c2c31", "#26262a"], mark: "#86817a" }] },
  "fleece": { f: ".55", oct: 3, seed: 3, finishes: [
    { n: "Red", stops: ["#a8343a", "#c4474c", "#d45a5e", "#b83d42"], mark: "#6c1a1f" },
    { n: "Navy", stops: ["#1a2546", "#25335c", "#2e3e6c", "#212d52"], mark: "#0c1226" },
    { n: "Grey", stops: ["#7d8087", "#93969d", "#a2a5ab", "#888b92"], mark: "#45484e" },
    { n: "Black", stops: ["#18181b", "#222225", "#2b2b2f"], mark: "#060607" }] },
  "glass": { frost: true, finishes: [
    { n: "Clear", gloss: "#c9efe8", mark: "#ffffff" },
    { n: "Bottle green", gloss: "#2f8a52", mark: "#e3f3e8" },
    { n: "Amber", gloss: "#c06a1c", mark: "#f6e3cc" },
    { n: "Cobalt", gloss: "#2b4fc4", mark: "#dfe6fa" }] },
  "leather": { f: ".45", oct: 5, seed: 11, finishes: [
    { n: "Brown", stops: ["#552d16", "#7a4524", "#68391d", "#8b5431"], mark: "#26120a" },
    { n: "Tan", stops: ["#9a5c2a", "#c07c42", "#ad6c36", "#cf8e52"], mark: "#4a230c" },
    { n: "Veg-tan", stops: ["#c9a074", "#dcb88c", "#d1aa7e", "#e6c69c"], mark: "#5a3214" },
    { n: "Black", stops: ["#1b1816", "#28231f", "#221e1b"], mark: "#4a423b" }] },
  "mat board": { f: "1.1", oct: 1, finishes: [
    { n: "White", stops: ["#ece7dc", "#f6f2ea"], mark: "#857358" },
    { n: "Cream", stops: ["#e3d6b9", "#eee3c9"], mark: "#7e6844" },
    { n: "Black", stops: ["#1d1d1f", "#262628"], mark: "#e9e4d8" },
    { n: "Navy", stops: ["#1e2a4a", "#27365c"], mark: "#e9e4d8" }] },
  "marble": { turb: true, f: ".011", oct: 5, seed: 4, finishes: [
    { n: "White", stops: ["#7d7d7b", "#c9c9c6", "#ececea", "#f6f6f4", "#f8f8f6"], mark: "#ffffff" },
    { n: "Black", stops: ["#d6d6d4", "#55555a", "#26262a", "#1b1b1e", "#18181b"], mark: "#c9c9c9" },
    { n: "Green", stops: ["#cfe3d6", "#4a7a62", "#2a5a44", "#21493a", "#1d4234"], mark: "#e6efe9" }] },
  "painted brass": { f: ".9", oct: 1, finishes: [
    { n: "Black", stops: ["#18181a", "#202023"], mark: "#d9b45a" },
    { n: "Green", stops: ["#1c2c25", "#24372e"], mark: "#d9b45a" },
    { n: "Blue", stops: ["#1b2846", "#233356"], mark: "#d9b45a" },
    { n: "Red", stops: ["#5a1a1d", "#6c2125"], mark: "#d9b45a" }] },
  "2-layer": { f: ".9", oct: 1, finishes: [
    { n: "Black / white", stops: ["#161616", "#222222"], mark: "#f2f2f2" },
    { n: "White / black", stops: ["#eeeeec", "#f6f6f4"], mark: "#1a1a1a" },
    { n: "Blue / white", stops: ["#1d4ba3", "#2557b8"], mark: "#f2f2f2" },
    { n: "Red / white", stops: ["#b01e28", "#c22631"], mark: "#f2f2f2" },
    { n: "Gold / black", f: ".0025 .7", oct: 2, stops: ["#b48c38", "#e8c870", "#c79f4a"], mark: "#151515" },
    { n: "Silver / black", f: ".0025 .7", oct: 2, stops: ["#9aa1a8", "#d3d7db", "#b3b9bf"], mark: "#151515" }] },
  "plastic": { f: ".9", oct: 1, finishes: [
    { n: "Red", stops: ["#c9363b", "#d9474b"], mark: "#7a1519" },
    { n: "Blue", stops: ["#2b5cc4", "#3466d0"], mark: "#13285a" },
    { n: "White", stops: ["#ececea", "#f5f5f3"], mark: "#b3a891" },
    { n: "Black", stops: ["#1b1b1d", "#252527"], mark: "#4a4a4d" },
    { n: "Yellow", stops: ["#e8b923", "#f0c53a"], mark: "#7a5a08" }] },
  "rubber": { f: "1.2", oct: 2, finishes: [
    { n: "Grey", stops: ["#5a5554", "#6a6463"], mark: "#262222" },
    { n: "Red", stops: ["#a0302b", "#b23a34"], mark: "#4e1310" },
    { n: "Black", stops: ["#1d1c1c", "#272626"], mark: "#0a0a0a" }] },
  "stainless": { f: ".003 .8", oct: 2, finishes: [
    { n: "Brushed", stops: ["#8e959c", "#c6cbd0", "#a8afb6", "#dadee2"], mark: "#121314" },
    { n: "Mirror", f: ".001 .05", oct: 1, stops: ["#6f767d", "#e6e9ec", "#9aa1a8", "#f4f6f8"], mark: "#121314" }] },
  "twill": { f: ".8", oct: 2, weave: "twill", finishes: [
    { n: "Khaki", stops: ["#9c895f", "#b5a276", "#a69369"], mark: "#5e4f30" },
    { n: "Black", stops: ["#1f1f22", "#2a2a2d"], mark: "#0a0a0b" },
    { n: "Navy", stops: ["#1d2947", "#263457"], mark: "#0c1226" },
    { n: "Red", stops: ["#8e1f26", "#a2272f"], mark: "#4a0c10" }] },
  "wood": { f: ".0045 .085", oct: 3, seed: 2, finishes: [
    { n: "Birch ply", stops: ["#d9b98a", "#ecd2a6", "#dfc093", "#f2dbb2", "#d6b484"], mark: "#4a2a12" },
    { n: "Pine", stops: ["#b98450", "#d8a66c", "#c08a52", "#e2b57d", "#b27b47", "#d3a066", "#c49058"], mark: "#4a2810" },
    { n: "MDF", f: ".9", oct: 2, stops: ["#a87c4f", "#b98b5c", "#b08354"], mark: "#2a170a" },
    { n: "Maple", stops: ["#e8d0a4", "#f2deb8", "#ead4aa", "#f6e5c2"], mark: "#5a3418" },
    { n: "Cherry", stops: ["#93452a", "#ad5636", "#9c4b2e", "#b9603e"], mark: "#30110a" },
    { n: "Walnut", stops: ["#4a2f1d", "#62402a", "#553623", "#6f4a31"], mark: "#1a0e07" },
    { n: "Bamboo", f: ".003 .16", stops: ["#d6b878", "#e4c88c", "#dcbf80", "#c9a866"], mark: "#4e3010" }] },
};
// a material name → its look; order matters ("Plastic (2-Layer…)" before "Plastics")
const LOOK_KEYS = ["2-layer", "anodized", "stainless", "painted brass", "mat board", "alumamark",
  "acrylic", "cork", "cotton", "denim", "fleece", "glass", "leather", "marble", "plastic",
  "rubber", "twill", "wood"];
const FALLBACK = { f: ".7", oct: 2, finishes: [{ n: "Standard", stops: ["#8a8f9c", "#a3a8b5"], mark: "#2a2d35" }] };
function lookKey(name) {
  const n = (name || "").toLowerCase();
  return LOOK_KEYS.find(k => n.includes(k)) || null;
}
const baseOf = name => LOOKS[lookKey(name)] || FALLBACK;
const finishesOf = name => baseOf(name).finishes.map(f => f.n);
// the finish shown for a material: the chosen one for the material in use,
// else (or if that colour doesn't exist for it) its first
function finishOf(name) {
  const fs = finishesOf(name);
  const want = name === $("#material").value ? state.finish : null;
  return fs.includes(want) ? want : fs[0];
}
function lookOf(name, finish = finishOf(name)) {
  const B = baseOf(name), i = Math.max(0, B.finishes.findIndex(f => f.n === finish));
  return { ...B, ...B.finishes[i], text: finishText({ ...B, ...B.finishes[i] }),
           key: `${lookKey(name) ? slug(lookKey(name)) : "fallback"}-${i}`,
           img: `mat-${slug(lookKey(name) || "x")}-${slug(B.finishes[i].n)}` };
}
// photos dropped into web/img/ as mat-<material>-<colour>.jpg replace the drawing
let IMAGES = new Set();
fetch("/api/images").then(r => r.json()).then(l => { IMAGES = new Set(l); }).catch(() => {});

// ---------- your own colours (finishes.json, edited on the Settings page) ----------
// The built-in colours above are fixed; yours are added after them. Each one is
// a base colour (the texture's pattern still comes from the material: grain,
// weave, brushing…), the colour a burn leaves, and for acrylic/glass whether
// you can see through it.
let CUSTOM = [];
// your own stock sizes, per material: {material, name, w, h} in mm. They join the
// Material size list as "Your sizes" while that material is chosen.
let SIZES = [];
const SIZE_MAX = 2000;
const sizesOf = name => SIZES.filter(z => z.material === name)
  .map(z => [z.name, Math.max(z.w, z.h), Math.min(z.w, z.h)]);
function shade(hex6, k) {   // k > 0 lightens, k < 0 darkens
  const c = [1, 3, 5].map(i => parseInt(hex6.slice(i, i + 2), 16));
  return "#" + c.map(v => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))
    .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}
// The text colour that reads on a colour: whichever of light or dark ink has the
// higher WCAG contrast against it (a grain/brushed texture is judged by the
// average luminance of its shades). Every finish carries one as `text`.
const INK_LIGHT = "#ffffff", INK_DARK = "#16181d";
function relLum(h) {
  return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrastText(colours) {
  const L = colours.reduce((a, c) => a + relLum(c), 0) / colours.length;
  const onLight = (L + 0.05) / (relLum(INK_DARK) + 0.05), onDark = (relLum(INK_LIGHT) + 0.05) / (L + 0.05);
  return onDark >= onLight ? INK_LIGHT : INK_DARK;
}
const finishText = F => F.text || contrastText(F.gloss ? [F.gloss] : F.stops);
function applyCustom() {
  Object.values(LOOKS).forEach(B => { B.finishes = B.finishes.filter(f => !f.custom); });
  CUSTOM.forEach(c => {
    const B = baseOf(c.material);
    if (B === FALLBACK || B.finishes.some(f => f.n === c.name)) return;
    B.finishes.push(B.frost
      ? { n: c.name, custom: true, gloss: c.base, opaque: !c.see_through, mark: c.mark, text: c.text }
      : { n: c.name, custom: true, mark: c.mark, text: c.text,
          stops: [shade(c.base, -0.14), shade(c.base, 0.07), shade(c.base, -0.05), shade(c.base, 0.12)] });
  });
  buildDefs();
}
let saveTimer = null;
function saveCustom() {
  CUSTOM.forEach(c => { c.text = contrastText([c.base]); });   // worked out, then saved with the colour
  applyCustom();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch("/api/finishes", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ custom: CUSTOM, sizes: SIZES }) }).catch(() => {}), 400);
  if (window.hsFinishesChanged) window.hsFinishesChanged();
}

// all the texture filters live once in a hidden <svg>; cards point at them
function hex(c) { return [1, 3, 5].map(i => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(3)); }
let defsSvg = null;
function buildDefs() {
  if (defsSvg) defsSvg.remove();   // rebuilt whenever the custom colours change
  const f = Object.entries(LOOKS).concat([["fallback", FALLBACK]]).flatMap(([k, B]) =>
    B.finishes.map((F, i) => [`${slug(k)}-${i}`, { ...B, ...F }])).filter(([, L]) => L.stops).map(([id, L]) => {
    const ch = [0, 1, 2].map(i => L.stops.map(s => hex(s)[i]).join(" "));
    return `<filter id="tx-${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
      <feTurbulence type="${L.turb ? "turbulence" : "fractalNoise"}" baseFrequency="${L.f}" numOctaves="${L.oct || 2}" seed="${L.seed || 1}"/>
      <feColorMatrix values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1"/>
      <feComponentTransfer><feFuncR type="table" tableValues="${ch[0]}"/><feFuncG type="table" tableValues="${ch[1]}"/><feFuncB type="table" tableValues="${ch[2]}"/></feComponentTransfer>
    </filter>`;
  }).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  svg.innerHTML = `<defs>${f}
    <pattern id="pk-weave" width="4" height="4" patternUnits="userSpaceOnUse">
      <path d="M0 1h4M1 0v4" stroke="#000" stroke-opacity=".09" stroke-width="1"/>
      <path d="M0 3h4M3 0v4" stroke="#fff" stroke-opacity=".12" stroke-width="1"/></pattern>
    <pattern id="pk-twill" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
      <path d="M0 1h5" stroke="#fff" stroke-opacity=".16" stroke-width="1.4"/>
      <path d="M0 3.5h5" stroke="#000" stroke-opacity=".12" stroke-width="1"/></pattern>
    <pattern id="pk-behind" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#3b4150"/><rect width="8" height="8" fill="#4a5161"/>
      <rect x="8" y="8" width="8" height="8" fill="#4a5161"/></pattern>
    ${[1, 2, 3, 4, 5].map(i => `<filter id="pk-blur-${i}" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${i * 0.7}"/></filter>`).join("")}
    <pattern id="pk-scan-300" width="4" height="2.6" patternUnits="userSpaceOnUse"><rect y="1.6" width="4" height="1" fill="#fff"/></pattern>
    <pattern id="pk-scan-600" width="4" height="1.3" patternUnits="userSpaceOnUse"><rect y=".85" width="4" height=".45" fill="#fff"/></pattern>
    <pattern id="pk-dots-300" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="1.5" cy="1.5" r="1.05" fill="#fff"/></pattern>
    <pattern id="pk-dots-600" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx=".8" cy=".8" r=".62" fill="#fff"/></pattern>
    ${["scan-300", "scan-600", "dots-300", "dots-600"].map(k => `<mask id="pk-m${k}" maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="150"><rect width="200" height="150" fill="url(#pk-${k})"/></mask>`).join("")}
    <linearGradient id="pk-shine" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".42" stop-color="#fff" stop-opacity=".0"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset=".58" stop-color="#fff" stop-opacity=".0"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".0"/></linearGradient>
  </defs>`;
  document.body.appendChild(svg);
  defsSvg = svg;
}

// the bare material over a w×h box
function texture(name, w, h, finish) {
  const L = lookOf(name, finish);
  if (IMAGES.has(L.img + ".jpg"))
    return `<image href="/img/${L.img}.jpg" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`;
  if (L.gloss) return (L.opaque ? "" : `<rect width="${w}" height="${h}" fill="url(#pk-behind)"/>`) +
    `<rect width="${w}" height="${h}" fill="${L.gloss}" fill-opacity="${L.opaque ? 1 : .55}"/>
    <rect width="${w}" height="${h}" fill="url(#pk-shine)"/>
    <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#fff" stroke-opacity="${L.opaque ? .18 : .5}"/>`;
  return `<rect width="${w}" height="${h}" fill="${L.stops[0]}" filter="url(#tx-${L.key})"/>` +
    (L.weave ? `<rect width="${w}" height="${h}" fill="url(#pk-${L.weave})"/>` : "");
}
// laser marks on a 200×150 swatch: an engraved emblem and/or a cut-out heart.
// `t` (0..1) is how hard the burn is — darker, deeper, a wider char halo and a
// wider kerf as it rises; `dpi` sets how visible the raster lines are; `photo`
// swaps the lettering for a halftone picture, as a photo engraving would be.
const heart = (x, y, z) => `M${x} ${y + z * .9}C${x - z * 1.6} ${y - z * .1} ${x - z * .8} ${y - z * 1.3} ${x} ${y - z * .45}` +
                           `C${x + z * .8} ${y - z * 1.3} ${x + z * 1.6} ${y - z * .1} ${x} ${y + z * .9}Z`;
function marks(name, { engrave, cut, t = 0.6, dpi = 600, photo = false, finish }) {
  const L = lookOf(name, finish), organic = !L.frost && !/anodized|stainless|alumamark|brass/.test(lookKey(name) || "");
  const ex = cut ? 72 : 100, cx = engrave ? 145 : 100;
  const blur = 1 + Math.round(t * 4);   // pk-blur-1 … pk-blur-5
  let s = "";
  if (engrave) {
    const ink = L.frost ? 0.45 + 0.4 * t : 0.4 + 0.6 * t;
    const depth = (0.3 + 1.7 * t).toFixed(2);
    const shape = photo
      ? `<circle cx="${ex + 14}" cy="56" r="13"/><path d="M${ex - 38} 108 L${ex - 14} 70 L${ex} 88 L${ex + 16} 62 L${ex + 38} 108Z"/>`
      : `<circle cx="${ex}" cy="75" r="34" fill="none" stroke-width="3.5"/><circle cx="${ex}" cy="75" r="27" fill="none" stroke-width="1.2"/>
         <text x="${ex}" y="86" text-anchor="middle" stroke="none" font-family="Georgia,serif" font-size="30" font-weight="700">Aa</text>`;
    const g = (paint, extra = "") => `<g fill="${paint}" stroke="${paint}" ${extra}>${shape}</g>`;
    // char halo (organic stock browns around a hard burn), lip highlight, the burn itself
    if (organic) s += g(L.mark, `opacity="${(0.08 + 0.4 * t).toFixed(2)}" filter="url(#pk-blur-${blur})"`);
    s += g("#fff", `opacity="${(0.12 + 0.25 * t).toFixed(2)}" transform="translate(0 ${depth})"`);
    s += g(L.mark, `opacity="${ink.toFixed(2)}"` + (photo ? ` mask="url(#pk-mdots-${dpi >= 600 ? 600 : 300})"` : ""));
    // raster lines: the head sweeps in rows; coarser DPI and lighter burns leave visible gaps
    if (!photo && dpi < 1000) s += g(L.stops ? L.stops[1] : L.gloss,
      `mask="url(#pk-mscan-${dpi >= 600 ? 600 : 300})" opacity="${(0.55 - 0.4 * t).toFixed(2)}"`);
  }
  if (cut) {
    const kerf = (0.7 + 2.3 * t).toFixed(2), d = heart(cx, 78, 26);
    if (organic) s += `<path d="${d}" fill="none" stroke="${L.mark}" stroke-width="${(2 + 5 * t).toFixed(1)}"
      opacity="${(0.1 + 0.45 * t).toFixed(2)}" filter="url(#pk-blur-${blur})"/>`;
    s += `<path d="${d}" fill="#000" fill-opacity="${(0.08 + 0.14 * t).toFixed(2)}"/>
      <path d="${d}" fill="none" stroke="#120c08" stroke-opacity=".85" stroke-width="${kerf}"/>`;
  }
  return s;
}
function swatch(name, opts) {
  return `<svg viewBox="0 0 200 150" preserveAspectRatio="xMidYMid slice">${texture(name, 200, 150, opts.finish)}${marks(name, opts)}</svg>`;
}

// ---------- real-size scale (thickness) ----------
// CSS "mm" is a nominal unit, not a physical one, so the thickness slabs are
// only life-size once calibrated against a bank card held to the screen.
const CARD_W = 85.6, CARD_H = 53.98, CARD_T = 0.76;
const thk = mm => inches() ? `${+(mm / INCH).toFixed(3)} in` : `${mm} mm`;   // a thickness, in display units
let mmScale = 1;
try { mmScale = +localStorage.getItem("hs-mm-scale") || 1; } catch (e) {}
const pxPerMm = () => 96 / 25.4 * mmScale;

// ---------- the panel ----------
let panel, openId = null;
function close() {
  if (!openId) return;
  $("#" + openId).classList.remove("picking");
  if (openId === "settingsBtn" && window.hsFinishesChanged) window.hsFinishesChanged();
  openId = null;
  panel.hidden = true;
  panel.innerHTML = "";
}
function choose(sel, value, finish) {
  if (finish) state.finish = finish;   // app.js keeps it if it belongs to the material
  sel.value = value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  close();
}
function open(sel) {
  if (openId) $("#" + openId).classList.remove("picking");
  openId = sel.id;
  sel.classList.add("picking");
  panel.style.top = document.querySelector("header").getBoundingClientRect().bottom + "px";
  panel.innerHTML = "";
  panel.hidden = false;
  render(sel);
  const on = panel.querySelector(".pk-card.on") || panel.querySelector(".pk-card");
  if (on) on.focus({ preventScroll: true });
}
// a panel's title row: a short subtitle, and the longer explanation (`info`)
// folded behind an ⓘ button so the panel itself stays quiet
function head(sel, sub, extra = "", info = "") {
  const clear = sel.value && sel.id === "sheet"
    ? `<button type="button" class="pk-clear" data-clear>Clear</button>` : "";
  return headRow(TITLES[sel.id], sub, extra + clear, info);
}
function headRow(title, sub, extra, info) {
  return `<div class="pk-head"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}
    ${info ? `<button type="button" class="pk-i" data-info title="About this" aria-expanded="false">i</button>` : ""}
    <span class="spacer"></span>${extra}<button type="button" class="pk-x" data-close title="Close (Esc)">✕</button></div>` +
    (info ? `<div class="pk-info" hidden>${info}</div>` : "");
}
// a card is a div acting as a button, so it can hold controls of its own (the colour dots)
function card(value, sel, art, body, cls = "") {
  return `<div role="button" tabindex="0" class="pk-card ${cls} ${String(sel.value) === String(value) ? "on" : ""}"
    data-v="${esc(value)}">${art}<div class="pk-body">${body}</div></div>`;
}
const chip = (t, cls = "") => `<span class="pk-chip ${cls}">${t}</span>`;
const opts = sel => [...sel.options].filter(o => o.value !== "");

function render(sel) {
  if (sel.id === "settingsBtn") return renderSettings();
  const html = { machine: viewMachine, material: viewMaterial, thickness: viewThickness,
                 sheet: viewSheet, preset: viewPreset }[sel.id](sel);
  panel.innerHTML = `<div class="pk-wrap">${html}</div>`;
  panel.querySelectorAll(".pk-card").forEach(b => {
    b.onclick = () => choose(sel, b.dataset.v, b.dataset.finish);
    b.onkeydown = e => { if (e.target === b && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); b.click(); } };
  });
  // colour dots: hovering previews the colour on the card, clicking picks material + colour
  panel.querySelectorAll(".pk-dot").forEach(d => {
    const c = d.closest(".pk-card"), name = c.dataset.v;
    const show = f => {
      c.querySelector(".pk-art").innerHTML = materialSwatch(name, f);
      c.querySelector(".pk-fin").textContent = f;
      c.querySelectorAll(".pk-dot").forEach(x => x.classList.toggle("on", x.dataset.f === f));
    };
    d.onmouseenter = d.onfocus = () => show(d.dataset.f);
    d.onclick = e => { e.stopPropagation(); choose(sel, name, d.dataset.f); };
  });
  panel.querySelectorAll(".pk-dots").forEach(g => g.onmouseleave = () => {
    const c = g.closest(".pk-card"), f = c.dataset.finish;
    c.querySelector(".pk-art").innerHTML = materialSwatch(c.dataset.v, f);
    c.querySelector(".pk-fin").textContent = f;
    c.querySelectorAll(".pk-dot").forEach(x => x.classList.toggle("on", x.dataset.f === f));
  });
  panel.querySelectorAll("[data-close]").forEach(b => b.onclick = close);
  panel.querySelectorAll("[data-clear]").forEach(b => b.onclick = () => choose(sel, ""));
  if (sel.id === "thickness") wireCalibration(sel);
  panel.querySelectorAll("[data-tab]").forEach(b => b.onclick = () => {
    presetTab = { tab: b.dataset.tab, forValue: sel.value };
    render(sel);
  });
}

// ---------- machine ----------
const MACHINE_ART = `<svg viewBox="0 0 320 210" class="pk-machine-art">
  <ellipse cx="160" cy="192" rx="138" ry="9" fill="#000" opacity=".25"/>
  <rect x="22" y="78" width="276" height="106" rx="9" fill="#2a2c31"/>
  <rect x="22" y="78" width="276" height="10" rx="5" fill="#3a3d44"/>
  <path d="M30 40h260l8 40H22z" fill="#1b1d21"/>
  <path d="M46 46h176l5 28H41z" fill="#0d171c"/>
  <g stroke="#6aa8ff" stroke-opacity=".18" stroke-width=".7">
    <path d="M60 52h150M57 58h158M54 64h166M51 70h172"/>
    <path d="M80 48l-6 26M110 48l-3 26M140 48v26M170 48l3 26M200 48l6 26"/></g>
  <path d="M60 47l40 0-30 26h-26z" fill="#fff" opacity=".07"/>
  <rect x="236" y="49" width="44" height="22" rx="3" fill="#0e0f12"/>
  <rect x="241" y="53" width="20" height="9" rx="1.5" fill="#6aa8ff" opacity=".85"/>
  <circle cx="268" cy="57" r="2.4" fill="#7bd88f"/><circle cx="275" cy="57" r="2.4" fill="#555"/>
  <circle cx="268" cy="65" r="2.4" fill="#555"/><circle cx="275" cy="65" r="2.4" fill="#d23b3b"/>
  <rect x="34" y="100" width="252" height="66" rx="5" fill="#25272c" stroke="#34373e"/>
  <rect x="34" y="96" width="70" height="4" rx="2" fill="#c8262e"/>
  <text x="44" y="122" fill="#e8e9ee" font-family="system-ui,sans-serif" font-size="13" font-weight="800" letter-spacing="2">EPILOG</text>
  <text x="44" y="138" fill="#9297a8" font-family="system-ui,sans-serif" font-size="9" letter-spacing="3">HELIX</text>
  <rect x="228" y="112" width="44" height="40" rx="4" fill="none" stroke="#3a3d44"/>
  <rect x="34" y="176" width="22" height="8" rx="2" fill="#17181b"/><rect x="264" y="176" width="22" height="8" rx="2" fill="#17181b"/>
</svg>`;
function viewMachine(sel) {
  const m = state.machine;
  const cards = opts(sel).map(o => {
    const img = `/img/${slug(o.value)}.jpg`;
    // a photo of YOUR machine at web/img/<name>.jpg wins; the drawing is the fallback
    const art = `<div class="pk-photo"><img src="${img}" alt="" onerror="this.remove()">${MACHINE_ART}</div>`;
    const isCur = m && m.name === o.value;
    const body = `<div class="pk-name">${esc(o.text)}</div>` + (isCur ?
      `<div class="pk-sub">Bed ${dims(m.bed_w_mm, m.bed_h_mm)} · reaches ${dims(m.usable_w_mm, m.usable_h_mm)}</div>
       <div class="pk-chips">${chip("Laser " + esc(state.laserHost))}${chip(`${len(m.safety_mm)} ${unit()} safety border`)}${chip("Origin top-left")}</div>` : "");
    return card(o.value, sel, art, body, "pk-wide");
  }).join("");
  return head(sel, "", "", `To show a photo of your own machine here, save it as <code>web/img/${slug(sel.value || "machine")}.jpg</code>.`) +
    `<div class="pk-grid pk-grid-wide">${cards}</div>`;
}

// ---------- material ----------
function materialSwatch(name, finish) {
  const m = state.materials.find(x => x.name === name);
  return swatch(name, { finish, engrave: m.operations.some(o => o.type === "engrave"),
                        cut: m.operations.some(o => o.type === "cut") });
}
// the swatch colour of a finish, for its dot
function dotColour(name, f) {
  const L = lookOf(name, f);
  return L.gloss || `linear-gradient(135deg, ${L.stops.join(", ")})`;
}
function viewMaterial(sel) {
  const cards = state.materials.map(m => {
    const eng = m.operations.filter(o => o.type === "engrave"), cut = m.operations.filter(o => o.type === "cut");
    const maxT = Math.max(0, ...cut.map(o => o.thickness_mm || 0));
    const fin = finishOf(m.name), fins = finishesOf(m.name);
    const chips = (eng.length ? chip("▦ Engrave", "eng") : "") +
      (cut.length ? chip("✂ Cut" + (maxT ? ` ≤ ${thk(maxT)}` : ""), "cut") : "");
    const dots = fins.length > 1 ? `<div class="pk-dots">${fins.map(f => `<button type="button" class="pk-dot ${f === fin ? "on" : ""}"
        data-f="${esc(f)}" title="${esc(f)}" aria-label="${esc(m.name)} — ${esc(f)}"
        style="background:${dotColour(m.name, f)}"></button>`).join("")}</div>` : "";
    return card(m.name, sel, `<div class="pk-art">${materialSwatch(m.name, fin)}</div>`,
      `<div class="pk-name">${esc(m.name)} <span class="pk-fin">${esc(fin)}</span></div>${dots}<div class="pk-chips">${chips}</div>` +
      (m.notes ? `<div class="pk-note" title="${esc(m.notes)}">${esc(m.notes)}</div>` : ""))
      .replace('data-v=', `data-finish="${esc(fin)}" data-v=`);
  }).join("");
  return head(sel, `${state.materials.length} materials`, "",
      "Hover a colour dot to preview it, click it to pick that colour. Each swatch shows how an engraving and a cut look on that stock. " +
      "Settings (⚙) adds colours of your own; a photo saved as <code>web/img/mat-&lt;material&gt;-&lt;colour&gt;.jpg</code> replaces the drawing.") +
    `<div class="pk-grid">${cards}</div>`;
}

// ---------- thickness, at real size ----------
function viewThickness(sel) {
  const m = currentMaterial(), name = m ? m.name : "Wood";
  const cuts = m ? m.operations.filter(o => o.type === "cut") : [];
  const px = pxPerMm();
  const rows = opts(sel).map(o => {
    const T = +o.value, h = Math.max(1, T * px);
    let cap = "";
    if (m) {
      // a preset with no rated thickness ("Thin Veneer", cork…) is still listed
      // for any thickness, but it promises nothing — say so rather than "cuts"
      const rated = cuts.some(c => c.thickness_mm != null && c.thickness_mm >= T);
      // an unrated cut only speaks for a material with no rated cuts at all —
      // Wood's "Thin Veneer" says nothing about 8 mm stock (as in app.js bestCut)
      const unrated = cuts.some(c => c.thickness_mm == null) && !cuts.some(c => c.thickness_mm != null);
      cap = rated ? chip("✂ cuts", "cut")
          : unrated ? chip("✂ unrated", "warn")
          : cuts.length ? chip("too thick to cut", "warn")
          : chip("engrave only", "");
    }
    const cards = T / CARD_T;
    const art = `<div class="pk-slab"><svg width="100%" height="${h}" viewBox="0 0 600 ${h}" preserveAspectRatio="xMinYMid slice">
        ${texture(name, 600, Math.max(h, 1))}<rect width="600" height="${h}" fill="none" stroke="#000" stroke-opacity=".35"/></svg></div>`;
    return `<button type="button" class="pk-card pk-row ${sel.value === o.value ? "on" : ""}" data-v="${o.value}">
      <div class="pk-mm">${inches() ? `<b>${+(T / INCH).toFixed(3)}</b> in<small>${T} mm</small>`
                                     : `<b>${T}</b> mm<small>${+(T / INCH).toFixed(3)}″</small>`}</div>
      ${art}
      <div class="pk-cmp">≈ ${cards < 10 ? cards.toFixed(1) : Math.round(cards)} bank cards${cap ? "<br>" + cap : ""}</div>
    </button>`;
  }).join("");
  const ref = `<div class="pk-ref"><span>Bank card edge · ${thk(CARD_T)}</span>
    <div class="pk-cardedge" style="height:${Math.max(1, CARD_T * px)}px"></div></div>`;
  return head(sel, m ? `${esc(m.name)} · ${esc(finishOf(m.name))}` : "",
      `<button type="button" class="pk-clear" data-cal>${mmScale === 1 ? "Calibrate" : "Recalibrate"}</button>`,
      "Each slab is the stock seen edge-on, at real size — once calibrated: screens don't report their physical size, " +
      "so hold a bank card to the screen under Calibrate. " +
      "<b>✂ cuts</b>: a cut preset is rated for this thickness. <b>✂ unrated</b>: the only cut preset has no rated thickness — test on scrap. " +
      "<b>too thick to cut</b>: every cut preset is rated thinner.") +
    `<div class="pk-cal" hidden>
       <p>Hold a bank card against the screen and drag until the outline matches it.</p>
       <div class="pk-cardbox"></div>
       <input type="range" min="0.6" max="2.2" step="0.005" value="${mmScale}">
       <button type="button" class="pk-clear" data-cal-done>Done</button></div>` +
    ref + `<div class="pk-list" style="--rows:${Math.ceil(opts(sel).length / 2)}">${rows}</div>`;
}
function wireCalibration(sel) {
  const box = panel.querySelector(".pk-cal"), cardbox = panel.querySelector(".pk-cardbox");
  const range = box.querySelector("input");
  const size = () => { cardbox.style.width = CARD_W * pxPerMm() + "px"; cardbox.style.height = CARD_H * pxPerMm() + "px"; };
  panel.querySelector("[data-cal]").onclick = () => { box.hidden = !box.hidden; size(); };
  range.oninput = () => { mmScale = +range.value; size(); };
  box.querySelector("[data-cal-done]").onclick = () => {
    try { localStorage.setItem("hs-mm-scale", String(mmScale)); } catch (e) {}
    render(sel);
  };
}

// ---------- stock size, drawn on the bed ----------
function viewSheet(sel) {
  const mc = state.machine, mat = currentMaterial(), name = mat ? mat.name : null;
  const W = mc.bed_w_mm, H = mc.bed_h_mm;
  const groups = sheetChoices().map(([group, list]) => {
    const cards = list.map(s => {
      const fill = name
        ? `<svg x="0" y="0" width="${s.w}" height="${s.h}" viewBox="0 0 ${s.w / 3} ${s.h / 3}" preserveAspectRatio="none">${texture(name, s.w / 3, s.h / 3)}</svg>`
        : `<rect width="${s.w}" height="${s.h}" fill="var(--sheet)"/>`;
      const art = `<div class="pk-art pk-bedart"><svg viewBox="-12 -12 ${W + 24} ${H + 24}">
          <rect width="${W}" height="${H}" rx="6" fill="var(--bed)" stroke="var(--bedline)" stroke-width="2"/>
          ${fill}<rect width="${s.w}" height="${s.h}" fill="none" stroke="var(--sheetline)" stroke-width="3"/>
          <circle r="7" fill="var(--accent2)"/></svg></div>`;
      const pct = Math.round(s.w * s.h / (W * H) * 100);
      return card(s.id, sel, art, `<div class="pk-name">${esc(s.name)}${s.id.endsWith("|P") ? " · portrait" : ""}</div>
        <div class="pk-sub">${dims(s.w, s.h)} · ${pct}% of the bed</div>`);
    }).join("");
    return `<h2 class="pk-group">${esc(group)}</h2><div class="pk-grid">${cards}</div>`;
  }).join("");
  return head(sel, `${dims(W, H)} bed`, "",
      "Each size is drawn to scale in the home corner of the bed, in the chosen material.") + groups;
}

// ---------- preset ----------
// how hard a preset burns: energy per area ∝ power ÷ speed (× DPI for a
// raster), placed on a log scale between this material's gentlest and hardest
// preset of the same kind — so the samples compare presets, not materials
const energy = op => op.power / Math.max(1, op.speed) * (op.type === "engrave" ? (op.dpi || 300) / 300 : 1);
function burnScale(ops) {
  const e = ops.map(energy).map(Math.log), lo = Math.min(...e), hi = Math.max(...e);
  return op => hi - lo < 1e-6 ? 0.5 : (Math.log(energy(op)) - lo) / (hi - lo);
}
// small labels over a preset's swatch: one sits top-right; two split across
// the top corners (engrave + cut: DPI top-left, Hz top-right)
const badges = list => list.length > 1
  ? `<span class="pk-badges pk-tl"><b>${list[0]}</b></span><span class="pk-badges"><b>${list[1]}</b></span>`
  : `<span class="pk-badges"><b>${list[0]}</b></span>`;
let presetTab = { tab: null, forValue: null };   // the tab looked at last, for the preset picker
function viewPreset(sel) {
  const m = currentMaterial();
  if (!m) return head(sel, "Choose a material first");
  const scale = {
    engrave: burnScale(m.operations.filter(o => o.type === "engrave")),
    cut: burnScale(m.operations.filter(o => o.type === "cut")),
  };
  const bar = (label, v, txt = v + "%") => `<div class="pk-bar"><span>${label}</span><i><b style="width:${v}%"></b></i><em>${txt}</em></div>`;
  const word = t => t < 0.34 ? "light" : t < 0.67 ? "medium" : "deep";
  const all = opts(sel), single = all.filter(o => !o.value.startsWith("c")), pairs = all.filter(o => o.value.startsWith("c"));
  // tabs: Cut · Engrave · Cut + Engrave — opening on the kind chosen now,
  // else the last tab looked at, else the first that has anything
  const kind = o => o.value.startsWith("c") ? "both" : m.operations[+o.value].type === "cut" ? "cut" : "engrave";
  const counts = { cut: 0, engrave: 0, both: 0 };
  all.forEach(o => counts[kind(o)]++);
  const cur = all.find(o => o.value === sel.value);
  let tab = presetTab.forValue === sel.value && counts[presetTab.tab] ? presetTab.tab : cur ? kind(cur) : presetTab.tab;
  if (!counts[tab]) tab = ["cut", "engrave", "both"].find(k => counts[k]) || "engrave";
  presetTab.tab = tab; presetTab.forValue = sel.value;
  const tabs = `<div class="pk-tabs" role="tablist">${[["cut", "✂ Cut"], ["engrave", "▦ Engrave"], ["both", "▦✂ Cut + Engrave"]]
    .map(([k, label]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}"
      class="${k === tab ? "on" : ""}" ${counts[k] ? "" : "disabled"}>${label}<em>${counts[k]}</em></button>`).join("")}</div>`;
  const cards = single.filter(o => kind(o) === tab).map(o => {
    const op = m.operations[+o.value], isCut = op.type === "cut";
    const t = scale[op.type](op);
    const art = `<div class="pk-art">${swatch(m.name, isCut
      ? { cut: true, t }
      : { engrave: true, t, dpi: op.dpi, photo: /photo/i.test(op.label) })}${badges([isCut ? `${op.freq} Hz` : `${op.dpi} DPI`])}</div>`;
    return card(o.value, sel, art, `<div class="pk-name">${isCut ? "✂" : "▦"} ${esc(presetLabel(op))}</div>
      ${bar("Speed", op.speed)}${bar("Power", op.power)}
      <div class="pk-bar pk-burn"><span>${isCut ? "Kerf" : "Burn"}</span><i><b style="width:${Math.round(8 + 92 * t)}%"></b></i><em>${word(t)}</em></div>
      ${isCut && op.thickness_mm ? `<div class="pk-chips">${chip(`up to ${thk(op.thickness_mm)}`)}</div>` : ""}`);
  }).join("");
  // engrave + cut: one job, the engraving first, then the hairlines cut out
  const pairCards = pairs.filter(() => tab === "both").map(o => {
    const [, ei, ci] = /^c(\d+):(\d+)$/.exec(o.value), e = m.operations[+ei], c = m.operations[+ci];
    const t = scale.engrave(e);
    const art = `<div class="pk-art">${swatch(m.name, { engrave: true, cut: true, t, dpi: e.dpi, photo: /photo/i.test(e.label) })}${badges([`${e.dpi} DPI`, `${c.freq} Hz`])}</div>`;
    return card(o.value, sel, art, `<div class="pk-name">▦ ${esc(presetLabel(e))}</div>
      <div class="pk-name pk-then">✂ ${esc(presetLabel(c))}</div>
      <div class="pk-sub">Engrave S${e.speed} · P${e.power} — burn ${word(t)}</div>
      <div class="pk-sub">Cut S${c.speed} · P${c.power}${c.thickness_mm ? ` · up to ${thk(c.thickness_mm)}` : ""}</div>
      <div class="pk-chips">${chip("One job", "eng")}${chip("Cuts hairlines", "cut")}</div>`);
  }).join("");
  const hidden = m.operations.length - single.length;
  return head(sel, `${esc(m.name)} · ${esc(finishOf(m.name))}${hidden ? ` · ${hidden} hidden` : ""}`, "",
      `Each sample is an impression of the burn, not a promise: power ÷ speed (× DPI when engraving), compared across
       ${esc(m.name.toLowerCase())}'s own presets. Coarser DPI shows its raster lines. Always test on scrap.` +
      (hidden ? ` ${hidden} cut preset${hidden > 1 ? "s are" : " is"} hidden: rated thinner than the chosen thickness.` : "") +
      (pairs.length ? ` <b>Engrave + cut</b> sends one job: the engraving first, then the cut. Only hairline strokes
       (0.1 mm or thinner) are cut — draw the outlines to cut that way; everything else is engraved.` : "")) +
    tabs + `<div class="pk-grid">${tab === "both" ? pairCards : cards}</div>`;
}

// ---------- settings: your own material colours ----------
// Built-in colours are listed, locked; yours can be added, renamed, recoloured
// and removed. Saved to finishes.json beside the server (gitignored), so a
// `git pull` never touches them.
let stMat = null;
function openSettings() { open($("#settingsBtn")); }
function renderSettings() {
  const mats = state.materials;
  if (!stMat || !mats.some(m => m.name === stMat)) stMat = $("#material").value || (mats[0] && mats[0].name);
  const nav = mats.map(m => {
    const n = CUSTOM.filter(c => c.material === m.name).length + SIZES.filter(z => z.material === m.name).length;
    return `<button type="button" class="st-mat ${m.name === stMat ? "on" : ""}" data-m="${esc(m.name)}">
      <svg viewBox="0 0 40 30" preserveAspectRatio="xMidYMid slice">${texture(m.name, 40, 30, finishesOf(m.name)[0])}</svg>
      <span>${esc(m.name)}</span>${n ? `<em>${n}</em>` : ""}</button>`;
  }).join("");
  const B = baseOf(stMat), mine = CUSTOM.map((c, i) => [c, i]).filter(([c]) => c.material === stMat);
  const builtIn = B.finishes.filter(f => !f.custom).map(f => `<div class="st-fin">
      <div class="pk-art">${materialSwatch(stMat, f.n)}</div><div><b>${esc(f.n)}</b><small>🔒 built-in</small></div></div>`).join("");
  const rows = mine.map(([c, i]) => `<div class="st-row" data-i="${i}">
      <div class="pk-art st-prev">${materialSwatch(stMat, c.name)}</div>
      <label>Name<input type="text" data-k="name" maxlength="40" value="${esc(c.name)}"></label>
      <label>Colour<input type="color" data-k="base" value="${c.base}"></label>
      <label>Burns as<input type="color" data-k="mark" value="${c.mark}"></label>
      <label title="Worked out from the colour, for text drawn on it">Text<span class="st-text"
        style="background:${c.base};color:${c.text || contrastText([c.base])}">Aa</span></label>
      ${B.frost ? `<label class="st-check"><input type="checkbox" data-k="see_through" ${c.see_through ? "checked" : ""}>See-through</label>` : ""}
      <button type="button" class="st-del" data-del title="Remove this colour">✕</button>
      <p class="st-err" hidden></p></div>`).join("");
  const bed = state.machine, tooBig = z => bed && Math.max(z.w, z.h) > bed.bed_w_mm + 0.5 ||
    bed && Math.min(z.w, z.h) > bed.bed_h_mm + 0.5;
  const sizeRows = SIZES.map((z, i) => [z, i]).filter(([z]) => z.material === stMat).map(([z, i]) => `
    <div class="st-row st-srow" data-i="${i}">
      <div class="st-sizeprev">${sizePreview(z)}</div>
      <label>Name<input type="text" data-k="name" maxlength="40" value="${esc(z.name)}"></label>
      <label>Width (${unit()})<input type="number" data-k="w" step="${inches() ? 0.01 : 0.1}" value="${len(z.w)}"></label>
      <label>Height (${unit()})<input type="number" data-k="h" step="${inches() ? 0.01 : 0.1}" value="${len(z.h)}"></label>
      <button type="button" class="st-del" data-del title="Remove this size">✕</button>
      <p class="st-err" ${tooBig(z) ? "" : "hidden"}>${tooBig(z) ? "Bigger than the bed — it won't be offered." : ""}</p></div>`).join("");
  panel.innerHTML = `<div class="pk-wrap">
    ${headRow("Settings", "Material colours and sizes",
      `<div class="seg" role="group" aria-label="Units">${["mm", "in"].map(u =>
        `<button type="button" data-unit="${u}" class="${unit() === u ? "on" : ""}">${u}</button>`).join("")}</div>`,
      "Built-in colours (🔒) can't be changed; add your own beside them — the colour of the stock you buy and the colour a burn " +
      "leaves on it. The pattern (grain, weave, brushing) comes from the material. Saved to <code>finishes.json</code> beside the server.")}
    <div class="st-grid"><nav class="st-nav">${nav}</nav><section class="st-main">
      <h2 class="pk-group">${esc(stMat)} · built-in</h2><div class="st-fins">${builtIn}</div>
      <h2 class="pk-group">${esc(stMat)} · your colours</h2>
      <div class="st-rows">${rows || `<p class="pk-sub">None yet.</p>`}</div>
      <button type="button" class="st-add" data-add>+ Add a colour</button>
      <h2 class="pk-group">${esc(stMat)} · your sizes</h2>
      <div class="st-rows">${sizeRows || `<p class="pk-sub">None yet.</p>`}</div>
      <button type="button" class="st-add" data-add-size>+ Add a size</button>
    </section></div></div>`;
  panel.querySelectorAll("[data-close]").forEach(b => b.onclick = close);
  panel.querySelectorAll(".st-mat").forEach(b => b.onclick = () => { stMat = b.dataset.m; renderSettings(); });
  // units: display only — lengths everywhere switch, nothing stored changes
  panel.querySelectorAll("[data-unit]").forEach(b => b.onclick = () => {
    state.units = b.dataset.unit;
    savePrefs({ units: state.units });
    applyUnits(); renderSettings();
  });
  panel.querySelector("[data-add]").onclick = () => {
    const taken = new Set(finishesOf(stMat));
    let n = 1; while (taken.has(`My colour ${n}`)) n++;
    const first = lookOf(stMat, finishesOf(stMat)[0]);
    CUSTOM.push({ material: stMat, name: `My colour ${n}`, base: first.gloss || first.stops[1] || "#888888",
                  mark: first.mark, see_through: !!(B.frost && !first.opaque) });
    saveCustom(); renderSettings();
    const last = panel.querySelector(".st-row:last-child input[data-k=name]");
    if (last) { last.focus(); last.select(); }
  };
  panel.querySelectorAll(".st-row:not(.st-srow)").forEach(row => {
    const c = CUSTOM[+row.dataset.i], err = row.querySelector(".st-err");
    row.querySelector("[data-del]").onclick = () => { CUSTOM.splice(+row.dataset.i, 1); saveCustom(); renderSettings(); };
    row.querySelectorAll("input").forEach(inp => inp.oninput = () => {
      const k = inp.dataset.k, v = inp.type === "checkbox" ? inp.checked : inp.value;
      if (k === "name") {
        const name = v.trim(), clash = finishesOf(stMat).some(f => f === name && f !== c.name);
        err.hidden = !!name && !clash;
        err.textContent = !name ? "Give it a name." : clash ? `${stMat} already has a colour called “${name}”.` : "";
        if (!name || clash) return;
        if (state.finish === c.name && $("#material").value === stMat) state.finish = name;   // keep it selected
        c.name = name;
      } else c[k] = v;
      saveCustom();
      row.querySelector(".st-prev").innerHTML = materialSwatch(stMat, c.name);
      const tx = row.querySelector(".st-text");
      tx.style.background = c.base; tx.style.color = c.text;
    });
  });
  // ---- your sizes ----
  const builtinNames = () => new Set(SHEETS.flatMap(([, l]) => l.map(([n]) => n)));
  panel.querySelector("[data-add-size]").onclick = () => {
    const taken = new Set([...builtinNames(), ...sizesOf(stMat).map(([n]) => n)]);
    let n = 1; while (taken.has(`My size ${n}`)) n++;
    SIZES.push({ material: stMat, name: `My size ${n}`, w: 300, h: 200 });
    saveCustom(); renderSettings();
    const last = [...panel.querySelectorAll(".st-srow input[data-k=name]")].pop();
    if (last) { last.focus(); last.select(); }
  };
  panel.querySelectorAll(".st-srow").forEach(row => {
    const z = SIZES[+row.dataset.i], err = row.querySelector(".st-err");
    row.querySelector("[data-del]").onclick = () => { SIZES.splice(+row.dataset.i, 1); saveCustom(); renderSettings(); };
    row.querySelectorAll("input").forEach(inp => inp.oninput = () => {
      const k = inp.dataset.k;
      let problem = "";
      if (k === "name") {
        const name = inp.value.trim();
        problem = !name ? "Give it a name." : name.includes("|") ? "A name can't contain “|”."
          : builtinNames().has(name) ? `“${name}” is a built-in size — pick another name.`
          : SIZES.some(o => o !== z && o.material === stMat && o.name === name) ? `${stMat} already has a size called “${name}”.` : "";
        if (!problem) {
          // renaming the size in use keeps it selected (its id is "<name>|L/P")
          const [was, o] = (state.sheetWant || "").split("|");
          if (was === z.name && z.material === $("#material").value) {
            state.sheetWant = `${name}|${o}`;
            savePrefs({ sheet: state.sheetWant });
          }
          z.name = name;
        }
      } else {
        const v = fromLen(parseFloat(inp.value));
        problem = !(v >= 1 && v <= SIZE_MAX) ? `Width and height are ${len(1)}–${len(SIZE_MAX)} ${unit()}.` : "";
        if (!problem) z[k] = Math.round(v * 10) / 10;
      }
      if (!problem && bed && (Math.max(z.w, z.h) > bed.bed_w_mm + 0.5 || Math.min(z.w, z.h) > bed.bed_h_mm + 0.5))
        problem = "Bigger than the bed — it won't be offered.";
      err.hidden = !problem; err.textContent = problem;
      row.querySelector(".st-sizeprev").innerHTML = sizePreview(z);
      saveCustom();
    });
  });
}
// a size drawn to scale in the bed's outline, in the material
function sizePreview(z) {
  const W = state.machine.bed_w_mm, H = state.machine.bed_h_mm;
  const w = Math.min(z.w, W), h = Math.min(z.h, H);
  return `<svg viewBox="-8 -8 ${W + 16} ${H + 16}"><rect width="${W}" height="${H}" rx="6" fill="var(--bed)" stroke="var(--bedline)" stroke-width="3"/>
    <svg width="${w}" height="${h}" viewBox="0 0 ${w / 3} ${h / 3}" preserveAspectRatio="none">${texture(stMat, w / 3, h / 3, finishOf(stMat))}</svg>
    <rect width="${w}" height="${h}" fill="none" stroke="var(--accent2)" stroke-width="3"/></svg>`;
}

// ---------- wiring ----------
function init() {
  buildDefs();
  panel = document.createElement("div");
  panel.className = "picker";
  panel.id = "picker";
  panel.hidden = true;
  document.body.appendChild(panel);
  // a click on the backdrop (not a card or control) closes it
  panel.addEventListener("click", e => {
    if (e.target === panel || e.target.classList.contains("pk-wrap")) return close();
    const ib = e.target.closest("[data-info]");
    if (ib) {
      const box = panel.querySelector(".pk-info");
      box.hidden = !box.hidden;
      ib.classList.toggle("on", !box.hidden);
      ib.setAttribute("aria-expanded", String(!box.hidden));
    }
  });
  PICKED.forEach(id => {
    const sel = $("#" + id);
    sel.addEventListener("mousedown", e => {
      if (sel.disabled || e.button !== 0) return;
      e.preventDefault();             // no native list
      if (openId === id) close(); else open(sel);
    });
    sel.addEventListener("keydown", e => {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) { e.preventDefault(); open(sel); }
    });
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && openId) { const id = openId; close(); $("#" + id).focus(); }
  });
  window.addEventListener("resize", () => { if (openId && openId !== "settingsBtn") open($("#" + openId)); });
  $("#settingsBtn").addEventListener("click", () => openId === "settingsBtn" ? close() : openSettings());
}
init();
fetch("/api/finishes").then(r => r.json()).then(d => {
  CUSTOM = Array.isArray(d.custom) ? d.custom : [];
  SIZES = Array.isArray(d.sizes) ? d.sizes : [];
  // colours saved before text colours existed get theirs worked out and saved once
  if (CUSTOM.some(c => !c.text)) saveCustom(); else applyCustom();
}).catch(() => {}).finally(() => {
  window.HSLook.ready = true;
  if (window.hsFinishesChanged) window.hsFinishesChanged();
});

// what the bed's burn simulation needs to know about a material in a colour
function burnLook(name, finish) {
  const L = lookOf(name, finish);
  return { mark: L.mark, frost: !!L.frost, see: !!L.gloss && !L.opaque, text: L.text, dark: L.text === INK_LIGHT,
           organic: !L.frost && !/anodized|stainless|alumamark|brass/.test(lookKey(name) || "") };
}
// how hard a preset burns on this material, 0..1 (the same scale the preset cards use)
function burnOf(name, op) {
  const m = state.materials.find(x => x.name === name);
  return m ? burnScale(m.operations.filter(o => o.type === op.type))(op) : 0.5;
}
window.HSLook = { finishesOf, sizesOf, texture, look: burnLook, burn: burnOf, swatch: dotColour, ink: c => contrastText([c]), openSettings };
})();
