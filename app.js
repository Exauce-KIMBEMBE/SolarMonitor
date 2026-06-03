/* =========================================================
   Dashboard ESP32 — app.js
   I(U), historique, servos, orientation solaire, tracker LDR
   Version Render API sans WebSocket
   ========================================================= */

const $ = (id) => document.getElementById(id);
const fmt = (v, nd = 3) =>
  (v === null || v === undefined || Number.isNaN(Number(v)))
    ? "—"
    : Number(v).toFixed(nd).replace(/\.0+$/, "");

const LUX_SCALE = 1000;
const UI_VOLT_MAX_HARD = 60;
const UI_VOLT_MIN_HARD = 1;

const API_URL = "https://solarmonitor-5093.onrender.com";

let currentUser = null;
let isManager = false;
let esp32Connected = false;
let lastDataSignature = "";

function getToken() {
  return localStorage.getItem("token");
}

function loadUser() {
  try {
    currentUser = JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    currentUser = null;
  }

  isManager =
    currentUser &&
    (currentUser.role === "admin" || currentUser.role === "manager");

  if ($("loginLink")) $("loginLink").style.display = currentUser ? "none" : "inline-flex";
  if ($("registerLink")) $("registerLink").style.display = currentUser ? "none" : "inline-flex";
  if ($("logoutBtn")) $("logoutBtn").style.display = currentUser ? "inline-flex" : "none";

  updateControls();
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  window.location.href = "index.html";
}

function updateControls() {
  const enabled = !!(esp32Connected && isManager);

  document.querySelectorAll(".esp32-control").forEach(el => {
    el.disabled = !enabled;
    el.style.opacity = enabled ? "1" : "0.45";
    el.style.pointerEvents = enabled ? "auto" : "none";
    el.title = enabled ? "" : "Seul le manager peut manipuler le panneau";
  });

  const warning = $("esp32Warning");

  if (warning) {
    if (!currentUser) {
      warning.textContent =
        "Connectez-vous pour voir les données. La page d’accueil reste accessible.";
      warning.style.display = "block";
    } else if (!isManager) {
      warning.textContent =
        "Mode lecture seule : vous pouvez voir et télécharger les données, mais seul le manager peut contrôler le panneau.";
      warning.style.display = "block";
    } else if (!esp32Connected) {
      warning.textContent =
        "Carte ESP32 déconnectée : les commandes sont désactivées.";
      warning.style.display = "block";
    } else {
      warning.style.display = "none";
    }
  }
}

async function checkESP32() {
  try {
    const res = await fetch(`${API_URL}/api/esp32/status`);
    const data = await res.json();

    esp32Connected = data.connected === true;

    if ($("conn")) {
      if (!currentUser) {
        $("conn").textContent = "Connectez-vous pour voir les données";
      } else {
        $("conn").textContent = esp32Connected
          ? "ESP32 : Connectée"
          : "ESP32 : Déconnectée";
      }
    }

    if ($("esp32Status")) {
      $("esp32Status").textContent = esp32Connected ? "Connectée" : "Déconnectée";
      $("esp32Status").className = esp32Connected ? "connected" : "disconnected";
    }

    if ($("esp32LastSeen")) $("esp32LastSeen").textContent = data.lastSeen || "—";
    if ($("esp32Ip")) $("esp32Ip").textContent = data.ip || "—";

    updateControls();
  } catch (err) {
    esp32Connected = false;

    if ($("conn")) {
      $("conn").textContent = currentUser
        ? "ESP32 : Déconnectée"
        : "Connectez-vous pour voir les données";
    }

    if ($("esp32Status")) {
      $("esp32Status").textContent = "Déconnectée";
      $("esp32Status").className = "disconnected";
    }

    updateControls();
  }
}

async function sendCmd(o) {
  if (!isManager) {
    alert("Seul le manager peut contrôler le panneau.");
    return;
  }

  if (!esp32Connected) {
    alert("ESP32 déconnectée.");
    return;
  }

  const token = getToken();

  if (!token) {
    alert("Session expirée. Reconnectez-vous.");
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/esp32/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(o)
    });

    const result = await res.json().catch(() => ({}));

    if (!res.ok) {
      alert(result.error || "Erreur lors de l’envoi de la commande.");
    }
  } catch (err) {
    console.error(err);
    alert("Impossible d’envoyer la commande au serveur.");
  }
}

async function pollESP32Data() {
  if (!currentUser) return;

  const token = getToken();
  if (!token) return;

  try {
    const res = await fetch(`${API_URL}/api/esp32/data`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) return;

    const s = await res.json();

    if (!s || typeof s !== "object") return;

    const signature = JSON.stringify(s);
    if (signature === lastDataSignature) return;
    lastDataSignature = signature;

    if (s.info === "snapshot") {
      if ("servo1_deg" in s) setServoAngleUI(1, s.servo1_deg);
      if ("servo2_deg" in s) setServoAngleUI(2, s.servo2_deg);
      applyOrientationStatus(s);
      return;
    }

    if (s.info === "iv_summary") {
      applyIvSummary(s);
    } else {
      applySample(s);
    }
  } catch (err) {
    console.log(err);
  }
}

/* ------------------- Orientation solaire ------------------- */
let currentOrientMode = "manual";
let currentTracker = false;

function getSelectedOrientMode() {
  const el = document.querySelector('input[name="orientMode"]:checked');
  return el ? el.value : currentOrientMode || "manual";
}

function setOrientModeUI(mode) {
  if (!mode) return;
  currentOrientMode = String(mode);

  const radio = document.querySelector(`input[name="orientMode"][value="${currentOrientMode}"]`);
  if (radio) radio.checked = true;

  if ($("orientModeTxt")) $("orientModeTxt").textContent = currentOrientMode;
  if ($("orientModeBar")) $("orientModeBar").textContent = currentOrientMode;
}

function setTrackerUI(enabled) {
  currentTracker = !!enabled;
  if ($("trackerTxt")) $("trackerTxt").textContent = currentTracker ? "ON" : "OFF";
}

