# qualite-air-atmo-france

Pipeline d'ingestion de l'indice de qualité de l'air (ATMO global, NO2, O3, PM10, PM2.5, SO2)
pour la France entière, par commune puis agrégé par département, aujourd'hui et demain.

Source : [API Atmo Data v2](https://admindata.atmo-france.org/api/doc/v2)
(`admindata.atmo-france.org`), endpoint `GET /api/v2/data/indices/atmo`.

## Secrets requis (GitHub Actions)

- `ATMO_USERNAME`, `ATMO_PASSWORD` : identifiants du compte Atmo Data (demande d'accès via
  https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa, validation par un
  administrateur).

## Fonctionnement

L'API ne propose pas de filtre par département : uniquement par commune/EPCI (`code_zone`,
code INSEE) ou "toutes les zones" par défaut. Le script interroge donc l'ensemble des communes
françaises (~35 000) pour aujourd'hui et demain (2 requêtes), puis :

- écrit `data/communes.json` : détail complet par commune (pour un futur affichage au clic,
  façon "jusqu'à la commune" sur vigiscript.fr)
- écrit `data/departements.json` : agrégation par département (pire valeur = max parmi les
  communes du département), pour la carte de vue d'ensemble

Le regroupement commune → département se fait sur les 2 premiers caractères du code INSEE
(`2A`/`2B` pour la Corse déjà sous cette forme, préfixe à 3 chiffres `971/972/973/974/976`
pour les DOM).

## Sortie

`data/departements.json` :
```json
{
  "generatedAt": "...",
  "jours": ["2026-10-01", "2026-10-02"],
  "departements": {
    "66": {
      "parJour": {
        "2026-10-01": { "code_no2": 1, "code_o3": 2, "code_pm10": 1, "code_pm25": 1, "code_so2": 1, "code_qual": 2, "nbCommunes": 226 }
      }
    }
  }
}
```

`data/communes.json` : même structure par code INSEE commune, avec `nom`, `lat`, `lon`.

Codes d'indice ATMO (`code_qual` et par polluant) : 0 absent, 1 bon, 2 moyen, 3 dégradé,
4 mauvais, 5 très mauvais, 6 extrêmement mauvais, 7 évènement.

## À surveiller au premier run réel

- Taille réelle de `communes.json` (35 000 communes × 2 jours) — à confirmer une fois les
  identifiants disponibles ; si trop volumineux pour un commit quotidien, on pourra ne garder
  que les champs strictement nécessaires au rendu ou ne publier qu'un sous-ensemble.
- Disponibilité effective de J+1 selon l'heure du run (les données sont rafraîchies vers midi
  côté Atmo France, cf. doc des intégrations tierces).
