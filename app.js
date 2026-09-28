/* =========================================================
   SolarMonitor — app.js
   ---------------------------------------------------------
   - Dashboard Render API sans WebSocket
   - ESP32 -> Render -> navigateur
   - Historique permanent MySQL via backend Render
   - 4 graphiques capteurs séparés
   - I(U), P(U), U(k), I(k)
   - Orientation solaire / servos / tracker
   - Export CSV + PDF
   ========================================================= */


/* =========================================================
   HELPERS
   ========================================================= */

const $ = (id) => document.getElementById(id);

const fmt = (v, nd = 3) =>
  (
    v === null ||
    v === undefined ||
    Number.isNaN(Number(v))
  )
    ? "—"
    : Number(v)
        .toFixed(nd)
        .replace(/\.0+$/, "");


/* =========================================================
   CONFIGURATION
   ========================================================= */

const API_URL =
  "https://solarmonitor-5093.onrender.com";

/*
   Calibration tension :

   5 V côté acquisition = 20 V panneau
*/
const PANEL_VOLTAGE_SCALE = 4;

const PANEL_VOLTAGE_MAX = 20;

const UI_VOLT_MAX_HARD = 20;
const UI_VOLT_MIN_HARD = 1;

const SENSOR_HARD_MAX = 20000;


/* =========================================================
   ETAT APPLICATION
   ========================================================= */

let currentUser = null;

let isUser = false;
let isManager = false;
let isAdmin = false;

let canControlESP32 = false;

let esp32Connected = false;

let lastDataSignature = "";

let scanOverlayTimer = null;


/* =========================================================
   AUTHENTIFICATION
   ========================================================= */

function getToken() {
  return localStorage.getItem("token");
}


function authHeaders(extra = {}) {
  const token = getToken();

  return {
    ...extra,
    ...(token
      ? {
          Authorization: `Bearer ${token}`
        }
      : {})
  };
}


function loadUser() {

  try {

    currentUser =
      JSON.parse(
        localStorage.getItem("user") || "null"
      );

  }
  catch {

    currentUser = null;

  }


  /* =====================================================
     IDENTIFICATION DU ROLE
     ===================================================== */

  isUser =
    !!currentUser &&
    currentUser.role === "user";


  isManager =
    !!currentUser &&
    currentUser.role === "manager";


  isAdmin =
    !!currentUser &&
    currentUser.role === "admin";


  /*
    MANAGER et ADMIN peuvent commander l'installation.

    USER = lecture uniquement.
  */

  canControlESP32 =
    isManager ||
    isAdmin;


  /* =====================================================
     CONNEXION / INSCRIPTION
     ===================================================== */

  if ($("loginLink")) {

    $("loginLink").style.display =
      currentUser
        ? "none"
        : "flex";
  }


  if ($("registerLink")) {

    $("registerLink").style.display =
      currentUser
        ? "none"
        : "flex";
  }


  /* =====================================================
     DECONNEXION
     ===================================================== */

  if ($("logoutBtn")) {

    $("logoutBtn").style.display =
      currentUser
        ? "flex"
        : "none";
  }


  /* =====================================================
     AFFICHAGE ROLE
     ===================================================== */

  if ($("userRole")) {

    if (isAdmin) {

      $("userRole").textContent =
        "Administrateur";

    }
    else if (isManager) {

      $("userRole").textContent =
        "Manager";

    }
    else if (isUser) {

      $("userRole").textContent =
        "Utilisateur";

    }
    else {

      $("userRole").textContent =
        "Visiteur";

    }
  }


  /* =====================================================
     GESTION UTILISATEURS
     ADMIN UNIQUEMENT
     ===================================================== */

  const adminLink =
    $("adminLink");


  if (adminLink) {

    adminLink.style.display =
      isAdmin
        ? "flex"
        : "none";
  }


  /* =====================================================
     ACTUALISATION DES COMMANDES
     ===================================================== */

  updateControls();
}


function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");

  window.location.href =
    "index.html";
}


/* =========================================================
   CONTROLES UTILISATEUR
   ========================================================= */

function updateControls() {

  /*
    Les commandes sont utilisables uniquement si :

    1. l'utilisateur est ADMIN ou MANAGER
    2. l'ESP32 est connectée
  */

  const enabled =
    !!(
      esp32Connected &&
      canControlESP32
    );


  document
    .querySelectorAll(
      ".esp32-control"
    )
    .forEach(el => {


      el.disabled =
        !enabled;


      el.style.opacity =
        enabled
          ? "1"
          : "0.45";


      el.style.pointerEvents =
        enabled
          ? "auto"
          : "none";


      if (enabled) {

        el.title =
          "";

      }

      else if (!currentUser) {

        el.title =
          "Connectez-vous pour utiliser cette commande.";

      }

      else if (!canControlESP32) {

        el.title =
          "Cette commande est réservée au manager et à l'administrateur.";

      }

      else {

        el.title =
          "ESP32 déconnectée.";

      }

    });


  /* =====================================================
     MESSAGE D'INFORMATION
     ===================================================== */

  const warning =
    $("esp32Warning");


  if (!warning)
    return;


  /* =====================================================
     VISITEUR
     ===================================================== */

  if (!currentUser) {

    warning.textContent =
      "Connectez-vous pour consulter les données et utiliser SolarMonitor.";

    warning.style.display =
      "block";

    return;
  }


  /* =====================================================
     USER
     ===================================================== */

  if (isUser) {

    warning.textContent =
      "Mode lecture seule : vous pouvez consulter les données, les courbes et l'historique, mais vous ne pouvez pas commander le panneau.";

    warning.style.display =
      "block";

    return;
  }


  /* =====================================================
     MANAGER / ADMIN MAIS ESP32 DECONNECTEE
     ===================================================== */

  if (
    canControlESP32 &&
    !esp32Connected
  ) {

    warning.textContent =
      isAdmin
        ? "Administrateur connecté — ESP32 déconnectée : les commandes sont temporairement désactivées."
        : "Manager connecté — ESP32 déconnectée : les commandes sont temporairement désactivées.";

    warning.style.display =
      "block";

    return;
  }


  /* =====================================================
     MANAGER / ADMIN + ESP32 CONNECTEE
     ===================================================== */

  warning.style.display =
    "none";
}


/* =========================================================
   NAVIGATION DASHBOARD
   ========================================================= */

const PAGE_INFO = {

  overview: {
    title:
      "Vue générale",

    subtitle:
      "État du système et données en temps réel"
  },

  measurement: {
    title:
      "Mesure I-V",

    subtitle:
      "Caractérisation électrique du panneau solaire"
  },

  sensors: {
    title:
      "Capteurs",

    subtitle:
      "Luminosité, température, humidité et thermocouple"
  },

  orientation: {
    title:
      "Orientation",

    subtitle:
      "Positionnement et suivi solaire"
  },

  gps: {
    title:
      "Localisation",

    subtitle:
      "Position GPS du panneau solaire"
  },

  history: {
    title:
      "Historique",

    subtitle:
      "Mesures I-V enregistrées dans la base de données"
  }

};


function showPage(name) {

  document
    .querySelectorAll(
      "[data-page-content]"
    )
    .forEach(page => {

      page.classList.toggle(
        "activePage",
        page.dataset.pageContent === name
      );
    });


  document
    .querySelectorAll(
      ".navItem[data-page]"
    )
    .forEach(btn => {

      btn.classList.toggle(
        "active",
        btn.dataset.page === name
      );
    });


  const info =
    PAGE_INFO[name];


  if (info) {

    if ($("pageTitle")) {

      $("pageTitle").textContent =
        info.title;
    }


    if ($("pageSubtitle")) {

      $("pageSubtitle").textContent =
        info.subtitle;
    }
  }


  document.body.classList.remove(
    "sidebar-open"
  );


  setTimeout(
    resizeAllCharts,
    80
  );


  /* =====================================================
     HISTORIQUE
     ===================================================== */

  if (name === "history") {

    loadMeasurementHistory();
  }


  /* =====================================================
     GPS

     Leaflet doit être redimensionné après l'ouverture
     de la page car la carte était auparavant cachée.
     ===================================================== */

  if (name === "gps") {

    initGpsMap();


    setTimeout(
      () => {

        if (gpsMap) {

          gpsMap.invalidateSize();
        }

      },
      150
    );


    refreshGpsDisplay();
  }
}


function wireNavigation() {

  document
    .querySelectorAll(
      ".navItem[data-page]"
    )
    .forEach(btn => {

      btn.addEventListener(
        "click",
        () => {

          showPage(
            btn.dataset.page
          );
        }
      );
    });


  $("sidebarToggle")
    ?.addEventListener(
      "click",
      () => {

        document.body
          .classList
          .toggle(
            "sidebar-open"
          );
      }
    );
}


/* =========================================================
   GPS / LOCALISATION
   ========================================================= */

let gpsMap = null;

let gpsMarker = null;

let gpsCircle = null;

let lastGpsData = null;


/*
  Position par défaut de la carte.

  IMPORTANT :
  ce n'est PAS la position du panneau.

  La carte démarre simplement avec une vue mondiale
  jusqu'à réception d'une vraie position GPS.
*/

const GPS_DEFAULT_LAT = 0;
const GPS_DEFAULT_LON = 0;
const GPS_DEFAULT_ZOOM = 2;

const GPS_VALID_ZOOM = 17;


/* =========================================================
   INITIALISATION CARTE
   ========================================================= */

function initGpsMap() {

  if (gpsMap)
    return;


  const mapElement =
    $("gpsMap");


  if (!mapElement)
    return;


  /*
    Vérification de Leaflet.
  */

  if (
    typeof L === "undefined"
  ) {

    console.error(
      "Leaflet n'est pas chargé."
    );

    return;
  }


  gpsMap =
    L.map(
      mapElement,
      {
        zoomControl: true,
        attributionControl: true
      }
    );


  gpsMap.setView(
    [
      GPS_DEFAULT_LAT,
      GPS_DEFAULT_LON
    ],
    GPS_DEFAULT_ZOOM
  );


  /*
    OpenStreetMap
  */

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,

      attribution:
        "&copy; OpenStreetMap contributors"
    }
  )
    .addTo(
      gpsMap
    );


  /*
    Aucun marqueur n'est créé ici.

    Le marqueur apparaîtra uniquement lorsqu'une
    vraie latitude/longitude sera reçue du GPS.
  */

  setTimeout(
    () => {

      if (gpsMap) {

        gpsMap.invalidateSize();
      }

    },
    100
  );
}


/* =========================================================
   VALIDATION COORDONNEES
   ========================================================= */

function isValidGpsCoordinate(
  latitude,
  longitude
) {

  const lat =
    Number(latitude);

  const lon =
    Number(longitude);


  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {

    return false;
  }


  if (
    lat < -90 ||
    lat > 90
  ) {

    return false;
  }


  if (
    lon < -180 ||
    lon > 180
  ) {

    return false;
  }


  /*
    0 / 0 est généralement envoyé par certains
    modules avant l'obtention d'un fix.

    On ne place donc pas le panneau à cet endroit.
  */

  if (
    lat === 0 &&
    lon === 0
  ) {

    return false;
  }


  return true;
}


/* =========================================================
   EXTRACTION DES DONNEES GPS

   Cette fonction accepte plusieurs noms afin de ne pas
   rendre le navigateur dépendant d'un seul format ESP32.

   Le format que nous utiliserons ensuite côté ESP32 sera :

   gps_valid
   gps_lat
   gps_lon
   gps_alt
   gps_satellites
   gps_hdop
   ========================================================= */

function extractGpsData(s) {

  if (
    !s ||
    typeof s !== "object"
  ) {

    return null;
  }


  const latitude =
    s.gps_lat ??
    s.latitude ??
    s.lat ??
    s.gps?.lat ??
    s.gps?.latitude;


  const longitude =
    s.gps_lon ??
    s.longitude ??
    s.lon ??
    s.lng ??
    s.gps?.lon ??
    s.gps?.lng ??
    s.gps?.longitude;


  const altitude =
    s.gps_alt ??
    s.gps_altitude ??
    s.altitude ??
    s.gps?.alt ??
    s.gps?.altitude;


  const satellites =
    s.gps_satellites ??
    s.satellites ??
    s.sats ??
    s.gps?.satellites;


  const hdop =
    s.gps_hdop ??
    s.hdop ??
    s.gps?.hdop;


  const explicitValid =
    s.gps_valid ??
    s.gps?.valid;


  const coordinateValid =
    isValidGpsCoordinate(
      latitude,
      longitude
    );


  const valid =
    explicitValid === undefined
      ? coordinateValid
      : (
          (
            explicitValid === true ||
            explicitValid === 1 ||
            explicitValid === "1" ||
            explicitValid === "true"
          ) &&
          coordinateValid
        );


  /*
    Si aucune donnée GPS n'est présente dans le JSON,
    on ne touche pas à la position actuellement affichée.
  */

  const hasGpsField =
    latitude !== undefined ||
    longitude !== undefined ||
    altitude !== undefined ||
    satellites !== undefined ||
    hdop !== undefined ||
    explicitValid !== undefined;


  if (!hasGpsField)
    return null;


  return {

    valid,

    latitude:
      latitude == null
        ? null
        : Number(latitude),

    longitude:
      longitude == null
        ? null
        : Number(longitude),

    altitude:
      altitude == null
        ? null
        : Number(altitude),

    satellites:
      satellites == null
        ? null
        : Number(satellites),

    hdop:
      hdop == null
        ? null
        : Number(hdop),

    receivedAt:
      new Date()

  };
}