function setBoolTxt(id, v) {
  const el = $(id);
  if (!el) return;
  if (v === null || v === undefined) el.textContent = "—";
  else el.textContent = v ? "ON" : "OFF";
}

function applyOrientationStatus(s) {
  if (!s || typeof s !== "object") return;

  if ("orient_mode" in s) setOrientModeUI(s.orient_mode);
  if ("tracker" in s) setTrackerUI(!!s.tracker);

  if ("ldr_l" in s) setBoolTxt("ldrL", !!s.ldr_l);
  if ("ldr_r" in s) setBoolTxt("ldrR", !!s.ldr_r);
  if ("ldr_h" in s) setBoolTxt("ldrH", !!s.ldr_h);
  if ("ldr_b" in s) setBoolTxt("ldrB", !!s.ldr_b);

  if ("servo1_deg" in s && $("servo1Live")) $("servo1Live").textContent = `${Number(s.servo1_deg) | 0}°`;
  if ("servo2_deg" in s && $("servo2Live")) $("servo2Live").textContent = `${Number(s.servo2_deg) | 0}°`;
}

function sendOrientMode() {
  const mode = getSelectedOrientMode();
  setOrientModeUI(mode);
  sendCmd({ cmd: "orient", mode });
}

/* ------------------- Charts ------------------- */
let lineChart, uiChart, pChart, iChart, uChart;
let lastIsc = null, lastVoc = null;

const histLabels = [];
const histLux   = [];
const histTemp  = [];
const histHum   = [];
const histTc    = [];

let WIN_SIZE = 150;
let scrollPos = 0;
let autoFollow = true;
let VIEW_START = 0;

let scanCounter = 0;
let selectedScanId = null;
let currentScanSamples = [];
let wasScanning = false;
let lastIvPoints = null;
let lastIvMeta = null;
let ivHistory = [];

const C = {
  lux:  "#fbbf24",
  temp: "#fb7185",
  hum:  "#22d3ee",
  tc:   "#34d399",
  iu:   "#60a5fa",
  pu:   "#f59e0b",
  ik:   "#fb7185",
  uk:   "#22d3ee",
  mpp:  "#facc15",
  isc:  "#ef4444",
  voc:  "#22c55e",
  ref:  "rgba(226,232,240,.7)",
  vmpp: "#a78bfa",
  impp: "#93c5fd",
};

function iuPointsToK(pointsIU){
  const uK = [];
  const iK = [];
  for (let k = 0; k < pointsIU.length; k++){
    const p = pointsIU[k];
    uK.push({ x: k, y: p.x });
    iK.push({ x: k, y: p.y });
  }
  return { uK, iK };
}

function line2pts(n, y){
  const x1 = 0;
  const x2 = Math.max(1, n - 1);
  return [{x:x1, y:y}, {x:x2, y:y}];
}

function autoscaleIaxis(Isc){
  if (!uiChart) return;
  if (!Number.isFinite(Isc) || Isc <= 0) return;

  const pad = 1.20;
  let step = 0.02;
  let yMax = Isc * pad;

  if (Isc < 0.2) step = 0.01;
  if (Isc < 0.08) step = 0.005;

  yMax = Math.ceil(yMax / step) * step;

  uiChart.options.scales.yI.min = 0;
  uiChart.options.scales.yI.max = yMax;
  uiChart.options.scales.yI.ticks.stepSize = step;
}

