#!/usr/bin/env node
// Pipeline qualite de l'air (indice ATMO global + NO2/O3/PM10/PM2.5/SO2) pour la France
// entiere, par zone (commune ou EPCI selon l'AASQA) puis agregee par departement, aujourd'hui
// et demain.
//
// Source : API Atmo Data v2 (admindata.atmo-france.org/api/doc/v2), endpoint
// GET /api/v2/data/indices/atmo. Authentification par compte (voir
// https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa), identifiants
// passes par variables d'environnement ATMO_USERNAME / ATMO_PASSWORD (secrets GitHub
// Actions), jamais en dur dans le code.
//
// Deux pieges decouverts en testant avec un vrai compte (voir aussi README) :
// 1) La requete "toutes zones" (sans code_zone) n'inclut PAS toutes les AASQA : Occitanie (76),
//    Bretagne (53) et Guyane (03) en sont absentes (comportement constate, non documente). On
//    les recupere donc explicitement en plus de la requete globale.
// 2) Certaines AASQA (Occitanie, Bretagne) publient par EPCI (communaute de communes/agglo,
//    code SIREN) et non par commune (code INSEE) : le prefixe du code ne permet donc pas de
//    retrouver le departement. On utilise alors les coordonnees (x_wgs84/y_wgs84) et un test
//    point-dans-polygone contre les contours des departements metropolitains (meme geojson que
//    les autres cartes du site) pour determiner le departement. Les zones DOM-TOM (hors de ce
//    geojson) restent identifiees par prefixe de code INSEE (971/972/973/974/976).
//
// Usage :
//   ATMO_USERNAME=... ATMO_PASSWORD=... node scripts/fetch-atmo.mjs --output-dir data

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const BASE_URL = "https://admindata.atmo-france.org";
const AUTH_URL = `${BASE_URL}/api/login`;
const INDICES_URL = `${BASE_URL}/api/v2/data/indices/atmo`;
const DEPARTEMENTS_GEOJSON_URL = "https://raw.githubusercontent.com/alertesmeteo-hub/harmonie/main/config/departements-france.geojson";

const POLLUTANT_KEYS = ["code_no2", "code_o3", "code_pm10", "code_pm25", "code_so2"];
const DOM_PREFIXES = ["971", "972", "973", "974", "976"];
// AASQA absentes de la requete "toutes zones" par defaut (constate empiriquement, voir
// commentaire en tete de fichier) : a interroger explicitement en plus.
const AASQA_MANQUANTES_PAR_DEFAUT = ["76", "53", "03"];
// AASQA couvrant un seul DOM : associer directement par aasqa plutot que de parser code_zone
// (voir commentaire plus bas sur le format non standard de l'AASQA Guyane).
const AASQA_DOM_DEPT = { "01": "971", "02": "972", "03": "973", "04": "974", "06": "976" };

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