/* =========================================================
   FORMAT DATE GPS
   ========================================================= */

function formatGpsTime(date) {

  if (!(date instanceof Date))
    return "—";


  return date.toLocaleString(
    "fr-FR",
    {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",

      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  );
}


/* =========================================================
   ETAT GPS
   ========================================================= */

function setGpsState(
  valid,
  message
) {

  const badge =
    $("gpsStateBadge");


  const text =
    $("gpsStateText");


  if (text) {

    text.textContent =
      message;
  }


  if (badge) {

    badge.classList.remove(
      "waiting",
      "valid",
      "error"
    );


    badge.classList.add(
      valid
        ? "valid"
        : "waiting"
    );
  }


  if ($("gpsFixStatus")) {

    $("gpsFixStatus").textContent =
      valid
        ? "Position GPS valide"
        : "Recherche de position";
  }


  if ($("gpsDataState")) {

    $("gpsDataState").textContent =
      valid
        ? "Position reçue"
        : "En attente";
  }


  if ($("gpsFixType")) {

    $("gpsFixType").textContent =
      valid
        ? "Fix valide"
        : "Aucun fix";
  }
}


/* =========================================================
   AFFICHAGE GPS
   ========================================================= */

function applyGpsData(s) {

  const gps =
    extractGpsData(s);


  /*
    Le message reçu ne contient aucune donnée GPS.
  */

  if (!gps)
    return;


  lastGpsData =
    gps;


  /* =====================================================
     SATELLITES
     ===================================================== */

  if ($("gpsSatellites")) {

    $("gpsSatellites").textContent =
      Number.isFinite(gps.satellites)
        ? Math.round(
            gps.satellites
          )
        : "—";
  }


  if ($("gpsSatellitesDetail")) {

    $("gpsSatellitesDetail").textContent =
      Number.isFinite(gps.satellites)
        ? `${Math.round(gps.satellites)}`
        : "—";
  }


  /* =====================================================
     HDOP
     ===================================================== */

  if ($("gpsHdop")) {

    $("gpsHdop").textContent =
      Number.isFinite(gps.hdop)
        ? fmt(
            gps.hdop,
            2
          )
        : "—";
  }


  if ($("gpsHdopDetail")) {

    $("gpsHdopDetail").textContent =
      Number.isFinite(gps.hdop)
        ? fmt(
            gps.hdop,
            2
          )
        : "—";
  }


  /* =====================================================
     PAS ENCORE DE FIX
     ===================================================== */

  if (!gps.valid) {

    setGpsState(
      false,
      "Recherche GPS"
    );


    if ($("gpsMapDescription")) {

      $("gpsMapDescription").textContent =
        "Recherche d'une position GPS valide...";
    }


    return;
  }


  /* =====================================================
     POSITION VALIDE
     ===================================================== */

  const lat =
    gps.latitude;

  const lon =
    gps.longitude;


  const latText =
    lat.toFixed(6);


  const lonText =
    lon.toFixed(6);


  /* =====================================================
     LATITUDE
     ===================================================== */

  if ($("gpsLatitude")) {

    $("gpsLatitude").textContent =
      latText;
  }


  /* =====================================================
     LONGITUDE
     ===================================================== */

  if ($("gpsLongitude")) {

    $("gpsLongitude").textContent =
      lonText;
  }


  /* =====================================================
     ALTITUDE
     ===================================================== */

  if ($("gpsAltitude")) {

    $("gpsAltitude").textContent =
      Number.isFinite(gps.altitude)
        ? fmt(
            gps.altitude,
            1
          )
        : "—";
  }


  if ($("gpsAltitudeDetail")) {

    $("gpsAltitudeDetail").textContent =
      Number.isFinite(gps.altitude)
        ? `${fmt(
            gps.altitude,
            1
          )} m`
        : "—";
  }


  /* =====================================================
     COORDONNEES
     ===================================================== */

  if ($("gpsCoordinates")) {

    $("gpsCoordinates").textContent =
      `${latText}, ${lonText}`;
  }


  /* =====================================================
     HEURE
     ===================================================== */

  const timeText =
    formatGpsTime(
      gps.receivedAt
    );


  if ($("gpsLastUpdate")) {

    $("gpsLastUpdate").textContent =
      timeText;
  }


  if ($("gpsLastReception")) {

    $("gpsLastReception").textContent =
      timeText;
  }


  /* =====================================================
     ETAT
     ===================================================== */

  setGpsState(
    true,
    "Position valide"
  );


  if ($("gpsMapDescription")) {

    $("gpsMapDescription").textContent =
      `Panneau : ${latText}, ${lonText}`;
  }


  /* =====================================================
     CARTE
     ===================================================== */

  initGpsMap();


  if (!gpsMap)
    return;


  const position = [
    lat,
    lon
  ];


  /*
    Premier fix GPS :
    création du marqueur.
  */

  if (!gpsMarker) {

    gpsMarker =
      L.marker(
        position
      )
        .addTo(
          gpsMap
        );


    gpsMarker.bindPopup(
      `
        <strong>Panneau solaire</strong>
        <br>
        Latitude : ${latText}
        <br>
        Longitude : ${lonText}
      `
    );
  }

  else {

    gpsMarker.setLatLng(
      position
    );


    gpsMarker.setPopupContent(
      `
        <strong>Panneau solaire</strong>
        <br>
        Latitude : ${latText}
        <br>
        Longitude : ${lonText}
      `
    );
  }


  /* =====================================================
     CERCLE DE PRECISION APPROXIMATIF

     HDOP n'est pas directement une précision en mètres.
     Le cercle sert uniquement de repère visuel et n'est
     affiché que lorsqu'une valeur HDOP exploitable existe.
     ===================================================== */

  if (
    Number.isFinite(gps.hdop) &&
    gps.hdop > 0
  ) {

    const approximateRadius =
      Math.max(
        5,
        gps.hdop * 5
      );


    if (!gpsCircle) {

      gpsCircle =
        L.circle(
          position,
          {
            radius:
              approximateRadius
          }
        )
          .addTo(
            gpsMap
          );
    }

    else {

      gpsCircle.setLatLng(
        position
      );


      gpsCircle.setRadius(
        approximateRadius
      );
    }
  }


  gpsMap.setView(
    position,
    GPS_VALID_ZOOM
  );


  /*
    Le message "position indisponible"
    disparaît seulement après un vrai fix.
  */

  if ($("gpsMapWaiting")) {

    $("gpsMapWaiting").style.display =
      "none";
  }


  setTimeout(
    () => {

      if (gpsMap) {

        gpsMap.invalidateSize();
      }

    },
    100
  );
}


/* =========================================================
   RAFRAICHISSEMENT AFFICHAGE GPS
   ========================================================= */

function refreshGpsDisplay() {

  initGpsMap();


  if (lastGpsData) {

    /*
      On reconstruit volontairement un objet dans le format
      attendu afin de réafficher la dernière position.
    */

    applyGpsData({

      gps_valid:
        lastGpsData.valid,

      gps_lat:
        lastGpsData.latitude,

      gps_lon:
        lastGpsData.longitude,

      gps_alt:
        lastGpsData.altitude,

      gps_satellites:
        lastGpsData.satellites,

      gps_hdop:
        lastGpsData.hdop

    });
  }


  setTimeout(
    () => {

      if (gpsMap) {

        gpsMap.invalidateSize();
      }

    },
    100
  );
}


/* =========================================================
   BOUTON ACTUALISER GPS
   ========================================================= */

function wireGpsControls() {

  $("btnRefreshGps")
    ?.addEventListener(
      "click",
      async () => {

        /*
          Pour l'instant, le bouton demande simplement
          immédiatement la dernière donnée disponible
          sur Render.

          Il ne commande PAS le panneau.
        */

        await pollESP32Data();


        refreshGpsDisplay();
      }
    );
}


/* =========================================================
   ESP32
   ========================================================= */

async function checkESP32() {

  try {

    const res =
      await fetch(
        `${API_URL}/api/esp32/status`
      );

    const data =
      await res.json();


    esp32Connected =
      data.connected === true;


    if ($("conn")) {

      if (!currentUser) {

        $("conn").textContent =
          "Connectez-vous pour voir les données";

      }
      else {

        $("conn").textContent =
          esp32Connected
            ? "ESP32 : Connectée"
            : "ESP32 : Déconnectée";
      }
    }


    if ($("esp32Status")) {

      $("esp32Status").textContent =
        esp32Connected
          ? "Connectée"
          : "Déconnectée";

      $("esp32Status").className =
        esp32Connected
          ? "connected"
          : "disconnected";
    }


    if ($("esp32LastSeen")) {
      $("esp32LastSeen").textContent =
        data.lastSeen || "—";
    }


    if ($("esp32Ip")) {
      $("esp32Ip").textContent =
        data.ip || "—";
    }


    if ($("topEspDot")) {

      $("topEspDot").style.background =
        esp32Connected
          ? "#22c55e"
          : "#ef4444";
    }


    updateControls();

  }
  catch (err) {

    esp32Connected =
      false;


    if ($("conn")) {

      $("conn").textContent =
        currentUser
          ? "ESP32 : Déconnectée"
          : "Connectez-vous pour voir les données";
    }


    if ($("esp32Status")) {

      $("esp32Status").textContent =
        "Déconnectée";

      $("esp32Status").className =
        "disconnected";
    }


    if ($("topEspDot")) {
      $("topEspDot").style.background =
        "#ef4444";
    }


    updateControls();
  }
}


/* =========================================================
   ENVOI COMMANDE
   ========================================================= */

async function sendCmd(o) {

  /* =====================================================
     VERIFICATION CONNEXION UTILISATEUR
     ===================================================== */

  if (!currentUser) {

    alert(
      "Vous devez vous connecter pour commander le panneau."
    );

    return false;
  }


  /* =====================================================
     VERIFICATION ROLE
     ===================================================== */

  if (!canControlESP32) {

    alert(
      "Votre compte est en lecture seule. Seuls un manager ou un administrateur peuvent commander le panneau."
    );

    return false;
  }


  /* =====================================================
     VERIFICATION ESP32
     ===================================================== */

  if (!esp32Connected) {

    alert(
      "ESP32 déconnectée."
    );

    return false;
  }


  /* =====================================================
     TOKEN
     ===================================================== */

  const token =
    getToken();


  if (!token) {

    alert(
      "Session expirée. Reconnectez-vous."
    );

    return false;
  }


  /* =====================================================
     ENVOI COMMANDE
     ===================================================== */

  try {


    const res =
      await fetch(

        `${API_URL}/api/esp32/command`,

        {

          method:
            "POST",


          headers:
            authHeaders({

              "Content-Type":
                "application/json"

            }),


          body:
            JSON.stringify(o)

        }

      );


    const result =
      await res
        .json()
        .catch(
          () => ({})
        );


    /* ===================================================
       COMMANDE REFUSEE
       =================================================== */

    if (!res.ok) {


      if (
        res.status === 401
      ) {

        alert(
          "Votre session a expiré. Reconnectez-vous."
        );

      }

      else if (
        res.status === 403
      ) {

        alert(
          result.error ||
          "Vous n'avez pas l'autorisation d'effectuer cette commande."
        );

      }

      else {

        alert(
          result.error ||
          "Erreur lors de l'envoi de la commande."
        );

      }


      return false;
    }


    return true;

  }


  catch (err) {


    console.error(
      "sendCmd:",
      err
    );


    alert(
      "Impossible d'envoyer la commande au serveur."
    );


    return false;

  }
}

/* =========================================================
   RECEPTION DONNEES ESP32
   ========================================================= */

async function pollESP32Data() {

  if (!currentUser)
    return;


  const token =
    getToken();


  if (!token)
    return;


  try {

    const res =
      await fetch(
        `${API_URL}/api/esp32/data`,
        {
          headers:
            authHeaders()
        }
      );


    if (!res.ok)
      return;


    const s =
      await res.json();


    if (
      !s ||
      typeof s !== "object"
    )
      return;


    const signature =
      JSON.stringify(s);


    if (
      signature ===
      lastDataSignature
    )
      return;


    lastDataSignature =
      signature;


    /* =====================================================
       GPS

       On traite les informations GPS quel que soit
       le type de message reçu.

       Ainsi un snapshot, un message temps réel ou un autre
       état pourra mettre à jour la localisation.
       ===================================================== */

    applyGpsData(s);


    /* =====================================================
       SNAPSHOT
       ===================================================== */

    if (
      s.info ===
      "snapshot"
    ) {

      if ("servo1_deg" in s) {

        setServoAngleUI(
          1,
          s.servo1_deg
        );
      }


      if ("servo2_deg" in s) {

        setServoAngleUI(
          2,
          s.servo2_deg
        );
      }


      applyOrientationStatus(s);


      return;
    }


    /* =====================================================
       RESUME I-V
       ===================================================== */

    if (
      s.info ===
      "iv_summary"
    ) {

      await applyIvSummary(s);

    }

    else {

      applySample(s);
    }

  }

  catch (err) {

    console.error(
      "pollESP32Data:",
      err
    );
  }
}


/* =========================================================
   ORIENTATION
   ========================================================= */

let currentOrientMode =
  "manual";

let currentTracker =
  false;

let pendingOrientUntil =
  0;

let pendingTrackerUntil =
  0;

let pendingServoUntil =
  0;


function getSelectedOrientMode() {

  const el =
    document.querySelector(
      'input[name="orientMode"]:checked'
    );

  return el
    ? el.value
    : currentOrientMode ||
      "manual";
}


function setOrientModeUI(
  mode,
  updateRadio = true
) {

  if (!mode)
    return;


  currentOrientMode =
    String(mode);


  if (updateRadio) {

    const radio =
      document.querySelector(
        `input[name="orientMode"][value="${currentOrientMode}"]`
      );

    if (radio) {
      radio.checked =
        true;
    }
  }


  if ($("orientModeTxt")) {
    $("orientModeTxt").textContent =
      currentOrientMode;
  }


  if ($("orientModeBar")) {
    $("orientModeBar").textContent =
      currentOrientMode;
  }
}


function setTrackerUI(enabled) {

  currentTracker =
    !!enabled;


  if ($("trackerTxt")) {

    $("trackerTxt").textContent =
      currentTracker
        ? "ON"
        : "OFF";
  }
}


function setBoolTxt(id, v) {

  const el =
    $(id);

  if (!el)
    return;


  if (
    v === null ||
    v === undefined
  ) {

    el.textContent =
      "—";

  }
  else {

    el.textContent =
      v
        ? "ON"
        : "OFF";
  }
}


function applyOrientationStatus(s) {

  if (
    !s ||
    typeof s !== "object"
  )
    return;


  const now =
    Date.now();


  if (
    "orient_mode" in s &&
    now > pendingOrientUntil
  ) {

    currentOrientMode =
      String(
        s.orient_mode
      );


    if ($("orientModeTxt")) {

      $("orientModeTxt").textContent =
        currentOrientMode;
    }


    if ($("orientModeBar")) {

      $("orientModeBar").textContent =
        currentOrientMode;
    }
  }


  if (
    "tracker" in s &&
    now > pendingTrackerUntil
  ) {

    setTrackerUI(
      !!s.tracker
    );
  }


  /*
    LDR vue générale
  */

  if ("ldr_l" in s) {
    setBoolTxt(
      "ldrL",
      !!s.ldr_l
    );

    setBoolTxt(
      "ldrOrientationL",
      !!s.ldr_l
    );
  }


  if ("ldr_r" in s) {

    setBoolTxt(
      "ldrR",
      !!s.ldr_r
    );

    setBoolTxt(
      "ldrOrientationR",
      !!s.ldr_r
    );
  }


  if ("ldr_h" in s) {

    setBoolTxt(
      "ldrH",
      !!s.ldr_h
    );

    setBoolTxt(
      "ldrOrientationH",
      !!s.ldr_h
    );
  }


  if ("ldr_b" in s) {

    setBoolTxt(
      "ldrB",
      !!s.ldr_b
    );

    setBoolTxt(
      "ldrOrientationB",
      !!s.ldr_b
    );
  }


  if (
    "servo1_deg" in s &&
    now > pendingServoUntil
  ) {

    setServoAngleUI(
      1,
      s.servo1_deg
    );
  }


  if (
    "servo2_deg" in s &&
    now > pendingServoUntil
  ) {

    setServoAngleUI(
      2,
      s.servo2_deg
    );
  }
}


function sendOrientMode() {

  const mode =
    getSelectedOrientMode();


  pendingOrientUntil =
    Date.now() + 3000;


  setOrientModeUI(
    mode,
    true
  );


  sendCmd({
    cmd:
      "orient",

    mode
  });
}


/* =========================================================
   CHARTS
   ========================================================= */

let luxChart;
let tempChart;
let humChart;
let tcChart;

let uiChart;
let pChart;
let iChart;
let uChart;

let lastIsc = null;
let lastVoc = null;


/* Temps réel capteurs */

const histLabels = [];
const histLux = [];
const histTemp = [];
const histHum = [];
const histTc = [];


/* Vue temporelle */

let WIN_SIZE = 150;

let scrollPos = 0;

let autoFollow = true;

let VIEW_START = 0;


/* Scan */

let currentScanSamples = [];

let wasScanning = false;

let lastIvPoints = null;

let lastIvMeta = null;


/* Historique permanent */

let ivHistory = [];

let selectedScanId = null;


/* Couleurs */

const C = {

  lux:
    "#fbbf24",

  temp:
    "#fb7185",

  hum:
    "#22d3ee",

  tc:
    "#34d399",

  iu:
    "#60a5fa",

  pu:
    "#f59e0b",

  ik:
    "#fb7185",

  uk:
    "#22d3ee",

  mpp:
    "#facc15",

  isc:
    "#ef4444",

  voc:
    "#22c55e",

  ref:
    "rgba(226,232,240,.7)",

  vmpp:
    "#a78bfa",

  impp:
    "#93c5fd"
};


/* =========================================================
   HELPERS CHART
   ========================================================= */

function iuPointsToK(pointsIU) {

  const uK = [];
  const iK = [];


  for (
    let k = 0;
    k < pointsIU.length;
    k++
  ) {

    const p =
      pointsIU[k];


    uK.push({
      x: k,
      y: p.x
    });


    iK.push({
      x: k,
      y: p.y
    });
  }


  return {
    uK,
    iK
  };
}


function line2pts(n, y) {

  return [
    {
      x: 0,
      y
    },

    {
      x:
        Math.max(
          1,
          n - 1
        ),

      y
    }
  ];
}


function autoscaleIaxis(Isc) {

  if (!uiChart)
    return;


  if (
    !Number.isFinite(Isc) ||
    Isc <= 0
  )
    return;


  let step =
    0.02;


  if (Isc < 0.2)
    step = 0.01;


  if (Isc < 0.08)
    step = 0.005;


  let yMax =
    Isc * 1.20;


  yMax =
    Math.ceil(
      yMax / step
    ) * step;


  uiChart.options.scales.yI.min =
    0;

  uiChart.options.scales.yI.max =
    yMax;

  uiChart.options.scales.yI.ticks.stepSize =
    step;
}


/* =========================================================
   CREATION GRAPHIQUE CAPTEUR
   ========================================================= */

function createSensorChart(
  canvasId,
  label,
  unit,
  color
) {

  const canvas =
    $(canvasId);

  if (!canvas)
    return null;


  return new Chart(
    canvas,
    {
      type:
        "line",

      data: {
        labels:
          [],

        datasets: [
          {
            label:
              `${label} (${unit})`,

            data:
              [],

            borderColor:
              color,

            backgroundColor:
              color,

            pointRadius:
              0,

            borderWidth:
              2,

            tension:
              0.25,

            fill:
              false
          }
        ]
      },

      options: {

        responsive:
          true,

        maintainAspectRatio:
          false,

        animation:
          false,

        interaction: {
          mode:
            "nearest",

          intersect:
            false
        },

        plugins: {

          legend: {
            labels: {
              color:
                "#dbe7f7"
            }
          },

          tooltip: {

            callbacks: {

              label:
                (ctx) => {

                  const v =
                    ctx.parsed.y;

                  if (
                    v === null ||
                    v === undefined
                  ) {

                    return `${label}: —`;
                  }


                  return (
                    `${label}: ` +
                    `${fmt(v, 2)} ${unit}`
                  );
                }
            }
          }
        },

        scales: {

          x: {

            ticks: {
              color:
                "#93a8c8",

              maxTicksLimit:
                10
            },

            grid: {
              color:
                "rgba(140,170,255,.10)"
            },

            title: {
              display:
                true,

              text:
                "Échantillon",

              color:
                "#93a8c8"
            }
          },

          y: {

            ticks: {
              color:
                "#93a8c8"
            },

            grid: {
              color:
                "rgba(140,170,255,.10)"
            },

            title: {
              display:
                true,

              text:
                unit,

              color:
                "#93a8c8"
            }
          }
        }
      }
    }
  );
}


/* =========================================================
   INITIALISATION CHARTS
   ========================================================= */

function initCharts() {

  luxChart =
    createSensorChart(
      "luxChart",
      "Luminosité",
      "lx",
      C.lux
    );


  tempChart =
    createSensorChart(
      "tempChart",
      "Température DHT",
      "°C",
      C.temp
    );


  humChart =
    createSensorChart(
      "humChart",
      "Humidité",
      "%",
      C.hum
    );


  tcChart =
    createSensorChart(
      "tcChart",
      "Thermocouple",
      "°C",
      C.tc
    );


  const commonXY = {

    responsive:
      true,

    maintainAspectRatio:
      false,

    animation:
      false,

    interaction: {
      mode:
        "nearest",

      intersect:
        false
    },

    plugins: {

      legend: {
        labels: {
          color:
            "#e5edff"
        }
      },

      tooltip: {
        enabled:
          true
      }
    },

    scales: {

      x: {

        ticks: {
          color:
            "#d0dcff"
        },

        grid: {
          color:
            "rgba(140,170,255,.15)"
        }
      },

      y: {

        ticks: {
          color:
            "#d0dcff"
        },

        grid: {
          color:
            "rgba(140,170,255,.15)"
        }
      }
    }
  };


  /* ========================
     I(U)
     ======================== */

  uiChart =
    new Chart(
      $("uiChart"),
      {
        type:
          "scatter",

        data: {

          datasets: [

            {
              label:
                "I(U)",

              data:
                [],

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              tension:
                .25,

              yAxisID:
                "yI",

              borderColor:
                C.iu
            },

            {
              label:
                "Vmpp",

              data:
                [],

              borderDash:
                [6,6],

              pointRadius:
                0,

              showLine:
                true,

              yAxisID:
                "yI",

              borderColor:
                C.vmpp
            },

            {
              label:
                "Impp",

              data:
                [],

              borderDash:
                [6,6],

              pointRadius:
                0,

              showLine:
                true,

              yAxisID:
                "yI",

              borderColor:
                C.impp
            },

            {
              label:
                "MPP",

              data:
                [],

              pointRadius:
                5,

              showLine:
                false,

              yAxisID:
                "yI",

              pointBackgroundColor:
                C.mpp,

              pointBorderColor:
                C.mpp
            },

            {
              label:
                "Isc",

              data:
                [],

              pointRadius:
                5,

              showLine:
                false,

              yAxisID:
                "yI",

              pointBackgroundColor:
                C.isc,

              pointBorderColor:
                C.isc
            },

            {
              label:
                "Voc",

              data:
                [],

              pointRadius:
                5,

              showLine:
                false,

              yAxisID:
                "yI",

              pointBackgroundColor:
                C.voc,

              pointBorderColor:
                C.voc
            }
          ]
        },

        options: {

          responsive:
            true,

          maintainAspectRatio:
            false,

          animation:
            false,

          interaction: {
            mode:
              "nearest",

            intersect:
              false
          },

          plugins: {

            legend: {
              labels: {
                color:
                  "#e5edff"
              }
            }
          },

          scales: {

            x: {

              min:
                0,

              max:
                20,

              title: {
                display:
                  true,

                text:
                  "Tension U (V)",

                color:
                  "#e5edff"
              },

              ticks: {
                color:
                  "#d0dcff"
              },

              grid: {
                color:
                  "rgba(140,170,255,.15)"
              }
            },

            yI: {

              min:
                0,

              max:
                3,

              title: {
                display:
                  true,

                text:
                  "Intensité I (A)",

                color:
                  "#e5edff"
              },

              ticks: {
                color:
                  "#d0dcff"
              },

              grid: {
                color:
                  "rgba(140,170,255,.15)"
              }
            }
          }
        }
      }
    );


  /* ========================
     P(U)
     ======================== */

  pChart =
    new Chart(
      $("pChart"),
      {
        type:
          "scatter",

        data: {

          datasets: [
            {
              label:
                "P(U)",

              data:
                [],

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              tension:
                .25,

              yAxisID:
                "yP",

              borderColor:
                C.pu
            }
          ]
        },

        options: {

          responsive:
            true,

          maintainAspectRatio:
            false,

          animation:
            false,

          interaction: {
            mode:
              "nearest",

            intersect:
              false
          },

          plugins: {
            legend: {
              labels: {
                color:
                  "#e5edff"
              }
            }
          },

          scales: {

            x: {

              min:
                0,

              max:
                20,

              title: {
                display:
                  true,

                text:
                  "Tension U (V)",

                color:
                  "#e5edff"
              },

              ticks: {
                color:
                  "#d0dcff"
              },

              grid: {
                color:
                  "rgba(140,170,255,.15)"
              }
            },

            yP: {

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Puissance P (W)",

                color:
                  "#e5edff"
              },

              ticks: {
                color:
                  "#d0dcff"
              },

              grid: {
                color:
                  "rgba(140,170,255,.15)"
              }
            }
          }
        }
      }
    );


  /* ========================
     I(k)
     ======================== */

  iChart =
    new Chart(
      $("iChart"),
      {
        type:
          "scatter",

        data: {

          datasets: [

            {
              label:
                "I(k)",

              data:
                [],

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              tension:
                .25,

              borderColor:
                C.ik
            },

            {
              label:
                "I = 0",

              data:
                [],

              borderDash:
                [6,6],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.ref
            },

            {
              label:
                "Isc",

              data:
                [],

              borderDash:
                [4,4],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.isc
            },

            {
              label:
                "Iref",

              data:
                [],

              borderDash:
                [4,4],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.vmpp
            }
          ]
        },

        options: {

          ...commonXY,

          scales: {

            x: {
              ...commonXY.scales.x,

              title: {
                display:
                  true,

                text:
                  "k (indice de mesure)",

                color:
                  "#e5edff"
              }
            },

            y: {
              ...commonXY.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "I (A)",

                color:
                  "#e5edff"
              }
            }
          }
        }
      }
    );


  /* ========================
     U(k)
     ======================== */

  uChart =
    new Chart(
      $("uChart"),
      {
        type:
          "scatter",

        data: {

          datasets: [

            {
              label:
                "U(k)",

              data:
                [],

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              tension:
                .25,

              borderColor:
                C.uk
            },

            {
              label:
                "U = 0",

              data:
                [],

              borderDash:
                [6,6],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.ref
            },

            {
              label:
                "Voc",

              data:
                [],

              borderDash:
                [4,4],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.voc
            },

            {
              label:
                "Uref",

              data:
                [],

              borderDash:
                [4,4],

              pointRadius:
                0,

              showLine:
                true,

              borderColor:
                C.vmpp
            }
          ]
        },

        options: {

          ...commonXY,

          scales: {

            x: {
              ...commonXY.scales.x,

              title: {
                display:
                  true,

                text:
                  "k (indice de mesure)",

                color:
                  "#e5edff"
              }
            },

            y: {
              ...commonXY.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "U (V)",

                color:
                  "#e5edff"
              }
            }
          }
        }
      }
    );
}


