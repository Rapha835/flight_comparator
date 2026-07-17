# Flight Price Watch ✈️

Système gratuit de suivi automatique de prix de vols, avec alertes Telegram — multi-destinations, multi-devises, pensé pour repérer les bonnes affaires et les **erreurs de prix** (tarifs anormalement bas visibles parfois dans une seule devise). Construit à l'origine pour surveiller un vol Europe → Séoul, adaptable à n'importe quelle destination.

## Pourquoi ce projet

[FlightList](https://www.flightlist.io/) est excellent pour explorer des vols pas chers sur une plage de dates flexible, en comparant plusieurs aéroports — mais il n'a **aucune alerte de prix**. Impossible de se contenter de vérifier "de temps en temps" sans risquer de rater une bonne affaire.

Les alternatives évidentes (API Kiwi, Amadeus) sont aujourd'hui fermées aux projets personnels : Kiwi exige 50 000 utilisateurs actifs/mois, Amadeus a arrêté les nouvelles inscriptions à son portail self-service en juillet 2026.

Ce projet reconstruit l'essentiel — comparaison de dizaines d'aéroports européens, dates flexibles, vols directs et avec escales — **avec une alerte automatique en plus**, en s'appuyant uniquement sur des briques gratuites.

## Comment ça marche

![Architecture](infographie_3_architecture.svg)

Un script [Google Apps Script](https://script.google.com) tourne en permanence sur les serveurs Google (gratuit, pas besoin de garder un ordinateur ou un navigateur ouvert) :

1. Toutes les 30 minutes, il interroge l'[API Travelpayouts/Aviasales](https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API) (gratuite, sanctionnée pour cet usage) pour chaque combinaison ville de départ × destination × devise — par lots de requêtes parallèles, donc rapide même avec des dizaines d'aéroports.
2. Il filtre selon TES critères, façon FlightList : fenêtre de dates aller (ex. 1–14 oct), fenêtre retour (ex. 19 oct–3 nov), durée du séjour en nuits, escales max, budget max. Les cabines avant (éco premium, affaires, first) choisies à l'onboarding sont vérifiées 1x/jour + `/premium` à la demande.
3. Il compare le meilleur prix trouvé à l'historique déjà enregistré, par destination et par devise, et envoie une alerte Telegram uniquement quand ça vaut le coup : **nouveau record**, ou **prix anormalement bas vs la moyenne relevée** (seuil dynamique, ex. 40 % sous la médiane → probable erreur de prix) — jamais deux fois pour le même prix.
4. Tout l'historique est journalisé dans un Google Sheet créé automatiquement.

Toute la configuration se fait dans Telegram : un **assistant de 8 questions** (`/config`) se lance à l'installation, et chaque critère reste modifiable à l'unité par commande — aucun besoin de rouvrir le code au quotidien.

Un module complémentaire, optionnel et isolé, surveille les **cabines avant (affaires, première)** via l'API Travelpayouts (endpoint `v2/prices/latest`, `trip_class=1/2`) — des prix en cache par mois de départ. Il est protégé par un filet de sécurité complet : s'il échoue ou n'a rien en cache, le suivi économique principal continue de tourner sans aucune interruption. À noter : l'**éco premium n'est pas couverte** par cette API, et ces prix sont **en cache** (moins frais que l'éco, qui est en quasi-temps réel). *(Historique : ce module scrapait Google Flights jusqu'en v2.7, mais Google bloque les requêtes serveur d'Apps Script ; Amadeus, le plan B « toutes cabines en live », a fermé son portail gratuit le 17/07/2026.)*

## Ce que ça compare

![Panorama des outils](infographie_2_comparatif.svg)

FlightList reste le seul outil combinant recherche par plage de dates et multi-aéroports — c'est justement pour ça qu'il sert de référence ici. Ce projet ne le remplace pas, il comble le seul trou du tableau : l'absence d'alerte.

## Installation

Guide complet pas-à-pas dans [`GUIDE_installation.md`](GUIDE_installation.md) — en résumé :

1. Crée un compte gratuit [Travelpayouts](https://www.travelpayouts.com/) et récupère ton token API.
2. Crée un bot Telegram via [@BotFather](https://t.me/BotFather) et récupère ton token + ton `chat_id`.
3. Copie `flight_price_watch.gs` dans un nouveau projet [Google Apps Script](https://script.google.com), remplis le bloc `CONFIG_STATIC` avec tes identifiants, exécute `setup()`.

C'est tout — le bot t'écrit sur Telegram et lance **l'onboarding : 8 questions rapides** (destinations, zone de départ, fenêtre de dates aller, fenêtre retour, durée du séjour, type de billet — éco/éco premium/affaires/first —, escales max, puis un budget PAR type de billet choisi, chacun avec son repère de prix constaté — API Travelpayouts pour l'éco comme pour les cabines avant). Réponds simplement ; « passer » garde la valeur proposée, `/annuler` garde tout par défaut. À la fin, première vérification et top 3 des prix. L'assistant se relance à tout moment avec `/config`.

Pas de déploiement, pas de webhook : le script relève tes commandes Telegram toutes les minutes (polling), et toute modification du code prend effet dès la sauvegarde. Aucune carte bancaire, aucun serveur à gérer, 100 % gratuit dans les limites d'usage personnel.

## Adapter à d'autres destinations / villes de départ / dates

Tout se règle depuis Telegram : `/config` relance l'assistant complet (8 questions : destinations, zone de départ, fenêtre aller, fenêtre retour, durée du séjour, type de billet, escales, budget), et chaque critère a sa commande dédiée. Le bloc `CONFIG_STATIC` en haut du script ne fixe que les valeurs proposées par défaut (`DEFAULT_*`) et les codes pays → aéroports (`COUNTRY_AIRPORTS`).

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/config` | relance l'onboarding — 8 questions, façon FlightList (« passer » = garder, `/annuler` = abandonner) |
| `/demarrer ICN` (ou juste `ICN`) | ajoute/active une destination + vérification immédiate |
| `/retirer ICN` | retire une destination (ou une ville de départ) |
| `/ajouter FR` | ajoute un pays (étendu auto) ou un aéroport de départ précis |
| `/dates 2026-10-01 2026-10-14` | fenêtre de départ (ou `/dates 2026-10` = tout le mois) |
| `/retour 2026-10-19 2026-11-03` | fenêtre de retour |
| `/duree 14 21` | durée du séjour min/max (nuits) |
| `/cabines eco affaires` | type de billet suivi (éco, éco premium, affaires, first, toutes) |
| `/escales 1` | escales maxi par trajet (`/escales non` = libre) |
| `/budget 700` / `/budget affaires 2500` | budget repère **par type de billet** : les prix au-dessus restent affichés, marqués ⚠️ |
| `/devises EUR USD` | devises suivies (la 1ère est la principale) |
| `/seuil 40` | alerte si un prix tombe 40 % sous la moyenne relevée |
| `/pause` / `/reprendre` | suspend ou relance la surveillance |
| `/check` | vérification immédiate avec top 3 par destination |
| `/premium` | prix affaires / première à la demande (via Travelpayouts) |
| `/liste` | config actuelle (et version du script) |
| `/status` | derniers prix éco + cabines premium |
| `/aide` | rappel des commandes |

Le bot répond en 1 minute maxi (les messages sont relevés toutes les minutes). Les prix sont **par personne, aller-retour**. Si ta config est très large (beaucoup de destinations × départs), la vérification passe automatiquement à 1x/heure pour rester dans les quotas gratuits — `/liste` l'indique.

**Filtres FlightList non couverts** : bagages, heure de départ, durée de vol maxi et temps d'escale maxi — l'API gratuite Travelpayouts n'expose pas ces informations.

## Mettre à jour le script

Colle le nouveau code, sauvegarde — les triggers exécutent toujours la dernière version enregistrée, aucun redéploiement. Ré-exécute `setup()` seulement si la mise à jour change les triggers (sans risque : config et historique sont conservés). Vérifie avec `/aide` que la version affichée correspond à `SCRIPT_VERSION`.

## Limites à connaître

- **Données en cache, pas temps réel.** L'API Travelpayouts reflète des recherches réelles d'autres voyageurs (jusqu'à ~48h). Idéal pour repérer une tendance ou une bonne affaire — à revérifier avant tout achat.
- **Pas d'interlining virtuel.** Contrairement à Kiwi/FlightList, ce système ne combine pas des billets aller-simple de compagnies sans accord entre elles.
- **Le module cabines premium (affaires/première) dépend du cache Travelpayouts** (`trip_class=1/2`). Les cabines avant sont bien moins mises en cache que l'éco : il peut ne rien remonter pour certaines routes. L'**éco premium n'est pas couverte** par cette API. Le module est isolé et n'affecte jamais le suivi principal.

## FAQ / Dépannage

### Le bot ne répond à aucune commande (même `/aide`)

Rappel : le bot répond en **1 minute maxi** (il relève les messages toutes les minutes, pas instantanément). Si toujours rien après 2 minutes, vérifie dans l'ordre :

1. **Le trigger de polling tourne-t-il ?** Panneau **Exécutions** (⏱) dans l'éditeur Apps Script : tu dois voir une ligne `pollTelegram` par minute, en état « Terminée ». Aucune ligne → ré-exécute `setup()`.
2. **Que disent les journaux ?** Clique sur le dernier `pollTelegram` → **Journaux Cloud** :
   - `Message ignoré — chat_id reçu : X ≠ attendu : Y` → ton `TELEGRAM_CHAT_ID` est faux : mets la valeur `X` affichée, sauvegarde, c'est réglé.
   - `Erreur getUpdates : ... 409 ...` → un ancien webhook bloque encore la relève des messages : ré-exécute `setup()` (il le supprime automatiquement).
   - `Échec d'envoi Telegram : ...` → la réponse part mais Telegram la refuse ; le message d'erreur JSON te dit pourquoi (token bot invalide, etc.).
3. **Les tokens sont-ils bons ?** Exécute `setup()` : si tout est correct, tu reçois immédiatement le message d'installation et la première question de l'assistant sur Telegram. Sinon, regarde le journal de `setup`.

### Pourquoi du polling et pas un webhook Telegram ?

Apps Script répond à toute requête web par une **redirection HTTP 302** (comportement Google non contournable). Telegram considère ça comme un échec (`Wrong response from the webhook: 302 Found` dans `getWebhookInfo`), marque le webhook en erreur et rejoue les messages : commandes en retard, en double, ou jamais traitées. Le polling (`getUpdates` toutes les minutes) est fiable, ne nécessite **aucun déploiement Web App**, et fait que toute modification du code prend effet dès la sauvegarde. Si tu migres depuis une version webhook de ce projet, exécute simplement `setup()` : il supprime le webhook et installe le polling.

### Le bot répond, mais avec l'ancien comportement (ou une ancienne version dans `/aide`)

Vérifie que tu as bien **sauvegardé** le fichier (Cmd/Ctrl+S) — les triggers exécutent la dernière version enregistrée. Si tu viens d'une version ≤ 2.0 (webhook), ré-exécute `setup()` une fois. Si tu avais déployé le script en Web App par le passé, ce déploiement ne sert plus à rien : tu peux le supprimer (« Gérer les déploiements » → archiver), il n'affecte pas le polling.

### Le panneau Exécutions montre des erreurs `Script function not found: xxx`

Un déclencheur (trigger) d'une ancienne version du script appelle une fonction qui n'existe plus. Exécute `setup()` : il supprime **tous** les anciens triggers avant de recréer les bons. Tu peux vérifier dans le panneau ⏰ **Déclencheurs** qu'il ne reste que `pollTelegram` (1 min), `checkPrices` (30 min) et éventuellement `checkPremiumCabins` (1x/jour).

### Je reçois la même alerte en boucle

Symptôme de la v1 (l'alerte « sous le seuil » se re-déclenchait à chaque passage). Corrigé depuis : une alerte donnée (record battu ou probable erreur de prix) n'est jamais renvoyée pour le même prix. Si ça t'arrive encore, vérifie avec `/aide` que tu es bien en v2.2+ (voir question précédente).

### `/pause` ne semble pas pris en compte

En v1, un check en cours pouvait écraser la pause (l'état complet était ré-écrit en fin de check). Corrigé en v2 : la config n'est plus jamais écrite par les checks, et l'état pause est relu juste avant chaque envoi d'alerte. Vérifie avec `/liste` que l'état affiché est bien « ⏸️ En pause » — et que tu es en v2.

### `/check` ou `/demarrer` ne renvoie rien (ou « Aucun résultat »)

- L'API Travelpayouts est un **cache** de recherches réelles : une route peu demandée (petit aéroport, destination exotique, dates lointaines) peut n'avoir aucune donnée. Essaie avec une grande ville (`PAR`, `LON`) pour valider que tout fonctionne.
- Vérifie ton `TRAVELPAYOUTS_TOKEN` : ouvre l'URL d'API à la main avec ton token, la réponse doit contenir `"success":true`.
- Tes critères sont peut-être trop stricts (fenêtres de dates étroites, `/escales 0`, budget bas, durée de séjour serrée) : le message « Aucun vol trouvé » rappelle les critères actifs — élargis-en un avec `/config` et réessaie.

### Erreur « Exception: Service invoked too many times » dans les exécutions

Tu as atteint les quotas Apps Script gratuits (~20 000 requêtes URL Fetch/jour). Avec beaucoup de départs × destinations × devises toutes les 30 min, ça peut arriver. Réduis la voilure : moins d'aéroports (`/retirer`), moins de devises (`/devises EUR`), ou passe le trigger à 60 min dans `setup()`.

### Le module premium ne remonte jamais rien

Les cabines avant sont peu mises en cache par Travelpayouts : pour certaines routes, il n'y a tout simplement rien. `/premium` te dit alors franchement la cause (« aucune offre en cache pour ce mois » ou une erreur `Travelpayouts HTTP …` en cas de souci de token/quota). C'est attendu — le module est volontairement isolé et son échec n'affecte jamais le suivi principal. Rappel : l'**éco premium n'est pas couverte** par cette API. Désactive tout le module avec `PREMIUM_ENABLED: false` si tu ne t'en sers pas.

### Comment repartir de zéro (config, records, historique d'alertes) ?

Dans l'éditeur Apps Script : **Paramètres du projet (⚙) → Propriétés du script** → supprime les propriétés (`CONFIG`, `MINS`, `ALERTED`, `RECENT`, `LAST_RESULT`…), puis ré-exécute `setup()`. La Google Sheet n'est pas touchée — supprime-la de ton Drive si tu veux aussi purger l'historique.

### Est-ce vraiment gratuit ? Y a-t-il un risque avec mes tokens ?

Tout tourne dans les quotas gratuits de Google Apps Script et l'API Data de Travelpayouts est gratuite. Tes tokens restent dans TON projet Apps Script (ne les committe jamais dans un fork public du repo) et rien n'est exposé sur internet : le script sort chercher ses données, personne ne peut l'appeler de l'extérieur. Seuls les messages venant de ton `chat_id` sont pris en compte.

## Stack

Google Apps Script · [Travelpayouts/Aviasales Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API) · Google Sheets · Telegram Bot API — entièrement gratuit.

## Licence

[MIT](LICENSE) — fais-en ce que tu veux.
