require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 4000;


/* =========================================================
   MIDDLEWARES
   ========================================================= */

app.use(cors());

app.use(
  express.json({
    limit: "5mb"
  })
);

app.use(express.static("public"));


/* =========================================================
   MYSQL
   ========================================================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "3306"),
  waitForConnections: true,
  connectionLimit: 10,
  connectTimeout: 60000
});


/* =========================================================
   CREATION TABLES MESURES

   IMPORTANT :
   On conserve seulement :

   - measurements
   - measurement_points

   measurement_points contient les points finaux de la
   courbe I-V envoyée par le système.

   Les échantillons bruts ne sont plus enregistrés.
   ========================================================= */

async function ensureMeasurementTables() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS measurements (

      id INT NOT NULL AUTO_INCREMENT,

      user_id INT DEFAULT NULL,

      series_no INT DEFAULT 0,

      orient_mode VARCHAR(50) DEFAULT NULL,

      servo1_deg DOUBLE DEFAULT NULL,
      servo2_deg DOUBLE DEFAULT NULL,

      vmpp DOUBLE DEFAULT NULL,
      impp DOUBLE DEFAULT NULL,
      pmpp DOUBLE DEFAULT NULL,

      isc DOUBLE DEFAULT NULL,
      voc DOUBLE DEFAULT NULL,
      umax DOUBLE DEFAULT NULL,

      lux_avg DOUBLE DEFAULT NULL,
      temp_avg DOUBLE DEFAULT NULL,
      hum_avg DOUBLE DEFAULT NULL,
      tc_avg DOUBLE DEFAULT NULL,

      points_count INT NOT NULL DEFAULT 0,

      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

      PRIMARY KEY (id),

      INDEX idx_measurements_created_at (created_at),
      INDEX idx_measurements_user_id (user_id)

    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);


  await pool.query(`
    CREATE TABLE IF NOT EXISTS measurement_points (

      id BIGINT NOT NULL AUTO_INCREMENT,

      measurement_id INT NOT NULL,

      k INT NOT NULL,

      u_v DOUBLE DEFAULT NULL,
      i_a DOUBLE DEFAULT NULL,
      p_w DOUBLE DEFAULT NULL,

      PRIMARY KEY (id),

      INDEX idx_measurement_points_measurement
        (measurement_id),

      INDEX idx_measurement_points_k
        (measurement_id, k),

      CONSTRAINT fk_measurement_points_measurement
        FOREIGN KEY (measurement_id)
        REFERENCES measurements(id)
        ON DELETE CASCADE

    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);


  /*
    Anciennes versions de SolarMonitor possédaient
    une colonne samples_count.

    On ne la supprime pas automatiquement afin de ne pas
    casser une base de données déjà déployée.

    Elle n'est simplement plus utilisée pour les nouvelles
    mesures.
  */


  console.log(
    "Tables mesures vérifiées/créées."
  );
}


/* =========================================================
   JWT
   ========================================================= */

function createToken(user) {

  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    {
      expiresIn: "2h"
    }
  );
}


/* =========================================================
   UTILISATEUR CONNECTE
   USER + MANAGER + ADMIN
   ========================================================= */

function authRequired(req, res, next) {

  const authHeader =
    req.headers.authorization || "";


  const token =
    authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;


  if (!token) {

    return res.status(401).json({
      error: "Token manquant"
    });
  }


  try {

    req.user =
      jwt.verify(
        token,
        process.env.JWT_SECRET
      );


    next();

  }
  catch {

    return res.status(401).json({
      error: "Token invalide"
    });
  }
}


/* =========================================================
   MANAGER OU ADMIN

   Peut :
   - lancer les mesures
   - commander ESP32
   - commander les servos
   - orientation
   - tracker
   - enregistrer mesure
   - supprimer mesure
   ========================================================= */

function managerRequired(req, res, next) {

  if (
    !req.user ||
    !["manager", "admin"].includes(
      req.user.role
    )
  ) {

    return res.status(403).json({
      error:
        "Accès réservé au manager/admin"
    });
  }


  next();
}


/* =========================================================
   ADMIN UNIQUEMENT

   Peut gérer les utilisateurs
   ========================================================= */

function adminRequired(req, res, next) {

  if (
    !req.user ||
    req.user.role !== "admin"
  ) {

    return res.status(403).json({
      error:
        "Accès réservé à l'administrateur"
    });
  }


  next();
}


/* =========================================================
   ETAT ESP32
   ========================================================= */

let currentCommand = {

  cmd: "none",

  mode: "manual",

  angleX: 0,

  angleY: 0,

  tracking: false
};


/*
  Dernier message temps réel reçu.

  On garde ce comportement pour conserver la compatibilité
  avec ton app.js existant.
*/

let solarData = {};


/* =========================================================
   GPS

   La position GPS est conservée séparément.

   C'est volontaire :
   un message suivant contenant seulement Lux / DHT /
   thermocouple / scan I-V ne doit PAS effacer la dernière
   position GPS connue.
   ========================================================= */

let gpsData = {

  gps_valid: false,

  gps_lat: null,

  gps_lon: null,

  gps_alt: null,

  gps_satellites: null,

  gps_hdop: null,

  gps_updated_at: null

};


/* =========================================================
   STATUT ESP32
   ========================================================= */

let esp32Status = {

  connected: false,

  lastSeen: null,

  ip: null,

  heap: null
};


/* =========================================================
   OUTILS GPS
   ========================================================= */


/*
  Convertit une valeur en nombre.

  Si la valeur reçue n'est pas exploitable,
  retourne null.
*/

function gpsNumber(value) {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {

    return null;
  }


  const n =
    Number(value);


  return Number.isFinite(n)
    ? n
    : null;
}


/* =========================================================
   VALIDATION COORDONNEES GPS
   ========================================================= */

function validGpsCoordinates(
  latitude,
  longitude
) {

  const lat =
    gpsNumber(latitude);

  const lon =
    gpsNumber(longitude);


  if (
    lat === null ||
    lon === null
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
    Un NEO-6M peut fournir 0 / 0 avant le premier fix.

    On ne considère donc pas 0 / 0 comme la position
    valide du panneau.
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
   CONVERSION BOOLEAN GPS
   ========================================================= */

function gpsBoolean(value) {

  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}


/* =========================================================
   EXTRACTION GPS DEPUIS UN MESSAGE ESP32
   ========================================================= */

function extractGpsFromBody(body) {

  if (
    !body ||
    typeof body !== "object"
  ) {

    return null;
  }


  /*
    Format principal prévu côté ESP32 :

      gps_valid
      gps_lat
      gps_lon
      gps_alt
      gps_satellites
      gps_hdop

    On accepte également un objet "gps" afin de garder
    le serveur tolérant.
  */


  const nestedGps =
    (
      body.gps &&
      typeof body.gps === "object"
    )
      ? body.gps
      : {};


  const latitude =
    body.gps_lat ??
    nestedGps.lat ??
    nestedGps.latitude;


  const longitude =
    body.gps_lon ??
    nestedGps.lon ??
    nestedGps.lng ??
    nestedGps.longitude;


  const altitude =
    body.gps_alt ??
    nestedGps.alt ??
    nestedGps.altitude;


  const satellites =
    body.gps_satellites ??
    nestedGps.satellites;


  const hdop =
    body.gps_hdop ??
    nestedGps.hdop;


  const explicitValid =
    body.gps_valid ??
    nestedGps.valid;


  /*
    Détermine si le message contient réellement
    quelque chose concernant le GPS.
  */

  const containsGps =
    latitude !== undefined ||
    longitude !== undefined ||
    altitude !== undefined ||
    satellites !== undefined ||
    hdop !== undefined ||
    explicitValid !== undefined;


  if (!containsGps) {

    return null;
  }


  const coordinateValid =
    validGpsCoordinates(
      latitude,
      longitude
    );


  /*
    Si gps_valid est fourni par l'ESP32,
    on exige à la fois :

      - gps_valid = true
      - coordonnées valides

    Sinon les coordonnées elles-mêmes déterminent
    la validité.
  */

  const valid =
    explicitValid === undefined
      ? coordinateValid
      : (
          gpsBoolean(
            explicitValid
          ) &&
          coordinateValid
        );


  return {

    gps_valid:
      valid,

    gps_lat:
      coordinateValid
        ? gpsNumber(latitude)
        : null,

    gps_lon:
      coordinateValid
        ? gpsNumber(longitude)
        : null,

    gps_alt:
      gpsNumber(altitude),

    gps_satellites:
      gpsNumber(satellites),

    gps_hdop:
      gpsNumber(hdop),

    gps_updated_at:
      new Date().toISOString()
  };
}


/* =========================================================
   MISE A JOUR GPS
   ========================================================= */

function updateGpsData(body) {

  const incomingGps =
    extractGpsFromBody(body);


  /*
    Le message ne contient aucune information GPS.

    On conserve donc exactement la dernière position connue.
  */

  if (!incomingGps) {

    return;
  }


  /*
    Si une nouvelle position est valide,
    on remplace les coordonnées.
  */

  if (incomingGps.gps_valid) {

    gpsData = {
      ...gpsData,
      ...incomingGps
    };

    return;
  }


  /*
    Pas de nouveau fix.

    On garde latitude/longitude de la dernière position
    valide mais on met gps_valid à false.

    Cela permet au site de savoir que le module cherche
    actuellement les satellites sans perdre la dernière
    position connue côté serveur.
  */

  gpsData = {

    ...gpsData,

    gps_valid: false,

    gps_alt:
      incomingGps.gps_alt ??
      gpsData.gps_alt,

    gps_satellites:
      incomingGps.gps_satellites ??
      gpsData.gps_satellites,

    gps_hdop:
      incomingGps.gps_hdop ??
      gpsData.gps_hdop,

    gps_updated_at:
      incomingGps.gps_updated_at
  };
}


/* =========================================================
   ACCUEIL
   ========================================================= */

app.get(
  "/",
  (req, res) => {

    res.json({

      status: true,

      project:
        "SolarMonitor",

      message:
        "Serveur SolarMonitor actif"

    });
  }
);


/* =========================================================
   HEALTH MYSQL
   ========================================================= */

app.get(
  "/api/health",
  async (req, res) => {

    try {

      const [rows] =
        await pool.query(`
          SELECT
            DATABASE() AS db,
            NOW() AS serverTime
        `);


      res.json({

        ok: true,

        database:
          rows[0]

      });

    }
    catch (err) {

      console.error(
        "MYSQL ERREUR :",
        err
      );


      res.status(500).json({

        ok: false,

        message:
          err.message,

        code:
          err.code,

        errno:
          err.errno,

        sqlState:
          err.sqlState

      });
    }
  }
);


/* =========================================================
   INSCRIPTION
   ========================================================= */

app.post(
  "/api/register",
  async (req, res) => {

    const {

      firstname,

      lastname,

      email,

      password

    } = req.body;


    if (
      !firstname ||
      !lastname ||
      !email ||
      !password
    ) {

      return res.status(400).json({
        error:
          "Tous les champs sont obligatoires"
      });
    }


    try {

      const [existing] =
        await pool.query(
          `
            SELECT id
            FROM users
            WHERE email = ?
          `,
          [
            email
          ]
        );


      if (
        existing.length > 0
      ) {

        return res.status(400).json({
          error:
            "Cet e-mail est déjà utilisé"
        });
      }


      const hash =
        await bcrypt.hash(
          password,
          10
        );


      const [result] =
        await pool.query(
          `
            INSERT INTO users
            (
              firstname,
              lastname,
              email,
              password_hash,
              role,
              status
            )
            VALUES
            (?, ?, ?, ?, 'user', 'pending')
          `,
          [
            firstname,
            lastname,
            email,
            hash
          ]
        );


      const [rows] =
        await pool.query(
          `
            SELECT
              id,
              firstname,
              lastname,
              email,
              role,
              status,
              created_at
            FROM users
            WHERE id = ?
          `,
          [
            result.insertId
          ]
        );


      res.status(201).json({

        message:
          "Demande d'inscription envoyée. En attente de validation par l'administrateur.",

        user:
          rows[0]

      });

    }
    catch (err) {

      console.error(
        "Erreur /api/register :",
        err
      );


      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message,

        code:
          err.code

      });
    }
  }
);


/* =========================================================
   CONNEXION
   ========================================================= */

app.post(
  "/api/login",
  async (req, res) => {

    const {

      email,

      password

    } = req.body;


    if (
      !email ||
      !password
    ) {

      return res.status(400).json({
        error:
          "E-mail et mot de passe requis"
      });
    }


    try {

      const [rows] =
        await pool.query(
          `
            SELECT *
            FROM users
            WHERE email = ?
          `,
          [
            email
          ]
        );


      if (
        rows.length === 0
      ) {

        return res.status(400).json({
          error:
            "Identifiants invalides"
        });
      }


      const user =
        rows[0];


      const match =
        await bcrypt.compare(
          password,
          user.password_hash
        );


      if (!match) {

        return res.status(400).json({
          error:
            "Identifiants invalides"
        });
      }


      if (
        user.status ===
        "pending"
      ) {

        return res.status(403).json({

          error:
            "Compte en attente de validation par l'administrateur"

        });
      }


      if (
        user.status ===
        "rejected"
      ) {

        return res.status(403).json({
          error:
            "Compte refusé"
        });
      }


      const token =
        createToken(
          user
        );


      res.json({

        message:
          "Connexion réussie",

        token,

        user: {

          id:
            user.id,

          firstname:
            user.firstname,

          lastname:
            user.lastname,

          email:
            user.email,

          role:
            user.role,

          status:
            user.status

        }

      });

    }
    catch (err) {

      console.error(
        "Erreur /api/login :",
        err
      );


      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message,

        code:
          err.code

      });
    }
  }
);


/* =========================================================
   ADMIN — LISTE UTILISATEURS
   ========================================================= */

app.get(
  "/api/admin/users",
  authRequired,
  adminRequired,
  async (req, res) => {

    const {
      status
    } = req.query;


    try {

      let sql = `
        SELECT
          id,
          firstname,
          lastname,
          email,
          role,
          status,
          created_at
        FROM users
      `;


      const params = [];


      if (status) {

        sql +=
          " WHERE status = ?";

        params.push(
          status
        );
      }


      sql +=
        " ORDER BY created_at DESC";


      const [rows] =
        await pool.query(
          sql,
          params
        );


      res.json(
        rows
      );

    }
    catch (err) {

      console.error(
        "Erreur /api/admin/users :",
        err
      );


      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message,

        code:
          err.code

      });
    }
  }
);


/* =========================================================
   ADMIN — MODIFICATION STATUT
   ========================================================= */

app.patch(
  "/api/admin/users/:id/status",
  authRequired,
  adminRequired,
  async (req, res) => {

    const userId =
      req.params.id;


    const {
      status
    } = req.body;


    if (
      ![
        "pending",
        "approved",
        "rejected"
      ].includes(status)
    ) {

      return res.status(400).json({
        error:
          "Statut invalide"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
            UPDATE users
            SET status = ?
            WHERE id = ?
          `,
          [
            status,
            userId
          ]
        );


      if (
        result.affectedRows === 0
      ) {

        return res.status(404).json({
          error:
            "Utilisateur introuvable"
        });
      }


      const [rows] =
        await pool.query(
          `
            SELECT
              id,
              firstname,
              lastname,
              email,
              role,
              status
            FROM users
            WHERE id = ?
          `,
          [
            userId
          ]
        );


      res.json({

        message:
          "Statut mis à jour",

        user:
          rows[0]

      });

    }
    catch (err) {

      console.error(
        "Erreur statut utilisateur :",
        err
      );


      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message,

        code:
          err.code

      });
    }
  }
);

