const BASE_URL = "https://admindata.atmo-france.org";
async function main() {
  const loginRes = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.ATMO_USERNAME, password: process.env.ATMO_PASSWORD }),
  });
  const { token } = await loginRes.json();
  const r = await fetch(`${BASE_URL}/api/v2/data/indices/atmo?format=geojson&date=2026-10-01&aasqa=03`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json();
  console.log("status", r.status, "n=", j.features?.length);
  console.log(JSON.stringify((j.features ?? []).slice(0, 5).map((f) => f.properties), null, 1));
}
main().catch(console.error);
