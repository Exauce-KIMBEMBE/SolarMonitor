/* =========================================================
   SolarMonitor Dashboard
   Gestion utilisateurs + ESP32 + permissions
========================================================= */

const $=(id)=>document.getElementById(id);

const fmt=(v,nd=2)=>
(v===null||v===undefined||Number.isNaN(Number(v)))
?"—"
:Number(v).toFixed(nd).replace(/\.0+$/,"");

const API_URL="https://solarmonitor.onrender.com";

const LUX_SCALE=1000;

let esp32Connected=false;

let currentUser=null;
let isManager=false;

let currentOrientMode="manual";
let currentTracker=false;

let histLabels=[];
let histLux=[];
let histTemp=[];
let histHum=[];
let histTc=[];


/* ================= AUTH ================= */

function loadUser(){

try{

currentUser=
JSON.pafunction loadUser(){

try{

currentUser =
JSON.parse(
localStorage.getItem("user")
);

}
catch{

currentUser = null;

}

/* Par défaut visiteur simple */
isManager = false;

/* Si connecté */
if(currentUser){

isManager =
currentUser.role === "admin" ||
currentUser.role === "manager";

}

/* On applique les droits sans rediriger */
applyPermissions();

}


/* ================= Permissions ================= */

function applyPermissions(){

const controls=
document.querySelectorAll(
".esp32-control"
);

controls.forEach(el=>{

if(!isManager){

el.disabled=true;

el.style.opacity=".4";

el.style.pointerEvents="none";

el.title=
"Seul le manager peut manipuler le panneau";

}

});

}


/* ================= ESP32 ================= */

async function checkESP32(){

try{

const res=
await fetch(
`${API_URL}/api/esp32/status`
);

const data=
await res.json();

esp32Connected=
data.connected===true;

updateESP32UI(data);

}
catch{

esp32Connected=false;

updateESP32UI();

}

}


function updateESP32UI(data={}){

$("conn").textContent=

esp32Connected
?
"ESP32 : Connectée"
:
"ESP32 : Déconnectée";


$("esp32Status").textContent=

esp32Connected
?
"Connectée"
:
"Déconnectée";


$("esp32LastSeen").textContent=
data.lastSeen||"—";

$("esp32Ip").textContent=
data.ip||"—";


updateControls();

}


function updateControls(){
  const controls=
  document.querySelectorAll(
  ".esp32-control"
  );
  
  controls.forEach(el=>{
  
  const enabled=
  (
  esp32Connected &&
  isManager
  );
  
  el.disabled=!enabled;
  
  el.style.opacity=
  enabled?"1":"0.4";
  
  el.style.pointerEvents=
  enabled?"auto":"none";
  });
}

/* ================= COMMANDES ================= */

async function sendCmd(cmd){

if(!isManager){

alert(
"Seul le manager peut contrôler le panneau"
);

return;

}

if(!esp32Connected){

alert(
"ESP32 déconnectée"
);

return;

}

try{

await fetch(

`${API_URL}/api/esp32/command`,

{

method:"POST",

headers:{

"Content-Type":"application/json"

},

body:JSON.stringify(cmd)

}

);

}
catch(err){

console.log(err);

}

}


/* ================= Lecture ESP32 ================= */

async function getESP32Data(){

   /* Il faut être connecté pour voir les données */
   if(!currentUser){
   
   if($("conn")){
   $("conn").textContent = "Connectez-vous pour voir les données";
   }
   
   return;
   
   }
   
   try{
   
   const res =
   await fetch(
   `${API_URL}/api/esp32/data`
   );
   
   const s =
   await res.json();
   
   applySample(s);
   
   }
   catch(err){
   
   console.log(err);
   
   }
}


function applySample(s){

if(!s)return;


/* capteurs */

if("temp_dht_c" in s){

$("liveTemp").textContent=

fmt(
s.temp_dht_c,
1
);

}


if("lux" in s){

$("liveLux").textContent=

fmt(
s.lux,
0
);

}


if("hum_dht" in s){

$("liveHumidity").textContent=

fmt(
s.hum_dht,
0
);

}


if("tc_c" in s){

$("liveTc").textContent=

fmt(
s.tc_c,
1
);

}


/* LDR */

if("ldr_l" in s)
$("ldrL").textContent=
s.ldr_l?"ON":"OFF";


if("ldr_r" in s)
$("ldrR").textContent=
s.ldr_r?"ON":"OFF";


if("ldr_h" in s)
$("ldrH").textContent=
s.ldr_h?"ON":"OFF";


if("ldr_b" in s)
$("ldrB").textContent=
s.ldr_b?"ON":"OFF";


/* servos */

if("servo1_deg" in s){

$("servo1Live").textContent=
`${s.servo1_deg}°`;

$("servo1Val").textContent=
`${s.servo1_deg}°`;

$("servo1Range").value=
s.servo1_deg;

}


if("servo2_deg" in s){

$("servo2Live").textContent=
`${s.servo2_deg}°`;

$("servo2Val").textContent=
`${s.servo2_deg}°`;

$("servo2Range").value=
s.servo2_deg;

}


/* tracker */

if("tracker" in s){

currentTracker=
!!s.tracker;

$("trackerTxt").textContent=

currentTracker
?
"ON"
:
"OFF";

}


/* orientation */

if("orient_mode" in s){

currentOrientMode=
s.orient_mode;

$("orientModeTxt")
.textContent=
currentOrientMode;

$("orientModeBar")
.textContent=
currentOrientMode;

}


/* historique temps réel */

if("seq" in s){

histLabels.push(s.seq);

histLux.push(
Number(s.lux)||0
);

histTemp.push(
Number(s.temp_dht_c)||0
);

histHum.push(
Number(s.hum_dht)||0
);

histTc.push(
Number(s.tc_c)||0
);

refreshCharts();
}
}

/* ================= Graphiques ================= */

function refreshCharts(){

if(!window.lineChart)return;

lineChart.data.labels=
histLabels.slice(-150);

lineChart.data.datasets[0].data=
histLux.slice(-150);

lineChart.data.datasets[1].data=
histTemp.slice(-150);

lineChart.data.datasets[2].data=
histHum.slice(-150);

lineChart.data.datasets[3].data=
histTc.slice(-150);

lineChart.update("none");

}


/* ================= Boutons ================= */

function wireButtons(){


$("btnStart")
?.addEventListener(
"click",
()=>{

sendCmd({

cmd:"start",
orient:currentOrientMode

});

}
);


$("btnStop")
?.addEventListener(
"click",
()=>{

sendCmd({

cmd:"stop"

});

}
);


$("btnScanFull")
?.addEventListener(
"click",
()=>{

sendCmd({

cmd:"scan",
type:"full",
orient:currentOrientMode

});

}
);


$("btnApplyOrient")
?.addEventListener(
"click",
()=>{

const mode=
document.querySelector(
'input[name="orientMode"]:checked'
)?.value;

currentOrientMode=mode;

sendCmd({

cmd:"orient",
mode

});

}
);


$("btnTrackerOn")
?.addEventListener(
"click",
()=>{

currentTracker=true;

sendCmd({

cmd:"tracker",
enabled:true

});

}
);


$("btnTrackerOff")
?.addEventListener(
"click",
()=>{

currentTracker=false;

sendCmd({

cmd:"tracker",
enabled:false

});

}
);


$("btnStatus")
?.addEventListener(
"click",
()=>{

checkESP32();

}
);


$("btnSetPeriod")
?.addEventListener(
"click",
()=>{

const ms=
Number(
$("periodMs").value
);

if(!ms)return;

sendCmd({

cmd:"schedule",
period_ms:ms

});

}
);


/* servos */

$("servo1Range")
?.addEventListener(
"input",
e=>{

sendCmd({

cmd:"servo",
index:1,
angle:Number(
e.target.value
)

});

}
);


$("servo2Range")
?.addEventListener(
"input",
e=>{

sendCmd({

cmd:"servo",
index:2,
angle:Number(
e.target.value
)

});

}
);


/* connexion manuelle */

$("btnManualConnect")
?.addEventListener(
"click",
()=>{

checkESP32();

}
);

}


/* ================= Initialisation ================= */

window.addEventListener(

"DOMContentLoaded",

()=>{

loadUser();

wireButtons();


/* vérification connexion ESP32 */

checkESP32();

setInterval(

checkESP32,

5000

);


/* lecture données ESP32 */

getESP32Data();

setInterval(

getESP32Data,

1000

);

}

);
