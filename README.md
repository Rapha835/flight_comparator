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
2. Il compare le meilleur prix trouvé à l'historique déjà enregistré, par destination et par devise.
3. Il envoie une alerte Telegram uniquement quand ça vaut le coup : **nouveau record**, **prix anormalement bas vs l'historique récent (probable erreur de prix)**, ou passage sous ton seuil — et jamais deux fois pour le même prix (fini le spam).
4. Tout l'historique est journalisé dans un Google Sheet créé automatiquement.

La config (destinations, villes de départ, devises, seuil d'alerte, pause/reprise) se pilote entièrement à distance via des commandes envoyées au bot Telegram — aucun besoin de rouvrir le code au quotidien.

Un module complémentaire, optionnel et isolé, va plus loin en interrogeant directement Google Flights pour surveiller les cabines que l'API Travelpayouts ne couvre pas (éco premium, affaires, première). Il est protégé par un filet de sécurité complet : s'il échoue (Google peut changer sa page à tout moment), le suivi économique principal continue de tourner sans aucune interruption.

## Ce que ça compare

![Panorama des outils](infographie_2_comparatif.svg)

FlightList reste le seul outil combinant recherche par plage de dates et multi-aéroports — c'est justement pour ça qu'il sert de référence ici. Ce projet ne le remplace pas, il comble le seul trou du tableau : l'absence d'alerte.

## Installation

Guide complet pas-à-pas dans [`GUIDE_installation.md`](GUIDE_installation.md) — en résumé :

1. Crée un compte gratuit [Travelpayouts](https://www.travelpayouts.com/) et récupère ton token API.
2. Crée un bot Telegram via [@BotFather](https://t.me/BotFather) et récupère ton token + ton `chat_id`.
3. Copie `flight_price_watch.gs` dans un nouveau projet [Google Apps Script](https://script.google.com), remplis le bloc `CONFIG_STATIC` avec tes identifiants, exécute `setup()`.

C'est tout — tu reçois un message de confirmation sur Telegram. Pas de déploiement, pas de webhook : le script relève tes commandes Telegram toutes les minutes (polling), et toute modification du code prend effet dès la sauvegarde. Aucune carte bancaire, aucun serveur à gérer, 100 % gratuit dans les limites d'usage personnel.

## Adapter à d'autres destinations / villes de départ

Les destinations, départs et devises se changent directement depuis Telegram (voir commandes ci-dessous). Le bloc `CONFIG_STATIC` en haut du script ne fixe que les valeurs de départ et les paramètres de dates :

- `DEFAULT_DESTINATIONS` — codes IATA ville ou aéroport (ex. `["SEL"]` pour Séoul, `["ICN", "NRT"]` pour Incheon + Tokyo-Narita)
- `DEFAULT_ORIGINS` — mélange librement des codes pays (2 lettres, ex. `"FR"`) et des codes aéroport précis (3 lettres, ex. `"CDG"`) ; les codes pays s'étendent automatiquement via la table `COUNTRY_AIRPORTS`
- `DEFAULT_CURRENCIES` — devises suivies (la 1ère porte le seuil d'alerte), ex. `["EUR", "USD"]`
- `DEPARTURE_MONTH` / `RETURN_MONTH`, `TRIP_DURATION_MIN/MAX`, `DEFAULT_ALERT_BELOW`

## Commandes Telegram

| Commande | Effet |
|---|---|
| `/demarrer ICN` | ajoute/active une destination + vérification immédiate |
| `ICN` (tout court) | pareil que `/demarrer ICN` |
| `/retirer ICN` | retire une destination (ou une ville de départ) |
| `/ajouter FR` | ajoute un pays (étendu auto) ou un aéroport de départ précis |
| `/devises EUR USD` | change les devises suivies (la 1ère porte le seuil) |
| `/seuil 600` | change le seuil de prix qui déclenche une alerte |
| `/pause` / `/reprendre` | suspend ou relance la surveillance |
| `/check` | force une vérification immédiate avec résumé |
| `/liste` | affiche la config actuelle (et la version du script) |
| `/status` | derniers meilleurs prix par destination/devise |
| `/aide` | rappel des commandes |

Le bot répond en 1 minute maxi (les messages sont relevés toutes les minutes).

## Mettre à jour le script

Colle le nouveau code, sauvegarde — les triggers exécutent toujours la dernière version enregistrée, aucun redéploiement. Ré-exécute `setup()` seulement si la mise à jour change les triggers (sans risque : config et historique sont conservés). Vérifie avec `/aide` que la version affichée correspond à `SCRIPT_VERSION`.

## Limites à connaître

- **Données en cache, pas temps réel.** L'API Travelpayouts reflète des recherches réelles d'autres voyageurs (jusqu'à ~48h). Idéal pour repérer une tendance ou une bonne affaire — à revérifier avant tout achat.
- **Pas d'interlining virtuel.** Contrairement à Kiwi/FlightList, ce système ne combine pas des billets aller-simple de compagnies sans accord entre elles.
- **Le module cabines premium est un scraping non officiel** de Google Flights (reverse engineering du format de requête interne). Il peut cesser de fonctionner sans préavis si Google modifie sa page — c'est pour ça qu'il est isolé et n'affecte jamais le suivi principal.

## FAQ / Dépannage

### Le bot ne répond à aucune commande (même `/aide`)

Rappel : le bot répond en **1 minute maxi** (il relève les messages toutes les minutes, pas instantanément). Si toujours rien après 2 minutes, vérifie dans l'ordre :

1. **Le trigger de polling tourne-t-il ?** Panneau **Exécutions** (⏱) dans l'éditeur Apps Script : tu dois voir une ligne `pollTelegram` par minute, en état « Terminée ». Aucune ligne → ré-exécute `setup()`.
2. **Que disent les journaux ?** Clique sur le dernier `pollTelegram` → **Journaux Cloud** :
   - `Message ignoré — chat_id reçu : X ≠ attendu : Y` → ton `TELEGRAM_CHAT_ID` est faux : mets la valeur `X` affichée, sauvegarde, c'est réglé.
   - `Erreur getUpdates : ... 409 ...` → un ancien webhook bloque encore la relève des messages : ré-exécute `setup()` (il le supprime automatiquement).
   - `Échec d'envoi Telegram : ...` → la réponse part mais Telegram la refuse ; le message d'erreur JSON te dit pourquoi (token bot invalide, etc.).
3. **Les tokens sont-ils bons ?** Exécute `setup()` : si tout est correct, tu reçois immédiatement « 🤖 Flight Price Watch installé et actif ! » sur Telegram. Sinon, regarde le journal de `setup`.

### Pourquoi du polling et pas un webhook Telegram ?

Apps Script répond à toute requête web par une **redirection HTTP 302** (comportement Google non contournable). Telegram considère ça comme un échec (`Wrong response from the webhook: 302 Found` dans `getWebhookInfo`), marque le webhook en erreur et rejoue les messages : commandes en retard, en double, ou jamais traitées. Le polling (`getUpdates` toutes les minutes) est fiable, ne nécessite **aucun déploiement Web App**, et fait que toute modification du code prend effet dès la sauvegarde. Si tu migres depuis une version webhook de ce projet, exécute simplement `setup()` : il supprime le webhook et installe le polling.

### Le bot répond, mais avec l'ancien comportement (ou une ancienne version dans `/aide`)

Vérifie que tu as bien **sauvegardé** le fichier (Cmd/Ctrl+S) — les triggers exécutent la dernière version enregistrée. Si tu viens d'une version ≤ 2.0 (webhook), ré-exécute `setup()` une fois. Si tu avais déployé le script en Web App par le passé, ce déploiement ne sert plus à rien : tu peux le supprimer (« Gérer les déploiements » → archiver), il n'affecte pas le polling.

### Le panneau Exécutions montre des erreurs `Script function not found: xxx`

Un déclencheur (trigger) d'une ancienne version du script appelle une fonction qui n'existe plus. Exécute `setup()` : il supprime **tous** les anciens triggers avant de recréer les bons. Tu peux vérifier dans le panneau ⏰ **Déclencheurs** qu'il ne reste que `checkPrices` (30 min) et éventuellement `checkPremiumCabins` (1x/jour).

### Je reçois la même alerte en boucle

Symptôme de la v1 (l'alerte « sous le seuil » se re-déclenchait à chaque passage). Corrigé en v2 : une alerte donnée (record, anomalie ou seuil) n'est jamais renvoyée pour le même prix. Si ça t'arrive encore, vérifie avec `/aide` que tu es bien en v2.1+ (voir question précédente).

### `/pause` ne semble pas pris en compte

En v1, un check en cours pouvait écraser la pause (l'état complet était ré-écrit en fin de check). Corrigé en v2 : la config n'est plus jamais écrite par les checks, et l'état pause est relu juste avant chaque envoi d'alerte. Vérifie avec `/liste` que l'état affiché est bien « ⏸️ En pause » — et que tu es en v2.

### `/check` ou `/demarrer` ne renvoie rien (ou « Aucun résultat »)

- L'API Travelpayouts est un **cache** de recherches réelles : une route peu demandée (petit aéroport, destination exotique, dates lointaines) peut n'avoir aucune donnée. Essaie avec une grande ville (`PAR`, `LON`) pour valider que tout fonctionne.
- Vérifie ton `TRAVELPAYOUTS_TOKEN` : ouvre l'URL d'API à la main avec ton token, la réponse doit contenir `"success":true`.
- Les filtres `TRIP_DURATION_MIN/MAX` éliminent les offres hors durée de séjour : élargis-les pour tester.

### Erreur « Exception: Service invoked too many times » dans les exécutions

Tu as atteint les quotas Apps Script gratuits (~20 000 requêtes URL Fetch/jour). Avec beaucoup de départs × destinations × devises toutes les 30 min, ça peut arriver. Réduis la voilure : moins d'aéroports (`/retirer`), moins de devises (`/devises EUR`), ou passe le trigger à 60 min dans `setup()`.

### Le module premium ne remonte jamais rien

C'est un scraping non officiel de Google Flights : il peut casser à tout moment si Google change sa page (erreur `structure ds:1 introuvable` dans les journaux). C'est attendu — il est volontairement isolé et son échec n'affecte jamais le suivi principal. Désactive-le avec `PREMIUM_ENABLED: false` si tu ne t'en sers pas.

### Comment repartir de zéro (config, records, historique d'alertes) ?

Dans l'éditeur Apps Script : **Paramètres du projet (⚙) → Propriétés du script** → supprime les propriétés (`CONFIG`, `MINS`, `ALERTED`, `RECENT`, `LAST_RESULT`…), puis ré-exécute `setup()`. La Google Sheet n'est pas touchée — supprime-la de ton Drive si tu veux aussi purger l'historique.

### Est-ce vraiment gratuit ? Y a-t-il un risque avec mes tokens ?

Tout tourne dans les quotas gratuits de Google Apps Script et l'API Data de Travelpayouts est gratuite. Tes tokens restent dans TON projet Apps Script (ne les committe jamais dans un fork public du repo) et rien n'est exposé sur internet : le script sort chercher ses données, personne ne peut l'appeler de l'extérieur. Seuls les messages venant de ton `chat_id` sont pris en compte.

## Stack

Google Apps Script · [Travelpayouts/Aviasales Data API](https://support.travelpayouts.com/hc/en-us/articles/203956163-Aviasales-Data-API) · Google Sheets · Telegram Bot API — entièrement gratuit.

## Licence

[MIT](LICENSE) — fais-en ce que tu veux.