/* =========================================================
   REDIMENSIONNEMENT
   ========================================================= */

function resizeAllCharts() {

  [
    luxChart,
    tempChart,
    humChart,
    tcChart,
    uiChart,
    pChart,
    iChart,
    uChart
  ]
    .filter(Boolean)
    .forEach(chart => {

      try {
        chart.resize();
      }
      catch {}
    });
}


/* =========================================================
   REPERES I / U
   ========================================================= */

function updateRefs() {

  if (
    !iChart ||
    !uChart
  )
    return;


  const chkI0 =
    $("chkI0")?.checked;

  const chkU0 =
    $("chkU0")?.checked;

  const chkIsc =
    $("chkIsc")?.checked;

  const chkVoc =
    $("chkVoc")?.checked;

  const chkUref =
    $("chkUref")?.checked;

  const chkIref =
    $("chkIref")?.checked;


  const Uref =
    Number(
      $("uRefVal")?.value
    );

  const Iref =
    Number(
      $("iRefVal")?.value
    );


  const n =
    iChart
      ?.data
      ?.datasets
      ?.[0]
      ?.data
      ?.length ?? 0;


  iChart.data.datasets[1].data =
    chkI0
      ? line2pts(n, 0)
      : [];


  iChart.data.datasets[2].data =
    (
      chkIsc &&
      Number.isFinite(lastIsc)
    )
      ? line2pts(
          n,
          lastIsc
        )
      : [];


  iChart.data.datasets[3].data =
    (
      chkIref &&
      Number.isFinite(Iref)
    )
      ? line2pts(
          n,
          Iref
        )
      : [];


  uChart.data.datasets[1].data =
    chkU0
      ? line2pts(n, 0)
      : [];


  uChart.data.datasets[2].data =
    (
      chkVoc &&
      Number.isFinite(lastVoc)
    )
      ? line2pts(
          n,
          lastVoc
        )
      : [];


  uChart.data.datasets[3].data =
    (
      chkUref &&
      Number.isFinite(Uref)
    )
      ? line2pts(
          n,
          Uref
        )
      : [];


  iChart.update("none");
  uChart.update("none");
}


