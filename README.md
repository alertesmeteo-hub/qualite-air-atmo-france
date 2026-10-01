# qualite-air-atmo-france

Pipeline d'ingestion de l'indice de qualité de l'air (ATMO global, NO2, O3, PM10, PM2.5, SO2)
pour la France entière, par département, aujourd'hui et demain. Source : [API Atmo
France](https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa)
(`admindata.atmo-france.org`).

## Secrets requis (GitHub Actions)

- `ATMO_USERNAME`, `ATMO_PASSWORD` : identifiants du compte Atmo Data (demande d'accès sur
  atmo-france.org, validation par un administrateur).

## À vérifier au premier run réel

Le format exact de `code_zone` pour interroger au niveau département (plutôt que commune,
seul niveau documenté dans les intégrations tierces connues) n'a pas pu être testé avant
l'obtention des identifiants. Le script `scripts/fetch-atmo.mjs` tente le code INSEE
département tel quel (`"66"`, `"2A"`, `"971"`...) ; les départements sans résultat sont listés
dans `data/departements.json` sous `manquants`, sans faire échouer tout le run.

## Sortie

`data/departements.json` :
```json
{
  "generatedAt": "...",
  "todayIso": "2026-10-01",
  "departements": {
    "66": {
      "nom": "...",
      "typeZone": "...",
      "dateMaj": "...",
      "source": "...",
      "parJour": {
        "2026-10-01": { "code_no2": 1, "code_o3": 2, "code_pm10": 1, "code_pm25": 1, "code_so2": 1, "code_qual": 2 },
        "2026-10-02": { ... }
      }
    }
  },
  "manquants": ["..."]
}
```

Codes d'indice (`POLLUTION_LEVEL`, même échelle que l'intégration Home Assistant Atmo France) :
0 indisponible, 1 bon, 2 moyen, 3 dégradé, 4 mauvais, 5 très mauvais, 6 extrêmement mauvais,
7 évènement.
