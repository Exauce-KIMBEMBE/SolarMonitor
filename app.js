/* =========================================================
   SolarMonitor Dashboard
   Ancien fonctionnement conservé
   Communication maintenant via Render -> ESP32 -> Serial2 -> Mega
========================================================= */

const $ = (id) => document.getElementById(id);

const fmt = (v, nd = 3) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? "—"
    : Number(v).toFixed(nd).replace(/\.0+$/, "");

const API_URL = "https://solarmonitor-5093.onrender.com";

const LUX_SCALE = 1000;
const UI_VOLT_MAX_HARD = 60;
const UI_VOLT_MIN_HARD = 1;

let currentUser = null;
let isManager = false;
let esp32Connected = false;

let currentOrientMode = "manual";
let currentTracker = false;

let lineChart, uiChart, pChart, iChart, uChart;
let lastIsc = null;
let lastVoc = null;

const histLabels = [];
const histLux = [];
const histTemp = [];
const histHum = [];
const histTc = [];

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

let lastDataSignature = "";

const C = {
  lux: "#fbbf24",
  temp: "#fb7185",
  hum: "#22d3ee",
  tc: "#34d399",
  iu: "#60a5fa",
  pu: "#f59e0b",
  ik: "#fb7185",
  uk: "#22d3ee",
  mpp: "#facc15",
  isc: "#ef4444",
  voc: "#22c55e",
  ref: "rgba(226,232,240,.7)",
  vmpp: "#a78bfa",
  impp: "#93c5fd"
};

/* ================= AUTH ================= */

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

/* ================= ESP32 STATUS ================= */

async function checkESP32() {
  try {
    const res = await fetch(`${API_URL}/api/esp32/status`);
    const data = await res.json();

    esp32Connected = data.connected === true;
    updateESP32UI(data);
  } catch {
    esp32Connected = false;
    updateESP32UI({});
  }
}

function updateESP32UI(data = {}) {
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
}

function updateControls() {
  const enabled = !!(esp32Connected && isManager);

  document.querySelectorAll(".esp32-control").forEach((el) => {
    el.disabled = !enabled;
    el.style.opacity = enabled ? "1" : "0.4";
    el.style.pointerEvents = enabled ? "auto" : "none";
  });

  const warning = $("esp32Warning");

  if (warning) {
    if (!currentUser) {
      warning.textContent =
        "Connectez-vous pour voir les données. La page d'accueil reste accessible.";
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

/* ================= COMMANDES SITE -> RENDER -> ESP32 ================= */

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
      alert(result.error || "Erreur commande serveur.");
    }
  } catch (err) {
    console.error(err);
    alert("Impossible d'envoyer la commande.");
  }
}

/* ================= LECTURE DATA RENDER -> SITE ================= */

async function pollEsp32Data() {
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

    const signature = JSON.stringify({
      received_at: s.received_at,
      seq: s.seq,
      ts_ms: s.ts_ms,
      info: s.info,
      phase: s.phase,
      line: s.line,
      u: s.u,
      i: s.i
    });

    if (signature === lastDataSignature) return;
    lastDataSignature = signature;

    if (s.info === "iv_summary") {
      applyIvSummary(s);
    } else {
      applySample(s);
    }

  } catch (err) {
    console.log(err);
  }
}

/* ================= ORIENTATION ================= */

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

  if ("servo1_deg" in s) setServoAngleUI(1, s.servo1_deg);
  if ("servo2_deg" in s) setServoAngleUI(2, s.servo2_deg);
}

function sendOrientMode() {
  const mode = getSelectedOrientMode();
  setOrientModeUI(mode);

  sendCmd({
    cmd: "orient",
    mode
  });
}

/* ================= CHARTS ================= */

function iuPointsToK(pointsIU) {
  const uK = [];
  const iK = [];

  for (let k = 0; k < pointsIU.length; k++) {
    const p = pointsIU[k];
    uK.push({ x: k, y: p.x });
    iK.push({ x: k, y: p.y });
  }

  return { uK, iK };
}

function line2pts(n, y) {
  const x1 = 0;
  const x2 = Math.max(1, n - 1);
  return [{ x: x1, y: y }, { x: x2, y: y }];
}

