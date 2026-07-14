# Flight Price Watch ✈️

Système gratuit de suivi automatique de prix de vols, avec alertes Telegram — construit à l'origine pour surveiller un vol Europe → Séoul, mais adaptable à n'importe quelle destination.

## Pourquoi ce projet

[FlightList](https://www.flightlist.io/) est excellent pour explorer des vols pas chers sur une plage de dates flexible, en comparant plusieurs aéroports — mais il n'a **aucune alerte de prix**. Impossible de se contenter de vérifier "de temps en temps" sans risquer de rater une bonne affaire.

Les alternatives évidentes (API Kiwi, Amadeus) sont aujourd'hui fermées aux projets personnels : Kiwi exige 50 000 utilisateurs actifs/mois, Amadeus a arrêté les nouvelles inscriptions à son portail self-service en juillet 2026.

Ce projet reconstruit l'essentiel — comparaison de dizaines d'aéroports européens, dates flexibles, vols directs et avec escales — **avec une alerte automatique en plus**, en s'appuyant uniquement sur des briques gratuites.

## Comment ça marche

![Architecture](infographie_3_architecture.svg)

Un script [Google Apps Script](https://script.google.com) tourne en permanence sur les serveurs Google (gratuit, pas besoin de garder un ordinateur ou un navigateur ouvert) :

1. Toutes les 30 minutes, il interroge l'[API Travelpayouts/Aviasales](https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API) (gratuite, sanctionnée pour cet usage) pour chaque ville/aéroport surveillé.
2. Il compare le meilleur prix trouvé à l'historique déjà enregistré.
3. En cas de nouveau record ou de prix sous un seuil défini, il envoie une alerte Telegram — avec le classement des meilleures villes de départ.
4. Tout l'historique est journalisé dans un Google Sheet créé automatiquement.

La config (villes surveillées, seuil d'alerte, pause/reprise) se pilote entièrement à distance via des commandes envoyées au bot Telegram — aucun besoin de rouvrir le code au quotidien.

Un module complémentaire, optionnel et isolé, va plus loin en interrogeant directement Google Flights pour surveiller les cabines que l'API Travelpayouts ne couvre pas (éco premium, affaires, première). Il est protégé par un filet de sécurité complet : s'il échoue (Google peut changer sa page à tout moment), le suivi économique principal continue de tourner sans aucune interruption.

## Ce que ça compare

![Panorama des outils](infographie_2_comparatif.svg)

FlightList reste le seul outil combinant recherche par plage de dates et multi-aéroports — c'est justement pour ça qu'il sert de référence ici. Ce projet ne le remplace pas, il comble le seul trou du tableau : l'absence d'alerte.

## Installation

Guide complet pas-à-pas dans [`GUIDE_installation.md`](GUIDE_installation.md) — en résumé :

1. Crée un compte gratuit [Travelpayouts](https://www.travelpayouts.com/) et récupère ton token API.
2. Crée un bot Telegram via [@BotFather](https://t.me/BotFather) et récupère ton token + ton `chat_id`.
3. Copie `flight_price_watch.gs` dans un nouveau projet [Google Apps Script](https://script.google.com), remplis le bloc `CONFIG_STATIC` avec tes identifiants, exécute `setup()`.
4. Déploie le script en application web et exécute `registerWebhook()` pour activer le pilotage par Telegram.

Aucune carte bancaire, aucun serveur à gérer, 100 % gratuit dans les limites d'usage personnel.

## Adapter à une autre destination / d'autres villes de départ

Tout se change dans le bloc `CONFIG_STATIC` en haut du script :

- `DESTINATION` — code IATA ville ou aéroport (ex. `"SEL"` pour Séoul, `"NYC"` pour New York)
- `DEFAULT_ORIGINS` — mélange librement des codes pays (2 lettres, ex. `"FR"`) et des codes aéroport précis (3 lettres, ex. `"CDG"`) ; les codes pays s'étendent automatiquement via la table `COUNTRY_AIRPORTS`
- `DEPARTURE_MONTH` / `RETURN_MONTH`, `TRIP_DURATION_MIN/MAX`, `CURRENCY`, `DEFAULT_ALERT_BELOW`

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/seuil 600` | change le seuil de prix qui déclenche une alerte |
| `/ajouter FR` | ajoute un pays (étendu auto) ou un aéroport précis |
| `/retirer FR` | retire une entrée |
| `/liste` | affiche la config actuelle |
| `/pause` / `/reprendre` | suspend ou relance la surveillance |
| `/status` | dernier meilleur prix trouvé |
| `/aide` | rappel des commandes |

## Limites à connaître

- **Données en cache, pas temps réel.** L'API Travelpayouts reflète des recherches réelles d'autres voyageurs (jusqu'à ~48h). Idéal pour repérer une tendance ou une bonne affaire — à revérifier avant tout achat.
- **Pas d'interlining virtuel.** Contrairement à Kiwi/FlightList, ce système ne combine pas des billets aller-simple de compagnies sans accord entre elles.
- **Le module cabines premium est un scraping non officiel** de Google Flights (reverse engineering du format de requête interne). Il peut cesser de fonctionner sans préavis si Google modifie sa page — c'est pour ça qu'il est isolé et n'affecte jamais le suivi principal.

## Stack

Google Apps Script · [Travelpayouts/Aviasales Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API) · Google Sheets · Telegram Bot API — entièrement gratuit.

## Licence

[MIT](LICENSE) — fais-en ce que tu veux.