function initCharts() {
  const commonXY = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { labels: { color: "#e5edff" } },
      tooltip: { enabled: true }
    },
    scales: {
      x: { ticks: { color: "#d0dcff" }, grid: { color: "rgba(140,170,255,.25)" } },
      y: { ticks: { color: "#d0dcff" }, grid: { color: "rgba(140,170,255,.25)" } }
    }
  };

  lineChart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Lux",           data: [], tension: .25, pointRadius: 0, borderColor: C.lux },
        { label: "Temp DHT (°C)", data: [], tension: .25, pointRadius: 0, borderColor: C.temp },
        { label: "Humidité (%)",  data: [], tension: .25, pointRadius: 0, borderColor: C.hum },
        { label: "TC (°C)",       data: [], tension: .25, pointRadius: 0, borderColor: C.tc },
      ]
    },
    options: {
      ...commonXY,
      plugins: {
        ...commonXY.plugins,
        tooltip: {
          enabled: true,
          callbacks: {
            label: (ctx) => {
              const name = ctx.dataset.label;
              const idx  = VIEW_START + ctx.dataIndex;
              if (name.startsWith("Lux")) {
                const real = histLux[idx];
                if (real == null) return "Lux: —";
                return `Lux: ${fmt(real, 0)} lx (affiché: ${fmt(real / LUX_SCALE, 1)})`;
              }
              if (name.startsWith("Temp")) {
                const v = histTemp[idx];
                return v == null ? "Temp DHT (°C): —" : `Temp DHT (°C): ${fmt(v, 2)} °C`;
              }
              if (name.startsWith("Hum")) {
                const v = histHum[idx];
                return v == null ? "Humidité (%): —" : `Humidité (%): ${fmt(v, 0)} %`;
              }
              if (name.startsWith("TC")) {
                const v = histTc[idx];
                return v == null ? "TC (°C): —" : `TC (°C): ${fmt(v, 2)} °C`;
              }
              return `${name}: ${fmt(ctx.parsed.y, 2)}`;
            }
          }
        }
      }
    }
  });

  uiChart = new Chart($("uiChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "I(U)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: .25, yAxisID: "yI", borderColor: C.iu },
        { label: "Vmpp", data: [], borderDash: [6,6], pointRadius: 0, showLine: true, yAxisID: "yI", borderColor: C.vmpp },
        { label: "Impp", data: [], borderDash: [6,6], pointRadius: 0, showLine: true, yAxisID: "yI", borderColor: C.impp },
        { label: "MPP",  data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.mpp, pointBorderColor: C.mpp },
        { label: "Isc",  data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.isc, pointBorderColor: C.isc },
        { label: "Voc",  data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.voc, pointBorderColor: C.voc },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { labels: { color: "#e5edff" } } },
      scales: {
        x:  { title: { display: true, text: "Tension U (V)", color: "#e5edff" }, ticks: { color: "#d0dcff", stepSize: 1 }, grid: { color: "rgba(140,170,255,.25)" }, min: 0, max: 40 },
        yI: { min: 0, max: 3, title: { display: true, text: "Intensité I (A)", color: "#e5edff" }, ticks: { color: "#d0dcff", stepSize: 0.1 }, grid: { color: "rgba(140,170,255,.25)" } }
      }
    }
  });

  pChart = new Chart($("pChart"), {
    type: "scatter",
    data: { datasets: [{ label: "P(U)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: .25, yAxisID: "yP", borderColor: C.pu }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { labels: { color: "#e5edff" } } },
      scales: {
        x:  { title: { display: true, text: "Tension U (V)", color: "#e5edff" }, ticks: { color: "#d0dcff", stepSize: 1 }, grid: { color: "rgba(140,170,255,.25)" }, min: 0, max: 40 },
        yP: { min: 0, title: { display: true, text: "Puissance P (W)", color: "#e5edff" }, ticks: { color: "#d0dcff" }, grid: { color: "rgba(140,170,255,.25)" } }
      }
    }
  });

  iChart = new Chart($("iChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "I(k)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: .25, borderColor: C.ik },
        { label: "I = 0", data: [], borderDash: [6,6], pointRadius: 0, showLine: true, borderColor: C.ref },
        { label: "Isc",   data: [], borderDash: [4,4], pointRadius: 0, showLine: true, borderColor: C.isc },
        { label: "Iref",  data: [], borderDash: [4,4], pointRadius: 0, showLine: true, borderColor: C.vmpp },
      ]
    },
    options: {
      ...commonXY,
      scales: {
        x: { ...commonXY.scales.x, title: { display:true, text:"k (index du point IU)", color:"#e5edff" } },
        y: { ...commonXY.scales.y, title: { display:true, text:"I (A)", color:"#e5edff" }, min: 0 }
      }
    }
  });

  uChart = new Chart($("uChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "U(k)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: .25, borderColor: C.uk },
        { label: "U = 0", data: [], borderDash: [6,6], pointRadius: 0, showLine: true, borderColor: C.ref },
        { label: "Voc",   data: [], borderDash: [4,4], pointRadius: 0, showLine: true, borderColor: C.voc },
        { label: "Uref",  data: [], borderDash: [4,4], pointRadius: 0, showLine: true, borderColor: C.vmpp },
      ]
    },
    options: {
      ...commonXY,
      scales: {
        x: { ...commonXY.scales.x, title: { display:true, text:"k (index du point IU)", color:"#e5edff" } },
        y: { ...commonXY.scales.y, title: { display:true, text:"U (V)", color:"#e5edff" }, min: 0 }
      }
    }
  });
}

/* ----------- Repères I(k)/U(k) ----------- */
function updateRefs() {
  const chkI0   = $("chkI0")?.checked;
  const chkU0   = $("chkU0")?.checked;
  const chkIsc  = $("chkIsc")?.checked;
  const chkVoc  = $("chkVoc")?.checked;
  const chkUref = $("chkUref")?.checked;
  const chkIref = $("chkIref")?.checked;

  const Uref = Number($("uRefVal")?.value);
  const Iref = Number($("iRefVal")?.value);
  const n = iChart?.data?.datasets?.[0]?.data?.length ?? 0;

  iChart.data.datasets[1].data = chkI0 ? line2pts(n, 0) : [];
  iChart.data.datasets[2].data = (chkIsc && Number.isFinite(lastIsc)) ? line2pts(n, lastIsc) : [];
  iChart.data.datasets[3].data = (chkIref && Number.isFinite(Iref)) ? line2pts(n, Iref) : [];

  uChart.data.datasets[1].data = chkU0 ? line2pts(n, 0) : [];
  uChart.data.datasets[2].data = (chkVoc && Number.isFinite(lastVoc)) ? line2pts(n, lastVoc) : [];
  uChart.data.datasets[3].data = (chkUref && Number.isFinite(Uref)) ? line2pts(n, Uref) : [];

  iChart.update("none");
  uChart.update("none");
}

function wireRefInputs(){
  ["chkI0","chkU0","chkIsc","chkVoc","chkUref","chkIref","uRefVal","iRefVal"].forEach(id=>{
    const el = $(id);
    if (el) {
      el.addEventListener("input", updateRefs);
      el.addEventListener("change", updateRefs);
    }
  });
}

function refreshLineViewport() {
  const L = histLabels.length;
  const maxStart = Math.max(0, L - WIN_SIZE);

  if (autoFollow) scrollPos = maxStart;
  scrollPos = Math.min(Math.max(0, scrollPos), maxStart);

  const slider = $("chartScroll");
  if (slider) {
    slider.max = String(maxStart);
    slider.value = String(scrollPos);
  }

  const start = scrollPos;
  const end = Math.min(L, start + WIN_SIZE);
  VIEW_START = start;

  const DS = lineChart.data.datasets;

  lineChart.data.labels = histLabels.slice(start, end);
  DS[0].data = histLux.slice(start, end).map(v => v == null ? null : v / LUX_SCALE);
  DS[1].data = histTemp.slice(start, end);
  DS[2].data = histHum.slice(start, end);
  DS[3].data = histTc.slice(start, end);

  lineChart.update("none");
}

function avg(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a,b)=>a+b,0) / v.length;
}

function stats(arr) {
  const v = arr.filter(x => Number.isFinite(x));
  if (!v.length) return { min:null, avg:null, max:null };

  let min = v[0];
  let max = v[0];
  let sum = 0;

  for (const x of v) {
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
  }

  return {
    min,
    avg: sum / v.length,
    max
  };
}

