// Capture the marketing-site screenshots from the running app (localhost:4060)
// with the neutral sample PDF: a multi-page layout on a stock sheet, and the
// overlap guard. The laser chip is shown in its connected state.
import { readFileSync, writeFileSync } from "node:fs";
const DIR = new URL(".", import.meta.url).pathname;   // site/sample/
const OUT = new URL("../public/assets/", import.meta.url).pathname;
const pdf64 = readFileSync(DIR + "sample.pdf").toString("base64");
const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const wait = {};
ws.onmessage = m => { const d = JSON.parse(m.data); if (wait[d.id]) { wait[d.id](d); delete wait[d.id]; } };
const cmd = (method, params = {}) => new Promise(r => { const i = ++id; wait[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await cmd("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = async name => {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT + name, Buffer.from(r.result.data, "base64"));
  console.log("wrote", name);
};
await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

for (const theme of ["dark", "light"]) {
  await cmd("Page.navigate", { url: "http://localhost:4060/" });
  await sleep(1200);
  await ev(`localStorage.setItem("hs-theme","${theme}"); localStorage.setItem("hs-sheet","Arch B|L");
    localStorage.setItem("hs-sheet-off", JSON.stringify({x:0,y:0})); true`);
  await cmd("Page.reload"); await sleep(1500);
  await ev(`(async()=>{const b=Uint8Array.from(atob("${pdf64}"),c=>c.charCodeAt(0));
    await importPdf(new File([b],"sample.pdf",{type:"application/pdf"})); return true})()`);
  await ev(`(async()=>{ for (let n=2;n<=4;n++) await includePage(n); return true })()`);
  await ev(`const m=$("#material"); m.value="Acrylic"; m.onchange();
    const t=$("#thickness"); t.value="3"; t.onchange();
    const p=$("#preset"); p.value=[...p.options].find(o=>o.text.includes("✂")).value; p.onchange(); true`);
  // connected-laser look for the hero
  await ev(`clearTimeout(pollTimer); pollLaser = scanLaser = async () => {}; true`);
  await sleep(3500);   // any start-up scan already in flight lands first
  await ev(`clearTimeout(pollTimer); state.laser="online"; renderLaser(); select(state.items[0]); true`);
  await sleep(800);
  await shot(`app-${theme}.png`);
  // overlap: drag the hexagon onto the tag
  await ev(`const a=state.items.find(i=>i.page===3), h=state.items.find(i=>i.page===4);
    select(h); h.off={x:a.off.x+40,y:a.off.y+18}; updatePlacement(); true`);
  await sleep(500);
  await shot(`overlap-${theme}.png`);
  console.log(await ev(`JSON.stringify(state.items.map(i=>[i.page,Math.round(i.off.x),Math.round(i.off.y)]))`));
}
ws.close();