/* =========================================================
   CREATION ADMIN AVEC SETUP_KEY
   ========================================================= */

app.post(
  "/api/setup-admin",
  async (req, res) => {

    const setupKey =
      req.headers["x-setup-key"];


    if (!process.env.SETUP_KEY) {

      return res.status(500).json({
        error:
          "SETUP_KEY manquant côté serveur"
      });
    }


    if (
      !setupKey ||
      setupKey !== process.env.SETUP_KEY
    ) {

      return res.status(403).json({
        error:
          "Clé setup invalide"
      });
    }


    const {

      firstname,
      lastname,
      email,
      password

    } = req.body;


    if (
      !firstname ||
      !lastname ||
      !email ||
      !password
    ) {

      return res.status(400).json({
        error:
          "Tous les champs sont obligatoires"
      });
    }


    try {

      const [existing] =
        await pool.query(
          `
            SELECT id
            FROM users
            WHERE email = ?
          `,
          [
            email
          ]
        );


      if (
        existing.length > 0
      ) {

        return res.status(400).json({
          error:
            "Cet e-mail est déjà utilisé"
        });
      }


      const hash =
        await bcrypt.hash(
          password,
          10
        );


      const [result] =
        await pool.query(
          `
            INSERT INTO users
            (
              firstname,
              lastname,
              email,
              password_hash,
              role,
              status
            )
            VALUES
            (?, ?, ?, ?, 'admin', 'approved')
          `,
          [
            firstname,
            lastname,
            email,
            hash
          ]
        );


      const [rows] =
        await pool.query(
          `
            SELECT
              id,
              firstname,
              lastname,
              email,
              role,
              status,
              created_at
            FROM users
            WHERE id = ?
          `,
          [
            result.insertId
          ]
        );


      res.status(201).json({

        message:
          "Admin créé avec succès",

        admin:
          rows[0]

      });

    }
    catch (err) {

      console.error(
        "Erreur /api/setup-admin :",
        err
      );


      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message,

        code:
          err.code

      });
    }
  }
);


