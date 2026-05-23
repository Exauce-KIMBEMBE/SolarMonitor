require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 4000;

// ============================================
// Middlewares
// ============================================

app.use(cors());
app.use(express.json());
app.use(express.static("public"));


// ============================================
// PostgreSQL
// ============================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
            : false
});


// ============================================
// JWT
// ============================================

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


// ============================================
// Auth middleware
// ============================================

function authRequired(req, res, next) {

    const authHeader = req.headers.authorization || "";

    const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

    if (!token) {
        return res.status(401).json({
            error: "Token manquant"
        });
    }

    try {

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET
        );

        req.user = decoded;

        next();

    }
    catch {

        return res.status(401).json({
            error: "Token invalide"
        });

    }

}


function adminRequired(req,res,next){

    if(!req.user || req.user.role!=="admin"){

        return res.status(403).json({
            error:"Accès administrateur uniquement"
        });

    }

    next();

}


// ============================================
// Variables mémoire ESP32
// (temporaire avant table SQL)
// ============================================

let currentCommand = {

    mode:"manual",
    angleX:0,
    angleY:0,
    tracking:false

};

let solarData = {

    temperature:null,
    lux:null,
    thermocouple:null,
    angleX:0,
    angleY:0

};


// ============================================
// Test serveur
// ============================================

app.get("/",(req,res)=>{

    res.json({

        status:true,
        project:"SolarTrackHub",
        message:"Serveur actif 🚀"

    });

});



// ============================================
// INSCRIPTION
// ============================================

app.post("/api/register",async(req,res)=>{

try{

const{
firstname,
lastname,
email,
password
}=req.body;


if(
!firstname ||
!lastname ||
!email ||
!password
){

return res.status(400).json({
error:"Tous les champs sont obligatoires"
});

}


const existing=
await pool.query(

"SELECT id FROM users WHERE email=$1",
[email]

);


if(existing.rows.length>0){

return res.status(400).json({
error:"Email déjà utilisé"
});

}


const hash=
await bcrypt.hash(password,10);


const result=
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
(
$1,
$2,
$3,
$4,
'user',
'pending'
)

RETURNING *
`,
[
firstname,
lastname,
email,
hash
]

);


res.status(201).json({

message:
"Demande envoyée en attente validation admin",

user:result.rows[0]

});


}

catch(err){

console.log(err);

res.status(500).json({
error:"Erreur serveur"
});

}

});



// ============================================
// CONNEXION
// ============================================

app.post("/api/login",async(req,res)=>{

try{

const{
email,
password
}=req.body;


const result=
await pool.query(

"SELECT * FROM users WHERE email=$1",
[email]

);


if(result.rows.length===0){

return res.status(400).json({
error:"Identifiants invalides"
});

}


const user=result.rows[0];


const match=
await bcrypt.compare(
password,
user.password_hash
);


if(!match){

return res.status(400).json({
error:"Identifiants invalides"
});

}


if(user.status==="pending"){

return res.status(403).json({
error:"Compte en attente"
});

}


if(user.status==="rejected"){

return res.status(403).json({
error:"Compte refusé"
});

}


const token=createToken(user);


res.json({

message:"Connexion réussie",

token,

user:{

id:user.id,
firstname:user.firstname,
lastname:user.lastname,
email:user.email,
role:user.role

}

});


}

catch(err){

console.log(err);

res.status(500).json({
error:"Erreur serveur"
});

}

});



// ============================================
// ADMIN USERS
// ============================================

app.get(
"/api/admin/users",
authRequired,
adminRequired,

async(req,res)=>{

try{

const users=
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
`

);

res.json(
users.rows
);

}
catch(err){

res.status(500).json({
error:"Erreur serveur"
});

}

}

);




// ============================================
// Changer statut user
// ============================================

app.patch(
"/api/admin/users/:id/status",
authRequired,
adminRequired,

async(req,res)=>{

try{

const id=req.params.id;

const{
status
}=req.body;


const result=
await pool.query(

`
UPDATE users
SET status=$1
WHERE id=$2
RETURNING *
`,
[
status,
id
]

);


res.json({

message:"Utilisateur mis à jour",

user:result.rows[0]

});


}
catch(err){

res.status(500).json({
error:"Erreur serveur"
});

}

}

);


// ============================================
// ESP32 reçoit commande
// ============================================

app.get(
"/api/esp32/command",
(req,res)=>{

res.json(
currentCommand
);

}
);


// ============================================
// Site envoie commande
// ============================================

app.post(
"/api/esp32/command",
(req,res)=>{

currentCommand=req.body;

res.json({

message:"Commande enregistrée"

});

}
);


// ============================================
// ESP32 envoie mesures
// ============================================

app.post(
"/api/esp32/data",
(req,res)=>{

solarData=req.body;

res.json({

message:"Données reçues"

});

}
);


// ============================================
// Site lit données
// ============================================

app.get(
"/api/esp32/data",
(req,res)=>{

res.json(
solarData
);

}
);


// ============================================
// Lancer serveur
// ============================================

app.listen(PORT,()=>{

console.log(

`Serveur SolarTrackHub lancé sur ${PORT}`

);

});