function autoscaleIaxis(Isc) {
  if (!uiChart) return;
  if (!Number.isFinite(Isc) || Isc <= 0) return;

  const pad = 1.2;
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
      x: {
        ticks: { color: "#d0dcff" },
        grid: { color: "rgba(140,170,255,.25)" }
      },
      y: {
        ticks: { color: "#d0dcff" },
        grid: { color: "rgba(140,170,255,.25)" }
      }
    }
  };

  lineChart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Lux", data: [], tension: 0.25, pointRadius: 0, borderColor: C.lux },
        { label: "Temp DHT (°C)", data: [], tension: 0.25, pointRadius: 0, borderColor: C.temp },
        { label: "Humidité (%)", data: [], tension: 0.25, pointRadius: 0, borderColor: C.hum },
        { label: "TC (°C)", data: [], tension: 0.25, pointRadius: 0, borderColor: C.tc }
      ]
    },
    options: commonXY
  });

  uiChart = new Chart($("uiChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "I(U)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: 0.25, yAxisID: "yI", borderColor: C.iu },
        { label: "Vmpp", data: [], borderDash: [6, 6], pointRadius: 0, showLine: true, yAxisID: "yI", borderColor: C.vmpp },
        { label: "Impp", data: [], borderDash: [6, 6], pointRadius: 0, showLine: true, yAxisID: "yI", borderColor: C.impp },
        { label: "MPP", data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.mpp, pointBorderColor: C.mpp },
        { label: "Isc", data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.isc, pointBorderColor: C.isc },
        { label: "Voc", data: [], pointRadius: 5, showLine: false, yAxisID: "yI", pointBackgroundColor: C.voc, pointBorderColor: C.voc }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { labels: { color: "#e5edff" } } },
      scales: {
        x: {
          title: { display: true, text: "Tension U (V)", color: "#e5edff" },
          ticks: { color: "#d0dcff", stepSize: 1 },
          grid: { color: "rgba(140,170,255,.25)" },
          min: 0,
          max: 40
        },
        yI: {
          min: 0,
          max: 3,
          title: { display: true, text: "Intensité I (A)", color: "#e5edff" },
          ticks: { color: "#d0dcff", stepSize: 0.1 },
          grid: { color: "rgba(140,170,255,.25)" }
        }
      }
    }
  });

  pChart = new Chart($("pChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "P(U)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: 0.25, yAxisID: "yP", borderColor: C.pu }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { labels: { color: "#e5edff" } } },
      scales: {
        x: {
          title: { display: true, text: "Tension U (V)", color: "#e5edff" },
          ticks: { color: "#d0dcff", stepSize: 1 },
          grid: { color: "rgba(140,170,255,.25)" },
          min: 0,
          max: 40
        },
        yP: {
          min: 0,
          title: { display: true, text: "Puissance P (W)", color: "#e5edff" },
          ticks: { color: "#d0dcff" },
          grid: { color: "rgba(140,170,255,.25)" }
        }
      }
    }
  });

  iChart = new Chart($("iChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "I(k)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: 0.25, borderColor: C.ik },
        { label: "I = 0", data: [], borderDash: [6, 6], pointRadius: 0, showLine: true, borderColor: C.ref },
        { label: "Isc", data: [], borderDash: [4, 4], pointRadius: 0, showLine: true, borderColor: C.isc },
        { label: "Iref", data: [], borderDash: [4, 4], pointRadius: 0, showLine: true, borderColor: C.vmpp }
      ]
    },
    options: {
      ...commonXY,
      scales: {
        x: {
          ...commonXY.scales.x,
          title: { display: true, text: "k (index du point IU)", color: "#e5edff" }
        },
        y: {
          ...commonXY.scales.y,
          title: { display: true, text: "I (A)", color: "#e5edff" },
          min: 0
        }
      }
    }
  });

  uChart = new Chart($("uChart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "U(k)", data: [], showLine: true, pointRadius: 0, borderWidth: 2, tension: 0.25, borderColor: C.uk },
        { label: "U = 0", data: [], borderDash: [6, 6], pointRadius: 0, showLine: true, borderColor: C.ref },
        { label: "Voc", data: [], borderDash: [4, 4], pointRadius: 0, showLine: true, borderColor: C.voc },
        { label: "Uref", data: [], borderDash: [4, 4], pointRadius: 0, showLine: true, borderColor: C.vmpp }
      ]
    },
    options: {
      ...commonXY,
      scales: {
        x: {
          ...commonXY.scales.x,
          title: { display: true, text: "k (index du point IU)", color: "#e5edff" }
        },
        y: {
          ...commonXY.scales.y,
          title: { display: true, text: "U (V)", color: "#e5edff" },
          min: 0
        }
      }
    }
  });
}

/* ================= REPERES ================= */