function fmtMinAvgMax(s, nd = 1, unit = "") {
  if (
    !Number.isFinite(s.min) ||
    !Number.isFinite(s.avg) ||
    !Number.isFinite(s.max)
  ) {
    return "—";
  }

  const u = unit ? ` ${unit}` : "";

  return `${fmt(s.min, nd)} / ${fmt(s.avg, nd)} / ${fmt(s.max, nd)}${u}`;
}

function updateHistoryDetails(entry) {
  if (!entry) {
    [
      "histSelId",
      "histSelTs",
      "histSelPts",
      "histSelDur",
      "histLux",
      "histTemp",
      "histHum",
      "histTc"
    ].forEach(id => {
      if ($(id)) $(id).textContent = "—";
    });

    return;
  }

  if ($("histSelId")) $("histSelId").textContent = String(entry.id);
  if ($("histSelTs")) $("histSelTs").textContent = new Date(entry.ts).toLocaleString();
  if ($("histSelPts")) $("histSelPts").textContent = String(entry.points?.length ?? 0);

  let dur = null;

  if (entry.samples?.length) {
    const t0 = entry.samples[0]?.ts_ms;
    const t1 = entry.samples.at(-1)?.ts_ms;

    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
      dur = t1 - t0;
    }
  }

  if ($("histSelDur")) $("histSelDur").textContent = dur == null ? "—" : `${dur} ms`;

  const s = entry.samples || [];

  if ($("histLux")) {
    $("histLux").textContent =
      fmtMinAvgMax(stats(s.map(r => r.lux)), 0, "lx");
  }

  if ($("histTemp")) {
    $("histTemp").textContent =
      fmtMinAvgMax(stats(s.map(r => r.temp_dht_c)), 1, "°C");
  }

  if ($("histHum")) {
    $("histHum").textContent =
      fmtMinAvgMax(stats(s.map(r => r.hum_dht)), 0, "%");
  }

  if ($("histTc")) {
    $("histTc").textContent =
      fmtMinAvgMax(stats(s.map(r => r.tc_c)), 1, "°C");
  }
}

function renderHistoryList() {
  const root = $("historyList");
  if (!root) return;

  root.innerHTML = "";

  if (!ivHistory.length) {
    root.innerHTML = `<div class="badge">Aucun scan enregistré.</div>`;
    updateHistoryDetails(null);
    return;
  }

  const items = [...ivHistory].reverse();

  for (const entry of items) {
    const dt = new Date(entry.ts);

    const lux = entry.env?.luxAvg;
    const temp = entry.env?.tempAvg;
    const hum = entry.env?.humAvg;

    const mode = entry.meta?.orient_mode || "—";

    const sx = Number.isFinite(entry.meta?.servo1_deg)
      ? `${entry.meta.servo1_deg | 0}°`
      : "—";

    const sy = Number.isFinite(entry.meta?.servo2_deg)
      ? `${entry.meta.servo2_deg | 0}°`
      : "—";

    const row = document.createElement("div");

    row.className = "badge histItem";
    row.dataset.id = String(entry.id);
    row.style.cursor = "pointer";
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.gap = "12px";
    row.style.alignItems = "center";

    if (selectedScanId === entry.id) {
      row.classList.add("selected");
    }

    const sub = [
      `Mode=${mode}`,
      `RX=${sx}`,
      `RY=${sy}`,
      Number.isFinite(lux) ? `Lux≈${fmt(lux, 0)} lx` : `Lux—`,
      Number.isFinite(temp) ? `T≈${fmt(temp, 1)} °C` : `T—`,
      Number.isFinite(hum) ? `H≈${fmt(hum, 0)} %` : `H—`,
      `Points=${entry.points.length}`
    ].join(" • ");

    row.innerHTML = `
      <div style="min-width:240px">
        <div><b>Scan #${entry.id} — ${dt.toLocaleString()}</b></div>
        <div style="opacity:.85">${sub}</div>
      </div>

      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <button class="pill info" data-action="show">Afficher</button>
        <button class="pill info" data-action="export">Export</button>
        <button class="pill off-btn" data-action="del">Suppr</button>
      </div>
    `;

    row.querySelector('[data-action="show"]').addEventListener("click", (e) => {
      e.stopPropagation();
      showHistoryEntry(entry.id);
    });

    row.querySelector('[data-action="export"]').addEventListener("click", (e) => {
      e.stopPropagation();
      downloadScanMeasuresCsv(entry.id);
    });

    row.querySelector('[data-action="del"]').addEventListener("click", (e) => {
      e.stopPropagation();
      deleteScan(entry.id);
    });

    row.addEventListener("click", () => {
      showHistoryEntry(entry.id);
    });

    root.appendChild(row);
  }

  if (selectedScanId == null && ivHistory.length) {
    showHistoryEntry(ivHistory.at(-1).id);
  } else {
    updateHistoryDetails(
      ivHistory.find(x => x.id === selectedScanId) || null
    );
  }
}

function updateHistorySelectionUI() {
  document.querySelectorAll(".histItem").forEach(el => {
    el.classList.toggle(
      "selected",
      Number(el.dataset.id) === selectedScanId
    );
  });
}

