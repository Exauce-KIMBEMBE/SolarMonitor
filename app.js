/* =========================================================
   SolarMonitor Dashboard
   Auth + ESP32 + permissions
========================================================= */

const $ = (id) => document.getElementById(id);

const fmt = (v, nd = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v))
    ? "—"
    : Number(v).toFixed(nd).replace(/\.0+$/, "");

const API_URL = "https://solarmonitor-5093.onrender.com";

let esp32Connected = false;
let currentUser = null;
let isManager = false;

let currentOrientMode = "manual";
let currentTracker = false;

let histLabels = [];
let histLux = [];
let histTemp = [];
let histHum = [];
let histTc = [];

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

  const loginLink = $("loginLink");
  const registerLink = $("registerLink");
  const logoutBtn = $("logoutBtn");

  if (currentUser) {
    if (loginLink) loginLink.style.display = "none";
    if (registerLink) registerLink.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "inline-flex";
  } else {
    if (loginLink) loginLink.style.display = "inline-flex";
    if (registerLink) registerLink.style.display = "inline-flex";
    if (logoutBtn) logoutBtn.style.display = "none";
  }

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

  if ($("esp32LastSeen")) {
    $("esp32LastSeen").textContent = data.lastSeen || "—";
  }

  if ($("esp32Ip")) {
    $("esp32Ip").textContent = data.ip || "—";
  }

  updateControls();
}

function updateControls() {
  const controls = document.querySelectorAll(".esp32-control");
  const enabled = !!(esp32Connected && isManager);

  controls.forEach((el) => {
    el.disabled = !enabled;
    el.style.opacity = enabled ? "1" : "0.4";
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

/* ================= COMMANDES ================= */

async function sendCmd(cmd) {
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
      body: JSON.stringify(cmd)
    });

    if (!res.ok) {
      const result = await res.json().catch(() => ({}));
      alert(result.error || "Erreur lors de l’envoi de la commande.");
    }
  } catch (err) {
    console.error(err);
    alert("Erreur de connexion au serveur.");
  }
}

/* ================= LECTURE DONNÉES ESP32 ================= */