function updateRefs() {
  if (!iChart || !uChart) return;

  const chkI0 = $("chkI0")?.checked;
  const chkU0 = $("chkU0")?.checked;
  const chkIsc = $("chkIsc")?.checked;
  const chkVoc = $("chkVoc")?.checked;
  const chkUref = $("chkUref")?.checked;
  const chkIref = $("chkIref")?.checked;

  const Uref = Number($("uRefVal")?.value);
  const Iref = Number($("iRefVal")?.value);

  const n = iChart.data.datasets[0].data.length || 2;

  iChart.data.datasets[1].data = chkI0 ? line2pts(n, 0) : [];
  iChart.data.datasets[2].data = chkIsc && Number.isFinite(lastIsc) ? line2pts(n, lastIsc) : [];
  iChart.data.datasets[3].data = chkIref && Number.isFinite(Iref) ? line2pts(n, Iref) : [];

  uChart.data.datasets[1].data = chkU0 ? line2pts(n, 0) : [];
  uChart.data.datasets[2].data = chkVoc && Number.isFinite(lastVoc) ? line2pts(n, lastVoc) : [];
  uChart.data.datasets[3].data = chkUref && Number.isFinite(Uref) ? line2pts(n, Uref) : [];

  iChart.update("none");
  uChart.update("none");
}

/* ================= TEMPS REEL ================= */

function refreshLineViewport() {
  if (!lineChart) return;

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

  lineChart.data.labels = histLabels.slice(start, end);
  lineChart.data.datasets[0].data = histLux.slice(start, end).map(v => v == null ? null : v / LUX_SCALE);
  lineChart.data.datasets[1].data = histTemp.slice(start, end);
  lineChart.data.datasets[2].data = histHum.slice(start, end);
  lineChart.data.datasets[3].data = histTc.slice(start, end);

  lineChart.update("none");
}

function applySample(s) {
  applyOrientationStatus(s);

  if ("seq" in s && $("seq")) $("seq").textContent = s.seq;
  if ("ts_ms" in s && $("ts")) $("ts").textContent = s.ts_ms;
  if ("phase" in s && $("phase")) $("phase").textContent = s.phase;
  if ("line" in s && $("line")) $("line").textContent = s.line;
  if ("state" in s && $("state")) $("state").textContent = "state=" + (s.state ? "true" : "false");

  if ("lux" in s && $("liveLux")) $("liveLux").textContent = fmt(s.lux, 0);
  if ("temp_dht_c" in s && $("liveTemp")) $("liveTemp").textContent = fmt(s.temp_dht_c, 1);
  if ("hum_dht" in s && $("liveHumidity")) $("liveHumidity").textContent = fmt(s.hum_dht, 0);
  if ("tc_c" in s && $("liveTc")) $("liveTc").textContent = fmt(s.tc_c, 1);

  const inScan = !!s.state && s.phase === "scan";
  const isRising = (!wasScanning && inScan) || (inScan && s.seq === 0);

  if (isRising) {
    currentScanSamples = [];
    if ($("stepCount")) $("stepCount").textContent = "0";
  }

  if (inScan && "seq" in s) {
    histLabels.push(s.seq);

    histLux.push(s.lux == null ? null : Number(s.lux));
    histTemp.push(s.temp_dht_c == null ? null : Number(s.temp_dht_c));
    histHum.push(s.hum_dht == null ? null : Number(s.hum_dht));
    histTc.push(s.tc_c == null ? null : Number(s.tc_c));

    const HARD_MAX = 20000;

    if (histLabels.length > HARD_MAX) {
      histLabels.shift();
      histLux.shift();
      histTemp.shift();
      histHum.shift();
      histTc.shift();
      scrollPos = Math.max(0, scrollPos - 1);
    }

    refreshLineViewport();
  }

  if (inScan) {
    const U = Number(s.u_v);
    const I = Number(s.i_a);

    if (Number.isFinite(U) && Number.isFinite(I)) {
      if ($("uEff")) $("uEff").textContent = fmt(U, 2);
      if ($("iEff")) $("iEff").textContent = fmt(I, 3);

      currentScanSamples.push({
        k: currentScanSamples.length,
        seq: "seq" in s ? Number(s.seq) : null,
        ts_ms: "ts_ms" in s ? Number(s.ts_ms) : null,
        line: "line" in s ? Number(s.line) : null,
        u_v: U,
        i_a: I,
        lux: s.lux == null ? null : Number(s.lux),
        temp_dht_c: s.temp_dht_c == null ? null : Number(s.temp_dht_c),
        hum_dht: s.hum_dht == null ? null : Number(s.hum_dht),
        tc_c: s.tc_c == null ? null : Number(s.tc_c),
        servo1_deg: "servo1_deg" in s ? Number(s.servo1_deg) : null,
        servo2_deg: "servo2_deg" in s ? Number(s.servo2_deg) : null,
        orient_mode: s.orient_mode ?? currentOrientMode
      });

      if ($("stepCount")) $("stepCount").textContent = String(currentScanSamples.length);
    }
  }

  wasScanning = inScan;
}

