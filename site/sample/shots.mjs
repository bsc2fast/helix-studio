// Capture the marketing-site screenshots from the running app (localhost:4060)
// with the neutral sample PDF (sample.pdf — no customer or personal designs).
//   node site/sample/shots.mjs          (the app must be running)
// Starts its own headless Chrome, shoots every view in dark and light, and
// leaves prefs.json as it found it. The laser chip is shown connected.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const DIR = new URL(".", import.meta.url).pathname;            // site/sample/
const OUT = new URL("../public/assets/", import.meta.url).pathname;
const PREFS = new URL("../../prefs.json", import.meta.url).pathname;
const pdf64 = readFileSync(DIR + "sample.pdf").toString("base64");
let prefsBackup = null;
try { prefsBackup = readFileSync(PREFS); } catch {}

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--remote-debugging-port=9334", "--hide-scrollbars",
   "--user-data-dir=" + mkdtempSync(tmpdir() + "/helix-shots-"), "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(2000);
const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const wait = {};
ws.onmessage = m => { const d = JSON.parse(m.data); if (wait[d.id]) { wait[d.id](d); delete wait[d.id]; }
  if (d.method === "Page.javascriptDialogOpening") {   // an alert() would freeze the page: report it and dismiss
    console.log("dialog:", d.params.message);
    ws.send(JSON.stringify({ id: 1e6 + id, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  } };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  if (process.env.SHOTS_DEBUG) console.log("·", expr.replace(/\s+/g, " ").slice(0, 70));
  const r = await cmd("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(expr.slice(0, 80) + " → " + JSON.stringify(r.result.exceptionDetails.exception?.description));
  return r.result.result.value;
};
const shot = async name => {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT + name + ".png", Buffer.from(r.result.data, "base64"));
  console.log("wrote", name);
};
const mouse = (x, y) => cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
const centre = async sel => ev(`const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.left+b.width/2,b.top+b.height/2]`);
const pick = id => ev(`document.querySelector('#${id}').dispatchEvent(new MouseEvent('mousedown',{button:0,bubbles:true,cancelable:true})); return 1`);
const esc = () => ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); return 1`);
const setSel = (id, v) => ev(`const s=$("#${id}"); s.value=${JSON.stringify(v)}; s.dispatchEvent(new Event("change")); return 1`);

await cmd("Page.enable");
await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
try {
  for (const theme of ["dark", "light"]) {
    await cmd("Page.navigate", { url: "http://localhost:4060/" }); await sleep(1500);
    await ev(`localStorage.setItem("hs-theme","${theme}"); return 1`);
    await cmd("Page.reload"); await sleep(2500);
    // connected-laser look; no scans while shooting
    await ev(`clearTimeout(pollTimer); pollLaser = scanLaser = async () => {}; return 1`);
    await sleep(3500);
    await ev(`clearTimeout(pollTimer); state.laser="online"; renderLaser(); return 1`);
    await ev(`state.finish="Birch ply"; return 1`);
    // Arch A (not A4): the sample's pages are A4, which would switch Page layout on
    await setSel("material", "Wood"); await setSel("thickness", "3"); await setSel("sheet", "Arch A|L");
    await ev(`state.sheetOff={x:60,y:50}; moveSheet(); return 1`);
    await ev(`const b=Uint8Array.from(atob("${pdf64}"),c=>c.charCodeAt(0));
      await importPdf(new File([b],"sample.pdf",{type:"application/pdf"})); return 1`);
    await sleep(1500);
    // three engraved coasters (page 5) on the A4 sheet, engrave + cut in one job
    await ev(`const d=state.docs[0].id; state.items.slice().forEach(removeItem);
      await includePage(d,5); await includePage(d,5,true); await includePage(d,5,true); return 1`);
    await ev(`const p=$("#preset"); p.value=[...p.querySelectorAll("optgroup option")].find(o=>o.text.includes("Clipart")&&o.text.includes("600")).value;
      p.dispatchEvent(new Event("change")); select(state.items[0]); return 1`);
    await sleep(3500);                    // burn preview + job time estimate land
    await mouse(5, 5);
    await shot(`hero-${theme}`);

    await pick("material"); await sleep(700); await shot(`material-${theme}`); await esc();
    await pick("preset"); await sleep(700); await shot(`presets-${theme}`); await esc();
    await pick("thickness"); await sleep(700); await shot(`thickness-${theme}`); await esc();

    // corner snapping: the Here markers, hovering bottom-right previews the landing
    await ev(`$("#artCorner").click(); return 1`); await sleep(400);
    const [hx, hy] = await centre("#cornerPick .here.br"); await mouse(hx, hy); await sleep(500);
    await shot(`corner-${theme}`); await esc(); await mouse(5, 5);

    // the burn preview: the sun wheel and a coaster engraved on walnut, deep
    await ev(`const d=state.docs[0].id; state.items.slice().forEach(removeItem); state.finish="Walnut"; return 1`);
    await setSel("material", "Wood");
    await ev(`const d=state.docs[0].id; await includePage(d,1); await includePage(d,5); return 1`);
    await ev(`const p=$("#preset"); p.value=[...p.options].find(o=>o.text.includes("Deep")&&!o.closest("optgroup")).value;
      p.dispatchEvent(new Event("change")); select(state.items[0]); return 1`);
    await sleep(3500);
    await shot(`burn-${theme}`);

    // the warnings: drop one coaster onto the other, hover the pulsing ⚠
    await ev(`const [a,b]=state.items; b.off={x:a.off.x+30,y:a.off.y+20}; select(b); updatePlacement(); return 1`);
    await sleep(600);
    const [ax, ay] = await centre("#artAlert"); await mouse(ax, ay); await sleep(600);
    await shot(`warning-${theme}`); await mouse(5, 5);

    // Settings: your own colours and sizes, mm ↔ in
    await ev(`$("#settingsBtn").click(); return 1`); await sleep(500);
    await ev(`[...document.querySelectorAll(".st-mat")].find(b=>b.dataset.m==="Wood").click(); return 1`); await sleep(500);
    await shot(`settings-${theme}`); await esc();
  }
} finally {
  ws.close(); chrome.kill();
  if (prefsBackup) writeFileSync(PREFS, prefsBackup);   // the shoot changed the last-used setup: put it back
}
