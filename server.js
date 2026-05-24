require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token invalide" });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      error: "Accès réservé au manager/admin"
    });
  }

  next();
}

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

app.get("/", (req, res) => {
  res.json({
    status: true,
    project: "SolarMonitor",
    message: "Serveur SolarMonitor actif"
  });
});

app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DATABASE() AS db, NOW() AS serverTime"
    );

    res.json({
      ok: true,
      database: rows[0]
    });
  } catch (err) {
    console.log("MYSQL ERREUR :", err);

    res.status(500).json({
      ok: false,
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState
    });
  }
});

/* ================= INSCRIPTION ================= */

app.post("/api/register", async (req, res) => {
  const { firstname, lastname, email, password } = req.body;

  if (!firstname || !lastname || !email || !password) {
    return res.status(400).json({
      error: "Tous les champs sont obligatoires"
    });
  }

  try {
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "Cet e-mail est déjà utilisé"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `
      INSERT INTO users
      (firstname, lastname, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'user', 'pending')
      `,
      [firstname, lastname, email, hash]
    );

    const [rows] = await pool.query(
      `
      SELECT id, firstname, lastname, email, role, status, created_at
      FROM users
      WHERE id = ?
      `,
      [result.insertId]
    );

    res.status(201).json({
      message: "Demande d'inscription envoyée. En attente de validation par le manager.",
      user: rows[0]
    });

  } catch (err) {
    console.error("Erreur /api/register :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});

/* ================= CONNEXION ================= */

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      error: "E-mail et mot de passe requis"
    });
  }

  try {
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (rows.length === 0) {
      return res.status(400).json({
        error: "Identifiants invalides"
      });
    }

    const user = rows[0];

    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(400).json({
        error: "Identifiants invalides"
      });
    }

    if (user.status === "pending") {
      return res.status(403).json({
        error: "Compte en attente de validation par le manager"
      });
    }

    if (user.status === "rejected") {
      return res.status(403).json({
        error: "Compte refusé"
      });
    }

    const token = createToken(user);

    res.json({
      message: "Connexion réussie",
      token,
      user: {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });

  } catch (err) {
    console.error("Erreur /api/login :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});

/* ================= ADMIN / MANAGER ================= */

app.get("/api/admin/users", authRequired, adminRequired, async (req, res) => {
  const { status } = req.query;

  try {
    let sql = `
      SELECT id, firstname, lastname, email, role, status, created_at
      FROM users
    `;

    const params = [];

    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC";

    const [rows] = await pool.query(sql, params);

    res.json(rows);

  } catch (err) {
    console.error("Erreur /api/admin/users :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});

app.patch("/api/admin/users/:id/status", authRequired, adminRequired, async (req, res) => {
  const userId = req.params.id;
  const { status } = req.body;

  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({
      error: "Statut invalide"
    });
  }

  try {
    const [result] = await pool.query(
      "UPDATE users SET status = ? WHERE id = ?",
      [status, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: "Utilisateur introuvable"
      });
    }

    const [rows] = await pool.query(
      `
      SELECT id, firstname, lastname, email, role, status
      FROM users
      WHERE id = ?
      `,
      [userId]
    );

    res.json({
      message: "Statut mis à jour",
      user: rows[0]
    });

  } catch (err) {
    console.error("Erreur /api/admin/users/:id/status :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});

/* ================= CREER ADMIN TEMPORAIRE ================= */

app.post("/api/setup-admin", async (req, res) => {
  const setupKey = req.headers["x-setup-key"];

  if (!process.env.SETUP_KEY) {
    return res.status(500).json({
      error: "SETUP_KEY manquant côté serveur"
    });
  }

  if (!setupKey || setupKey !== process.env.SETUP_KEY) {
    return res.status(403).json({
      error: "Clé setup invalide"
    });
  }

  const { firstname, lastname, email, password } = req.body;

  if (!firstname || !lastname || !email || !password) {
    return res.status(400).json({
      error: "Tous les champs sont obligatoires"
    });
  }

  try {
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        error: "Cet e-mail est déjà utilisé"
      });
    }

    const hash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `
      INSERT INTO users
      (firstname, lastname, email, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'admin', 'approved')
      `,
      [firstname, lastname, email, hash]
    );

    const [rows] = await pool.query(
      `
      SELECT id, firstname, lastname, email, role, status, created_at
      FROM users
      WHERE id = ?
      `,
      [result.insertId]
    );

    res.status(201).json({
      message: "Admin créé avec succès",
      admin: rows[0]
    });

  } catch (err) {
    console.error("Erreur /api/setup-admin :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message,
      code: err.code
    });
  }
});

/* ================= Delete user ================= */
app.delete("/api/admin/users/:id", authRequired, adminRequired, async (req, res) => {
  const userId = req.params.id;

  try {
    const [result] = await pool.query(
      "DELETE FROM users WHERE id = ?",
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

  } catch (err) {
    console.error("Erreur DELETE /api/admin/users/:id :", err);

    res.status(500).json({
      error: "Erreur serveur",
      details: err.message
    });
  }
});


/* ================= ESP32 COMMANDES ================= */

app.get("/api/esp32/command", (req, res) => {
  res.json(currentCommand);
});

app.post("/api/esp32/command", authRequired, adminRequired, (req, res) => {
  currentCommand = {
    ...req.body,
    created_at: new Date().toISOString()
  };

  res.json({
    message: "Commande enregistrée",
    command: currentCommand
  });
});

/* ================= ESP32 DATA ================= */

app.post("/api/esp32/data", (req, res) => {
  solarData = {
    ...req.body,
    received_at: new Date().toISOString()
  };

  esp32Status.connected = true;
  esp32Status.lastSeen = new Date().toISOString();
  esp32Status.ip = req.body.ip || esp32Status.ip || null;
  esp32Status.heap = req.body.heap || esp32Status.heap || null;

  res.json({
    message: "Données reçues"
  });
});

app.get("/api/esp32/data", authRequired, (req, res) => {
  res.json(solarData);
});

/* ================= ESP32 PING / STATUS ================= */

app.post("/api/esp32/ping", (req, res) => {
  esp32Status.connected = true;
  esp32Status.lastSeen = new Date().toISOString();
  esp32Status.ip = req.body.ip || null;
  esp32Status.heap = req.body.heap || null;

  res.json({
    success: true
  });
});

app.get("/api/esp32/status", (req, res) => {
  const now = Date.now();

  const last = esp32Status.lastSeen
    ? new Date(esp32Status.lastSeen).getTime()
    : 0;

  const connected = now - last < 10000;

  esp32Status.connected = connected;

  res.json({
    connected,
    lastSeen: esp32Status.lastSeen,
    ip: esp32Status.ip,
    heap: esp32Status.heap
  });
});

app.listen(PORT, () => {
  console.log(`Serveur SolarMonitor lancé sur le port ${PORT}`);
});