function applyIvSummary(s) {
  applyOrientationStatus(s);

  const U = Array.isArray(s.u) ? s.u : [];
  const I = Array.isArray(s.i) ? s.i : [];
  const N = Math.min(U.length, I.length);

  if (!N) return;

  const points = [];

  for (let k = 0; k < N; k++) {
    const u = Number(U[k]);
    const i = Number(I[k]);

    if (Number.isFinite(u) && Number.isFinite(i) && u >= 0 && i >= 0) {
      points.push({ x: u, y: i });
    }
  }

  points.sort((a, b) => a.x - b.x);

  const meta = {
    vmpp: Number(s.vmpp),
    impp: Number(s.impp),
    pmpp: Number(s.pmpp),
    isc: Number(s.isc_a),
    voc: Number(s.voc_v),
    umax: Number(s.umax),
    servo1_deg: Number(s.servo1_deg),
    servo2_deg: Number(s.servo2_deg),
    orient_mode: s.orient_mode ?? currentOrientMode,
    series: Number(s.series)
  };

  lastIvMeta = { ...meta };
  lastIvPoints = points.slice();

  lastIsc = Number.isFinite(meta.isc) ? meta.isc : lastIsc;
  lastVoc = Number.isFinite(meta.voc) ? meta.voc : lastVoc;

  autoscaleIaxis(lastIsc);

  uiChart.data.datasets[0].data = points;
  pChart.data.datasets[0].data = points.map(p => ({ x: p.x, y: p.x * p.y }));

  if ($("uiCount")) $("uiCount").textContent = String(points.length);
  if ($("vmpp")) $("vmpp").textContent = Number.isFinite(meta.vmpp) ? fmt(meta.vmpp, 2) : "—";
  if ($("impp")) $("impp").textContent = Number.isFinite(meta.impp) ? fmt(meta.impp, 3) : "—";
  if ($("pmpp")) $("pmpp").textContent = Number.isFinite(meta.pmpp) ? fmt(meta.pmpp, 2) : "—";
  if ($("iscVal")) $("iscVal").textContent = Number.isFinite(meta.isc) ? fmt(meta.isc, 3) : "—";
  if ($("vocVal")) $("vocVal").textContent = Number.isFinite(meta.voc) ? fmt(meta.voc, 2) : "—";

  const { uK, iK } = iuPointsToK(points);

  iChart.data.datasets[0].data = iK;
  uChart.data.datasets[0].data = uK;

  iChart.options.scales.x.max = Math.max(1, points.length - 1);
  uChart.options.scales.x.max = Math.max(1, points.length - 1);

  if ($("stepCount")) $("stepCount").textContent = String(points.length);

  uiChart.update("none");
  pChart.update("none");
  updateRefs();
  iChart.update("none");
  uChart.update("none");
}

/* ================= SERVOS ================= */

function paintRange(el) {
  if (!el) return;

  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const val = ((Number(el.value) - min) / (max - min)) * 100;

  el.style.background = `linear-gradient(90deg,#22c55e ${val}%, #264a8a ${val}%)`;
}

function setServo(needle, label, deg) {
  const a = Math.max(0, Math.min(180, Number(deg) || 0));

  if (needle) needle.style.transform = `rotate(${a - 90}deg)`;
  if (label) label.textContent = `${a | 0}°`;
}

function setGaugeFill(idx, angle) {
  const el = document.querySelector(
    idx === 1
      ? ".gauges .servo:nth-child(1)"
      : ".gauges .servo:nth-child(2)"
  );

  if (!el) return;

  const a = Math.max(0, Math.min(180, Number(angle) || 0));
  const fill = el.querySelector(".gauge .gFill");

  if (fill) fill.style.setProperty("--angle", a);
}

