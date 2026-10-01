// Script de diagnostic temporaire : pourquoi l'Occitanie (dont le 66) n'apparait pas dans la
// requete "toutes zones". A supprimer une fois le probleme compris.
const BASE_URL = "https://admindata.atmo-france.org";

async function main() {
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ATMO_USERNAME, password: process.env.ATMO_PASSWORD }),
  });
  const { token } = await loginRes.json();
  console.log("Token OK");

  // 1) Requete ciblee sur Perpignan (66136)
  const r1 = await fetch(`${BASE_URL}/api/v2/data/indices/atmo?format=geojson&date=2026-10-01&code_zone=66136`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("code_zone=66136 ->", r1.status);
  console.log(await r1.text());

  // 2) Requete filtree sur l'AASQA Occitanie (76)
  const r2 = await fetch(`${BASE_URL}/api/v2/data/indices/atmo?format=geojson&date=2026-10-01&aasqa=76`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j2 = await r2.json();
  console.log("aasqa=76 ->", r2.status, "features:", j2.features?.length);
  console.log("Types de zone:", [...new Set(j2.features.map((f) => f.properties.type_zone))]);
  console.log("5 premiers echantillons:", JSON.stringify(j2.features.slice(0, 5).map((f) => f.properties), null, 1));
  const code66 = j2.features.filter((f) => String(f.properties.code_zone).startsWith("66") || String(f.properties.lib_zone || "").match(/perpignan|roussillon|pyren/i));
  console.log("Zones liees au 66 (par code ou nom):", JSON.stringify(code66.map((f) => f.properties), null, 1));

  for (const aasqa of ["53", "03"]) {
    const r = await fetch(`${BASE_URL}/api/v2/data/indices/atmo?format=geojson&date=2026-10-01&aasqa=${aasqa}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    console.log(`aasqa=${aasqa} ->`, r.status, "features:", j.features?.length, "types:", [...new Set((j.features ?? []).map((f) => f.properties.type_zone))]);
  }
}

main().catch(console.error);