function wireRefInputs() {

  [
    "chkI0",
    "chkU0",
    "chkIsc",
    "chkVoc",
    "chkUref",
    "chkIref",
    "uRefVal",
    "iRefVal"
  ]
    .forEach(id => {

      const el =
        $(id);

      if (!el)
        return;


      el.addEventListener(
        "input",
        updateRefs
      );

      el.addEventListener(
        "change",
        updateRefs
      );
    });
}


/* =========================================================
   GRAPHIQUES CAPTEURS TEMPS REEL
   ========================================================= */

function refreshSensorViewport() {

  const L =
    histLabels.length;


  const maxStart =
    Math.max(
      0,
      L - WIN_SIZE
    );


  if (autoFollow) {
    scrollPos =
      maxStart;
  }


  scrollPos =
    Math.min(
      Math.max(
        0,
        scrollPos
      ),
      maxStart
    );


  const slider =
    $("chartScroll");


  if (slider) {

    slider.max =
      String(maxStart);

    slider.value =
      String(scrollPos);
  }


  const start =
    scrollPos;

  const end =
    Math.min(
      L,
      start + WIN_SIZE
    );


  VIEW_START =
    start;


  const labels =
    histLabels.slice(
      start,
      end
    );


  const apply =
    (
      chart,
      values
    ) => {

      if (!chart)
        return;


      chart.data.labels =
        labels;


      chart.data.datasets[0].data =
        values.slice(
          start,
          end
        );


      chart.update(
        "none"
      );
    };


  apply(
    luxChart,
    histLux
  );


  apply(
    tempChart,
    histTemp
  );


  apply(
    humChart,
    histHum
  );


  apply(
    tcChart,
    histTc
  );
}


/*
  Ancien nom conservé pour compatibilité
*/
function refreshLineViewport() {
  refreshSensorViewport();
}


/* =========================================================
   STATS
   ========================================================= */

function avg(arr) {

  const v =
    arr.filter(
      x =>
        Number.isFinite(x)
    );


  if (!v.length)
    return null;


  return (
    v.reduce(
      (a,b) =>
        a + b,
      0
    )
    /
    v.length
  );
}


function stats(arr) {

  const v =
    arr.filter(
      x =>
        Number.isFinite(x)
    );


  if (!v.length) {

    return {
      min:
        null,

      avg:
        null,

      max:
        null
    };
  }


  let min =
    v[0];

  let max =
    v[0];

  let sum =
    0;


  for (const x of v) {

    min =
      Math.min(
        min,
        x
      );

    max =
      Math.max(
        max,
        x
      );

    sum += x;
  }


  return {

    min,

    avg:
      sum /
      v.length,

    max
  };
}


function fmtMinAvgMax(
  s,
  nd = 1,
  unit = ""
) {

  if (
    !Number.isFinite(s.min) ||
    !Number.isFinite(s.avg) ||
    !Number.isFinite(s.max)
  ) {

    return "—";
  }


  const u =
    unit
      ? ` ${unit}`
      : "";


  return (
    `${fmt(s.min,nd)} / ` +
    `${fmt(s.avg,nd)} / ` +
    `${fmt(s.max,nd)}${u}`
  );
}


/* =========================================================
   NORMALISATION HISTORIQUE
   ========================================================= */

function normalizeMeasurement(raw) {

  if (!raw)
    return null;


  const metaRaw =
    raw.meta || {};


  const envRaw =
    raw.env || {};


  let points =
    raw.points || [];


  points =
    points.map(
      (p, index) => {

        if (
          Array.isArray(p)
        ) {

          return {
            x:
              Number(p[0]),

            y:
              Number(p[1])
          };
        }


        return {
          x:
            Number(
              p.x ??
              p.u_v ??
              p.u ??
              0
            ),

          y:
            Number(
              p.y ??
              p.i_a ??
              p.i ??
              0
            ),

          k:
            Number(
              p.k ??
              index
            )
        };
      }
    );


  const samples =
    Array.isArray(raw.samples)
      ? raw.samples
      : [];


  return {

    id:
      raw.id ??
      raw.measurement_id,

    ts:
      raw.ts
      ? Number(raw.ts)
      : (
          raw.created_at
            ? new Date(
                raw.created_at
              ).getTime()
            : Date.now()
        ),

    created_at:
      raw.created_at,

    loaded:
      points.length > 0,

    points,

    samples,

    meta: {

      vmpp:
        Number(
          metaRaw.vmpp ??
          raw.vmpp
        ),

      impp:
        Number(
          metaRaw.impp ??
          raw.impp
        ),

      pmpp:
        Number(
          metaRaw.pmpp ??
          raw.pmpp
        ),

      isc:
        Number(
          metaRaw.isc ??
          raw.isc
        ),

      voc:
        Number(
          metaRaw.voc ??
          raw.voc
        ),

      umax:
        Number(
          metaRaw.umax ??
          raw.umax
        ),

      servo1_deg:
        Number(
          metaRaw.servo1_deg ??
          raw.servo1_deg
        ),

      servo2_deg:
        Number(
          metaRaw.servo2_deg ??
          raw.servo2_deg
        ),

      orient_mode:
        metaRaw.orient_mode ??
        raw.orient_mode ??
        "manual",

      series:
        Number(
          metaRaw.series ??
          raw.series_no ??
          raw.series ??
          0
        )
    },

    env: {

      luxAvg:
        Number(
          envRaw.luxAvg ??
          raw.lux_avg
        ),

      tempAvg:
        Number(
          envRaw.tempAvg ??
          raw.temp_avg
        ),

      humAvg:
        Number(
          envRaw.humAvg ??
          raw.hum_avg
        ),

      tcAvg:
        Number(
          envRaw.tcAvg ??
          raw.tc_avg
        )
    },

    points_count:
      Number(
        raw.points_count ??
        points.length
      )
  };
}


/* =========================================================
   API HISTORIQUE
   ========================================================= */

async function loadMeasurementHistory() {

  if (!currentUser)
    return;


  try {

    const res =
      await fetch(
        `${API_URL}/api/measurements`,
        {
          headers:
            authHeaders()
        }
      );


    /*
      Tant que le backend n'est pas encore modifié,
      on ne détruit pas l'historique local.
    */
    if (!res.ok)
      return;


    const data =
      await res.json();


    const list =
      Array.isArray(data)
        ? data
        : (
            Array.isArray(
              data.measurements
            )
              ? data.measurements
              : []
          );


    ivHistory =
      list
        .map(
          normalizeMeasurement
        )
        .filter(Boolean);


    renderHistoryList();

  }
  catch (err) {

    console.warn(
      "Historique DB indisponible :",
      err
    );
  }
}


/* =========================================================
   CHARGEMENT DETAIL MESURE
   ========================================================= */

async function ensureMeasurementLoaded(
  entry
) {

  if (!entry)
    return null;


  if (
    entry.loaded &&
    entry.points?.length
  ) {

    return entry;
  }


  try {

    const res =
      await fetch(
        `${API_URL}/api/measurements/${encodeURIComponent(entry.id)}`,
        {
          headers:
            authHeaders()
        }
      );


    if (!res.ok) {

      throw new Error(
        `HTTP ${res.status}`
      );
    }


    const raw =
      await res.json();


    const full =
      normalizeMeasurement(raw);


    if (!full)
      return entry;


    const idx =
      ivHistory.findIndex(
        x =>
          String(x.id) ===
          String(entry.id)
      );


    if (idx >= 0) {

      ivHistory[idx] =
        full;
    }


    return full;

  }
  catch (err) {

    console.error(
      "Impossible de charger la mesure:",
      err
    );

    return entry;
  }
}


/* =========================================================
   SAUVEGARDE MESURE DB
   ========================================================= */

