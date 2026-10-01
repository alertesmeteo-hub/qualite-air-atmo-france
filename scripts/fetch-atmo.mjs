#!/usr/bin/env node
// Pipeline qualite de l'air (indice ATMO global + NO2/O3/PM10/PM2.5/SO2) pour la France
// entiere, par commune (puis agregee par departement pour la vue d'ensemble), aujourd'hui
// et demain.
//
// Source : API Atmo Data v2 (admindata.atmo-france.org/api/doc/v2), endpoint
// GET /api/v2/data/indices/atmo. Authentification par compte (voir
// https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa), identifiants
// passes par variables d'environnement ATMO_USERNAME / ATMO_PASSWORD (secrets GitHub
// Actions), jamais en dur dans le code.
//
// Il n'existe pas de parametre "departement" cote API : seuls commune/EPCI (code_zone, code
// INSEE) sont filtrables, ou "toutes les zones" par defaut (ce qu'on utilise ici, une requete
// par jour). Les ~35000 communes remontees sont ensuite regroupees par departement (les 2
// premiers caracteres du code INSEE, sauf Corse "2A"/"2B" deja sous cette forme et DOM a
// prefixe 3 chiffres 971/972/973/974/976) : l'indice retenu pour le departement est le pire
// (max) constate parmi ses communes, pour une vue d'ensemble coherente avec un principe de
// precaution.
//
// Usage :
//   ATMO_USERNAME=... ATMO_PASSWORD=... node scripts/fetch-atmo.mjs --output-dir data

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://admindata.atmo-france.org";
const AUTH_URL = `${BASE_URL}/api/login`;
const INDICES_URL = `${BASE_URL}/api/v2/data/indices/atmo`;

const POLLUTANT_KEYS = ["code_no2", "code_o3", "code_pm10", "code_pm25", "code_so2"];
const DOM_PREFIXES = ["971", "972", "973", "974", "976"];

function departementDeCommune(codeInsee) {
  if (!codeInsee) return null;
  const p3 = codeInsee.slice(0, 3);
  if (DOM_PREFIXES.includes(p3)) return p3;
  return codeInsee.slice(0, 2); // couvre aussi "2A"/"2B" pour la Corse
}

function parseArgs(argv) {
  const args = { outputDir: "data" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output-dir") args.outputDir = argv[++i];
    else throw new Error(`Argument inconnu : ${a}`);
  }
  return args;
}

function log(...parts) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

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
  const token = data.token ?? data.access_token ?? data.jwt;
  if (!token) throw new Error(`Reponse de login sans token reconnu : ${JSON.stringify(data)}`);
  return token;
}

async function getIndicesForDate(token, dateIso) {
  const url = `${INDICES_URL}?format=geojson&date=${dateIso}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Echec recuperation indices pour ${dateIso} (HTTP ${res.status}) : ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

function parisDateIso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
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

  const jours = [parisDateIso(0), parisDateIso(1)];
  const communes = {}; // code_zone -> { nom, parJour: { date: {...} } }
  const departements = {}; // code_dept -> { parJour: { date: { ...max par polluant, nbCommunes } } }

  for (const dateIso of jours) {
    log(`Recuperation des indices pour ${dateIso}...`);
    const features = await getIndicesForDate(token, dateIso);
    log(`  ${features.length} communes recues.`);
    for (const f of features) {
      const p = f.properties ?? {};
      const codeInsee = String(p.code_zone ?? "");
      if (!codeInsee) continue;
      const valeurs = Object.fromEntries(POLLUTANT_KEYS.map((k) => [k, typeof p[k] === "number" ? p[k] : null]));
      valeurs.code_qual = typeof p.code_qual === "number" ? p.code_qual : null;

      if (!communes[codeInsee]) communes[codeInsee] = { nom: p.lib_zone ?? null, lat: p.y_wgs84 ?? null, lon: p.x_wgs84 ?? null, parJour: {} };
      communes[codeInsee].parJour[dateIso] = valeurs;

      const dept = departementDeCommune(codeInsee);
      if (!dept) continue;
      if (!departements[dept]) departements[dept] = { parJour: {} };
      if (!departements[dept].parJour[dateIso]) {
        departements[dept].parJour[dateIso] = Object.fromEntries([...POLLUTANT_KEYS, "code_qual"].map((k) => [k, null]));
        departements[dept].parJour[dateIso].nbCommunes = 0;
      }
      const agg = departements[dept].parJour[dateIso];
      agg.nbCommunes++;
      for (const k of [...POLLUTANT_KEYS, "code_qual"]) {
        const v = valeurs[k];
        if (typeof v === "number" && (agg[k] === null || v > agg[k])) agg[k] = v;
      }
    }
  }

  const nbCommunes = Object.keys(communes).length;
  const nbDepartements = Object.keys(departements).length;
  log(`Total : ${nbCommunes} communes, ${nbDepartements} departements.`);

  await mkdir(args.outputDir, { recursive: true });
  await writeFile(
    path.join(args.outputDir, "departements.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), jours, source: "Atmo France (admindata.atmo-france.org)", departements }),
  );
  await writeFile(
    path.join(args.outputDir, "communes.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), jours, source: "Atmo France (admindata.atmo-france.org)", communes }),
  );
  log(`Ecrit ${args.outputDir}/departements.json et ${args.outputDir}/communes.json`);

  if (!nbCommunes) {
    throw new Error("Aucune commune recuperee : verifier la reponse de l'API (quota, format de date...)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