async function getIndices(token, dateIso, aasqa) {
  const url = `${INDICES_URL}?format=geojson&date=${dateIso}${aasqa ? `&aasqa=${aasqa}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Echec recuperation indices pour ${dateIso}${aasqa ? ` (aasqa=${aasqa})` : ""} (HTTP ${res.status}) : ${await res.text().catch(() => "")}`);
  }
  const json = await res.json();
  return Array.isArray(json?.features) ? json.features : [];
}

function parisDateIso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

// --- Point-dans-polygone (ray casting), avec bounding box pre-calculee par departement pour un
// rejet rapide. Les coordonnees du geojson sont en [lon, lat] (WGS84), comme x_wgs84/y_wgs84.
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function polygonContains(coordinates, x, y) {
  // Polygon : [ring_exterieur, ring_trou1, ...]. Un point dans un trou n'est pas dans le polygone.
  if (!polygonContains_inRing(coordinates[0], x, y)) return false;
  for (let i = 1; i < coordinates.length; i++) {
    if (polygonContains_inRing(coordinates[i], x, y)) return false;
  }
  return true;
}
const polygonContains_inRing = ringContains;

async function chargerDepartementsGeo() {
  const res = await fetch(DEPARTEMENTS_GEOJSON_URL);
  const geo = await res.json();
  return geo.features.map((f) => {
    const geom = f.geometry;
    const polygons = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates; // MultiPolygon
    const all = polygons.flat(2);
    const lons = all.filter((_, i) => i % 2 === 0);
    const lats = all.filter((_, i) => i % 2 === 1);
    return {
      code: f.properties.code,
      polygons,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    };
  });
}

function departementParCoordonnees(departementsGeo, lon, lat) {
  for (const d of departementsGeo) {
    const [x0, y0, x1, y1] = d.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    for (const poly of d.polygons) {
      if (polygonContains(poly, lon, lat)) return d.code;
    }
  }
  return null;
}

function departementDeCommune(codeInsee) {
  const p3 = codeInsee.slice(0, 3);
  if (DOM_PREFIXES.includes(p3)) return p3;
  return codeInsee.slice(0, 2); // couvre aussi "2A"/"2B" pour la Corse
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

  log("Chargement des contours departementaux...");
  const departementsGeo = await chargerDepartementsGeo();

  const jours = [parisDateIso(0), parisDateIso(1)];
  const communes = {}; // code_zone -> { nom, typeZone, lat, lon, parJour: { date: {...} } }
  const departements = {}; // code_dept -> { parJour: { date: { ...max par polluant, nbZones } } }
  let zonesSansDepartement = 0;

  for (const dateIso of jours) {
    log(`Recuperation des indices pour ${dateIso}...`);
    const vues = new Map(); // code_zone -> feature (dedoublonne entre la requete globale et les AASQA manquantes)
    for (const f of await getIndices(token, dateIso)) vues.set(String(f.properties?.code_zone), f);
    for (const aasqa of AASQA_MANQUANTES_PAR_DEFAUT) {
      for (const f of await getIndices(token, dateIso, aasqa)) vues.set(String(f.properties?.code_zone), f);
    }
    log(`  ${vues.size} zones recues (apres dedoublonnage).`);

    for (const f of vues.values()) {
      const p = f.properties ?? {};
      const codeZone = String(p.code_zone ?? "");
      if (!codeZone) continue;
      const typeZone = String(p.type_zone ?? "").toLowerCase();
      const valeurs = Object.fromEntries(POLLUTANT_KEYS.map((k) => [k, typeof p[k] === "number" ? p[k] : null]));
      valeurs.code_qual = typeof p.code_qual === "number" ? p.code_qual : null;

      if (!communes[codeZone]) communes[codeZone] = { nom: p.lib_zone ?? null, typeZone, lat: p.y_wgs84 ?? null, lon: p.x_wgs84 ?? null, parJour: {} };
      communes[codeZone].parJour[dateIso] = valeurs;

      // Determination du departement, par ordre de priorite :
      // 1) AASQA mono-departementale (DOM) : le code_zone de l'AASQA Guyane (03) utilise un
      //    format a 9 chiffres non standard (ex: "249730045") et ses x_wgs84/y_wgs84 semblent
      //    inverses avec x_reg/y_reg (constate en test reel) ; inutile de parser quoi que ce
      //    soit, une AASQA DOM ne couvre jamais qu'un seul departement.
      // 2) prefixe INSEE pour les zones "commune" bien formees (rapide, fiable)
      // 3) geolocalisation pour tout le reste (EPCI, ou type/format inattendu)
      let dept = AASQA_DOM_DEPT[String(p.aasqa)] ?? null;
      if (!dept && typeZone === "commune" && /^(\d{5}|2[ab]\d{3})$/i.test(codeZone)) {
        dept = departementDeCommune(codeZone);
      } else if (!dept && typeof p.x_wgs84 === "number" && typeof p.y_wgs84 === "number") {
        dept = departementParCoordonnees(departementsGeo, p.x_wgs84, p.y_wgs84);
      }
      if (!dept) {
        zonesSansDepartement++;
        continue;
      }

      if (!departements[dept]) departements[dept] = { parJour: {} };
      if (!departements[dept].parJour[dateIso]) {
        departements[dept].parJour[dateIso] = Object.fromEntries([...POLLUTANT_KEYS, "code_qual"].map((k) => [k, null]));
        departements[dept].parJour[dateIso].nbZones = 0;
      }
      const agg = departements[dept].parJour[dateIso];
      agg.nbZones++;
      for (const k of [...POLLUTANT_KEYS, "code_qual"]) {
        const v = valeurs[k];
        if (typeof v === "number" && (agg[k] === null || v > agg[k])) agg[k] = v;
      }
    }
  }

  const nbCommunes = Object.keys(communes).length;
  const nbDepartements = Object.keys(departements).length;
  log(`Total : ${nbCommunes} zones, ${nbDepartements} departements, ${zonesSansDepartement} zones non rattachees a un departement.`);

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

  if (!nbCommunes || nbDepartements < 95) {
    throw new Error(`Couverture insuffisante : ${nbDepartements} departements seulement (attendu ~101). Verifier les AASQA manquantes.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