async function saveMeasurementToDatabase(
  entry
) {

  const token =
    getToken();


  if (!token)
    return null;


  try {

    const payload = {

      series_no:
        entry.meta.series,

      orient_mode:
        entry.meta.orient_mode,

      servo1_deg:
        entry.meta.servo1_deg,

      servo2_deg:
        entry.meta.servo2_deg,

      vmpp:
        entry.meta.vmpp,

      impp:
        entry.meta.impp,

      pmpp:
        entry.meta.pmpp,

      isc:
        entry.meta.isc,

      voc:
        entry.meta.voc,

      umax:
        entry.meta.umax,

      lux_avg:
        entry.env.luxAvg,

      temp_avg:
        entry.env.tempAvg,

      hum_avg:
        entry.env.humAvg,

      tc_avg:
        entry.env.tcAvg,

      /*
        Les 256 points de la courbe.
      */
      points:
        entry.points.map(
          (p,k) => ({
            k,

            u_v:
              p.x,

            i_a:
              p.y,

            p_w:
              p.x * p.y
          })
        ),

      /*
        Données environnementales reçues
        DURANT cette mesure uniquement.

        Rien n'est enregistré dans cette
        table hors mesure.
      */
      samples:
        entry.samples.map(
          s => ({

            k:
              s.k,

            seq:
              s.seq,

            ts_ms:
              s.ts_ms,

            line:
              s.line,

            u_v:
              s.u_v,

            i_a:
              s.i_a,

            lux:
              s.lux,

            temp_dht_c:
              s.temp_dht_c,

            hum_dht:
              s.hum_dht,

            tc_c:
              s.tc_c,

            servo1_deg:
              s.servo1_deg,

            servo2_deg:
              s.servo2_deg,

            orient_mode:
              s.orient_mode
          })
        )
    };


    const res =
      await fetch(
        `${API_URL}/api/measurements`,
        {
          method:
            "POST",

          headers:
            authHeaders({
              "Content-Type":
                "application/json"
            }),

          body:
            JSON.stringify(
              payload
            )
        }
      );


    if (!res.ok) {

      const error =
        await res
          .json()
          .catch(
            () => ({})
          );


      throw new Error(
        error.error ||
        `HTTP ${res.status}`
      );
    }


    const saved =
      await res.json();


    return saved;

  }
  catch (err) {

    console.error(
      "Sauvegarde mesure impossible:",
      err
    );


    /*
      La courbe reste quand même visible
      dans le navigateur.
    */
    return null;
  }
}


/* =========================================================
   DETAILS HISTORIQUE
   ========================================================= */

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
    ]
      .forEach(id => {

        if ($(id)) {
          $(id).textContent =
            "—";
        }
      });


    return;
  }


  if ($("histSelId")) {

    $("histSelId").textContent =
      String(entry.id ?? "—");
  }


  if ($("histSelTs")) {

    $("histSelTs").textContent =
      new Date(
        entry.ts
      ).toLocaleString();
  }


  if ($("histSelPts")) {

    $("histSelPts").textContent =
      String(
        entry.points?.length ||
        entry.points_count ||
        0
      );
  }


  let dur =
    null;


  if (
    entry.samples?.length
  ) {

    const t0 =
      entry.samples[0]
        ?.ts_ms;

    const t1 =
      entry.samples
        .at(-1)
        ?.ts_ms;


    if (
      Number.isFinite(t0) &&
      Number.isFinite(t1) &&
      t1 >= t0
    ) {

      dur =
        t1 - t0;
    }
  }


  if ($("histSelDur")) {

    $("histSelDur").textContent =
      dur === null
        ? "—"
        : `${dur} ms`;
  }


  const s =
    entry.samples || [];


  if (
    s.length
  ) {

    if ($("histLux")) {

      $("histLux").textContent =
        fmtMinAvgMax(
          stats(
            s.map(
              r => r.lux
            )
          ),
          0,
          "lx"
        );
    }


    if ($("histTemp")) {

      $("histTemp").textContent =
        fmtMinAvgMax(
          stats(
            s.map(
              r =>
                r.temp_dht_c
            )
          ),
          1,
          "°C"
        );
    }


    if ($("histHum")) {

      $("histHum").textContent =
        fmtMinAvgMax(
          stats(
            s.map(
              r =>
                r.hum_dht
            )
          ),
          0,
          "%"
        );
    }


    if ($("histTc")) {

      $("histTc").textContent =
        fmtMinAvgMax(
          stats(
            s.map(
              r => r.tc_c
            )
          ),
          1,
          "°C"
        );
    }
  }
  else {

    if ($("histLux")) {

      $("histLux").textContent =
        Number.isFinite(
          entry.env?.luxAvg
        )
          ? `${fmt(entry.env.luxAvg,0)} lx`
          : "—";
    }


    if ($("histTemp")) {

      $("histTemp").textContent =
        Number.isFinite(
          entry.env?.tempAvg
        )
          ? `${fmt(entry.env.tempAvg,1)} °C`
          : "—";
    }


    if ($("histHum")) {

      $("histHum").textContent =
        Number.isFinite(
          entry.env?.humAvg
        )
          ? `${fmt(entry.env.humAvg,0)} %`
          : "—";
    }


    if ($("histTc")) {

      $("histTc").textContent =
        Number.isFinite(
          entry.env?.tcAvg
        )
          ? `${fmt(entry.env.tcAvg,1)} °C`
          : "—";
    }
  }
}


/* =========================================================
   LISTE HISTORIQUE
   ========================================================= */

function renderHistoryList() {

  const root =
    $("historyList");


  if (!root)
    return;


  root.innerHTML =
    "";


  if (!ivHistory.length) {

    root.innerHTML =
      `<div class="badge">Aucune mesure enregistrée.</div>`;

    updateHistoryDetails(
      null
    );

    return;
  }


  const items =
    [...ivHistory]
      .sort(
        (a,b) =>
          b.ts - a.ts
      );


  for (
    const entry
    of items
  ) {

    const dt =
      new Date(entry.ts);


    const m =
      entry.meta || {};


    const sx =
      Number.isFinite(
        m.servo1_deg
      )
        ? `${m.servo1_deg | 0}°`
        : "—";


    const sy =
      Number.isFinite(
        m.servo2_deg
      )
        ? `${m.servo2_deg | 0}°`
        : "—";


    const row =
      document.createElement(
        "div"
      );


    row.className =
      "badge histItem";


    row.dataset.id =
      String(entry.id);


    row.style.cursor =
      "pointer";

    row.style.display =
      "flex";

    row.style.justifyContent =
      "space-between";

    row.style.gap =
      "12px";

    row.style.alignItems =
      "center";

    row.style.flexWrap =
      "wrap";


    if (
      String(selectedScanId) ===
      String(entry.id)
    ) {

      row.classList.add(
        "selected"
      );
    }


    const sub = [

      `Mode=${m.orient_mode || "—"}`,

      `RX=${sx}`,

      `RY=${sy}`,

      Number.isFinite(
        m.voc
      )
        ? `Voc=${fmt(m.voc,2)}V`
        : "Voc—",

      Number.isFinite(
        m.pmpp
      )
        ? `Pmpp=${fmt(m.pmpp,2)}W`
        : "Pmpp—",

      `Points=${
        entry.points?.length ||
        entry.points_count ||
        0
      }`

    ].join(" • ");


    row.innerHTML = `
      <div style="min-width:260px; flex:1">

        <div>
          <b>
            Mesure #${entry.id}
            —
            ${dt.toLocaleString()}
          </b>
        </div>

        <div style="opacity:.80; font-size:12px">
          ${sub}
        </div>

      </div>

      <div style="
        display:flex;
        gap:8px;
        align-items:center;
        flex-wrap:wrap;
      ">

        <button
          class="pill info"
          data-action="show"
        >
          Afficher
        </button>

        <button
          class="pill info"
          data-action="pdf"
        >
          PDF
        </button>

        <button
          class="pill info"
          data-action="csv"
        >
          CSV
        </button>

        <button
          class="pill off-btn esp32-control"
          data-action="del"
        >
          Supprimer
        </button>

      </div>
    `;


    row
      .querySelector(
        '[data-action="show"]'
      )
      ?.addEventListener(
        "click",
        async e => {

          e.stopPropagation();

          await showHistoryEntry(
            entry.id
          );
        }
      );


    row
      .querySelector(
        '[data-action="pdf"]'
      )
      ?.addEventListener(
        "click",
        async e => {

          e.stopPropagation();

          await downloadScanPdf(
            entry.id
          );
        }
      );


    row
      .querySelector(
        '[data-action="csv"]'
      )
      ?.addEventListener(
        "click",
        async e => {

          e.stopPropagation();

          await downloadScanMeasuresCsv(
            entry.id
          );
        }
      );


    row
      .querySelector(
        '[data-action="del"]'
      )
      ?.addEventListener(
        "click",
        async e => {

          e.stopPropagation();

          await deleteScan(
            entry.id
          );
        }
      );


    row.addEventListener(
      "click",
      async () => {

        await showHistoryEntry(
          entry.id
        );
      }
    );


    root.appendChild(
      row
    );
  }


  updateHistorySelectionUI();
}


/* =========================================================
   SELECTION HISTORIQUE
   ========================================================= */

function updateHistorySelectionUI() {

  document
    .querySelectorAll(
      ".histItem"
    )
    .forEach(el => {

      el.classList.toggle(
        "selected",

        String(
          el.dataset.id
        )
        ===
        String(
          selectedScanId
        )
      );
    });
}


/* =========================================================
   AFFICHAGE D'UNE MESURE
   ========================================================= */

async function showHistoryEntry(id) {

  let entry =
    ivHistory.find(
      x =>
        String(x.id) ===
        String(id)
    );


  if (!entry)
    return;


  entry =
    await ensureMeasurementLoaded(
      entry
    );


  selectedScanId =
    entry.id;


  renderMeasurementToCharts(
    entry
  );


  updateHistoryDetails(
    entry
  );


  updateHistorySelectionUI();
}


/* =========================================================
   AFFICHAGE MESURE SUR CHARTS
   ========================================================= */

function renderMeasurementToCharts(
  entry
) {

  if (
    !entry ||
    !entry.points?.length
  )
    return;


  const points =
    entry.points;


  const m =
    entry.meta || {};


  uiChart.data.datasets[0].data =
    points;


  pChart.data.datasets[0].data =
    points.map(
      p => ({
        x:
          p.x,

        y:
          p.x * p.y
      })
    );


  const maxU =
    Math.max(
      ...points.map(
        p => p.x
      )
    );


  const maxI =
    Math.max(
      ...points.map(
        p => p.y
      )
    );


  const maxP =
    Math.max(
      ...points.map(
        p =>
          p.x * p.y
      )
    );


  const xMaxAuto =
    Number.isFinite(maxU) &&
    maxU > 0

      ? Math.min(
          maxU * 1.15,
          PANEL_VOLTAGE_MAX
        )

      : 1;


  const yMaxAuto =
    Number.isFinite(maxI) &&
    maxI > 0

      ? maxI * 1.20

      : 1;


  const pMaxAuto =
    Number.isFinite(maxP) &&
    maxP > 0

      ? maxP * 1.25

      : 1;


  uiChart.options.scales.x.min =
    0;

  uiChart.options.scales.x.max =
    xMaxAuto;


  uiChart.options.scales.yI.min =
    0;

  uiChart.options.scales.yI.max =
    yMaxAuto;


  pChart.options.scales.x.min =
    0;

  pChart.options.scales.x.max =
    xMaxAuto;


  pChart.options.scales.yP.min =
    0;

  pChart.options.scales.yP.max =
    pMaxAuto;


  uiChart.data.datasets[1].data =
    (
      Number.isFinite(m.vmpp) &&
      Number.isFinite(m.impp)
    )
      ? [
          {
            x:
              m.vmpp,

            y:
              0
          },

          {
            x:
              m.vmpp,

            y:
              m.impp
          }
        ]
      : [];


  uiChart.data.datasets[2].data =
    (
      Number.isFinite(m.vmpp) &&
      Number.isFinite(m.impp)
    )
      ? [
          {
            x:
              0,

            y:
              m.impp
          },

          {
            x:
              m.vmpp,

            y:
              m.impp
          }
        ]
      : [];


  uiChart.data.datasets[3].data =
    (
      Number.isFinite(m.vmpp) &&
      Number.isFinite(m.impp)
    )
      ? [
          {
            x:
              m.vmpp,

            y:
              m.impp
          }
        ]
      : [];


  uiChart.data.datasets[4].data =
    Number.isFinite(m.isc)
      ? [
          {
            x:
              0,

            y:
              m.isc
          }
        ]
      : [];


  uiChart.data.datasets[5].data =
    Number.isFinite(m.voc)
      ? [
          {
            x:
              m.voc,

            y:
              0
          }
        ]
      : [];


  lastIsc =
    Number.isFinite(m.isc)
      ? m.isc
      : lastIsc;


  lastVoc =
    Number.isFinite(m.voc)
      ? m.voc
      : lastVoc;


  autoscaleIaxis(
    lastIsc
  );


  const {
    uK,
    iK
  } =
    iuPointsToK(
      points
    );


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


  if ($("uiCount")) {
    $("uiCount").textContent =
      String(
        points.length
      );
  }


  if ($("stepCount")) {
    $("stepCount").textContent =
      String(
        points.length
      );
  }


  if ($("vmpp")) {

    $("vmpp").textContent =
      Number.isFinite(m.vmpp)
        ? fmt(
            m.vmpp,
            2
          )
        : "—";
  }


  if ($("impp")) {

    $("impp").textContent =
      Number.isFinite(m.impp)
        ? fmt(
            m.impp,
            3
          )
        : "—";
  }


  if ($("pmpp")) {

    $("pmpp").textContent =
      Number.isFinite(m.pmpp)
        ? fmt(
            m.pmpp,
            2
          )
        : "—";
  }


  if ($("iscVal")) {

    $("iscVal").textContent =
      Number.isFinite(m.isc)
        ? fmt(
            m.isc,
            3
          )
        : "—";
  }


  if ($("vocVal")) {

    $("vocVal").textContent =
      Number.isFinite(m.voc)
        ? fmt(
            m.voc,
            2
          )
        : "—";
  }


  lastIvMeta =
    {...m};

  lastIvPoints =
    points.slice();


  uiChart.update("none");
  pChart.update("none");

  updateRefs();

  iChart.update("none");
  uChart.update("none");
}