function showHistoryEntry(id) {
  const entry = ivHistory.find(x => x.id === id);
  if (!entry) return;

  selectedScanId = id;

  uiChart.data.datasets[0].data = entry.points;
  pChart.data.datasets[0].data =
    entry.points.map(p => ({ x: p.x, y: p.x * p.y }));


  const maxU = Math.max(...points.map(p => p.x));
  const maxI = Math.max(...points.map(p => p.y));
  const maxP = Math.max(...points.map(p => p.x * p.y));

  const xMaxAuto = Number.isFinite(maxU) && maxU > 0
    ? maxU * 1.15
    : 1;

  const yMaxAuto = Number.isFinite(maxI) && maxI > 0
    ? maxI * 1.20
    : 1;

  const pMaxAuto = Number.isFinite(maxP) && maxP > 0
    ? maxP * 1.25
    : 1;

  uiChart.options.scales.x.min = 0;
  uiChart.options.scales.x.max = xMaxAuto;
  uiChart.options.scales.yI.min = 0;
  uiChart.options.scales.yI.max = yMaxAuto;

  pChart.options.scales.x.min = 0;
  pChart.options.scales.x.max = xMaxAuto;
  pChart.options.scales.yP.min = 0;
  pChart.options.scales.yP.max = pMaxAuto;

  const umax = Number(entry.meta?.umax);

  let xMax = Number.isFinite(umax)
    ? umax * 1.08
    : (entry.points.at(-1)?.x || 40);

  xMax = Math.max(
    UI_VOLT_MIN_HARD,
    Math.min(UI_VOLT_MAX_HARD, xMax)
  );

  const stepX = xMax <= 10 ? 0.5 : 1;

  uiChart.options.scales.x.min = 0;
  uiChart.options.scales.x.max = Math.ceil(xMax / stepX) * stepX;
  uiChart.options.scales.x.ticks.stepSize = stepX;

  pChart.options.scales.x.min = 0;
  pChart.options.scales.x.max = uiChart.options.scales.x.max;
  pChart.options.scales.x.ticks.stepSize = stepX;

  const { uK, iK } = iuPointsToK(entry.points);

  iChart.data.datasets[0].data = iK;
  uChart.data.datasets[0].data = uK;

  iChart.options.scales.x.max = Math.max(1, entry.points.length - 1);
  uChart.options.scales.x.max = Math.max(1, entry.points.length - 1);

  if ($("stepCount")) $("stepCount").textContent = String(entry.points.length);

  const m = entry.meta || {};

  lastIvMeta = { ...m };
  lastIvPoints = entry.points.slice();

  lastIsc = Number.isFinite(m.isc) ? m.isc : lastIsc;
  lastVoc = Number.isFinite(m.voc) ? m.voc : lastVoc;

  autoscaleIaxis(lastIsc);

  if ($("uiCount")) $("uiCount").textContent = String(entry.points.length);
  if ($("vmpp")) $("vmpp").textContent = Number.isFinite(m.vmpp) ? fmt(m.vmpp, 2) : "—";
  if ($("impp")) $("impp").textContent = Number.isFinite(m.impp) ? fmt(m.impp, 3) : "—";
  if ($("pmpp")) $("pmpp").textContent = Number.isFinite(m.pmpp) ? fmt(m.pmpp, 2) : "—";
  if ($("iscVal")) $("iscVal").textContent = Number.isFinite(m.isc) ? fmt(m.isc, 3) : "—";
  if ($("vocVal")) $("vocVal").textContent = Number.isFinite(m.voc) ? fmt(m.voc, 2) : "—";

  uiChart.update("none");
  pChart.update("none");

  updateRefs();

  iChart.update("none");
  uChart.update("none");

  updateHistoryDetails(entry);
  updateHistorySelectionUI();
}

function deleteScan(id) {
  const idx = ivHistory.findIndex(x => x.id === id);
  if (idx < 0) return;

  ivHistory.splice(idx, 1);

  if (selectedScanId === id) {
    selectedScanId = ivHistory.length
      ? ivHistory.at(-1).id
      : null;
  }

  renderHistoryList();
}

function downloadScanMeasuresCsv(id) {
  const entry = ivHistory.find(x => x.id === id);
  if (!entry) return;

  let csv =
    "k;seq;ts_ms;line;u_v;i_a;lux;temp_dht_c;hum_dht;tc_c;servo1_deg;servo2_deg;orient_mode\n";

  for (const r of entry.samples || []) {
    csv += [
      r.k,
      r.seq,
      r.ts_ms,
      r.line,
      r.u_v,
      r.i_a,
      r.lux,
      r.temp_dht_c,
      r.hum_dht,
      r.tc_c,
      r.servo1_deg,
      r.servo2_deg,
      r.orient_mode
    ].join(";") + "\n";
  }

  const blob = new Blob(
    [csv],
    { type: "text/csv;charset=utf-8" }
  );

  const a = document.createElement("a");

  a.href = URL.createObjectURL(blob);
  a.download = `scan_${id}.csv`;
  a.click();

  URL.revokeObjectURL(a.href);
}

function downloadAllMeasuresCsv() {
  let csv =
    "scan;k;seq;ts_ms;line;u_v;i_a;lux;temp_dht_c;hum_dht;tc_c;servo1_deg;servo2_deg;orient_mode\n";

  for (const scan of ivHistory) {
    for (const r of scan.samples || []) {
      csv += [
        scan.id,
        r.k,
        r.seq,
        r.ts_ms,
        r.line,
        r.u_v,
        r.i_a,
        r.lux,
        r.temp_dht_c,
        r.hum_dht,
        r.tc_c,
        r.servo1_deg,
        r.servo2_deg,
        r.orient_mode
      ].join(";") + "\n";
    }
  }

  const blob = new Blob(
    [csv],
    { type: "text/csv;charset=utf-8" }
  );

  const a = document.createElement("a");

  a.href = URL.createObjectURL(blob);
  a.download = "solar_monitor_toutes_mesures.csv";
  a.click();

  URL.revokeObjectURL(a.href);
}

/* ------------------- Temps réel ------------------- */

