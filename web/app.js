// Helix Studio — front-end
const $ = s => document.querySelector(s);
const state = { materials: [], session: null, laserHost: "192.168.1.6", machine: null };

async function boot() {
  const cfg = await (await fetch("/api/config")).json();
  state.laserHost = cfg.laser_host;
  state.machine = cfg.machine;
  $("#laserPill").innerHTML = "laser <b>" + cfg.laser_host + "</b>";
  $("#host").value = cfg.laser_host;
  const m = cfg.machine;
  $("#bed").setAttribute("viewBox", `0 0 ${m.bed_w_mm} ${m.bed_h_mm}`);

  const mat = await (await fetch("/api/materials")).json();
  state.materials = mat.materials;
  const sel = $("#material");
  mat.materials.forEach(m => {
    const o = document.createElement("option");
    o.value = m.name; o.textContent = m.name;
    sel.appendChild(o);
  });
}

// ---- upload ----
const drop = $("#drop"), fileInput = $("#file");
drop.onclick = () => fileInput.click();
fileInput.onchange = e => e.target.files[0] && importPdf(e.target.files[0]);
["dragover", "dragenter"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.add("hot");
}));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
  e.preventDefault(); drop.classList.remove("hot");
}));
drop.addEventListener("drop", e => {
  const f = e.dataTransfer.files[0];
  if (f && f.type === "application/pdf") importPdf(f);
});

async function importPdf(file) {
  drop.innerHTML = "<p class='muted'>importing " + file.name + "…</p>";
  const buf = await file.arrayBuffer();
  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: buf,
  });
  const data = await res.json();
  if (data.error) { drop.innerHTML = "<p class='warn'>" + data.error + "</p>"; return; }
  state.session = data;
  drop.style.display = "none";
  $("#stage").classList.add("on");
  $("#preview").src = data.preview + "?t=" + Date.now();
  const info = data.info;
  $("#pagePill").style.display = "";
  $("#pagePill").textContent = `${info.width_mm} × ${info.height_mm} mm · ${info.pages} page(s)`;
  $("#resetBtn").style.display = "";
  renderLayers();
  $("#layersSection").style.display = data.layers.length ? "" : "none";
  $("#placeSection").style.display = "";
  $("#sendSection").style.display = "";
  updateBed();
}

$("#resetBtn").onclick = () => location.reload();

// ---- bed placement preview + bounds check ----
function boundsCheck() {
  const m = state.machine, c = state.session && state.session.content_mm;
  if (!m || !c) return { ok: false };
  const ox = +$("#offx").value, oy = +$("#offy").value;
  const maxW = m.usable_w_mm - m.margin_mm, maxH = m.usable_h_mm - m.margin_mm;
  const ok = ox >= 0 && oy >= 0 && ox + c.w_mm <= maxW && oy + c.h_mm <= maxH;
  return { ok, ox, oy, cw: c.w_mm, ch: c.h_mm, maxW, maxH };
}

function updateBed() {
  const svg = $("#bed"), m = state.machine, c = state.session && state.session.content_mm;
  if (!m) return;
  const b = boundsCheck();
  const art = c ? `<rect x="${b.ox}" y="${b.oy}" width="${c.w_mm}" height="${c.h_mm}"
      fill="${b.ok ? 'rgba(123,216,143,.28)' : 'rgba(255,107,107,.30)'}"
      stroke="${b.ok ? '#7bd88f' : '#ff6b6b'}" stroke-width="2"/>` : "";
  svg.innerHTML = `
    <rect x="0" y="0" width="${m.bed_w_mm}" height="${m.bed_h_mm}" fill="#111318" stroke="#333644" stroke-width="1"/>
    <rect x="${m.margin_mm}" y="${m.margin_mm}"
      width="${m.usable_w_mm - 2*m.margin_mm}" height="${m.usable_h_mm - 2*m.margin_mm}"
      fill="none" stroke="#3a3f50" stroke-dasharray="6 5" stroke-width="1"/>
    <circle cx="0" cy="0" r="6" fill="#6aa8ff"/>
    ${art}`;
  if (c) {
    $("#placeInfo").textContent =
      `Artwork ${c.w_mm.toFixed(0)}×${c.h_mm.toFixed(0)} mm · placed at (${b.ox},${b.oy}) · ` +
      `reaches (${(b.ox + c.w_mm).toFixed(0)},${(b.oy + c.h_mm).toFixed(0)}) mm · ` +
      `bed ${m.bed_w_mm}×${m.bed_h_mm}`;
    const warn = $("#boundsWarn");
    if (!b.ok) {
      warn.style.display = "";
      warn.textContent = "⚠ Out of bounds — would exceed the usable area (" +
        b.maxW.toFixed(0) + "×" + b.maxH.toFixed(0) + " mm). Sending is disabled.";
    } else warn.style.display = "none";
  }
  const bad = !b.ok;
  $("#sendBtn").disabled = bad;
  $("#frameBtn").disabled = bad;
}

$("#offx").oninput = updateBed;
$("#offy").oninput = updateBed;

// ---- material change re-populates layer operation dropdowns ----
$("#material").onchange = () => {
  const m = currentMaterial();
  $("#matNotes").textContent = m && m.notes ? m.notes : "";
  renderLayers();
};

function currentMaterial() {
  return state.materials.find(m => m.name === $("#material").value) || null;
}