/* =========================================================
   SUPPRESSION MESURE
   ========================================================= */

async function deleteScan(id) {

  const ok =
    confirm(
      `Supprimer définitivement la mesure #${id} ?`
    );


  if (!ok)
    return;


  try {

    const res =
      await fetch(
        `${API_URL}/api/measurements/${encodeURIComponent(id)}`,
        {
          method:
            "DELETE",

          headers:
            authHeaders()
        }
      );


    if (!res.ok) {

      const r =
        await res
          .json()
          .catch(
            () => ({})
          );


      throw new Error(
        r.error ||
        "Suppression impossible"
      );
    }


    ivHistory =
      ivHistory.filter(
        x =>
          String(x.id) !==
          String(id)
      );


    if (
      String(selectedScanId) ===
      String(id)
    ) {

      selectedScanId =
        null;

      updateHistoryDetails(
        null
      );
    }


    renderHistoryList();

  }
  catch (err) {

    console.error(err);

    alert(
      "Impossible de supprimer cette mesure."
    );
  }
}


/* =========================================================
   CSV
   ========================================================= */

function csvValue(v) {

  return (
    v === null ||
    v === undefined ||
    Number.isNaN(v)
  )
    ? ""
    : v;
}


async function downloadScanMeasuresCsv(
  id
) {

  let entry =
    ivHistory.find(
      x =>
        String(x.id) ===
        String(id)
    );


  if (!entry)
    return;


  entry =
    await ensureMeasurementLoaded(
      entry
    );


  if (!entry.points?.length) {

    alert(
      "Aucun point disponible pour cette mesure."
    );

    return;
  }


  let csv =
    "k;u_v;i_a;p_w;scan;date;servo1_deg;servo2_deg;orient_mode;vmpp;impp;pmpp;isc;voc\n";


  const m =
    entry.meta || {};


  entry.points
    .forEach(
      (p,k) => {

        csv += [

          k,

          csvValue(p.x),

          csvValue(p.y),

          csvValue(
            p.x * p.y
          ),

          entry.id,

          new Date(
            entry.ts
          ).toLocaleString(),

          csvValue(
            m.servo1_deg
          ),

          csvValue(
            m.servo2_deg
          ),

          csvValue(
            m.orient_mode
          ),

          csvValue(
            m.vmpp
          ),

          csvValue(
            m.impp
          ),

          csvValue(
            m.pmpp
          ),

          csvValue(
            m.isc
          ),

          csvValue(
            m.voc
          )

        ].join(";") +
        "\n";
      }
    );


  downloadTextFile(
    csv,
    `mesure_${entry.id}_IV.csv`,
    "text/csv;charset=utf-8"
  );
}


async function downloadAllMeasuresCsv() {

  if (!ivHistory.length) {

    alert(
      "Aucune mesure enregistrée."
    );

    return;
  }


  let csv =
    "scan;k;u_v;i_a;p_w;date;servo1_deg;servo2_deg;orient_mode;vmpp;impp;pmpp;isc;voc\n";


  for (
    const summary
    of ivHistory
  ) {

    const scan =
      await ensureMeasurementLoaded(
        summary
      );


    if (!scan.points?.length)
      continue;


    const m =
      scan.meta || {};


    scan.points
      .forEach(
        (p,k) => {

          csv += [

            scan.id,

            k,

            csvValue(p.x),

            csvValue(p.y),

            csvValue(
              p.x * p.y
            ),

            new Date(
              scan.ts
            ).toLocaleString(),

            csvValue(
              m.servo1_deg
            ),

            csvValue(
              m.servo2_deg
            ),

            csvValue(
              m.orient_mode
            ),

            csvValue(
              m.vmpp
            ),

            csvValue(
              m.impp
            ),

            csvValue(
              m.pmpp
            ),

            csvValue(
              m.isc
            ),

            csvValue(
              m.voc
            )

          ].join(";") +
          "\n";
        }
      );
  }


  downloadTextFile(
    csv,
    "solar_monitor_toutes_mesures.csv",
    "text/csv;charset=utf-8"
  );
}


function downloadTextFile(
  content,
  filename,
  type
) {

  const blob =
    new Blob(
      [content],
      {
        type
      }
    );


  const url =
    URL.createObjectURL(
      blob
    );


  const a =
    document.createElement(
      "a"
    );


  a.href =
    url;

  a.download =
    filename;


  document.body.appendChild(
    a
  );


  a.click();


  a.remove();


  setTimeout(
    () =>
      URL.revokeObjectURL(
        url
      ),
    500
  );
}


/* =========================================================
   PDF
   ========================================================= */

/*
  Charge jsPDF automatiquement.
  Aucun changement HTML nécessaire.
*/
let jsPdfPromise =
  null;


function ensureJsPdf() {

  if (
    window.jspdf?.jsPDF
  ) {

    return Promise.resolve(
      window.jspdf.jsPDF
    );
  }


  if (jsPdfPromise)
    return jsPdfPromise;


  jsPdfPromise =
    new Promise(
      (resolve,reject) => {

        const script =
          document.createElement(
            "script"
          );


        script.src =
          "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";


        script.onload =
          () => {

            if (
              window.jspdf?.jsPDF
            ) {

              resolve(
                window.jspdf.jsPDF
              );

            }
            else {

              reject(
                new Error(
                  "jsPDF non disponible"
                )
              );
            }
          };


        script.onerror =
          reject;


        document.head.appendChild(
          script
        );
      }
    );


  return jsPdfPromise;
}


/* =========================================================
   GENERATION IMAGE CHART POUR PDF
   ========================================================= */

function makePdfChartImage(
  type,
  data,
  options
) {

  const canvas =
    document.createElement(
      "canvas"
    );


  canvas.width =
    900;

  canvas.height =
    480;


  canvas.style.position =
    "fixed";

  canvas.style.left =
    "-10000px";

  canvas.style.top =
    "0";


  document.body.appendChild(
    canvas
  );


  const ctx =
    canvas.getContext(
      "2d"
    );


  /*
    Fond clair pour impression PDF
  */
  ctx.fillStyle =
    "#ffffff";

  ctx.fillRect(
    0,
    0,
    canvas.width,
    canvas.height
  );


  const chart =
    new Chart(
      canvas,
      {
        type,
        data,
        options
      }
    );


  chart.update();


  const image =
    chart.toBase64Image(
      "image/png",
      1
    );


  chart.destroy();

  canvas.remove();


  return image;
}


/* =========================================================
   PDF D'UNE MESURE
   ========================================================= */

async function downloadScanPdf(id) {

  let entry =
    ivHistory.find(
      x =>
        String(x.id) ===
        String(id)
    );


  if (!entry)
    return;


  entry =
    await ensureMeasurementLoaded(
      entry
    );


  if (!entry.points?.length) {

    alert(
      "Aucun point disponible pour cette mesure."
    );

    return;
  }


  try {

    const jsPDF =
      await ensureJsPdf();


    const points =
      entry.points;


    const m =
      entry.meta || {};


    const pu =
      points.map(
        p => ({
          x:
            p.x,

          y:
            p.x * p.y
        })
      );


    const {
      uK,
      iK
    } =
      iuPointsToK(
        points
      );


    const commonOptions = {

      responsive:
        false,

      animation:
        false,

      plugins: {

        legend: {
          labels: {
            color:
              "#111827"
          }
        }
      },

      scales: {

        x: {

          ticks: {
            color:
              "#374151"
          },

          grid: {
            color:
              "#e5e7eb"
          }
        },

        y: {

          ticks: {
            color:
              "#374151"
          },

          grid: {
            color:
              "#e5e7eb"
          }
        }
      }
    };


    const iuImg =
      makePdfChartImage(
        "scatter",

        {
          datasets: [
            {
              label:
                "I(U)",

              data:
                points,

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              borderColor:
                C.iu
            },

            ...(Number.isFinite(m.vmpp) &&
               Number.isFinite(m.impp)
              ? [
                  {
                    label:
                      "MPP",

                    data: [
                      {
                        x:
                          m.vmpp,

                        y:
                          m.impp
                      }
                    ],

                    pointRadius:
                      6,

                    pointBackgroundColor:
                      C.mpp
                  }
                ]
              : [])
          ]
        },

        {
          ...commonOptions,

          scales: {

            x: {
              ...commonOptions.scales.x,

              min:
                0,

              max:
                Math.min(
                  Math.max(
                    ...points.map(
                      p => p.x
                    )
                  ) * 1.1,
                  20
                ),

              title: {
                display:
                  true,

                text:
                  "Tension U (V)"
              }
            },

            y: {
              ...commonOptions.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Courant I (A)"
              }
            }
          }
        }
      );


    const puImg =
      makePdfChartImage(
        "scatter",

        {
          datasets: [
            {
              label:
                "P(U)",

              data:
                pu,

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              borderColor:
                C.pu
            }
          ]
        },

        {
          ...commonOptions,

          scales: {

            x: {
              ...commonOptions.scales.x,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Tension U (V)"
              }
            },

            y: {
              ...commonOptions.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Puissance P (W)"
              }
            }
          }
        }
      );


    const ukImg =
      makePdfChartImage(
        "scatter",

        {
          datasets: [
            {
              label:
                "U(k)",

              data:
                uK,

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              borderColor:
                C.uk
            }
          ]
        },

        {
          ...commonOptions,

          scales: {

            x: {
              ...commonOptions.scales.x,

              title: {
                display:
                  true,

                text:
                  "Indice k"
              }
            },

            y: {
              ...commonOptions.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Tension U (V)"
              }
            }
          }
        }
      );


    const ikImg =
      makePdfChartImage(
        "scatter",

        {
          datasets: [
            {
              label:
                "I(k)",

              data:
                iK,

              showLine:
                true,

              pointRadius:
                0,

              borderWidth:
                2,

              borderColor:
                C.ik
            }
          ]
        },

        {
          ...commonOptions,

          scales: {

            x: {
              ...commonOptions.scales.x,

              title: {
                display:
                  true,

                text:
                  "Indice k"
              }
            },

            y: {
              ...commonOptions.scales.y,

              min:
                0,

              title: {
                display:
                  true,

                text:
                  "Courant I (A)"
              }
            }
          }
        }
      );


    const doc =
      new jsPDF({
        orientation:
          "portrait",

        unit:
          "mm",

        format:
          "a4"
      });


    const pageW =
      doc.internal.pageSize.getWidth();


    const margin =
      14;


    /* ========================
       PAGE 1
       ======================== */

    doc.setFontSize(
      18
    );


    doc.text(
      "SolarMonitor - Rapport de mesure I-V",
      margin,
      18
    );


    doc.setFontSize(
      10
    );


    doc.text(
      `Mesure : #${entry.id}`,
      margin,
      28
    );


    doc.text(
      `Date : ${new Date(entry.ts).toLocaleString()}`,
      margin,
      34
    );


    doc.text(
      `Mode orientation : ${m.orient_mode || "—"}`,
      margin,
      40
    );


    doc.text(
      `Servo RX / Azimut : ${
        Number.isFinite(m.servo1_deg)
          ? `${m.servo1_deg} deg`
          : "—"
      }`,
      margin,
      46
    );


    doc.text(
      `Servo RY / Elevation : ${
        Number.isFinite(m.servo2_deg)
          ? `${m.servo2_deg} deg`
          : "—"
      }`,
      margin,
      52
    );


    doc.setFontSize(
      12
    );


    doc.text(
      "Parametres photovoltaïques",
      margin,
      64
    );


    doc.setFontSize(
      10
    );


    const params = [

      `Isc : ${
        Number.isFinite(m.isc)
          ? `${fmt(m.isc,4)} A`
          : "—"
      }`,

      `Voc : ${
        Number.isFinite(m.voc)
          ? `${fmt(m.voc,3)} V`
          : "—"
      }`,

      `Vmpp : ${
        Number.isFinite(m.vmpp)
          ? `${fmt(m.vmpp,3)} V`
          : "—"
      }`,

      `Impp : ${
        Number.isFinite(m.impp)
          ? `${fmt(m.impp,4)} A`
          : "—"
      }`,

      `Pmpp : ${
        Number.isFinite(m.pmpp)
          ? `${fmt(m.pmpp,3)} W`
          : "—"
      }`

    ];


    params.forEach(
      (text,index) => {

        doc.text(
          text,
          margin,
          72 + index * 6
        );
      }
    );


    doc.setFontSize(
      12
    );


    doc.text(
      "Conditions pendant la mesure",
      105,
      64
    );


    doc.setFontSize(
      10
    );


    const env = [

      `Luminosite moy. : ${
        Number.isFinite(entry.env?.luxAvg)
          ? `${fmt(entry.env.luxAvg,1)} lx`
          : "—"
      }`,

      `Temperature DHT moy. : ${
        Number.isFinite(entry.env?.tempAvg)
          ? `${fmt(entry.env.tempAvg,1)} °C`
          : "—"
      }`,

      `Humidite moy. : ${
        Number.isFinite(entry.env?.humAvg)
          ? `${fmt(entry.env.humAvg,1)} %`
          : "—"
      }`,

      `Thermocouple moy. : ${
        Number.isFinite(entry.env?.tcAvg)
          ? `${fmt(entry.env.tcAvg,1)} °C`
          : "—"
      }`

    ];


    env.forEach(
      (text,index) => {

        doc.text(
          text,
          105,
          72 + index * 6
        );
      }
    );


    doc.text(
      `Nombre de points : ${points.length}`,
      margin,
      107
    );


    doc.setFontSize(
      12
    );

    doc.text(
      "Courbe I(U)",
      margin,
      119
    );


    doc.addImage(
      iuImg,
      "PNG",
      margin,
      124,
      pageW - margin * 2,
      75
    );


    doc.text(
      "Courbe P(U)",
      margin,
      211
    );


    doc.addImage(
      puImg,
      "PNG",
      margin,
      216,
      pageW - margin * 2,
      65
    );


    /* ========================
       PAGE 2
       ======================== */

    doc.addPage();


    doc.setFontSize(
      15
    );


    doc.text(
      "Evolution des valeurs par point de mesure",
      margin,
      18
    );


    doc.setFontSize(
      12
    );


    doc.text(
      "Tension U(k)",
      margin,
      30
    );


    doc.addImage(
      ukImg,
      "PNG",
      margin,
      35,
      pageW - margin * 2,
      100
    );


    doc.text(
      "Courant I(k)",
      margin,
      150
    );


    doc.addImage(
      ikImg,
      "PNG",
      margin,
      155,
      pageW - margin * 2,
      100
    );


    doc.save(
      `SolarMonitor_mesure_${entry.id}.pdf`
    );

  }
  catch (err) {

    console.error(
      "PDF:",
      err
    );


    alert(
      "Impossible de générer le PDF."
    );
  }
}