function setServoAngleUI(idx, angle) {
  const a = Math.max(0, Math.min(180, Number(angle) || 0));

  if (idx === 1) {
    setServo($("needle1"), $("servoTxt1"), a);
    if ($("servo1Val")) $("servo1Val").textContent = `${a | 0}°`;
    if ($("servo1Live")) $("servo1Live").textContent = `${a | 0}°`;
  } else {
    setServo($("needle2"), $("servoTxt2"), a);
    if ($("servo2Val")) $("servo2Val").textContent = `${a | 0}°`;
    if ($("servo2Live")) $("servo2Live").textContent = `${a | 0}°`;
  }

  setGaugeFill(idx, a);

  const rangeEl = $(idx === 1 ? "servo1Range" : "servo2Range");

  if (rangeEl) {
    rangeEl.value = String(a);
    paintRange(rangeEl);
  }
}

function setServoAngle(idx, angle) {
  const a = Math.max(0, Math.min(180, Number(angle) || 0));

  setServoAngleUI(idx, a);

  sendCmd({
    cmd: "servo",
    index: idx,
    angle: a
  });
}

/* ================= CSV ================= */

function downloadAllMeasuresCsv() {
  if (!currentUser) {
    alert("Connectez-vous pour exporter.");
    return;
  }

  let csv = "seq;lux;temp_dht_c;hum_dht;tc_c\n";

  for (let i = 0; i < histLabels.length; i++) {
    csv += `${histLabels[i] ?? ""};${histLux[i] ?? ""};${histTemp[i] ?? ""};${histHum[i] ?? ""};${histTc[i] ?? ""}\n`;
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "solar_monitor_mesures.csv";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

/* ================= CLEAR ================= */

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

  ["uEff", "iEff", "uiCount", "stepCount", "vmpp", "impp", "pmpp", "iscVal", "vocVal"].forEach(id => {
    if ($(id)) $(id).textContent = "—";
  });
}

/* ================= BOUTONS ================= */

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

  $("btnApplyOrient")?.addEventListener("click", sendOrientMode);

  document.querySelectorAll('input[name="orientMode"]').forEach(el => {
    el.addEventListener("change", () => {
      setOrientModeUI(getSelectedOrientMode());
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
    pollEsp32Data();
  });

  $("btnSetPeriod")?.addEventListener("click", () => {
    const v = Number(($("periodMs")?.value || "").trim());

    if (!Number.isFinite(v) || v < 0) {
      alert("Entrez un intervalle valide.");
      return;
    }

    sendCmd({
      cmd: "schedule",
      period_ms: v
    });
  });

  $("btnDownloadAllMeasures")?.addEventListener("click", downloadAllMeasuresCsv);

  $("btnClearDisplay")?.addEventListener("click", clearDisplay);

  $("btnClearHistory")?.addEventListener("click", () => {
    ivHistory = [];
    scanCounter = 0;
    selectedScanId = null;

    const root = $("historyList");
    if (root) root.innerHTML = "";
  });

  $("btnToggleHistory")?.addEventListener("click", () => {
    const card = $("historyCard");
    if (!card) return;

    const hidden = card.classList.toggle("is-hidden");
    $("btnToggleHistory").textContent = hidden ? "Afficher historique" : "Masquer historique";
  });

  $("winSize")?.addEventListener("change", () => {
    const v = Number($("winSize").value);

    if (Number.isFinite(v) && v >= 20) {
      WIN_SIZE = Math.min(2000, Math.max(20, v));
      refreshLineViewport();
    }
  });

  $("chartScroll")?.addEventListener("input", () => {
    scrollPos = Number($("chartScroll").value) || 0;
    autoFollow = false;

    if ($("autoFollow")) $("autoFollow").checked = false;

    refreshLineViewport();
  });

  $("autoFollow")?.addEventListener("change", () => {
    autoFollow = !!$("autoFollow").checked;
    refreshLineViewport();
  });

  $("servo1Range")?.addEventListener("input", e => setServoAngle(1, e.target.value));
  $("servo2Range")?.addEventListener("input", e => setServoAngle(2, e.target.value));

  $("btnManualConnect")?.addEventListener("click", () => {
    checkESP32();
    pollEsp32Data();
  });

  $("logoutBtn")?.addEventListener("click", logout);

  ["chkI0", "chkU0", "chkIsc", "chkVoc", "chkUref", "chkIref", "uRefVal", "iRefVal"].forEach(id => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", updateRefs);
      el.addEventListener("change", updateRefs);
    }
  });
}

/* ================= BOOT ================= */

window.addEventListener("DOMContentLoaded", () => {
  loadUser();

  initCharts();

  setOrientModeUI("manual");
  setTrackerUI(false);

  wireButtons();

  const card = $("historyCard");
  if (card) card.classList.add("is-hidden");

  checkESP32();
  pollEsp32Data();

  setInterval(checkESP32, 5000);
  setInterval(pollEsp32Data, 500);
});