/* =========================================================
   ADMIN — SUPPRIMER UTILISATEUR
   ========================================================= */

app.delete(
  "/api/admin/users/:id",
  authRequired,
  adminRequired,
  async (req, res) => {

    const userId =
      Number(
        req.params.id
      );


    /*
      Utilisateurs protégés dans ton projet actuel.
    */

    if (
      [1, 3, 5, 10].includes(
        userId
      )
    ) {

      return res.status(403).json({
        error:
          "Cet utilisateur est protégé"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
            DELETE FROM users
            WHERE id = ?
          `,
          [
            userId
          ]
        );


      if (
        result.affectedRows === 0
      ) {

        return res.status(404).json({
          error:
            "Utilisateur introuvable"
        });
      }


      res.json({
        message:
          "Utilisateur supprimé"
      });

    }
    catch (err) {

      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   ADMIN — MODIFICATION ROLE
   ========================================================= */

app.patch(
  "/api/admin/users/:id/role",
  authRequired,
  adminRequired,
  async (req, res) => {

    const userId =
      Number(
        req.params.id
      );


    const {
      role
    } = req.body;


    if (
      ![
        "admin",
        "manager",
        "user"
      ].includes(role)
    ) {

      return res.status(400).json({
        error:
          "Rôle invalide"
      });
    }


    if (
      [1, 3, 5, 10].includes(
        userId
      )
    ) {

      return res.status(403).json({
        error:
          "Cet utilisateur est protégé"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
            UPDATE users
            SET role = ?
            WHERE id = ?
          `,
          [
            role,
            userId
          ]
        );


      if (
        result.affectedRows === 0
      ) {

        return res.status(404).json({
          error:
            "Utilisateur introuvable"
        });
      }


      res.json({
        message:
          "Rôle modifié"
      });

    }
    catch (err) {

      res.status(500).json({

        error:
          "Erreur serveur",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   ESP32 — RECUPERATION COMMANDE
   ========================================================= */

app.get(
  "/api/esp32/command",
  (req, res) => {

    res.json(
      currentCommand
    );
  }
);


/* =========================================================
   ESP32 — ENVOYER COMMANDE

   MANAGER + ADMIN
   ========================================================= */

app.post(
  "/api/esp32/command",
  authRequired,
  managerRequired,
  (req, res) => {

    currentCommand = {

      ...req.body,

      created_at:
        new Date().toISOString()

    };


    res.json({

      message:
        "Commande enregistrée",

      command:
        currentCommand

    });
  }
);


/* =========================================================
   ESP32 — DATA TEMPS REEL

   PAS D'ENREGISTREMENT MYSQL ICI

   Cette route reçoit :
   - capteurs
   - servos
   - états
   - progression mesure
   - résumé I-V
   - GPS

   Le GPS est également copié dans gpsData afin que sa
   dernière valeur reste disponible même lorsque le message
   ESP32 suivant ne contient pas les champs GPS.
   ========================================================= */

app.post(
  "/api/esp32/data",
  (req, res) => {

    const now =
      new Date().toISOString();


    /* =====================================================
       MISE A JOUR GPS
       ===================================================== */

    updateGpsData(
      req.body
    );


    /* =====================================================
       DONNEE TEMPS REEL

       On garde le message reçu comme avant.

       On y ajoute cependant l'état GPS conservé par le
       serveur.

       Cela permet à app.js de recevoir le GPS directement
       avec son GET /api/esp32/data existant.
       ===================================================== */

    solarData = {

      ...req.body,

      ...gpsData,

      received_at:
        now

    };


    /* =====================================================
       STATUT ESP32
       ===================================================== */

    esp32Status.connected =
      true;


    esp32Status.lastSeen =
      now;


    esp32Status.ip =
      req.body.ip ||
      esp32Status.ip ||
      null;


    esp32Status.heap =
      req.body.heap ||
      esp32Status.heap ||
      null;


    res.json({

      message:
        "Données reçues",

      gps_valid:
        gpsData.gps_valid

    });
  }
);


/* =========================================================
   LECTURE DATA ESP32

   USER + MANAGER + ADMIN
   ========================================================= */

app.get(
  "/api/esp32/data",
  authRequired,
  (req, res) => {

    /*
      On fusionne encore gpsData ici.

      Ainsi même si solarData a été créé avant le premier
      fix GPS ou qu'une autre partie du programme le modifie,
      la réponse contient toujours l'état GPS actuel.
    */

    res.json({

      ...solarData,

      ...gpsData

    });
  }
);


/* =========================================================
   GPS — LECTURE DE LA DERNIERE POSITION

   USER + MANAGER + ADMIN

   Cette route est facultative pour app.js car le GPS est
   également présent dans /api/esp32/data.

   Elle est néanmoins utile pour :
   - diagnostic
   - page GPS indépendante
   - évolution future du projet
   ========================================================= */

app.get(
  "/api/gps",
  authRequired,
  (req, res) => {

    res.json({

      ...gpsData,

      esp32_connected:
        esp32Status.connected,

      esp32_last_seen:
        esp32Status.lastSeen

    });
  }
);


/* =========================================================
   GPS — RECEPTION DIRECTE DEPUIS ESP32

   Cette route permettra plus tard à l'ESP32 d'envoyer
   uniquement le GPS sans remplacer le message principal.

   Aucun JWT utilisateur n'est demandé ici, comme pour
   /api/esp32/data et /api/esp32/ping dans ton architecture
   actuelle.

   Le navigateur, lui, ne lit cette information qu'après
   authentification avec GET /api/gps ou GET /api/esp32/data.
   ========================================================= */

app.post(
  "/api/esp32/gps",
  (req, res) => {

    const incomingGps =
      extractGpsFromBody(
        req.body
      );


    if (!incomingGps) {

      return res.status(400).json({

        success:
          false,

        error:
          "Aucune donnée GPS reçue"

      });
    }


    updateGpsData(
      req.body
    );


    /*
      Un message GPS provenant de l'ESP32 compte également
      comme activité de l'ESP32.
    */

    const now =
      new Date().toISOString();


    esp32Status.connected =
      true;


    esp32Status.lastSeen =
      now;


    esp32Status.ip =
      req.body.ip ||
      esp32Status.ip ||
      null;


    esp32Status.heap =
      req.body.heap ||
      esp32Status.heap ||
      null;


    /*
      On met aussi le GPS dans solarData afin que
      /api/esp32/data le fournisse immédiatement.
    */

    solarData = {

      ...solarData,

      ...gpsData

    };


    res.json({

      success:
        true,

      message:
        gpsData.gps_valid
          ? "Position GPS reçue"
          : "GPS reçu, en attente d'un fix valide",

      gps:
        gpsData

    });
  }
);


/* =========================================================
   ESP32 PING
   ========================================================= */

app.post(
  "/api/esp32/ping",
  (req, res) => {

    esp32Status.connected =
      true;


    esp32Status.lastSeen =
      new Date().toISOString();


    esp32Status.ip =
      req.body.ip ||
      null;


    esp32Status.heap =
      req.body.heap ||
      null;


    res.json({
      success:
        true
    });
  }
);


/* =========================================================
   ESP32 STATUS
   ========================================================= */

app.get(
  "/api/esp32/status",
  (req, res) => {

    const now =
      Date.now();


    const last =
      esp32Status.lastSeen
        ? new Date(
            esp32Status.lastSeen
          ).getTime()
        : 0;


    /*
      Si aucun ping ou aucune donnée n'a été reçue
      pendant 10 secondes, l'ESP32 est considéré
      déconnecté.
    */

    const connected =
      now - last < 10000;


    esp32Status.connected =
      connected;


    res.json({

      connected,

      lastSeen:
        esp32Status.lastSeen,

      ip:
        esp32Status.ip,

      heap:
        esp32Status.heap

    });
  }
);


/* =========================================================
   ENREGISTRER UNE MESURE

   MANAGER + ADMIN

   IMPORTANT :
   On enregistre uniquement les points finaux I-V.

   measurement_samples n'est plus alimentée.
   ========================================================= */

app.post(
  "/api/measurements",
  authRequired,
  managerRequired,
  async (req, res) => {

    const {

      series_no,

      orient_mode,

      servo1_deg,
      servo2_deg,

      vmpp,
      impp,
      pmpp,

      isc,
      voc,
      umax,

      lux_avg,
      temp_avg,
      hum_avg,
      tc_avg,

      points

    } = req.body;


    /* =====================================================
       VERIFICATION POINTS
       ===================================================== */

    if (
      !Array.isArray(points) ||
      points.length === 0
    ) {

      return res.status(400).json({
        error:
          "Aucun point I-V reçu"
      });
    }


    /*
      Le scan normal contient 256 points.

      On garde une limite de sécurité à 1000 pour éviter
      qu'une requête anormale surcharge la base.
    */

    if (
      points.length > 1000
    ) {

      return res.status(400).json({
        error:
          "Nombre de points trop élevé"
      });
    }


    let connection;


    try {

      connection =
        await pool.getConnection();


      await connection.beginTransaction();


      /* ===================================================
         MESURE PRINCIPALE
         =================================================== */

      const [result] =
        await connection.query(
          `
            INSERT INTO measurements
            (
              user_id,

              series_no,

              orient_mode,

              servo1_deg,
              servo2_deg,

              vmpp,
              impp,
              pmpp,

              isc,
              voc,
              umax,

              lux_avg,
              temp_avg,
              hum_avg,
              tc_avg,

              points_count
            )

            VALUES
            (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?
            )
          `,
          [

            req.user.id || null,


            Number.isFinite(
              Number(series_no)
            )
              ? Number(series_no)
              : 0,


            orient_mode ||
              null,


            Number.isFinite(
              Number(servo1_deg)
            )
              ? Number(servo1_deg)
              : null,


            Number.isFinite(
              Number(servo2_deg)
            )
              ? Number(servo2_deg)
              : null,


            Number.isFinite(
              Number(vmpp)
            )
              ? Number(vmpp)
              : null,


            Number.isFinite(
              Number(impp)
            )
              ? Number(impp)
              : null,


            Number.isFinite(
              Number(pmpp)
            )
              ? Number(pmpp)
              : null,


            Number.isFinite(
              Number(isc)
            )
              ? Number(isc)
              : null,


            Number.isFinite(
              Number(voc)
            )
              ? Number(voc)
              : null,


            Number.isFinite(
              Number(umax)
            )
              ? Number(umax)
              : null,


            Number.isFinite(
              Number(lux_avg)
            )
              ? Number(lux_avg)
              : null,


            Number.isFinite(
              Number(temp_avg)
            )
              ? Number(temp_avg)
              : null,


            Number.isFinite(
              Number(hum_avg)
            )
              ? Number(hum_avg)
              : null,


            Number.isFinite(
              Number(tc_avg)
            )
              ? Number(tc_avg)
              : null,


            points.length

          ]
        );


      const measurementId =
        result.insertId;


      /* ===================================================
         256 POINTS FINAUX I-V

         Ce sont exactement les points envoyés par app.js
         après réception de iv_summary.
         =================================================== */

      const pointValues =
        points.map(
          (p, index) => {

            const u =
              Number(
                p.u_v ??
                p.x
              );


            const i =
              Number(
                p.i_a ??
                p.y
              );


            let power =
              Number(
                p.p_w
              );


            /*
              Si P n'est pas fourni,
              on le calcule simplement avec U × I.
            */

            if (
              !Number.isFinite(power)
            ) {

              power =
                (
                  Number.isFinite(u) &&
                  Number.isFinite(i)
                )
                  ? u * i
                  : null;
            }


            return [

              measurementId,


              Number.isFinite(
                Number(p.k)
              )
                ? Number(p.k)
                : index,


              Number.isFinite(u)
                ? u
                : null,


              Number.isFinite(i)
                ? i
                : null,


              Number.isFinite(power)
                ? power
                : null

            ];
          }
        );


      await connection.query(
        `
          INSERT INTO measurement_points
          (
            measurement_id,
            k,
            u_v,
            i_a,
            p_w
          )

          VALUES ?
        `,
        [
          pointValues
        ]
      );


      /*
        IMPORTANT :

        Aucun INSERT dans measurement_samples.

        Les anciens enregistrements éventuellement présents
        dans cette table restent dans MySQL, mais les nouvelles
        mesures n'y écrivent plus rien.
      */


      await connection.commit();


      const [savedRows] =
        await pool.query(
          `
            SELECT *
            FROM measurements
            WHERE id = ?
          `,
          [
            measurementId
          ]
        );


      res.status(201).json({

        message:
          "Mesure enregistrée",

        ...savedRows[0]

      });

    }
    catch (err) {

      if (connection) {

        try {

          await connection.rollback();

        }
        catch {}
      }


      console.error(
        "Erreur enregistrement mesure :",
        err
      );


      res.status(500).json({

        error:
          "Impossible d'enregistrer la mesure",

        details:
          err.message,

        code:
          err.code

      });

    }
    finally {

      if (connection) {

        connection.release();
      }
    }
  }
);

/* =========================================================
   LISTE HISTORIQUE

   USER + MANAGER + ADMIN
   ========================================================= */

app.get(
  "/api/measurements",
  authRequired,
  async (req, res) => {

    try {

      const [rows] =
        await pool.query(
          `
            SELECT

              m.id,

              m.user_id,

              m.series_no,

              m.orient_mode,

              m.servo1_deg,
              m.servo2_deg,

              m.vmpp,
              m.impp,
              m.pmpp,

              m.isc,
              m.voc,
              m.umax,

              m.lux_avg,
              m.temp_avg,
              m.hum_avg,
              m.tc_avg,

              m.points_count,

              m.created_at,

              u.firstname,
              u.lastname,
              u.email

            FROM measurements m

            LEFT JOIN users u
              ON u.id = m.user_id

            ORDER BY
              m.created_at DESC,
              m.id DESC
          `
        );


      res.json(
        rows
      );

    }
    catch (err) {

      console.error(
        "Erreur liste historique :",
        err
      );


      res.status(500).json({

        error:
          "Impossible de charger l'historique",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   CHARGER UNE MESURE

   USER + MANAGER + ADMIN

   On charge uniquement :
   - informations générales
   - paramètres I-V
   - conditions environnementales moyennes
   - points finaux de la courbe

   Les anciens measurement_samples ne sont plus utilisés.
   ========================================================= */

app.get(
  "/api/measurements/:id",
  authRequired,
  async (req, res) => {

    const measurementId =
      Number(
        req.params.id
      );


    if (
      !Number.isInteger(
        measurementId
      ) ||
      measurementId <= 0
    ) {

      return res.status(400).json({
        error:
          "Identifiant de mesure invalide"
      });
    }


    try {

      /* ===================================================
         MESURE
         =================================================== */

      const [measurements] =
        await pool.query(
          `
            SELECT

              m.*,

              u.firstname,
              u.lastname,
              u.email

            FROM measurements m

            LEFT JOIN users u
              ON u.id = m.user_id

            WHERE m.id = ?
          `,
          [
            measurementId
          ]
        );


      if (
        measurements.length === 0
      ) {

        return res.status(404).json({
          error:
            "Mesure introuvable"
        });
      }


      const measurement =
        measurements[0];


      /* ===================================================
         POINTS FINAUX I-V
         =================================================== */

      const [points] =
        await pool.query(
          `
            SELECT

              k,

              u_v,

              i_a,

              p_w

            FROM measurement_points

            WHERE measurement_id = ?

            ORDER BY k ASC
          `,
          [
            measurementId
          ]
        );


      /* ===================================================
         REPONSE
         =================================================== */

      res.json({

        id:
          measurement.id,


        user_id:
          measurement.user_id,


        created_at:
          measurement.created_at,


        points_count:
          measurement.points_count,


        /*
          On garde samples_count dans la réponse pour
          compatibilité avec l'ancien app.js.

          Il vaut toujours 0 dans le nouveau système.
        */

        samples_count:
          0,


        /* =================================================
           META
           ================================================= */

        meta: {

          series:
            measurement.series_no,


          orient_mode:
            measurement.orient_mode,


          servo1_deg:
            measurement.servo1_deg,


          servo2_deg:
            measurement.servo2_deg,


          vmpp:
            measurement.vmpp,


          impp:
            measurement.impp,


          pmpp:
            measurement.pmpp,


          isc:
            measurement.isc,


          voc:
            measurement.voc,


          umax:
            measurement.umax

        },


        /* =================================================
           ENVIRONNEMENT
           ================================================= */

        env: {

          luxAvg:
            measurement.lux_avg,


          tempAvg:
            measurement.temp_avg,


          humAvg:
            measurement.hum_avg,


          tcAvg:
            measurement.tc_avg

        },


        /* =================================================
           UTILISATEUR
           ================================================= */

        user: {

          firstname:
            measurement.firstname,


          lastname:
            measurement.lastname,


          email:
            measurement.email

        },


        /* =================================================
           256 POINTS FINAUX
           ================================================= */

        points:
          points.map(
            p => ({

              k:
                p.k,


              x:
                p.u_v === null
                  ? null
                  : Number(
                      p.u_v
                    ),


              y:
                p.i_a === null
                  ? null
                  : Number(
                      p.i_a
                    ),


              p_w:
                p.p_w === null
                  ? null
                  : Number(
                      p.p_w
                    )

            })
          ),


        /*
          Compatibilité avec l'ancien app.js.

          Il n'y a maintenant plus d'échantillons bruts
          sauvegardés en base.
        */

        samples: []

      });

    }
    catch (err) {

      console.error(
        "Erreur lecture mesure :",
        err
      );


      res.status(500).json({

        error:
          "Impossible de charger la mesure",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   SUPPRIMER UNE MESURE

   MANAGER + ADMIN
   ========================================================= */

app.delete(
  "/api/measurements/:id",
  authRequired,
  managerRequired,
  async (req, res) => {

    const measurementId =
      Number(
        req.params.id
      );


    if (
      !Number.isInteger(
        measurementId
      ) ||
      measurementId <= 0
    ) {

      return res.status(400).json({
        error:
          "Identifiant de mesure invalide"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
            DELETE FROM measurements
            WHERE id = ?
          `,
          [
            measurementId
          ]
        );


      if (
        result.affectedRows === 0
      ) {

        return res.status(404).json({
          error:
            "Mesure introuvable"
        });
      }


      /*
        measurement_points est automatiquement supprimé
        grâce à :

        FOREIGN KEY measurement_id
        ON DELETE CASCADE
      */


      res.json({

        message:
          "Mesure supprimée",

        id:
          measurementId

      });

    }
    catch (err) {

      console.error(
        "Erreur suppression mesure :",
        err
      );


      res.status(500).json({

        error:
          "Impossible de supprimer la mesure",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   SUPPRIMER TOUT L'HISTORIQUE

   MANAGER + ADMIN

   Cette route est utile pour le bouton
   "Vider historique" de la page web.
   ========================================================= */

app.delete(
  "/api/measurements",
  authRequired,
  managerRequired,
  async (req, res) => {

    let connection;


    try {

      connection =
        await pool.getConnection();


      await connection.beginTransaction();


      /*
        Grâce à ON DELETE CASCADE,
        supprimer measurements supprime également
        measurement_points.
      */

      const [result] =
        await connection.query(
          `
            DELETE FROM measurements
          `
        );


      await connection.commit();


      res.json({

        message:
          "Historique supprimé",

        deleted:
          result.affectedRows

      });

    }
    catch (err) {

      if (connection) {

        try {

          await connection.rollback();

        }
        catch {}
      }


      console.error(
        "Erreur suppression historique :",
        err
      );


      res.status(500).json({

        error:
          "Impossible de supprimer l'historique",

        details:
          err.message

      });

    }
    finally {

      if (connection) {

        connection.release();
      }
    }
  }
);


/* =========================================================
   STATISTIQUES HISTORIQUE
   ========================================================= */

app.get(
  "/api/measurements-stats",
  authRequired,
  async (req, res) => {

    try {

      const [rows] =
        await pool.query(
          `
            SELECT

              COUNT(*)
                AS total_measurements,

              COALESCE(
                SUM(points_count),
                0
              )
                AS total_points,

              MAX(created_at)
                AS last_measurement

            FROM measurements
          `
        );


      res.json(
        rows[0]
      );

    }
    catch (err) {

      console.error(
        "Erreur statistiques historique :",
        err
      );


      res.status(500).json({

        error:
          "Impossible de lire les statistiques",

        details:
          err.message

      });
    }
  }
);


/* =========================================================
   ETAT GPS - DIAGNOSTIC

   USER + MANAGER + ADMIN

   Cette route donne l'état GPS dans un format pratique
   pour le diagnostic de la page Localisation.
   ========================================================= */

app.get(
  "/api/gps/status",
  authRequired,
  (req, res) => {

    const now =
      Date.now();


    const gpsTime =
      gpsData.gps_updated_at
        ? new Date(
            gpsData.gps_updated_at
          ).getTime()
        : 0;


    const ageMs =
      gpsTime > 0
        ? now - gpsTime
        : null;


    res.json({

      valid:
        gpsData.gps_valid,


      latitude:
        gpsData.gps_lat,


      longitude:
        gpsData.gps_lon,


      altitude:
        gpsData.gps_alt,


      satellites:
        gpsData.gps_satellites,


      hdop:
        gpsData.gps_hdop,


      updated_at:
        gpsData.gps_updated_at,


      age_ms:
        ageMs,


      esp32_connected:
        esp32Status.connected,


      esp32_last_seen:
        esp32Status.lastSeen

    });
  }
);


/* =========================================================
   404 API

   Si une route /api/... inexistante est demandée,
   on retourne du JSON plutôt qu'une page HTML.
   ========================================================= */

app.use(
  "/api",
  (req, res) => {

    res.status(404).json({

      error:
        "Route API introuvable",

      method:
        req.method,

      path:
        req.originalUrl

    });
  }
);


/* =========================================================
   GESTION ERREUR EXPRESS
   ========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      "Erreur Express :",
      err
    );


    if (
      res.headersSent
    ) {

      return next(
        err
      );
    }


    res.status(500).json({

      error:
        "Erreur interne du serveur",

      details:
        err.message

    });
  }
);


/* =========================================================
   DEMARRAGE SERVEUR
   ========================================================= */

async function startServer() {

  try {

    /* =====================================================
       VERIFICATION MYSQL
       ===================================================== */

    const [dbRows] =
      await pool.query(`
        SELECT DATABASE() AS db
      `);


    console.log(
      "Base MySQL connectée :",
      dbRows[0]?.db
    );


    /* =====================================================
       TABLES
       ===================================================== */

    await ensureMeasurementTables();


    /* =====================================================
       SERVEUR HTTP
       ===================================================== */

    app.listen(
      PORT,
      () => {

        console.log(
          `Serveur SolarMonitor lancé sur le port ${PORT}`
        );


        console.log(
          "Historique MySQL activé"
        );


        console.log(
          "GPS SolarMonitor activé"
        );


        console.log(
          "Route ESP32 GPS : POST /api/esp32/gps"
        );


        console.log(
          "Route lecture GPS : GET /api/gps"
        );

      }
    );

  }
  catch (err) {

    console.error(
      "Impossible de démarrer SolarMonitor :",
      err
    );


    process.exit(
      1
    );
  }
}


/* =========================================================
   LANCEMENT
   ========================================================= */

startServer();