/* =========================================================
   DONNEES TEMPS REEL
   ========================================================= */

function applySample(s) {

  applyOrientationStatus(s);


  /* ========================
     Valeurs instantanées
     ======================== */

  if (
    "lux" in s &&
    $("liveLux")
  ) {

    $("liveLux").textContent =
      s.lux == null
        ? "—"
        : `${fmt(s.lux,0)} lx`;
  }


  if (
    "temp_dht_c" in s &&
    $("liveTemp")
  ) {

    $("liveTemp").textContent =
      s.temp_dht_c == null
        ? "—"
        : `${fmt(s.temp_dht_c,1)} °C`;
  }


  if (
    "hum_dht" in s &&
    $("liveHumidity")
  ) {

    $("liveHumidity").textContent =
      s.hum_dht == null
        ? "—"
        : `${fmt(s.hum_dht,0)} %`;
  }


  if (
    "tc_c" in s &&
    $("liveTc")
  ) {

    $("liveTc").textContent =
      s.tc_c == null
        ? "—"
        : `${fmt(s.tc_c,1)} °C`;
  }


  if ("servo1_deg" in s) {

    setServoAngleUI(
      1,
      s.servo1_deg
    );
  }


  if ("servo2_deg" in s) {

    setServoAngleUI(
      2,
      s.servo2_deg
    );
  }


  if (
    "seq" in s &&
    $("seq")
  ) {

    $("seq").textContent =
      s.seq;
  }


  if (
    "ts_ms" in s &&
    $("ts")
  ) {

    $("ts").textContent =
      s.ts_ms;
  }


  if (
    "phase" in s &&
    $("phase")
  ) {

    $("phase").textContent =
      s.phase;
  }


  if (
    "line" in s &&
    $("line")
  ) {

    $("line").textContent =
      s.line;
  }


  if (
    "state" in s &&
    $("state")
  ) {

    $("state").textContent =
      s.state
        ? "Mesure en cours"
        : "Mesure inactive";
  }


  const inScan =
    !!s.state &&
    s.phase === "scan";


  /* ========================
     Overlay mesure
     ======================== */

  if (inScan) {

    clearTimeout(
      scanOverlayTimer
    );


    showScanOverlay();


    const step =
      Number(
        s.line ?? 0
      );


    const serie =
      Number(
        s.series ?? 0
      );


    /*
      Start = jusqu'à 4 séries.

      Pour Scan simple, serie reste 0.
    */
    const totalSeries =
      4;


    const globalStep =
      serie * 256 +
      step;


    const globalTotal =
      totalSeries *
      256;


    const pct =
      Math.min(
        100,
        Math.round(
          globalStep *
          100 /
          globalTotal
        )
      );


    if ($("scanProgressFill")) {

      $("scanProgressFill").style.width =
        `${pct}%`;
    }


    if ($("scanCount")) {

      $("scanCount").textContent =
        `Série ${serie + 1} / ${totalSeries} — Point ${step} / 255`;
    }


    if ($("scanProgressTxt")) {

      $("scanProgressTxt").textContent =
        `Progression : ${pct}%`;
    }
  }


  /* ========================
     Début d'une série
     ======================== */

  const isRising =
    (
      !wasScanning &&
      inScan
    )
    ||
    (
      inScan &&
      Number(s.seq) === 0
    );


  if (isRising) {

    currentScanSamples =
      [];


    if ($("stepCount")) {

      $("stepCount").textContent =
        "0";
    }
  }


  /* ========================
     TEMPS REEL CAPTEURS

     IMPORTANT :
     Rien de cette partie n'est envoyé
     à MySQL.

     Ces tableaux sont uniquement
     en mémoire dans le navigateur.
     ======================== */

  if ("seq" in s) {

    histLabels.push(
      Number(s.seq)
    );


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


    if (
      histLabels.length >
      SENSOR_HARD_MAX
    ) {

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


    refreshSensorViewport();
  }


  /* ========================
     DONNEES PENDANT MESURE

     Elles seront sauvegardées
     uniquement lorsque iv_summary
     arrivera.
     ======================== */

  if (inScan) {

    const rawU =
      Number(
        s.u_v
      );


    const U =
      Number.isFinite(rawU)

        ? Math.min(
            Math.max(
              rawU *
              PANEL_VOLTAGE_SCALE,
              0
            ),
            PANEL_VOLTAGE_MAX
          )

        : NaN;


    const I =
      Number(
        s.i_a
      );


    if (
      Number.isFinite(U) &&
      Number.isFinite(I)
    ) {

      if ($("uEff")) {

        $("uEff").textContent =
          fmt(
            U,
            2
          );
      }


      if ($("iEff")) {

        $("iEff").textContent =
          fmt(
            I,
            3
          );
      }


      currentScanSamples.push({

        k:
          currentScanSamples.length,

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

        u_v:
          U,

        i_a:
          I,

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


  wasScanning =
    inScan;
}


/* =========================================================
   FIN DE MESURE / IV SUMMARY
   ========================================================= */

async function applyIvSummary(s) {

  clearTimeout(
    scanOverlayTimer
  );


  hideScanOverlay();


  applyOrientationStatus(
    s
  );


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


  if (!N)
    return;


  const points =
    [];


  for (
    let k = 0;
    k < N;
    k++
  ) {

    const rawU =
      Number(
        U[k]
      );


    const u =
      Math.min(
        Math.max(
          rawU *
          PANEL_VOLTAGE_SCALE,
          0
        ),
        PANEL_VOLTAGE_MAX
      );


    const i =
      Number(
        I[k]
      );


    if (
      Number.isFinite(u) &&
      Number.isFinite(i) &&
      u >= 0 &&
      i >= 0
    ) {

      points.push({
        x:
          u,

        y:
          i
      });
    }
  }


  points.sort(
    (a,b) =>
      a.x - b.x
  );


  const vmppCorr =
    Math.min(
      Math.max(
        Number(s.vmpp) *
        PANEL_VOLTAGE_SCALE,
        0
      ),
      PANEL_VOLTAGE_MAX
    );


  const imppCorr =
    Number(
      s.impp
    );


  const vocCorr =
    Math.min(
      Math.max(
        Number(s.voc_v) *
        PANEL_VOLTAGE_SCALE,
        0
      ),
      PANEL_VOLTAGE_MAX
    );


  const umaxCorr =
    Math.min(
      Math.max(
        Number(s.umax) *
        PANEL_VOLTAGE_SCALE,
        0
      ),
      PANEL_VOLTAGE_MAX
    );


  const meta = {

    vmpp:
      vmppCorr,

    impp:
      imppCorr,

    pmpp:
      (
        Number.isFinite(
          vmppCorr
        )
        &&
        Number.isFinite(
          imppCorr
        )
      )
        ? vmppCorr *
          imppCorr

        : Number(s.pmpp) *
          PANEL_VOLTAGE_SCALE,

    isc:
      Number(
        s.isc_a
      ),

    voc:
      vocCorr,

    umax:
      umaxCorr,

    servo1_deg:
      Number(
        s.servo1_deg
      ),

    servo2_deg:
      Number(
        s.servo2_deg
      ),

    orient_mode:
      s.orient_mode ??
      currentOrientMode,

    series:
      Number(
        s.series ??
        0
      )
  };


  lastIvMeta =
    {...meta};


  lastIvPoints =
    points.slice();


  const entry = {

    /*
      ID temporaire local.

      Le serveur retournera le véritable
      ID MySQL.
    */
    id:
      `local-${Date.now()}`,

    ts:
      Date.now(),

    loaded:
      true,

    points:
      points.slice(),

    samples:
      currentScanSamples.slice(),

    meta:
      {...meta},

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
            x =>
              x.temp_dht_c
          )
        ),

      humAvg:
        avg(
          currentScanSamples.map(
            x =>
              x.hum_dht
          )
        ),

      tcAvg:
        avg(
          currentScanSamples.map(
            x => x.tc_c
          )
        )
    },

    points_count:
      points.length
  };


  /*
    Affichage immédiat.
  */
  renderMeasurementToCharts(
    entry
  );


  updateHistoryDetails(
    entry
  );


  /*
    Sauvegarde permanente.

    UNE seule sauvegarde à la fin
    de la mesure.
  */
  const saved =
    await saveMeasurementToDatabase(
      entry
    );


  if (saved) {

    const savedEntry =
      normalizeMeasurement({
        ...entry,
        ...saved,
        id:
          saved.id ??
          saved.measurement_id ??
          entry.id,

        points:
          entry.points,

        samples:
          entry.samples,

        meta:
          entry.meta,

        env:
          entry.env,

        loaded:
          true
      });


    ivHistory.push(
      savedEntry
    );


    selectedScanId =
      savedEntry.id;

  }
  else {

    /*
      Si MySQL n'est momentanément
      pas disponible, on garde quand
      même la mesure pour cette session.
    */
    ivHistory.push(
      entry
    );


    selectedScanId =
      entry.id;
  }


  renderHistoryList();


  /*
    Prépare la prochaine série.
  */
  currentScanSamples =
    [];
}


/* =========================================================
   OVERLAY
   ========================================================= */

function startScanOverlayTimeout() {

  clearTimeout(
    scanOverlayTimer
  );


  scanOverlayTimer =
    setTimeout(
      () => {

        if ($("scanProgressTxt")) {

          $("scanProgressTxt").textContent =
            "Aucune donnée reçue de l’ESP32. Vérifiez la connexion.";
        }


        if ($("scanCount")) {

          $("scanCount").textContent =
            "Mesure non confirmée";
        }


        if ($("scanProgressFill")) {

          $("scanProgressFill").style.width =
            "0%";
        }

      },
      10000
    );
}


function showScanOverlay() {

  $("scanOverlay")
    ?.classList
    .remove(
      "hidden"
    );
}


function hideScanOverlay() {

  $("scanOverlay")
    ?.classList
    .add(
      "hidden"
    );
}


/* =========================================================
   SERVOS
   ========================================================= */

function paintRange(el) {

  if (!el)
    return;


  const min =
    Number(el.min) ||
    0;


  const max =
    Number(el.max) ||
    100;


  const val =
    (
      Number(el.value) -
      min
    )
    /
    (
      max -
      min
    )
    *
    100;


  el.style.background =
    `linear-gradient(
      90deg,
      #22c55e ${val}%,
      #264a8a ${val}%
    )`;
}


function setServoAngleUI(
  idx,
  angle
) {

  const a =
    Math.max(
      0,
      Math.min(
        180,
        Number(angle) || 0
      )
    );


  if (idx === 1) {

    setServo(
      $("needle1"),
      $("servoTxt1"),
      a
    );


    if ($("servo1Val")) {

      $("servo1Val").textContent =
        `${a | 0}°`;
    }


    if ($("servo1Live")) {

      $("servo1Live").textContent =
        `${a | 0}°`;
    }
  }
  else {

    setServo(
      $("needle2"),
      $("servoTxt2"),
      a
    );


    if ($("servo2Val")) {

      $("servo2Val").textContent =
        `${a | 0}°`;
    }


    if ($("servo2Live")) {

      $("servo2Live").textContent =
        `${a | 0}°`;
    }
  }


  setGaugeFill(
    idx,
    a
  );


  const rangeEl =
    $(
      idx === 1
        ? "servo1Range"
        : "servo2Range"
    );


  if (rangeEl) {

    rangeEl.value =
      String(a);

    paintRange(
      rangeEl
    );
  }
}


function setServo(
  needle,
  label,
  deg
) {

  const a =
    Math.max(
      0,
      Math.min(
        180,
        Number(deg) || 0
      )
    );


  if (needle) {

    needle.style.transform =
      `rotate(${a - 90}deg)`;
  }


  if (label) {

    label.textContent =
      `${a | 0}°`;
  }
}


function setGaugeFill(
  idx,
  angle
) {

  const el =
    document.querySelector(
      idx === 1
        ? ".gauges .servo:nth-child(1)"
        : ".gauges .servo:nth-child(2)"
    );


  if (!el)
    return;


  const a =
    Math.max(
      0,
      Math.min(
        180,
        Number(angle) || 0
      )
    );


  const fill =
    el.querySelector(
      ".gauge .gFill"
    );


  if (fill) {

    fill.style.setProperty(
      "--angle",
      a
    );
  }
}


function setServoActive(
  idx,
  active
) {

  const servoEl =
    document.querySelector(
      idx === 1
        ? ".gauges .servo:nth-child(1)"
        : ".gauges .servo:nth-child(2)"
    );


  const rangeEl =
    $(
      idx === 1
        ? "servo1Range"
        : "servo2Range"
    );


  if (servoEl) {

    servoEl.classList.toggle(
      "active",
      !!active
    );
  }


  if (rangeEl) {

    rangeEl.classList.toggle(
      "moving",
      !!active
    );
  }
}


function setServoAngle(
  idx,
  angle
) {

  const a =
    Math.max(
      0,
      Math.min(
        180,
        Number(angle) || 0
      )
    );


  pendingServoUntil =
    Date.now() +
    1000;


  setServoAngleUI(
    idx,
    a
  );


  sendCmd({

    cmd:
      "servo",

    index:
      idx,

    angle:
      a
  });
}


/* =========================================================
   RESET AFFICHAGE
   ========================================================= */

function clearDisplay() {

  histLabels.length =
    0;

  histLux.length =
    0;

  histTemp.length =
    0;

  histHum.length =
    0;

  histTc.length =
    0;


  refreshSensorViewport();


  [
    uiChart,
    pChart,
    iChart,
    uChart
  ]
    .filter(Boolean)
    .forEach(chart => {

      chart.data.datasets
        .forEach(
          ds =>
            ds.data = []
        );


      chart.update(
        "none"
      );
    });


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
  ]
    .forEach(id => {

      if ($(id)) {

        $(id).textContent =
          "—";
      }
    });


  lastIsc =
    null;

  lastVoc =
    null;

  lastIvPoints =
    null;

  lastIvMeta =
    null;


  updateHistoryDetails(
    null
  );


  selectedScanId =
    null;


  updateHistorySelectionUI();
}


/* =========================================================
   BUTTONS
   ========================================================= */

function wireButtons() {

  /* ========================
     START = série
     ======================== */

  $("btnStart")
    ?.addEventListener(
      "click",
      () => {

        const mode =
          getSelectedOrientMode();


        pendingOrientUntil =
          Date.now() +
          10000;


        setOrientModeUI(
          mode,
          true
        );


        showScanOverlay();

        startScanOverlayTimeout();


        if ($("scanProgressTxt")) {

          $("scanProgressTxt").textContent =
            "Démarrage de la série de mesures...";
        }


        if ($("scanProgressFill")) {

          $("scanProgressFill").style.width =
            "0%";
        }


        if ($("scanCount")) {

          $("scanCount").textContent =
            "Préparation...";
        }


        sendCmd({

          cmd:
            "start",

          orient:
            mode
        });
      }
    );


  /* ========================
     STOP
     ======================== */

  $("btnStop")
    ?.addEventListener(
      "click",
      () => {

        clearTimeout(
          scanOverlayTimer
        );


        hideScanOverlay();


        sendCmd({
          cmd:
            "stop"
        });
      }
    );


  /* ========================
     MESURE I-V 256 points
     ======================== */

  $("btnScanFull")
    ?.addEventListener(
      "click",
      () => {

        const mode =
          getSelectedOrientMode();


        pendingOrientUntil =
          Date.now() +
          10000;


        setOrientModeUI(
          mode,
          true
        );


        showScanOverlay();

        startScanOverlayTimeout();


        if ($("scanProgressTxt")) {

          $("scanProgressTxt").textContent =
            "Initialisation de la mesure I-V...";
        }


        if ($("scanProgressFill")) {

          $("scanProgressFill").style.width =
            "0%";
        }


        if ($("scanCount")) {

          $("scanCount").textContent =
            "Préparation...";
        }


        sendCmd({

          cmd:
            "scan",

          type:
            "full",

          orient:
            mode
        });
      }
    );


  /* ========================
     ORIENTATION
     ======================== */

  $("btnApplyOrient")
    ?.addEventListener(
      "click",
      sendOrientMode
    );


  document
    .querySelectorAll(
      'input[name="orientMode"]'
    )
    .forEach(
      el => {

        el.addEventListener(
          "change",
          () => {

            pendingOrientUntil =
              Date.now() +
              10000;


            const mode =
              getSelectedOrientMode();


            if ($("orientModeTxt")) {

              $("orientModeTxt").textContent =
                mode;
            }


            if ($("orientModeBar")) {

              $("orientModeBar").textContent =
                mode;
            }
          }
        );
      }
    );


  /* ========================
     TRACKER
     ======================== */

  $("btnTrackerOn")
    ?.addEventListener(
      "click",
      () => {

        pendingTrackerUntil =
          Date.now() +
          3000;


        setTrackerUI(
          true
        );


        sendCmd({

          cmd:
            "tracker",

          enabled:
            true
        });
      }
    );


  $("btnTrackerOff")
    ?.addEventListener(
      "click",
      () => {

        pendingTrackerUntil =
          Date.now() +
          3000;


        setTrackerUI(
          false
        );


        sendCmd({

          cmd:
            "tracker",

          enabled:
            false
        });
      }
    );


  /* ========================
     STATUS
     ======================== */

  $("btnStatus")
    ?.addEventListener(
      "click",
      () => {

        checkESP32();

        pollESP32Data();


        sendCmd({
          cmd:
            "status"
        });
      }
    );


  /* ========================
     PERIODE
     ======================== */

  $("btnSetPeriod")
    ?.addEventListener(
      "click",
      () => {

        const v =
          Number(
            (
              $("periodMs")
                ?.value ||
              ""
            )
            .trim()
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

          cmd:
            "schedule",

          period_ms:
            v
        });
      }
    );


  /* ========================
     HISTORIQUE
     ======================== */

  $("btnDownloadAllMeasures")
    ?.addEventListener(
      "click",
      downloadAllMeasuresCsv
    );


  /*
    Maintenant l'historique est permanent.
    On ne vide plus silencieusement
    la base entière avec ce bouton.

    Pour éviter une suppression accidentelle,
    on recharge simplement l'historique.
  */
  $("btnClearHistory")
    ?.addEventListener(
      "click",
      () => {

        alert(
          "L’historique est maintenant conservé dans la base de données. Supprimez les mesures individuellement depuis la liste."
        );
      }
    );


  $("btnExportSelectedScan")
    ?.addEventListener(
      "click",
      async () => {

        if (
          selectedScanId ===
          null
        ) {

          alert(
            "Aucune mesure sélectionnée."
          );

          return;
        }


        await downloadScanMeasuresCsv(
          selectedScanId
        );
      }
    );


  $("btnDeleteSelectedScan")
    ?.addEventListener(
      "click",
      async () => {

        if (
          selectedScanId ===
          null
        ) {

          alert(
            "Aucune mesure sélectionnée."
          );

          return;
        }


        await deleteScan(
          selectedScanId
        );
      }
    );


  $("btnToggleHistory")
    ?.addEventListener(
      "click",
      () => {

        const card =
          $("historyCard");


        if (!card)
          return;


        const hidden =
          card.classList.toggle(
            "is-hidden"
          );


        if ($("btnToggleHistory")) {

          $("btnToggleHistory").textContent =
            hidden
              ? "Afficher historique"
              : "Masquer historique";
        }
      }
    );


  /* ========================
     RESET AFFICHAGE
     ======================== */

  $("btnClearDisplay")
    ?.addEventListener(
      "click",
      clearDisplay
    );


  /* ========================
     FENETRE CAPTEURS
     ======================== */

  $("winSize")
    ?.addEventListener(
      "change",
      () => {

        const v =
          Number(
            $("winSize").value
          );


        if (
          Number.isFinite(v) &&
          v >= 20
        ) {

          WIN_SIZE =
            Math.min(
              2000,
              Math.max(
                20,
                v
              )
            );


          refreshSensorViewport();
        }
      }
    );


  $("chartScroll")
    ?.addEventListener(
      "input",
      () => {

        scrollPos =
          Number(
            $("chartScroll").value
          ) || 0;


        autoFollow =
          false;


        if ($("autoFollow")) {

          $("autoFollow").checked =
            false;
        }


        refreshSensorViewport();
      }
    );


  $("autoFollow")
    ?.addEventListener(
      "change",
      () => {

        autoFollow =
          !!$("autoFollow").checked;


        refreshSensorViewport();
      }
    );


  /* ========================
     SERVOS
     ======================== */

  const s1 =
    $("servo1Range");

  const s2 =
    $("servo2Range");


  if (s1) {

    paintRange(
      s1
    );


    s1.addEventListener(
      "input",
      e =>
        setServoAngle(
          1,
          e.target.value
        )
    );


    [
      "mousedown",
      "touchstart"
    ]
      .forEach(
        ev =>

          s1.addEventListener(
            ev,
            () =>
              setServoActive(
                1,
                true
              )
          )
      );


    [
      "mouseup",
      "mouseleave",
      "touchend",
      "touchcancel"
    ]
      .forEach(
        ev =>

          s1.addEventListener(
            ev,
            () =>
              setServoActive(
                1,
                false
              )
          )
      );
  }


  if (s2) {

    paintRange(
      s2
    );


    s2.addEventListener(
      "input",
      e =>
        setServoAngle(
          2,
          e.target.value
        )
    );


    [
      "mousedown",
      "touchstart"
    ]
      .forEach(
        ev =>

          s2.addEventListener(
            ev,
            () =>
              setServoActive(
                2,
                true
              )
          )
      );


    [
      "mouseup",
      "mouseleave",
      "touchend",
      "touchcancel"
    ]
      .forEach(
        ev =>

          s2.addEventListener(
            ev,
            () =>
              setServoActive(
                2,
                false
              )
          )
      );
  }


  /* ========================
     ESP32
     ======================== */

  $("btnManualConnect")
    ?.addEventListener(
      "click",
      () => {

        checkESP32();

        pollESP32Data();
      }
    );


  /* ========================
     LOGOUT
     ======================== */

  $("logoutBtn")
    ?.addEventListener(
      "click",
      logout
    );
}


