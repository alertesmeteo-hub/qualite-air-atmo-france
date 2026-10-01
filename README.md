# qualite-air-atmo-france

Pipeline d'ingestion de l'indice de qualité de l'air (ATMO global, NO2, O3, PM10, PM2.5, SO2)
pour la France entière, par zone (commune ou EPCI selon l'AASQA) puis agrégé par département,
aujourd'hui et demain.

Source : [API Atmo Data v2](https://admindata.atmo-france.org/api/doc/v2)
(`admindata.atmo-france.org`), endpoint `GET /api/v2/data/indices/atmo`.

## Secrets requis (GitHub Actions)

- `ATMO_USERNAME`, `ATMO_PASSWORD` : identifiants du compte Atmo Data (demande d'accès via
  https://www.atmo-france.org/article/acceder-aux-donnees-de-votre-aasqa, validation par un
  administrateur). **Attention** : `ATMO_USERNAME` est le nom d'utilisateur choisi à
  l'inscription, pas forcément l'adresse email.

## Pièges découverts en testant avec un vrai compte

1. **La requête "toutes zones" (sans `code_zone`) n'inclut pas toutes les AASQA.** Occitanie
   (76), Bretagne (53) et Guyane (03) en sont absentes (constaté empiriquement, non documenté
   dans l'API). Le script les récupère donc explicitement en plus de la requête globale.
2. **Certaines AASQA publient par EPCI** (communauté de communes/agglo, code SIREN à 9
   chiffres) et non par commune (code INSEE à 5 chiffres) : Occitanie et Bretagne dans ce cas.
   Le préfixe du code ne permet donc pas de retrouver le département pour ces zones. Le script
   utilise alors les coordonnées (`x_wgs84`/`y_wgs84`, toujours fournies) et un test
   point-dans-polygone contre les contours des départements métropolitains (même GeoJSON que
   les autres cartes du site) pour déterminer le département. Les DOM restent identifiés par
   préfixe de code INSEE (971/972/973/974/976), hors couverture de ce GeoJSON.

## Sortie

`data/departements.json` : agrégation par département (pire valeur = max parmi les zones du
département), pour la carte de vue d'ensemble.

`data/communes.json` : détail complet par zone (commune ou EPCI selon la région), avec `nom`,
`typeZone`, `lat`, `lon` — pour un futur affichage au clic, façon "jusqu'à la commune" sur
vigiscript.fr (à noter : en Occitanie et Bretagne, le clic portera sur l'EPCI, pas la commune,
faute de donnée plus fine côté Atmo Data).

Codes d'indice ATMO (`code_qual` et par polluant) : 0 absent, 1 bon, 2 moyen, 3 dégradé,
4 mauvais, 5 très mauvais, 6 extrêmement mauvais, 7 évènement.

## À surveiller

- Taille de `communes.json` (~35 000 zones × 2 jours, plusieurs Mo) — committée à chaque run
  sur `main` : à surveiller sur la durée (croissance du dépôt), un passage en branche
  force-push façon `radar-data` pourrait être envisagé si ça devient gênant.
- Disponibilité effective de J+1 selon l'heure du run (données rafraîchies vers midi Paris
  côté Atmo France).