function applySample(s) {

  applyOrientationStatus(s);

  /* ===== Mise à jour affichage instantané ===== */

  if ("lux" in s && $("liveLux")) {
    $("liveLux").textContent = fmt(s.lux, 0) + " lx";
  }

  if ("temp_dht_c" in s && $("liveTemp")) {
    $("liveTemp").textContent = fmt(s.temp_dht_c, 1) + " °C";
  }

  if ("hum_dht" in s && $("liveHumidity")) {
    $("liveHumidity").textContent = fmt(s.hum_dht, 0) + " %";
  }

  if ("tc_c" in s && $("liveTc")) {
    $("liveTc").textContent = fmt(s.tc_c, 1) + " °C";
  }

  if ("servo1_deg" in s) {
    setServoAngleUI(1, s.servo1_deg);
  }

  if ("servo2_deg" in s) {
    setServoAngleUI(2, s.servo2_deg);
  }

  if ("seq" in s && $("seq"))
    $("seq").textContent = s.seq;

  if ("ts_ms" in s && $("ts"))
    $("ts").textContent = s.ts_ms;

  if ("phase" in s && $("phase"))
    $("phase").textContent = s.phase;

  if ("line" in s && $("line"))
    $("line").textContent = s.line;

  if ("state" in s && $("state"))
    $("state").textContent =
      "state=" + (s.state ? "true" : "false");

  const inScan =
    !!s.state &&
    s.phase === "scan";

  const isRising =
    (!wasScanning && inScan) ||
    (inScan && s.seq === 0);

  if (isRising) {
    currentScanSamples = [];

    if ($("stepCount"))
      $("stepCount").textContent = "0";
  }

  /* ===== Historique capteurs même hors scan ===== */

  if ("seq" in s) {

    histLabels.push(s.seq);

    histLux.push(
      s.lux == null
        ? null
        : Number(s.lux)
    );

    histTemp.push(
      s.temp_dht_c == null
        ? null
        : Number(s.temp_dht_c)
    );

    histHum.push(
      s.hum_dht == null
        ? null
        : Number(s.hum_dht)
    );

    histTc.push(
      s.tc_c == null
        ? null
        : Number(s.tc_c)
    );

    const HARD_MAX = 20000;

    if (histLabels.length > HARD_MAX) {

      histLabels.shift();
      histLux.shift();
      histTemp.shift();
      histHum.shift();
      histTc.shift();

      scrollPos =
        Math.max(
          0,
          scrollPos - 1
        );
    }

    refreshLineViewport();
  }

  if (inScan) {

    const U =
      Number(s.u_v);

    const I =
      Number(s.i_a);

    if (
      Number.isFinite(U) &&
      Number.isFinite(I)
    ) {

      if ($("uEff"))
        $("uEff").textContent =
          fmt(U, 2);

      if ($("iEff"))
        $("iEff").textContent =
          fmt(I, 3);

      currentScanSamples.push({
        k: currentScanSamples.length,

        seq:
          "seq" in s
            ? Number(s.seq)
            : null,

        ts_ms:
          "ts_ms" in s
            ? Number(s.ts_ms)
            : null,

        line:
          "line" in s
            ? Number(s.line)
            : null,

        u_v: U,
        i_a: I,

        lux:
          s.lux == null
            ? null
            : Number(s.lux),

        temp_dht_c:
          s.temp_dht_c == null
            ? null
            : Number(s.temp_dht_c),

        hum_dht:
          s.hum_dht == null
            ? null
            : Number(s.hum_dht),

        tc_c:
          s.tc_c == null
            ? null
            : Number(s.tc_c),

        servo1_deg:
          "servo1_deg" in s
            ? Number(s.servo1_deg)
            : null,

        servo2_deg:
          "servo2_deg" in s
            ? Number(s.servo2_deg)
            : null,

        orient_mode:
          s.orient_mode ??
          currentOrientMode
      });

      if ($("stepCount")) {
        $("stepCount").textContent =
          String(
            currentScanSamples.length
          );
      }
    }
  }

  wasScanning = inScan;
}

function applyIvSummary(s) {

  applyOrientationStatus(s);

  const U =
    Array.isArray(s.u)
      ? s.u
      : [];

  const I =
    Array.isArray(s.i)
      ? s.i
      : [];

  const N =
    Math.min(
      U.length,
      I.length
    );

  if (!N) return;

  const points = [];

  for (let k = 0; k < N; k++) {

    const u =
      Number(U[k]);

    const i =
      Number(I[k]);

    if (
      Number.isFinite(u) &&
      Number.isFinite(i) &&
      u >= 0 &&
      i >= 0
    ) {
      points.push({
        x: u,
        y: i
      });
    }
  }

  points.sort(
    (a, b) =>
      a.x - b.x
  );

  const meta = {

    vmpp:
      Number(s.vmpp),

    impp:
      Number(s.impp),

    pmpp:
      Number(s.pmpp),

    isc:
      Number(s.isc_a),

    voc:
      Number(s.voc_v),

    umax:
      Number(s.umax),

    servo1_deg:
      Number(s.servo1_deg),

    servo2_deg:
      Number(s.servo2_deg),

    orient_mode:
      s.orient_mode ??
      currentOrientMode,

    series:
      Number(s.series)
  };

  lastIvMeta =
    { ...meta };

  lastIvPoints =
    points.slice();

  lastIsc =
    Number.isFinite(meta.isc)
      ? meta.isc
      : lastIsc;

  lastVoc =
    Number.isFinite(meta.voc)
      ? meta.voc
      : lastVoc;

  autoscaleIaxis(
    lastIsc
  );

  uiChart.data.datasets[0].data =
    points;

  pChart.data.datasets[0].data =
    points.map(p => ({
      x: p.x,
      y: p.x * p.y
    }));

  /* ===========================
     REPERES Vmpp / Impp / MPP
     =========================== */

  uiChart.data.datasets[1].data =
    (
      Number.isFinite(meta.vmpp) &&
      Number.isFinite(meta.impp)
    )
      ? [
          {
            x: meta.vmpp,
            y: 0
          },
          {
            x: meta.vmpp,
            y: meta.impp
          }
        ]
      : [];

  uiChart.data.datasets[2].data =
    (
      Number.isFinite(meta.vmpp) &&
      Number.isFinite(meta.impp)
    )
      ? [
          {
            x: 0,
            y: meta.impp
          },
          {
            x: meta.vmpp,
            y: meta.impp
          }
        ]
      : [];

  uiChart.data.datasets[3].data =
    (
      Number.isFinite(meta.vmpp) &&
      Number.isFinite(meta.impp)
    )
      ? [
          {
            x: meta.vmpp,
            y: meta.impp
          }
        ]
      : [];

  uiChart.data.datasets[4].data =
    Number.isFinite(meta.isc)
      ? [
          {
            x: 0,
            y: meta.isc
          }
        ]
      : [];

  uiChart.data.datasets[5].data =
    Number.isFinite(meta.voc)
      ? [
          {
            x: meta.voc,
            y: 0
          }
        ]
      : [];

  if ($("uiCount"))
    $("uiCount").textContent =
      String(points.length);

  if ($("vmpp"))
    $("vmpp").textContent =
      Number.isFinite(meta.vmpp)
        ? fmt(meta.vmpp, 2)
        : "—";

  if ($("impp"))
    $("impp").textContent =
      Number.isFinite(meta.impp)
        ? fmt(meta.impp, 3)
        : "—";

  if ($("pmpp"))
    $("pmpp").textContent =
      Number.isFinite(meta.pmpp)
        ? fmt(meta.pmpp, 2)
        : "—";

  if ($("iscVal"))
    $("iscVal").textContent =
      Number.isFinite(meta.isc)
        ? fmt(meta.isc, 3)
        : "—";

  if ($("vocVal"))
    $("vocVal").textContent =
      Number.isFinite(meta.voc)
        ? fmt(meta.voc, 2)
        : "—";

  const { uK, iK } =
    iuPointsToK(points);

  iChart.data.datasets[0].data =
    iK;

  uChart.data.datasets[0].data =
    uK;

  iChart.options.scales.x.max =
    Math.max(
      1,
      points.length - 1
    );

  uChart.options.scales.x.max =
    Math.max(
      1,
      points.length - 1
    );

  if ($("stepCount"))
    $("stepCount").textContent =
      String(points.length);

  uiChart.update("none");
  pChart.update("none");

  updateRefs();

  iChart.update("none");
  uChart.update("none");

  scanCounter++;

  const entry = {
    id: scanCounter,
    ts: Date.now(),
    points: points.slice(),
    samples: currentScanSamples.slice(),
    meta: { ...meta },
    env: {
      luxAvg:
        avg(
          currentScanSamples.map(
            x => x.lux
          )
        ),
      tempAvg:
        avg(
          currentScanSamples.map(
            x => x.temp_dht_c
          )
        ),
      humAvg:
        avg(
          currentScanSamples.map(
            x => x.hum_dht
          )
        ),
      tcAvg:
        avg(
          currentScanSamples.map(
            x => x.tc_c
          )
        )
    }
  };

  ivHistory.push(entry);

  selectedScanId =
    entry.id;

  renderHistoryList();
}


