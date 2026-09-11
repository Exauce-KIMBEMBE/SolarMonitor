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
      samples_count INT NOT NULL DEFAULT 0,

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


  await pool.query(`
    CREATE TABLE IF NOT EXISTS measurement_samples (

      id BIGINT NOT NULL AUTO_INCREMENT,

      measurement_id INT NOT NULL,

      k INT DEFAULT NULL,

      seq INT DEFAULT NULL,

      ts_ms BIGINT DEFAULT NULL,

      line_no INT DEFAULT NULL,

      u_v DOUBLE DEFAULT NULL,
      i_a DOUBLE DEFAULT NULL,

      lux DOUBLE DEFAULT NULL,

      temp_dht_c DOUBLE DEFAULT NULL,
      hum_dht DOUBLE DEFAULT NULL,
      tc_c DOUBLE DEFAULT NULL,

      servo1_deg DOUBLE DEFAULT NULL,
      servo2_deg DOUBLE DEFAULT NULL,

      orient_mode VARCHAR(50) DEFAULT NULL,

      PRIMARY KEY (id),

      INDEX idx_measurement_samples_measurement
        (measurement_id),

      CONSTRAINT fk_measurement_samples_measurement
        FOREIGN KEY (measurement_id)
        REFERENCES measurements(id)
        ON DELETE CASCADE

    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  console.log("Tables mesures vérifiées/créées.");
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
    !["manager", "admin"].includes(req.user.role)
  ) {

    return res.status(403).json({
      error: "Accès réservé au manager/admin"
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
      error: "Accès réservé à l'administrateur"
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


let solarData = {};


let esp32Status = {
  connected: false,
  lastSeen: null,
  ip: null,
  heap: null
};


/* =========================================================
   ACCUEIL
   ========================================================= */

app.get("/", (req, res) => {

  res.json({
    status: true,
    project: "SolarMonitor",
    message: "Serveur SolarMonitor actif"
  });
});


/* =========================================================
   HEALTH MYSQL
   ========================================================= */

app.get("/api/health", async (req, res) => {

  try {

    const [rows] =
      await pool.query(`
        SELECT
          DATABASE() AS db,
          NOW() AS serverTime
      `);

    res.json({
      ok: true,
      database: rows[0]
    });

  }
  catch (err) {

    console.error("MYSQL ERREUR :", err);

    res.status(500).json({
      ok: false,
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState
    });
  }
});


/* =========================================================
   INSCRIPTION
   ========================================================= */

app.post("/api/register", async (req, res) => {

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
      error: "Tous les champs sont obligatoires"
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
        [email]
      );


    if (existing.length > 0) {

      return res.status(400).json({
        error: "Cet e-mail est déjà utilisé"
      });
    }


    const hash =
      await bcrypt.hash(password, 10);


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
        [result.insertId]
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
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});


/* =========================================================
   CONNEXION
   ========================================================= */

app.post("/api/login", async (req, res) => {

  const {
    email,
    password
  } = req.body;


  if (
    !email ||
    !password
  ) {

    return res.status(400).json({
      error: "E-mail et mot de passe requis"
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
        [email]
      );


    if (rows.length === 0) {

      return res.status(400).json({
        error: "Identifiants invalides"
      });
    }


    const user = rows[0];


    const match =
      await bcrypt.compare(
        password,
        user.password_hash
      );


    if (!match) {

      return res.status(400).json({
        error: "Identifiants invalides"
      });
    }


    if (user.status === "pending") {

      return res.status(403).json({
        error:
          "Compte en attente de validation par l'administrateur"
      });
    }


    if (user.status === "rejected") {

      return res.status(403).json({
        error: "Compte refusé"
      });
    }


    const token =
      createToken(user);


    res.json({

      message: "Connexion réussie",

      token,

      user: {

        id: user.id,

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
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});


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

        sql += " WHERE status = ?";

        params.push(status);
      }


      sql += " ORDER BY created_at DESC";


      const [rows] =
        await pool.query(
          sql,
          params
        );


      res.json(rows);

    }
    catch (err) {

      console.error(
        "Erreur /api/admin/users :",
        err
      );

      res.status(500).json({
        error: "Erreur serveur",
        details: err.message,
        code: err.code
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
        error: "Statut invalide"
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


      if (result.affectedRows === 0) {

        return res.status(404).json({
          error: "Utilisateur introuvable"
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
          [userId]
        );


      res.json({
        message: "Statut mis à jour",
        user: rows[0]
      });

    }
    catch (err) {

      console.error(
        "Erreur statut utilisateur :",
        err
      );

      res.status(500).json({
        error: "Erreur serveur",
        details: err.message,
        code: err.code
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
        error: "SETUP_KEY manquant côté serveur"
      });
    }


    if (
      !setupKey ||
      setupKey !== process.env.SETUP_KEY
    ) {

      return res.status(403).json({
        error: "Clé setup invalide"
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
        error: "Tous les champs sont obligatoires"
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
          [email]
        );


      if (existing.length > 0) {

        return res.status(400).json({
          error: "Cet e-mail est déjà utilisé"
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
          [result.insertId]
        );


      res.status(201).json({
        message: "Admin créé avec succès",
        admin: rows[0]
      });

    }
    catch (err) {

      console.error(
        "Erreur /api/setup-admin :",
        err
      );

      res.status(500).json({
        error: "Erreur serveur",
        details: err.message,
        code: err.code
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
      Number(req.params.id);


    if ([1, 3, 5, 10].includes(userId)) {

      return res.status(403).json({
        error: "Cet utilisateur est protégé"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
          DELETE FROM users
          WHERE id = ?
          `,
          [userId]
        );


      if (result.affectedRows === 0) {

        return res.status(404).json({
          error: "Utilisateur introuvable"
        });
      }


      res.json({
        message: "Utilisateur supprimé"
      });

    }
    catch (err) {

      res.status(500).json({
        error: "Erreur serveur",
        details: err.message
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
      Number(req.params.id);


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
        error: "Rôle invalide"
      });
    }


    if ([1, 3, 5, 10].includes(userId)) {

      return res.status(403).json({
        error: "Cet utilisateur est protégé"
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


      if (result.affectedRows === 0) {

        return res.status(404).json({
          error: "Utilisateur introuvable"
        });
      }


      res.json({
        message: "Rôle modifié"
      });

    }
    catch (err) {

      res.status(500).json({
        error: "Erreur serveur",
        details: err.message
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

    res.json(currentCommand);
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
   ========================================================= */

app.post(
  "/api/esp32/data",
  (req, res) => {

    solarData = {

      ...req.body,

      received_at:
        new Date().toISOString()
    };


    esp32Status.connected = true;

    esp32Status.lastSeen =
      new Date().toISOString();

    esp32Status.ip =
      req.body.ip ||
      esp32Status.ip ||
      null;

    esp32Status.heap =
      req.body.heap ||
      esp32Status.heap ||
      null;


    res.json({
      message: "Données reçues"
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

    res.json(solarData);
  }
);


/* =========================================================
   ESP32 PING
   ========================================================= */

app.post(
  "/api/esp32/ping",
  (req, res) => {

    esp32Status.connected = true;

    esp32Status.lastSeen =
      new Date().toISOString();

    esp32Status.ip =
      req.body.ip ||
      null;

    esp32Status.heap =
      req.body.heap ||
      null;


    res.json({
      success: true
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

      points,
      samples

    } = req.body;


    if (
      !Array.isArray(points) ||
      points.length === 0
    ) {

      return res.status(400).json({
        error: "Aucun point I-V reçu"
      });
    }


    if (points.length > 1000) {

      return res.status(400).json({
        error: "Nombre de points trop élevé"
      });
    }


    const measurementSamples =
      Array.isArray(samples)
        ? samples.slice(0, 1000)
        : [];


    let connection;


    try {

      connection =
        await pool.getConnection();


      await connection.beginTransaction();


      /* =========================
         MESURE PRINCIPALE
         ========================= */

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

            points_count,
            samples_count
          )
          VALUES
          (
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
          )
          `,
          [

            req.user.id || null,

            Number.isFinite(Number(series_no))
              ? Number(series_no)
              : 0,

            orient_mode || null,

            Number.isFinite(Number(servo1_deg))
              ? Number(servo1_deg)
              : null,

            Number.isFinite(Number(servo2_deg))
              ? Number(servo2_deg)
              : null,

            Number.isFinite(Number(vmpp))
              ? Number(vmpp)
              : null,

            Number.isFinite(Number(impp))
              ? Number(impp)
              : null,

            Number.isFinite(Number(pmpp))
              ? Number(pmpp)
              : null,

            Number.isFinite(Number(isc))
              ? Number(isc)
              : null,

            Number.isFinite(Number(voc))
              ? Number(voc)
              : null,

            Number.isFinite(Number(umax))
              ? Number(umax)
              : null,

            Number.isFinite(Number(lux_avg))
              ? Number(lux_avg)
              : null,

            Number.isFinite(Number(temp_avg))
              ? Number(temp_avg)
              : null,

            Number.isFinite(Number(hum_avg))
              ? Number(hum_avg)
              : null,

            Number.isFinite(Number(tc_avg))
              ? Number(tc_avg)
              : null,

            points.length,

            measurementSamples.length
          ]
        );


      const measurementId =
        result.insertId;


      /* =========================
         POINTS I-V
         ========================= */

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
              Number(p.p_w);


            if (!Number.isFinite(power)) {

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

              Number.isFinite(Number(p.k))
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
        [pointValues]
      );


      /* =========================
         CAPTEURS PENDANT MESURE
         ========================= */

      if (measurementSamples.length) {

        const sampleValues =
          measurementSamples.map(
            (s, index) => [

              measurementId,

              Number.isFinite(Number(s.k))
                ? Number(s.k)
                : index,

              Number.isFinite(Number(s.seq))
                ? Number(s.seq)
                : null,

              Number.isFinite(Number(s.ts_ms))
                ? Number(s.ts_ms)
                : null,

              Number.isFinite(Number(s.line))
                ? Number(s.line)
                : null,

              Number.isFinite(Number(s.u_v))
                ? Number(s.u_v)
                : null,

              Number.isFinite(Number(s.i_a))
                ? Number(s.i_a)
                : null,

              Number.isFinite(Number(s.lux))
                ? Number(s.lux)
                : null,

              Number.isFinite(Number(s.temp_dht_c))
                ? Number(s.temp_dht_c)
                : null,

              Number.isFinite(Number(s.hum_dht))
                ? Number(s.hum_dht)
                : null,

              Number.isFinite(Number(s.tc_c))
                ? Number(s.tc_c)
                : null,

              Number.isFinite(Number(s.servo1_deg))
                ? Number(s.servo1_deg)
                : null,

              Number.isFinite(Number(s.servo2_deg))
                ? Number(s.servo2_deg)
                : null,

              s.orient_mode ||
              orient_mode ||
              null
            ]
          );


        await connection.query(
          `
          INSERT INTO measurement_samples
          (
            measurement_id,
            k,
            seq,
            ts_ms,
            line_no,
            u_v,
            i_a,
            lux,
            temp_dht_c,
            hum_dht,
            tc_c,
            servo1_deg,
            servo2_deg,
            orient_mode
          )
          VALUES ?
          `,
          [sampleValues]
        );
      }


      await connection.commit();


      const [savedRows] =
        await pool.query(
          `
          SELECT *
          FROM measurements
          WHERE id = ?
          `,
          [measurementId]
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
            m.samples_count,

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


      res.json(rows);

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
   ========================================================= */

app.get(
  "/api/measurements/:id",
  authRequired,
  async (req, res) => {

    const measurementId =
      Number(req.params.id);


    if (
      !Number.isInteger(measurementId) ||
      measurementId <= 0
    ) {

      return res.status(400).json({
        error: "Identifiant de mesure invalide"
      });
    }


    try {

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
          [measurementId]
        );


      if (measurements.length === 0) {

        return res.status(404).json({
          error: "Mesure introuvable"
        });
      }


      const measurement =
        measurements[0];


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
          [measurementId]
        );


      const [samples] =
        await pool.query(
          `
          SELECT

            k,

            seq,

            ts_ms,

            line_no AS line,

            u_v,
            i_a,

            lux,

            temp_dht_c,
            hum_dht,
            tc_c,

            servo1_deg,
            servo2_deg,

            orient_mode

          FROM measurement_samples

          WHERE measurement_id = ?

          ORDER BY id ASC
          `,
          [measurementId]
        );


      res.json({

        id:
          measurement.id,

        user_id:
          measurement.user_id,

        created_at:
          measurement.created_at,

        points_count:
          measurement.points_count,

        samples_count:
          measurement.samples_count,


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


        user: {

          firstname:
            measurement.firstname,

          lastname:
            measurement.lastname,

          email:
            measurement.email
        },


        points:
          points.map(
            p => ({

              k:
                p.k,

              x:
                Number(p.u_v),

              y:
                Number(p.i_a),

              p_w:
                p.p_w === null
                  ? null
                  : Number(p.p_w)
            })
          ),


        samples:
          samples.map(
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
                s.u_v === null
                  ? null
                  : Number(s.u_v),

              i_a:
                s.i_a === null
                  ? null
                  : Number(s.i_a),

              lux:
                s.lux === null
                  ? null
                  : Number(s.lux),

              temp_dht_c:
                s.temp_dht_c === null
                  ? null
                  : Number(s.temp_dht_c),

              hum_dht:
                s.hum_dht === null
                  ? null
                  : Number(s.hum_dht),

              tc_c:
                s.tc_c === null
                  ? null
                  : Number(s.tc_c),

              servo1_deg:
                s.servo1_deg,

              servo2_deg:
                s.servo2_deg,

              orient_mode:
                s.orient_mode
            })
          )
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
      Number(req.params.id);


    if (
      !Number.isInteger(measurementId) ||
      measurementId <= 0
    ) {

      return res.status(400).json({
        error: "Identifiant de mesure invalide"
      });
    }


    try {

      const [result] =
        await pool.query(
          `
          DELETE FROM measurements
          WHERE id = ?
          `,
          [measurementId]
        );


      if (result.affectedRows === 0) {

        return res.status(404).json({
          error: "Mesure introuvable"
        });
      }


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

            COUNT(*) AS total_measurements,

            COALESCE(
              SUM(points_count),
              0
            ) AS total_points,

            MAX(created_at)
              AS last_measurement

          FROM measurements
          `
        );


      res.json(rows[0]);

    }
    catch (err) {

      res.status(500).json({
        error:
          "Impossible de lire les statistiques"
      });
    }
  }
);


/* =========================================================
   DEMARRAGE SERVEUR
   ========================================================= */

async function startServer() {

  try {

    const [dbRows] =
      await pool.query(`
        SELECT DATABASE() AS db
      `);


    console.log(
      "Base MySQL connectée :",
      dbRows[0]?.db
    );


    await ensureMeasurementTables();


    app.listen(
      PORT,
      () => {

        console.log(
          `Serveur SolarMonitor lancé sur le port ${PORT}`
        );

        console.log(
          "Historique MySQL activé"
        );
      }
    );

  }
  catch (err) {

    console.error(
      "Impossible de démarrer SolarMonitor :",
      err
    );

    process.exit(1);
  }
}


startServer();