function renderLayers() {
  const box = $("#layers");
  box.innerHTML = "";
  if (!state.session) return;
  const m = currentMaterial();
  state.session.layers.forEach((L, i) => {
    const div = document.createElement("div");
    div.className = "layer";
    div.dataset.i = i;

    const top = document.createElement("div");
    top.className = "top";
    const sw = document.createElement("div");
    sw.className = "swatch"; sw.style.background = L.hex;
    const name = document.createElement("div");
    name.style.flex = "1";
    name.innerHTML = `<div>${L.hex}</div><div class="cov">${(L.coverage*100).toFixed(1)}% of art</div>`;
    top.appendChild(sw); top.appendChild(name);
    div.appendChild(top);

    // operation dropdown
    const opSel = document.createElement("select");
    opSel.className = "opsel";
    const ignore = new Option("Ignore this colour", "ignore");
    opSel.appendChild(ignore);
    if (m) {
      m.operations.forEach((op, oi) => {
        const label = `${op.type === "cut" ? "✂ Cut" : "▦ Engrave"} — ${op.label}`;
        opSel.appendChild(new Option(label, oi));
      });
    }
    div.appendChild(opSel);

    const grid = document.createElement("div");
    grid.className = "grid4";
    grid.innerHTML = `
      <div><label class="f">Speed %</label><input type="number" class="sp" min="1" max="100"></div>
      <div><label class="f">Power %</label><input type="number" class="pw" min="1" max="100"></div>
      <div class="dpiWrap"><label class="f">DPI</label><input type="number" class="dpi"></div>
      <div class="freqWrap"><label class="f">Freq Hz</label><input type="number" class="freq"></div>`;
    div.appendChild(grid);

    function applyOp() {
      const val = opSel.value;
      if (val === "ignore" || !m) {
        div.classList.add("ignored");
        grid.style.display = "none";
        return;
      }
      div.classList.remove("ignored");
      grid.style.display = "";
      const op = m.operations[parseInt(val, 10)];
      grid.querySelector(".sp").value = op.speed;
      grid.querySelector(".pw").value = op.power;
      grid.querySelector(".dpiWrap").style.display = op.type === "engrave" ? "" : "none";
      grid.querySelector(".freqWrap").style.display = op.type === "cut" ? "" : "none";
      grid.querySelector(".dpi").value = op.dpi || "";
      grid.querySelector(".freq").value = op.freq || "";
    }
    opSel.onchange = applyOp;
    // default: pick first engrave op if present, else ignore
    if (m) {
      const firstEng = m.operations.findIndex(o => o.type === "engrave");
      opSel.value = firstEng >= 0 ? String(firstEng) : "ignore";
    } else {
      opSel.value = "ignore";
    }
    applyOp();
    box.appendChild(div);
  });
  if (!m) $("#layers").insertAdjacentHTML("afterbegin",
    "<p class='muted' style='font-size:12px'>Choose a material to assign settings.</p>");
}

// ---- send ----
$("#sendBtn").onclick = async () => {
  const m = currentMaterial();
  if (!m) { alert("Choose a material first."); return; }
  const assignments = [];
  document.querySelectorAll(".layer").forEach(div => {
    const opSel = div.querySelector(".opsel");
    if (!opSel || opSel.value === "ignore") return;
    const op = m.operations[parseInt(opSel.value, 10)];
    const L = state.session.layers[parseInt(div.dataset.i, 10)];
    assignments.push({
      hex: L.hex, rgb: L.rgb, op: op.type,
      label: op.label,
      speed: +div.querySelector(".sp").value,
      power: +div.querySelector(".pw").value,
      dpi: +div.querySelector(".dpi").value || undefined,
      freq: +div.querySelector(".freq").value || undefined,
    });
  });
  if (!assignments.length) { alert("Assign at least one colour to cut or engrave."); return; }

  const dry = $("#dryrun").checked;
  const btn = $("#sendBtn");
  btn.disabled = true; btn.textContent = dry ? "Building…" : "Sending…";
  const out = $("#out"); out.classList.add("on"); out.textContent = "working…";
  try {
    const res = await fetch("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.session.id, host: $("#host").value,
        material: m.name, assignments,
        offset_mm: [+$("#offx").value, +$("#offy").value],
        autofocus: $("#autofocus").checked, dry_run: dry,
      }),
    });
    const data = await res.json();
    if (data.error) { out.textContent = "ERROR: " + data.error; }
    else {
      const lines = data.jobs.map(j =>
        j.skipped ? `· ${j.title}: SKIPPED (${j.skipped})`
        : `· ${j.title}: ${j.bytes} bytes ${j.sent ? "→ SENT" : "(dry-run)"}`);
      out.textContent = (dry ? "DRY-RUN — nothing sent\n" : "Sent to " + data.host +
        " — press GO on the machine per job\n") + lines.join("\n");
    }
  } catch (e) {
    out.textContent = "ERROR: " + e.message;
  }
  btn.disabled = false; btn.textContent = dry ? "Build jobs" : "Send to laser";
};

$("#dryrun").onchange = e => {
  $("#sendBtn").textContent = e.target.checked ? "Build jobs" : "Send to laser";
};

// ---- frame test ----
$("#frameBtn").onclick = async () => {
  if (!state.session) return;
  const dry = $("#dryrun").checked;
  const out = $("#out"); out.classList.add("on"); out.textContent = "framing…";
  const btn = $("#frameBtn"); btn.disabled = true;
  try {
    const res = await fetch("/api/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.session.id, host: $("#host").value, frame: true,
        offset_mm: [+$("#offx").value, +$("#offy").value], dry_run: dry,
      }),
    });
    const data = await res.json();
    if (data.error) out.textContent = "ERROR: " + data.error;
    else out.textContent = (dry ? "DRY-RUN frame (not sent)\n" :
      "Frame sent — press GO; the head traces the artwork outline at low power.\n") +
      `outline ${data.placement.content_w_mm}×${data.placement.content_h_mm} mm at ` +
      `(${data.placement.x_mm},${data.placement.y_mm})`;
  } catch (e) { out.textContent = "ERROR: " + e.message; }
  btn.disabled = false;
};

boot();