/* ------------------------- UI / boutons ------------------------- */

function paintRange(el){
  if(!el) return;

  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const val = (Number(el.value) - min) / (max - min) * 100;

  el.style.background =
    `linear-gradient(90deg,#22c55e ${val}%, #264a8a ${val}%)`;
}

function setServoAngleUI(idx, angle) {
  const a = Math.max(0, Math.min(180, Number(angle) || 0));

  if (idx === 1) {
    setServo($("needle1"), $("servoTxt1"), a);

    if ($("servo1Val"))
      $("servo1Val").textContent = `${a | 0}°`;

    if ($("servo1Live"))
      $("servo1Live").textContent = `${a | 0}°`;

  } else {
    setServo($("needle2"), $("servoTxt2"), a);

    if ($("servo2Val"))
      $("servo2Val").textContent = `${a | 0}°`;

    if ($("servo2Live"))
      $("servo2Live").textContent = `${a | 0}°`;
  }

  setGaugeFill(idx, a);

  const rangeEl =
    $(idx === 1 ? "servo1Range" : "servo2Range");

  if (rangeEl) {
    rangeEl.value = String(a);
    paintRange(rangeEl);
  }
}

function setServo(needle, label, deg){
  const a =
    Math.max(
      0,
      Math.min(180, Number(deg) || 0)
    );

  if (needle)
    needle.style.transform =
      `rotate(${a - 90}deg)`;

  if (label)
    label.textContent =
      `${a | 0}°`;
}

function setGaugeFill(idx, angle){
  const el =
    document.querySelector(
      idx === 1
        ? ".gauges .servo:nth-child(1)"
        : ".gauges .servo:nth-child(2)"
    );

  if(!el) return;

  const a =
    Math.max(
      0,
      Math.min(180, Number(angle) || 0)
    );

  const fill =
    el.querySelector(".gauge .gFill");

  if(fill)
    fill.style.setProperty("--angle", a);
}

function setServoActive(idx, active){
  const servoEl =
    document.querySelector(
      idx === 1
        ? ".gauges .servo:nth-child(1)"
        : ".gauges .servo:nth-child(2)"
    );

  const rangeEl =
    $(idx === 1 ? "servo1Range" : "servo2Range");

  if(servoEl)
    servoEl.classList.toggle("active", !!active);

  if(rangeEl)
    rangeEl.classList.toggle("moving", !!active);
}

function setServoAngle(idx, angle) {
  const a =
    Math.max(
      0,
      Math.min(180, Number(angle) || 0)
    );

  setServoAngleUI(idx, a);

  sendCmd({
    cmd: "servo",
    index: idx,
    angle: a
  });
}

function clearDisplay() {
  histLabels.length = 0;
  histLux.length = 0;
  histTemp.length = 0;
  histHum.length = 0;
  histTc.length = 0;

  refreshLineViewport();

  uiChart.data.datasets.forEach(ds => ds.data = []);
  pChart.data.datasets.forEach(ds => ds.data = []);
  iChart.data.datasets.forEach(ds => ds.data = []);
  uChart.data.datasets.forEach(ds => ds.data = []);

  uiChart.update("none");
  pChart.update("none");
  iChart.update("none");
  uChart.update("none");

  [
    "uEff",
    "iEff",
    "uiCount",
    "stepCount",
    "vmpp",
    "impp",
    "pmpp",
    "iscVal",
    "vocVal"
  ].forEach(id => {
    if ($(id)) $(id).textContent = "—";
  });

  updateHistoryDetails(null);
  selectedScanId = null;
  updateHistorySelectionUI();
}

