#!/usr/bin/env node
// Pipeline qualite de l'air (indice ATMO global + NO2/O3/PM10/PM2.5/SO2) pour la France
// entiere, par departement, aujourd'hui et demain.
//
// Source : API Atmo France (admindata.atmo-france.org), authentification par compte
// (voir https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa). Les
// identifiants sont passes par variables d'environnement ATMO_USERNAME / ATMO_PASSWORD
// (secrets GitHub Actions), jamais en dur dans le code.
//
// IMPORTANT (a verifier au premier run reel, aucun compte disponible au moment de l'ecriture) :
// le format exact de "code_zone" pour interroger au niveau departement (plutot que commune,
// seul niveau documente dans l'integration Home Assistant de reference) n'est pas confirme.
// On tente d'abord le code INSEE departement tel quel (ex: "66", "2A", "971"). Si l'API ne
// renvoie aucune "feature" pour un departement, le script le signale dans le resume (voir
// `manquants` dans la sortie) sans faire echouer tout le run : une persone devra alors
// verifier via la doc API (admindata.atmo-france.org/api/doc) ou interroger une commune
// representative du departement et agreger.
//
// Usage :
//   ATMO_USERNAME=... ATMO_PASSWORD=... node scripts/fetch-atmo.mjs --output-dir data

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://admindata.atmo-france.org";
const AUTH_URL = `${BASE_URL}/api/login`;
const DATA_URL = `${BASE_URL}/api/data`;
const CODE_POLLUTION = 112;

// Les 96 departements metropolitains (2A/2B pour la Corse) + DOM principaux. Memes codes que
// `config/departements-france.geojson` (repo harmonie), reutilisable tel quel pour le tracé de
// la carte cote front (meme logique de projection lon/lat -> pixel que les autres cartes SVG
// du site).
const DEPARTEMENTS = [
  "01","02","03","04","05","06","07","08","09","10","11","12","13","14","15","16","17","18","19",
  "2A","2B","21","22","23","24","25","26","27","28","29","30","31","32","33","34","35","36","37",
  "38","39","40","41","42","43","44","45","46","47","48","49","50","51","52","53","54","55","56",
  "57","58","59","60","61","62","63","64","65","66","67","68","69","70","71","72","73","74","75",
  "76","77","78","79","80","81","82","83","84","85","86","87","88","89","90","91","92","93","94",
  "95","971","972","973","974","976",
];

const POLLUTANT_KEYS = ["code_no2", "code_o3", "code_pm10", "code_pm25", "code_so2", "code_qual"];

function parseArgs(argv) {
  const args = { outputDir: "data", pacingMs: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output-dir") args.outputDir = argv[++i];
    else if (a === "--pacing-ms") args.pacingMs = Number(argv[++i]);
    else throw new Error(`Argument inconnu : ${a}`);
  }
  return args;
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getToken(username, password) {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`Echec authentification Atmo France (HTTP ${res.status}) : ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("Reponse de login sans token");
  return data.token;
}

async function getZoneData(token, zoneCode, todayIso) {
  const filtre = {
    code_zone: { operator: "=", value: zoneCode },
    date_ech: { operator: ">=", value: todayIso },
  };
  const url = `${DATA_URL}/${CODE_POLLUTION}/${JSON.stringify(filtre)}?withGeom=false`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    log(`  ! HTTP ${res.status} pour ${zoneCode}`);
    return [];
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

function todayIsoParis() {
  const fmt = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = process.env.ATMO_USERNAME;
  const password = process.env.ATMO_PASSWORD;
  if (!username || !password) {
    throw new Error("ATMO_USERNAME et ATMO_PASSWORD doivent etre definies (secrets GitHub Actions)");
  }

  log("Authentification Atmo France...");
  const token = await getToken(username, password);
  log("Token obtenu.");

  const todayIso = todayIsoParis();
  const departements = {};
  const manquants = [];

  for (const code of DEPARTEMENTS) {
    const features = await getZoneData(token, code, todayIso);
    if (!features.length) {
      manquants.push(code);
      await sleep(args.pacingMs);
      continue;
    }
    const parJour = {};
    for (const f of features) {
      const p = f.properties ?? {};
      if (!p.date_ech) continue;
      parJour[p.date_ech] = Object.fromEntries(POLLUTANT_KEYS.map((k) => [k, p[k] ?? null]));
    }
    departements[code] = {
      nom: features[0]?.properties?.lib_zone ?? null,
      typeZone: features[0]?.properties?.type_zone ?? null,
      dateMaj: features[0]?.properties?.date_maj ?? null,
      source: features[0]?.properties?.source ?? null,
      parJour,
    };
    log(`  OK ${code} (${departements[code].nom ?? "?"}) : ${Object.keys(parJour).length} jour(s)`);
    await sleep(args.pacingMs);
  }

  if (manquants.length) {
    log(`Departements sans donnee (a investiguer, voir commentaire en tete de script) : ${manquants.join(", ")}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    todayIso,
    source: "Atmo France (admindata.atmo-france.org)",
    departements,
    manquants,
  };

  await mkdir(args.outputDir, { recursive: true });
  await writeFile(path.join(args.outputDir, "departements.json"), JSON.stringify(out));
  log(`Ecrit ${Object.keys(departements).length}/${DEPARTEMENTS.length} departements dans ${args.outputDir}/departements.json`);

  if (!Object.keys(departements).length) {
    throw new Error("Aucun departement recupere : verifier le format de code_zone (voir commentaire en tete de fichier)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