async function getESP32Data() {
  if (!currentUser) {
    return;
  }

  const token = getToken();

  if (!token) {
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/esp32/data`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (!res.ok) return;

    const s = await res.json();
    applySample(s);
  } catch (err) {
    console.log(err);
  }
}

function applySample(s) {
  if (!s || typeof s !== "object") return;

  if ("temp_dht_c" in s && $("liveTemp")) {
    $("liveTemp").textContent = fmt(s.temp_dht_c, 1);
  }

  if ("lux" in s && $("liveLux")) {
    $("liveLux").textContent = fmt(s.lux, 0);
  }

  if ("hum_dht" in s && $("liveHumidity")) {
    $("liveHumidity").textContent = fmt(s.hum_dht, 0);
  }

  if ("tc_c" in s && $("liveTc")) {
    $("liveTc").textContent = fmt(s.tc_c, 1);
  }

  if ("ldr_l" in s && $("ldrL")) $("ldrL").textContent = s.ldr_l ? "ON" : "OFF";
  if ("ldr_r" in s && $("ldrR")) $("ldrR").textContent = s.ldr_r ? "ON" : "OFF";
  if ("ldr_h" in s && $("ldrH")) $("ldrH").textContent = s.ldr_h ? "ON" : "OFF";
  if ("ldr_b" in s && $("ldrB")) $("ldrB").textContent = s.ldr_b ? "ON" : "OFF";

  if ("servo1_deg" in s) {
    if ($("servo1Live")) $("servo1Live").textContent = `${s.servo1_deg}°`;
    if ($("servo1Val")) $("servo1Val").textContent = `${s.servo1_deg}°`;
    if ($("servo1Range")) $("servo1Range").value = s.servo1_deg;
  }

  if ("servo2_deg" in s) {
    if ($("servo2Live")) $("servo2Live").textContent = `${s.servo2_deg}°`;
    if ($("servo2Val")) $("servo2Val").textContent = `${s.servo2_deg}°`;
    if ($("servo2Range")) $("servo2Range").value = s.servo2_deg;
  }

  if ("tracker" in s) {
    currentTracker = !!s.tracker;
    if ($("trackerTxt")) $("trackerTxt").textContent = currentTracker ? "ON" : "OFF";
  }

  if ("orient_mode" in s) {
    currentOrientMode = s.orient_mode;

    if ($("orientModeTxt")) $("orientModeTxt").textContent = currentOrientMode;
    if ($("orientModeBar")) $("orientModeBar").textContent = currentOrientMode;
  }

  if ("state" in s && $("state")) {
    $("state").textContent = s.state ? "Mesure active" : "Mesure inactive";
  }

  if ("seq" in s && $("seq")) $("seq").textContent = s.seq;
  if ("ts_ms" in s && $("ts")) $("ts").textContent = s.ts_ms;
  if ("phase" in s && $("phase")) $("phase").textContent = s.phase;
  if ("line" in s && $("line")) $("line").textContent = s.line;

  if ("u_v" in s && $("uEff")) $("uEff").textContent = fmt(s.u_v, 2);
  if ("i_a" in s && $("iEff")) $("iEff").textContent = fmt(s.i_a, 3);

  if ("seq" in s) {
    histLabels.push(s.seq);
    histLux.push(Number(s.lux) || 0);
    histTemp.push(Number(s.temp_dht_c) || 0);
    histHum.push(Number(s.hum_dht) || 0);
    histTc.push(Number(s.tc_c) || 0);

    if (histLabels.length > 500) {
      histLabels.shift();
      histLux.shift();
      histTemp.shift();
      histHum.shift();
      histTc.shift();
    }

    refreshCharts();
  }
}

/* ================= GRAPHIQUES ================= */

function refreshCharts() {
  if (typeof lineChart === "undefined" || !lineChart) return;

  lineChart.data.labels = histLabels.slice(-150);
  lineChart.data.datasets[0].data = histLux.slice(-150);
  lineChart.data.datasets[1].data = histTemp.slice(-150);
  lineChart.data.datasets[2].data = histHum.slice(-150);
  lineChart.data.datasets[3].data = histTc.slice(-150);

  lineChart.update("none");
}

/* ================= BOUTONS ================= */

function wireButtons() {
  $("btnStart")?.addEventListener("click", () => {
    sendCmd({
      cmd: "start",
      orient: currentOrientMode
    });
  });

  $("btnStop")?.addEventListener("click", () => {
    sendCmd({
      cmd: "stop"
    });
  });

  $("btnScanFull")?.addEventListener("click", () => {
    sendCmd({
      cmd: "scan",
      type: "full",
      orient: currentOrientMode
    });
  });

  $("btnApplyOrient")?.addEventListener("click", () => {
    const mode = document.querySelector('input[name="orientMode"]:checked')?.value || "manual";

    currentOrientMode = mode;

    sendCmd({
      cmd: "orient",
      mode
    });
  });

  document.querySelectorAll('input[name="orientMode"]').forEach((el) => {
    el.addEventListener("change", () => {
      currentOrientMode =
        document.querySelector('input[name="orientMode"]:checked')?.value || "manual";

      if ($("orientModeTxt")) $("orientModeTxt").textContent = currentOrientMode;
      if ($("orientModeBar")) $("orientModeBar").textContent = currentOrientMode;
    });
  });

  $("btnTrackerOn")?.addEventListener("click", () => {
    currentTracker = true;
    if ($("trackerTxt")) $("trackerTxt").textContent = "ON";

    sendCmd({
      cmd: "tracker",
      enabled: true
    });
  });

  $("btnTrackerOff")?.addEventListener("click", () => {
    currentTracker = false;
    if ($("trackerTxt")) $("trackerTxt").textContent = "OFF";

    sendCmd({
      cmd: "tracker",
      enabled: false
    });
  });

  $("btnStatus")?.addEventListener("click", () => {
    checkESP32();
    getESP32Data();
  });

  $("btnSetPeriod")?.addEventListener("click", () => {
    const ms = Number($("periodMs")?.value);

    if (!Number.isFinite(ms) || ms < 0) {
      alert("Entrez un intervalle valide.");
      return;
    }

    sendCmd({
      cmd: "schedule",
      period_ms: ms
    });
  });

  $("servo1Range")?.addEventListener("input", (e) => {
    if ($("servo1Val")) $("servo1Val").textContent = `${e.target.value}°`;

    sendCmd({
      cmd: "servo",
      index: 1,
      angle: Number(e.target.value)
    });
  });

  $("servo2Range")?.addEventListener("input", (e) => {
    if ($("servo2Val")) $("servo2Val").textContent = `${e.target.value}°`;

    sendCmd({
      cmd: "servo",
      index: 2,
      angle: Number(e.target.value)
    });
  });

  $("btnManualConnect")?.addEventListener("click", () => {
    checkESP32();
    getESP32Data();
  });

  $("logoutBtn")?.addEventListener("click", logout);

  $("btnClearDisplay")?.addEventListener("click", () => {
    histLabels = [];
    histLux = [];
    histTemp = [];
    histHum = [];
    histTc = [];
    refreshCharts();
  });

  $("btnDownloadAllMeasures")?.addEventListener("click", () => {
    downloadCurrentDataCsv();
  });
}

/* ================= EXPORT CSV SIMPLE ================= */

function downloadCurrentDataCsv() {
  if (!currentUser) {
    alert("Connectez-vous pour télécharger les données.");
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
  a.download = "solar_monitor_data.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  URL.revokeObjectURL(url);
}

/* ================= INITIALISATION ================= */

window.addEventListener("DOMContentLoaded", () => {
  loadUser();
  wireButtons();

  checkESP32();
  setInterval(checkESP32, 5000);

  getESP32Data();
  setInterval(getESP32Data, 1000);
});