/* =========================================================
   RIPPLE
   ========================================================= */

function enableRipple() {

  document
    .querySelectorAll(
      "button.pill"
    )
    .forEach(
      btn => {

        btn.addEventListener(
          "click",
          e => {

            const circle =
              document.createElement(
                "span"
              );


            circle.classList.add(
              "ripple"
            );


            const rect =
              btn.getBoundingClientRect();


            const size =
              Math.max(
                rect.width,
                rect.height
              );


            circle.style.width =
              `${size}px`;

            circle.style.height =
              `${size}px`;


            circle.style.left =
              `${
                e.clientX -
                rect.left -
                size / 2
              }px`;


            circle.style.top =
              `${
                e.clientY -
                rect.top -
                size / 2
              }px`;


            btn.appendChild(
              circle
            );


            setTimeout(
              () =>
                circle.remove(),
              600
            );
          }
        );
      }
    );
}


/* =========================================================
   BOOT
   ========================================================= */

window.addEventListener(
  "DOMContentLoaded",
  async () => {

    loadUser();


    initCharts();


    setOrientModeUI(
      "manual"
    );


    setTrackerUI(
      false
    );


    wireNavigation();

    wireRefInputs();

    wireButtons();

    wireGpsControls();

    enableRipple();


    showPage(
      "overview"
    );


    checkESP32();

    pollESP32Data();


    /*
      Charge également l'historique
      permanent dès le démarrage.
    */

    await loadMeasurementHistory();


    setInterval(
      checkESP32,
      5000
    );


    setInterval(
      pollESP32Data,
      500
    );

  }
);