function wireButtons() {

  $("btnStart")?.addEventListener("click", () => {
    const mode = getSelectedOrientMode();

    setOrientModeUI(mode);

    sendCmd({
      cmd: "start",
      orient: mode
    });
  });

  $("btnStop")?.addEventListener("click", () => {
    sendCmd({
      cmd: "stop"
    });
  });

  $("btnScanFull")?.addEventListener("click", () => {
    const mode = getSelectedOrientMode();

    setOrientModeUI(mode);

    sendCmd({
      cmd: "scan",
      type: "full",
      orient: mode
    });
  });

  $("btnApplyOrient")?.addEventListener(
    "click",
    sendOrientMode
  );

  document
    .querySelectorAll('input[name="orientMode"]')
    .forEach(el => {
      el.addEventListener("change", () => {
        setOrientModeUI(
          getSelectedOrientMode()
        );
      });
    });

  $("btnTrackerOn")?.addEventListener("click", () => {
    setTrackerUI(true);

    sendCmd({
      cmd: "tracker",
      enabled: true
    });
  });

  $("btnTrackerOff")?.addEventListener("click", () => {
    setTrackerUI(false);

    sendCmd({
      cmd: "tracker",
      enabled: false
    });
  });

  $("btnStatus")?.addEventListener("click", () => {
    checkESP32();
    pollESP32Data();

    sendCmd({
      cmd: "status"
    });
  });

  $("btnSetPeriod")?.addEventListener("click", () => {
    const v =
      Number(
        ($("periodMs")?.value || "").trim()
      );

    if (
      !Number.isFinite(v) ||
      v < 0
    ) {
      alert(
        "Entrez un intervalle valide (ms >= 0)."
      );
      return;
    }

    sendCmd({
      cmd: "schedule",
      period_ms: v
    });
  });

  $("btnDownloadAllMeasures")?.addEventListener(
    "click",
    () => downloadAllMeasuresCsv()
  );

  $("btnClearHistory")?.addEventListener("click", () => {
    ivHistory = [];
    scanCounter = 0;
    selectedScanId = null;
    renderHistoryList();
  });

  $("btnExportSelectedScan")?.addEventListener("click", () => {
    if (selectedScanId == null) {
      alert("Aucun scan sélectionné.");
      return;
    }

    downloadScanMeasuresCsv(selectedScanId);
  });

  $("btnDeleteSelectedScan")?.addEventListener("click", () => {
    if (selectedScanId == null) {
      alert("Aucun scan sélectionné.");
      return;
    }

    deleteScan(selectedScanId);
  });

  $("btnToggleHistory")?.addEventListener("click", () => {
    const card = $("historyCard");

    if (!card) return;

    const hidden =
      card.classList.toggle("is-hidden");

    if ($("btnToggleHistory")) {
      $("btnToggleHistory").textContent =
        hidden
          ? "Afficher historique"
          : "Masquer historique";
    }
  });

  $("btnClearDisplay")?.addEventListener(
    "click",
    () => clearDisplay()
  );

  $("winSize")?.addEventListener("change", () => {
    const v =
      Number($("winSize").value);

    if (
      Number.isFinite(v) &&
      v >= 20
    ) {
      WIN_SIZE =
        Math.min(
          1000,
          Math.max(20, v)
        );

      refreshLineViewport();
    }
  });

  $("chartScroll")?.addEventListener("input", () => {
    scrollPos =
      Number($("chartScroll").value) || 0;

    autoFollow = false;

    if ($("autoFollow"))
      $("autoFollow").checked = false;

    refreshLineViewport();
  });

  $("autoFollow")?.addEventListener("change", () => {
    autoFollow =
      !!$("autoFollow").checked;

    refreshLineViewport();
  });

  const s1 = $("servo1Range");
  const s2 = $("servo2Range");

  if (s1) {
    paintRange(s1);

    s1.addEventListener(
      "input",
      e => setServoAngle(1, e.target.value)
    );

    ["mousedown", "touchstart"].forEach(ev =>
      s1.addEventListener(ev, () => setServoActive(1, true))
    );

    ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(ev =>
      s1.addEventListener(ev, () => setServoActive(1, false))
    );
  }

  if (s2) {
    paintRange(s2);

    s2.addEventListener(
      "input",
      e => setServoAngle(2, e.target.value)
    );

    ["mousedown", "touchstart"].forEach(ev =>
      s2.addEventListener(ev, () => setServoActive(2, true))
    );

    ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(ev =>
      s2.addEventListener(ev, () => setServoActive(2, false))
    );
  }

  $("btnManualConnect")?.addEventListener("click", () => {
    checkESP32();
    pollESP32Data();
  });

  $("logoutBtn")?.addEventListener(
    "click",
    logout
  );
}

function enableRipple(){
  document.querySelectorAll("button.pill").forEach(btn => {
    btn.addEventListener("click", e => {
      const circle =
        document.createElement("span");

      circle.classList.add("ripple");

      const rect =
        btn.getBoundingClientRect();

      const size =
        Math.max(
          rect.width,
          rect.height
        );

      circle.style.width =
        circle.style.height =
          `${size}px`;

      circle.style.left =
        `${e.clientX - rect.left - size / 2}px`;

      circle.style.top =
        `${e.clientY - rect.top - size / 2}px`;

      btn.appendChild(circle);

      setTimeout(
        () => circle.remove(),
        600
      );
    });
  });
}

/* ------------------------- Boot --------------------------- */

window.addEventListener("DOMContentLoaded", () => {

  loadUser();

  initCharts();

  setOrientModeUI("manual");
  setTrackerUI(false);

  wireRefInputs();
  wireButtons();
  renderHistoryList();
  enableRipple();

  const card = $("historyCard");

  if (card)
    card.classList.add("is-hidden");

  checkESP32();
  pollESP32Data();

  setInterval(
    checkESP32,
    5000
  );

  setInterval(
    pollESP32Data,
    500
  );

});
